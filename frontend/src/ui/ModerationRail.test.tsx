import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminModerationRow } from '../api/types';
import { ModerationRail } from './ModerationRail';
import { entry, renderWithState, signedIn } from './testUtils';

describe('ModerationRail', () => {
  it('is hidden for non-admins', () => {
    renderWithState(<ModerationRail />, signedIn());
    expect(document.getElementById('rail')).not.toBeVisible();
  });

  it('shows the empty hint for an admin without cards', () => {
    renderWithState(<ModerationRail />, signedIn({ isAdmin: true }));
    expect(document.getElementById('rail')).toBeVisible();
    expect(document.getElementById('rail-empty')).toBeVisible();
    expect(document.getElementById('audit')).toBeEmptyDOMElement();
  });

  it('renders cards newest first and hides the empty hint', () => {
    renderWithState(<ModerationRail />, (s) => ({
      ...signedIn({ isAdmin: true })(s),
      admin: {
        ...s.admin,
        entries: [
          entry({ messageId: 'm2', status: 'DLT', handle: null, text: 'x'.repeat(130), banState: { until: '2024-01-01T11:00:00Z' } } as Partial<AdminModerationRow>),
          entry(),
        ],
      },
    }));
    const cards = document.querySelectorAll('#cards .card');
    expect(cards).toHaveLength(2);
    expect(document.getElementById('rail-empty')).not.toBeVisible();
    expect(cards[0]?.querySelector('.top b')).toHaveTextContent('(unknown)');
    expect(cards[0]?.querySelector('.pill')).toHaveClass('pill', 'p-dlt');
    expect(cards[0]?.querySelector('.q')?.textContent).toBe(`${'x'.repeat(120)}…`);
    const metas = cards[0]?.querySelectorAll('.meta');
    expect(metas).toHaveLength(2);
    expect(metas?.[0]).toHaveTextContent('score 0.50 · strike 1 / 3');
    expect(metas?.[1]?.textContent).toMatch(/^banned until /);
    expect(cards[1]?.querySelector('.pill')).toHaveClass('p-rej');
    expect(cards[1]?.querySelectorAll('.meta')).toHaveLength(1);
  });

  it('loads and renders audit lines', () => {
    const { actions } = renderWithState(<ModerationRail />, (s) => ({
      ...signedIn({ isAdmin: true })(s),
      admin: { ...s.admin, audit: ['one', 'No audit entries.'] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Load audit logs' }));
    expect(actions.loadAudit).toHaveBeenCalled();
    expect(document.querySelectorAll('#audit li')).toHaveLength(2);
  });
});
