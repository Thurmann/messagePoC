import { describe, expect, it } from 'vitest';
import { HANDLE_RE } from './handle';

describe('HANDLE_RE', () => {
  it.each(['abc', 'Alice_1', 'a'.repeat(20), '___', '123'])('accepts %s', (h) => {
    expect(HANDLE_RE.test(h)).toBe(true);
  });
  it.each(['', 'ab', 'a'.repeat(21), 'has space', 'ål', 'a-b', 'abc\n', ' abc'])('rejects %j', (h) => {
    expect(HANDLE_RE.test(h)).toBe(false);
  });
});
