-- Explicit NoxCue errors stay actionable until a person acknowledges or resolves them.
-- A later occurrence reopens a resolved group; ingestion never claims recovery.
ALTER TABLE cue_error_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'acknowledged', 'resolved'));
ALTER TABLE cue_error_groups ADD COLUMN acknowledged_at TEXT;
ALTER TABLE cue_error_groups ADD COLUMN acknowledged_by TEXT;
ALTER TABLE cue_error_groups ADD COLUMN resolved_at TEXT;
ALTER TABLE cue_error_groups ADD COLUMN resolved_by TEXT;

-- Existing groups predate lifecycle controls and must not suddenly appear as
-- active incidents. The next genuine occurrence reopens the group in NoxCue.
UPDATE cue_error_groups
   SET status = 'resolved',
       resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
       resolved_by = 'migration';

CREATE INDEX idx_cue_error_groups_org_status_last_seen
  ON cue_error_groups(org_id, status, last_seen_at DESC);
