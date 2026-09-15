// Per-org board stage resolution + validation. Mirrors src/lib/board-stages.ts.
//
// Stages live inside the `settings` config row (key="settings", JSON column).
// The default list matches the historical hardcoded scheme so D1 rows and
// GitHub `status:*` labels written before this feature shipped keep mapping
// to the same columns until an admin customises them.

export const DEFAULT_BOARD_STAGES = [
  { id: "todo",       label: "To do",                color: "#94a3b8" },
  { id: "specced",    label: "Specced",              color: "#8b83b8" },
  { id: "staging",    label: "Testing on staging",   color: "#b89464" },
  { id: "ready",      label: "Ready for production", color: "#6a9991" },
  { id: "production", label: "On production",        color: "#6e9970" },
];

export const MIN_BOARD_STAGES = 1;
export const MAX_BOARD_STAGES = 10;

const STAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export async function resolveBoardStages(db, orgId, projectId) {
  const row = await db
    .prepare(projectId
      ? "SELECT data FROM project_config WHERE org_id = ? AND project_id = ? AND key = ?"
      : "SELECT data FROM config WHERE org_id = ? AND key = ?")
    .bind(...(projectId ? [orgId, projectId, "settings"] : [orgId, "settings"]))
    .first();
  if (!row) return DEFAULT_BOARD_STAGES;
  try {
    const data = JSON.parse(row.data);
    const stages = data?.boardStages;
    if (Array.isArray(stages) && stages.length > 0) return stages;
    return DEFAULT_BOARD_STAGES;
  } catch {
    return DEFAULT_BOARD_STAGES;
  }
}

// Returns { ok: true } or { ok: false, error: string } so callers can decide
// the HTTP status. Pure (no DB access) — pass the parsed array in.
export function validateBoardStages(stages) {
  if (!Array.isArray(stages)) return { ok: false, error: "boardStages must be an array" };
  if (stages.length < MIN_BOARD_STAGES) {
    return { ok: false, error: `boardStages must have at least ${MIN_BOARD_STAGES} stage` };
  }
  if (stages.length > MAX_BOARD_STAGES) {
    return { ok: false, error: `boardStages may have at most ${MAX_BOARD_STAGES} stages` };
  }
  const seen = new Set();
  for (const stage of stages) {
    if (!stage || typeof stage !== "object") {
      return { ok: false, error: "Each stage must be an object" };
    }
    if (typeof stage.id !== "string" || !STAGE_ID_RE.test(stage.id)) {
      return { ok: false, error: `Invalid stage id: ${stage.id}` };
    }
    if (seen.has(stage.id)) {
      return { ok: false, error: `Duplicate stage id: ${stage.id}` };
    }
    seen.add(stage.id);
    if (typeof stage.label !== "string" || !stage.label.trim() || stage.label.length > 50) {
      return { ok: false, error: `Invalid stage label for "${stage.id}"` };
    }
    if (typeof stage.color !== "string" || !HEX_COLOR_RE.test(stage.color)) {
      return { ok: false, error: `Invalid stage color for "${stage.id}" (expected #RRGGBB)` };
    }
  }
  return { ok: true };
}
