import { createContext, useContext, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { Actions, App } from '../core/app';
import type { AppState } from '../core/state';

const AppCtx = createContext<App | null>(null);

export function AppProvider({ app, children }: { app: App; children: ReactNode }) {
  return <AppCtx.Provider value={app}>{children}</AppCtx.Provider>;
}

function useApp(): App {
  const app = useContext(AppCtx);
  if (!app) throw new Error('AppProvider is missing');
  return app;
}

export function useActions(): Actions {
  return useApp().actions;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Subscribes to the part of the state the selector returns. Selectors may build new objects: the result is
 * structurally compared with the previous one so an unchanged view keeps its reference (no loops, no re-render).
 */
export function useAppState<T>(selector: (state: AppState) => T): T {
  const { store } = useApp();
  const last = useRef<{ state: AppState; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    const prev = last.current;
    if (prev && prev.state === state) return prev.value;
    const value = selector(state);
    const keep = prev && deepEqual(prev.value, value) ? prev.value : value;
    last.current = { state, value: keep };
    return keep;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
