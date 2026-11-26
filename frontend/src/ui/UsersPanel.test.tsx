import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { OnlineUser } from '../api/types';
import { UsersPanel } from './UsersPanel';
import { renderWithState, signedIn } from './testUtils';

const NOW = Date.parse('2024-01-01T10:00:00Z');

function withUsers(users: OnlineUser[], me: Parameters<typeof signedIn>[0] = {}) {
  return (s: Parameters<ReturnType<typeof signedIn>>[0]) => {
    const t = signedIn(me)(s);
    return { ...t, presence: { ...t.presence, running: true, users, now: NOW } };
  };
}

describe('UsersPanel', () => {
  it('is hidden until presence runs', () => {
    renderWithState(<UsersPanel />);
    expect(screen.getByLabelText('Online users', { selector: 'aside' })).not.toBeVisible();
  });

  it('lists users with markers and a count that includes you', () => {
    renderWithState(<UsersPanel />, withUsers([{ handle: 'alice' }, { handle: 'bob', isAdmin: true }]));
    expect(document.getElementById('users-count')).toHaveTextContent('2');
    const items = document.querySelectorAll('#users-list li');
    expect(items).toHaveLength(2);
    expect(items[0]?.querySelector('.you')).toHaveTextContent('(you)');
    expect(items[1]?.querySelector('.tag')).toHaveTextContent('admin');
    expect(document.getElementById('users-empty')).not.toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the empty hint when alone', () => {
    renderWithState(<UsersPanel />, withUsers([{ handle: 'alice' }]));
    expect(document.getElementById('users-empty')).toBeVisible();
  });

  it('shows banned users with a countdown and no Ban button', () => {
    renderWithState(
      <UsersPanel />,
      withUsers([{ handle: 'alice' }, { handle: 'bob', bannedUntil: new Date(NOW + 65_000).toISOString() }], { isAdmin: true }),
    );
    expect(screen.getByText('banned · 1m 5s')).toHaveClass('banned');
    expect(screen.queryByRole('button', { name: 'Ban bob' })).toBeNull();
  });

  it('lets an admin ban other non-admins', () => {
    const { actions } = renderWithState(
      <UsersPanel />,
      withUsers([{ handle: 'alice' }, { handle: 'bob' }, { handle: 'root', isAdmin: true }], { isAdmin: true }),
    );
    expect(screen.queryByRole('button', { name: 'Ban alice' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ban root' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ban bob' }));
    expect(actions.banUser).toHaveBeenCalledWith('bob');
  });

  it('disables the Ban button while a ban is in flight', () => {
    renderWithState(<UsersPanel />, (s) => {
      const t = withUsers([{ handle: 'alice' }, { handle: 'bob' }], { isAdmin: true })(s);
      return { ...t, presence: { ...t.presence, banning: { bob: true } } };
    });
    expect(screen.getByRole('button', { name: 'Ban bob' })).toBeDisabled();
  });

  it('shows the error as an alert', () => {
    renderWithState(<UsersPanel />, (s) => {
      const t = withUsers([{ handle: 'alice' }])(s);
      return { ...t, presence: { ...t.presence, error: 'Admins cannot be banned.' } };
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Admins cannot be banned.');
  });
});
