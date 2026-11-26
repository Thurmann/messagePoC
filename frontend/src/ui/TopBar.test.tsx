import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TopBar } from './TopBar';
import { renderWithState, signedIn } from './testUtils';

describe('TopBar', () => {
  it('shows the offline anonymous state', () => {
    renderWithState(<TopBar />);
    expect(screen.getByText('Live chat')).toBeInTheDocument();
    expect(screen.getByText('offline')).toHaveClass('conn');
    expect(document.getElementById('tabs')).not.toBeVisible();
    expect(document.getElementById('me')).not.toBeVisible();
    expect(document.getElementById('version')).not.toBeVisible();
    expect(document.getElementById('login')).not.toBeVisible();
    expect(document.getElementById('gsi-button')).toBeEmptyDOMElement();
  });

  it('shows the login button once Google is ready, keeping the same gsi element', () => {
    const { store } = renderWithState(<TopBar />);
    const gsi = document.getElementById('gsi-button');
    act(() => store.set((s) => ({ ...s, auth: { ...s.auth, gisReady: true } })));
    expect(document.getElementById('login')).toBeVisible();
    expect(document.getElementById('gsi-button')).toBe(gsi);
    expect(gsi).toHaveAttribute('title', 'Login');
  });

  it('shows the version', () => {
    renderWithState(<TopBar />, (s) => ({ ...s, config: { ...s.config, version: '1.2.3' } }));
    const v = document.getElementById('version');
    expect(v).toHaveTextContent('v1.2.3');
    expect(v).toHaveAttribute('title', 'Running version 1.2.3');
    expect(v).toBeVisible();
  });

  it('shows the signed-in user and signs out', () => {
    const { actions } = renderWithState(<TopBar />, signedIn());
    expect(document.getElementById('me-handle')).toHaveTextContent('@alice');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(actions.signOut).toHaveBeenCalled();
  });

  it('shows the email when no handle is chosen', () => {
    renderWithState(<TopBar />, signedIn({ handle: null }));
    expect(document.getElementById('me-handle')).toHaveTextContent('alice@example.com');
  });

  it('shows the connection states', () => {
    const { store } = renderWithState(<TopBar />);
    act(() => store.set((s) => ({ ...s, conn: { sse: true, kafka: 'UP' } })));
    expect(screen.getByText('live')).toHaveClass('conn', 'on');
    act(() => store.set((s) => ({ ...s, conn: { sse: true, kafka: 'DOWN' } })));
    expect(screen.getByText('live · Kafka unavailable, messages delayed')).toHaveClass('conn', 'warn');
    act(() => store.set((s) => ({ ...s, conn: { sse: false, kafka: 'UP' } })));
    expect(screen.getByText('reconnecting…')).toHaveAttribute('title', 'Connection to the chat stream lost; reconnecting.');
  });

  it('shows admin tabs and switches them', () => {
    const { actions, store } = renderWithState(<TopBar />, signedIn({ isAdmin: true }));
    expect(document.getElementById('tabs')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveClass('tab', 'active');
    fireEvent.click(screen.getByRole('button', { name: 'Admin log' }));
    expect(actions.switchTab).toHaveBeenCalledWith('log');
    act(() => store.set((s) => ({ ...s, admin: { ...s.admin, tab: 'log' } })));
    expect(screen.getByRole('button', { name: 'Admin log' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Chat' })).not.toHaveClass('active');
  });
});
