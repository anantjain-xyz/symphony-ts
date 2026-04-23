-- Supabase Realtime reads only from the `supabase_realtime` publication.
-- The init migration created `symphony_live`, so WAL rows for streaming
-- tables never reached the Realtime server. Drop the misnamed publication
-- and ensure the streaming tables are members of `supabase_realtime`.

drop publication if exists symphony_live;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end$$;

do $$
declare
  t text;
begin
  foreach t in array array['agent_events', 'live_sessions', 'run_attempts', 'retry_queue']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end$$;
