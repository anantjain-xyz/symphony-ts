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
// Hard ceiling on how long we'll block the orchestrator tick waiting for the
// status panel to render. We exit earlier on settled output (see SETTLE_MS).
const READ_WINDOW_MS = 3000;
// Return as soon as the PTY has been quiet this long after first data — most
// status panels finish in 200–500ms, so we shouldn't sit on the full 3s when
// we've already got everything.
const SETTLE_MS = 250;
// Cap the buffer so a CLI stuck in a login/error loop can't OOM the worker.
const BUF_CAP = 64 * 1024;

export function defaultUsageProbe(log: Logger): UsageProbe {
  return {
    probe: async (backend) => {
      try {
        return await runStatusProbe(backend, log);
      } catch (err) {
        log.warn(
          { backend, err: err instanceof Error ? err.message : String(err) },
          'usage probe failed; orchestrator will fail closed',
        );
        return null;
      }
    },
  };
}

async function runStatusProbe(backend: AgentBackend, log: Logger): Promise<UsageSnapshot | null> {
  const pty = await loadNodePty();
  if (!pty) {
    log.warn(
      { backend },
      'usage probe: node-pty unavailable (install fail or missing); orchestrator will fail closed',
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
  await new Promise<void>((resolve) => {
    let lastDataAt = 0;
    let settleTimer: NodeJS.Timeout | null = null;
    const hardDeadline = setTimeout(() => {
      if (settleTimer) clearTimeout(settleTimer);
      resolve();
    }, READ_WINDOW_MS);
    proc.onData((d) => {
      if (buf.length < BUF_CAP) buf += d;
      lastDataAt = Date.now();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (Date.now() - lastDataAt >= SETTLE_MS) {
          clearTimeout(hardDeadline);
          resolve();
        }
      }, SETTLE_MS);
    });
    proc.write(STATUS_INPUT);
  });
  try {
    proc.kill();
  } catch {
    // Best effort — the process may have already exited.
  }
  const text = stripAnsi(buf);
  const parsed = backend === 'claude' ? parseClaudeStatus(text) : parseCodexStatus(text);
  if (!parsed) {
    log.warn(
      { backend, sample: text.slice(0, 200) },
      'usage probe: could not parse /status output',
    );
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

// Bucket-keyword + percent matchers are forgiving across CLI version drift —
// we just need any line that names a quota window and carries a number.
export function parseClaudeStatus(text: string): UsageSnapshot | null {
  return parseStatusGeneric(text, [
    /session|5\s*-?\s*h|five\s+hour/i,
    /weekly|7\s*-?\s*day|\bweek\b/i,
  ]);
}

export function parseCodexStatus(text: string): UsageSnapshot | null {
  return parseStatusGeneric(text, [
    /5\s*-?\s*h(?:ours?)?\b|hourly/i,
    /weekly|7\s*-?\s*day|\bweek\b/i,
  ]);
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
  const isoMatch = line.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  );
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
