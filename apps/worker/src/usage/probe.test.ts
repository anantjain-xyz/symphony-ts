import { describe, expect, it } from 'vitest';
import { parseClaudeStatus, parseCodexStatus } from './probe.js';

describe('parseClaudeStatus', () => {
  it('extracts the smaller-remaining window across session and weekly', () => {
    const sample = [
      '──── Status ────',
      'Session usage: 47% (resets at 14:00)',
      'Weekly usage: 12% (resets in 5 days)',
    ].join('\n');
    const out = parseClaudeStatus(sample);
    expect(out).not.toBeNull();
    // Session is at 47% used = 53% remaining; weekly is 88% remaining. The
    // probe must surface the *more constrained* window — session.
    expect(out!.remainingPct).toBe(53);
  });

  it('respects "X% left" wording without inverting it', () => {
    const sample = 'Session: 8% left (resets at 21:00)';
    const out = parseClaudeStatus(sample);
    expect(out!.remainingPct).toBe(8);
  });

  it('returns null when no bucket lines are present', () => {
    expect(parseClaudeStatus('Welcome to Claude. Type /help for commands.')).toBeNull();
  });

  it('parses an ISO reset timestamp when one is rendered', () => {
    const sample = 'Session usage: 80% (resets at 2026-05-07T18:30:00Z)';
    const out = parseClaudeStatus(sample);
    expect(out!.resetAt?.toISOString()).toBe('2026-05-07T18:30:00.000Z');
  });
});

describe('parseCodexStatus', () => {
  it('reads the 5h and weekly buckets and picks the more constrained one', () => {
    const sample = ['Status', '5h limit:    61% used  (resets in 02:14)', 'Weekly limit: 18% used  (resets Mon)'].join(
      '\n',
    );
    const out = parseCodexStatus(sample);
    expect(out!.remainingPct).toBe(39); // 5h is 61% used = 39% remaining; weekly is 82%.
  });

  it('handles "resets in HH:MM" by adding the offset to now', () => {
    const before = Date.now();
    const out = parseCodexStatus('5h limit: 90% used (resets in 01:30)');
    const after = Date.now();
    const reset = out!.resetAt!.getTime();
    // Allow a 100ms window for the elapsed test time. 1h30m = 5_400_000ms.
    expect(reset).toBeGreaterThanOrEqual(before + 5_400_000);
    expect(reset).toBeLessThanOrEqual(after + 5_400_000 + 100);
  });

  it('returns null for an unrecognized panel', () => {
    expect(parseCodexStatus('codex 0.120.0 — type /help for commands')).toBeNull();
  });

  it('clamps obviously-bogus percent values out (only 0–100 accepted)', () => {
    // "999%" must not be parsed as a usage percent.
    const out = parseCodexStatus('5h limit: 999% used');
    expect(out).toBeNull();
  });
});
