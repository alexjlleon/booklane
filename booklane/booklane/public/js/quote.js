/* Build-your-own quote flow */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, catalog = D.catalog || [], qs = biz.settings.quote;
  const P = window.BLPricing;
  const cur = qs.currency || 'USD';
  const money = (n) => P.money(n, cur);
  const params = new URLSearchParams(location.search);
  const storeKey = `quote:${biz.slug}`;
  const app = document.getElementById('app');

  const STEP_DEFS = {
    details: { title: 'Tell us about your event', subtitle: 'This helps us check your date and tailor your options.' },
    services: { title: 'Choose your services', subtitle: qs.intro },
    contact: { title: 'Where should we send your quote?', subtitle: 'We will email you a copy so you can come back to it anytime.' },
    review: { title: 'Your custom quote', subtitle: 'Here is everything you picked. What would you like to do next?' },
  };
  const order = qs.contact_step_position === 'first' ? ['contact', 'details', 'services', 'review'] : ['details', 'services', 'contact', 'review'];

  const st = {
    i: 0, details: { event_type: '', event_date: '', city: '', venue: '', guests: '' }, sel: {}, open: null,
    contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    quoteToken: null, leadToken: null, status: 'draft', busy: false, error: null, modal: null, done: null, saveState: '',
  };

  // ---- persistence ----
  const saver = BL.createSaver({
    url: () => st.quoteToken && `/api/public/quotes/${st.quoteToken}`,
    beaconUrl: () => st.leadToken && `/api/public/leads/${st.leadToken}/beacon`,
    onState: (s) => { st.saveState = s; const el = $('.save-state'); if (el) { el.className = 'save-state ' + s; el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Progress saved' : ''; } },
  });
  let creating = null;
  function ensureQuote() {
    if (st.quoteToken) return Promise.resolve(st.quoteToken);
    if (!creating) creating = api('POST', `/api/public/b/${biz.slug}/quotes`, { meta: BL.leadMeta() }).then((r) => {
      st.quoteToken = r.token; st.leadToken = r.lead_token; BL.store.set(storeKey, { token: r.token, at: Date.now() }); return r.token;
    }).catch(() => { creating = null; return null; });
    return creating;
  }
  const selections = () => Object.values(st.sel);
  const progress = () => ({ step_index: st.i, step_key: order[st.i], step_total: order.length });
  function capture(patch, immediate) { ensureQuote().then((t) => t && saver.queue(Object.assign(progress(), patch), immediate)); }

  // ---- pricing ----
  const calc = () => P.calculate(catalog, selections(), qs);
  function defaultSelection(s) {
    const options = {};
    for (const g of s.option_groups || []) {
      if (g.required) { const d = (g.choices || []).find((c) => c.default) || (g.choices || [])[0]; if (d) options[g.id] = g.multi ? [d.id] : d.id; }
      else options[g.id] = g.multi ? [] : '';
    }
    return { service_id: s.id, qty: s.pricing_type === 'flat' ? 1 : s.default_qty || s.min_qty || 1, options, addons: {} };
  }

  // ---- render helpers ----
  const field = (name, label, input, req) => `<div class="field"><label for="f-${name}">${esc(label)}${req ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
  const cards = (name, options, value) => `<div class="options">${options.map((o) => `<label class="opt radio ${o === value ? 'is-on' : ''}"><input type="radio" name="${name}" value="${esc(o)}" ${o === value ? 'checked' : ''} data-detail="${name}"><span class="tick"></span><span>${esc(o)}</span></label>`).join('')}</div>`;

  function renderDetails() {
    const d = st.details;
    return `<form class="step-form" novalidate>
      <div class="field"><span class="label">What are you celebrating?</span>${cards('event_type', qs.event_types || [], d.event_type)}</div>
      <div class="grid-2">
        ${field('event_date', 'Event date', `<input class="input" type="date" id="f-event_date" name="event_date" min="${BL.todayIn(biz.timezone)}" value="${esc(d.event_date)}" data-detail="event_date">`, qs.require_event_date)}
        ${(qs.cities || []).length ? field('city', 'City / area', `<select class="select" id="f-city" name="city" data-detail="city"><option value="">Select…</option>${qs.cities.map((c) => `<option ${c === d.city ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>`) : field('city', 'City', `<input class="input" id="f-city" name="city" value="${esc(d.city)}" data-detail="city">`)}
      </div>
      ${field('venue', 'Venue (if you have one)', `<input class="input" id="f-venue" name="venue" value="${esc(d.venue)}" placeholder="Not booked yet? Leave blank" data-detail="venue">`)}
      ${(qs.guest_ranges || []).length ? `<div class="field"><span class="label">Guest count</span>${cards('guests', qs.guest_ranges, d.guests)}</div>` : ''}
    </form>`;
  }

  function stepper(attrs, value, min, max) {
    return `<span class="stepper"><button type="button" ${attrs} data-delta="-1" aria-label="Less">−</button><input type="number" inputmode="numeric" ${attrs} value="${value}" min="${min}" max="${max}" aria-label="Quantity"><button type="button" ${attrs} data-delta="1" aria-label="More">+</button></span>`;
  }

  function renderService(s) {
    const on = !!st.sel[s.id];
    const sel = st.sel[s.id];
    const line = on ? P.priceService(s, sel) : null;
    const from = P.startingPrice(s);
    const priceLabel = on ? `<span>${money(line.amount)}</span>` : `<span>${s.pricing_type === 'flat' && !(s.option_groups || []).some((g) => g.mode === 'base') ? '' : 'from '}${money(from)}</span><small>${s.pricing_type === 'per_unit' ? `${s.min_qty}+ ${esc(s.unit_label || 'units')}` : s.pricing_type === 'hourly' ? `${s.min_qty} hr min` : ''}</small>`;
    let body = '';
    if (on) {
      const qty = s.pricing_type !== 'flat' ? `<div class="qty-row">${stepper(`data-qty="${s.id}"`, sel.qty, s.min_qty, s.max_qty)}<span>${esc(s.unit_label || (s.pricing_type === 'hourly' ? 'hours' : 'units'))}</span></div>` : '';
      const groups = (s.option_groups || []).map((g) => {
        const val = sel.options[g.id];
        const isOn = (c) => (g.multi ? [].concat(val || []).includes(c.id) : val === c.id);
        return `<div><div class="svc-group-title">${esc(g.name)}${g.multi ? ' · pick any' : ''}</div><div class="choice-grid">${(g.choices || []).map((c) => `<button type="button" class="choice ${isOn(c) ? 'is-on' : ''}" data-svc="${s.id}" data-group="${esc(g.id)}" data-choice="${esc(c.id)}" aria-pressed="${isOn(c)}">
          <span class="cn"><span>${esc(c.name)}</span><span>${g.mode === 'base' ? money(c.price) : (c.price >= 0 ? '+' : '') + money(c.price)}</span></span>${c.description ? `<span class="cd">${esc(c.description)}</span>` : ''}</button>`).join('')}</div></div>`;
      }).join('');
      const addons = (s.addons || []).length ? `<div><div class="svc-group-title">Add-ons</div>${s.addons.map((a) => {
        const q = sel.addons[a.id] || 0;
        const control = (a.max || 1) > 1 ? stepper(`data-addon="${esc(a.id)}" data-svc="${s.id}"`, q, 0, a.max) : `<label class="check" style="margin:0"><input type="checkbox" data-addon="${esc(a.id)}" data-svc="${s.id}" ${q ? 'checked' : ''}><span class="sr-only">Add</span></label>`;
        return `<div class="addon"><span class="an">${esc(a.name)}${a.description ? `<div class="muted small" style="font-weight:400">${esc(a.description)}</div>` : ''}</span><span class="ap">+${money(a.price)}${a.per === 'unit' ? ' each ' + esc(s.unit_label || 'unit') : (a.max || 1) > 1 ? ' each' : ''}</span>${control}</div>`;
      }).join('')}</div>` : '';
      body = `<div class="svc-body">${qty}${groups}${addons}</div>`;
    }
    return `<div class="svc ${on ? 'is-on' : ''}" data-service="${s.id}">
      <button type="button" class="svc-head" data-toggle="${s.id}" aria-expanded="${on}"><span class="tick"></span>
        <span style="flex:1"><span class="svc-title">${esc(s.name)}${s.badge ? `<span class="badge">${esc(s.badge)}</span>` : ''}</span>${s.description ? `<span class="svc-desc">${esc(s.description)}</span>` : ''}</span>
        <span class="svc-price">${priceLabel}</span></button>${body}</div>`;
  }

  function renderServices() {
    const cats = [];
    for (const s of catalog) { const c = s.category || ''; let g = cats.find((x) => x.c === c); if (!g) cats.push((g = { c, items: [] })); g.items.push(s); }
    const hint = calc().next_bundle;
    return `${hint && selections().length ? `<div class="q-hint" style="margin-bottom:14px">Add ${hint.needed} more service${hint.needed > 1 ? 's' : ''} to save ${hint.percent}%</div>` : ''}
      ${cats.map((g) => `${g.c ? `<div class="svc-group-title" style="margin:18px 0 10px">${esc(g.c)}</div>` : ''}<div class="svc-list">${g.items.map(renderService).join('')}</div>`).join('')}
      ${catalog.length ? '' : '<div class="empty">No services have been added yet.</div>'}`;
  }

  function renderContact() {
    const c = st.contact;
    const inp = (name, type, auto, ph) => `<input class="input" id="f-${name}" name="${name}" type="${type}" autocomplete="${auto}" value="${esc(c[name] || '')}" placeholder="${esc(ph || '')}" data-contact>`;
    return `<form class="step-form" novalidate><div class="grid-2">${field('first_name', 'First name', inp('first_name', 'text', 'given-name'), true)}${field('last_name', 'Last name', inp('last_name', 'text', 'family-name'))}</div>
      ${field('email', 'Email', inp('email', 'email', 'email', 'you@example.com'), true)}${field('phone', 'Phone', inp('phone', 'tel', 'tel', '(555) 555-5555'))}
      <label class="check"><input type="checkbox" name="sms_consent" data-contact ${c.sms_consent ? 'checked' : ''}><span>${esc(biz.settings.sms_consent_text)}</span></label>
      ${biz.settings.privacy_note ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}</form>`;
  }

  function lineDesc(l) {
    return [l.options.map((o) => o.name).join(', '), l.pricing_type !== 'flat' ? `${l.qty} ${l.unit_label || ''}` : '', l.addons.map((a) => `${a.name}${a.qty > 1 ? ' ×' + a.qty : ''}`).join(', ')].filter(Boolean).join(' · ');
  }

  function renderReview() {
    const c = calc();
    const ns = qs.next_steps || {};
    const d = st.details;
    if (st.done) return renderDone();
    return `<div class="muted small" style="margin-bottom:10px">${esc([d.event_type, d.event_date ? BL.fmtDateStr(d.event_date) : '', d.city, d.guests ? d.guests + ' guests' : ''].filter(Boolean).join(' · '))}</div>
      <table class="review-table">${c.lines.map((l) => `<tr><td><b>${esc(l.name)}</b><div class="sub">${esc(lineDesc(l))}</div></td><td>${money(l.amount)}</td></tr>`).join('')}
      ${c.discount ? `<tr><td class="disc" style="color:var(--ok)">${esc(c.discount_label)}</td><td style="color:var(--ok)">−${money(c.discount)}</td></tr>` : ''}
      ${c.tax ? `<tr><td>Tax (${c.tax_rate}%)</td><td>${money(c.tax)}</td></tr>` : ''}
      <tr><td><b style="font-size:18px">Total</b>${c.deposit ? `<div class="sub">${money(c.deposit)} deposit reserves your date</div>` : ''}</td><td style="font-size:22px">${money(c.total)}</td></tr></table>
      <p class="terms">${esc(qs.terms)}</p>
      <h3 style="margin:26px 0 12px;font-size:17px">What's next?</h3>
      <div class="next-steps">
        ${ns.contract ? `<button type="button" class="ns primary" data-action="contract"><span class="dot">${icons.doc}</span><h4>Request my contract</h4><p>Lock in these prices. We confirm your date and send the contract.</p></button>` : ''}
        ${ns.book_call && D.callEventSlug ? `<button type="button" class="ns" data-action="book"><span class="dot">${icons.cal.replace('<svg', '<svg width="20" height="20"')}</span><h4>Book a call</h4><p>Pick a time to walk through your quote with our team.</p></button>` : ''}
        ${ns.callback ? `<button type="button" class="ns" data-action="callback"><span class="dot">${icons.callback}</span><h4>Have us call me</h4><p>Tell us when is best and we will reach out.</p></button>` : ''}
      </div>
      <p class="small muted" style="margin-top:16px">Your quote is saved. <a href="/q/${esc(st.quoteToken || '')}" target="_blank" rel="noopener">View or share it</a></p>`;
  }

  function renderDone() {
    const map = {
      contract: ['Contract request received!', `Thanks ${esc(st.contact.first_name)}! We are checking availability for your date and will email your contract to <b>${esc(st.contact.email)}</b> shortly.`],
      callback: ['We will call you soon!', `Expect a call at <b>${esc(st.contact.phone)}</b>. We also emailed a copy of your quote to <b>${esc(st.contact.email)}</b>.`],
    };
    const [h, p] = map[st.done];
    return `<div class="done"><div class="done-icon">${icons.check}</div><h2>${h}</h2><p class="muted">${p}</p>
      <div class="actions" style="margin-top:20px"><a class="btn btn-ghost" href="/q/${esc(st.quoteToken)}">View my quote</a>
      ${st.done === 'contract' && qs.next_steps.book_call && D.callEventSlug ? `<a class="btn btn-primary" href="/b/${esc(biz.slug)}/${esc(D.callEventSlug)}?quote=${esc(st.quoteToken)}${BL.data.embed ? '&embed=1' : ''}">Also book a call</a>` : ''}</div></div>`;
  }

  function sidePanel() {
    const c = calc();
    return `<aside class="card quote-side" aria-live="polite">
      <div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <h3>Your quote</h3>
      ${c.lines.length ? `<div class="q-lines">${c.lines.map((l) => `<div class="q-line"><div><div class="n">${esc(l.name)}</div><div class="d">${esc(lineDesc(l))}</div></div><div class="a">${money(l.amount)}</div></div>`).join('')}</div>` : '<div class="muted small">Pick services to see your price build here.</div>'}
      ${c.lines.length ? `<div class="q-totals">${c.discount ? `<div class="disc"><span>${esc(c.discount_label)}</span><span>−${money(c.discount)}</span></div>` : ''}${c.tax ? `<div><span>Tax</span><span>${money(c.tax)}</span></div>` : ''}
        <div style="align-items:baseline"><span class="muted">Total</span><span class="q-total">${money(c.total)}</span></div>${c.deposit ? `<div class="muted small"><span>Deposit to book</span><span>${money(c.deposit)}</span></div>` : ''}</div>` : ''}
      ${c.next_bundle && c.lines.length ? `<div class="q-hint">Add ${c.next_bundle.needed} more to save ${c.next_bundle.percent}%</div>` : ''}
      <ul class="trust" style="margin-top:6px">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </aside>`;
  }

  function modalHtml() {
    if (!st.modal) return '';
    const c = st.contact, cf = qs.contract_fields || {};
    const inp = (name, label, type = 'text', val = '', req = false, ph = '') => field(name, label, `<input class="input" id="f-${name}" name="${name}" type="${type}" value="${esc(val)}" placeholder="${esc(ph)}">`, req);
    let inner = '';
    if (st.modal === 'contract') {
      inner = `<h3>Request your contract</h3><p class="muted" style="margin-top:0">Just a few details for the paperwork. Total: <b>${money(calc().total)}</b></p>
        ${st.error ? `<div class="form-error">${esc(st.error)}</div>` : ''}
        <form id="modal-form" novalidate>
        ${inp('legal_name', 'Name for the contract', 'text', [c.first_name, c.last_name].filter(Boolean).join(' '), true)}
        ${!st.details.event_date ? inp('event_date', 'Event date', 'date', '', !!qs.require_event_date) : ''}
        ${!c.phone ? inp('phone', 'Phone', 'tel', '', false) : ''}
        ${cf.event_start_time || cf.event_end_time ? `<div class="grid-2">${cf.event_start_time ? inp('event_start_time', 'Start time', 'time') : ''}${cf.event_end_time ? inp('event_end_time', 'End time', 'time') : ''}</div>` : ''}
        ${cf.venue_address ? inp('venue_address', 'Venue address', 'text', '', false, st.details.venue || '') : ''}
        ${cf.billing_address ? inp('billing_address', 'Billing address') : ''}
        ${cf.planner_name ? inp('planner_name', 'Planner or venue coordinator') : ''}
        ${field('notes', 'Anything we should know?', '<textarea class="textarea" id="f-notes" name="notes"></textarea>')}
        <label class="check" style="margin-bottom:16px"><input type="checkbox" name="agreed_terms" checked><span>${esc(qs.terms)}</span></label>
        <div class="step-nav" style="position:static;margin:0;padding-bottom:0"><button type="button" class="btn btn-link" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-lg" ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}Send my request</button></div></form>`;
    } else if (st.modal === 'callback') {
      inner = `<h3>When should we call?</h3><p class="muted" style="margin-top:0">We will go over your quote and answer any questions.</p>
        ${st.error ? `<div class="form-error">${esc(st.error)}</div>` : ''}
        <form id="modal-form" novalidate>
        ${inp('phone', 'Best number', 'tel', c.phone, true)}
        <div class="field"><span class="label">Best day</span>${cards('preferred_day', ['Today', 'Tomorrow', 'This week', 'Weekend'], '')}</div>
        <div class="field"><span class="label">Best time</span>${cards('preferred_time', ['Morning', 'Afternoon', 'Evening', 'Anytime'], '')}</div>
        ${field('notes', 'Questions for us', '<textarea class="textarea" id="f-notes" name="notes"></textarea>')}
        <div class="step-nav" style="position:static;margin:0;padding-bottom:0"><button type="button" class="btn btn-link" data-close>Cancel</button><button type="submit" class="btn btn-primary btn-lg" ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}Request a call</button></div></form>`;
    }
    return `<div class="modal-back${st.modalShown ? ' no-anim' : ''}" data-backdrop><div class="modal" role="dialog" aria-modal="true">${inner}</div></div>`;
  }

  function render() {
    const key = order[st.i];
    const def = STEP_DEFS[key];
    const body = key === 'details' ? renderDetails() : key === 'services' ? renderServices() : key === 'contact' ? renderContact() : renderReview();
    const c = calc();
    const isReview = key === 'review';
    const scrollY = window.scrollY;
    const keepModal = st.modal && $('.modal') ? true : false;
    app.innerHTML = `<div class="shell"><div class="quoter">
      <main class="card quoter-main">
        <div class="biz q-mobile-head">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
        ${st.done ? '' : `<div class="progress" aria-label="Step ${st.i + 1} of ${order.length}"><div class="progress-bar"><span style="width:${Math.round(((st.i + 1) / order.length) * 100)}%"></span></div><div class="progress-count">${st.i + 1} / ${order.length}</div></div>
        <div class="step-head"><h2>${esc(def.title)}</h2>${def.subtitle ? `<p>${esc(def.subtitle)}</p>` : ''}</div>`}
        ${st.error && !st.modal ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body" ${keepModal ? 'style="animation:none"' : ''}>${body}</div>
        ${isReview ? (st.done ? '' : `<div class="step-nav"><button type="button" class="btn btn-link" data-back>${icons.left} Edit quote</button><span class="save-state ${st.saveState}"></span></div>`) : `<div class="step-nav">
          <div>${st.i > 0 ? `<button type="button" class="btn btn-link" data-back>${icons.left} Back</button>` : `<span class="save-state ${st.saveState}"></span>`}</div>
          ${key !== 'details' && c.lines.length ? `<div class="nav-total">Total<b>${money(c.total)}</b></div>` : ''}
          <button type="button" class="btn btn-primary btn-lg" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${order[st.i + 1] === 'review' ? 'See my quote' : 'Continue'} ${st.busy ? '' : icons.right}</button>
        </div>`}
      </main>${sidePanel()}</div></div>${BL.powered()}${modalHtml()}`;
    if (keepModal) window.scrollTo(0, scrollY);
    st.modalShown = !!st.modal;
  }

  // Lightweight re-render of just the prices (keeps focus while typing quantities)
  function refreshTotals(serviceId) {
    const side = $('.quote-side');
    if (side) side.outerHTML = sidePanel();
    if (serviceId) {
      const s = catalog.find((x) => x.id === serviceId);
      const el = $(`.svc[data-service="${serviceId}"] .svc-price`);
      if (s && el && st.sel[serviceId]) el.innerHTML = `<span>${money(P.priceService(s, st.sel[serviceId]).amount)}</span>`;
    }
    const nt = $('.nav-total b');
    if (nt) nt.textContent = money(calc().total);
  }

  // ---- validation & navigation ----
  function validate(key) {
    const e = {};
    if (key === 'details' && qs.require_event_date && !st.details.event_date) e.event_date = 'Pick your date (an estimate is fine)';
    if (key === 'services' && !selections().length) { st.error = 'Pick at least one service to build your quote.'; return { _: 1 }; }
    if (key === 'contact') {
      if (!st.contact.first_name.trim()) e.first_name = 'Required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.contact.email.trim())) e.email = 'Enter a valid email';
    }
    return e;
  }

  async function go(dir) {
    const key = order[st.i];
    if (dir > 0) {
      const errs = validate(key);
      if (Object.keys(errs).length) { if (errs._) { render(); return; } BL.fieldErrors(app, errs); return; }
      st.error = null;
      st.i = Math.min(order.length - 1, st.i + 1);
      if (order[st.i] === 'review') {
        st.busy = true; render();
        try {
          await ensureQuote();
          saver.queue(Object.assign(progress(), { details: st.details, selections: selections(), contact: st.contact }), true);
          await saver.flush(); await saver.wait();
          if (st.status === 'draft') { const r = await api('POST', `/api/public/quotes/${st.quoteToken}/submit`, {}); st.status = r.quote.status; }
        } catch (err) {
          st.error = err.message;
          if (err.details) st.i = order.indexOf('contact');
        }
        st.busy = false;
      } else capture(key === 'contact' ? { contact: st.contact } : key === 'details' ? { details: st.details } : { selections: selections() }, true);
    } else { st.i = Math.max(0, st.i - 1); st.error = null; capture({}, true); }
    render();
    if (!BL.data.embed) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function submitModal(form) {
    const fd = Object.fromEntries(new FormData(form));
    st.busy = true; st.error = null; render();
    try {
      await ensureQuote();
      const patch = {};
      if (fd.phone) { st.contact.phone = fd.phone; patch.contact = { phone: fd.phone }; }
      if (fd.event_date) { st.details.event_date = fd.event_date; patch.details = { event_date: fd.event_date }; }
      if (Object.keys(patch).length) { saver.queue(patch, true); await saver.flush(); await saver.wait(); }
      if (st.modal === 'contract') await api('POST', `/api/public/quotes/${st.quoteToken}/contract`, Object.assign(fd, { agreed_terms: !!fd.agreed_terms }));
      else await api('POST', `/api/public/quotes/${st.quoteToken}/callback`, fd);
      st.done = st.modal; st.modal = null; BL.store.del(storeKey);
    } catch (err) { st.error = err.message; st.busy = false; render(); if (err.details) BL.fieldErrors($('.modal'), err.details); return; }
    st.busy = false; render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- events ----
  app.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-next]')) return go(1);
    if (t.closest('[data-back]')) { st.done = null; return go(-1); }
    if (t.closest('[data-close]') || (t.matches('[data-backdrop]'))) { st.modal = null; st.error = null; return render(); }
    const tog = t.closest('[data-toggle]');
    if (tog) {
      const id = Number(tog.dataset.toggle);
      const s = catalog.find((x) => x.id === id);
      if (st.sel[id]) delete st.sel[id]; else st.sel[id] = defaultSelection(s);
      st.error = null; render(); capture({ selections: selections() });
      return;
    }
    const ch = t.closest('[data-choice]');
    if (ch) {
      const s = catalog.find((x) => x.id === Number(ch.dataset.svc));
      const g = s.option_groups.find((x) => x.id === ch.dataset.group);
      const sel = st.sel[s.id];
      if (g.multi) { const arr = [].concat(sel.options[g.id] || []); const i = arr.indexOf(ch.dataset.choice); if (i >= 0) arr.splice(i, 1); else arr.push(ch.dataset.choice); sel.options[g.id] = arr; }
      else sel.options[g.id] = sel.options[g.id] === ch.dataset.choice && !g.required ? '' : ch.dataset.choice;
      render(); capture({ selections: selections() });
      return;
    }
    const delta = t.closest('[data-delta]');
    if (delta) {
      const input = delta.parentElement.querySelector('input');
      const v = Math.min(Number(input.max), Math.max(Number(input.min), (Number(input.value) || 0) + Number(delta.dataset.delta)));
      input.value = v; input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const act = t.closest('[data-action]');
    if (act) {
      const a = act.dataset.action;
      if (a === 'book') { location.href = `/b/${biz.slug}/${D.callEventSlug}?quote=${st.quoteToken}${BL.data.embed ? '&embed=1' : ''}`; return; }
      st.modal = a; st.error = null; render();
      const first = $('.modal input, .modal textarea'); if (first) first.focus();
    }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.id === 'modal-form') submitModal(e.target); else go(1); });
  app.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.modal) { st.modal = null; render(); } });
  function onInput(e) {
    const t = e.target;
    if (t.dataset.detail) {
      st.details[t.dataset.detail] = t.value;
      if (t.type === 'radio') $$(`input[name="${t.name}"]`, app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      capture({ details: { [t.dataset.detail]: t.value } }, t.type === 'radio' || e.type === 'change');
    } else if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      capture({ contact: { [t.name]: st.contact[t.name] } }, t.type === 'checkbox' || e.type === 'change');
    } else if (t.dataset.qty) {
      const id = Number(t.dataset.qty); const s = catalog.find((x) => x.id === id);
      const v = Math.round(Number(t.value));
      if (!Number.isFinite(v)) return;
      st.sel[id].qty = Math.min(s.max_qty, Math.max(s.min_qty, v));
      refreshTotals(id); capture({ selections: selections() });
    } else if (t.dataset.addon) {
      const id = Number(t.dataset.svc);
      const q = t.type === 'checkbox' ? (t.checked ? 1 : 0) : Math.max(0, Math.round(Number(t.value) || 0));
      st.sel[id].addons[t.dataset.addon] = q;
      refreshTotals(id); capture({ selections: selections() });
    } else if (t.closest('.modal') && t.type === 'radio') {
      $$(`input[name="${t.name}"]`, $('.modal')).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { const t = e.target; if (t.type === 'checkbox' || t.type === 'radio' || t.tagName === 'SELECT' || t.type === 'date' || (t.dataset.qty && e.type === 'change')) onInput(e); });

  // ---- boot / resume ----
  async function boot() {
    const resume = params.get('resume') || (BL.store.get(storeKey) || {}).token;
    if (resume) {
      try {
        const q = await api('GET', `/api/public/quotes/${encodeURIComponent(resume)}`);
        if (['draft', 'submitted'].includes(q.status) || params.get('resume')) {
          st.quoteToken = q.token; st.status = q.status;
          st.leadToken = q.lead && q.lead.token;
          Object.assign(st.details, q.details || {});
          for (const s of q.selections || []) if (catalog.find((c) => c.id === s.service_id)) st.sel[s.service_id] = Object.assign(defaultSelection(catalog.find((c) => c.id === s.service_id)), s);
          if (q.lead) Object.assign(st.contact, q.lead.contact);
          const max = q.lead ? q.lead.max_step_index : 0;
          st.i = Math.min(max, order.length - 1);
          if (order[st.i] === 'review' && !selections().length) st.i = order.indexOf('services');
        }
      } catch (e) { BL.store.del(storeKey); }
    }
    render();
  }
  boot();
})();
