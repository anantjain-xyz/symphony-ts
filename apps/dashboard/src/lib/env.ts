// Each env var must be read with a static `process.env.X` access. Next.js's
// Edge middleware compiler statically scans for these references to know which
// values to forward into the Edge runtime sandbox; computed access (e.g.
// process.env[name]) is invisible to that scanner and yields `undefined` at
// runtime.

function require_(name: string, value: string | undefined): string {
  if (!value) throw new Error(`missing env var: ${name}`);
  return value;
}

function parseEmails(raw: string): string[] {
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) {
    throw new Error('ALLOWED_OPERATOR_EMAILS must contain at least one email');
  }
  return list;
}

export const env = {
  SUPABASE_URL: require_('SUPABASE_URL', process.env.SUPABASE_URL),
  SUPABASE_SERVICE_ROLE_KEY: require_(
    'SUPABASE_SERVICE_ROLE_KEY',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ),
  ALLOWED_OPERATOR_EMAILS: parseEmails(
    require_('ALLOWED_OPERATOR_EMAILS', process.env.ALLOWED_OPERATOR_EMAILS),
  ),
  DASHBOARD_SESSION_SECRET: require_(
    'DASHBOARD_SESSION_SECRET',
    process.env.DASHBOARD_SESSION_SECRET,
  ),
};
