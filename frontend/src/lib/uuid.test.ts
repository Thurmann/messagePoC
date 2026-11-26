import { describe, expect, it, vi } from 'vitest';
import { newMessageId } from './uuid';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newMessageId', () => {
  it('prefers crypto.randomUUID', () => {
    expect(newMessageId({ randomUUID: () => 'fixed-id' })).toBe('fixed-id');
  });
  it('builds a v4 UUID from getRandomValues when randomUUID is missing', () => {
    const getRandomValues = vi.fn((a: Uint8Array) => a.fill(0xff));
    const id = newMessageId({ getRandomValues });
    expect(id).toMatch(V4);
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });
  it('falls back to Math.random without crypto', () => {
    expect(newMessageId(null, () => 0)).toBe('00000000-0000-4000-8000-000000000000');
    expect(newMessageId(null, () => 0.999)).toMatch(V4);
  });
  it('produces distinct ids', () => {
    expect(newMessageId(null)).not.toBe(newMessageId(null));
  });
});
