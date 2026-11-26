import { describe, expect, it } from 'vitest';
import { MAX_TIMER_MS, renewalDelayMs, tokenExpiryMs } from './jwt';

const b64url = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = (payload: unknown) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

describe('tokenExpiryMs', () => {
  it('returns exp in milliseconds', () => {
    expect(tokenExpiryMs(token({ exp: 1700000000 }))).toBe(1700000000000);
  });
  it('decodes base64url payloads that need padding and url-safe characters', () => {
    expect(tokenExpiryMs(token({ exp: 5, name: '??>>~~' }))).toBe(5000);
  });
  it.each([
    ['no exp', token({ sub: 'x' })],
    ['string exp', token({ exp: '123' })],
    ['garbage', 'not-a-jwt'],
    ['bad base64', 'a.@@@.c'],
    ['bad json', `a.${btoa('nope')}.c`],
    ['empty', ''],
  ])('returns 0 for %s', (_name, t) => {
    expect(tokenExpiryMs(t)).toBe(0);
  });
});

describe('renewalDelayMs', () => {
  const now = 1_000_000;
  it('renews five minutes before expiry', () => {
    const exp = (now + 3_600_000) / 1000;
    expect(renewalDelayMs(token({ exp }), now)).toBe(3_600_000 - 300_000);
  });
  it('never goes negative', () => {
    expect(renewalDelayMs(token({ exp: (now + 1000) / 1000 }), now)).toBe(0);
    expect(renewalDelayMs(token({ exp: 1 }), now)).toBe(0);
  });
  it('caps at the largest setTimeout delay', () => {
    expect(renewalDelayMs(token({ exp: 4_102_444_800 }), 0)).toBe(MAX_TIMER_MS);
  });
  it('is null without an expiry', () => {
    expect(renewalDelayMs(token({}), now)).toBeNull();
  });
});
