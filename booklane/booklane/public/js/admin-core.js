/* Admin SPA core: API, routing, layout, helpers */
(function () {
  'use strict';
  const A = (window.A = { routes: [], me: null, cache: {} });
  const esc = (A.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  A.$ = (s, r = document) => r.querySelector(s);
  A.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  A.api = async (method, url, body) => {
    const res = await fetch('/api/admin' + url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = null; try { data = await res.json(); } catch (e) { /* non-json */ }
    if (res.status === 401 && !url.startsWith('/auth/') && !location.hash.startsWith('#/accept/')) { A.me = null; location.hash = '#/login'; }
    if (!res.ok) { const err = new Error((data && data.error) || `Request failed (${res.status})`); err.status = res.status; err.details = data && data.details; throw err; }
    return data;
  };

  A.toast = (msg, isErr) => {
    const t = document.createElement('div');
    t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t); setTimeout(() => t.remove(), isErr ? 5000 : 2600);
  };
  A.guard = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) A.toast(okMsg); return r; } catch (e) { A.toast(e.message, true); throw e; } };

  // ---- formatting ----
  A.tz = () => (A.me && A.me.user.timezone) || 'America/Chicago';
  A.money = (n, cur) => window.BLPricing.money(n, cur || 'USD');
  A.parseTs = (s) => (s ? Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : NaN);
  A.dt = (s, o) => { const t = A.parseTs(s); return isNaN(t) ? '' : new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: A.tz(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, o || {})).format(new Date(t)); };
  A.date = (s) => { if (!s) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(s + 'T12:00:00Z')); return A.dt(s, { hour: undefined, minute: undefined, year: 'numeric' }); };
  A.ago = (s) => {
    const t = A.parseTs(s); if (isNaN(t)) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`; const h = Math.round(m / 60); if (h < 24) return `${h}h ago`; const d = Math.round(h / 24); if (d < 30) return `${d}d ago`; return A.date(s);
  };
  A.label = (s) => String(s || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  A.pill = (s) => `<span class="pill ${esc(s)}">${esc(A.label(s))}</span>`;
  A.name = (l) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.phone || 'Anonymous visitor';
  A.minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  A.timeToMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  A.timeOptions = (sel, step = 15) => { let o = ''; for (let m = 0; m <= 1440; m += step) { const lbl = m === 1440 ? '12:00am (end)' : new Date(Date.UTC(2000, 0, 1, 0, m)).toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).toLowerCase(); o += `<option value="${m}" ${m === sel ? 'selected' : ''}>${lbl}</option>`; } return o; };
  A.tzSelect = (name, sel) => {
    let all = ['America/Chicago']; try { all = Intl.supportedValuesOf('timeZone'); } catch (e) { /* ignore */ }
    if (sel && !all.includes(sel)) all.unshift(sel);
    return `<select class="select" name="${name}" data-bind="${name}">${all.map((t) => `<option ${t === sel ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
  };

  // ---- form binding: [data-bind="a.b.c"] with data-type = number|bool|lines|json ----
  A.setPath = (obj, path, val) => { const ks = path.split('.'); let o = obj; ks.slice(0, -1).forEach((k) => { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; o = o[k]; }); o[ks[ks.length - 1]] = val; return obj; };
  A.getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  A.collect = (root) => {
    const out = {};
    for (const el of A.$$('[data-bind]', root)) {
      const type = el.dataset.type;
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (type === 'number') v = el.value === '' ? null : Number(el.value);
      if (type === 'lines') v = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (type === 'json') { try { v = JSON.parse(el.value || '{}'); } catch (e) { throw new Error(`"${el.dataset.bind}" must be valid JSON`); } }
      if (el.type === 'radio') { if (!el.checked) continue; v = el.value; }
      A.setPath(out, el.dataset.bind, v);
    }
    return out;
  };
  A.showErrors = (root, details) => {
    A.$$('.field.has-error', root).forEach((f) => { f.classList.remove('has-error'); const e = A.$('.field-error', f); if (e) e.remove(); });
    for (const [k, msg] of Object.entries(details || {})) {
      const el = root.querySelector(`[name="${k}"], [data-bind="${k}"]`);
      const f = el && el.closest('.field');
      if (f) { f.classList.add('has-error'); f.insertAdjacentHTML('beforeend', `<div class="field-error">${esc(msg)}</div>`); }
    }
  };
  A.field = (label, input, help) => `<div class="field"><label>${esc(label)}</label>${input}${help ? `<div class="help">${help}</div>` : ''}</div>`;
  A.input = (bind, val, attrs = '') => `<input class="input" data-bind="${bind}" name="${bind}" value="${esc(val ?? '')}" ${attrs}>`;
  A.textarea = (bind, val, attrs = '') => `<textarea class="textarea" data-bind="${bind}" name="${bind}" ${attrs}>${esc(val ?? '')}</textarea>`;
  A.toggle = (bind, on, label) => `<label class="toggle"><input type="checkbox" data-bind="${bind}" ${on ? 'checked' : ''}><span class="sw"></span><span>${esc(label)}</span></label>`;
  A.select = (bind, val, options, attrs = '') => `<select class="select" data-bind="${bind}" name="${bind}" ${attrs}>${Object.entries(options).map(([k, v]) => `<option value="${esc(k)}" ${String(k) === String(val) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
  A.copy = async (text) => { try { await navigator.clipboard.writeText(text); A.toast('Copied'); } catch (e) { A.toast('Copy failed. Select and copy manually.', true); } };

  // ---- drawer / modal ----
  A.drawer = (html, mount) => {
    A.closeDrawer();
    const wrap = document.createElement('div');
    wrap.className = 'drawer-back'; wrap.innerHTML = `<div class="drawer" role="dialog" aria-modal="true">${html}</div>`;
    wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close-drawer]')) A.closeDrawer(); });
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
    if (mount) mount(wrap.firstElementChild);
    return wrap.firstElementChild;
  };
  A.closeDrawer = () => { A.$$('.drawer-back').forEach((d) => d.remove()); document.body.style.overflow = ''; };
  addEventListener('keydown', (e) => { if (e.key === 'Escape') A.closeDrawer(); });

  // ---- routing ----
  A.route = (pattern, view) => { const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$'); A.routes.push({ re, keys, view, pattern }); };
  A.parseHash = () => { const h = location.hash.slice(1) || '/'; const [path, qs] = h.split('?'); return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) }; };
  A.go = (h) => { if (location.hash === h) A.render(); else location.hash = h; };

  const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const NAV = [
    ['Overview', null],
    ['/', 'Dashboard', ICON('<path d="M3 13h8V3H3zM13 21h8V11h-8zM13 3v6h8V3zM3 21h8v-6H3z"/>')],
    ['/leads', 'Leads', ICON('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>')],
    ['/bookings', 'Bookings', ICON('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>')],
    ['/quotes', 'Quotes', ICON('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h4"/>')],
    ['Setup', null],
    ['/event-types', 'Booking pages', ICON('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')],
    ['/availability', 'Availability', ICON('<path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 1 .5 4"/><path d="M3 4v5h5"/>')],
    ['/calendars', 'Calendars', ICON('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>')],
    ['/catalog', 'Quote catalog', ICON('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>')],
    ['/share', 'Share & embed', ICON('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>')],
    ['Business', null],
    ['/team', 'Team', ICON('<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M21 21v-2a4 4 0 0 0-3-3.9"/>')],
    ['/settings', 'Settings', ICON('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')],
  ];

  function shell(active) {
    const me = A.me;
    const biz = me.business;
    return `<div class="mobile-bar"><button type="button" data-menu aria-label="Menu">☰</button><span>${esc(biz ? biz.name : 'Booklane')}</span><a href="${biz ? '/b/' + esc(biz.slug) : '#'}" target="_blank" style="color:#fff;font-size:13px">View page ↗</a></div>
    <div class="layout"><nav class="sidebar" aria-label="Main">
      <div class="brand-row"><div class="logo-mark"></div>${esc((window.__BL__ || {}).appName || 'Booklane')}</div>
      <div class="biz-switch"><label class="sr-only" for="bizsel">Business</label><select id="bizsel">${me.businesses.map((b) => `<option value="${b.id}" ${biz && b.id === biz.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}<option value="__new">+ Add a business</option></select></div>
      <div class="nav">${NAV.map((n) => n[1] === null ? `<div class="nav-sec">${n[0]}</div>` : `<a href="#${n[0]}" class="${active === n[0] ? 'active' : ''}">${n[2]}<span>${n[1]}</span></a>`).join('')}</div>
      <div class="sidebar-foot">${biz ? `<a href="/b/${esc(biz.slug)}" target="_blank" rel="noopener">View booking page ↗</a>` : ''}<a href="#/account">${esc(me.user.name)} · Account</a><button type="button" data-logout>Log out</button></div>
    </nav><main class="main" id="view"></main></div>`;
  }

  A.render = async () => {
    const { path, query } = A.parseHash();
    const app = document.getElementById('app');
    if (!A.me && !['/login', '/signup'].includes(path) && !path.startsWith('/accept/')) {
      try { A.me = await A.api('GET', '/auth/me'); } catch (e) { location.hash = '#/login'; return; }
    }
    let match = null, params = {};
    for (const r of A.routes) { const m = r.re.exec(path); if (m) { match = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; } }
    if (!match) { location.hash = '#/'; return; }
    const v = match.view;
    A.closeDrawer();
    if (v.public) { app.innerHTML = '<div id="view"></div>'; }
    else {
      const section = '/' + (path.split('/')[1] || '');
      app.innerHTML = shell(section === '/' ? '/' : section);
    }
    const root = document.getElementById('view');
    document.title = `${v.title ? (typeof v.title === 'function' ? v.title(params) : v.title) + ' · ' : ''}${(window.__BL__ || {}).appName || 'Booklane'}`;
    root.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
    try {
      const html = await v.render(params, query, root);
      if (typeof html === 'string') root.innerHTML = html;
      if (v.mount) v.mount(root, params, query);
    } catch (e) {
      if (e.status === 401) return;
      root.innerHTML = `<div class="panel"><div class="empty-state"><h3>Could not load this page</h3><p>${esc(e.message)}</p>${e.status === 403 ? '' : '<button class="btn btn-ghost" onclick="A.render()">Try again</button>'}</div></div>`;
    }
  };

  document.addEventListener('click', async (e) => {
    if (e.target.closest('[data-menu]')) { A.$('.sidebar').classList.toggle('open'); return; }
    if (e.target.closest('.sidebar a')) A.$('.sidebar') && A.$('.sidebar').classList.remove('open');
    if (e.target.closest('[data-logout]')) { await A.api('POST', '/auth/logout', {}); A.me = null; location.hash = '#/login'; }
    const cp = e.target.closest('[data-copy]');
    if (cp) A.copy(cp.dataset.copy);
  });
  document.addEventListener('change', async (e) => {
    if (e.target.id !== 'bizsel') return;
    if (e.target.value === '__new') {
      const name = prompt('Name of the new business');
      if (!name) { e.target.value = A.me.business.id; return; }
      await A.guard(() => A.api('POST', '/businesses', { name }), 'Business created');
    } else await A.api('POST', '/auth/switch', { business_id: Number(e.target.value) });
    A.me = await A.api('GET', '/auth/me'); A.go('#/');
  });
  addEventListener('hashchange', A.render);
  A.start = () => A.render();
})();
