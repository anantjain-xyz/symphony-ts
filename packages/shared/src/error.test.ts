import { describe, expect, it } from 'vitest';
import { formatError } from './error.js';

describe('formatError', () => {
  it('returns message for Error instances', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  it('returns stack for Error instances when includeStack is set', () => {
    const err = new Error('boom');
    const out = formatError(err, { includeStack: true });
    expect(out).toContain('boom');
    expect(out).toContain('at ');
  });

  it('falls back to message when includeStack is set but stack is missing', () => {
    const err = new Error('no-stack');
    err.stack = undefined;
    expect(formatError(err, { includeStack: true })).toBe('no-stack');
  });

  it('returns the string itself for string throws', () => {
    expect(formatError('plain string')).toBe('plain string');
  });

  it('extracts message from object-with-message', () => {
    expect(formatError({ message: 'broke' })).toBe('broke');
  });

  it('JSON-stringifies plain objects without a string message', () => {
    expect(formatError({ code: 42, detail: 'x' })).toBe('{"code":42,"detail":"x"}');
  });

  it('falls back to Object.prototype.toString for objects with circular refs', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(formatError(obj)).toBe('[object Object]');
  });

  it('ignores empty string message and JSON-stringifies the object', () => {
    expect(formatError({ message: '' })).toBe('{"message":""}');
  });

  it('ignores non-string message field', () => {
    expect(formatError({ message: 42 })).toBe('{"message":42}');
  });

  it('handles primitives via String()', () => {
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
    expect(formatError(undefined)).toBe('undefined');
    expect(formatError(true)).toBe('true');
  });
});
