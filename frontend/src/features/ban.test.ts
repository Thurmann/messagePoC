import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { banBannerText, composerView } from '../core/selectors';
import { reply } from '../test/fakes';
import { createHarness, meResponse, type Harness } from '../test/harness';

const NOW = new Date('2025-03-01T12:00:00Z');
let h: Harness;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  h = createHarness();
});
afterEach(() => {
  vi.useRealTimers();
});

const inSeconds = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
const ban = (s: number) => ({ until: inSeconds(s), remainingSeconds: s });

describe('ban countdown (N2, N3, M3)', () => {
  it('N2 shows the banner with the remaining time and ticks every second', async () => {
    await h.bootSignedIn(meResponse({ ban: ban(65) }));
    expect(banBannerText(h.state())).toBe('You are temporarily banned from posting. Time remaining: 1m 5s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(banBannerText(h.state())).toBe('You are temporarily banned from posting. Time remaining: 1m 4s');
    await vi.advanceTimersByTimeAsync(4000);
    expect(banBannerText(h.state())).toContain('Time remaining: 1m 0s');
  });

  it('disables the composer with the banned placeholder while banned', async () => {
    await h.bootSignedIn(meResponse({ ban: ban(30) }));
    expect(composerView(h.state())).toEqual({ disabled: true, placeholder: 'You are temporarily banned' });
  });

  it('N3 on expiry hides the banner, clears me.ban and re-enables the composer', async () => {
    await h.bootSignedIn(meResponse({ ban: ban(3) }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.state().ban).toBeNull();
    expect(h.state().auth.me?.ban).toBeNull();
    expect(composerView(h.state())).toEqual({ disabled: false, placeholder: 'Write a message' });
    const timers = vi.getTimerCount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(banBannerText(h.state())).toBeNull();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers);
  });

  it('N2 falls back to now + remainingSeconds when until is missing or invalid', async () => {
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => reply(200, { ban: { until: 'garbage', remainingSeconds: 30 } }));
    await h.bootSignedIn();
    expect(h.state().ban).toEqual({ until: NOW.getTime() + 30_000, label: '30s' });
  });

  it('a ban that already ended never shows', async () => {
    await h.bootSignedIn(meResponse({ ban: { until: inSeconds(-5), remainingSeconds: 0 } }));
    expect(h.state().ban).toBeNull();
    expect(composerView(h.state()).disabled).toBe(false);
  });

  it('is cleared by sign-out', async () => {
    await h.bootSignedIn(meResponse({ ban: ban(60) }));
    h.app.actions.signOut();
    expect(h.state().ban).toBeNull();
  });

  it('restarting a ban replaces the previous countdown', async () => {
    await h.bootSignedIn(meResponse({ ban: ban(60) }));
    h.deps.fakeFetch.on('POST', '/api/me/presence', () => reply(200, { ban: ban(10) }));
    h.app.actions.pageShow(true);
    await h.flush();
    expect(h.state().ban?.label).toBe('10s');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(h.state().ban).toBeNull();
  });
});
