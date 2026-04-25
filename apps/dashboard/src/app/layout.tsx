import './globals.css';
import type { Metadata } from 'next';
import { Fraunces, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { getCurrentSession } from '@/lib/auth';

const sans = Inter_Tight({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
  weight: ['400', '500', '600'],
});

const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
  style: ['normal', 'italic'],
  axes: ['opsz', 'SOFT'],
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'Symphony',
  description: 'Symphony orchestrator dashboard',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getCurrentSession();

  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">
        <header className="border-b border-hairline px-8 py-3 flex items-center">
          <Link href="/" className="flex items-center gap-3 group">
            <span
              className="block w-2 h-2 rounded-full bg-signal"
              aria-hidden
              style={{ boxShadow: '0 0 12px rgba(232,163,61,0.5)' }}
            />
            <span className="font-display text-[17px] tracking-tight text-ink-0 group-hover:text-white">
              Symphony
            </span>
          </Link>
          {session && (
            <div className="ml-auto flex items-center gap-3">
              <span className="font-mono text-[11px] text-ink-3 tabular truncate max-w-[260px]">
                {session.email}
              </span>
              <form method="post" action="/api/auth/logout">
                <button
                  type="submit"
                  className="smallcaps text-[10px] text-ink-3 hover:text-ink-0 link-hover"
                >
                  log out
                </button>
              </form>
            </div>
          )}
        </header>
        <main className="px-8 py-6">{children}</main>
      </body>
    </html>
  );
}
