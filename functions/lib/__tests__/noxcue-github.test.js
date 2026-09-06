import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../github-app.js", () => ({
  getInstallationIdForOrg: vi.fn().mockResolvedValue(42),
  getInstallationToken: vi.fn().mockResolvedValue("installation-token"),
}));
vi.mock("../github-sync.js", () => ({ upsertIssue: vi.fn() }));
vi.mock("../apps.js", () => ({ isAppEnabled: vi.fn().mockResolvedValue(true) }));
vi.mock("../github-issues.js", () => ({
  createRepositoryIssue: vi.fn(), createRepositoryIssueComment: vi.fn(),
  ensureRepositoryLabels: vi.fn(), findIssueByBodyMarker: vi.fn(),
  getRepositoryIssue: vi.fn(), updateRepositoryIssue: vi.fn(),
}));

import { createOrUpdateNoxCueGitHubIssue } from "../noxcue-github.js";
import {
  createRepositoryIssue, ensureRepositoryLabels, findIssueByBodyMarker,
  getRepositoryIssue, updateRepositoryIssue,
} from "../github-issues.js";

const baseRow = {
  id: "incident-1", org_id: 1, project_id: "project-1", source_id: "source-1",
  environment: "production", incident_key: "auth.signup/dependency_unavailable/auth/auth_503/createaccount",
  title: "Sign up is unavailable", enabled: 1, environments_json: '["production"]',
  comment_on_repeat: 0, repeat_interval_minutes: 360, repo: "playnist", github_login: "acme",
  first_seen_at: "2026-09-05T00:00:00Z", last_seen_at: "2026-09-05T00:01:00Z",
  occurrence_count: 2, processing_occurrence_count: 2, github_issue_number: null,
  github_repo: null, previous_issue_number: null, previous_issue_url: null,
  last_github_update_at: null, last_github_release: null,
  payload_json: JSON.stringify({
    impact: "People cannot create accounts", message: "Auth returned 503",
    error: { name: "AuthError", code: "AUTH_503", status: 503, message: "Unavailable" },
    context: { release: "web-123", runtime: "browser", url: "https://app.example.test/signup" },
    diagnosis: { possibleCauses: ["The auth dependency is unavailable"], possibleFixes: ["Check the auth provider status"] },
  }),
};

function environment(row) {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql, args: [], bind(...args) { this.args = args; return this; },
        async run() { return { meta: { changes: sql.startsWith("UPDATE cue_github_incidents\n        SET status = 'processing'") ? 1 : 1 } }; },
        async first() {
          if (sql.includes("SELECT incident.*")) return row;
          if (sql.includes("SELECT status FROM cue_github_incidents")) return { status: "open" };
          return null;
        },
      };
      statements.push(statement);
      return statement;
    },
    batch: vi.fn().mockResolvedValue([]),
  };
  const buildGitHubIncident = vi.fn(async (input, previous) => ({
    marker: `<!-- noxcue-key: ${input.environment}/${input.incidentKey} -->`,
    title: `[NoxCue] ${input.title}`,
    body: `Incident key: \`${input.incidentKey}\`\n${previous?.url ? `Previous occurrence: ${previous.url}\n` : ""}has not changed the application or attempted a fix`,
    labels: [{ name: "noxcue", color: "6f42c1" }, { name: "incident", color: "d73a4a" }],
    latestRelease: "web-123",
    repeatComment: `NoxCue observed this incident again. Occurrences: **${input.occurrenceCount}**`,
  }));
  return { env: { DB: db, TASK_QUEUE: { send: vi.fn() }, NOXCUE_RESPONSE: { buildGitHubIncident } }, statements };
}

beforeEach(() => vi.clearAllMocks());

describe("NoxCue GitHub issue routing", () => {
  it("creates an issue with the readable incident key and detection-only guidance", async () => {
    const { env } = environment(baseRow);
    findIssueByBodyMarker.mockResolvedValue(null);
    createRepositoryIssue.mockResolvedValue({ number: 12, state: "open", html_url: "https://github.test/12", created_at: "2026-09-05T00:02:00Z" });
    await createOrUpdateNoxCueGitHubIssue(env, { incidentId: "incident-1" });
    expect(ensureRepositoryLabels).toHaveBeenCalled();
    expect(createRepositoryIssue).toHaveBeenCalledWith(
      "installation-token", "acme", "playnist",
      expect.objectContaining({
        title: "[NoxCue] Sign up is unavailable",
        body: expect.stringContaining("Incident key: `auth.signup/dependency_unavailable/auth/auth_503/createaccount`"),
      }),
    );
    expect(createRepositoryIssue.mock.calls[0][3].body).toContain("has not changed the application or attempted a fix");
  });

  it("deduplicates against the mapped open issue without a noisy update inside the interval", async () => {
    const row = { ...baseRow, github_issue_number: 12, github_repo: "playnist", last_github_update_at: new Date().toISOString(), last_github_release: "web-123" };
    const { env } = environment(row);
    getRepositoryIssue.mockResolvedValue({ number: 12, state: "open", html_url: "https://github.test/12" });
    await createOrUpdateNoxCueGitHubIssue(env, { incidentId: "incident-1" });
    expect(updateRepositoryIssue).not.toHaveBeenCalled();
    expect(createRepositoryIssue).not.toHaveBeenCalled();
  });

  it("opens a new linked issue when a human closed the previous occurrence", async () => {
    const row = { ...baseRow, github_issue_number: 12, github_repo: "playnist" };
    const { env } = environment(row);
    getRepositoryIssue.mockResolvedValue({ number: 12, state: "closed", html_url: "https://github.test/12" });
    createRepositoryIssue.mockResolvedValue({ number: 19, state: "open", html_url: "https://github.test/19", created_at: "2026-09-05T01:00:00Z" });
    await createOrUpdateNoxCueGitHubIssue(env, { incidentId: "incident-1" });
    expect(createRepositoryIssue).toHaveBeenCalled();
    expect(createRepositoryIssue.mock.calls[0][3].body).toContain("Previous occurrence: https://github.test/12");
  });
});
