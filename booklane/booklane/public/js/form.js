/* A custom form: whatever steps the admin put on it, walked in order.
   Questions, contact details, a note, a live date check, a calendar, album options, a payment.

   The page never decides money or availability. Totals come back from the server for every change,
   and the calendar comes from the booking page the form names, so what is shown is what is real. */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, form = D.form;
  const steps = form.steps;
  const storeKey = `form:${biz.slug}:${form.slug}`;
  const C = form.copy;

  const st = {
    i: 0,
    tz: BL.guessTz(),
    answers: {},
    contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    slot: null,
    options: {},          // product step: groupId -> choiceId
    addons: {},           // product step: addonId -> qty
    qty: 1,
    quote: null,
    avail: null,          // the date check's answer
    leadToken: null,
    busy: false,
    error: null,
    saveState: '',
  };
  const app = document.getElementById('app');

  const productStep = () => steps.find((s) => s.type === 'product' && s.product) || null;
  const prod = () => (productStep() || {}).product || null;
  const cur = () => steps[st.i];
  const isLast = () => st.i === steps.length - 1;
  const cents = (n) => `$${(n / 100).toFixed(2).replace(/\.00$/, '')}`;

  // ---------- lead capture, same as every other flow ----------
  const saver = BL.createSaver({
    url: () => (st.leadToken ? `/api/public/leads/${st.leadToken}` : null),
    onState: (s) => { st.saveState = s; const el = $('.save-state', app); if (el) el.className = `save-state ${s}`; },
  });
  let leadPromise = null;
  function ensureLead() {
    if (st.leadToken) return Promise.resolve(st.leadToken);
    if (!leadPromise) {
      leadPromise = api('POST', `/api/public/b/${biz.slug}/leads`, { source: 'booking', meta: Object.assign(BL.leadMeta(), { form: form.slug }) })
        .then((r) => { st.leadToken = r.token; BL.store.set(storeKey, { token: r.token, at: Date.now() }); return r.token; })
        .catch(() => { leadPromise = null; return null; });
    }
    return leadPromise;
  }
  function capture(patch, now) {
    ensureLead().then((t) => t && saver.queue(Object.assign({ step_index: st.i, step_key: cur().key, step_total: steps.length }, patch), now));
  }

  // ---------- product pricing, server-side ----------
  let quoteSeq = 0;
  async function refreshQuote() {
    const p = prod();
    if (!p) return;
    const missing = p.option_groups.filter((g) => liveGroup(g) && g.required && !st.options[g.id]);
    if (missing.length) { st.quote = null; paintTotals(); return; }
    const seq = ++quoteSeq;
    try {
      const r = await api('POST', `/api/public/b/${biz.slug}/f/${form.slug}/quote`, { selection: { options: st.options, addons: st.addons, qty: st.qty } });
      if (seq !== quoteSeq) return;
      st.quote = r;
    } catch (e) {
      if (seq !== quoteSeq) return;
      st.quote = null;
      if (e.status !== 422) st.error = e.message;
    }
    paintTotals();
  }
  const liveGroup = (g) => !g.applies_to.length || g.applies_to.some((id) => Object.values(st.options).map(String).includes(String(id)));

  // ---------- pieces ----------
  function side() {
    const q = st.quote;
    return `<aside class="booker-side">
      <div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <div><h1 class="event-title">${esc(form.name)}</h1>${form.description ? `<p class="muted desc" style="margin:8px 0 0">${esc(form.description)}</p>` : ''}</div>
      ${q ? `<div class="cart-side">${q.lines.map((l) => `
        <div class="cart-line"><span>${esc(l.label)}${l.qty > 1 ? ` <span class="muted">x${l.qty}</span>` : ''}${l.detail ? `<span class="cart-detail">${esc(l.detail)}</span>` : ''}</span><span>${esc(cents(l.line_cents))}</span></div>`).join('')}
        <div class="cart-line cart-total"><span>Total</span><span>${esc(cents(q.total_cents))}</span></div></div>` : ''}
      ${st.slot ? `<div class="selected-time">${esc(BL.fmtDate(st.slot, st.tz, { weekday: 'short', month: 'short' }))}, ${esc(BL.fmtTime(st.slot, st.tz))}</div>` : ''}
      <ul class="trust">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </aside>`;
  }

  const field = (name, label, input, required) =>
    `<div class="field"><label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;

  function renderQuestion(q) {
    const v = st.answers[q.id];
    if (q.type === 'choice' || q.type === 'multi') {
      const multi = q.type === 'multi';
      const vals = [].concat(v || []);
      const opts = (q.options || []).map((o) => `<label class="opt ${multi ? '' : 'radio'} ${vals.includes(o) ? 'is-on' : ''}"><input type="${multi ? 'checkbox' : 'radio'}" name="${esc(q.id)}" value="${esc(o)}" ${vals.includes(o) ? 'checked' : ''} data-q="${esc(q.id)}" data-multi="${multi ? 1 : 0}"><span class="tick"></span><span>${esc(o)}</span></label>`).join('');
      return `<div class="field" role="group" aria-label="${esc(q.label)}"><span class="label">${esc(q.label)}${q.required ? ' <span class="req">*</span>' : ''}</span><div class="options ${q.display === 'cards' ? '' : 'list'}">${opts}</div></div>`;
    }
    if (q.type === 'select') {
      return field(q.id, q.label, `<select class="select" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}"><option value="">Select…</option>${(q.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`, q.required);
    }
    if (q.type === 'textarea') return field(q.id, q.label, `<textarea class="textarea" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}">${esc(v || '')}</textarea>`, q.required);
    const type = q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text';
    const min = q.type === 'date' ? ` min="${BL.todayIn(st.tz)}"` : '';
    return field(q.id, q.label, `<input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="${type}"${min} value="${esc(v || '')}" data-q="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}">`, q.required);
  }

  function renderContact(step) {
    const f = step.fields || {};
    const show = (k) => f[k] !== 'hidden';
    const req = (k) => f[k] === 'required';
    const inp = (n, t, ac) => `<input class="input" id="f-${n}" name="${n}" type="${t}" data-contact value="${esc(st.contact[n])}" autocomplete="${ac}">`;
    return `<form class="step-form" novalidate>
      <div class="grid-2">
        ${show('first_name') ? field('first_name', 'First name', inp('first_name', 'text', 'given-name'), req('first_name')) : ''}
        ${show('last_name') ? field('last_name', 'Last name', inp('last_name', 'text', 'family-name'), req('last_name')) : ''}
      </div>
      ${show('email') ? field('email', 'Email', inp('email', 'email', 'email'), req('email')) : ''}
      ${show('phone') ? field('phone', 'Mobile', inp('phone', 'tel', 'tel'), req('phone')) : ''}
      ${show('sms_consent') ? `<label class="check"><input type="checkbox" name="sms_consent" data-contact ${st.contact.sms_consent ? 'checked' : ''}><span>${esc(biz.settings.sms_consent_text || 'Text me about my booking')}</span></label>` : ''}
      ${biz.settings.privacy_note ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}
    </form>`;
  }

  function renderProduct(step) {
    const p = step.product;
    if (!p) return '<p class="muted">This product is not available right now.</p>';
    const groups = p.option_groups.filter(liveGroup);
    return groups.map((g) => `
      <div class="opt-group">
        ${groups.length > 1 ? `<h3 class="opt-group-title">${esc(g.label)}</h3>` : ''}
        <div class="options ${g.layout === 'cards' || g.layout === 'swatches' ? 'list' : 'list'}">${g.choices.map((ch) => `
          <label class="opt radio${st.options[g.id] === ch.id ? ' is-on' : ''}">
            <input type="radio" name="g-${esc(g.id)}" value="${esc(ch.id)}" data-opt="${esc(g.id)}"${st.options[g.id] === ch.id ? ' checked' : ''}>
            <span class="tick"></span><span class="opt-stack"><span>${esc(ch.label)}</span></span>
            ${ch.price_cents > 0 ? `<span class="opt-price">${esc(cents(ch.price_cents))}</span>` : ''}
          </label>`).join('')}</div>
      </div>`).join('')
      + (p.addons.length ? `<div class="opt-group"><h3 class="opt-group-title">${esc(p.copy.addons_label || 'Anything else?')}</h3>
        <div class="options list">${p.addons.map((a) => {
    const n = Number(st.addons[a.id] || 0);
    return `<div class="opt check${n > 0 ? ' is-on' : ''}">
          <label class="opt-main"><input type="checkbox" data-addon="${esc(a.id)}"${n > 0 ? ' checked' : ''}><span class="tick"></span><span class="opt-stack"><span>${esc(a.label)}</span></span></label>
          <span class="opt-right">${a.max_qty > 1 && n > 0 ? `<input class="input input-qty" type="number" min="1" max="${a.max_qty}" value="${n}" data-addon-qty="${esc(a.id)}" aria-label="How many ${esc(a.label)}">` : ''}<span class="opt-price">${a.price_cents > 0 ? esc(cents(a.price_cents)) : ''}</span></span>
        </div>`;
  }).join('')}</div></div>` : '');
  }

  function renderPayment(step) {
    const total = st.quote ? st.quote.total_cents : (step.source === 'fixed' ? step.amount_cents : null);
    return `<div class="price-panel">
      ${total === null ? '<p class="muted">Go back and finish choosing.</p>' : `
        <div class="price-figure"><div class="price-amount">${esc(cents(total))}</div>
        <div class="muted">${esc(step.label || form.name)}</div></div>`}
      ${st.quote ? `<div class="cart">${st.quote.lines.map((l) => `<div class="cart-line"><span>${esc(l.label)}${l.detail ? `<span class="cart-detail">${esc(l.detail)}</span>` : ''}${l.qty > 1 ? ` <span class="muted">x${l.qty}</span>` : ''}</span><span>${esc(cents(l.line_cents))}</span></div>`).join('')}
        <div class="cart-line cart-total"><span>Total</span><span>${esc(cents(st.quote.total_cents))}</span></div></div>` : ''}
      ${form.shape.schedules_after_payment ? '<p>You will pick a time on the next screen, once this is paid for.</p>' : ''}
    </div>`;
  }

  function renderAvailability(step) {
    const a = st.avail;
    const when = st.answers[step.date_question_id];
    const pretty = when ? BL.fmtDate(when + 'T12:00:00Z', 'UTC', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
    if (!when) return '<div class="done"><p class="muted">Tell us your date and we\'ll check it.</p></div>';
    if (!a || a.loading) return `<div class="done"><div class="spinner" style="margin:10px auto"></div><p class="muted">Checking ${esc(pretty)}…</p></div>`;
    if (a.available) {
      return `<div class="done"><div class="done-icon">${icons.check}</div>
        <h2 style="margin:10px 0 4px">We're available!</h2>
        <p class="muted">${esc(step.available_text || `${pretty} is open.`)}</p></div>`;
    }
    return `<div class="done"><div class="done-icon" style="background:#fdf1e7;color:#b4690e">${icons.check}</div>
      <h2 style="margin:10px 0 4px">That date is in demand</h2>
      <p class="muted">${esc(step.unavailable_text || `We may already be booked on ${pretty}, but teams free up. Let's talk.`)}</p></div>`;
  }

  function stepBody(step) {
    if (step.type === 'questions') return `<form class="step-form" novalidate>${(step.questions || []).map(renderQuestion).join('')}</form>`;
    if (step.type === 'contact') return renderContact(step);
    if (step.type === 'message') return `<div class="price-panel"><p>${esc(step.body || '')}</p></div>`;
    if (step.type === 'availability') return renderAvailability(step);
    if (step.type === 'schedule') return '<div id="scheduler"></div>';
    if (step.type === 'product') return renderProduct(step);
    if (step.type === 'payment') return renderPayment(step);
    return '';
  }

  function ctaLabel() {
    const step = cur();
    if (isLast()) {
      if (step.type === 'payment') return 'Pay now';
      return C.submit_cta || 'Submit';
    }
    return 'Continue';
  }

  function paintTotals() {
    const sideEl = $('.booker-side', app);
    if (sideEl) sideEl.outerHTML = side();
    if (cur().type === 'payment') { const b = $('.step-body', app); if (b) b.innerHTML = renderPayment(cur()); }
  }

  function render() {
    const step = cur();
    app.innerHTML = `<div class="shell"><div class="card booker">${side()}
      <main class="booker-main">
        <div class="progress" aria-label="Step ${st.i + 1} of ${steps.length}"><div class="progress-bar"><span style="width:${Math.round(((st.i + 1) / steps.length) * 100)}%"></span></div><div class="progress-count">${st.i + 1} / ${steps.length}</div></div>
        <div class="step-head"><h2>${esc(step.title || '')}</h2>${step.subtitle ? `<p>${esc(step.subtitle)}</p>` : ''}</div>
        ${st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body">${stepBody(step)}</div>
        <div class="step-nav">
          <div>${st.i > 0 ? `<button type="button" class="btn btn-link" data-back>${icons.left} Back</button>` : `<span class="save-state ${st.saveState}"></span>`}</div>
          ${st.i > 0 ? `<span class="save-state ${st.saveState}"></span>` : ''}
          <button type="button" class="btn btn-primary btn-lg" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${esc(ctaLabel())} ${isLast() || st.busy ? '' : icons.right}</button>
        </div>
      </main></div></div>${BL.powered()}`;
    if (step.type === 'schedule') mountScheduler();
    if (step.type === 'availability') checkDate(step);
  }

  function mountScheduler() {
    BL.Scheduler({
      root: $('#scheduler'), tz: st.tz, selected: st.slot, maxDaysAhead: 180,
      slotsUrl: `/api/public/b/${encodeURIComponent(biz.slug)}/f/${encodeURIComponent(form.slug)}/slots`,
      onTzChange: (tz) => { st.tz = tz; },
      onSelect: (iso) => {
        st.slot = iso; st.error = null;
        const label = `${BL.fmtDate(iso, st.tz, { weekday: 'short', month: 'short', year: 'numeric' })} at ${BL.fmtTime(iso, st.tz)}`;
        st.answers.requested_time = label;
        capture({ answers: { requested_time: label } }, true);
        const sideEl = $('.booker-side', app);
        if (sideEl) sideEl.outerHTML = side();
      },
    });
  }

  // The same endpoint the booking pages use, so one answer about a date, not two.
  async function checkDate(step) {
    const when = st.answers[step.date_question_id];
    if (!when || (st.avail && st.avail.date === when)) return;
    st.avail = { loading: true, date: when };
    try {
      const r = await fetch(`/api/public/b/${encodeURIComponent(biz.slug)}/date-check?date=${encodeURIComponent(when)}`).then((x) => x.json());
      st.avail = { date: when, available: !!r.available };
      capture({ answers: { date_available: r.available ? 'yes' : 'already booked' } }, true);
    } catch (e) {
      // If the check fails, say nothing rather than claiming a date is taken.
      st.avail = { date: when, available: true };
    }
    if (cur().type === 'availability') render();
  }

  // ---------- validation ----------
  function validate() {
    const step = cur();
    if (step.type === 'questions') {
      const errs = {};
      for (const q of step.questions || []) {
        if (!q.required) continue;
        const v = st.answers[q.id];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) errs[q.id] = 'Required';
      }
      if (Object.keys(errs).length) { BL.fieldErrors(app, errs); return 'Please fill in the highlighted fields.'; }
    }
    if (step.type === 'contact') {
      const f = step.fields || {};
      const errs = {};
      if (f.first_name === 'required' && !st.contact.first_name.trim()) errs.first_name = 'Required';
      if (f.last_name === 'required' && !st.contact.last_name.trim()) errs.last_name = 'Required';
      if (f.email !== 'hidden' && (f.email === 'required' || st.contact.email.trim())) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.contact.email.trim())) errs.email = 'Enter a valid email';
      }
      if (f.phone === 'required' && st.contact.phone.replace(/\D/g, '').length < 7) errs.phone = 'Enter a valid phone number';
      if (Object.keys(errs).length) { BL.fieldErrors(app, errs); return 'Please fix the highlighted fields.'; }
    }
    if (step.type === 'product') {
      const p = step.product;
      const missing = (p ? p.option_groups : []).filter(liveGroup).find((g) => g.required && !st.options[g.id]);
      if (missing) return `Please choose ${String(missing.label || 'an option').toLowerCase()}.`;
    }
    if (step.type === 'schedule' && !st.slot) return 'Pick a time to continue.';
    if (step.type === 'payment' && !st.quote && step.source === 'product') return 'Go back and finish choosing.';
    return null;
  }

  async function go(dir) {
    st.error = null;
    if (dir > 0) {
      const problem = validate();
      if (problem) { st.error = problem; return render(); }
      if (isLast()) return submit();
      st.i += 1;
    } else {
      st.i = Math.max(0, st.i - 1);
    }
    capture({}, false);
    render();
    if (cur().type === 'payment') refreshQuote();
  }

  async function submit() {
    st.busy = true; render();
    try {
      const r = await api('POST', `/api/public/b/${biz.slug}/f/${form.slug}/submit`, {
        lead_token: st.leadToken,
        contact: st.contact,
        answers: st.answers,
        start: st.slot,
        timezone: st.tz,
        selection: { options: st.options, addons: st.addons, qty: st.qty },
      });
      if (r.kind === 'checkout' && r.checkout_url) { location.href = r.checkout_url; return; }
      if (r.kind === 'booked' && r.redirect) { location.href = r.redirect; return; }
      if (r.redirect) { location.href = r.redirect; return; }
      done(r);
    } catch (e) {
      st.busy = false;
      st.error = e.message || 'Something went wrong. Please try again.';
      if (e.details) BL.fieldErrors(app, e.details);
      render();
    }
  }

  function done(r) {
    const c = (r && r.copy) || C;
    BL.store.del(storeKey);
    app.innerHTML = `<div class="shell"><div class="card" style="max-width:520px;margin:0 auto;padding:36px 28px;text-align:center">
      <div class="biz" style="justify-content:center">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <div class="done-icon" style="margin:14px auto">${icons.check}</div>
      <h1 style="font-size:22px;margin:12px 0 6px">${esc(c.done_heading || 'Thank you')}</h1>
      <p class="muted">${esc(c.done_blurb || '')}</p>
    </div></div>${BL.powered()}`;
  }

  // ---------- events ----------
  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) { e.preventDefault(); go(1); }
    else if (e.target.closest('[data-back]')) { e.preventDefault(); go(-1); }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });

  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-q')) {
      const id = t.getAttribute('data-q');
      if (t.dataset.multi === '1') {
        const set = new Set([].concat(st.answers[id] || []));
        if (t.checked) set.add(t.value); else set.delete(t.value);
        st.answers[id] = [...set];
        $$(`[data-q="${id}"]`, app).forEach((x) => x.closest('.opt') && x.closest('.opt').classList.toggle('is-on', x.checked));
      } else if (t.type === 'radio') {
        st.answers[id] = t.value;
        $$(`[data-q="${id}"]`, app).forEach((x) => x.closest('.opt') && x.closest('.opt').classList.toggle('is-on', x.checked));
      } else {
        st.answers[id] = t.value;
      }
      const fl = t.closest('.field');
      if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
      capture({ answers: { [id]: st.answers[id] } }, e.type === 'change');
    } else if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      const fl = t.closest('.field');
      if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change' || t.type === 'checkbox');
    } else if (t.hasAttribute('data-opt')) {
      const gid = t.getAttribute('data-opt');
      st.options[gid] = t.value;
      const p = prod();
      if (p) { const live = new Set(p.option_groups.filter(liveGroup).map((g) => g.id)); for (const k of Object.keys(st.options)) if (!live.has(k)) delete st.options[k]; }
      render(); refreshQuote();
    } else if (t.hasAttribute('data-addon')) {
      const id = t.getAttribute('data-addon');
      if (t.checked) st.addons[id] = Math.max(1, Number(st.addons[id] || 1)); else delete st.addons[id];
      render(); refreshQuote();
    } else if (t.hasAttribute('data-addon-qty')) {
      const id = t.getAttribute('data-addon-qty');
      st.addons[id] = Math.max(1, Number(t.value) || 1);
      refreshQuote();
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.type === 'radio' || e.target.tagName === 'SELECT' || e.target.type === 'number') onInput(e); });

  if (D.cancelled) st.error = 'Your payment was cancelled, so nothing was charged. Your answers are still here.';
  render();
  if (cur().type === 'payment') refreshQuote();
})();
