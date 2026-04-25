import { NextResponse, type NextRequest } from 'next/server';
import { isOperator } from '@/lib/auth';
import { createMagicToken } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function safeNext(input: string | null): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const emailRaw = form.get('email');
  const nextPath = safeNext(
    typeof form.get('next') === 'string' ? (form.get('next') as string) : null,
  );
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';

  const sentUrl = new URL('/login', req.url);
  sentUrl.searchParams.set('sent', '1');
  if (nextPath !== '/') sentUrl.searchParams.set('next', nextPath);

  // Always respond with the same generic "link issued" page so the form can't
  // be used to enumerate which emails are operators.
  if (!email || !isOperator(email)) {
    if (email) {
      // Log the rejection server-side so a misconfigured operator can debug.
      process.stdout.write(
        `[auth] login attempt rejected for ${email} (not in ALLOWED_OPERATOR_EMAILS)\n`,
      );
    }
    return NextResponse.redirect(sentUrl, { status: 303 });
  }

  const token = await createMagicToken(email);
  const callback = new URL('/api/auth/callback', req.url);
  callback.searchParams.set('token', token);
  if (nextPath !== '/') callback.searchParams.set('next', nextPath);

  process.stdout.write(
    `\n[auth] magic link for ${email} (valid 15m):\n  ${callback.toString()}\n\n`,
  );

  return NextResponse.redirect(sentUrl, { status: 303 });
}
