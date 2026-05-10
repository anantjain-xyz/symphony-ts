import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFirstLine } from './session-log.js';

describe('readFirstLine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'session-log-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the first line of a multi-line file', async () => {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, '{"cwd":"/work"}\n{"x":1}\n{"y":2}\n');
    expect(await readFirstLine(file)).toBe('{"cwd":"/work"}');
  });

  it('returns the only line when the file lacks a trailing newline', async () => {
    const file = path.join(dir, 'one.jsonl');
    await writeFile(file, '{"cwd":"/work"}');
    expect(await readFirstLine(file)).toBe('{"cwd":"/work"}');
  });

  it('returns null for an empty file', async () => {
    const file = path.join(dir, 'empty.jsonl');
    await writeFile(file, '');
    expect(await readFirstLine(file)).toBeNull();
  });

  it('reads only the first line of a multi-MB file in well under a second', async () => {
    const file = path.join(dir, 'big.jsonl');
    const head = '{"cwd":"/work","sessionId":"abc"}';
    const tail = 'x'.repeat(8 * 1024 * 1024);
    await writeFile(file, `${head}\n${tail}`);
    const start = process.hrtime.bigint();
    const result = await readFirstLine(file);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(result).toBe(head);
    expect(elapsedMs).toBeLessThan(500);
  });

  it('rejects when the file does not exist', async () => {
    await expect(readFirstLine(path.join(dir, 'missing.jsonl'))).rejects.toThrow();
  });
});
