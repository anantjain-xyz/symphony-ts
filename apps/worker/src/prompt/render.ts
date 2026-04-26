import type { Issue } from '@symphony/shared';

/**
 * Minimal Mustache-flavored renderer scoped to issue fields. Supports:
 *
 *   {{field}}                    - value substitution (HTML-NOT-escaped; the
 *                                  template is fed directly to the agent).
 *   {{#field}}...{{/field}}      - section: rendered if value is truthy and
 *                                  non-empty array.
 *   {{#field.length}}...{{/...}} - section guard for non-empty arrays.
 *   {{#array}} {{.}} {{/array}}  - iterate strings.
 *
 * Out of scope: nested Mustache lambdas, partials, custom delimiters.
 */
export function renderPrompt(template: string, issue: Issue): string {
  let out = '';
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{{', i);
    if (open < 0) {
      out += template.slice(i);
      break;
    }
    out += template.slice(i, open);
    const close = template.indexOf('}}', open + 2);
    if (close < 0) {
      // Unmatched; emit the rest verbatim.
      out += template.slice(open);
      break;
    }
    const tag = template.slice(open + 2, close).trim();
    if (tag.startsWith('#')) {
      const field = tag.slice(1).trim();
      const endTag = `{{/${field}}}`;
      const endIdx = template.indexOf(endTag, close + 2);
      if (endIdx < 0) throw new Error(`Unclosed section: ${tag}`);
      const inner = template.slice(close + 2, endIdx);
      out += renderSection(field, inner, issue);
      i = endIdx + endTag.length;
      continue;
    }
    if (tag.startsWith('/') || tag.startsWith('!')) {
      i = close + 2;
      continue;
    }
    out += String(lookup(tag, issue) ?? '');
    i = close + 2;
  }
  return out;
}

function renderSection(field: string, inner: string, issue: Issue): string {
  if (field.endsWith('.length')) {
    const arr = lookup(field.slice(0, -'.length'.length), issue);
    if (Array.isArray(arr) && arr.length > 0) return renderPrompt(inner, issue);
    return '';
  }
  const value = lookup(field, issue);
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value
      .map((item) => renderPrompt(inner.replaceAll('{{.}}', String(item)), issue))
      .join('');
  }
  return value ? renderPrompt(inner, issue) : '';
}

function lookup(field: string, issue: Issue): unknown {
  const obj = issue as unknown as Record<string, unknown>;
  return obj[field];
}

export interface RetryContext {
  runNumber: number;
  priorErrorClass: string | null;
  priorErrorMessage: string | null;
  recentEvents: Array<{ kind: string; payload: unknown; created_at: string }>;
}

/**
 * Repo surface buildRetryContext needs — narrower than the full Repo so the
 * helper can be unit-tested with a fake. Both methods return prior-run data
 * for the same issue, deliberately *excluding* `beforeRunId`.
 */
export interface RetryContextRepo {
  priorRun(
    issueId: string,
    beforeRunId: string,
  ): Promise<{ error_class: string | null; error_message: string | null } | null>;
  recentEventsForIssue(
    issueId: string,
    beforeRunId: string,
    limit: number,
  ): Promise<Array<{ kind: string; payload: unknown; created_at: string }>>;
}

/**
 * Assemble a {@link RetryContext} for the in-flight run. Returns `null` for
 * first runs (caller should skip {@link appendRetryContext}). Pulls
 * `priorErrorClass`/`priorErrorMessage` from the *prior* run's row and
 * `recentEvents` from prior runs' `agent_events` — the new run's row has
 * null errors and no events at prompt-render time.
 */
export async function buildRetryContext(
  repo: RetryContextRepo,
  issueId: string,
  run: { id: string; run_number: number },
  recentEventsLimit = 10,
): Promise<RetryContext | null> {
  if (run.run_number <= 1) return null;
  const [prior, recent] = await Promise.all([
    repo.priorRun(issueId, run.id),
    repo.recentEventsForIssue(issueId, run.id, recentEventsLimit),
  ]);
  return {
    runNumber: run.run_number,
    priorErrorClass: prior?.error_class ?? null,
    priorErrorMessage: prior?.error_message ?? null,
    recentEvents: recent,
  };
}

/**
 * Append a "Prior run context" trailer so the agent can avoid repeating what
 * already failed. Caller passes the rendered prompt + context for the earlier
 * run.
 */
export function appendRetryContext(prompt: string, ctx: RetryContext): string {
  const lines = [
    '',
    '---',
    '',
    `## Prior run context (this is run ${ctx.runNumber})`,
    '',
  ];
  if (ctx.priorErrorClass || ctx.priorErrorMessage) {
    lines.push(
      `Previous run failed: **${ctx.priorErrorClass ?? 'unknown'}** \u2014 ${ctx.priorErrorMessage ?? ''}`.trim(),
    );
    lines.push('');
  }
  if (ctx.recentEvents.length > 0) {
    lines.push('Recent agent events from the previous run (most recent last):');
    lines.push('');
    for (const e of ctx.recentEvents.slice(-10)) {
      lines.push(`- [${e.kind}] ${summarize(e.payload)}`);
    }
  }
  return prompt.trimEnd() + '\n' + lines.join('\n') + '\n';
}

function summarize(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    if (typeof o.message === 'string') return o.message;
    if (typeof o.summary === 'string') return o.summary;
    if (typeof o.tool === 'string') return `tool=${o.tool}`;
  }
  return JSON.stringify(payload);
}
