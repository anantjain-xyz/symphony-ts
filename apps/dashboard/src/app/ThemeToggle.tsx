'use client';

import { forwardRef, type KeyboardEvent, useEffect, useRef, useState } from 'react';

type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'symphony-theme';
const ORDER: ThemePref[] = ['light', 'system', 'dark'];
const LABELS: Record<ThemePref, string> = { light: 'Light', system: 'System', dark: 'Dark' };

function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }
  return pref;
}

function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(pref);
  root.dataset.themePref = pref;
}

export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>('system');
  const [mounted, setMounted] = useState(false);
  const buttonRefs = useRef<Record<ThemePref, HTMLButtonElement | null>>({
    light: null,
    system: null,
    dark: null,
  });

  useEffect(() => {
    const initial = (document.documentElement.dataset.themePref as ThemePref) || 'system';
    setPref(initial);
    setMounted(true);

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => {
      const current = (document.documentElement.dataset.themePref as ThemePref) || 'system';
      if (current === 'system') applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const choose = (next: ThemePref) => {
    setPref(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage may be unavailable (private mode, SSR); theme still applies for the session
    }
    applyTheme(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Don't intercept browser/OS shortcuts (Cmd+R refresh, Cmd+ArrowRight, etc.)
    // when focus happens to be inside the radiogroup.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idx = ORDER.indexOf(pref);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % ORDER.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + ORDER.length) % ORDER.length;
    } else if (e.key === 'Home') {
      nextIdx = 0;
    } else if (e.key === 'End') {
      nextIdx = ORDER.length - 1;
    }
    if (nextIdx === null) return;
    const next = ORDER[nextIdx] as ThemePref;
    e.preventDefault();
    choose(next);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={onKeyDown}
      className="flex items-center gap-0.5 rounded border border-hairline bg-surface-1 p-0.5"
    >
      {ORDER.map((value) => {
        const Icon = value === 'light' ? SunIcon : value === 'system' ? MonitorIcon : MoonIcon;
        return (
          <ToggleButton
            key={value}
            ref={(el) => {
              buttonRefs.current[value] = el;
            }}
            label={LABELS[value]}
            active={mounted && pref === value}
            tabIndex={pref === value ? 0 : -1}
            onClick={() => choose(value)}
          >
            <Icon />
          </ToggleButton>
        );
      })}
    </div>
  );
}

const ToggleButton = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    active: boolean;
    tabIndex: number;
    onClick: () => void;
    children: React.ReactNode;
  }
>(function ToggleButton({ label, active, tabIndex, onClick, children }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      title={label}
      tabIndex={tabIndex}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors ${
        active ? 'bg-surface-3 text-ink-0' : 'text-ink-3 hover:text-ink-1 hover:bg-surface-2'
      }`}
    >
      {children}
    </button>
  );
});

const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function SunIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function MonitorIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 22h8" />
      <path d="M12 18v4" />
    </svg>
  );
}
