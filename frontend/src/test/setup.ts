import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom implements <dialog> without showModal/close; emulate the open state and the close event.
if (typeof HTMLDialogElement !== 'undefined') {
  const proto = HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      if (this.open) throw new DOMException('Already open', 'InvalidStateError');
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      if (!this.open) return;
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
}

// Node >= 25 ships a built-in Web Storage global that can shadow jsdom's (undefined without --localstorage-file).
// Prefer jsdom's own storage; fall back to a small in-memory Storage so tests do not depend on the Node version.
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => (data.has(String(k)) ? (data.get(String(k)) as string) : null),
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => void data.delete(String(k)),
    setItem: (k, v) => void data.set(String(k), String(v)),
  };
}

function works(read: () => Storage | undefined): boolean {
  try {
    const s = read();
    return !!s && typeof s.clear === 'function' && typeof s.getItem === 'function';
  } catch {
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  if (works(() => globalThis[name])) continue;
  const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window;
  const storage = works(() => jsdomWindow?.[name]) ? (jsdomWindow?.[name] as Storage) : memoryStorage();
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  if (typeof window !== 'undefined') Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
}
