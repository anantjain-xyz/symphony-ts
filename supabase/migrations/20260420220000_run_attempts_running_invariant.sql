-- Enforce "at most one running attempt per issue" at the database level.
--
-- Motivation: the in-memory dedupe in OrchestratorLoop (`active` map) relied
-- on the worker process being the only writer. Recovery on startup handles
-- orphans from a hard crash, but live-worker drift between the in-memory map
-- and the DB was able to leave multiple `running` rows for the same issue,
-- causing concurrent Codex processes to fight over the same workspace.

-- Step 1: clean up any existing offenders so the unique index can be created.
-- These were already in a bad state (multiple concurrent runners for the same
-- issue); mark them cancelled so retry bookkeeping stays consistent.
update run_attempts
set status = 'cancelled',
    error_class = 'manual',
    error_message = 'cleaned up during running-invariant migration',
    ended_at = coalesce(ended_at, now())
where status = 'running';

-- Step 2: enforce the invariant going forward. Any concurrent attempt that
-- tries to set status='running' for the same issue will violate this index
-- and surface as a 23505 unique_violation, which the worker handles by
-- cancelling the losing attempt.
create unique index run_attempts_one_running_per_issue
  on run_attempts (issue_id)
  where status = 'running';
