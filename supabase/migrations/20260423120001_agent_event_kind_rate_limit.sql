-- Add 'rate_limit' to agent_event_kind.
--
-- Kept in its own migration because ALTER TYPE ... ADD VALUE historically
-- cannot run inside a transaction with other DDL in older Postgres versions;
-- isolating the change also keeps the enum timeline easy to audit.

alter type agent_event_kind add value if not exists 'rate_limit';
