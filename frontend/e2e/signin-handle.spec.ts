import { expect, test } from './support/fixtures';
import { fakeIdToken } from './support/token';

test.describe('sign-in and choosing a handle', () => {
  test('a new user must pick a handle; validation and server errors keep the dialog open', async ({ page, app, api }) => {
    await app.open();
    await app.signIn({ handle: null, email: 'new@example.com' });

    const dialog = page.locator('#handle-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#handle-input')).toBeFocused();
    await expect(page.locator('#handle-error')).toBeHidden();
    // no handle yet: the profile shows the e-mail, there is no presence and the composer is closed
    await expect(page.locator('#me-handle')).toHaveText('new@example.com');
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'Choose a handle to chat');
    await expect(page.locator('#users')).toBeHidden();
    expect(api.calls('POST /api/me/presence')).toHaveLength(0);

    // client-side validation: nothing is sent
    await page.locator('#handle-input').fill('ab');
    await page.locator('#handle-save').click();
    await expect(page.locator('#handle-error')).toHaveText('Use 3-20 letters, digits or underscores.');
    await page.locator('#handle-input').fill('bad handle!');
    await page.locator('#handle-save').click();
    await expect(page.locator('#handle-error')).toHaveText('Use 3-20 letters, digits or underscores.');
    expect(api.calls('PUT /api/me/handle')).toHaveLength(0);

    // server answers
    const cases: Array<[number, string]> = [
      [400, 'Invalid handle. Use 3-20 letters, digits or underscores.'],
      [409, 'That handle is taken (or you already have one).'],
      [500, 'Could not save handle (HTTP 500).'],
    ];
    await page.locator('#handle-input').fill('alice');
    for (const [status, message] of cases) {
      api.on('PUT /api/me/handle', () => ({ status, json: {} }));
      await page.locator('#handle-save').click();
      await expect(page.locator('#handle-error')).toHaveText(message);
      await expect(page.locator('#handle-error')).toHaveAttribute('role', 'alert');
      await expect(dialog).toBeVisible();
      await expect(page.locator('#handle-save')).toBeEnabled();
    }
    api.on('PUT /api/me/handle', () => ({ abort: true }));
    await page.locator('#handle-save').click();
    await expect(page.locator('#handle-error')).toHaveText('Network error. Try again.');
    expect(api.calls('PUT /api/me/handle')).toHaveLength(4);
  });

  test('saving a handle signs the user in fully', async ({ page, app, api }) => {
    await app.open();
    const token = await app.signIn({ handle: null });
    await page.locator('#handle-input').fill('  alice  ');
    api.on('PUT /api/me/handle', () => {
      api.me = { ...api.me, handle: 'alice' };
      return { status: 200, json: {} };
    });
    await page.locator('#handle-save').click();

    await expect(page.locator('#handle-dialog')).toBeHidden();
    const put = api.calls('PUT /api/me/handle')[0]!;
    expect(put.body).toEqual({ handle: 'alice' });
    expect(put.headers['authorization']).toBe(`Bearer ${token}`);

    await expect(page.locator('#me')).toBeVisible();
    await expect(page.locator('#me-handle')).toHaveText('@alice');
    await expect(page.locator('#signout')).toHaveText('Sign out');
    await expect(page.locator('#login')).toBeHidden();
    await expect(page.locator('#users')).toBeVisible();
    await expect(page.locator('#view-chat')).not.toHaveClass(/\bno-users\b/);
    await expect(page.locator('#text')).toBeEnabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'Write a message');
    await expect(page.locator('#send')).toBeEnabled();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#rail')).toBeHidden();
    expect(api.calls('POST /api/me/presence')).toHaveLength(1);
    expect(api.calls('POST /api/me/presence')[0]!.headers['authorization']).toBe(`Bearer ${token}`);
  });

  test('the handle dialog can be cancelled with the button or Escape', async ({ page, app }) => {
    await app.open();
    await app.signIn({ handle: null });
    await expect(page.locator('#handle-dialog')).toBeVisible();
    await page.locator('#handle-cancel').click();
    await expect(page.locator('#handle-dialog')).toBeHidden();
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'Choose a handle to chat');

    // cancelling leaves the user without a handle; the next load asks again
    await page.reload();
    await expect(page.locator('#handle-dialog')).toBeVisible();
    await expect(page.locator('#handle-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#handle-dialog')).toBeHidden();
  });

  test('an expired session while saving the handle signs the user out', async ({ page, app, api }) => {
    await app.open();
    await app.signIn({ handle: null });
    api.on('PUT /api/me/handle', () => ({ status: 401, json: {} }));
    await page.locator('#handle-input').fill('alice');
    await page.locator('#handle-save').click();
    await expect(page.locator('#handle-dialog')).toBeHidden();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
  });

  test('signing in via the Google button works and lists who is online', async ({ page, app, api }) => {
    api.users = [{ handle: 'alice' }, { handle: 'bob' }, { handle: 'root', isAdmin: true }];
    await app.open();
    await app.google.clickButton(fakeIdToken());
    await expect(page.locator('#me-handle')).toHaveText('@alice');

    await expect(page.locator('#users-label')).toContainText('Online');
    await expect(page.locator('#users-count')).toHaveText('3');
    const items = page.locator('#users-list li');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('alice');
    await expect(items.nth(0).locator('.you')).toHaveText('(you)');
    await expect(items.nth(1).locator('.h')).toHaveText('bob');
    await expect(items.nth(2).locator('.h')).toHaveText('root');
    await expect(items.nth(2).locator('.tag')).toHaveText('admin');
    await expect(page.locator('#users-list button')).toHaveCount(0); // only admins can ban
    await expect(page.locator('#users-empty')).toBeHidden();
    expect(api.calls('GET /api/users/online').length).toBeGreaterThanOrEqual(1);
  });

  test('says so when nobody else is online', async ({ page, app, api }) => {
    api.users = [{ handle: 'alice' }];
    await app.open();
    await app.signIn();
    await expect(page.locator('#users-count')).toHaveText('1');
    await expect(page.locator('#users-empty')).toBeVisible();
    await expect(page.locator('#users-empty')).toHaveText('No one else is online.');
  });

  test('the session survives a reload and ends with sign out', async ({ page, app, api }) => {
    api.users = [{ handle: 'alice' }, { handle: 'bob' }];
    await app.open();
    const token = await app.signIn();
    await expect(page.locator('#users-list li')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('#me-handle')).toHaveText('@alice');
    await expect(page.locator('#login')).toBeHidden();
    const lastMe = api.calls('GET /api/me').at(-1)!;
    expect(lastMe.headers['authorization']).toBe(`Bearer ${token}`);
    await expect(page.locator('#text')).toBeEnabled();
    await expect(page.locator('#users-list li')).toHaveCount(2);

    const linesBefore = await page.locator('#lines .line').count();
    await page.locator('#signout').click();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#users')).toBeHidden();
    await expect(page.locator('#text')).toBeDisabled();
    await expect(page.locator('#text')).toHaveAttribute('placeholder', 'Sign in to chat');
    await expect(page.locator('#lines .line')).toHaveCount(linesBefore); // the chat is not cleared
    await expect.poll(() => api.calls('DELETE /api/me/presence').length).toBe(1);
    expect(api.calls('DELETE /api/me/presence')[0]!.headers['authorization']).toBe(`Bearer ${token}`);
    expect((await app.google.state()).disableAutoSelect).toBe(1);

    // signed out for good: a reload does not bring the session back
    await page.reload();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#me')).toBeHidden();
  });

  test('an unusable profile response is reported and does not sign the user in', async ({ page, app, api }) => {
    await app.open();
    api.on('GET /api/me', () => ({ status: 500, json: {} }));
    await app.google.deliver(fakeIdToken());
    await expect(page.locator('#send-error')).toHaveText('Could not load your profile. Try again shortly.');
    await expect(page.locator('#send-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#text')).toBeDisabled();
  });

  test('a 401 for the profile signs the user out', async ({ page, app, api }) => {
    await app.open();
    api.on('GET /api/me', () => ({ status: 401, json: {} }));
    await app.google.deliver(fakeIdToken());
    await expect.poll(() => api.calls('GET /api/me').length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('#me')).toBeHidden();
    await expect(page.locator('#login')).toBeVisible();
    await expect(page.locator('#text')).toBeDisabled();
  });
});
