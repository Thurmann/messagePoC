import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle';

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.dataset.theme = 'light';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts from the pre-paint theme (light)', () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveAttribute('aria-label', 'Switch to dark mode');
    expect(btn).toHaveAttribute('title', 'Switch to dark mode');
    expect(btn).toHaveTextContent('☾Dark');
  });

  it('starts from the pre-paint theme (dark)', () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveAttribute('aria-label', 'Switch to light mode');
    expect(btn).toHaveTextContent('☀Light');
  });

  it('toggles, applies and persists the theme', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button')).toHaveTextContent('☀Light');
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('ignores storage errors', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
