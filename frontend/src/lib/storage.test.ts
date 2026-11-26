import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '../test/fakes';
import { safeGet, safeRemove, safeSet, TOKEN_KEY, type StorageLike } from './storage';

const throwing: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('storage helpers', () => {
  it('uses idToken as the session key', () => {
    expect(TOKEN_KEY).toBe('idToken');
  });
  it('reads, writes and removes values', () => {
    const s = createMemoryStorage();
    expect(safeGet(s, 'k')).toBeNull();
    safeSet(s, 'k', 'v');
    expect(safeGet(s, 'k')).toBe('v');
    safeRemove(s, 'k');
    expect(safeGet(s, 'k')).toBeNull();
  });
  it('swallows storage errors', () => {
    expect(safeGet(throwing, 'k')).toBeNull();
    expect(() => safeSet(throwing, 'k', 'v')).not.toThrow();
    expect(() => safeRemove(throwing, 'k')).not.toThrow();
  });
});
