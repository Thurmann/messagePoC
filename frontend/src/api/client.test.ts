import { describe, expect, it, vi } from 'vitest';
import { createFakeFetch, reply } from '../test/fakes';
import { apiBase, authedFetch, authHeaders } from './client';

describe('apiBase', () => {
  it('strips trailing slashes', () => {
    expect(apiBase('https://api.example.com///')).toBe('https://api.example.com');
    expect(apiBase('/x/')).toBe('/x');
  });
  it('is empty for missing values', () => {
    expect(apiBase('')).toBe('');
    expect(apiBase(undefined)).toBe('');
    expect(apiBase(null)).toBe('');
  });
});

describe('authHeaders', () => {
  it('adds a bearer token and keeps extras', () => {
    expect(authHeaders('t', { Accept: 'a' })).toEqual({ Accept: 'a', Authorization: 'Bearer t' });
  });
  it('omits Authorization without a token and does not mutate extras', () => {
    const extra = { A: '1' };
    expect(authHeaders(null)).toEqual({});
    expect(authHeaders(null, extra)).toEqual({ A: '1' });
    expect(extra).toEqual({ A: '1' });
  });
});

describe('authedFetch', () => {
  function setup(token: string | null, renewResult = true) {
    const ff = createFakeFetch();
    let current = token;
    const renewToken = vi.fn(async () => {
      if (renewResult) current = 'fresh';
      return renewResult;
    });
    const auth = { getToken: () => current, renewToken };
    return { ff, auth, renewToken };
  }

  it('sends the bearer token and passes init through', async () => {
    const { ff, auth } = setup('abc');
    ff.on('PUT', '/api/me/handle', { status: 200 });
    const res = await authedFetch(ff.fetch, auth, '/api/me/handle', {
      method: 'PUT',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(ff.requests[0]).toMatchObject({
      method: 'PUT',
      body: '{}',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer abc' },
    });
  });

  it('renews once on 401 and retries with the new token', async () => {
    const { ff, auth, renewToken } = setup('old');
    let n = 0;
    ff.on('GET', '/api/me', () => reply(++n === 1 ? 401 : 200));
    const res = await authedFetch(ff.fetch, auth, '/api/me');
    expect(res.status).toBe(200);
    expect(renewToken).toHaveBeenCalledTimes(1);
    expect(ff.requests.map((r) => r.headers.Authorization)).toEqual(['Bearer old', 'Bearer fresh']);
  });

  it('returns the 401 when renewal fails, without retrying', async () => {
    const { ff, auth } = setup('old', false);
    ff.on('GET', '/api/me', { status: 401 });
    expect((await authedFetch(ff.fetch, auth, '/api/me')).status).toBe(401);
    expect(ff.requests).toHaveLength(1);
  });

  it('retries at most once even if the retry is also 401', async () => {
    const { ff, auth, renewToken } = setup('old');
    ff.on('GET', '/api/me', { status: 401 });
    expect((await authedFetch(ff.fetch, auth, '/api/me')).status).toBe(401);
    expect(ff.requests).toHaveLength(2);
    expect(renewToken).toHaveBeenCalledTimes(1);
  });

  it('does not renew a 401 when there is no token', async () => {
    const { ff, auth, renewToken } = setup(null);
    ff.on('GET', '/api/me', { status: 401 });
    await authedFetch(ff.fetch, auth, '/api/me');
    expect(renewToken).not.toHaveBeenCalled();
    expect(ff.requests[0]?.headers.Authorization).toBeUndefined();
  });

  it('does not renew for non-401 errors', async () => {
    const { ff, auth, renewToken } = setup('t');
    ff.on('GET', '/api/me', { status: 403 });
    expect((await authedFetch(ff.fetch, auth, '/api/me')).status).toBe(403);
    expect(renewToken).not.toHaveBeenCalled();
  });
});
