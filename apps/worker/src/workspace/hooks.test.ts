import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Issue } from '@symphony/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHook } from './hooks.js';

const ISSUE: Issue = {
  id: 'uuid-1',
  identifier: 'ENG-7',
  title: 'a title',
  description: null,
  priority: 2,
  state: 'todo',
  branch: null,
  labels: [],
  blockers: [],
  pr_urls: [],
};

describe('runHook', () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(path.join(tmpdir(), 'symphony-hook-'));
  });
  afterEach(async () => {
    await rm(ws, { recursive: true, force: true });
  });

  it('captures exit code 0 on success', async () => {
    const result = await runHook(
      'after_create',
      'echo hi > out.txt',
      { issue: ISSUE, workspacePath: ws, attemptNumber: 1 },
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(await readFile(path.join(ws, 'out.txt'), 'utf8')).toContain('hi');
  });

  it('captures non-zero exit and stderr tail without throwing', async () => {
    const result = await runHook(
      'before_run',
      'echo "bad things" >&2 && exit 7',
      { issue: ISSUE, workspacePath: ws, attemptNumber: 1 },
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(7);
    expect(result.stderrTail).toContain('bad things');
  });

  it('exposes ISSUE_IDENTIFIER and WORKSPACE_PATH to the script', async () => {
    const result = await runHook(
      'before_run',
      'echo "$ISSUE_IDENTIFIER@$WORKSPACE_PATH" > meta.txt',
      { issue: ISSUE, workspacePath: ws, attemptNumber: 3 },
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(0);
    const meta = await readFile(path.join(ws, 'meta.txt'), 'utf8');
    expect(meta.trim()).toBe(`ENG-7@${ws}`);
  });

  it('strips SUPABASE_SERVICE_ROLE_KEY from hook env', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'should-not-leak';
    try {
      const result = await runHook(
        'after_run',
        'echo "key=${SUPABASE_SERVICE_ROLE_KEY:-MISSING}" > leak.txt',
        { issue: ISSUE, workspacePath: ws, attemptNumber: 1 },
        { timeoutMs: 5000 },
      );
      expect(result.exitCode).toBe(0);
      expect((await readFile(path.join(ws, 'leak.txt'), 'utf8')).trim()).toBe('key=MISSING');
    } finally {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });

  it('exposes REPO_URL to the script when set in the process env', async () => {
    process.env.REPO_URL = 'https://example.com/fake.git';
    try {
      const result = await runHook(
        'after_create',
        'echo "$REPO_URL" > repo.txt',
        { issue: ISSUE, workspacePath: ws, attemptNumber: 1 },
        { timeoutMs: 5000 },
      );
      expect(result.exitCode).toBe(0);
      expect((await readFile(path.join(ws, 'repo.txt'), 'utf8')).trim()).toBe(
        'https://example.com/fake.git',
      );
    } finally {
      delete process.env.REPO_URL;
    }
  });

  it('enforces timeoutMs and reports timedOut=true', async () => {
    const result = await runHook(
      'before_remove',
      'sleep 5',
      { issue: ISSUE, workspacePath: ws, attemptNumber: 1 },
      { timeoutMs: 100 },
    );
    expect(result.timedOut).toBe(true);
  });
});
