-- Terminal-style "Symphony Status" dashboard: fleet-wide metrics.
--
-- Adds:
--   1. run_attempts.worker_pid      - subprocess PID captured at spawn time.
--   2. rate_limit_state             - one row per rate-limit source (codex
--                                     primary/secondary/credits, future
--                                     providers), upserted by the worker when
--                                     an adapter surfaces a rate-limit signal.
--   3. worker_heartbeat             - single-row table recording worker
--                                     startup time + most recent beat. Drives
--                                     the dashboard's Runtime / stale-worker
--                                     indicators.
--   4. agent_events_latest          - view: latest agent_events row per
--                                     run_attempt_id. Backed by the existing
--                                     (run_attempt_id, id) index so DISTINCT
--                                     ON is cheap.

alter table run_attempts
  add column worker_pid integer;

create table rate_limit_state (
  source text primary key,
  remaining bigint,
  reset_at timestamptz,
  updated_at timestamptz not null default now()
);

create table worker_heartbeat (
  id text primary key default 'worker' check (id = 'worker'),
  started_at timestamptz not null,
  last_beat_at timestamptz not null default now(),
  worker_pid integer
);

create view agent_events_latest as
select distinct on (run_attempt_id)
  id,
  run_attempt_id,
  kind,
  payload,
  created_at
from agent_events
order by run_attempt_id, id desc;
