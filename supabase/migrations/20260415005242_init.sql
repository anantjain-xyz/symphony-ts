-- symphony-ts initial schema
-- See https://github.com/openai/symphony/blob/main/SPEC.md for the source spec.

create extension if not exists "pgcrypto";

-- =========================================================================
-- Enums
-- =========================================================================

create type run_attempt_status as enum (
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
  'humanized'
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
  raw jsonb not null,                     -- full normalized payload
  last_seen_at timestamptz not null default now()
);

create index issues_state_idx on issues (state);
create index issues_priority_idx on issues (priority desc);

-- =========================================================================
-- run_attempts: one row per dispatch
-- =========================================================================

create table run_attempts (
  id uuid primary key default gen_random_uuid(),
  issue_id text not null references issues(id) on delete cascade,
  attempt_number int not null,
  workspace_path text not null,
  status run_attempt_status not null default 'pending',
  started_at timestamptz,
  ended_at timestamptz,
  error_class text,
  error_message text,
  created_at timestamptz not null default now(),
  unique (issue_id, attempt_number)
);

create index run_attempts_status_idx on run_attempts (status);
create index run_attempts_issue_idx on run_attempts (issue_id, attempt_number desc);

-- Partial index for fast "currently running" fleet queries.
create index run_attempts_running_idx
  on run_attempts (started_at desc)
  where status = 'running';

-- =========================================================================
-- live_sessions: one row per active agent session (deleted on completion)
-- =========================================================================

create table live_sessions (
  run_attempt_id uuid primary key references run_attempts(id) on delete cascade,
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
-- agent_events: append-only firehose; Realtime fans out to dashboard
-- =========================================================================

create table agent_events (
  id bigserial primary key,
  run_attempt_id uuid not null references run_attempts(id) on delete cascade,
  kind agent_event_kind not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index agent_events_attempt_idx on agent_events (run_attempt_id, id);
create index agent_events_created_idx on agent_events (created_at desc);

-- =========================================================================
-- retry_queue: scheduled retries with backoff
-- =========================================================================

create table retry_queue (
  issue_id text primary key references issues(id) on delete cascade,
  attempt_number int not null,           -- the attempt that will be created when this fires
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
  run_attempt_id uuid references run_attempts(id) on delete cascade,
  hook hook_name not null,
  exit_code int not null,
  duration_ms int not null,
  stderr_tail text,
  created_at timestamptz not null default now()
);

create index hook_runs_attempt_idx on hook_runs (run_attempt_id, created_at desc);

-- =========================================================================
-- Realtime publication
-- =========================================================================

drop publication if exists symphony_live;
create publication symphony_live for table
  agent_events,
  live_sessions,
  run_attempts,
  retry_queue;

-- =========================================================================
-- Row Level Security: read-only operator console
-- =========================================================================
-- Worker uses the service-role key (bypasses RLS).
-- Dashboard uses the anon key + an authenticated session; we grant SELECT
-- on every table to authenticated users. No insert/update/delete from browser.

alter table workflows      enable row level security;
alter table issues         enable row level security;
alter table run_attempts   enable row level security;
alter table live_sessions  enable row level security;
alter table agent_events   enable row level security;
alter table retry_queue    enable row level security;
alter table hook_runs      enable row level security;

create policy "operators read workflows"     on workflows     for select to authenticated using (true);
create policy "operators read issues"        on issues        for select to authenticated using (true);
create policy "operators read run_attempts"  on run_attempts  for select to authenticated using (true);
create policy "operators read live_sessions" on live_sessions for select to authenticated using (true);
create policy "operators read agent_events"  on agent_events  for select to authenticated using (true);
create policy "operators read retry_queue"   on retry_queue   for select to authenticated using (true);
create policy "operators read hook_runs"     on hook_runs     for select to authenticated using (true);
