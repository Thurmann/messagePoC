// Loaded in <head> so the saved theme (or the OS preference) applies before first paint, like thurmann-nielsen.no.
// A classic script (not a module) so it runs synchronously; the IIFE keeps its names out of the global scope.
(function (): void {
  const KEY = 'theme';
  const root = document.documentElement;
  function saved(): string | null {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }
  let t = saved();
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', t);

  function render(btn: HTMLElement): void {
    const dark = root.getAttribute('data-theme') === 'dark';
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const icon = btn.querySelector('.theme-icon');
    if (icon) icon.textContent = dark ? '☀' : '☾';
    const text = btn.querySelector('.theme-label');
    if (text) text.textContent = dark ? 'Light' : 'Dark';
  }
  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    render(btn);
    btn.addEventListener('click', function () {
      const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* private mode: applies for this view only */
      }
      render(btn);
    });
  });
})();
