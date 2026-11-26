export const RENEW_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
/** Largest delay setTimeout accepts. */
export const MAX_TIMER_MS = 2147483647;

/**
 * Expiry (epoch ms) from the unverified JWT payload, or 0 when absent/unreadable.
 * Used only to time a silent renewal; the server alone decides whether a token is valid.
 */
export function tokenExpiryMs(token: string): number {
  try {
    let p = String(token).split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const exp = (JSON.parse(atob(p)) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Delay until a renewal should start (5 minutes before expiry), or null when the token has no expiry. */
export function renewalDelayMs(token: string, nowMs: number): number | null {
  const exp = tokenExpiryMs(token);
  if (!exp) return null;
  return Math.min(Math.max(0, exp - nowMs - RENEW_BEFORE_EXPIRY_MS), MAX_TIMER_MS);
}
