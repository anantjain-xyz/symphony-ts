'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Tables } from '@symphony/shared';

export type EventRow = Tables<'agent_events'>;

type ToolCallPayload = {
  tool?: string;
  args?: unknown;
  call_id?: string;
  result_summary?: string;
};
type ApprovalPayload = { reason?: string; call_id?: string };
type TokenCountPayload = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};
type ErrorPayload = { class?: string; message?: string; recoverable?: boolean };
type UserInputPayload = { text?: string };
type HumanizedPayload = { summary?: string };
type RateLimitPayload = { source?: string; remaining?: number | null; reset_at?: string | null };

interface Props {
  ev: EventRow;
  isFresh: boolean;
  selected: boolean;
  onSelect: (id: number | null) => void;
}

export function EventBlock({ ev, isFresh, selected, onSelect }: Props) {
  const time = formatTime(ev.created_at);
  const payload = ev.payload as Record<string, unknown>;

  const toggle = () => onSelect(selected ? null : ev.id);

  switch (ev.kind) {
    // The `status` kind is a noisy duplicate of `humanized`; we keep humanized only.
    case 'status':
      return null;
    case 'user_input':
      return (
        <Row time={time} isFresh={isFresh} kind="you" selected={selected} onSelect={toggle}>
          <UserInputBlock payload={payload as UserInputPayload} />
        </Row>
      );
    case 'humanized': {
      // Suppress humanized rows that are canned echoes of structured events
      // we already render with a richer block (tool_call / approval / error).
      const summary = (payload as HumanizedPayload).summary ?? '';
      if (isCannedHumanized(summary)) return null;
      return (
        <Row time={time} isFresh={isFresh} kind="say" selected={selected} onSelect={toggle}>
          <HumanizedBlock payload={payload as HumanizedPayload} />
        </Row>
      );
    }
    case 'tool_call':
      // ToolCallBlock renders its own inner button — Row stays a plain wrapper
      // to avoid nested interactive elements.
      return (
        <Row time={time} isFresh={isFresh} kind="tool" dense>
          <ToolCallBlock
            payload={payload as ToolCallPayload}
            selected={selected}
            onSelect={toggle}
          />
        </Row>
      );
    case 'approval':
      return (
        <Row time={time} isFresh={isFresh} kind="warn" selected={selected} onSelect={toggle}>
          <ApprovalBlock payload={payload as ApprovalPayload} />
        </Row>
      );
    case 'error':
      return (
        <Row time={time} isFresh={isFresh} kind="err" selected={selected} onSelect={toggle}>
          <ErrorBlock payload={payload as ErrorPayload} />
        </Row>
      );
    case 'token_count':
      return (
        <Row time={time} isFresh={isFresh} kind="meter" dense selected={selected} onSelect={toggle}>
          <TokenCountLine payload={payload as TokenCountPayload} />
        </Row>
      );
    case 'rate_limit':
      return (
        <Row time={time} isFresh={isFresh} kind="meter" dense selected={selected} onSelect={toggle}>
          <RateLimitLine payload={payload as RateLimitPayload} />
        </Row>
      );
    default:
      return (
        <Row time={time} isFresh={isFresh} kind="say" dense selected={selected} onSelect={toggle}>
          <UnknownBlock kind={ev.kind} payload={payload} />
        </Row>
      );
  }
}

/** Stacked tool-call ribbon — collapses N consecutive same-tool calls under a single header. */
export function ToolRunGroup({
  events,
  isFreshFn,
  selectedId,
  onSelect,
}: {
  events: EventRow[];
  isFreshFn: (id: number) => boolean;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const head = events[0];
  if (!head) return null;
  const tool = (head.payload as ToolCallPayload).tool ?? 'tool';
  const time = formatTime(head.created_at);
  const succeeded = events.filter((e) => exitOf(e) === 'success').length;
  const failed = events.filter((e) => exitOf(e) === 'error').length;
  const running = events.filter((e) => exitOf(e) === 'running').length;
  const isFresh = events.some((e) => isFreshFn(e.id));

  return (
    <Row time={time} isFresh={isFresh} kind="tool" dense>
      <details className="group/run">
        <summary className="cursor-pointer list-none flex items-center gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-surface-1">
          <ToolGlyph tool={tool} />
          <span className="font-mono text-[12.5px] text-ink-0">{tool}</span>
          <span className="text-ink-3 text-[11px]">×{events.length}</span>
          <span className="flex items-center gap-1 ml-1">
            {succeeded > 0 && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
            {failed > 0 && <span className="h-1.5 w-1.5 rounded-full bg-danger" />}
            {running > 0 && <span className="h-1.5 w-1.5 rounded-full bg-signal" />}
          </span>
          <span className="ml-2 text-[11px] text-ink-3 truncate">
            {previewArgs((head.payload as ToolCallPayload).args)}
          </span>
          <span className="ml-auto text-[10px] text-ink-3 smallcaps">{events.length} actions</span>
        </summary>
        <div className="mt-1 ml-6 border-l border-hairline pl-3 space-y-0.5">
          {events.map((e) => (
            <ToolCallChild
              key={e.id}
              ev={e}
              selected={selectedId === e.id}
              onSelect={() => onSelect(selectedId === e.id ? null : e.id)}
            />
          ))}
        </div>
      </details>
    </Row>
  );
}

function ToolCallChild({
  ev,
  selected,
  onSelect,
}: {
  ev: EventRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const payload = ev.payload as ToolCallPayload;
  const status = exitOf(ev);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left flex items-center gap-2 py-1 pr-2 rounded text-[12px] ${
        selected ? 'bg-signal-soft text-ink-0' : 'text-ink-2 hover:text-ink-0 hover:bg-surface-1'
      }`}
    >
      <ExitChip status={status} summary={payload.result_summary} />
      <span className="font-mono text-ink-2 truncate">{previewArgs(payload.args)}</span>
      <span className="ml-auto tabular text-[10px] text-ink-3">{formatTime(ev.created_at)}</span>
    </button>
  );
}

/* -------- Row: timestamp gutter + content rail. The visual ticker tape. -------- */

function Row({
  time,
  isFresh,
  kind,
  dense,
  selected,
  onSelect,
  children,
}: {
  time: string;
  isFresh: boolean;
  kind: 'say' | 'you' | 'tool' | 'warn' | 'err' | 'meter';
  dense?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  const railColor: Record<typeof kind, string> = {
    say: 'bg-info',
    you: 'bg-signal',
    tool: 'bg-ink-3',
    warn: 'bg-signal',
    err: 'bg-danger',
    meter: 'bg-ink-4',
  };
  const interactive = typeof onSelect === 'function';
  const contentClass = interactive
    ? `min-w-0 -mx-2 px-2 py-1 rounded transition-colors cursor-pointer ${
        selected ? 'bg-signal-soft' : 'hover:bg-surface-1'
      }`
    : 'min-w-0';
  return (
    <div
      data-fresh={isFresh ? 'true' : 'false'}
      className={`grid grid-cols-[72px_10px_1fr] gap-3 items-start group ${dense ? 'py-0.5' : 'py-1.5'}`}
    >
      <div className="text-right tabular text-[11px] text-ink-3 pt-1">{time}</div>
      <div className="relative h-full flex justify-center">
        <span
          aria-hidden
          className={`absolute top-2 h-1.5 w-1.5 rounded-full ring-2 ring-surface-0 ${railColor[kind]}`}
        />
        <span aria-hidden className="absolute top-3.5 bottom-0 w-px bg-hairline" />
      </div>
      {interactive ? (
        <div
          role="button"
          tabIndex={0}
          aria-pressed={selected ? true : false}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onSelect?.();
            }
          }}
          className={contentClass}
        >
          {children}
        </div>
      ) : (
        <div className={contentClass}>{children}</div>
      )}
    </div>
  );
}

/* -------- Block bodies -------- */

function UserInputBlock({ payload }: { payload: UserInputPayload }) {
  return (
    <div className="rounded-md bg-signal-soft border border-signal/30 px-3 py-2">
      <div className="smallcaps text-[10px] text-signal mb-1">you</div>
      <div className="text-[13px] text-ink-0">
        <Markdown>{payload.text ?? ''}</Markdown>
      </div>
    </div>
  );
}

function HumanizedBlock({ payload }: { payload: HumanizedPayload }) {
  return (
    <div className="text-[13.5px] text-ink-0 leading-[1.6]">
      <Markdown>{payload.summary ?? ''}</Markdown>
    </div>
  );
}

function ToolCallBlock({
  payload,
  selected,
  onSelect,
}: {
  payload: ToolCallPayload;
  selected: boolean;
  onSelect: () => void;
}) {
  const tool = payload.tool ?? '?';
  const cmd = previewArgs(payload.args);
  const status = exitFromSummary(payload.result_summary);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded transition-colors ${
        selected ? 'bg-signal-soft' : 'hover:bg-surface-1'
      }`}
    >
      <ToolGlyph tool={tool} />
      <span className="font-mono text-[12.5px] text-ink-0 shrink-0">{tool}</span>
      <ExitChip status={status} summary={payload.result_summary} />
      {cmd && <span className="font-mono text-[12px] text-ink-2 truncate min-w-0">{cmd}</span>}
    </button>
  );
}

function ApprovalBlock({ payload }: { payload: ApprovalPayload }) {
  return (
    <div className="rounded-md border border-signal/40 bg-signal-soft px-3 py-2">
      <div className="flex items-center gap-2 mb-0.5">
        <span className="smallcaps text-[10px] text-signal">approval requested</span>
      </div>
      <div className="text-[13px] text-ink-0">{payload.reason ?? ''}</div>
    </div>
  );
}

function ErrorBlock({ payload }: { payload: ErrorPayload }) {
  return (
    <div className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2">
      <div className="flex items-center gap-2 mb-0.5">
        <span className="font-mono text-[12px] text-danger">{payload.class ?? 'error'}</span>
        {payload.recoverable && (
          <span className="smallcaps text-[9px] text-ink-3 border border-hairline rounded px-1 py-px">
            recoverable
          </span>
        )}
      </div>
      <div className="text-[13px] text-ink-0 break-words">{payload.message ?? ''}</div>
    </div>
  );
}

function TokenCountLine({ payload }: { payload: TokenCountPayload }) {
  return (
    <div className="font-mono text-[11px] text-ink-3 tabular flex items-center gap-3">
      <span>
        <span className="text-ink-4">in</span>{' '}
        <span className="text-ink-1">{payload.input_tokens.toLocaleString()}</span>
      </span>
      <span>
        <span className="text-ink-4">out</span>{' '}
        <span className="text-ink-1">{payload.output_tokens.toLocaleString()}</span>
      </span>
      <span>
        <span className="text-ink-4">Σ</span>{' '}
        <span className="text-ink-0">{payload.total_tokens.toLocaleString()}</span>
      </span>
    </div>
  );
}

function RateLimitLine({ payload }: { payload: RateLimitPayload }) {
  const source = payload.source ?? 'unknown';
  const remaining = payload.remaining;
  const resetAt = payload.reset_at ? new Date(payload.reset_at) : null;
  const resetValid = resetAt !== null && !Number.isNaN(resetAt.getTime());
  return (
    <div className="font-mono text-[11px] text-ink-3 tabular flex items-center gap-3">
      <span>
        <span className="text-ink-4">rate limit</span> <span className="text-ink-1">{source}</span>
      </span>
      <span>
        <span className="text-ink-4">remaining</span>{' '}
        <span className="text-ink-1">
          {typeof remaining === 'number' ? remaining.toLocaleString() : 'n/a'}
        </span>
      </span>
      {resetValid ? (
        <span>
          <span className="text-ink-4">resets</span>{' '}
          <span className="text-ink-1">{resetAt.toLocaleTimeString()}</span>
        </span>
      ) : null}
    </div>
  );
}

function UnknownBlock({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  return (
    <div className="text-[12px] text-ink-2">
      <span className="font-mono text-ink-3">{kind}</span> <span className="text-ink-3">·</span>{' '}
      <span className="text-ink-1">{JSON.stringify(payload).slice(0, 140)}</span>
    </div>
  );
}

/* -------- Atoms -------- */

function ExitChip({
  status,
  summary,
}: {
  status: 'success' | 'error' | 'running' | 'unknown';
  summary?: string;
}) {
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-signal whitespace-nowrap shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-signal animate-pulse" />
        running
      </span>
    );
  }
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-success whitespace-nowrap shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        {summary ?? 'ok'}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-danger whitespace-nowrap shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-danger" />
        {summary ?? 'fail'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-ink-3 whitespace-nowrap shrink-0">
      {summary ?? '·'}
    </span>
  );
}

const TOOL_ICONS: Record<string, string> = {
  bash: '$',
  shell: '$',
  exec: '$',
  read: '⎙',
  Read: '⎙',
  edit: '✎',
  Edit: '✎',
  write: '✎',
  Write: '✎',
  grep: '⌕',
  Grep: '⌕',
  glob: '⌕',
  Glob: '⌕',
  task: '◇',
  Task: '◇',
  webfetch: '↗',
  WebFetch: '↗',
  websearch: '⌕',
  WebSearch: '⌕',
  todowrite: '☑',
  TodoWrite: '☑',
};

function ToolGlyph({ tool }: { tool: string }) {
  const icon = TOOL_ICONS[tool] ?? (tool.toLowerCase().startsWith('mcp') ? '◈' : '▣');
  return (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-surface-2 text-ink-1 font-mono text-[11px] shrink-0">
      {icon}
    </span>
  );
}

/**
 * The worker emits a humanized row alongside every structured event. For tool
 * calls / approvals / errors that's redundant — we already render a richer
 * block. Drop those canned echoes; keep the prose narrations.
 */
export function isCannedHumanized(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (/^Calling [\w/.\-]+$/.test(t)) return true;
  if (/^Approval requested:/.test(t)) return true;
  if (/^Error \(/.test(t)) return true;
  // tool result echoes look like "bash: exit 0", "edit: ok", "Read: …", "tool: running"
  if (/^[\w/.\-]+:\s*(running|pending|exit\s+-?\d+|ok|fail(ed)?|error|completed|done)\b/i.test(t))
    return true;
  if (/^[\w/.\-]+\s+completed$/i.test(t)) return true;
  return false;
}

export function exitOf(ev: { payload: unknown }): 'success' | 'error' | 'running' | 'unknown' {
  return exitFromSummary((ev.payload as ToolCallPayload | undefined)?.result_summary);
}

export function exitFromSummary(
  raw: string | undefined,
): 'success' | 'error' | 'running' | 'unknown' {
  const summary = raw?.toLowerCase() ?? '';
  if (!summary) return 'unknown';
  if (summary.includes('running') || summary.includes('pending')) return 'running';
  // codex shells: "exit 0" / "exit 1"
  const m = summary.match(/exit\s+(-?\d+)/);
  if (m) return m[1] === '0' ? 'success' : 'error';
  if (summary.includes('error') || summary.includes('fail')) return 'error';
  return 'success';
}

export function previewArgs(args: unknown): string {
  if (!args) return '';
  if (typeof args === 'string') return collapse(args);
  if (Array.isArray(args)) return collapse(args.join(' '));
  if (typeof args === 'object') {
    const a = args as Record<string, unknown>;
    // bash from codex
    const c = a.command ?? a.cmd;
    if (Array.isArray(c)) return collapse(c.join(' '));
    if (typeof c === 'string') return collapse(c);
    // claude tools — try canonical fields
    const candidates = [
      a.file_path,
      a.path,
      a.pattern,
      a.query,
      a.url,
      a.description,
      a.subject,
      a.prompt,
    ];
    const first = candidates.find((v) => typeof v === 'string' && v.length > 0);
    if (typeof first === 'string') return collapse(first);
    // fallback — short JSON
    return collapse(JSON.stringify(a));
  }
  return collapse(String(args));
}

function collapse(s: string): string {
  return unwrapShell(s.replace(/\s+/g, ' ').trim()).slice(0, 200);
}

/** Strip wrappers like `/bin/zsh -lc '…'`, `bash -c "…"` so the inner command is what's shown. */
function unwrapShell(s: string): string {
  const m = s.match(
    /^(?:[/\w.-]*\/)?(?:bash|sh|zsh|fish)\s+(?:-l\s+)?-(?:l?c)\s+(['"])([\s\S]*)\1\s*$/,
  );
  if (m && m[2]) return m[2];
  return s;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/* -------- Markdown -------- */

const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="text-ink-0 leading-[1.65] my-1.5 first:mt-0 last:mb-0">{children}</p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-info underline decoration-info/40 underline-offset-2 hover:decoration-info"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = (rest as { 'data-inline'?: boolean })['data-inline'] === false;
    if (isBlock || (className && className.startsWith('language-'))) {
      return (
        <code className="block whitespace-pre overflow-x-auto rounded bg-surface-2 border border-hairline p-2 text-[12px] text-ink-1 font-mono">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-surface-2 px-1.5 py-px text-[0.86em] text-ink-0 font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
  ul: ({ children }) => <ul className="list-disc ml-5 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-5 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-ink-0">{children}</li>,
  h1: ({ children }) => (
    <h1 className="text-[15px] font-semibold text-ink-0 mt-2 mb-1">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[14px] font-semibold text-ink-0 mt-2 mb-1">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[13px] font-semibold text-ink-1 mt-2 mb-1">{children}</h3>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-hairline-strong pl-3 text-ink-2 my-1">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-hairline" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline px-2 py-1 text-left text-ink-1">{children}</th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1 text-ink-0">{children}</td>,
};

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}
