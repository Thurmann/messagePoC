// Unsigned fake Google ID token. The app decodes the payload only to time a silent renewal;
// the server (mocked here) is the only judge of validity.
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export interface FakeTokenOptions {
  /** Expiry in epoch seconds. Defaults to far in the future so no renewal timer fires during a test. */
  exp?: number;
  email?: string;
  /** Makes two tokens for the same user distinguishable (e.g. before and after a renewal). */
  nonce?: string;
}

export function fakeIdToken(options: FakeTokenOptions = {}): string {
  const payload = {
    iss: 'https://accounts.google.com',
    sub: '1234567890',
    email: options.email ?? 'alice@example.com',
    exp: options.exp ?? 4_102_444_800, // 2100-01-01
    nonce: options.nonce ?? 'n0',
  };
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`;
}
