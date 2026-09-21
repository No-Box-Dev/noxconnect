-- Exact NoxCue delivery deduplication and group-only diagnostic retention.
-- Receipts contain no error body or user identity and expire after seven days.
CREATE TABLE cue_error_receipts (
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL REFERENCES cue_sources(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  ingest_token TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  PRIMARY KEY (source_id, event_id)
);

CREATE INDEX idx_cue_error_receipts_expiry
  ON cue_error_receipts(expires_at);

ALTER TABLE cue_error_groups ADD COLUMN grouping_kind TEXT NOT NULL DEFAULT 'inferred'
  CHECK (grouping_kind IN ('explicit', 'inferred'));
ALTER TABLE cue_error_groups ADD COLUMN sample_json TEXT
  CHECK (sample_json IS NULL OR json_valid(sample_json));
ALTER TABLE cue_error_groups ADD COLUMN first_release TEXT;
ALTER TABLE cue_error_groups ADD COLUMN last_release TEXT;

CREATE TABLE cue_error_group_users (
  org_id       INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  user_hash    TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (source_id, fingerprint, user_hash),
  FOREIGN KEY (source_id, fingerprint)
    REFERENCES cue_error_groups(source_id, fingerprint) ON DELETE CASCADE
);

CREATE INDEX idx_cue_error_group_users_group
  ON cue_error_group_users(source_id, fingerprint);
