// Webhook → events INSERT path. One row per github action (pr:opened,
// pr:merged, push, issues:opened, ...). Read by the in-app Posts tab and
// (later) the narrator cron, which writes back rows of type='narrative'.
//
// Ported from workers/noxlink-brain/src/webhook.ts (storeEvent + helpers).

import { resolveActorFromGithub } from "./actors";
import { upsertGhUser } from "./gh-mirror";
import { narrateEvent } from "./narrator";

export function mapEventType(ghEvent, action, payload) {
  switch (ghEvent) {
    case "pull_request":
      if (action === "opened") return "github:pr:opened";
      // A draft flipping to "ready for review" is what actually belongs in
      // the Opened feed — the previous opened event was gated out because
      // pr.draft was true. Map it to the same type so narratePrOpened runs
      // with draft=false and the pr_narrative UNIQUE INDEX dedups against
      // any accidental double-open.
      if (action === "ready_for_review") return "github:pr:opened";
      if (action === "closed") return payload.pull_request?.merged ? "github:pr:merged" : "github:pr:closed";
      if (action === "reopened") return "github:pr:reopened";
      return null;
    case "push":
      return "github:push";
    case "release":
      if (action === "published") return "github:release:published";
      return null;
    case "issues":
      if (action === "opened") return "github:issue:opened";
      if (action === "closed") return "github:issue:closed";
      return null;
    case "pull_request_review":
      if (action === "submitted") {
        const state = payload.review?.state;
        if (state === "approved") return "github:pr:review:approved";
        if (state === "changes_requested") return "github:pr:review:changes_requested";
        if (state === "commented") return "github:pr:review:commented";
      }
      return null;
    case "repository":
      if (action === "archived") return "github:repo:archived";
      if (action === "unarchived") return "github:repo:unarchived";
      if (action === "deleted") return "github:repo:deleted";
      if (action === "transferred") return "github:repo:transferred";
      if (action === "renamed") return "github:repo:renamed";
      return null;
    case "installation":
      return `github:installation:${action ?? "unknown"}`;
    case "installation_repositories":
      return `github:installation_repos:${action ?? "unknown"}`;
    default:
      return null;
  }
}

function pickAuthor(ghEvent, payload) {
  const candidate =
    ghEvent === "pull_request" ? payload.pull_request?.user :
    ghEvent === "issues" ? payload.issue?.user :
    ghEvent === "release" ? payload.release?.author :
    ghEvent === "pull_request_review" ? payload.review?.user :
    payload.sender;
  if (!candidate?.login) return null;
  return {
    login: candidate.login,
    id: candidate.id ?? null,
    avatar_url: candidate.avatar_url ?? null,
    type: candidate.type === "Bot" ? "Bot" : candidate.type === "User" ? "User" : null,
    name: candidate.name ?? null,
  };
}

function buildSummary(type, payload) {
  if (type.startsWith("github:pr:")) {
    const pr = payload.pull_request;
    if (pr) return `PR #${pr.number}: ${pr.title}`;
  }
  if (type === "github:push") {
    const ref = payload.ref?.replace("refs/heads/", "") || "?";
    const count = payload.commits?.length ?? 0;
    return `Push to ${ref} (${count} commit${count === 1 ? "" : "s"})`;
  }
  if (type === "github:release:published") {
    return `Release ${payload.release?.tag_name ?? "?"}`;
  }
  if (type.startsWith("github:issue:")) {
    const issue = payload.issue;
    if (issue) return `Issue #${issue.number}: ${issue.title}`;
  }
  if (type.startsWith("github:pr:review:")) {
    const pr = payload.pull_request;
    const state = payload.review?.state ?? "reviewed";
    if (pr) return `Review (${state}) on PR #${pr.number}: ${pr.title}`;
  }
  if (type.startsWith("github:repo:")) {
    const action = type.split(":")[2];
    const repo = payload.repository?.full_name ?? payload.repository?.name ?? "?";
    return `Repository ${action}: ${repo}`;
  }
  if (type.startsWith("github:installation")) {
    return `Installation ${payload.action ?? ""}`.trim();
  }
  return type;
}

// Strip large fields before persisting so a single big push doesn't blow
// the row size. Mirror of NoxLink's slimPayload.
function slimPayload(ghEvent, payload) {
  if (ghEvent === "push") {
    return {
      ref: payload.ref,
      before: payload.before,
      after: payload.after,
      pusher: payload.pusher?.name,
      commits: (payload.commits ?? []).slice(0, 10).map((c) => ({
        id: c.id,
        message: c.message?.slice(0, 200),
        author: c.author?.name,
        added: c.added,
        modified: c.modified,
        removed: c.removed,
      })),
    };
  }
  if (ghEvent === "pull_request" && payload.pull_request) {
    const pr = payload.pull_request;
    return {
      action: payload.action,
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body?.slice(0, 16000),
        state: pr.state,
        merged: pr.merged,
        // Carry draft so narratePrOpened can skip drafts — see the
        // Opened-feed gate in narrator.js.
        draft: !!pr.draft,
        author: pr.user?.login,
        merged_by: pr.merged_by?.login ?? null,
        head_ref: pr.head?.ref ?? null,
        base_ref: pr.base?.ref ?? null,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
      },
    };
  }
  if (ghEvent === "pull_request_review" && payload.review) {
    const pr = payload.pull_request;
    return {
      action: payload.action,
      review: {
        state: payload.review.state,
        body: payload.review.body?.slice(0, 16000),
        author: payload.review.user?.login,
        submitted_at: payload.review.submitted_at,
      },
      pr: pr ? { number: pr.number, title: pr.title, author: pr.user?.login } : null,
    };
  }
  if (ghEvent === "repository") {
    return {
      action: payload.action,
      repo: payload.repository?.full_name ?? payload.repository?.name ?? null,
      changes: payload.changes ?? null,
    };
  }
  if (ghEvent === "issues" && payload.issue) {
    // Carry issue.number through so the reconcile path can dedup against
    // webhook-stored rows by `json_extract($.issue.number)`. Pre-existing
    // rows (slimmed to just `{action}`) get the 5-min created_at fallback
    // in event-reconcile.js.
    const issue = payload.issue;
    return {
      action: payload.action,
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user?.login ?? null,
      },
    };
  }
  return { action: payload.action };
}

// INSERT into events. Returns { id, type } on insert (type is the mapped
// event type, e.g. 'github:pr:opened'). Returns null if the event type
// isn't tracked or the delivery_id collides.
export async function storeEvent(db, ghEvent, deliveryId, payload, ownerId) {
  const action = payload.action;
  const type = mapEventType(ghEvent, action, payload);
  if (!type) return null;

  const repo = payload.repository?.name ?? null;
  const org = payload.organization?.login ?? payload.repository?.owner?.login ?? null;
  const summary = buildSummary(type, payload);

  // Auto-register the repo as a project on first sight so the dashboard
  // surfaces it immediately. Mirrors NoxLink's storeEvent.
  let projectId = null;
  if (repo && org) {
    projectId = `proj_${org}_${repo}`.toLowerCase();
    await db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, org, repo, owner_id, org_id, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT id FROM orgs WHERE github_login = ? COLLATE NOCASE), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    ).bind(projectId, repo, org, repo, ownerId, ownerId).run();
  }

  // Keep commit statistics current between repository syncs. Push payloads
  // expose GitHub's resolved author username when one is available; the
  // periodic default-branch sync later fills any unresolved identities.
  //
  // ONLY count pushes to the default branch. Squash-merged PRs produce
  // one commit on default (that's the "shipped" work) plus N commits
  // that already exist on the feature branch — if we ingested pushes to
  // any branch, we'd double-count every PR (N feature-branch pushes +
  // 1 default-branch squash commit). syncCommits (repo backfill) is
  // already default-branch-only via GitHub's default `/commits` endpoint,
  // so this gate brings the webhook path in line.
  const pushedRef = payload.ref;                                    // "refs/heads/<branch>"
  const defaultBranch = payload.repository?.default_branch;         // "develop", "main", etc.
  const isDefaultBranchPush = typeof pushedRef === "string"
    && typeof defaultBranch === "string"
    && pushedRef === `refs/heads/${defaultBranch}`;
  if (ghEvent === "push" && isDefaultBranchPush && repo && org && Array.isArray(payload.commits) && payload.commits.length > 0) {
    const orgRow = await db
      .prepare("SELECT id FROM orgs WHERE lower(github_login) = lower(?) LIMIT 1")
      .bind(ownerId)
      .first();
    if (orgRow?.id != null) {
      const commitStmt = db.prepare(
        `INSERT INTO github_commits
           (org_id, repo, sha, author, authored_at, committed_at, html_url, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(org_id, repo, sha) DO UPDATE SET
           author = COALESCE(excluded.author, github_commits.author),
           authored_at = COALESCE(excluded.authored_at, github_commits.authored_at),
           committed_at = COALESCE(excluded.committed_at, github_commits.committed_at),
           html_url = COALESCE(excluded.html_url, github_commits.html_url),
           message = COALESCE(excluded.message, github_commits.message)`,
      );
      for (let i = 0; i < payload.commits.length; i += 50) {
        await db.batch(
          payload.commits.slice(i, i + 50).map((commit) =>
            commitStmt.bind(
              orgRow.id,
              repo,
              commit.id,
              commit.author?.username ?? null,
              commit.timestamp ?? null,
              commit.timestamp ?? null,
              commit.url ?? null,
              commit.message?.slice(0, 500) ?? null,
            )),
        );
      }
    }
  }

  // Resolve the actor from whoever triggered the event. Prefer the typed
  // author for PRs/issues/releases; fall back to sender for everything else.
  const author = pickAuthor(ghEvent, payload);
  if (author?.id != null) {
    try {
      await upsertGhUser(db, {
        id: author.id,
        login: author.login,
        avatar_url: author.avatar_url,
        type: author.type ?? "User",
        name: author.name,
      });
    } catch (err) {
      console.error("[noxconnect events] upsertGhUser failed:", err);
    }
  }
  const actor = author ? await resolveActorFromGithub(db, ownerId, author) : null;

  const result = await db.prepare(
    `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     ON CONFLICT(delivery_id) DO NOTHING`
  ).bind(
    deliveryId || null,
    "github-app",
    type,
    actor?.id ?? null,
    projectId,
    org,
    repo,
    summary,
    JSON.stringify(slimPayload(ghEvent, payload)),
    ownerId,
  ).run();

  const id = result?.meta?.last_row_id;
  return id ? { id, type } : null;
}

// Build & insert a github:pr:merged event row, then kick off narration.
// Use this from anywhere we observe a merge from GitHub data (backfill,
// reconcile cron) — webhooks already go through storeEvent + narrateEvent.
// Idempotent via the caller-provided deliveryId.
//
// `pr` is the GitHub Pulls API shape (or a synthesized equivalent). At
// minimum: { number, title, user: { login, id, avatar_url, type }, merged_at }.
export async function recordMergedPr(env, args) {
  const { ownerId, projectId, org, repo, deliveryId, source, pr } = args;
  if (!pr?.number || !pr.user?.login || !pr.merged_at) return null;

  if (pr.user.id != null) {
    try {
      await upsertGhUser(env.DB, {
        id: pr.user.id,
        login: pr.user.login,
        avatar_url: pr.user.avatar_url ?? null,
        type: pr.user.type === "Bot" ? "Bot" : "User",
        name: pr.user.name ?? null,
      });
    } catch (err) {
      console.error("[noxconnect events] upsertGhUser failed:", err);
    }
  }

  const actor = await resolveActorFromGithub(env.DB, ownerId, {
    login: pr.user.login,
    id: pr.user.id ?? null,
    avatar_url: pr.user.avatar_url ?? null,
    type: pr.user.type === "Bot" ? "Bot" : "User",
    name: null,
  });
  if (!actor) return null;

  const result = await env.DB.prepare(
    `INSERT INTO events (delivery_id, source, type, actor_id, project_id, org, repo, summary, payload_json, owner_id, created_at)
     VALUES (?, ?, 'github:pr:merged', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(delivery_id) DO NOTHING`
  ).bind(
    deliveryId,
    source,
    actor.id,
    projectId,
    org,
    repo,
    `PR #${pr.number}: ${pr.title}`,
    JSON.stringify({
      action: "merged",
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body?.slice(0, 16000) ?? null,
        state: pr.state ?? "closed",
        merged: true,
        author: pr.user.login,
        merged_by: pr.merged_by?.login ?? null,
        head_ref: pr.head?.ref ?? null,
        base_ref: pr.base?.ref ?? null,
        additions: pr.additions ?? null,
        deletions: pr.deletions ?? null,
        changed_files: pr.changed_files ?? null,
      },
    }),
    ownerId,
    pr.merged_at,
  ).run();

  const eventId = result.meta?.last_row_id;
  if (!eventId) return null;
  await narrateEvent(env, eventId);
  return { id: eventId };
}
