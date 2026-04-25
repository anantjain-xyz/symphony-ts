import { NextResponse, type NextRequest } from 'next/server';
import { isOperator } from '@/lib/auth';
import { safeNextPath } from '@/lib/redirect';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createSessionToken,
  readMagicToken,
} from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const nextPath = safeNextPath(req.nextUrl.searchParams.get('next'), req.url);

  const denied = new URL('/login', req.url);
  denied.searchParams.set('error', '1');

  const verified = token ? await readMagicToken(token) : null;
  if (!verified || !isOperator(verified.email)) {
    return NextResponse.redirect(denied, { status: 303 });
  }

  const session = await createSessionToken(verified.email);
  const res = NextResponse.redirect(new URL(nextPath, req.url), { status: 303 });
  res.cookies.set(SESSION_COOKIE_NAME, session, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
