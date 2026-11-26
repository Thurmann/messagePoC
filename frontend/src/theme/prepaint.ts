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
})();
