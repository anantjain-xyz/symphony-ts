import { NextResponse, type NextRequest } from 'next/server';
import { isOperator } from '@/lib/auth';
import { SESSION_COOKIE_NAME, readSessionToken } from '@/lib/session';

const PUBLIC_PREFIXES = ['/login', '/api/auth/login', '/api/auth/callback', '/api/auth/logout'];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await readSessionToken(token);
  if (session && isOperator(session.email)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const loginUrl = new URL('/login', req.url);
  if (pathname !== '/' && pathname !== '/login') {
    loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
