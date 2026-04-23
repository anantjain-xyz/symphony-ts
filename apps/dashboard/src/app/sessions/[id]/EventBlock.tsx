'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Tables } from '@symphony/shared';

type EventRow = Tables<'agent_events'>;

type StatusPayload = { message: string };
type ToolCallPayload = {
  tool: string;
  args?: unknown;
  call_id?: string;
  result_summary?: string;
};
type ApprovalPayload = { reason: string; call_id?: string };
type TokenCountPayload = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};
type ErrorPayload = { class: string; message: string; recoverable?: boolean };
type UserInputPayload = { text: string };
type HumanizedPayload = { summary: string };

interface Props {
  ev: EventRow;
  prev?: EventRow;
}

export function EventBlock({ ev, prev }: Props) {
  const time = new Date(ev.created_at).toLocaleTimeString();
  const payload = ev.payload as Record<string, unknown>;

  switch (ev.kind) {
    case 'user_input':
      return <UserInputBlock time={time} payload={payload as UserInputPayload} />;
    case 'humanized':
      return <HumanizedBlock time={time} payload={payload as HumanizedPayload} />;
    case 'status':
      return (
        <StatusBlock
          time={time}
          payload={payload as StatusPayload}
          groupedWithPrev={prev?.kind === 'status'}
        />
      );
    case 'tool_call':
      return <ToolCallBlock time={time} payload={payload as ToolCallPayload} />;
    case 'approval':
      return <ApprovalBlock time={time} payload={payload as ApprovalPayload} />;
    case 'error':
      return <ErrorBlock time={time} payload={payload as ErrorPayload} />;
    case 'token_count':
      return <TokenCountLine payload={payload as TokenCountPayload} />;
    default:
      return <UnknownBlock time={time} kind={ev.kind} payload={payload} />;
  }
}

function UserInputBlock({ time, payload }: { time: string; payload: UserInputPayload }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%]">
        <div className="flex items-center justify-end gap-2 mb-1 text-[11px] text-zinc-500">
          <span>{time}</span>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">you</span>
        </div>
        <div className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-100">
          <Markdown>{payload.text ?? ''}</Markdown>
        </div>
      </div>
    </div>
  );
}

function HumanizedBlock({ time, payload }: { time: string; payload: HumanizedPayload }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        <div className="flex items-center gap-2 mb-1 text-[11px] text-zinc-500">
          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">assistant</span>
          <span>{time}</span>
        </div>
        <div className="rounded-lg border border-emerald-500/20 bg-zinc-900 px-4 py-2 text-sm text-zinc-100">
          <Markdown>{payload.summary ?? ''}</Markdown>
        </div>
      </div>
    </div>
  );
}

function StatusBlock({
  time,
  payload,
  groupedWithPrev,
}: {
  time: string;
  payload: StatusPayload;
  groupedWithPrev: boolean;
}) {
  return (
    <div className={`flex items-baseline gap-2 text-xs text-zinc-400 ${groupedWithPrev ? '-mt-2' : ''}`}>
      <span className="text-zinc-600 shrink-0 w-16 tabular-nums">{time}</span>
      <span className="text-zinc-600">▸</span>
      <span className="break-words">{payload.message ?? ''}</span>
    </div>
  );
}

function ToolCallBlock({ time, payload }: { time: string; payload: ToolCallPayload }) {
  const hasArgs = payload.args !== undefined && payload.args !== null;
  const summary = payload.result_summary;
  return (
    <div className="rounded-lg border border-blue-500/20 bg-zinc-900">
      <details>
        <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-2 text-sm">
          <span className="text-blue-400">🔧</span>
          <span className="font-mono text-zinc-100">{payload.tool ?? '?'}</span>
          {summary ? (
            <span className="text-zinc-400 truncate">— {summary}</span>
          ) : (
            <span className="text-zinc-600">…</span>
          )}
          <span className="ml-auto text-[11px] text-zinc-600 tabular-nums">{time}</span>
        </summary>
        {hasArgs && (
          <div className="border-t border-zinc-800 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">args</div>
            <JsonBlock value={payload.args} />
          </div>
        )}
      </details>
    </div>
  );
}

function ApprovalBlock({ time, payload }: { time: string; payload: ApprovalPayload }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-amber-300">
        <span>⚠</span>
        <span className="font-medium">Approval requested</span>
        <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{time}</span>
      </div>
      <div className="mt-1 text-sm text-zinc-200">{payload.reason ?? ''}</div>
    </div>
  );
}

function ErrorBlock({ time, payload }: { time: string; payload: ErrorPayload }) {
  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-red-300">
        <span>✕</span>
        <span className="font-medium font-mono">{payload.class ?? 'error'}</span>
        {payload.recoverable && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">recoverable</span>
        )}
        <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">{time}</span>
      </div>
      <div className="mt-1 text-sm text-zinc-200 break-words">{payload.message ?? ''}</div>
    </div>
  );
}

function TokenCountLine({ payload }: { payload: TokenCountPayload }) {
  return (
    <div className="text-[11px] text-zinc-600 tabular-nums pl-[72px]">
      ↑ {payload.input_tokens.toLocaleString()} · ↓ {payload.output_tokens.toLocaleString()} · Σ{' '}
      {payload.total_tokens.toLocaleString()}
    </div>
  );
}

function UnknownBlock({
  time,
  kind,
  payload,
}: {
  time: string;
  kind: string;
  payload: Record<string, unknown>;
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
      <div className="flex items-center gap-2 text-zinc-500">
        <span className="font-mono">{kind}</span>
        <span className="ml-auto tabular-nums">{time}</span>
      </div>
      <JsonBlock value={payload} />
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-xs text-zinc-300 whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="text-zinc-100 leading-relaxed my-1 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} className="text-blue-400 underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ className, children, ...rest }) => {
    const isBlock = (rest as { 'data-inline'?: boolean })['data-inline'] === false;
    if (isBlock || (className && className.startsWith('language-'))) {
      return (
        <code className="block whitespace-pre overflow-x-auto rounded bg-zinc-950 border border-zinc-800 p-2 text-xs text-zinc-300 font-mono">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-zinc-800 px-1 py-0.5 text-[0.85em] text-zinc-100 font-mono">
        {children}
      </code>
    );
  },
  pre: ({ children }) => <pre className="my-2 overflow-x-auto">{children}</pre>,
  ul: ({ children }) => <ul className="list-disc ml-5 my-1 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal ml-5 my-1 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-zinc-100">{children}</li>,
  h1: ({ children }) => <h1 className="text-base font-semibold text-zinc-100 mt-2 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-semibold text-zinc-100 mt-2 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-zinc-200 mt-2 mb-1">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-700 pl-3 text-zinc-400 my-1">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-zinc-800" />,
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="text-xs border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-zinc-800 px-2 py-1 text-left text-zinc-300">{children}</th>,
  td: ({ children }) => <td className="border border-zinc-800 px-2 py-1 text-zinc-200">{children}</td>,
};

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {children}
    </ReactMarkdown>
  );
}
