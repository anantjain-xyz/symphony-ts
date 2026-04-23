-- Auth removed from dashboard; anon key reads directly.
-- Worker uses service-role (bypasses RLS) so disabling is safe.

drop policy if exists "operators read workflows"        on workflows;
drop policy if exists "operators read issues"           on issues;
drop policy if exists "operators read run_attempts"     on run_attempts;
drop policy if exists "operators read live_sessions"    on live_sessions;
drop policy if exists "operators read agent_events"     on agent_events;
drop policy if exists "operators read retry_queue"      on retry_queue;
drop policy if exists "operators read hook_runs"        on hook_runs;
drop policy if exists "operators read rate_limit_state" on rate_limit_state;
drop policy if exists "operators read worker_heartbeat" on worker_heartbeat;

alter table workflows        disable row level security;
alter table issues           disable row level security;
alter table run_attempts     disable row level security;
alter table live_sessions    disable row level security;
alter table agent_events     disable row level security;
alter table retry_queue      disable row level security;
alter table hook_runs        disable row level security;
alter table rate_limit_state disable row level security;
alter table worker_heartbeat disable row level security;

grant select on
  workflows, issues, run_attempts, live_sessions,
  agent_events, retry_queue, hook_runs,
  rate_limit_state, worker_heartbeat,
  agent_events_latest
to anon;
