/* Shared helpers for public pages */
(function () {
  'use strict';
  const BL = (window.BL = window.BL || {});
  BL.data = window.__BL__ || {};

  BL.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  BL.$ = (sel, root = document) => root.querySelector(sel);
  BL.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  BL.api = async function (method, url, body, opts = {}) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, keepalive: !!opts.keepalive, credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) { const err = new Error((data && data.error) || 'Something went wrong. Please try again.'); err.status = res.status; err.details = data && data.details; throw err; }
    return data;
  };

  BL.store = {
    get(k) { try { return JSON.parse(localStorage.getItem('bl:' + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('bl:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('bl:' + k); } catch (e) { /* ignore */ } },
  };

  BL.icons = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m22 8-6 4 6 4z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    left: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>',
    check: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    doc: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 13h6M9 17h4"/></svg>',
    tag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
    callback: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M21 3l-6 6"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg>',
  };
  BL.locIcon = (t) => (t === 'phone' ? BL.icons.phone : t === 'in_person' ? BL.icons.pin : BL.icons.video);

  // ---- Time helpers ----
  BL.guessTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago'; } catch (e) { return 'America/Chicago'; } };
  BL.fmtTime = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).toLowerCase().replace(' ', '');
  BL.fmtDate = (iso, tz, o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }, o || {})).format(new Date(iso));
  BL.fmtDateStr = (d, o) => new Intl.DateTimeFormat('en-US', Object.assign({ timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, o || {})).format(new Date(d + 'T12:00:00Z'));
  BL.todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  BL.tzLabel = (tz) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
      const abbr = (parts.find((p) => p.type === 'timeZoneName') || {}).value || '';
      return `${tz.replace(/_/g, ' ').replace(/^.*\//, '')} (${abbr})`;
    } catch (e) { return tz; }
  };
  const COMMON_TZ = ['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', 'America/Anchorage', 'Pacific/Honolulu', 'America/Halifax', 'Europe/London', 'Europe/Paris', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
  BL.tzOptions = (selected) => {
    let all = COMMON_TZ;
    try { all = Array.from(new Set(COMMON_TZ.concat(Intl.supportedValuesOf('timeZone')))); } catch (e) { /* older browsers */ }
    if (selected && !all.includes(selected)) all = [selected].concat(all);
    return all.map((tz, i) => `${i === COMMON_TZ.length ? '<option disabled>──────────</option>' : ''}<option value="${BL.esc(tz)}"${tz === selected ? ' selected' : ''}>${BL.esc(BL.tzLabel(tz))}</option>`).join('');
  };

  // ---- Lead meta (UTM, referrer) ----
  BL.leadMeta = () => {
    const p = new URLSearchParams(location.search);
    const utm = {};
    for (const [k, v] of p) if (/^utm_|^gclid$|^fbclid$/.test(k)) utm[k] = v;
    // When embedded, the iframe's own URL is useless for attribution: the embed script
    // passes the host page in ?src, and we fall back to the referrer if it didn't.
    const embedded = !!BL.data.embed;
    const page = embedded ? (p.get('src') || document.referrer || '') : location.href;
    return { utm, referrer: document.referrer || '', landing: location.href, embedded,
      page_url: page, page_title: p.get('stitle') || (embedded ? '' : document.title) };
  };

  // ---- Autosaver: debounced PATCH + beacon on page hide ----
  BL.createSaver = function ({ url, beaconUrl, onState }) {
    let pending = null, timer = null, inflight = null;
    const set = (s) => onState && onState(s);
    async function flush() {
      clearTimeout(timer); timer = null;
      if (!pending || !url()) return;
      const body = pending; pending = null;
      set('saving');
      try { inflight = BL.api('PATCH', url(), body); await inflight; set('saved'); } catch (e) { set('error'); pending = Object.assign({}, body, pending || {}); } finally { inflight = null; }
    }
    function queue(patch, immediate) {
      pending = mergePatch(pending || {}, patch);
      clearTimeout(timer);
      if (immediate) return flush();
      timer = setTimeout(flush, 700);
    }
    function mergePatch(a, b) {
      const out = Object.assign({}, a, b);
      for (const k of ['answers', 'contact', 'details']) if (a[k] || b[k]) out[k] = Object.assign({}, a[k] || {}, b[k] || {});
      return out;
    }
    function beacon() {
      if (!pending || !beaconUrl()) return;
      try { navigator.sendBeacon(beaconUrl(), new Blob([JSON.stringify(pending)], { type: 'text/plain' })); pending = null; } catch (e) { /* ignore */ }
    }
    addEventListener('pagehide', beacon);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') beacon(); });
    return { queue, flush, wait: () => inflight || Promise.resolve() };
  };

  // ---- Embed auto-height ----
  if (BL.data.embed && window.parent !== window) {
    const post = () => window.parent.postMessage({ type: 'booklane:height', height: Math.ceil(document.documentElement.scrollHeight) }, '*');
    try { new ResizeObserver(post).observe(document.body); } catch (e) { setInterval(post, 800); }
    addEventListener('load', post);
  }

  BL.logo = (b) => b.logo_url ? `<div class="biz-logo"><img src="${BL.esc(b.logo_url)}" alt=""></div>` : `<div class="biz-logo">${BL.esc((b.name || '?').trim().charAt(0).toUpperCase())}</div>`;
  BL.powered = () => BL.data.embed ? '' : `<div class="powered">Scheduling by ${BL.esc(BL.data.appName || 'Booklane')}</div>`;

  BL.fieldErrors = (root, details) => {
    BL.$$('.field.has-error', root).forEach((f) => { f.classList.remove('has-error'); const e = BL.$('.field-error', f); if (e) e.remove(); });
    if (!details) return;
    let first = null;
    for (const [k, msg] of Object.entries(details)) {
      const input = root.querySelector(`[name="${k}"]`);
      const field = input && input.closest('.field');
      if (!field) continue;
      field.classList.add('has-error');
      field.insertAdjacentHTML('beforeend', `<div class="field-error">${BL.esc(msg)}</div>`);
      first = first || input;
    }
    if (first) first.focus();
  };
})();
