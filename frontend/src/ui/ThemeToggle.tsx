import { useState } from 'react';
import { applyTheme, persistTheme, readTheme, type Theme } from '../theme/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const dark = theme === 'dark';
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  function toggle(): void {
    const next: Theme = readTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    persistTheme(next);
    setTheme(next);
  }
  return (
    <button
      type="button"
      className="btn ghost theme-toggle"
      id="theme-toggle"
      aria-pressed={dark}
      aria-label={label}
      title={label}
      onClick={toggle}
    >
      <span className="theme-icon" aria-hidden="true">
        {dark ? '☀' : '☾'}
      </span>
      <span className="theme-label">{dark ? 'Light' : 'Dark'}</span>
    </button>
  );
}
