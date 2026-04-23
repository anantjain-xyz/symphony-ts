import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@symphony/shared';
import { env } from './env';

export async function createSupabaseServerClient(): Promise<SupabaseClient<Database>> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
