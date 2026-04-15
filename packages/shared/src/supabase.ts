import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './db-types.js';

export type SymphonyClient = SupabaseClient<Database>;

export interface ServiceClientOptions {
  url: string;
  serviceRoleKey: string;
}

/**
 * Worker client. Uses the service-role key, bypasses RLS.
 * Never instantiate this in browser/Edge Function code.
 */
export function createServiceClient(opts: ServiceClientOptions): SymphonyClient {
  return createClient<Database>(opts.url, opts.serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    db: { schema: 'public' },
  });
}
