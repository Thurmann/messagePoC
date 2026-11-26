import { expect, test } from './support/fixtures';

const MOON = '☾';
const SUN = '☀';

async function expectLight(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const toggle = page.locator('#theme-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark mode');
  await expect(toggle).toHaveAttribute('title', 'Switch to dark mode');
  await expect(toggle.locator('.theme-icon')).toHaveText(MOON);
  await expect(toggle.locator('.theme-label')).toHaveText('Dark');
}

async function expectDark(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const toggle = page.locator('#theme-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light mode');
  await expect(toggle).toHaveAttribute('title', 'Switch to light mode');
  await expect(toggle.locator('.theme-icon')).toHaveText(SUN);
  await expect(toggle.locator('.theme-label')).toHaveText('Light');
}

const savedTheme = (page: import('@playwright/test').Page) => page.evaluate(() => localStorage.getItem('theme'));

test.describe('theme', () => {
  test('toggles between light and dark and remembers the choice', async ({ page, app }) => {
    await app.open();
    await expectLight(page);
    expect(await savedTheme(page)).toBeNull();

    await page.locator('#theme-toggle').click();
    await expectDark(page);
    expect(await savedTheme(page)).toBe('dark');

    await page.reload();
    await expectDark(page);

    await page.locator('#theme-toggle').click();
    await expectLight(page);
    expect(await savedTheme(page)).toBe('light');
    await page.reload();
    await expectLight(page);
  });

  test('the saved theme is applied before the page body is created (no flash)', async ({ page, app }) => {
    await app.open();
    await page.locator('#theme-toggle').click();
    await expectDark(page);

    await page.addInitScript(() => {
      const record = () => {
        const w = window as unknown as { __themeAtBody?: string | null };
        if (document.body && w.__themeAtBody === undefined) w.__themeAtBody = document.documentElement.dataset.theme ?? null;
      };
      new MutationObserver(record).observe(document, { childList: true, subtree: true });
    });
    await page.reload();
    await expectDark(page);
    expect(await page.evaluate(() => (window as unknown as { __themeAtBody?: string }).__themeAtBody)).toBe('dark');
  });

  test.describe('without a saved choice', () => {
    test.use({ colorScheme: 'dark' });

    test('follows the operating system preference', async ({ page, app }) => {
      await app.open();
      await expectDark(page);
      expect(await savedTheme(page)).toBeNull();
    });

    test('a saved choice wins over the operating system', async ({ page, app }) => {
      await app.open();
      await page.evaluate(() => localStorage.setItem('theme', 'light'));
      await page.reload();
      await expectLight(page);
      await page.locator('#theme-toggle').click();
      await expectDark(page);
    });
  });

  test('keeps working when storage is unavailable', async ({ page, app }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('denied', 'SecurityError');
      };
    });
    await app.open();
    await expectLight(page);
    await page.locator('#theme-toggle').click();
    await expectDark(page);
  });
});
