CREATE TABLE IF NOT EXISTS message_result (
    event_id        UUID PRIMARY KEY,
    event_type      TEXT                     NOT NULL,
    event_version   INTEGER                  NOT NULL,
    occurred_at     TIMESTAMPTZ              NOT NULL,
    message_id      UUID                     NOT NULL,
    correlation_id  UUID                     NOT NULL,
    causation_id    UUID                     NULL,
    producer        TEXT                     NOT NULL,
    status          TEXT                     NOT NULL,
    text            TEXT                     NOT NULL,
    reason          TEXT                     NULL,
    CONSTRAINT message_result_status_chk CHECK (status IN ('VALIDATED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS message_result_message_id_idx ON message_result (message_id);
CREATE INDEX IF NOT EXISTS message_result_correlation_id_idx ON message_result (correlation_id);
CREATE INDEX IF NOT EXISTS message_result_occurred_at_idx ON message_result (occurred_at);
CREATE INDEX IF NOT EXISTS message_result_status_idx ON message_result (status);

