import { describe, it, expect } from 'vitest';
import { renderPrompt, appendRetryContext } from './render.js';
import type { Issue } from '@symphony/shared';

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
};

describe('renderPrompt', () => {
  it('substitutes simple fields', () => {
    expect(renderPrompt('Hello {{identifier}}: {{title}}', ISSUE)).toBe('Hello ENG-42: Fix the bug');
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
      attemptNumber: 2,
      priorErrorClass: 'tool_failure',
      priorErrorMessage: 'tests failed',
      recentEvents: [
        { kind: 'status', payload: { message: 'Reading files' }, created_at: '2026-01-01' },
        { kind: 'tool_call', payload: { tool: 'bash' }, created_at: '2026-01-01' },
      ],
    });
    expect(out).toContain('original prompt');
    expect(out).toContain('Prior attempt context (this is attempt 2)');
    expect(out).toContain('tool_failure');
    expect(out).toContain('tests failed');
    expect(out).toContain('[status] Reading files');
    expect(out).toContain('[tool_call] tool=bash');
  });

  it('omits error line when no prior error info', () => {
    const out = appendRetryContext('p', {
      attemptNumber: 2,
      priorErrorClass: null,
      priorErrorMessage: null,
      recentEvents: [],
    });
    expect(out).not.toContain('Last attempt failed');
  });
});
