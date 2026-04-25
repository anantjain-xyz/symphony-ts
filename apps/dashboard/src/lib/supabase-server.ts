import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@symphony/shared';
import { serverEnv } from './env';

export function createSupabaseServerClient(): SupabaseClient<Database> {
  return createClient<Database>(serverEnv.SUPABASE_URL, serverEnv.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
