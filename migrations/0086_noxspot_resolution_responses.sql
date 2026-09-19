CREATE TABLE spot_report_response_tokens (
  token_hash       TEXT PRIMARY KEY,
  token_encrypted  TEXT NOT NULL,
  resolution_key   TEXT NOT NULL UNIQUE,
  report_id        TEXT,
  org_id           INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id       TEXT NOT NULL,
  site_id          TEXT NOT NULL REFERENCES spot_sites(id) ON DELETE CASCADE,
  repo             TEXT NOT NULL,
  issue_number     INTEGER NOT NULL,
  report_title     TEXT NOT NULL,
  reporter_name    TEXT,
  expires_at       TEXT NOT NULL,
  claimed_at       TEXT,
  used_at          TEXT,
  response_id      TEXT,
  response_text    TEXT,
  screenshot_url   TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX spot_report_response_tokens_report
  ON spot_report_response_tokens(report_id, created_at DESC);
CREATE INDEX spot_report_response_tokens_expiry
  ON spot_report_response_tokens(expires_at)
  WHERE used_at IS NULL;
