ALTER TABLE spot_reports ADD COLUMN resolution_ai_status TEXT NOT NULL DEFAULT 'not_requested'
  CHECK (resolution_ai_status IN ('not_requested', 'pending', 'generating', 'ready', 'insufficient', 'failed'));
ALTER TABLE spot_reports ADD COLUMN resolution_ai_evidence_source TEXT;
ALTER TABLE spot_reports ADD COLUMN resolution_ai_model TEXT;
ALTER TABLE spot_reports ADD COLUMN resolution_ai_last_error TEXT;

CREATE INDEX spot_reports_resolution_ai_recovery
  ON spot_reports(resolution_ai_status, updated_at)
  WHERE resolution_ai_status IN ('pending', 'generating', 'failed');
