import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import type { AdminModerationRow, MeResponse } from '../api/types';
import type { Actions, App } from '../core/app';
import { initialState, type AppState, type ModerationEntry } from '../core/state';
import { createStore } from '../core/store';
import { meResponse } from '../test/harness';
import { AppProvider } from './AppContext';

export type MockActions = { [K in keyof Actions]: ReturnType<typeof vi.fn> } & Actions;

export function renderWithState(ui: ReactElement, patch: (s: AppState) => AppState = (s) => s) {
  const store = createStore(patch(initialState()));
  const actions = {
    setDraft: vi.fn(),
    submit: vi.fn(),
    signOut: vi.fn(),
    switchTab: vi.fn(),
    banUser: vi.fn(),
    loadAudit: vi.fn(),
    openHandleDialog: vi.fn(),
    closeHandleDialog: vi.fn(),
    saveHandle: vi.fn(),
    pageShow: vi.fn(),
  } as unknown as MockActions;
  const app: App = { store, actions, start: () => Promise.resolve() };
  const result = render(<AppProvider app={app}>{ui}</AppProvider>);
  return { ...result, store, actions };
}

export function signedIn(patch: Partial<MeResponse> = {}): (s: AppState) => AppState {
  return (s) => ({ ...s, auth: { ...s.auth, token: 'tok', me: meResponse(patch) } });
}

export function entry(patch: Partial<AdminModerationRow> = {}, banThreshold: number | null = 3): ModerationEntry {
  const row = {
    occurredAt: '2024-01-01T10:00:00Z',
    messageId: 'm1',
    email: 'bob@example.com',
    handle: 'bob',
    status: 'REJECTED',
    score: 0.5,
    text: 'bad words',
    reason: 'toxic',
    strikesAfter: 1,
    currentStrikes: 1,
    banState: null,
    ...patch,
  } as AdminModerationRow;
  return { key: `${row.messageId}:${row.status}`, row, banThreshold };
}
