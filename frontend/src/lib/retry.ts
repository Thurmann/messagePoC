export const MAX_ATTEMPTS = 6;

interface HeaderSource {
  headers?: { get(name: string): string | null } | null;
}

/** Retry-After in seconds, clamped to 3..30 (default 5), as milliseconds. */
export function retryDelayMs(res: HeaderSource | null | undefined): number {
  let n = parseInt(res?.headers ? (res.headers.get('Retry-After') ?? '') : '', 10);
  if (Number.isNaN(n)) n = 5;
  return Math.min(30, Math.max(3, n)) * 1000;
}
