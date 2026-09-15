import { getCtx, jsonResponse, errorResponse } from "../lib/db";
import { getInstallationToken, signAppJwt } from "../lib/github-app";
import { setInstallationRepos, upsertInstallation } from "../lib/gh-mirror";

// GET /api/projects — list projects (narrator scope) for this org.
//
// Source of truth is installations.repos_json, maintained by GitHub App
// install/repo webhooks. We sync into the projects table on every read so
// the dashboard reflects the current install set independent of webhook
// timing. If repos_json is empty (e.g. an installation that predates the
// webhook fix), we bootstrap by pulling /installation/repositories from
// GitHub via an installation token.
export async function onRequestGet(context) {
  const { orgLogin, orgId, auth } = getCtx(context);
  if (!orgLogin) return errorResponse("Missing org context", 400);

  const db = context.env.DB;

  await ensureInstallationsRow(db, orgLogin, orgId);
  await discoverInstallationViaApp(context.env, orgLogin);
  await bootstrapReposIfEmpty(context.env, orgLogin);
  await syncProjectsFromInstallations(db, orgLogin);

  const rows = await db.prepare(
    `SELECT project.id, project.name, project.slug, project.org, project.repo,
            project.description, project.narrator_enabled,
            COALESCE(routing.enabled, 0) AS routing_enabled,
            CASE
              WHEN project.archived = 1
                OR repo.archived_at IS NOT NULL
                OR repo.retired_at IS NOT NULL
              THEN 1 ELSE 0
            END AS archived,
            COALESCE(project.archived_at, repo.archived_at, repo.retired_at) AS archived_at,
            project.updated_at
     FROM projects project
     LEFT JOIN repos repo ON repo.org_id = ? AND repo.name = project.repo
     LEFT JOIN project_routing_settings routing
       ON routing.org_id = ? AND routing.project_id = project.id
     WHERE project.org_id = ?
     ORDER BY archived, COALESCE(project.org, ''), project.name`
  ).bind(orgId, orgId, orgId).all();

  const projects = rows.results ?? [];
  if (auth?.accessLevel !== "guest" || auth.guestAccess?.organizationWide === true) {
    return jsonResponse({ projects });
  }
  const allowed = new Set(Object.keys(auth?.guestAccess?.projects ?? {}));
  return jsonResponse({ projects: projects.filter((project) => allowed.has(project.id)) });
}

// If `orgs.installation_id` is set but no installations row exists yet
// (legacy installs from before the upsertInstallation flow), seed one so
// the rest of the pipeline works.
async function ensureInstallationsRow(db, orgLogin, orgId) {
  const existing = await db.prepare(
    "SELECT installation_id FROM installations WHERE owner_id = ? LIMIT 1"
  ).bind(orgLogin).first();
  if (existing) return;

  const org = await db.prepare(
    "SELECT installation_id FROM orgs WHERE id = ?"
  ).bind(orgId).first();
  if (!org?.installation_id) return;

  await upsertInstallation(db, {
    id: org.installation_id,
    account: { login: orgLogin, type: "Organization" },
  });
}

// Last-resort discovery: if we have no installations row AND no
// orgs.installation_id, ask GitHub directly with an App JWT. Covers users
// who installed the app before the install webhook handler shipped.
async function discoverInstallationViaApp(env, ownerId) {
  const existing = await env.DB.prepare(
    "SELECT installation_id FROM installations WHERE owner_id = ? LIMIT 1"
  ).bind(ownerId).first();
  if (existing) return;

  // Webhook + install paths throw on missing App credentials. This path used
  // to silently no-op, which hid a real misconfiguration: users with no
  // installations row saw `{projects: []}` instead of an error. Make it loud
  // so the missing env vars get spotted (matches signAppJwt's behavior).
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required for installation discovery");
  }

  let jwt;
  try {
    jwt = await signAppJwt(env);
  } catch (err) {
    console.error("[noxconnect projects] signAppJwt failed:", err);
    return;
  }

  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "NoxConnect",
  };

  // Try org first, then user installation.
  for (const path of [
    `/orgs/${encodeURIComponent(ownerId)}/installation`,
    `/users/${encodeURIComponent(ownerId)}/installation`,
  ]) {
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (res.status === 404) continue;
    if (!res.ok) {
      console.error(`[noxconnect projects] discover ${path} ${res.status}`);
      return;
    }
    const data = await res.json();
    if (!data?.id) return;
    await upsertInstallation(env.DB, {
      id: data.id,
      account: data.account || { login: ownerId },
    });
    return;
  }
}

// For each installation belonging to this owner, if repos_json is empty,
// fetch the installation's accessible repositories from GitHub once and
// persist. Bootstrap-only — the webhook keeps it fresh from there.
async function bootstrapReposIfEmpty(env, ownerId) {
  const insts = await env.DB.prepare(
    "SELECT installation_id, repos_json FROM installations WHERE owner_id = ?"
  ).bind(ownerId).all();

  for (const inst of insts.results ?? []) {
    if (inst.repos_json && inst.repos_json !== "[]") continue;
    try {
      const fullNames = await fetchInstallationRepos(env, inst.installation_id);
      await setInstallationRepos(env.DB, inst.installation_id, fullNames);
    } catch (err) {
      console.error("[noxconnect projects] bootstrap fetch failed:", inst.installation_id, err);
    }
  }
}

async function fetchInstallationRepos(env, installationId) {
  const token = await getInstallationToken(env, installationId);
  const out = [];
  let page = 1;
  while (page <= 10) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "NoxConnect",
        },
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`installation/repositories ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const repos = Array.isArray(data?.repositories) ? data.repositories : [];
    for (const r of repos) {
      if (r?.full_name) out.push(r.full_name);
    }
    if (repos.length < 100) break;
    page++;
  }
  return out;
}

async function syncProjectsFromInstallations(db, ownerId) {
  const insts = await db.prepare(
    "SELECT installation_id, repos_json FROM installations WHERE owner_id = ?"
  ).bind(ownerId).all();

  const upserts = [];
  for (const inst of insts.results ?? []) {
    if (!inst.repos_json) continue;
    let repos;
    try {
      repos = JSON.parse(inst.repos_json);
    } catch (err) {
      // Surface corruption — silently skipping made installations look like
      // they had no repos and stranded projects in the dashboard.
      console.error(
        `[noxconnect projects] Corrupt repos_json for installation ${inst.installation_id} owner=${ownerId}:`,
        err?.message ?? err,
      );
      continue;
    }
    if (!Array.isArray(repos)) {
      console.error(
        `[noxconnect projects] repos_json is not an array for installation ${inst.installation_id} owner=${ownerId}`,
      );
      continue;
    }

    for (const fullName of repos) {
      if (typeof fullName !== "string" || !fullName.includes("/")) continue;
      const [org, repo] = fullName.split("/", 2);
      if (!org || !repo) continue;
      const projectId = `proj_${org}_${repo}`.toLowerCase();
      upserts.push(
        db.prepare(
          `INSERT OR IGNORE INTO projects (id, name, org, repo, owner_id, org_id, updated_at)
           VALUES (?, ?, ?, ?, ?, (SELECT id FROM orgs WHERE github_login = ? COLLATE NOCASE), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
        ).bind(projectId, repo, org, repo, ownerId, ownerId)
      );
    }
  }
  if (upserts.length > 0) await db.batch(upserts);
}
