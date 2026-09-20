-- Associate feature outcomes with a source-scoped, one-way subject hash.
-- Raw application user identifiers remain transient inside NoxCue and are
-- never stored in NoxConnect.

ALTER TABLE cue_feature_results ADD COLUMN subject_hash TEXT;

CREATE INDEX idx_cue_feature_results_source_subject_time
  ON cue_feature_results(source_id, subject_hash, received_at DESC)
  WHERE subject_hash IS NOT NULL;
