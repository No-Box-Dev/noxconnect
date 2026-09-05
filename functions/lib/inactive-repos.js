// Source of truth for which repos are inactive in this org.
// A repo is inactive (and therefore excluded from sync, the issues/PRs
// endpoints, and any other "all repos" surface) if any of:
//   - has projects.archived = 1 (platform-level archive, toggled from the
//     Repos tab)
//   - has repos.archived_at IS NOT NULL (GitHub-side archive, captured by
//     the `repository.archived` webhook)
//   - has repos.retired_at IS NOT NULL (deleted, transferred, or App access removed)
//   - is the configured "noxconnect" repo (settings.noxTicketRepo, default
//     "noxconnect") — that repo holds features/todos/plans, not product work
//
// Returns a Set<string> of repo names to exclude.
import { normalizeNoxSettings } from "./naming-compat.js";

export async function getInactiveRepoSet(db, orgId, orgLogin) {
  const [settingsRow, archivedRows, ghArchivedRows] = await db.batch([
    db.prepare("SELECT data FROM config WHERE org_id = ? AND key = 'settings'").bind(orgId),
    db.prepare("SELECT repo FROM projects WHERE owner_id = ? AND archived = 1").bind(orgLogin),
    db.prepare("SELECT name FROM repos WHERE org_id = ? AND (archived_at IS NOT NULL OR retired_at IS NOT NULL)").bind(orgId),
  ]);

  const exclude = new Set();
  let noxTicketRepo = "noxconnect";
  const settingsData = settingsRow.results?.[0]?.data;
  if (settingsData) {
    let parsed;
    try {
      parsed = normalizeNoxSettings(JSON.parse(settingsData));
    } catch (e) {
      // Fail loud rather than silently reverting noxTicketRepo to "noxconnect":
      // that would re-expose the features-tracking repo in every issue/PR
      // surface the moment a corrupt row landed in D1.
      console.error(`[noxconnect] Corrupt settings JSON for org ${orgId}:`, e?.message ?? e);
      throw new Error(`Corrupt settings JSON for org ${orgId} — fix the row in the config table before proceeding`);
    }
    if (typeof parsed.noxTicketRepo === "string" && parsed.noxTicketRepo.trim()) {
      noxTicketRepo = parsed.noxTicketRepo.trim();
    }
  }
  exclude.add(noxTicketRepo);

  for (const row of archivedRows.results ?? []) {
    if (row.repo) exclude.add(row.repo);
  }

  for (const row of ghArchivedRows.results ?? []) {
    if (row.name) exclude.add(row.name);
  }

  return exclude;
}

// Resolve the configured noxconnect repo name (settings.noxTicketRepo, default
// "noxconnect"). The noxconnect repo holds features/todos/plans, not product work,
// and is read separately from the product-repo sync.
export async function getNoxTicketRepoName(db, orgId) {
  const settingsRow = await db
    .prepare("SELECT data FROM config WHERE org_id = ? AND key = 'settings'")
    .bind(orgId)
    .first();
  if (settingsRow?.data) {
    let parsed;
    try {
      parsed = normalizeNoxSettings(JSON.parse(settingsRow.data));
    } catch (e) {
      console.error(`[noxconnect] Corrupt settings JSON for org ${orgId}:`, e?.message ?? e);
      throw new Error(`Corrupt settings JSON for org ${orgId} — fix the row in the config table before proceeding`);
    }
    if (typeof parsed.noxTicketRepo === "string" && parsed.noxTicketRepo.trim()) {
      return parsed.noxTicketRepo.trim();
    }
  }
  return "noxconnect";
}

export async function filterInactive(db, orgId, orgLogin, repoNames) {
  if (!Array.isArray(repoNames) || repoNames.length === 0) return repoNames ?? [];
  const exclude = await getInactiveRepoSet(db, orgId, orgLogin);
  return exclude.size > 0 ? repoNames.filter((n) => !exclude.has(n)) : repoNames;
}

// Active list = every repo in `repos` minus everything `getInactiveRepoSet`
// would exclude. Used by read endpoints to filter via `repo IN (?, ?, …)`
// instead of `NOT IN (capped-list)` — keeps the bind count bounded by the
// active count (small in practice) and never silently drops inactive repos
// past the old 30-bind cap.
export async function getActiveRepoNames(db, orgId, orgLogin, projectId = null) {
  const [reposRow, inactive] = await Promise.all([
    projectId
      ? db.prepare(
        `SELECT repo.name
           FROM repos repo
           JOIN project_repositories assignment
             ON assignment.org_id = repo.org_id AND assignment.repo = repo.name
          WHERE repo.org_id = ? AND assignment.project_id = ?`,
      ).bind(orgId, projectId).all()
      : db.prepare("SELECT name FROM repos WHERE org_id = ?").bind(orgId).all(),
    getInactiveRepoSet(db, orgId, orgLogin),
  ]);
  const out = [];
  for (const row of reposRow.results ?? []) {
    if (row?.name && !inactive.has(row.name)) out.push(row.name);
  }
  return out;
}
