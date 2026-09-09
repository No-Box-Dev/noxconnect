import { describe, it, expect, vi } from "vitest";

vi.mock("../reconcile.js", () => ({
  reconcileOrg: vi.fn(),
}));

vi.mock("../stats-audit.js", () => ({
  runNextStatsAudit: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../database-recovery.js", () => ({
  runDatabaseRecoveryStep: vi.fn(() => Promise.resolve({ done: true, idle: true })),
}));

import worker from "../index.js";
import { reconcileOrg } from "../reconcile.js";

// D1 stub: dispatches by SQL substring. Captures binds + UPDATE results.
function makeDb({ orgs = [], installations = [] } = {}) {
  const state = { orgs: [...orgs], installations: [...installations], updates: [] };
  function prepare(sql) {
    return {
      _binds: [],
      bind(...b) { this._binds = b; return this; },
      async all() {
        if (sql.includes("FROM orgs")) {
          const matches = state.orgs.filter(
            (o) => o.installation_id != null && o.bootstrapped_at != null,
          );
          return { results: matches };
        }
        return { results: [] };
      },
      async run() {
        if (sql.includes("UPDATE orgs SET")) {
          let changes = 0;
          for (const o of state.orgs) {
            const install = state.installations.find(
              (i) => i.account_login === o.github_login,
            );
            if (!install) continue;
            const needsLink = o.installation_id == null || o.bootstrapped_at == null;
            if (!needsLink) continue;
            if (o.installation_id == null) o.installation_id = install.installation_id;
            if (o.bootstrapped_at == null) o.bootstrapped_at = new Date().toISOString();
            changes++;
          }
          state.updates.push({ kind: "heal", changes });
          return { meta: { changes } };
        }
        return { meta: { changes: 0 } };
      },
    };
  }
  return { prepare, _state: state };
}

function makeCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (p) => pending.push(p) },
    drain: () => Promise.all(pending),
  };
}

describe("scheduled tick", () => {
  it("does not expose manual cron controls without the local-only enable flag", async () => {
    const { ctx } = makeCtx();
    const response = await worker.fetch(new Request("https://x/__scheduled"), { DB: makeDb() }, ctx);
    expect(response.status).toBe(404);
    expect(reconcileOrg).not.toHaveBeenCalled();
  });

  it("heals orgs missing installation_id/bootstrapped_at before dispatching reconcile", async () => {
    vi.mocked(reconcileOrg).mockReset();
    const db = makeDb({
      orgs: [
        { id: 1, github_login: "acme", installation_id: null, bootstrapped_at: null },
        { id: 2, github_login: "n1", installation_id: null, bootstrapped_at: null },
      ],
      installations: [
        { installation_id: 111, account_login: "acme" },
        { installation_id: 222, account_login: "n1" },
      ],
    });

    const { ctx, drain } = makeCtx();
    await worker.fetch(new Request("https://x/__scheduled"), { DB: db, ENABLE_MANUAL_CRON: "true" }, ctx);
    await drain();

    expect(db._state.orgs[0].installation_id).toBe(111);
    expect(db._state.orgs[0].bootstrapped_at).not.toBeNull();
    expect(db._state.orgs[1].installation_id).toBe(222);
    expect(reconcileOrg).toHaveBeenCalledTimes(2);
    expect(reconcileOrg).toHaveBeenCalledWith(expect.anything(), db, 1, "acme", 111);
    expect(reconcileOrg).toHaveBeenCalledWith(expect.anything(), db, 2, "n1", 222);
  });

  it("leaves orgs without a matching installation alone (no reconcile, no heal)", async () => {
    vi.mocked(reconcileOrg).mockReset();
    const db = makeDb({
      orgs: [
        { id: 1, github_login: "stranger", installation_id: null, bootstrapped_at: null },
      ],
      installations: [],
    });

    const { ctx, drain } = makeCtx();
    await worker.fetch(new Request("https://x/__scheduled"), { DB: db, ENABLE_MANUAL_CRON: "true" }, ctx);
    await drain();

    expect(db._state.orgs[0].installation_id).toBeNull();
    expect(db._state.orgs[0].bootstrapped_at).toBeNull();
    expect(reconcileOrg).not.toHaveBeenCalled();
  });

  it("preserves an existing bootstrapped_at when only installation_id is missing", async () => {
    vi.mocked(reconcileOrg).mockReset();
    const existingStamp = "2026-01-01 00:00:00";
    const db = makeDb({
      orgs: [
        { id: 1, github_login: "acme", installation_id: null, bootstrapped_at: existingStamp },
      ],
      installations: [{ installation_id: 111, account_login: "acme" }],
    });

    const { ctx, drain } = makeCtx();
    await worker.fetch(new Request("https://x/__scheduled"), { DB: db, ENABLE_MANUAL_CRON: "true" }, ctx);
    await drain();

    expect(db._state.orgs[0].installation_id).toBe(111);
    expect(db._state.orgs[0].bootstrapped_at).toBe(existingStamp);
  });
});
