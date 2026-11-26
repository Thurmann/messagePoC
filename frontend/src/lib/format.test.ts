import { describe, expect, it } from 'vitest';
import { banText, colorClass, fmtDateTime, fmtRemaining, fmtTime, truncate } from './format';

describe('colorClass', () => {
  it('is stable and within c0..c7', () => {
    for (const h of ['alice', 'bob', 'x', 'user_12345678901234567']) {
      expect(colorClass(h)).toBe(colorClass(h));
      expect(colorClass(h)).toMatch(/^c[0-7]$/);
    }
  });
  it('matches the 31-multiplier hash of the legacy app', () => {
    // 'a' = 97 -> 97 % 8 = 1; 'ab' = 97*31+98 = 3105 -> 3105 % 8 = 1; 'abc' = 3105*31+99 = 96354 -> 2
    expect(colorClass('a')).toBe('c1');
    expect(colorClass('ab')).toBe('c1');
    expect(colorClass('abc')).toBe('c2');
  });
  it('treats missing handles as the empty string', () => {
    expect(colorClass(null)).toBe('c0');
    expect(colorClass(undefined)).toBe('c0');
    expect(colorClass('')).toBe('c0');
  });
  it('stays unsigned for long handles', () => {
    expect(colorClass('z'.repeat(200))).toMatch(/^c[0-7]$/);
  });
});

describe('fmtRemaining', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [7, '7s'],
    [59.2, '1m 0s'], // ceil -> 60 s, which is a full minute,
    [60, '1m 0s'],
    [120, '2m 0s'],
    [3605, '1h 0m 5s'],
    [3600, '1h 0m 0s'],
    [3725, '1h 2m 5s'],
  ])('%s -> %s', (seconds, expected) => {
    expect(fmtRemaining(seconds)).toBe(expected);
  });
});

describe('truncate', () => {
  it('keeps strings up to the limit', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });
  it('cuts and appends an ellipsis beyond the limit', () => {
    expect(truncate('abcdef', 5)).toBe('abcde…');
  });
  it('maps null and undefined to empty', () => {
    expect(truncate(null, 5)).toBe('');
    expect(truncate(undefined, 5)).toBe('');
  });
});

describe('date formatting', () => {
  it('formats valid ISO strings like the browser locale does', () => {
    const iso = '2025-03-04T05:06:07Z';
    expect(fmtTime(iso)).toBe(
      new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    );
    expect(fmtDateTime(iso)).toBe(new Date(iso).toLocaleString());
  });
  it('returns an empty string for invalid input', () => {
    expect(fmtTime('nope')).toBe('');
    expect(fmtDateTime('nope')).toBe('');
    expect(fmtTime('')).toBe('');
  });
});

describe('banText', () => {
  it('is empty without a ban state', () => {
    expect(banText({})).toBe('');
    expect(banText({ banState: null })).toBe('');
  });
  it('prefixes the formatted date', () => {
    const until = '2025-03-04T05:06:07Z';
    expect(banText({ banState: { until } })).toBe(`banned until ${fmtDateTime(until)}`);
  });
  it('degrades to the bare prefix for an invalid date', () => {
    expect(banText({ banState: { until: 'x' } })).toBe('banned until ');
  });
});
