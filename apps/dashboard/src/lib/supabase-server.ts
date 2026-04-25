import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@symphony/shared';
import { env } from './env';

/**
 * Service-role Supabase client. Server-only — `SUPABASE_SERVICE_ROLE_KEY`
 * has no `NEXT_PUBLIC_` prefix and therefore never reaches the client bundle.
 */
export function createSupabaseServerClient(): SupabaseClient<Database> {
  return createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
