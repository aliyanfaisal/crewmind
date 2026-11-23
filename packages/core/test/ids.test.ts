import { describe, expect, it } from 'vitest';
import { isId, newId } from '../src/ids.js';

describe('ids', () => {
  it('creates valid ULIDs', () => {
    const id = newId();
    expect(id).toHaveLength(26);
    expect(isId(id)).toBe(true);
  });

  it('ids created in the same millisecond still sort in creation order', () => {
    const t = 1_700_000_000_000;
    const ids = Array.from({ length: 50 }, () => newId(t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('rejects non-ULIDs', () => {
    expect(isId('not-an-id')).toBe(false);
    expect(isId('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false); // contains I
    expect(isId(42)).toBe(false);
  });
});
