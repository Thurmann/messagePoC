CREATE TABLE IF NOT EXISTS app_user (
    google_sub      TEXT PRIMARY KEY,
    email           TEXT                     NOT NULL,
    handle          TEXT                     NULL,
    created_at      TIMESTAMPTZ              NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ              NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS app_user_handle_lower_idx ON app_user (lower(handle));

CREATE TABLE IF NOT EXISTS admin_user (
    email           TEXT PRIMARY KEY,
    source          TEXT                     NOT NULL DEFAULT 'ENV',
    created_at      TIMESTAMPTZ              NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_ban (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             TEXT                 NOT NULL REFERENCES app_user (google_sub),
    step                INTEGER              NOT NULL,
    starts_at           TIMESTAMPTZ          NOT NULL,
    ends_at             TIMESTAMPTZ          NOT NULL,
    strikes_at_ban      INTEGER              NULL,
    trigger_message_id  UUID                 NULL,
    created_at          TIMESTAMPTZ          NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_ban_user_ends_idx ON user_ban (user_id, ends_at DESC);

ALTER TABLE message_result DROP CONSTRAINT IF EXISTS message_result_status_chk;
ALTER TABLE message_result
    ADD CONSTRAINT message_result_status_chk CHECK (status IN ('VALIDATED', 'REJECTED', 'DLT'));

ALTER TABLE message_result
    ADD COLUMN IF NOT EXISTS author_id      TEXT    NULL,
    ADD COLUMN IF NOT EXISTS author_handle  TEXT    NULL,
    ADD COLUMN IF NOT EXISTS strike         BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS strikes_after  INTEGER NULL;

CREATE INDEX IF NOT EXISTS message_result_author_occurred_idx ON message_result (author_id, occurred_at);
