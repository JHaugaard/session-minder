-- db/01-role-and-schema.sql
-- Run as the postgres superuser. Split from 02-tables.sql so the table file
-- can be applied connected AS _sessionminder_role — ownership follows the
-- connecting role (see ~/.claude/rules/database-conventions.md).

CREATE ROLE _sessionminder_role LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD';
CREATE SCHEMA IF NOT EXISTS _sessionminder AUTHORIZATION _sessionminder_role;
