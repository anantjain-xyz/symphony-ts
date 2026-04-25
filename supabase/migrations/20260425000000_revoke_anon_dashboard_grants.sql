-- Auth posture (SYM-16): server-side proxy. The dashboard now talks to
-- Supabase exclusively from server-side route handlers using the service-role
-- key, so the browser never receives a database key. Revoke the anon-role
-- grants added by 20260423230000_disable_auth_rls.sql and re-enable RLS as
-- defense-in-depth. With no policies, RLS denies all non-service-role access.

revoke select on
  workflows, issues, run_attempts, live_sessions,
  agent_events, retry_queue, hook_runs,
  rate_limit_state, worker_heartbeat,
  agent_events_latest
from anon;

alter table workflows        enable row level security;
alter table issues           enable row level security;
alter table run_attempts     enable row level security;
alter table live_sessions    enable row level security;
alter table agent_events     enable row level security;
alter table retry_queue      enable row level security;
alter table hook_runs        enable row level security;
alter table rate_limit_state enable row level security;
alter table worker_heartbeat enable row level security;
