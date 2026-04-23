import './globals.css';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Symphony',
  description: 'Symphony orchestrator dashboard',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-6">
          <Link href="/" className="font-semibold tracking-tight">
            Symphony
          </Link>
        </header>
        <main className="px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
