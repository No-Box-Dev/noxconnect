-- Keep undelivered terminal outcomes in the outbox audit trail. The original
-- constraint predates service enablement and route-supersession handling even
-- though both states are emitted by current delivery code.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE delivery_outbox_v2 (
  id                 TEXT PRIMARY KEY,
  org_id             INTEGER NOT NULL REFERENCES orgs(id),
  source             TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  destination        TEXT NOT NULL,
  site_id            TEXT,
  channel_id         TEXT,
  payload_json       TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'queued', 'processing', 'retrying',
                                       'blocked_configuration', 'blocked_service_disabled',
                                       'superseded', 'delivered', 'failed')),
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  last_error_code    TEXT,
  last_error         TEXT,
  next_attempt_at    TEXT,
  delivered_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  slack_message_ts   TEXT,
  slack_connection_id TEXT,
  UNIQUE (source, destination, source_id)
);

INSERT INTO delivery_outbox_v2
  (id, org_id, source, source_id, destination, site_id, channel_id, payload_json,
   status, attempt_count, last_error_code, last_error, next_attempt_at,
   delivered_at, created_at, updated_at, slack_message_ts, slack_connection_id)
SELECT id, org_id, source, source_id, destination, site_id, channel_id, payload_json,
       status, attempt_count, last_error_code, last_error, next_attempt_at,
       delivered_at, created_at, updated_at, slack_message_ts, slack_connection_id
  FROM delivery_outbox;

DROP TABLE delivery_outbox;
ALTER TABLE delivery_outbox_v2 RENAME TO delivery_outbox;

CREATE INDEX delivery_outbox_org_status
  ON delivery_outbox(org_id, status, updated_at);
CREATE INDEX delivery_outbox_site_time
  ON delivery_outbox(site_id, created_at DESC);

PRAGMA defer_foreign_keys = OFF;
