import { execa } from 'execa';
import type { HookName, Issue } from '@symphony/shared';

export interface HookResult {
  exitCode: number;
  durationMs: number;
  stderrTail: string | null;
  timedOut: boolean;
}

export interface HookEnv {
  issue: Issue;
  workspacePath: string;
  attemptNumber: number;
}

/**
 * Environment variable names that must not leak into hook subprocesses.
 * Spec: "API keys via environment variables, never logged in full" — and never
 * passed to operator-supplied hook scripts either.
 */
const BLOCKED_ENV = new Set([
  'SUPABASE_SERVICE_ROLE_KEY',
  'LINEAR_API_KEY',
  'TEST_SUPABASE_SERVICE_ROLE_KEY',
]);

/**
 * Run a workflow hook script via `bash -lc`. Returns the result without
 * throwing on non-zero exit (caller decides whether to treat as fatal).
 *
 * - cwd is the workspace path; never the worker's cwd.
 * - secrets are stripped from env before spawning.
 * - stdout/stderr are captured but only the stderr tail is returned.
 * - timeout enforced via execa; SIGTERM then SIGKILL.
 */
export async function runHook(
  hook: HookName,
  script: string,
  env: HookEnv,
  options: { timeoutMs: number },
): Promise<HookResult> {
  const start = Date.now();
  const childEnv = filterEnv(process.env);
  childEnv.SYMPHONY_HOOK = hook;
  childEnv.ISSUE_ID = env.issue.id;
  childEnv.ISSUE_IDENTIFIER = env.issue.identifier;
  childEnv.ISSUE_TITLE = env.issue.title;
  childEnv.ISSUE_STATE = env.issue.state;
  childEnv.ATTEMPT_NUMBER = String(env.attemptNumber);
  childEnv.WORKSPACE_PATH = env.workspacePath;
  // Passed through explicitly rather than relying on filterEnv — this is the
  // canonical input to the default after_create `git clone` hook, so surfacing
  // it here makes the contract obvious at the call site.
  if (process.env.REPO_URL) childEnv.REPO_URL = process.env.REPO_URL;

  try {
    const result = await execa('bash', ['-lc', script], {
      cwd: env.workspacePath,
      env: childEnv,
      extendEnv: false, // childEnv is the *complete* env; secrets are stripped
      timeout: options.timeoutMs,
      reject: false,
      all: false,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: result.exitCode ?? -1,
      durationMs: Date.now() - start,
      stderrTail: tail(result.stderr ?? '', 4096),
      timedOut: result.timedOut === true,
    };
  } catch (err) {
    // execa with reject:false should not throw for non-zero exit, but spawn
    // failures (e.g. bash missing) still throw.
    const e = err as { stderr?: string; timedOut?: boolean; exitCode?: number };
    return {
      exitCode: e.exitCode ?? -1,
      durationMs: Date.now() - start,
      stderrTail: tail(e.stderr ?? (err instanceof Error ? err.message : ''), 4096),
      timedOut: e.timedOut === true,
    };
  }
}

function filterEnv(src: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    if (BLOCKED_ENV.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function tail(s: string, max: number): string | null {
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}
