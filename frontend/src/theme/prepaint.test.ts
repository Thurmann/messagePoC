import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function stubMatchMedia(dark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: dark && query.includes('dark') }));
}

async function run(): Promise<string | null> {
  vi.resetModules();
  // @ts-expect-error prepaint.ts is a classic script (no exports), so it is not a module for the type checker
  await import('./prepaint');
  return document.documentElement.getAttribute('data-theme');
}

describe('prepaint', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the saved theme', async () => {
    stubMatchMedia(false);
    localStorage.setItem('theme', 'dark');
    expect(await run()).toBe('dark');
  });

  it('saved light wins over a dark OS preference', async () => {
    stubMatchMedia(true);
    localStorage.setItem('theme', 'light');
    expect(await run()).toBe('light');
  });

  it('falls back to the OS preference', async () => {
    stubMatchMedia(true);
    expect(await run()).toBe('dark');
  });

  it('ignores an invalid saved value', async () => {
    stubMatchMedia(false);
    localStorage.setItem('theme', 'purple');
    expect(await run()).toBe('light');
  });

  it('survives unreadable storage', async () => {
    stubMatchMedia(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(await run()).toBe('dark');
  });

  it('does not wire up the toggle', async () => {
    document.body.innerHTML = '<button id="theme-toggle"></button>';
    stubMatchMedia(false);
    await run();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(document.getElementById('theme-toggle')?.hasAttribute('aria-pressed')).toBe(false);
    document.body.innerHTML = '';
  });
});
