import type { Page } from '@playwright/test';

export type PromptMode = 'notDisplayed' | 'skipped' | 'throw' | 'hang' | 'credential';

export interface GoogleState {
  initCalls: Array<{ client_id?: string; auto_select?: boolean }>;
  renderCalls: number;
  prompts: number;
  disableAutoSelect: number;
}

// Served in place of https://accounts.google.com/gsi/client, so window.google exists only once the app has
// loaded the script (like the real library) and a blocked script leaves it undefined.
const GSI_SCRIPT = `
(function () {
  var s = window.__gsi;
  window.google = { accounts: { id: {
    initialize: function (cfg) { s.callback = cfg.callback; s.initCalls.push({ client_id: cfg.client_id, auto_select: cfg.auto_select }); },
    renderButton: function (el) {
      s.renderCalls++;
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-testid', 'fake-gsi');
      b.textContent = 'Sign in with Google';
      b.addEventListener('click', function () { s.callback({ credential: s.nextCredential }); });
      el.appendChild(b);
    },
    prompt: function (cb) {
      s.prompts++;
      if (s.promptMode === 'throw') throw new Error('prompt failed');
      if (s.promptMode === 'notDisplayed') cb({ isNotDisplayed: function () { return true; }, isSkippedMoment: function () { return false; } });
      else if (s.promptMode === 'skipped') cb({ isNotDisplayed: function () { return false; }, isSkippedMoment: function () { return true; } });
      else if (s.promptMode === 'credential') setTimeout(function () { s.callback({ credential: s.renewCredential }); }, 0);
    },
    disableAutoSelect: function () { s.disableAutoSelect++; },
  } } };
})();
`;

export class FakeGoogle {
  /** When true the GSI script request fails, as with a blocker or no network. */
  blocked = false;

  constructor(private readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__gsi = {
        callback: null,
        initCalls: [],
        renderCalls: 0,
        prompts: 0,
        disableAutoSelect: 0,
        promptMode: 'notDisplayed',
        nextCredential: undefined,
        renewCredential: undefined,
      };
    });
    await this.page.route('https://accounts.google.com/gsi/client', (route) => {
      if (this.blocked) return route.abort('failed');
      return route.fulfill({ contentType: 'application/javascript', body: GSI_SCRIPT });
    });
  }

  /** How the silent-renewal prompt behaves. 'credential' delivers `credential` to the sign-in callback. */
  async setPrompt(mode: PromptMode, credential?: string): Promise<void> {
    await this.page.evaluate(
      ([m, c]) => {
        const s = (window as unknown as { __gsi: Record<string, unknown> }).__gsi;
        s.promptMode = m;
        s.renewCredential = c;
      },
      [mode, credential] as const,
    );
  }

  /** The credential Google hands over, as after auto-select. */
  async deliver(credential: string): Promise<void> {
    await this.page.evaluate((c) => {
      (window as unknown as { __gsi: { callback: (r: unknown) => void } }).__gsi.callback({ credential: c });
    }, credential);
  }

  /** Clicks the rendered Google button, which then delivers `credential`. */
  async clickButton(credential: string): Promise<void> {
    await this.page.evaluate((c) => {
      (window as unknown as { __gsi: Record<string, unknown> }).__gsi.nextCredential = c;
    }, credential);
    await this.page.getByTestId('fake-gsi').click();
  }

  async state(): Promise<GoogleState> {
    return this.page.evaluate(() => {
      const s = (window as unknown as { __gsi: GoogleState }).__gsi;
      return {
        initCalls: s.initCalls,
        renderCalls: s.renderCalls,
        prompts: s.prompts,
        disableAutoSelect: s.disableAutoSelect,
      };
    });
  }
}
