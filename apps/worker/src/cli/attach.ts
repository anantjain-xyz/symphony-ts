/**
 * `pnpm --filter @symphony/worker attach <issue-identifier>`
 *
 * Look up the Claude session id tied to the most recent attempt on <issue>,
 * then `claude --resume <session-id>` in the issue's workspace with stdio
 * inherited. Use when an agent gets stuck and an operator wants to drive the
 * same session from their own terminal.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { execa } from 'execa';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
loadDotenv({ path: resolve(repoRoot, '.env.local') });
loadDotenv({ path: resolve(repoRoot, '.env') });

import { createServiceClient } from '@symphony/shared';
import { resolveConfig } from '../config/resolve.js';
import { loadWorkflowFile } from '../config/workflow.js';
import { WorkspaceManager } from '../workspace/manager.js';

async function main(): Promise<number> {
  const identifier = process.argv[2];
  if (!identifier) {
    process.stderr.write('usage: pnpm --filter @symphony/worker attach <issue-identifier>\n');
    return 2;
  }

  const workflowPath = resolve(repoRoot, process.env.WORKFLOW_PATH ?? 'WORKFLOW.md');
  const workflow = await loadWorkflowFile(workflowPath);
  const config = resolveConfig(workflow);

  if (config.agentBackend() !== 'claude') {
    process.stderr.write(
      `attach is only supported for the claude backend; current backend is ${config.agentBackend()}.\n` +
        `Flip \`agent.backend: claude\` in ${workflowPath} and restart the worker.\n`,
    );
    return 2;
  }

  const workspaces = new WorkspaceManager(config.workspaceRoot());
  const cwd = workspaces.pathFor(identifier);

  let sessionId: string | null = null;
  try {
    sessionId = await lookupSessionIdFromDb(identifier);
  } catch (err) {
    process.stderr.write(`[attach] DB lookup failed: ${(err as Error).message}\n`);
  }

  if (!sessionId) {
    sessionId = await lookupSessionIdFromDisk(cwd);
  }

  if (!sessionId) {
    process.stderr.write(
      `no Claude session found for ${identifier}. Has the worker started an attempt yet?\n`,
    );
    return 1;
  }

  process.stderr.write(`[attach] resuming claude session ${sessionId} in ${cwd}\n`);
  const r = await execa('claude', ['--resume', sessionId], {
    cwd,
    stdio: 'inherit',
    reject: false,
  });
  return r.exitCode ?? 0;
}

async function lookupSessionIdFromDb(identifier: string): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const db = createServiceClient({ url, serviceRoleKey: key });

  const { data: issue, error: issueErr } = await db
    .from('issues')
    .select('id')
    .eq('identifier', identifier)
    .maybeSingle();
  if (issueErr) throw issueErr;
  if (!issue) return null;

  const { data: attempt, error: attErr } = await db
    .from('run_attempts')
    .select('id, status')
    .eq('issue_id', issue.id)
    .order('attempt_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (attErr) throw attErr;
  if (!attempt) return null;

  const { data: session, error: sessErr } = await db
    .from('live_sessions')
    .select('thread_id')
    .eq('run_attempt_id', attempt.id)
    .maybeSingle();
  if (sessErr) throw sessErr;
  if (session?.thread_id) return session.thread_id;

  return null;
}

/**
 * Fallback when `live_sessions` has been cleared on attempt completion. Claude
 * Code persists each session as `~/.claude/projects/<hashed-cwd>/<uuid>.jsonl`
 * (the hash maps cwd -> a stable directory). Pick the newest `.jsonl` under
 * any project dir that references our workspace path.
 */
async function lookupSessionIdFromDisk(cwd: string): Promise<string | null> {
  const projectsRoot = path.join(homedir(), '.claude', 'projects');
  let projects: string[];
  try {
    projects = await readdir(projectsRoot);
  } catch {
    return null;
  }

  let best: { uuid: string; mtimeMs: number } | null = null;
  for (const dir of projects) {
    const full = path.join(projectsRoot, dir);
    let entries: string[];
    try {
      entries = await readdir(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = path.join(full, entry);
      let matchesCwd = false;
      try {
        const fd = await readFile(filePath, 'utf8');
        const firstLine = fd.split('\n', 1)[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine) as { cwd?: string };
          if (parsed.cwd === cwd) matchesCwd = true;
        }
      } catch {
        continue;
      }
      if (!matchesCwd) continue;
      const s = await stat(filePath);
      const uuid = entry.slice(0, -'.jsonl'.length);
      if (!best || s.mtimeMs > best.mtimeMs) {
        best = { uuid, mtimeMs: s.mtimeMs };
      }
    }
  }
  return best?.uuid ?? null;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  },
);
