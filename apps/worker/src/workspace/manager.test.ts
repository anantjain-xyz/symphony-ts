import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeKey, WORKSPACE_READY_SENTINEL, WorkspaceManager } from './manager.js';

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
    expect(ws.needsInit).toBe(true);
    expect(ws.path).toBe(path.join(root, 'ENG-42'));
    expect(ws.key).toBe('ENG-42');
  });

  it('createOrReuse reuses a ready workspace without wiping contents', async () => {
    const first = await mgr.createOrReuse('ENG-42');
    await writeFile(path.join(first.path, 'state.txt'), 'preserved');
    await mgr.markReady('ENG-42');
    const second = await mgr.createOrReuse('ENG-42');
    expect(second.createdNow).toBe(false);
    expect(second.needsInit).toBe(false);
    expect(await readFile(path.join(second.path, 'state.txt'), 'utf8')).toBe('preserved');
  });

  it('createOrReuse wipes an existing directory that is missing the ready sentinel', async () => {
    const first = await mgr.createOrReuse('ENG-42');
    await writeFile(path.join(first.path, 'leftover.txt'), 'from-broken-init');
    // Note: no markReady() call — simulates a prior after_create that never completed.
    const second = await mgr.createOrReuse('ENG-42');
    expect(second.createdNow).toBe(false);
    expect(second.needsInit).toBe(true);
    await expect(readFile(path.join(second.path, 'leftover.txt'))).rejects.toThrow();
  });

  it('markReady writes the sentinel at the workspace root', async () => {
    const ws = await mgr.createOrReuse('ENG-42');
    await mgr.markReady('ENG-42');
    expect(await readFile(path.join(ws.path, WORKSPACE_READY_SENTINEL), 'utf8')).toBe('');
  });

  it('remove deletes the directory', async () => {
    const ws = await mgr.createOrReuse('ENG-99');
    await mgr.remove('ENG-99');
    await expect(readFile(path.join(ws.path, 'anything'))).rejects.toThrow();
  });

  describe('removeIfStale', () => {
    it('removes a directory that is missing the ready sentinel', async () => {
      const ws = await mgr.createOrReuse('ENG-42');
      await writeFile(path.join(ws.path, 'half-clone'), 'partial');
      const removed = await mgr.removeIfStale(ws.path);
      expect(removed).toBe(true);
      await expect(readFile(path.join(ws.path, 'half-clone'))).rejects.toThrow();
    });

    it('preserves a directory that has the ready sentinel', async () => {
      const ws = await mgr.createOrReuse('ENG-42');
      await mgr.markReady('ENG-42');
      await writeFile(path.join(ws.path, 'state.txt'), 'preserved');
      const removed = await mgr.removeIfStale(ws.path);
      expect(removed).toBe(false);
      expect(await readFile(path.join(ws.path, 'state.txt'), 'utf8')).toBe('preserved');
    });

    it('is a no-op when the path does not exist', async () => {
      const removed = await mgr.removeIfStale(path.join(root, 'never-created'));
      expect(removed).toBe(false);
    });

    it('refuses to remove paths outside the workspace root', async () => {
      const outside = await mkdtemp(path.join(tmpdir(), 'symphony-outside-'));
      try {
        const removed = await mgr.removeIfStale(outside);
        expect(removed).toBe(false);
        // Outside path must still exist.
        await expect(readFile(path.join(outside, 'anything'))).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('refuses to remove the workspace root itself', async () => {
      const removed = await mgr.removeIfStale(root);
      expect(removed).toBe(false);
    });
  });

  it('pathFor never returns a path outside the root (even via crafted keys)', () => {
    expect(mgr.pathFor('ENG-1').startsWith(root)).toBe(true);
    expect(mgr.pathFor('../escape').startsWith(root)).toBe(true);
    expect(mgr.pathFor('/abs').startsWith(root)).toBe(true);
  });
});
