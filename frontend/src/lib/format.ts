/** Stable colour bucket (c0..c7) for a handle, from a 31-multiplier string hash. */
export function colorClass(handle: string | null | undefined): string {
  let h = 0;
  const s = String(handle ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `c${h % 8}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** "1h 0m 5s", "2m 0s", "7s": leading zero units dropped, minutes kept once hours are shown. */
export function fmtRemaining(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h ? `${h}h ` : ''}${h || m ? `${m}m ` : ''}${sec}s`;
}

export function truncate(value: unknown, max: number): string {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function banText(row: { banState?: { until: string } | null }): string {
  return row.banState ? `banned until ${fmtDateTime(row.banState.until)}` : '';
}
