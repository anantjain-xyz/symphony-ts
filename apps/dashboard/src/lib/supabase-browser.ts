'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@symphony/shared';

let client: SupabaseClient<Database> | null = null;

export function getSupabaseBrowserClient() {
  if (client) return client;
  client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  return client;
}
