import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChatLine } from '../core/state';
import { ChatPanel } from './ChatPanel';
import { renderWithState, signedIn } from './testUtils';

const line = (patch: Partial<ChatLine>): ChatLine => ({
  key: 'm1',
  kind: 'user',
  handle: 'bob',
  text: 'hello',
  pending: false,
  unconfirmed: false,
  failed: false,
  status: null,
  ...patch,
});

describe('ChatPanel', () => {
  it('has the log and composer contract when signed out', () => {
    renderWithState(<ChatPanel />);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    const input = screen.getByLabelText('Message');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Sign in to chat');
    expect(input).toHaveAttribute('maxlength', '500');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(document.getElementById('send-error')).not.toBeVisible();
  });

  it('renders user, system, pending and failed lines', () => {
    renderWithState(<ChatPanel />, (s) => ({
      ...s,
      lines: [
        line({ key: 'a', time: '2024-01-01T10:00:00Z' }),
        line({ key: 'b', kind: 'sys', handle: undefined, text: 'A message from bob was removed by moderation.' }),
        line({ key: 'c', pending: true, status: 'checking…' }),
        line({ key: 'd', failed: true, status: 'not posted · flagged by moderation' }),
        line({ key: 'e', unconfirmed: true, pending: true, status: 'not confirmed yet – retrying…' }),
      ],
    }));
    const lines = document.querySelectorAll('#lines > .line');
    expect(lines).toHaveLength(5);
    expect(lines[0]?.querySelector('.t')).not.toBeNull();
    expect(lines[0]?.querySelector('.h')?.textContent).toBe('bob');
    expect(lines[0]?.querySelector('.x')?.textContent).toBe('hello');
    expect(lines[0]?.textContent).toContain('bob: hello');
    expect(lines[1]).toHaveClass('line', 'sys');
    expect(lines[2]).toHaveClass('pending');
    expect(lines[2]?.querySelector('.status')).toHaveTextContent('checking…');
    expect(lines[3]).toHaveClass('failed');
    expect(lines[4]).toHaveClass('pending', 'unconfirmed');
  });

  it('shows the send error', () => {
    renderWithState(<ChatPanel />, (s) => ({ ...s, sendError: 'Oops' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Oops');
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('enables the composer, forwards typing and submit', () => {
    const { actions } = renderWithState(<ChatPanel />, signedIn());
    const input = screen.getByLabelText('Message');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('placeholder', 'Write a message');
    fireEvent.change(input, { target: { value: 'hi' } });
    expect(actions.setDraft).toHaveBeenCalledWith('hi');
    fireEvent.submit(document.getElementById('composer') as HTMLElement);
    expect(actions.submit).toHaveBeenCalled();
  });

  it('shows the draft from the store', () => {
    renderWithState(<ChatPanel />, (s) => ({ ...signedIn()(s), draft: 'typed' }));
    expect(screen.getByLabelText('Message')).toHaveValue('typed');
  });

  it('autoscrolls only while the user is near the bottom', () => {
    const { store } = renderWithState(<ChatPanel />);
    const log = document.getElementById('lines') as HTMLElement;
    let height = 1000;
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(log, 'clientHeight', { configurable: true, value: 200 });
    const add = (key: string) => act(() => store.set((s) => ({ ...s, lines: [...s.lines, line({ key })] })));
    add('1');
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 100; // far from the bottom
    fireEvent.scroll(log);
    height = 1200;
    add('2');
    expect(log.scrollTop).toBe(100);
    log.scrollTop = 1000; // near the bottom again
    fireEvent.scroll(log);
    height = 1400;
    add('3');
    expect(log.scrollTop).toBe(1400);
  });
});
