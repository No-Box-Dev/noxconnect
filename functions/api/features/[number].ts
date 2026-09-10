/* eslint-disable @typescript-eslint/no-explicit-any */ // dynamic D1 rows + GitHub issue payloads
// /api/features/:number — single-feature mutations against the noxconnect
// repo. PATCH edits title/status/owners/plan; DELETE closes the issue and
// strips the noxticket/feature/status labels.
//
// Both paths are *optimistic*: D1 is updated first so the UI reflects the
// change immediately, and the GitHub write is fired via waitUntil. If the
// GitHub call fails, the failure is recorded in op_failures (admins see it
// in Settings → Recent failures) and the next webhook delivery or 30-min
// cron syncFeatures will reconcile D1 against GitHub (GitHub is the source
// of truth).
//
// Mutations use the GitHub App installation token, not the caller's OAuth
// token — so any logged-in user can edit the board even without personal
// `issues:write` on {org}/noxconnect.

import { z } from "zod";
import { getCtx, jsonResponse, errorResponse } from "../../lib/db";
import { getInstallationIdForOrg, getInstallationToken } from "../../lib/github-app";
import { parseFeatureMetadata } from "../../lib/feature-metadata";
import { sanitizeSpecLinks } from "../../lib/spec-links";
import { recordFailure } from "../../lib/op-failures";
import { resolveBoardStages } from "../../lib/board-stages.js";
import {
  buildFeatureLabels,
  buildIssueBody,
  ensureNoxTicketRepoLabels,
  extractBacklogFromLabels,
  extractStatusFromLabels,
  ghIssueToFeature,
  patchFeatureIssue,
  readFeatureRow,
  upsertFeatureRow,
  NOXTICKET_LABEL,
  FEATURE_LABEL,
  hasNoxTicketLabel,
} from "../../lib/feature-issues";
import { validate } from "../../lib/validate";
import { delegateFeatureMutation } from "../../lib/noxticket-features";
import type { NoxTicketEnvironment } from "../../lib/noxticket-service";

interface Env extends NoxTicketEnvironment {
  DB: D1Database;
  TASK_QUEUE: Queue;
}

interface Ctx {
  env: Env;
  data: { orgId: number; orgLogin: string; userLogin: string; isAdmin?: boolean };
  request: Request;
  params?: { number?: string };
  waitUntil: (promise: Promise<unknown>) => void;
}

// Permissive body schema — every field is optional (PATCH is a partial
// update). The status 422 check and owner-username filtering stay in the
// handler: status validation needs the org's board stages, and the response
// codes (422 for bad status) differ from the schema's 400.
const PatchFeatureBody = z.object({
  title: z.string().optional(),
  status: z.string().optional(),
  owners: z.array(z.unknown()).optional(),
  // Move to backlog / return to board via the `backlog` label. Orthogonal
  // to status — the status label stays put so returning to the board
  // lands the feature in the column it left.
  backlog: z.boolean().optional(),
  // Shape is intentionally loose — sanitizeSpecLinks does the real
  // validation (http/https only, drops empty rows) at the storage boundary.
  specLinks: z.array(z.unknown()).optional(),
}).passthrough();

function parseFeatureNumber(context: Ctx): number | null {
  const raw = context.params?.number;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// Build an issue-shaped object from the desired new state so we can write D1
// before GitHub. Mirrors the column set upsertFeatureRow expects.
function synthesizeIssue(
  { row, number, title, body, status, backlog, owners }:
  { row: Record<string, any>; number: number; title: string; body: string; status: string; backlog: boolean; owners: string[] },
) {
  return {
    number,
    title,
    state: "open",
    body,
    labels: buildFeatureLabels(status, backlog).map((name: string) => ({ name, color: "" })),
    assignees: owners.map((login) => ({ login, avatar_url: "" })),
    milestone: row.milestone_title ? { title: row.milestone_title } : null,
    html_url: row.html_url,
    created_at: row.created_at,
    updated_at: new Date().toISOString(),
  };
}

// PATCH /api/features/:number
// Body: { title?, status?, owners?: string[], plan?: string }
// Any omitted field is left unchanged on GitHub (the current value is sent
// back so a partial update doesn't blank out a field we didn't touch).
export async function onRequestPatch(context: Ctx): Promise<Response> {
  const { orgId, orgLogin } = getCtx(context) as { orgId: number; orgLogin: string };
  if (!orgLogin) return errorResponse("Missing org context", 400);

  const number = parseFeatureNumber(context);
  if (!number) return errorResponse("Invalid feature number", 400);

  let rawBody: unknown;
  try { rawBody = await context.request.json(); } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const delegated = await delegateFeatureMutation(context.env, {
    orgId,
    userLogin: context.data.userLogin,
    isAdmin: context.data.isAdmin,
  }, context.request, "update", number, rawBody);
  if (delegated) return delegated;

  const parsed = validate(PatchFeatureBody, rawBody);
  if (!parsed.ok) return parsed.response;
  const payload = parsed.data;

  const row = await readFeatureRow(context.env.DB, orgId, number);
  if (!row) return errorResponse("Feature not found", 404);

  // Compose desired state from request + current D1 row.
  const currentLabels = JSON.parse(row.labels_json || "[]");
  const currentStatus = extractStatusFromLabels(currentLabels);
  const currentAssignees = JSON.parse(row.assignees_json || "[]");
  const { content: currentPlan, metadata: currentMetadata } = parseFeatureMetadata(row.body ?? "");

  const title = typeof payload?.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : row.title;

  const stages = await resolveBoardStages(context.env.DB, orgId);
  const validStatusIds = new Set(stages.map((s) => s.id));

  let status = currentStatus;
  if (payload?.status !== undefined) {
    if (!validStatusIds.has(payload.status)) {
      return errorResponse(`Invalid status: ${payload.status}`, 422);
    }
    status = payload.status;
  }

  const currentBacklog = extractBacklogFromLabels(currentLabels);
  const backlog = payload?.backlog !== undefined ? payload.backlog : currentBacklog;

  let owners = currentAssignees.map((a: { login: string }) => a.login);
  if (Array.isArray(payload?.owners)) {
    owners = payload.owners.filter(
      (o) => typeof o === "string" && /^[a-zA-Z0-9-]+$/.test(o),
    ) as string[];
  }

  // Plan is retired — features no longer carry a description of their own,
  // Specs are the sole content surface. Preserve any legacy content already
  // in the body so we don't wipe historical plans on the GitHub side.
  const plan = currentPlan;

  // Status history: append on transition only. Re-saves with the same status
  // don't duplicate entries.
  const statusHistory = [...(currentMetadata.statusHistory ?? [])];
  if (status !== currentStatus) {
    statusHistory.push({ status, timestamp: new Date().toISOString() });
  }

  // Spec links: replace wholesale when the field is present (the UI always
  // sends the full list), otherwise keep what's stored. Sanitized to http(s)
  // URLs before they're written into the issue body.
  const specLinks = payload?.specLinks !== undefined
    ? sanitizeSpecLinks(payload.specLinks)
    : (currentMetadata.specLinks ?? []);

  // Spread currentMetadata so any unknown-to-us field survives the
  // round-trip instead of being silently dropped when the body is rebuilt.
  const body = buildIssueBody(plan, {
    ...currentMetadata,
    statusHistory,
    specLinks,
  });

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed for this org", 412);

  // Optimistic write: mark D1 as locally-edited (gh_synced_at stays at its
  // last GH-synced value), respond now. The GitHub call runs in waitUntil;
  // if it succeeds the row gets re-mirrored as in-sync. If it fails, the
  // 30-min cron's syncFeatures will detect d1.updated_at > d1.gh_synced_at
  // and push the change to GitHub on the next tick — no more silent reverts.
  const optimistic = synthesizeIssue({ row, number, title, body, status, backlog, owners });
  await upsertFeatureRow(context.env.DB, orgId, optimistic, { from: "local" });

  // Only send the fields the caller actually changed. GitHub PATCH is
  // additive per-field — anything omitted stays as-is. Blindly sending
  // title/body/labels/assignees on every PATCH created a lost-update race:
  // two concurrent PATCHes that read the same D1 snapshot would each
  // overwrite the other's field. This diff keeps concurrent edits from
  // stepping on each other (as long as they touch different fields).
  const titleChanged = payload?.title !== undefined && title !== row.title;
  const ownersChanged = payload?.owners !== undefined;
  const statusChanged = status !== currentStatus;
  const backlogChanged = backlog !== currentBacklog;
  const specLinksChanged = payload?.specLinks !== undefined;
  const labelsChanged = statusChanged || backlogChanged;
  const bodyChanged = statusChanged || specLinksChanged;

  const ghPatch: Record<string, unknown> = {};
  if (titleChanged) ghPatch.title = title;
  if (bodyChanged) ghPatch.body = body;
  if (labelsChanged) ghPatch.labels = buildFeatureLabels(status, backlog);
  if (ownersChanged) ghPatch.assignees = owners;

  const ghWrite = (async () => {
    // No fields changed — the caller sent a no-op PATCH (or the values
    // matched what was already there). Skip the GitHub round-trip
    // entirely; the D1 row already reflects the identity write above.
    if (Object.keys(ghPatch).length === 0) return;
    const token = await getInstallationToken(context.env, installationId);
    // Make sure the status:<id> label exists on GitHub before patching —
    // GitHub rejects PATCHes referencing nonexistent labels. The helper is
    // cached per-org so this is a no-op after the first hit.
    await ensureNoxTicketRepoLabels(token, orgLogin, stages);
    const ghIssue = await patchFeatureIssue(token, orgLogin, number, ghPatch);
    await upsertFeatureRow(context.env.DB, orgId, ghIssue, { from: "github" });
  })();
  context.waitUntil(
    ghWrite.catch(async (err) => {
      console.error("[features:patch] GitHub PATCH failed (waitUntil)", { number, status: err?.status, msg: err?.message, ghBody: err?.ghBody });
      await recordFailure(context.env.DB, {
        ownerId: orgLogin,
        op: "patchFeatureIssue",
        deliveryId: `feature-${number}`,
        error: err,
      });
    }),
  );

  return jsonResponse(ghIssueToFeature(optimistic));
}

// DELETE /api/features/:number — close the issue on GitHub, strip
// noxticket/feature/status labels so it disappears from the board, and mark
// D1 closed. Optimistic: D1 closes first; GitHub close runs in waitUntil.
export async function onRequestDelete(context: Ctx): Promise<Response> {
  const { orgId, orgLogin } = getCtx(context) as { orgId: number; orgLogin: string };
  if (!orgLogin) return errorResponse("Missing org context", 400);

  const number = parseFeatureNumber(context);
  if (!number) return errorResponse("Invalid feature number", 400);

  const delegated = await delegateFeatureMutation(context.env, {
    orgId,
    userLogin: context.data.userLogin,
    isAdmin: context.data.isAdmin,
  }, context.request, "close", number);
  if (delegated) return delegated;

  const row = await readFeatureRow(context.env.DB, orgId, number);
  if (!row) return errorResponse("Feature not found", 404);

  // Drop NoxTicket-owned labels but keep any user-applied ones.
  const currentLabels = JSON.parse(row.labels_json || "[]");
  const keepLabels = currentLabels
    .map((l: { name: string }) => l.name)
    .filter(
      (name: string) =>
        name !== NOXTICKET_LABEL &&
        !hasNoxTicketLabel([name]) &&
        name !== FEATURE_LABEL &&
        !name.startsWith("status:"),
    );

  const installationId = await getInstallationIdForOrg(context.env.DB, orgId);
  if (!installationId) return errorResponse("GitHub App not installed for this org", 412);

  // Optimistic D1 close marked as a local edit — bumps updated_at but
  // leaves gh_synced_at, so cron syncFeatures will push the close to
  // GitHub on the next tick if the inline waitUntil fails.
  //
  // Detach any specs that pointed at this feature in the same batch so
  // they don't become orphans referencing a closed issue. Since migration
  // 0037 the truth is `spec.feature_number`, and no cascade FK exists
  // yet — this is the natural moment to null it out.
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE features
          SET state = 'closed',
              labels_json = ?,
              updated_at = ?
        WHERE org_id = ? AND number = ?`,
    )
      .bind(
        JSON.stringify(keepLabels.map((name: string) => ({ name, color: "" }))),
        new Date().toISOString(),
        orgId,
        number,
      ),
    context.env.DB.prepare(
      `UPDATE specs
          SET feature_number = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE org_id = ? AND feature_number = ?`,
    ).bind(orgId, number),
  ]);

  const ghWrite = (async () => {
    const token = await getInstallationToken(context.env, installationId);
    const ghIssue = await patchFeatureIssue(token, orgLogin, number, {
      labels: keepLabels,
      state: "closed",
    });
    await upsertFeatureRow(context.env.DB, orgId, ghIssue, { from: "github" });
  })();
  context.waitUntil(
    ghWrite.catch(async (err) => {
      console.error("[features:delete] GitHub PATCH failed (waitUntil)", { number, status: err?.status, msg: err?.message, ghBody: err?.ghBody });
      await recordFailure(context.env.DB, {
        ownerId: orgLogin,
        op: "deleteFeatureIssue",
        deliveryId: `feature-${number}`,
        error: err,
      });
    }),
  );

  return jsonResponse({ ok: true });
}
