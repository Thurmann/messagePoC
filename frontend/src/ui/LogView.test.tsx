import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminModerationRow } from '../api/types';
import { LogView } from './LogView';
import { entry, renderWithState } from './testUtils';

describe('LogView', () => {
  it('is hidden unless the log tab is active', () => {
    renderWithState(<LogView />);
    expect(document.getElementById('view-log')).not.toBeVisible();
  });

  it('renders the header and nine-cell rows', () => {
    renderWithState(<LogView />, (s) => ({
      ...s,
      admin: {
        ...s.admin,
        tab: 'log',
        entries: [
          entry({ messageId: 'm2', status: 'DLT', text: 'second', reason: null, banState: { until: '2024-01-01T11:00:00Z' } } as Partial<AdminModerationRow>),
          entry({ score: null, strikesAfter: 2, currentStrikes: 3 } as Partial<AdminModerationRow>),
        ],
      },
    }));
    expect(document.getElementById('view-log')).toBeVisible();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Time', 'User', 'Handle', 'Status', 'Score', 'Text', 'Reason', 'Strikes', 'Ban',
    ]);
    const rows = document.querySelectorAll('#log-body tr');
    expect(rows).toHaveLength(2);
    const first = rows[0]?.querySelectorAll('td');
    expect(first).toHaveLength(9);
    expect(first?.[0]).toHaveClass('num');
    expect(first?.[3]?.querySelector('.pill')).toHaveClass('p-dlt');
    expect(first?.[4]).toHaveTextContent('0.50');
    expect(first?.[5]).toHaveClass('txt');
    expect(first?.[5]).toHaveTextContent('second');
    expect(first?.[7]).toHaveTextContent('1 (now 1)');
    expect(first?.[8]?.textContent).toMatch(/^banned until /);
    const second = rows[1]?.querySelectorAll('td');
    expect(second?.[4]).toHaveTextContent('');
    expect(second?.[7]).toHaveTextContent('2 (now 3)');
  });
});
