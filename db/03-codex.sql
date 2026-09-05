-- Apply as the table owner, _sessionminder_role, to an existing installation.
-- Transactional and repeatable; the uniqueness constraint is unchanged.
BEGIN;
ALTER TABLE _sessionminder.sessions DROP CONSTRAINT sessions_platform_check;
ALTER TABLE _sessionminder.sessions ADD CONSTRAINT sessions_platform_check
  CHECK (platform IN ('claude_code', 'hermes', 'kimi_code', 'codex'));
COMMIT;
