import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceManager, sanitizeKey } from './manager.js';

describe('sanitizeKey', () => {
  it.each([
    ['ENG-42', 'ENG-42'],
    ['ENG/42', 'ENG_42'],
    ['../escape', '___escape'],
    ['foo bar', 'foo_bar'],
    ['..', '_'],
    ['.', '_'],
    ['', '_'],
    ['name with $weird @chars', 'name_with__weird__chars'],
  ])('%s -> %s', (input, expected) => {
    expect(sanitizeKey(input)).toBe(expected);
  });
});

describe('WorkspaceManager', () => {
  let root: string;
  let mgr: WorkspaceManager;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'symphony-ws-test-'));
    mgr = new WorkspaceManager(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('createOrReuse creates the directory on first call', async () => {
    const ws = await mgr.createOrReuse('ENG-42');
    expect(ws.createdNow).toBe(true);
    expect(ws.path).toBe(path.join(root, 'ENG-42'));
    expect(ws.key).toBe('ENG-42');
  });

  it('createOrReuse reuses existing directory across retries', async () => {
    await mgr.createOrReuse('ENG-42');
    await writeFile(path.join(root, 'ENG-42', 'state.txt'), 'preserved');
    const second = await mgr.createOrReuse('ENG-42');
    expect(second.createdNow).toBe(false);
    expect(await readFile(path.join(second.path, 'state.txt'), 'utf8')).toBe('preserved');
  });

  it('remove deletes the directory', async () => {
    const ws = await mgr.createOrReuse('ENG-99');
    await mgr.remove('ENG-99');
    await expect(readFile(path.join(ws.path, 'anything'))).rejects.toThrow();
  });

  it('pathFor never returns a path outside the root (even via crafted keys)', () => {
    expect(mgr.pathFor('ENG-1').startsWith(root)).toBe(true);
    expect(mgr.pathFor('../escape').startsWith(root)).toBe(true);
    expect(mgr.pathFor('/abs').startsWith(root)).toBe(true);
  });
});
