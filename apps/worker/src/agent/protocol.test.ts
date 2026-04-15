import { describe, it, expect } from 'vitest';
import { NdjsonParser, encodeRequest, isResult, isError, isNotification } from './protocol.js';

describe('NdjsonParser', () => {
  it('parses one message per line', () => {
    const p = new NdjsonParser();
    const out = p.push('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","method":"x","params":{}}\n');
    expect(out).toHaveLength(2);
    expect(isResult(out[0]!)).toBe(true);
    expect(isNotification(out[1]!)).toBe(true);
  });

  it('handles split chunks across newlines', () => {
    const p = new NdjsonParser();
    expect(p.push('{"jsonrpc":"2.0",')).toEqual([]);
    expect(p.push('"id":1,"result":{}}\n')).toHaveLength(1);
  });

  it('handles multiple newlines in one chunk', () => {
    const p = new NdjsonParser();
    const out = p.push('{"jsonrpc":"2.0","id":1,"result":1}\n\n{"jsonrpc":"2.0","id":2,"result":2}\n');
    expect(out).toHaveLength(2);
  });

  it('flush returns trailing line without newline', () => {
    const p = new NdjsonParser();
    p.push('{"jsonrpc":"2.0","id":1,"result":1}');
    expect(p.push('')).toEqual([]);
    const tail = p.flush();
    expect(tail).toHaveLength(1);
  });
});

describe('encodeRequest', () => {
  it('produces a single JSON line ending in \\n', () => {
    const line = encodeRequest(7, 'test', { x: 1 });
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ jsonrpc: '2.0', id: 7, method: 'test', params: { x: 1 } });
  });
});

describe('type guards', () => {
  it('discriminate result/error/notification', () => {
    expect(isResult({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true);
    expect(isError({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'm' } })).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', method: 'x', params: {} })).toBe(true);
    expect(isResult({ jsonrpc: '2.0', method: 'x', params: {} })).toBe(false);
  });
});
