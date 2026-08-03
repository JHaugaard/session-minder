-- db/02-tables.sql
-- Run connected AS _sessionminder_role, NEVER as postgres. A table created
-- by the superuser is owned by postgres, and every future migration run as
-- the project role then fails with "must be owner of table" — the exact
-- _foundry trap from 2026-07 (see ~/.claude/rules/database-conventions.md).

CREATE TABLE _sessionminder.sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    platform            text NOT NULL CHECK (platform IN ('claude_code', 'hermes', 'kimi_code')),
    external_session_id text NOT NULL,
    host                text NOT NULL,
    project_path        text,
    started_at          timestamptz NOT NULL,
    ended_at            timestamptz,
    message_count       integer,
    noise_flag          boolean NOT NULL DEFAULT false,
    title               text,
    note                text,
    status              text NOT NULL DEFAULT 'unreviewed' CHECK (status IN ('unreviewed', 'kept', 'pruned')),
    raw_metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (platform, external_session_id)
);

CREATE OR REPLACE FUNCTION _sessionminder.set_updated_at()
RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sessions_set_updated_at
    BEFORE UPDATE ON _sessionminder.sessions
    FOR EACH ROW EXECUTE FUNCTION _sessionminder.set_updated_at();
