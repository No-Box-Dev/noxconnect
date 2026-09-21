import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0094_noxcue_atomic_error_groups.sql"),
  "utf8",
);

describe("NoxCue grouped-error storage contract", () => {
  it("uses a source/event receipt as the exact deduplication boundary", () => {
    expect(migration).toContain("PRIMARY KEY (source_id, event_id)");
    expect(migration).toContain("ingest_token TEXT NOT NULL");
    expect(migration).toContain("idx_cue_error_receipts_expiry");
  });

  it("retains group evidence and hashed membership without an occurrence body table", () => {
    expect(migration).toContain("sample_json TEXT");
    expect(migration).toContain("first_release TEXT");
    expect(migration).toContain("last_release TEXT");
    expect(migration).toContain("user_hash    TEXT NOT NULL");
    expect(migration).not.toMatch(/CREATE TABLE\s+cue_error_occurrences/i);
    expect(migration).not.toMatch(/\b(email|user_id|error_json|payload_json)\b/i);
  });
});
