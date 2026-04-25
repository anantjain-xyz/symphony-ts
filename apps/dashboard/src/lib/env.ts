function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

// Browser-facing values: inlined into the client bundle at build time by Next.
export const env = {
  SUPABASE_URL: required('NEXT_PUBLIC_SUPABASE_URL'),
  SUPABASE_ANON_KEY: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
};

// Server-side override for environments where the SSR process cannot reach
// the public Supabase URL — e.g. the docker compose stack, where the browser
// hits `localhost:54421` (host port) but the dashboard container reaches
// supabase by the in-network service name. Falls back to the public URL.
export const serverEnv = {
  SUPABASE_URL: process.env.SUPABASE_INTERNAL_URL || env.SUPABASE_URL,
  SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
};
