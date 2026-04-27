-- LISTEN/NOTIFY fanout. Replaces what Supabase Realtime did via WAL.
--
-- Two channels:
--   * symphony_changes — coarse fanout for table-level changes the dashboard
--     watches. Payload is small ({table, op, id}); consumers refetch.
--   * agent_events:<run_id> — per-run firehose for the live event stream.
--     Payload is the full row JSON when it fits under pg_notify's 8000-byte
--     limit; otherwise a slim {id, run_id, kind, created_at, truncated}
--     payload that prompts the client to refetch.

create or replace function notify_table_change() returns trigger
language plpgsql as $$
begin
  -- Coarse fanout: just the table + op. The dashboard refetches on any
  -- change, so we don't need a per-row id; staying off the row also keeps
  -- this trigger uniform across tables that key on `id`, `run_id`, or
  -- `source` (different PK shapes break a generic NEW.id/OLD.id reference).
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
