import { describe, it, expect } from 'vitest';
import { selectDispatchable } from './concurrency.js';
import type { Issue } from '@symphony/shared';

function mk(id: string, state: string, priority = 2): Issue {
  return {
    id,
    identifier: id,
    title: 't',
    description: null,
    priority,
    state,
    branch: null,
    labels: [],
    blockers: [],
  };
}

describe('selectDispatchable', () => {
  it('respects global cap; preserves input order', () => {
    const eligible = [mk('a', 'todo'), mk('b', 'todo'), mk('c', 'todo')];
    expect(selectDispatchable(eligible, new Map(), 0, 2, {})).toEqual([eligible[0], eligible[1]]);
  });

  it('skips issues whose state cap is full but lets others through', () => {
    const eligible = [mk('a', 'todo'), mk('b', 'todo'), mk('c', 'in progress')];
    const out = selectDispatchable(eligible, new Map([['todo', 1]]), 1, 5, { todo: 1 });
    // todo cap (1) already used -> a and b skipped; c gets through.
    expect(out.map((i) => i.id)).toEqual(['c']);
  });

  it('global cap caps total even with available per-state slots', () => {
    const eligible = [mk('a', 'todo'), mk('b', 'in progress')];
    expect(selectDispatchable(eligible, new Map(), 5, 5, {}).length).toBe(0);
  });

  it('per-state cap does not affect states without an entry', () => {
    const eligible = [mk('a', 'todo'), mk('b', 'in progress'), mk('c', 'in progress')];
    const out = selectDispatchable(eligible, new Map(), 0, 10, { todo: 1 });
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
