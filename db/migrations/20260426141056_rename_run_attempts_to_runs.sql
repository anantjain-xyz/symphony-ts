-- Unify terminology: collapse "run_attempt" / "attempt_number" into "run" / "run_number"
-- across the schema. The `live_sessions` table itself stays — its `session_id` is
-- the Claude SDK session token, not a Run. Only its FK column gets renamed.
--
-- The `agent_events_latest` view hard-references the old column name, so it
-- has to be dropped and recreated.

-- 1. drop the view that hard-references the old column name
drop view if exists agent_events_latest;

-- 2. rename the enum
alter type run_attempt_status rename to run_status;

-- 3. rename the table + column
alter table run_attempts rename to runs;
alter table runs rename column attempt_number to run_number;

-- 4. rename FK columns on dependent tables
alter table agent_events  rename column run_attempt_id to run_id;
alter table live_sessions rename column run_attempt_id to run_id;
alter table hook_runs     rename column run_attempt_id to run_id;
alter table retry_queue   rename column attempt_number to run_number;

-- 5. rename FK constraints (cosmetic — keeps `\d` output sane)
alter table runs          rename constraint run_attempts_issue_id_fkey       to runs_issue_id_fkey;
alter table agent_events  rename constraint agent_events_run_attempt_id_fkey  to agent_events_run_id_fkey;
alter table live_sessions rename constraint live_sessions_run_attempt_id_fkey to live_sessions_run_id_fkey;
alter table hook_runs     rename constraint hook_runs_run_attempt_id_fkey     to hook_runs_run_id_fkey;

-- 6. rename indexes (incl. the auto-generated PK and unique-constraint backing
-- indexes, whose names still carry the old table+column prefix)
alter index run_attempts_pkey                                  rename to runs_pkey;
alter index run_attempts_issue_id_attempt_number_key           rename to runs_issue_id_run_number_key;
alter index run_attempts_status_idx                            rename to runs_status_idx;
alter index run_attempts_issue_idx                             rename to runs_issue_idx;
alter index run_attempts_running_idx                           rename to runs_running_idx;
alter index run_attempts_one_running_per_issue                 rename to runs_one_running_per_issue;
alter index agent_events_attempt_idx                           rename to agent_events_run_idx;
alter index hook_runs_attempt_idx                              rename to hook_runs_run_idx;

-- 7. recreate the dropped view against the new column name
create view agent_events_latest as
select distinct on (run_id)
  id,
  run_id,
  kind,
  payload,
  created_at
from agent_events
order by run_id, id desc;
