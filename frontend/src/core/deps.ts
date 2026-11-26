import type { FetchFn } from '../api/client';
import type { StorageLike } from '../lib/storage';
import { newMessageId } from '../lib/uuid';

/** The slice of Google Identity Services the app uses. */
export interface GoogleIdApi {
  initialize(config: { client_id: string; callback: (resp: { credential?: string }) => void; auto_select: boolean }): void;
  renderButton(parent: HTMLElement, options: { theme: string; size: string; type: string }): void;
  prompt(listener?: (notification: GoogleMomentNotification) => void): void;
  disableAutoSelect(): void;
}

export interface GoogleMomentNotification {
  isNotDisplayed?(): boolean;
  isSkippedMoment?(): boolean;
}

export interface Google {
  accounts?: { id?: GoogleIdApi };
}

/** Everything the app takes from the outside world, so tests can control time, network and Google. */
export interface Deps {
  fetch: FetchFn;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  session: StorageLike;
  confirm(message: string): boolean;
  getGoogle(): Google | undefined;
  loadScript(src: string): Promise<void>;
  randomUUID(): string;
}

// Globals are read at call time (and fetch is wrapped) so test stubs and polyfills are honoured
// and native functions are never invoked with the wrong `this`.
export const browserDeps: Deps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as number),
  session: {
    getItem: (key) => globalThis.sessionStorage.getItem(key),
    setItem: (key, value) => globalThis.sessionStorage.setItem(key, value),
    removeItem: (key) => globalThis.sessionStorage.removeItem(key),
  },
  confirm: (message) => globalThis.confirm(message),
  getGoogle: () => (globalThis as { google?: Google }).google,
  loadScript: (src) =>
    new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(script);
    }),
  randomUUID: () => newMessageId(),
};
