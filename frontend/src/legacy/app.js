(function () {
  'use strict';

  var HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
  var TOKEN_KEY = 'idToken';
  var state = {
    config: { googleClientId: '', messageApiBaseUrl: '' },
    token: null,
    me: null,
    gisReady: false,     // Google sign-in loaded and its button rendered
    seen: new Map(),      // messageId -> { type, el }
    pending: new Map(),   // messageId -> { text, el }
    cards: new Map(),     // messageId -> element
    logRows: [],
    banTimer: null,
    banUntil: 0,
    tokenTimer: null,
    renewal: null,
    kafka: 'UNKNOWN',     // 'UNKNOWN' | 'UP' | 'DOWN'
    kafkaVer: 0,
    sse: null,            // null until the first connection result
    lastFailed: null,     // { text, messageId } of the last message dropped with a known failure
  };
  var MAX_ATTEMPTS = 6;

  var $ = function (id) { return document.getElementById(id); };
  var els = {};
  ['tabs', 'tab-chat', 'tab-log', 'conn', 'version', 'me', 'me-handle', 'signout', 'login', 'gsi-button', 'setup', 'warn-banner',
    'ban-banner', 'view-chat', 'view-log', 'lines', 'send-error', 'composer', 'text', 'send', 'rail', 'cards',
    'users', 'users-count', 'users-list', 'users-empty', 'users-error', 'rail-empty', 'audit-btn', 'audit', 'log-body', 'handle-dialog', 'handle-form', 'handle-input',
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

  function newMessageId() {
    var c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = [];
    for (var j = 0; j < 16; j++) h.push((b[j] + 256).toString(16).slice(1));
    return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') + '-' +
      h.slice(8, 10).join('') + '-' + h.slice(10).join('');
  }
  function setStatus(p, text) {
    var s = p.el.querySelector('.status');
    if (!s) { s = el('span', 'status'); p.el.appendChild(s); }
    s.textContent = text;
  }

  function markPosted(p) {
    p.el.classList.remove('pending');
    p.el.classList.remove('unconfirmed');
    var s = p.el.querySelector('.status');
    if (s) s.remove();
  }
  function markRemoved(p) {
    p.el.classList.remove('pending');
    p.el.classList.remove('unconfirmed');
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
      if (pend.timer) { clearTimeout(pend.timer); pend.timer = null; }
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
    var stopped = false, delay = 1000, ctrl = null, retried401 = false;
    opts = opts || {};
    async function run() {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          var res = await fetch(path, {
            headers: withAuth ? authHeaders({ Accept: 'text/event-stream' }) : { Accept: 'text/event-stream' },
            signal: ctrl.signal, cache: 'no-store',
          });
          if (res.status === 401 && withAuth) {
            if (!retried401 && await renewToken()) { retried401 = true; continue; }
            signOut();
            return;
          }
          if (res.status === 403 && withAuth && opts.onForbidden) { stopped = true; opts.onForbidden(); return; }
          if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
          delay = 1000;
          retried401 = false;
          if (opts.onState) opts.onState(true);
          // stream is open first; load state afterwards so results committed in the gap are not lost
          if (opts.afterConnect) opts.afterConnect();
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

  function renderConn() {
    if (state.sse === null) return;
    var warn = state.sse && state.kafka === 'DOWN';
    els.conn.textContent = !state.sse ? 'reconnecting…'
      : warn ? 'live · Kafka unavailable, messages delayed' : 'live';
    els.conn.title = !state.sse ? 'Connection to the chat stream lost; reconnecting.'
      : warn ? 'Live updates work, but the message broker is unavailable. Messages you send are retried until confirmed.'
        : 'Connected to the live chat stream.';
    els.conn.classList.toggle('on', !!state.sse && !warn);
    els.conn.classList.toggle('warn', warn);
    updateComposer();
  }
  function renderVersion() {
    var version = state.config && state.config.version;
    els.version.textContent = version ? 'v' + version : '';
    els.version.title = version ? 'Running version ' + version : '';
    show(els.version, !!version);
  }
  function setKafka(status) {
    state.kafka = status === 'UP' || status === 'DOWN' ? status : 'UNKNOWN';
    renderConn();
  }
  async function loadKafkaStatus() {
    var ver = state.kafkaVer;
    try {
      var res = await fetch('/api/chat/kafka-status', { cache: 'no-store' });
      if (!res.ok) return;
      var body = await res.json();
      if (ver === state.kafkaVer) setKafka(body && body.status); // ignore if a newer stream event arrived meanwhile
    } catch (e) { /* ignore */ }
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
  // The JWT payload is decoded only to time a silent renewal; the server alone decides whether a token is valid.
  function tokenExpiryMs(t) {
    try {
      var p = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var exp = JSON.parse(atob(p)).exp;
      return typeof exp === 'number' ? exp * 1000 : 0;
    } catch (e) { return 0; }
  }
  function scheduleRenewal(t) {
    if (state.tokenTimer) clearTimeout(state.tokenTimer);
    state.tokenTimer = null;
    var exp = t ? tokenExpiryMs(t) : 0;
    if (!exp) return;
    var wait = Math.max(0, exp - Date.now() - 5 * 60 * 1000);
    state.tokenTimer = setTimeout(function () { renewToken(); }, Math.min(wait, 2147483647));
  }
  // Asks Google for a fresh credential silently (auto_select). Resolves true if a new token arrived.
  function renewToken() {
    if (state.renewal) return state.renewal.promise;
    if (!(window.google && google.accounts && google.accounts.id)) return Promise.resolve(false);
    var r = {};
    r.promise = new Promise(function (resolve) {
      var done = false;
      r.finish = function (ok) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state.renewal = null;
        resolve(ok);
      };
      var timer = setTimeout(function () { r.finish(false); }, 8000);
    });
    state.renewal = r;
    try {
      google.accounts.id.prompt(function (n) {
        if (n && ((n.isNotDisplayed && n.isNotDisplayed()) || (n.isSkippedMoment && n.isSkippedMoment()))) r.finish(false);
      });
    } catch (e) { r.finish(false); }
    return r.promise;
  }
  // fetch with auth; on 401 tries one silent renewal and retries once
  async function authedFetch(path, init) {
    init = init || {};
    function go() {
      return fetch(path, Object.assign({}, init, { headers: authHeaders(init.headers) }));
    }
    var res = await go();
    if (res.status === 401 && state.token) {
      if (await renewToken()) res = await go();
    }
    return res;
  }
  function setToken(t) {
    state.token = t || null;
    if (t) safeStore('set', TOKEN_KEY, t); else safeStore('del', TOKEN_KEY);
    scheduleRenewal(state.token);
  }
  function signOut() {
    // a retry must never post with another user's token: stop every in-flight send of the signed-out user
    state.pending.forEach(function (p) {
      p.stopped = true;
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      p.el.classList.remove('pending');
      p.el.classList.add('unconfirmed');
      setStatus(p, 'not confirmed – it may still appear');
    });
    state.lastFailed = null;
    if (state.token && presence.running) sendOffline();
    stopPresence();
    setToken(null);
    state.me = null;
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    stopAdmin();
    renderMe();
  }
  async function onCredential(resp) {
    if (!resp || !resp.credential) return;
    setToken(resp.credential);
    if (state.renewal) state.renewal.finish(true);
    if (!state.me) await refreshMe();
  }
  async function refreshMe() {
    if (!state.token) return;
    try {
      var res = await authedFetch('/api/me', { cache: 'no-store' });
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
    show(els.login, !signed && state.gisReady);
    if (signed) els['me-handle'].textContent = me.handle ? '@' + me.handle : me.email;

    // banners
    if (signed && me.warning && !me.ban) {
      els['warn-banner'].textContent = 'You have ' + me.strikes + ' flagged messages.' +
        (me.isAdmin ? '' : ' At ' + me.banThreshold + ' your account is temporarily banned.');
      show(els['warn-banner'], true);
    } else show(els['warn-banner'], false);
    if (signed && me.ban) startBan(me.ban.until, me.ban.remainingSeconds); else stopBan();

    var admin = signed && me.isAdmin;
    show(els.tabs, admin);
    show(els.rail, admin);
    els['view-chat'].classList.toggle('no-rail', !admin);
    if (admin) startAdmin(); else { stopAdmin(); switchTab('chat'); }
    if (signed && me.handle) startPresence(); else stopPresence();
    updateComposer();
  }

  // ---------- presence / online users ----------
  var presence = { running: false, gen: 0, hbTimer: null, pollTimer: null, polling: 0, tickTimer: null,
    users: [], banning: {}, banSpans: [] };

  function sendOffline() {
    try {
      fetch('/api/me/presence', { method: 'DELETE', headers: authHeaders(), keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  }
  function startPresence() {
    if (presence.running) return;
    presence.running = true;
    var gen = ++presence.gen;
    show(els.users, true);
    els['view-chat'].classList.remove('no-users');
    heartbeat(gen, true);
    presence.hbTimer = setInterval(function () { heartbeat(gen, false); }, 30000);
    presence.pollTimer = setInterval(function () { pollUsers(gen); }, 15000);
  }
  function stopPresence() {
    if (presence.hbTimer) clearInterval(presence.hbTimer);
    if (presence.pollTimer) clearInterval(presence.pollTimer);
    if (presence.tickTimer) clearInterval(presence.tickTimer);
    presence.hbTimer = presence.pollTimer = presence.tickTimer = null;
    presence.running = false;
    presence.gen++; // invalidates in-flight responses
    presence.users = [];
    presence.banning = {};
    presence.banSpans = [];
    els['users-list'].textContent = '';
    setError(els['users-error'], '');
    show(els.users, false);
    els['view-chat'].classList.add('no-users');
  }
  async function heartbeat(gen, first) {
    try {
      var res = await authedFetch('/api/me/presence', { method: 'POST', cache: 'no-store' });
      if (gen !== presence.gen) return;
      if (res.status === 401) { signOut(); return; }
      if (!res.ok) return;
      var body = null;
      try { body = await res.json(); } catch (e) { /* no body */ }
      if (gen !== presence.gen) return;
      if (body && body.ban) {
        if (state.me) state.me.ban = body.ban;
        startBan(body.ban.until, body.ban.remainingSeconds);
      }
      if (first) pollUsers(gen);
    } catch (e) { /* retry on the next beat */ }
  }
  async function pollUsers(gen) {
    if (gen !== presence.gen || presence.polling === gen) return;
    presence.polling = gen;
    try {
      var res = await authedFetch('/api/users/online', { cache: 'no-store' });
      if (gen !== presence.gen) return;
      if (res.status === 401) { signOut(); return; }
      if (!res.ok) return;
      var list = await res.json();
      if (gen !== presence.gen) return;
      presence.users = Array.isArray(list) ? list : [];
      renderUsers();
    } catch (e) { /* keep the previous list */ }
    finally { if (presence.polling === gen) presence.polling = 0; }
  }
  function bannedLeft(u) {
    var t = u.bannedUntil ? Date.parse(u.bannedUntil) : NaN;
    return isNaN(t) ? 0 : (t - Date.now()) / 1000;
  }
  function renderUsers() {
    var me = state.me, myHandle = me ? me.handle : null, viewerAdmin = !!(me && me.isAdmin);
    var list = els['users-list'], others = 0;
    // the list is rebuilt on every poll; keep keyboard focus on the same Ban button
    var focused = document.activeElement && list.contains(document.activeElement)
      ? document.activeElement.getAttribute('aria-label') : null;
    list.textContent = '';
    presence.banSpans = [];
    presence.users.forEach(function (u) {
      if (!u || !u.handle) return;
      var self = u.handle === myHandle;
      if (!self) others++;
      var li = el('li');
      li.appendChild(el('span', 'h ' + colorClass(u.handle), u.handle));
      if (self) li.appendChild(el('span', 'you', '(you)'));
      if (u.isAdmin) li.appendChild(el('span', 'tag', 'admin'));
      var left = bannedLeft(u);
      if (left > 0) {
        var b = el('span', 'banned', 'banned · ' + fmtRemaining(left));
        li.appendChild(b);
        presence.banSpans.push({ span: b, until: Date.parse(u.bannedUntil) });
      } else if (viewerAdmin && !self && !u.isAdmin) {
        var btn = el('button', 'btn small danger', 'Ban');
        btn.type = 'button';
        btn.disabled = !!presence.banning[u.handle];
        btn.setAttribute('aria-label', 'Ban ' + u.handle);
        btn.addEventListener('click', function () { banUser(u.handle); });
        li.appendChild(btn);
      }
      list.appendChild(li);
    });
    if (focused) {
      var again = Array.prototype.find.call(list.querySelectorAll('button'), function (b) {
        return b.getAttribute('aria-label') === focused;
      });
      if (again) again.focus();
    }
    els['users-count'].textContent = String(presence.users.length);
    show(els['users-empty'], others === 0);
    if (presence.tickTimer) { clearInterval(presence.tickTimer); presence.tickTimer = null; }
    if (presence.banSpans.length) presence.tickTimer = setInterval(tickBans, 1000);
  }
  function tickBans() {
    var expired = false;
    presence.banSpans.forEach(function (b) {
      var left = (b.until - Date.now()) / 1000;
      if (left <= 0) expired = true; else b.span.textContent = 'banned · ' + fmtRemaining(left);
    });
    if (expired) renderUsers();
  }
  async function banUser(handle) {
    if (presence.banning[handle]) return;
    if (!window.confirm('Ban @' + handle + '? The ban length follows the ladder (1 min, 5 min, 30 min, …).')) return;
    var gen = presence.gen;
    presence.banning[handle] = true;
    renderUsers();
    setError(els['users-error'], '');
    try {
      var res = await authedFetch('/api/admin/users/ban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle }),
      });
      if (gen !== presence.gen) return;
      if (res.status === 401) { signOut(); return; }
      var err = {};
      if (!res.ok) { try { err = await res.json(); } catch (e) { /* no body */ } }
      if (gen !== presence.gen) return;
      if (res.ok) { pollUsers(gen); }
      else if (res.status === 403) { setError(els['users-error'], 'You are not allowed to ban users.'); refreshMe(); }
      else if (res.status === 404) { setError(els['users-error'], '@' + handle + ' no longer exists.'); pollUsers(gen); }
      else if (res.status === 409 && err.error === 'CANNOT_BAN_ADMIN') setError(els['users-error'], 'Admins cannot be banned.');
      else if (res.status === 409 && err.error === 'ALREADY_BANNED') { setError(els['users-error'], '@' + handle + ' is already banned.'); pollUsers(gen); }
      else setError(els['users-error'], 'Could not ban @' + handle + ' (HTTP ' + res.status + ').');
    } catch (e) {
      if (gen === presence.gen) setError(els['users-error'], 'Network error. Try again.');
    } finally {
      delete presence.banning[handle];
      if (gen === presence.gen) renderUsers();
    }
  }
  // Closing or reloading a tab does not mark the user offline (another tab may still be open): the online window expires.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && state.token && presence.running) { heartbeat(presence.gen, true); }
  });

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
      : isBanned() ? 'You are temporarily banned'
      : state.kafka === 'DOWN' ? 'Write a message (Kafka unavailable, messages may be delayed)' : 'Write a message';
  }

  function retryDelayMs(res) {
    var n = parseInt(res && res.headers ? res.headers.get('Retry-After') : '', 10);
    if (isNaN(n)) n = 5;
    return Math.min(30, Math.max(3, n)) * 1000;
  }

  // Outcome unknown (Kafka did not confirm / network error): keep the line and resend with the SAME messageId.
  function unconfirmed(p, delayMs) {
    p.el.classList.remove('pending');
    p.el.classList.add('unconfirmed');
    if (p.attempts >= MAX_ATTEMPTS) {
      setStatus(p, 'not confirmed – it may still appear'); // stays pending: a late result still resolves the line
      return;
    }
    setStatus(p, 'not confirmed yet – retrying…');
    p.timer = setTimeout(function () { p.timer = null; attempt(p); }, delayMs);
  }

  // Definite failure: nothing was accepted, so drop the line and give the text back.
  function failMessage(p, message, status, err) {
    state.pending.delete(p.messageId);
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    p.el.remove();
    state.lastFailed = { text: p.text, messageId: p.messageId };
    if (!els.text.value || p.attempts <= 1) els.text.value = p.text;
    if (status === 401) { signOut(); setError(els['send-error'], 'Your session expired. Please sign in again.'); }
    else if (status === 403 && err && err.error === 'BANNED') { startBan(err.bannedUntil, err.remainingSeconds); }
    else if (status === 409 && err && err.error === 'HANDLE_REQUIRED') { openHandleDialog(); }
    else setError(els['send-error'], message);
  }

  async function attempt(p) {
    if (p.stopped) return;
    if (p.stopped || state.pending.get(p.messageId) !== p) return; // already resolved by the stream
    if (!state.token) { setStatus(p, 'not confirmed – it may still appear'); return; }
    p.attempts++;
    var res;
    try {
      res = await authedFetch(apiBase() + '/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: p.text, messageId: p.messageId }),
      });
    } catch (e) {
      if (p.stopped || state.pending.get(p.messageId) !== p) return;
      unconfirmed(p, 5000);
      return;
    }
    if (p.stopped || state.pending.get(p.messageId) !== p) return; // result arrived meanwhile
    if (res.status === 202) {
      state.lastFailed = null;
      p.el.classList.remove('unconfirmed');
      setStatus(p, 'checking…');
      return; // the stream (or history) resolves it
    }
    var err = {};
    try { err = await res.json(); } catch (e) { /* no body */ }
    if (p.stopped || state.pending.get(p.messageId) !== p) return;
    if (res.status === 503 && err && err.status === 'UNCONFIRMED') { unconfirmed(p, retryDelayMs(res)); return; }
    if (res.status === 503 && err && err.error === 'UNAVAILABLE') {
      failMessage(p, 'Service temporarily unavailable. Please try again.', 503, err);
    } else if (res.status >= 500) {
      unconfirmed(p, retryDelayMs(res)); // may have reached Kafka
    } else {
      failMessage(p, 'Could not send message (HTTP ' + res.status + ').', res.status, err);
    }
  }

  function sendMessage(text, messageId) {
    setError(els['send-error'], '');
    var line = userLine(state.me.handle, text, new Date().toISOString(), 'pending');
    line.appendChild(el('span', 'status', 'checking…'));
    appendLine(line);
    if (!messageId || state.pending.has(messageId)) messageId = newMessageId(); // never overwrite a pending entry
    var p = { text: text, el: line, messageId: messageId, attempts: 0, timer: null, stopped: false };
    // register before the POST so a stream result that beats the response still resolves the line
    state.pending.set(p.messageId, p);
    return attempt(p);
  }

  els.composer.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = els.text.value.trim();
    if (!text || els.send.disabled) return;
    var id = null;
    if (state.lastFailed && state.lastFailed.text === text) id = state.lastFailed.messageId;
    state.lastFailed = null;
    els.text.value = '';
    sendMessage(text, id);
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
      var res = await authedFetch('/api/me/handle', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
  async function loadModerationLog() {
    try {
      var res = await authedFetch('/api/admin/moderation-log?limit=200', { cache: 'no-store' });
      if (res.status === 401) { signOut(); return; }
      if (res.ok) {
        var rows = await res.json();
        rows.slice().reverse().forEach(addModerationRow);
      }
    } catch (e) { /* ignore */ }
  }
  function startAdmin() {
    if (stopAdminStream) return;
    state.logRows = [];
    state.cards.clear();
    els.cards.textContent = '';
    els['log-body'].textContent = '';
    stopAdminStream = startSse('/api/admin/stream', true, function (name, row) {
      if (name === 'moderation') addModerationRow(row);
      else if (name === 'resync') loadModerationLog();
    }, {
      afterConnect: loadModerationLog,
      onForbidden: function () {
        // 403 is final: not an admin (anymore); stop retrying and hide the admin UI
        if (state.me) state.me.isAdmin = false;
        renderMe();
      },
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
      var res = await authedFetch('/api/audit-logs', { cache: 'no-store' });
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
      google.accounts.id.initialize({
        client_id: state.config.googleClientId, callback: onCredential, auto_select: true,
      });
      google.accounts.id.renderButton(els['gsi-button'], { theme: 'outline', size: 'medium', type: 'standard' });
      state.gisReady = true;
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
    renderVersion();

    // public stream; after every (re)connect (and on resync) re-fetch history, dedupe by messageId
    startSse('/api/chat/stream', false, function (name, ev) {
      if (name === 'message' || name === 'removed') handleChatEvent(name, ev);
      else if (name === 'kafka') { state.kafkaVer++; setKafka(ev && ev.status); }
      else if (name === 'resync') loadHistory();
    }, {
      afterConnect: function () { loadHistory(); loadKafkaStatus(); },
      onState: function (on) { state.sse = on; renderConn(); },
    });
    loadKafkaStatus();

    var saved = safeStore('get', TOKEN_KEY);
    await initAuth(); // GIS must be ready before any 401 can trigger a silent renewal
    if (saved) { setToken(saved); await refreshMe(); }
    renderMe();
  }
  boot();
})();
