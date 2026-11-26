import { useMemo } from 'react';
import { logRowView } from '../core/selectors';
import { useAppState } from './AppContext';

export function LogView() {
  const show = useAppState((s) => s.admin.tab === 'log');
  const entries = useAppState((s) => s.admin.entries);
  const rows = useMemo(() => entries.map(logRowView), [entries]);
  return (
    <main id="view-log" className="logview" hidden={!show}>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>User</th>
              <th>Handle</th>
              <th>Status</th>
              <th>Score</th>
              <th>Text</th>
              <th>Reason</th>
              <th>Strikes</th>
              <th>Ban</th>
            </tr>
          </thead>
          <tbody id="log-body">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="num">{r.time}</td>
                <td>{r.email}</td>
                <td>{r.handle}</td>
                <td>
                  <span className={r.pillClass}>{r.status}</span>
                </td>
                <td className="num">{r.score}</td>
                <td className="txt">{r.text}</td>
                <td>{r.reason}</td>
                <td className="num">{r.strikes}</td>
                <td>{r.ban}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
