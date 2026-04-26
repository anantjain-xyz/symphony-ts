'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ChangeEvent, useEffect, useState, useTransition } from 'react';

export type FilterOption = { value: string; label: string };

export function ListFilters({
  filterParam,
  options,
  selected,
  searchParam = 'q',
  searchValue,
  searchPlaceholder = 'Search…',
  resultCount,
}: {
  filterParam: string;
  options: FilterOption[];
  selected: string[];
  searchParam?: string;
  searchValue: string;
  searchPlaceholder?: string;
  resultCount: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(searchValue);

  // Keep local input in sync with URL on back/forward.
  useEffect(() => setQuery(searchValue), [searchValue]);

  const apply = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? '');
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname));
  };

  // Debounce search input so we're not pushing a new URL on every keystroke.
  useEffect(() => {
    if (query === searchValue) return;
    const t = setTimeout(() => apply({ [searchParam]: query || null }), 250);
    return () => clearTimeout(t);
  }, [query, searchValue, searchParam]);

  const toggle = (value: string) => {
    const set = new Set(selected);
    if (set.has(value)) set.delete(value);
    else set.add(value);
    const csv = [...set].join(',');
    apply({ [filterParam]: csv || null });
  };

  const clearAll = () => apply({ [filterParam]: null, [searchParam]: null });

  const anyActive = selected.length > 0 || searchValue.length > 0;

  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2">
      <input
        type="search"
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
        placeholder={searchPlaceholder}
        className="bg-surface-1 border border-hairline rounded px-3 py-1.5 text-[13px] text-ink-0 placeholder:text-ink-3 focus:outline-none focus:border-hairline-strong w-64"
      />
      <div className="flex flex-wrap items-center gap-1">
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              aria-pressed={active}
              className={`smallcaps text-[10px] px-2.5 py-1 rounded border transition-colors ${
                active
                  ? 'bg-surface-2 border-hairline-strong text-ink-0'
                  : 'border-hairline text-ink-2 hover:text-ink-0 hover:border-hairline-strong'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {anyActive && (
        <button
          type="button"
          onClick={clearAll}
          className="smallcaps text-[10px] text-ink-3 hover:text-ink-1 underline-offset-2 hover:underline"
        >
          clear
        </button>
      )}
      <span
        className={`ml-auto smallcaps text-[10px] tabular ${pending ? 'text-signal' : 'text-ink-3'}`}
      >
        {pending
          ? 'updating…'
          : `${resultCount.toLocaleString()} result${resultCount === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}
