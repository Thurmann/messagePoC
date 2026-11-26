import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reply } from '../test/fakes';
import { createHarness, meResponse, type Harness } from '../test/harness';

let h: Harness;

beforeEach(async () => {
  vi.useFakeTimers();
  h = createHarness();
  await h.bootSignedIn(meResponse({ handle: null }));
});
afterEach(() => {
  vi.useRealTimers();
});

const puts = () => h.deps.fakeFetch.requestsTo('PUT', '/api/me/handle');
const dialog = () => h.state().dialog;
async function save(input: string): Promise<void> {
  h.app.actions.saveHandle(input);
  await h.flush();
}

describe('open and close (H1, H2)', () => {
  it('opens automatically for a profile without handle', () => {
    expect(dialog()).toMatchObject({ open: true, error: '', saving: false });
  });

  it('H1 opening clears the error and bumps openSeq even when already open', async () => {
    await save('x');
    expect(dialog().error).not.toBe('');
    const seq = dialog().openSeq;
    h.app.actions.openHandleDialog();
    expect(dialog()).toMatchObject({ open: true, error: '' });
    expect(dialog().openSeq).toBe(seq + 1);
  });

  it('H2 cancel closes and leaves the error untouched', async () => {
    await save('x');
    h.app.actions.closeHandleDialog();
    expect(dialog().open).toBe(false);
    expect(dialog().error).toBe('Use 3-20 letters, digits or underscores.');
  });
});

describe('save (H3)', () => {
  it('rejects an invalid handle without calling the API', async () => {
    await save('ab');
    await save('has space');
    await save('x'.repeat(21));
    expect(puts()).toHaveLength(0);
    expect(dialog().error).toBe('Use 3-20 letters, digits or underscores.');
  });

  it('trims, PUTs {handle}, closes and refreshes the profile on success', async () => {
    h.deps.fakeFetch.on('PUT', '/api/me/handle', () => reply(200, {}));
    h.deps.fakeFetch.on('GET', '/api/me', () => reply(200, meResponse({ handle: 'alice_1' })));
    await save('  alice_1  ');
    expect(JSON.parse(puts()[0]?.body ?? '')).toEqual({ handle: 'alice_1' });
    expect(dialog()).toMatchObject({ open: false, saving: false });
    expect(h.state().auth.me?.handle).toBe('alice_1');
    expect(h.state().presence.running).toBe(true);
  });

  it('disables Save while the request is in flight', async () => {
    let release!: (r: Response) => void;
    h.deps.fakeFetch.on('PUT', '/api/me/handle', () => new Promise<Response>((r) => (release = r)));
    h.app.actions.saveHandle('alice_1');
    await h.flush();
    expect(dialog().saving).toBe(true);
    release(reply(409, {}));
    await h.flush();
    expect(dialog().saving).toBe(false);
  });

  it.each([
    [400, 'Invalid handle. Use 3-20 letters, digits or underscores.'],
    [409, 'That handle is taken (or you already have one).'],
    [500, 'Could not save handle (HTTP 500).'],
  ])('HTTP %i shows its message and keeps the dialog open', async (status, text) => {
    h.deps.fakeFetch.on('PUT', '/api/me/handle', () => reply(status, {}));
    await save('alice_1');
    expect(dialog()).toMatchObject({ open: true, error: text, saving: false });
  });

  it('401 closes the dialog and signs out', async () => {
    h.deps.setGoogle(undefined);
    h.deps.fakeFetch.on('PUT', '/api/me/handle', () => reply(401, {}));
    await save('alice_1');
    expect(dialog().open).toBe(false);
    expect(h.state().auth.token).toBeNull();
  });

  it('a network error shows "Network error. Try again."', async () => {
    h.deps.fakeFetch.on('PUT', '/api/me/handle', () => {
      throw new Error('offline');
    });
    await save('alice_1');
    expect(dialog()).toMatchObject({ open: true, error: 'Network error. Try again.', saving: false });
  });
});
