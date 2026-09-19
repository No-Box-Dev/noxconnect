-- Password-based public portals were replaced by named, email-based guest
-- access. Remove all password hashes, session tokens, attempts, and share
-- links so the retired authentication path cannot be reactivated.

DROP TABLE IF EXISTS external_project_share_attempts;
DROP TABLE IF EXISTS external_project_share_sessions;
DROP TABLE IF EXISTS external_project_shares;

DROP TABLE IF EXISTS cue_dashboard_share_attempts;
DROP TABLE IF EXISTS cue_dashboard_share_sessions;
DROP TABLE IF EXISTS cue_dashboard_shares;
