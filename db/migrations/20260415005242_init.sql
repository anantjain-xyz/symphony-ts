-- symphony-ts initial schema

create extension if not exists "pgcrypto";

-- =========================================================================
-- Enums
-- =========================================================================

create type run_status as enum (
  'pending',
  'running',
  'success',
  'failure',
  'timeout',
  'cancelled'
);

create type agent_event_kind as enum (
  'status',
  'tool_call',
  'approval',
  'token_count',
  'error',
  'user_input',
  'humanized',
  'rate_limit'
);

create type hook_name as enum (
  'after_create',
  'before_run',
  'after_run',
  'before_remove'
);

-- =========================================================================
-- workflows: snapshot of the active WORKFLOW.md
-- =========================================================================

create table workflows (
  id uuid primary key default gen_random_uuid(),
  source_hash text not null,
  parsed jsonb not null,
  prompt_template text not null,
  loaded_at timestamptz not null default now(),
  unique (source_hash)
);

create index workflows_loaded_at_idx on workflows (loaded_at desc);

-- =========================================================================
-- issues: normalized cache of tracker issues
-- =========================================================================

create table issues (
  id text primary key,                    -- Linear UUID
  identifier text not null unique,        -- e.g. "ENG-123"
  title text not null,
  description text,
  priority smallint not null default 0,
  state text not null,                    -- lowercased state name from tracker
  branch text,
  labels text[] not null default '{}',
  blockers text[] not null default '{}',  -- referenced issue identifiers
  pr_urls text[] not null default '{}',   -- GitHub PR URLs linked by tracker integration
  raw jsonb not null,                     -- full normalized payload
  last_seen_at timestamptz not null default now()
);

create index issues_state_idx on issues (state);
create index issues_priority_idx on issues (priority desc);

-- =========================================================================
-- runs: one row per dispatch
-- =========================================================================

create table runs (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references issues(id) on delete cascade,
  run_number int not null,
  workspace_path text not null,
  status run_status not null default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  error_class text,
  error_message text,
  worker_pid integer,
  created_at timestamptz not null default now(),
  unique (issue_id, run_number)
);

create index runs_status_idx on runs (status);
create index runs_issue_idx on runs (issue_id, run_number desc);

-- Partial index for fast "currently running" fleet queries.
create index runs_running_idx
  on runs (started_at desc)
  where status = 'running';

-- Enforce "at most one running run per issue" at the database level.
create unique index runs_one_running_per_issue
  on runs (issue_id)
  where status = 'running';

-- =========================================================================
-- live_sessions: one row per active agent session (deleted on completion)
-- =========================================================================

create table live_sessions (
  run_id uuid primary key references runs(id) on delete cascade,
  session_id text not null,        -- "<thread_id>-<turn_id>"
  thread_id text not null,
  turn_id text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  last_event_at timestamptz not null default now(),
  started_at timestamptz not null default now()
);

-- =========================================================================
-- agent_events: append-only firehose; LISTEN/NOTIFY fans out to dashboard
-- =========================================================================

create table agent_events (
  id bigserial primary key,
  run_id uuid not null references runs(id) on delete cascade,
  kind agent_event_kind not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index agent_events_run_idx on agent_events (run_id, id);
create index agent_events_created_idx on agent_events (created_at desc);

create view agent_events_latest as
select distinct on (run_id)
  id,
  run_id,
  kind,
  payload,
  created_at
from agent_events
order by run_id, id desc;

-- =========================================================================
-- retry_queue: scheduled retries with backoff
-- =========================================================================

create table retry_queue (
  issue_id text primary key references issues(id) on delete cascade,
  run_number int not null,               -- the run that will be created when this fires
  due_at timestamptz not null,
  error_class text,
  error_message text,
  created_at timestamptz not null default now()
);

create index retry_queue_due_idx on retry_queue (due_at);

-- =========================================================================
-- hook_runs: observability for shell hook executions
-- =========================================================================

create table hook_runs (
  id bigserial primary key,
  run_id uuid references runs(id) on delete cascade,
  hook hook_name not null,
  exit_code int not null,
  duration_ms int not null,
  stderr_tail text,
  created_at timestamptz not null default now()
);

create index hook_runs_run_idx on hook_runs (run_id, created_at desc);

-- =========================================================================
-- rate_limit_state: latest rate-limit signal per source
-- =========================================================================

create table rate_limit_state (
  source text primary key,
  remaining bigint,
  reset_at timestamptz,
  updated_at timestamptz not null default now()
);

-- =========================================================================
-- worker_heartbeat: single-row worker liveness heartbeat
-- =========================================================================

create table worker_heartbeat (
  id text primary key default 'worker' check (id = 'worker'),
  started_at timestamptz not null,
  last_beat_at timestamptz not null default now(),
  worker_pid integer
);

-- =========================================================================
-- LISTEN/NOTIFY fanout for dashboard SSE
-- =========================================================================

create or replace function notify_table_change() returns trigger
language plpgsql as $$
begin
  -- Coarse fanout: just the table + op. The dashboard refetches on any
  -- change, so this trigger stays uniform across tables with different PKs.
  perform pg_notify(
    'symphony_changes',
    json_build_object('table', tg_table_name, 'op', tg_op)::text
  );
  return null;
end;
$$;

create trigger runs_notify
  after insert or update or delete on runs
  for each row execute function notify_table_change();

create trigger retry_queue_notify
  after insert or update or delete on retry_queue
  for each row execute function notify_table_change();

create trigger live_sessions_notify
  after insert or update or delete on live_sessions
  for each row execute function notify_table_change();

create trigger rate_limit_state_notify
  after insert or update or delete on rate_limit_state
  for each row execute function notify_table_change();

create or replace function notify_agent_event() returns trigger
language plpgsql as $$
declare
  body text;
begin
  body := row_to_json(new)::text;
  if octet_length(body) > 7500 then
    body := json_build_object(
      'id', new.id,
      'run_id', new.run_id,
      'kind', new.kind,
      'created_at', new.created_at,
      'truncated', true
    )::text;
  end if;
  perform pg_notify('agent_events:' || new.run_id::text, body);
  return null;
end;
$$;

create trigger agent_events_notify
  after insert on agent_events
  for each row execute function notify_agent_event();
