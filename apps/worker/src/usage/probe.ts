import type { AgentBackend } from '@symphony/shared';
import type { Logger } from 'pino';

export interface UsageSnapshot {
  /** 0–100. The smallest remaining-percentage across the backend's quota windows (5h + weekly) — whichever is closest to running out is what gates dispatch. */
  remainingPct: number;
  /** When the gating window resets, if reported. null when the CLI didn't surface a parseable reset time. */
  resetAt: Date | null;
}

export interface UsageProbe {
  probe(backend: AgentBackend): Promise<UsageSnapshot | null>;
}

interface PtyLike {
  onData(cb: (data: string) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): PtyLike;
}

const STATUS_INPUT = '/status\r';
// Real-world `claude /status` and `codex /status` settle within a few hundred
// ms of opening the session, but TUI repaints, MOTD banners, and slower
// machines can stretch that. 3s gives the panel time to render without
// blocking the orchestrator tick noticeably (we cache for 60s anyway).
const READ_WINDOW_MS = 3000;

/**
 * Default probe: spawns the active backend's CLI under a PTY, sends `/status`,
 * collects ~3s of output, and parses remaining quota out of the visible panel.
 *
 * Failure modes (CLI missing, not logged in, PTY native build absent, parse
 * miss) all return `null` — the caller treats `null` as **fail open** and
 * does NOT gate dispatch. Halting the worker on a flaky probe would be worse
 * than running with stale information.
 */
export function defaultUsageProbe(log: Logger): UsageProbe {
  return {
    probe: async (backend) => {
      try {
        return await runStatusProbe(backend, log);
      } catch (err) {
        log.warn(
          { backend, err: err instanceof Error ? err.message : String(err) },
          'usage probe failed; failing open',
        );
        return null;
      }
    },
  };
}

async function runStatusProbe(
  backend: AgentBackend,
  log: Logger,
): Promise<UsageSnapshot | null> {
  const pty = await loadNodePty();
  if (!pty) {
    log.warn(
      { backend },
      'usage probe: node-pty unavailable (install fail or missing) — failing open',
    );
    return null;
  }
  const command = backend === 'claude' ? 'claude' : 'codex';
  let buf = '';
  const proc = pty.spawn(command, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    env: process.env,
  });
  proc.onData((d) => {
    buf += d;
  });
  proc.write(STATUS_INPUT);
  await new Promise((r) => setTimeout(r, READ_WINDOW_MS));
  try {
    proc.kill();
  } catch {
    // Best effort — the process may have already exited.
  }
  const text = stripAnsi(buf);
  const parsed = backend === 'claude' ? parseClaudeStatus(text) : parseCodexStatus(text);
  if (!parsed) {
    log.warn({ backend, sample: text.slice(0, 200) }, 'usage probe: could not parse /status output');
    return null;
  }
  return parsed;
}

async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    // node-pty is an optionalDependency: install may have skipped it (no
    // toolchain on the host), or it may have failed to compile. Dynamic
    // import via a string variable keeps the TS compiler from demanding type
    // resolution at typecheck time — we discover availability at runtime.
    const moduleName = 'node-pty';
    const mod = (await import(moduleName)) as unknown as NodePtyModule;
    return mod;
  } catch {
    return null;
  }
}

const ANSI_RE = /\[[0-9;?]*[A-Za-z]|\][^]*|[=>]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Parse `claude /status` output. Codexbar's reference parser
 * (Sources/CodexBarCore/Providers/Claude/ClaudeUsageFetcher.swift) keys off
 * lines like:
 *
 *     Session usage: 47% (resets at 14:00)
 *     Weekly usage:  12% (resets in 5 days)
 *
 * Different `claude` versions render slightly different verbiage, so we look
 * for any line carrying both a percent number and one of the bucket keywords
 * — "session"/"5h"/"five hour"/"5-hour" or "weekly"/"7-day"/"week". The
 * smallest remaining wins.
 */
export function parseClaudeStatus(text: string): UsageSnapshot | null {
  return parseStatusGeneric(text, [/session|5\s*-?\s*h|five\s+hour/i, /weekly|7\s*-?\s*day|\bweek\b/i]);
}

/**
 * Parse `codex /status` output. Codexbar's reference parser
 * (Sources/CodexBarCore/Providers/Codex/CodexStatusProbe.swift) reads:
 *
 *     5h limit:     61% used  (resets in 02:14)
 *     Weekly limit: 18% used  (resets Mon)
 *
 * Same forgiving approach as claude — match on bucket keyword + a percent —
 * and pick whichever window has the smallest remaining.
 */
export function parseCodexStatus(text: string): UsageSnapshot | null {
  return parseStatusGeneric(text, [/5\s*-?\s*h(?:ours?)?\b|hourly/i, /weekly|7\s*-?\s*day|\bweek\b/i]);
}

function parseStatusGeneric(text: string, bucketPatterns: RegExp[]): UsageSnapshot | null {
  const lines = text.split(/\r?\n/);
  const candidates: { remainingPct: number; resetAt: Date | null }[] = [];
  for (const line of lines) {
    if (!bucketPatterns.some((re) => re.test(line))) continue;
    const pct = extractPercent(line);
    if (pct === null) continue;
    const remaining = inferRemainingPct(line, pct);
    candidates.push({ remainingPct: remaining, resetAt: extractResetAt(line) });
  }
  if (candidates.length === 0) return null;
  // Pick the bucket closest to running out — that's the one that should gate.
  candidates.sort((a, b) => a.remainingPct - b.remainingPct);
  return candidates[0]!;
}

function extractPercent(line: string): number | null {
  const m = line.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/**
 * The line shows a single percent, but it may be either "X% used" or "X% left".
 * We disambiguate from surrounding words; default to "used" since that's how
 * both `claude /status` and `codex /status` render it today.
 */
function inferRemainingPct(line: string, pct: number): number {
  if (/\b(left|remaining|available)\b/i.test(line)) return pct;
  return Math.max(0, 100 - pct);
}

function extractResetAt(line: string): Date | null {
  // "(resets at 14:00)" or "(resets in 02:14)" or "resets at 2026-01-02T..."
  const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (isoMatch) {
    const d = new Date(isoMatch[1]!);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const inMatch = line.match(/resets?\s+in\s+(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
  if (inMatch) {
    const h = Number(inMatch[1]);
    const m = Number(inMatch[2]);
    const s = inMatch[3] ? Number(inMatch[3]) : 0;
    return new Date(Date.now() + ((h * 60 + m) * 60 + s) * 1000);
  }
  const inDays = line.match(/resets?\s+in\s+(\d+)\s+day/i);
  if (inDays) {
    return new Date(Date.now() + Number(inDays[1]) * 24 * 60 * 60 * 1000);
  }
  const atClock = line.match(/resets?\s+at\s+(\d{1,2}):(\d{2})/i);
  if (atClock) {
    const now = new Date();
    const target = new Date(now);
    target.setHours(Number(atClock[1]), Number(atClock[2]), 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target;
  }
  return null;
}
