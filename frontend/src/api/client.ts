export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** What the client needs from the session; passed explicitly so it stays testable. */
export interface AuthSource {
  getToken(): string | null;
  /** Resolves true when a fresh token is available. */
  renewToken(): Promise<boolean>;
}

export function apiBase(messageApiBaseUrl: string | null | undefined): string {
  return (messageApiBaseUrl || '').replace(/\/+$/, '');
}

export function authHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** fetch with the bearer token; on 401 tries one silent renewal and retries once. */
export async function authedFetch(
  fetchFn: FetchFn,
  auth: AuthSource,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const go = () =>
    fetchFn(path, {
      ...init,
      headers: authHeaders(auth.getToken(), init.headers as Record<string, string> | undefined),
    });
  let res = await go();
  if (res.status === 401 && auth.getToken()) {
    if (await auth.renewToken()) res = await go();
  }
  return res;
}
