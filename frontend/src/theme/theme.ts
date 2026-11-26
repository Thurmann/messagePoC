export type Theme = 'light' | 'dark';

const KEY = 'theme';

/** The theme the pre-paint script (theme.js) put on <html>. */
export function readTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: applies for this view only */
  }
}
