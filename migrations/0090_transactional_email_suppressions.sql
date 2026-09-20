CREATE TABLE transactional_email_suppressions (
  recipient_hash    TEXT PRIMARY KEY,
  reason            TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'spam_complaint')),
  message_stream    TEXT NOT NULL,
  provider_event_at TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX transactional_email_suppressions_time
  ON transactional_email_suppressions(provider_event_at DESC);
