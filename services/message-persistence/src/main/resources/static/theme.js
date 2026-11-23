// Loaded in <head> so the saved theme (or the OS preference) applies before first paint, like thurmann-nielsen.no.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  var t = saved();
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.setAttribute('data-theme', t);

  function render(btn) {
    var dark = root.getAttribute('data-theme') === 'dark';
    var label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.querySelector('.theme-icon').textContent = dark ? '☀' : '☾';
    btn.querySelector('.theme-label').textContent = dark ? 'Light' : 'Dark';
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    render(btn);
    btn.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: applies for this view only */ }
      render(btn);
    });
  });
})();
