ALTER TABLE app_user ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS app_user_last_seen_idx ON app_user (last_seen_at) WHERE handle IS NOT NULL;

ALTER TABLE user_ban ADD COLUMN IF NOT EXISTS banned_by TEXT NULL;
