import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './retry';

const withHeader = (value?: string) => ({
  headers: new Headers(value === undefined ? {} : { 'Retry-After': value }),
});

describe('retryDelayMs', () => {
  it.each([
    [undefined, 5000],
    ['1', 3000],
    ['3', 3000],
    ['10', 10000],
    ['30', 30000],
    ['99', 30000],
    ['0', 3000],
    ['-4', 3000],
    ['abc', 5000],
    ['', 5000],
    ['7.9', 7000],
  ])('Retry-After %s -> %d ms', (header, expected) => {
    expect(retryDelayMs(withHeader(header))).toBe(expected);
  });
  it('defaults to 5s without a response or headers', () => {
    expect(retryDelayMs(null)).toBe(5000);
    expect(retryDelayMs(undefined)).toBe(5000);
    expect(retryDelayMs({})).toBe(5000);
  });
});
