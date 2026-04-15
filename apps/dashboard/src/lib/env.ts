function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export const env = {
  SUPABASE_URL: required('NEXT_PUBLIC_SUPABASE_URL'),
  SUPABASE_ANON_KEY: required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  ALLOWED_OPERATOR_EMAILS: (process.env.ALLOWED_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  if (env.ALLOWED_OPERATOR_EMAILS.length === 0) return true; // dev mode
  return env.ALLOWED_OPERATOR_EMAILS.includes(email.toLowerCase());
}
