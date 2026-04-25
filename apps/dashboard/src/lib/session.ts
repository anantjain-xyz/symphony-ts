import { env } from './env';

export const SESSION_COOKIE_NAME = 'symphony_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAGIC_TOKEN_TTL_MS = 15 * 60 * 1000;

type TokenKind = 'session' | 'magic';

interface Payload {
  e: string;
  x: number;
  k: TokenKind;
  n: string;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let keyPromise: Promise<CryptoKey> | null = null;
function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      'raw',
      encoder.encode(env.DASHBOARD_SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return keyPromise;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await getKey();
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sign(payload: Payload): Promise<string> {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = base64UrlEncode(await hmac(body));
  return `${body}.${sig}`;
}

async function verify(token: string, kind: TokenKind): Promise<Payload | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const claimed = token.slice(dot + 1);
  let claimedBytes: Uint8Array;
  try {
    claimedBytes = base64UrlDecode(claimed);
  } catch {
    return null;
  }
  const expected = await hmac(body);
  if (!timingSafeEqual(claimedBytes, expected)) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body))) as Payload;
  } catch {
    return null;
  }
  if (payload.k !== kind) return null;
  if (typeof payload.x !== 'number' || payload.x < Date.now()) return null;
  if (typeof payload.e !== 'string' || !payload.e) return null;
  return payload;
}

export async function createSessionToken(email: string): Promise<string> {
  return sign({
    e: email.toLowerCase(),
    x: Date.now() + SESSION_TTL_MS,
    k: 'session',
    n: randomNonce(),
  });
}

export async function createMagicToken(email: string): Promise<string> {
  return sign({
    e: email.toLowerCase(),
    x: Date.now() + MAGIC_TOKEN_TTL_MS,
    k: 'magic',
    n: randomNonce(),
  });
}

export async function readSessionToken(
  token: string | undefined,
): Promise<{ email: string } | null> {
  if (!token) return null;
  const p = await verify(token, 'session');
  return p ? { email: p.e } : null;
}

export async function readMagicToken(token: string): Promise<{ email: string } | null> {
  const p = await verify(token, 'magic');
  return p ? { email: p.e } : null;
}
