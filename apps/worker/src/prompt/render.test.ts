import type { Issue } from '@symphony/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  appendRetryContext,
  buildRetryContext,
  renderPrompt,
  type RetryContextRepo,
} from './render.js';

const ISSUE: Issue = {
  id: 'uuid',
  identifier: 'ENG-42',
  title: 'Fix the bug',
  description: 'Repro steps:\n1. ...',
  priority: 1,
  state: 'todo',
  branch: null,
  labels: ['backend', 'bug'],
  blockers: ['ENG-40', 'ENG-41'],
  pr_urls: [],
};

describe('renderPrompt', () => {
  it('substitutes simple fields', () => {
    expect(renderPrompt('Hello {{identifier}}: {{title}}', ISSUE)).toBe(
      'Hello ENG-42: Fix the bug',
    );
  });

  it('renders truthy section', () => {
    const t = '{{#description}}DESC: {{description}}{{/description}}';
    expect(renderPrompt(t, ISSUE)).toBe('DESC: Repro steps:\n1. ...');
  });

  it('omits falsy section', () => {
    const t = '{{#branch}}branch={{branch}}{{/branch}}done';
    expect(renderPrompt(t, ISSUE)).toBe('done');
  });

  it('iterates over array sections with {{.}}', () => {
    const t = '{{#blockers}}- {{.}}\n{{/blockers}}';
    expect(renderPrompt(t, ISSUE)).toBe('- ENG-40\n- ENG-41\n');
  });

  it('omits empty array sections via .length guard', () => {
    const noBlockers = { ...ISSUE, blockers: [] };
    const t = 'A{{#blockers.length}}has blockers{{/blockers.length}}B';
    expect(renderPrompt(t, ISSUE)).toBe('Ahas blockersB');
    expect(renderPrompt(t, noBlockers)).toBe('AB');
  });

  it('leaves unknown fields as empty', () => {
    expect(renderPrompt('x={{nope}}', ISSUE)).toBe('x=');
  });

  it('handles consecutive sections', () => {
    const t = '{{#description}}D{{/description}}{{#blockers.length}}B{{/blockers.length}}';
    expect(renderPrompt(t, ISSUE)).toBe('DB');
  });
});

describe('appendRetryContext', () => {
  it('appends prior error and recent events', () => {
    const out = appendRetryContext('original prompt', {
      runNumber: 2,
      priorErrorClass: 'tool_failure',
      priorErrorMessage: 'tests failed',
      recentEvents: [
        { kind: 'status', payload: { message: 'Reading files' }, created_at: '2026-01-01' },
        { kind: 'tool_call', payload: { tool: 'bash' }, created_at: '2026-01-01' },
      ],
    });
    expect(out).toContain('original prompt');
    expect(out).toContain('Prior run context (this is run 2)');
    expect(out).toContain('tool_failure');
    expect(out).toContain('tests failed');
    expect(out).toContain('[status] Reading files');
    expect(out).toContain('[tool_call] tool=bash');
  });

  it('omits error line when no prior error info', () => {
    const out = appendRetryContext('p', {
      runNumber: 2,
      priorErrorClass: null,
      priorErrorMessage: null,
      recentEvents: [],
    });
    expect(out).not.toContain('Previous run failed');
  });
});

describe('buildRetryContext', () => {
  it('returns null on the first run (no trailer to append)', async () => {
    const repo: RetryContextRepo = {
      priorRun: vi.fn(),
      recentEventsForIssue: vi.fn(),
    };
    const ctx = await buildRetryContext(repo, 'issue-1', { id: 'a1', run_number: 1 });
    expect(ctx).toBeNull();
    expect(repo.priorRun).not.toHaveBeenCalled();
    expect(repo.recentEventsForIssue).not.toHaveBeenCalled();
  });

  it('pulls events from prior runs and renders them in the trailer', async () => {
    const events = [
      {
        kind: 'status',
        payload: { message: 'Reading repo.ts' },
        created_at: '2026-01-01T00:00:01Z',
      },
      { kind: 'tool_call', payload: { tool: 'bash' }, created_at: '2026-01-01T00:00:02Z' },
      { kind: 'status', payload: { message: 'Running tests' }, created_at: '2026-01-01T00:00:03Z' },
    ];
    const repo: RetryContextRepo = {
      priorRun: vi.fn().mockResolvedValue({
        error_class: 'tool_failure',
        error_message: 'tests failed',
      }),
      recentEventsForIssue: vi.fn().mockResolvedValue(events),
    };

    const ctx = await buildRetryContext(repo, 'issue-1', { id: 'a2', run_number: 2 });
    expect(ctx).not.toBeNull();
    expect(repo.recentEventsForIssue).toHaveBeenCalledWith('issue-1', 'a2', 10);
    expect(repo.priorRun).toHaveBeenCalledWith('issue-1', 'a2');

    const out = appendRetryContext('original prompt', ctx!);
    expect(out).toContain('Prior run context (this is run 2)');
    expect(out).toContain('[status] Reading repo.ts');
    expect(out).toContain('[tool_call] tool=bash');
    expect(out).toContain('[status] Running tests');
  });

  it('uses the prior run row for priorErrorClass/priorErrorMessage, not the current run', async () => {
    const repo: RetryContextRepo = {
      priorRun: vi.fn().mockResolvedValue({
        error_class: 'turn_timeout',
        error_message: 'agent took too long',
      }),
      recentEventsForIssue: vi.fn().mockResolvedValue([]),
    };

    const ctx = await buildRetryContext(repo, 'issue-1', { id: 'a3', run_number: 3 });
    expect(ctx?.priorErrorClass).toBe('turn_timeout');
    expect(ctx?.priorErrorMessage).toBe('agent took too long');

    const out = appendRetryContext('p', ctx!);
    expect(out).toContain('Previous run failed');
    expect(out).toContain('turn_timeout');
    expect(out).toContain('agent took too long');
  });

  it('falls back to null error fields when no prior run is found', async () => {
    const repo: RetryContextRepo = {
      priorRun: vi.fn().mockResolvedValue(null),
      recentEventsForIssue: vi.fn().mockResolvedValue([]),
    };
    const ctx = await buildRetryContext(repo, 'issue-1', { id: 'a2', run_number: 2 });
    expect(ctx?.priorErrorClass).toBeNull();
    expect(ctx?.priorErrorMessage).toBeNull();
  });
});
