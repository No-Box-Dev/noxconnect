import { normalizeNoxSettings } from "./naming-compat.js";

export interface StoredSlackSettings {
  settings: Record<string, unknown>;
  slack: Record<string, unknown>;
  raw: string | null;
}

// One strict reader for every agent-facing Slack setup endpoint. Corrupt
// config must fail visibly instead of making an agent "repair" healthy routes
// from an empty fallback view.
export async function readSlackSettings(db: D1Database, orgId: number, projectId?: string | null): Promise<StoredSlackSettings> {
  const row = await db.prepare(
    projectId
      ? "SELECT data FROM project_config WHERE org_id = ? AND project_id = ? AND key = 'settings'"
      : "SELECT data FROM config WHERE org_id = ? AND key = 'settings'",
  ).bind(...(projectId ? [orgId, projectId] : [orgId])).first<{ data: string }>();
  if (!row) return { settings: {}, slack: {}, raw: null };
  try {
    const settings = normalizeNoxSettings(JSON.parse(String(row.data))) as Record<string, unknown>;
    const slack = settings.slack && typeof settings.slack === "object" && !Array.isArray(settings.slack)
      ? settings.slack as Record<string, unknown>
      : {};
    return { settings, slack, raw: String(row.data) };
  } catch {
    throw new Error("Corrupt settings config — repair before continuing");
  }
}

export function resolveSavedSlackChannel(slack: Record<string, unknown>, field: string): string {
  return String(slack[field] || slack.fallbackChannelId || "").trim();
}
