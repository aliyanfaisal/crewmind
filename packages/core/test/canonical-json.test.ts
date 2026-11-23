import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalize } from '../src/canonical-json.js';

describe('canonicalize', () => {
  it('sorts keys so logically equal objects serialize identically', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it('keeps array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('omits undefined object values like JSON.stringify', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles unicode and escapes consistently', () => {
    expect(canonicalize({ k: 'héllo "q" \n ✓' })).toBe('{"k":"héllo \\"q\\" \\n ✓"}');
  });

  it('handles primitives and null', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(-0.5)).toBe('-0.5');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 1n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['undefined in array', [1, undefined]],
  ])('rejects %s instead of silently changing signed data', (_label, value) => {
    expect(() => canonicalize({ v: value })).toThrow(CanonicalJsonError);
  });

  it('accepts null-prototype objects', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.z = 1;
    o.a = 2;
    expect(canonicalize(o)).toBe('{"a":2,"z":1}');
  });
});
