import { expect, test as base, type Page } from '@playwright/test';
import { FakeGoogle } from './fakeGoogle';
import { FakeStreams } from './fakeStreams';
import { ALICE, MockApi, type Me } from './mockApi';
import { fakeIdToken, type FakeTokenOptions } from './token';

/** Fixed fake time for specs that drive timers with page.clock. */
export const T0 = Date.parse('2030-06-01T12:00:00Z');

export class App {
  /** The ID token of the last signIn(). */
  token = '';

  constructor(
    readonly page: Page,
    readonly api: MockApi,
    readonly google: FakeGoogle,
  ) {}

  /** Loads the app and waits until it has booted far enough to show the Login button. */
  async open(): Promise<void> {
    await this.page.goto('/');
    await expect(this.page.locator('#login')).toBeVisible();
  }

  /**
   * Like open(), but with page.clock installed at T0 and then stopped, so the spec moves time with
   * page.clock.runFor(). Only specs about timers (retries, ban countdown) should use it.
   */
  async openWithClock(): Promise<void> {
    await this.page.clock.install({ time: T0 });
    await this.open();
    await this.page.clock.pauseAt(T0 + 1000);
  }

  /** Google delivers a credential and the backend knows the user as `me` (ALICE merged with the overrides). */
  async signIn(me: Partial<Me> = {}, token: FakeTokenOptions = {}): Promise<string> {
    await this.deliverCredential(me, token);
    await expect(this.page.locator('#me')).toBeVisible();
    return this.token;
  }

  /** Like signIn() without waiting for the signed-in UI, for flows where the session ends again at once. */
  async deliverCredential(me: Partial<Me> = {}, token: FakeTokenOptions = {}): Promise<void> {
    this.api.me = { ...ALICE, ...me };
    this.token = fakeIdToken(token);
    await this.google.deliver(this.token);
  }

  /** Types into the composer and submits with the Send button. */
  async send(text: string): Promise<void> {
    await this.page.locator('#text').fill(text);
    await this.page.locator('#send').click();
  }
}

interface Fixtures {
  api: MockApi;
  google: FakeGoogle;
  streams: FakeStreams;
  app: App;
  /** Option: false leaves fetch alone so a spec can serve the stream through page.route. */
  fakeStreams: boolean;
  /** Fails the test on console errors, uncaught exceptions and CSP violations. */
  noBrowserErrors: void;
}

export const test = base.extend<Fixtures>({
  fakeStreams: [true, { option: true }],

  api: async ({ page }, use) => {
    const api = new MockApi(page);
    await api.install();
    await use(api);
    expect(api.unhandled, 'every /api request must be answered by the mock').toEqual([]);
  },
  google: async ({ page }, use) => {
    const google = new FakeGoogle(page);
    await google.install();
    await use(google);
  },
  streams: async ({ page, fakeStreams }, use) => {
    const streams = new FakeStreams(page, fakeStreams);
    await streams.install();
    await use(streams);
  },
  app: async ({ page, api, google, streams }, use) => {
    await use(new App(page, api, google));
  },

  noBrowserErrors: [
    async ({ page, google, api, streams }, use) => {
      void api; // requested so the mock backend and stream shim are installed in every test
      void streams;
      const problems: string[] = [];
      // A CSP violation is only reported as an event; surface it as a console error that the listener below sees.
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`);
        });
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const url = msg.location().url;
        // Chromium logs every 4xx/5xx or aborted response as a console error. The specs answer /api calls with
        // error statuses and network failures on purpose, so only those requests are exempt.
        if (/^Failed to load resource/.test(msg.text()) && url.includes('/api/')) return;
        // A blocked Google script (scenario "GSI aborted") logs the same for its own URL, and only then.
        if (google.blocked && /^Failed to load resource/.test(msg.text()) && url.includes('accounts.google.com/gsi/client')) return;
        problems.push(`console.error: ${msg.text()} (${url})`);
      });
      page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
      await use();
      expect(problems, 'browser errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
