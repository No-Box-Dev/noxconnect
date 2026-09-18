CREATE TABLE transactional_email_events (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL CHECK (event_type IN ('delivery', 'bounce', 'spam_complaint')),
  message_id        TEXT NOT NULL,
  message_stream    TEXT NOT NULL,
  tag               TEXT,
  recipient_hash    TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('delivered', 'bounce', 'spam_complaint')),
  provider_event_at TEXT NOT NULL,
  detail_code       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX transactional_email_events_message
  ON transactional_email_events(message_id, provider_event_at DESC);
CREATE INDEX transactional_email_events_stream_time
  ON transactional_email_events(message_stream, provider_event_at DESC);
