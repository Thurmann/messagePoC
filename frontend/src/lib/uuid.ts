export interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => unknown;
}

/** crypto.randomUUID when available, else an RFC 4122 v4 built from getRandomValues or Math.random. */
export function newMessageId(
  crypto: CryptoLike | null = globalThis.crypto,
  random: () => number = Math.random,
): string {
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(random() * 256);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => (x + 256).toString(16).slice(1));
  return [h.slice(0, 4), h.slice(4, 6), h.slice(6, 8), h.slice(8, 10), h.slice(10)]
    .map((part) => part.join(''))
    .join('-');
}
