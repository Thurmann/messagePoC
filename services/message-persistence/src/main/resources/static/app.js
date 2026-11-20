(function () {
  'use strict';

  var HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
  var TOKEN_KEY = 'idToken';
  var state = {
    config: { googleClientId: '', messageApiBaseUrl: '' },
    token: null,
    me: null,
    seen: new Map(),      // messageId -> { type, el }
    pending: new Map(),   // messageId -> { text, el }
    cards: new Map(),     // messageId -> element
    logRows: [],
    banTimer: null,
    banUntil: 0,
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['tabs', 'tab-chat', 'tab-log', 'conn', 'me', 'me-handle', 'signout', 'gsi-button', 'setup', 'warn-banner',
    'ban-banner', 'view-chat', 'view-log', 'lines', 'send-error', 'composer', 'text', 'send', 'rail', 'cards',
    'rail-empty', 'audit-btn', 'audit', 'log-body', 'handle-dialog', 'handle-form', 'handle-input',
    'handle-error', 'handle-cancel', 'handle-save'].forEach(function (id) { els[id] = $(id); });

  // ---------- helpers ----------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function colorClass(handle) {
    var h = 0, s = String(handle || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'c' + (h % 8);
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString();
  }
  function show(e, on) { e.hidden = !on; }
  function setError(e, msg) { e.textContent = msg || ''; show(e, !!msg); }
  function apiBase() { return (state.config.messageApiBaseUrl || '').replace(/\/+$/, ''); }
  function authHeaders(extra) {
    var h = Object.assign({}, extra || {});
    if (state.token) h.Authorization = 'Bearer ' + state.token;
    return h;
  }
  function safeStore(op, key, value) {
    try {
      if (op === 'set') sessionStorage.setItem(key, value);
      else if (op === 'del') sessionStorage.removeItem(key);
      else return sessionStorage.getItem(key);
    } catch (e) { /* storage unavailable */ }
    return null;
  }

  // ---------- chat rendering ----------
  function nearBottom() {
    var l = els.lines;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }
  function appendLine(node) {
    var stick = nearBottom();
    els.lines.appendChild(node);
    if (stick) els.lines.scrollTop = els.lines.scrollHeight;
  }
  function userLine(handle, text, time, cls) {
    var line = el('div', 'line' + (cls ? ' ' + cls : ''));
    if (time) line.appendChild(el('span', 't', fmtTime(time)));
    line.appendChild(el('span', 'h ' + colorClass(handle), handle));
    line.appendChild(document.createTextNode(': '));
    line.appendChild(el('span', 'x', text));
    return line;
  }
  function systemLine(text) { return el('div', 'line sys', text); }

  function markPosted(p) {
    p.el.classList.remove('pending');
    var s = p.el.querySelector('.status');
    if (s) s.remove();
  }
  function markRemoved(p) {
    p.el.classList.remove('pending');
    p.el.classList.add('failed');
    var s = p.el.querySelector('.status');
    if (!s) { s = el('span', 'status'); p.el.appendChild(s); }
    s.textContent = 'not posted · flagged by moderation';
  }

  function handleChatEvent(type, ev) {
    if (!ev || !ev.messageId) return;
    var id = ev.messageId;
    var pend = state.pending.get(id);
    if (pend) {
      state.pending.delete(id);
      state.seen.set(id, { type: type, el: pend.el });
      if (type === 'message') markPosted(pend); else { markRemoved(pend); refreshMe(); }
      return;
    }
    if (state.seen.has(id)) return;
    var node = type === 'message'
      ? userLine(ev.handle, ev.text, ev.occurredAt)
      : systemLine('A message from ' + ev.handle + ' was removed by moderation.');
    state.seen.set(id, { type: type, el: node });
    appendLine(node);
  }

  // ---------- fetch-based SSE ----------
  function startSse(path, withAuth, onEvent, opts) {
    var stopped = false, delay = 1000, ctrl = null;
    opts = opts || {};
    async function run() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          if (opts.beforeConnect) await opts.beforeConnect();
          var res = await fetch(path, {
            headers: withAuth ? authHeaders({ Accept: 'text/event-stream' }) : { Accept: 'text/event-stream' },
            signal: ctrl.signal, cache: 'no-store',
          });
          if (res.status === 401 && withAuth) { signOut(); return; }
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          delay = 1000;
          if (opts.onState) opts.onState(true);
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', evName = '', data = [];
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.search(/\r\n|\n|\r/)) >= 0) {
              var m = buf.match(/\r\n|\n|\r/);
              var line = buf.slice(0, idx);
              buf = buf.slice(idx + m[0].length);
              if (line === '') {
                if (data.length) {
                  try { onEvent(evName || 'message', JSON.parse(data.join('\n'))); } catch (e) { /* bad event */ }
                }
                evName = ''; data = [];
              } else if (line.charAt(0) === ':') {
                // comment / heartbeat
              } else {
                var c = line.indexOf(':');
                var f = c < 0 ? line : line.slice(0, c);
                var v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
                if (f === 'event') evName = v; else if (f === 'data') data.push(v);
              }
            }
          }
        } catch (e) {
          if (stopped) return;
        }
        if (opts.onState) opts.onState(false);
        if (stopped) return;
        await new Promise(function (r) { setTimeout(r, delay); });
        delay = Math.min(delay * 2, 30000);
      }
    }
    run();
    return function stop() { stopped = true; if (ctrl) ctrl.abort(); };
  }

  async function loadHistory() {
    try {
      var res = await fetch('/api/chat/history?limit=100', { cache: 'no-store' });
      if (!res.ok) return;
      var list = await res.json();
      list.forEach(function (ev) { handleChatEvent(ev.type, ev); });
    } catch (e) { /* ignore */ }
  }

  // ---------- auth ----------
  function setToken(t) {
    state.token = t || null;
    if (t) safeStore('set', TOKEN_KEY, t); else safeStore('del', TOKEN_KEY);
  }
  function signOut() {
    setToken(null);
    state.me = null;
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    stopAdmin();
    renderMe();
  }
  async function onCredential(resp) {
    if (!resp || !resp.credential) return;
    setToken(resp.credential);
    await refreshMe();
  }
  async function refreshMe() {
    if (!state.token) return;
    try {
      var res = await fetch('/api/me', { headers: authHeaders(), cache: 'no-store' });
      if (res.status === 401) { signOut(); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.me = await res.json();
    } catch (e) {
      setError(els['send-error'], 'Could not load your profile. Try again shortly.');
      return;
    }
    renderMe();
    if (state.me.handle === null || state.me.handle === undefined) openHandleDialog();
  }

  function renderMe() {
    var me = state.me;
    var signed = !!(state.token && me);
    show(els.me, signed);
    show(els['gsi-button'], !signed && !!state.config.googleClientId);
    if (signed) els['me-handle'].textContent = me.handle ? '@' + me.handle : me.email;

    // banners
    if (signed && me.warning && !me.ban) {
      els['warn-banner'].textContent = 'You have ' + me.strikes + ' flagged messages. At ' + me.banThreshold +
        ' your account is temporarily banned.';
      show(els['warn-banner'], true);
    } else show(els['warn-banner'], false);
    if (signed && me.ban) startBan(me.ban.until, me.ban.remainingSeconds); else stopBan();

    var admin = signed && me.isAdmin;
    show(els.tabs, admin);
    show(els.rail, admin);
    els['view-chat'].classList.toggle('no-rail', !admin);
    if (admin) startAdmin(); else { stopAdmin(); switchTab('chat'); }
    updateComposer();
  }

  // ---------- ban countdown ----------
  function fmtRemaining(s) {
    s = Math.max(0, Math.ceil(s));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + sec + 's';
  }
  function startBan(until, remainingSeconds) {
    var end = until ? Date.parse(until) : NaN;
    if (isNaN(end)) end = Date.now() + (remainingSeconds || 0) * 1000;
    state.banUntil = end;
    if (state.banTimer) clearInterval(state.banTimer);
    var tick = function () {
      var left = (state.banUntil - Date.now()) / 1000;
      if (left <= 0) { stopBan(); if (state.me) state.me.ban = null; updateComposer(); return; }
      els['ban-banner'].textContent = 'You are temporarily banned from posting. Time remaining: ' + fmtRemaining(left);
      show(els['ban-banner'], true);
    };
    tick();
    if (state.banUntil > Date.now()) state.banTimer = setInterval(tick, 1000);
    updateComposer();
  }
  function stopBan() {
    if (state.banTimer) clearInterval(state.banTimer);
    state.banTimer = null;
    state.banUntil = 0;
    show(els['ban-banner'], false);
  }
  function isBanned() { return state.banUntil > Date.now(); }

  // ---------- composer ----------
  function updateComposer() {
    var me = state.me, signed = !!(state.token && me);
    var ok = signed && !!me.handle && !isBanned();
    els.text.disabled = !ok;
    els.send.disabled = !ok;
    els.text.placeholder = !signed ? 'Sign in to chat' : !me.handle ? 'Choose a handle to chat'
      : isBanned() ? 'You are temporarily banned' : 'Write a message';
  }

  async function sendMessage(text) {
    setError(els['send-error'], '');
    var handle = state.me.handle;
    var line = userLine(handle, text, new Date().toISOString(), 'pending');
    line.appendChild(el('span', 'status', 'checking…'));
    appendLine(line);
    var p = { text: text, el: line };
    var drop = function () { line.remove(); };
    try {
      var res = await fetch(apiBase() + '/api/messages', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text: text }),
      });
      if (res.status === 202) {
        var body = await res.json();
        var seen = state.seen.get(body.messageId);
        if (seen) {
          // stream result arrived before the POST response
          if (seen.el && seen.el.parentNode) seen.el.remove();
          if (seen.type === 'message') { markPosted(p); } else { markRemoved(p); refreshMe(); }
          state.seen.set(body.messageId, { type: seen.type, el: line });
        } else state.pending.set(body.messageId, p);
        return;
      }
      drop();
      els.text.value = text;
      var err = {};
      try { err = await res.json(); } catch (e) { /* no body */ }
      if (res.status === 401) { signOut(); setError(els['send-error'], 'Your session expired. Please sign in again.'); }
      else if (res.status === 403 && err.error === 'BANNED') { startBan(err.bannedUntil, err.remainingSeconds); }
      else if (res.status === 409 && err.error === 'HANDLE_REQUIRED') { openHandleDialog(); }
      else if (res.status === 503) setError(els['send-error'], 'Service temporarily unavailable. Please try again.');
      else setError(els['send-error'], 'Could not send message (HTTP ' + res.status + ').');
    } catch (e) {
      drop();
      els.text.value = text;
      setError(els['send-error'], 'Network error. Could not send message.');
    }
  }

  els.composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = els.text.value.trim();
    if (!text || els.send.disabled) return;
    els.text.value = '';
    sendMessage(text);
  });

  // ---------- handle dialog ----------
  function openHandleDialog() {
    setError(els['handle-error'], '');
    if (!els['handle-dialog'].open) {
      if (typeof els['handle-dialog'].showModal === 'function') els['handle-dialog'].showModal();
      else els['handle-dialog'].setAttribute('open', '');
    }
    els['handle-input'].focus();
  }
  els['handle-cancel'].addEventListener('click', function () { els['handle-dialog'].close(); });
  els['handle-form'].addEventListener('submit', async function (e) {
    e.preventDefault();
    var handle = els['handle-input'].value.trim();
    if (!HANDLE_RE.test(handle)) {
      setError(els['handle-error'], 'Use 3-20 letters, digits or underscores.');
      return;
    }
    els['handle-save'].disabled = true;
    try {
      var res = await fetch('/api/me/handle', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ handle: handle }),
      });
      if (res.ok) { els['handle-dialog'].close(); await refreshMe(); }
      else if (res.status === 401) { els['handle-dialog'].close(); signOut(); }
      else if (res.status === 400) setError(els['handle-error'], 'Invalid handle. Use 3-20 letters, digits or underscores.');
      else if (res.status === 409) setError(els['handle-error'], 'That handle is taken (or you already have one).');
      else setError(els['handle-error'], 'Could not save handle (HTTP ' + res.status + ').');
    } catch (err) {
      setError(els['handle-error'], 'Network error. Try again.');
    } finally { els['handle-save'].disabled = false; }
  });

  // ---------- admin ----------
  var stopAdminStream = null;
  function startAdmin() {
    if (stopAdminStream) return;
    state.logRows = [];
    state.cards.clear();
    els.cards.textContent = '';
    els['log-body'].textContent = '';
    (async function () {
      try {
        var res = await fetch('/api/admin/moderation-log?limit=200', { headers: authHeaders(), cache: 'no-store' });
        if (res.status === 401) { signOut(); return; }
        if (res.ok) {
          var rows = await res.json();
          rows.slice().reverse().forEach(addModerationRow);
        }
      } catch (e) { /* ignore */ }
    })();
    stopAdminStream = startSse('/api/admin/stream', true, function (name, row) {
      if (name === 'moderation') addModerationRow(row);
    });
  }
  function stopAdmin() {
    if (stopAdminStream) stopAdminStream();
    stopAdminStream = null;
  }

  function statusPill(status) {
    return el('span', 'pill ' + (status === 'DLT' ? 'p-dlt' : 'p-rej'), status);
  }
  function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
  function banText(row) { return row.banState ? 'banned until ' + fmtDateTime(row.banState.until) : ''; }

  function addModerationRow(row) {
    if (!row || !row.messageId) return;
    var key = row.messageId + ':' + row.status;
    if (state.cards.has(key)) return;
    var me = state.me;
    var card = el('div', 'card');
    var top = el('div', 'top');
    top.appendChild(el('b', colorClass(row.handle), row.handle || '(unknown)'));
    top.appendChild(statusPill(row.status));
    card.appendChild(top);
    card.appendChild(el('div', 'q', truncate(row.text, 120)));
    var meta = [];
    if (row.score !== null && row.score !== undefined) meta.push('score ' + Number(row.score).toFixed(2));
    if (row.strikesAfter !== null && row.strikesAfter !== undefined) {
      meta.push('strike ' + row.strikesAfter + (me ? ' / ' + me.banThreshold : ''));
    }
    if (meta.length) card.appendChild(el('div', 'meta', meta.join(' · ')));
    if (row.banState) card.appendChild(el('div', 'meta', banText(row)));
    state.cards.set(key, card);
    els.cards.insertBefore(card, els.cards.firstChild);
    show(els['rail-empty'], false);

    var tr = el('tr');
    tr.appendChild(el('td', 'num', fmtDateTime(row.occurredAt)));
    tr.appendChild(el('td', '', row.email || ''));
    tr.appendChild(el('td', '', row.handle || ''));
    var st = el('td'); st.appendChild(statusPill(row.status)); tr.appendChild(st);
    tr.appendChild(el('td', 'num', row.score == null ? '' : Number(row.score).toFixed(2)));
    tr.appendChild(el('td', 'txt', row.text));
    tr.appendChild(el('td', '', row.reason || ''));
    tr.appendChild(el('td', 'num', row.strikesAfter == null ? '' : String(row.strikesAfter) +
      (row.currentStrikes == null ? '' : ' (now ' + row.currentStrikes + ')')));
    tr.appendChild(el('td', '', banText(row)));
    els['log-body'].insertBefore(tr, els['log-body'].firstChild);
  }

  function switchTab(name) {
    var log = name === 'log';
    show(els['view-chat'], !log);
    show(els['view-log'], log);
    els['tab-chat'].classList.toggle('active', !log);
    els['tab-log'].classList.toggle('active', log);
  }
  els['tab-chat'].addEventListener('click', function () { switchTab('chat'); });
  els['tab-log'].addEventListener('click', function () { switchTab('log'); });

  els['audit-btn'].addEventListener('click', async function () {
    els.audit.textContent = '';
    try {
      var res = await fetch('/api/audit-logs', { headers: authHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var list = await res.json();
      list.slice(0, 30).forEach(function (a) {
        els.audit.appendChild(el('li', '', fmtDateTime(a.timestamp) + ' · ' + (a.result || '') + ' · ' +
          truncate(a.text || a.message, 80)));
      });
      if (!list.length) els.audit.appendChild(el('li', '', 'No audit entries.'));
    } catch (e) {
      els.audit.appendChild(el('li', '', 'Could not load audit logs.'));
    }
  });
  els.signout.addEventListener('click', signOut);

  // ---------- Google Identity Services ----------
  function loadGis() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  async function initAuth() {
    if (!state.config.googleClientId) {
      els.setup.textContent = 'Set GOOGLE_CLIENT_ID to enable sign-in';
      show(els.setup, true);
      return;
    }
    try {
      await loadGis();
      google.accounts.id.initialize({ client_id: state.config.googleClientId, callback: onCredential });
      google.accounts.id.renderButton(els['gsi-button'], { theme: 'outline', size: 'medium', type: 'standard' });
    } catch (e) {
      els.setup.textContent = 'Could not load Google sign-in.';
      show(els.setup, true);
    }
  }

  // ---------- boot ----------
  async function boot() {
    updateComposer();
    try {
      var res = await fetch('/api/config', { cache: 'no-store' });
      if (res.ok) state.config = await res.json();
    } catch (e) { /* use defaults */ }

    // public stream; re-fetch history on every (re)connect, dedupe by messageId
    startSse('/api/chat/stream', false, function (name, ev) {
      if (name === 'message' || name === 'removed') handleChatEvent(name, ev);
    }, {
      beforeConnect: loadHistory,
      onState: function (on) {
        els.conn.textContent = on ? 'live' : 'reconnecting…';
        els.conn.classList.toggle('on', on);
      },
    });

    var saved = safeStore('get', TOKEN_KEY);
    if (saved) { state.token = saved; await refreshMe(); }
    renderMe();
    initAuth();
  }
  boot();
})();
