import { cookies } from 'next/headers';
import { env } from './env';
import { SESSION_COOKIE_NAME, readSessionToken } from './session';

export function isOperator(email: string): boolean {
  return env.ALLOWED_OPERATOR_EMAILS.includes(email.toLowerCase());
}

export async function getCurrentSession(): Promise<{ email: string } | null> {
  const jar = await cookies();
  const session = await readSessionToken(jar.get(SESSION_COOKIE_NAME)?.value);
  if (!session) return null;
  if (!isOperator(session.email)) return null;
  return session;
}

export async function requireOperator(): Promise<{ email: string }> {
  const session = await getCurrentSession();
  if (!session) throw new Error('not authenticated');
  return session;
}
