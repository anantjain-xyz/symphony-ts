import { describe, it, expect } from 'vitest';
import { backoffMs } from './backoff.js';

describe('backoffMs', () => {
  it('attempt 1 with deterministic rng=0.5 (zero jitter) returns base', () => {
    expect(backoffMs(1, 300_000, 5000, () => 0.5)).toBe(5000);
  });

  it('doubles each attempt up to maxMs', () => {
    const norand = () => 0.5;
    expect(backoffMs(1, 300_000, 5000, norand)).toBe(5000);
    expect(backoffMs(2, 300_000, 5000, norand)).toBe(10_000);
    expect(backoffMs(3, 300_000, 5000, norand)).toBe(20_000);
    expect(backoffMs(4, 300_000, 5000, norand)).toBe(40_000);
    expect(backoffMs(7, 300_000, 5000, norand)).toBe(300_000); // capped
    expect(backoffMs(20, 300_000, 5000, norand)).toBe(300_000); // still capped
  });

  it('applies +/-20% jitter band', () => {
    const lo = backoffMs(2, 300_000, 5000, () => 0); // -20%
    const hi = backoffMs(2, 300_000, 5000, () => 1); // +20%
    expect(lo).toBe(8000);
    expect(hi).toBe(12_000);
  });

  it('returns 0 for attempt < 1', () => {
    expect(backoffMs(0, 300_000)).toBe(0);
  });
});
