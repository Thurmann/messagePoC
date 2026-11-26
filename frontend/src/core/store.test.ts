import { describe, expect, it, vi } from 'vitest';
import { createStore } from './store';

describe('createStore', () => {
  it('returns the initial state', () => {
    expect(createStore({ n: 1 }).get()).toEqual({ n: 1 });
  });

  it('applies updaters and notifies subscribers', () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((s) => ({ ...s, n: s.n + 1 }));
    expect(store.get()).toEqual({ n: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is immutable: previous snapshots are not mutated', () => {
    const store = createStore({ items: ['a'] });
    const before = store.get();
    store.set((s) => ({ items: [...s.items, 'b'] }));
    expect(before.items).toEqual(['a']);
    expect(store.get()).not.toBe(before);
  });

  it('does not notify when the updater returns the same reference', () => {
    const store = createStore({ n: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((s) => s);
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes, and unsubscribing twice is harmless', () => {
    const store = createStore(0);
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    off();
    store.set((n) => n + 1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('lets listeners read the new state and unsubscribe during notification', () => {
    const store = createStore(0);
    const calls: number[] = [];
    const off = store.subscribe(() => {
      calls.push(store.get());
      off();
    });
    const other = vi.fn();
    store.subscribe(other);
    store.set(() => 1);
    store.set(() => 2);
    expect(calls).toEqual([1]);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('supports several subscribers', () => {
    const store = createStore(0);
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.set(() => 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
