-- @notxn
-- Add 'rate_limit' to agent_event_kind.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to run outside a transaction
-- block, so this file is flagged with the @notxn directive (read by
-- db/migrate.ts) and kept in its own migration.

alter type agent_event_kind add value if not exists 'rate_limit';
