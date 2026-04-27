'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ThemeToggle } from './ThemeToggle';

const NAV: Array<{ href: string; label: string; match: (pathname: string) => boolean }> = [
  { href: '/', label: 'Dashboard', match: (p) => p === '/' },
  { href: '/issues', label: 'Issues', match: (p) => p === '/issues' || p.startsWith('/issues/') },
  {
    href: '/runs',
    label: 'Runs',
    match: (p) => p === '/runs' || p.startsWith('/runs/'),
  },
];

export function TopBar() {
  const pathname = usePathname() ?? '/';
  return (
    <header className="border-b border-hairline px-8 py-3 flex items-center gap-8">
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
      <nav className="flex items-center gap-1">
        {NAV.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`smallcaps text-[10px] px-3 py-1.5 rounded transition-colors ${
                active
                  ? 'text-ink-0 bg-surface-2'
                  : 'text-ink-3 hover:text-ink-1 hover:bg-surface-1'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
