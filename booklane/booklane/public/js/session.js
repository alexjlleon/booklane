/* Buy-and-book flow for a session: pick a location, say whether it's already paid for,
   otherwise buy it, then pick a time. Partial answers are saved as you go, same as the call form. */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, sess = D.session;
  const params = new URLSearchParams(location.search);
  const storeKey = `sess:${biz.slug}:${sess.slug}`;
  const L = sess.labels;

  const st = {
    i: 0,
    tz: BL.guessTz(),
    calendar: sess.calendars.length === 1 ? sess.calendars[0].slug : null,
    booked: null,              // true = already paid for, false = buying now
    bookingNumber: '',
    slot: null,
    answers: {},
    contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    leadToken: null,
    busy: false,
    error: null,
    saveState: '',
  };
  const app = document.getElementById('app');

  // ---------- which steps exist ----------
  // The location step only appears when there is a real choice to make, which is what lets the
  // album flow (one designer) skip straight to the purchase.
  function stepList() {
    const out = [];
    if (sess.calendars.length > 1) out.push('choose');
    out.push('booked');
    if (st.booked === true && sess.ask_booking_number) out.push('number');
    if (st.booked === false) out.push('price');
    out.push('contact', 'schedule');
    return out;
  }
  const steps = () => stepList();
  const cur = () => steps()[st.i];
  const isLast = () => st.i >= steps().length - 1;
  const calName = () => (sess.calendars.find((c) => c.slug === st.calendar) || {}).name || '';
  const payable = () => st.booked === false && sess.price_cents > 0;

  // ---------- lead capture ----------
  const saver = BL.createSaver({
    url: () => st.leadToken && `/api/public/leads/${st.leadToken}`,
    beaconUrl: () => st.leadToken && `/api/public/leads/${st.leadToken}/beacon`,
    onState: (s) => { st.saveState = s; const el = $('.save-state'); if (el) { el.className = 'save-state ' + s; el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Progress saved' : ''; } },
  });

  let leadPromise = null;
  function ensureLead() {
    if (st.leadToken) return Promise.resolve(st.leadToken);
    if (!leadPromise) {
      leadPromise = api('POST', `/api/public/b/${biz.slug}/leads`, { source: 'booking', event_type_slug: sess.slug, meta: BL.leadMeta() })
        .then((r) => { st.leadToken = r.token; BL.store.set(storeKey, { token: r.token, at: Date.now() }); return r.token; })
        .catch(() => { leadPromise = null; return null; });
    }
    return leadPromise;
  }
  const progress = () => ({ step_index: st.i, step_key: cur(), step_total: steps().length });
  function capture(patch, now) { ensureLead().then((t) => t && saver.queue(Object.assign(progress(), patch), now)); }

  // ---------- pieces ----------
  function side() {
    return `<aside class="booker-side">
      <div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <div><h1 class="event-title">${esc(sess.name)}</h1>${sess.description ? `<p class="muted desc" style="margin:8px 0 0">${esc(sess.description)}</p>` : ''}</div>
      <div class="meta-list">
        <div>${icons.clock}${sess.duration_min} min</div>
        ${sess.price_cents > 0 ? `<div>${icons.tag}${esc(sess.price_display)}</div>` : ''}
        ${st.calendar ? `<div>${icons.pin}${esc(calName())}</div>` : ''}
      </div>
      ${st.slot ? `<div class="selected-time">${icons.cal.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px"')}${esc(BL.fmtDate(st.slot, st.tz, { weekday: 'short', month: 'short' }))}, ${esc(BL.fmtTime(st.slot, st.tz))}</div>` : ''}
      ${biz.settings.urgency_text ? `<div class="urgency">${esc(biz.settings.urgency_text)}</div>` : ''}
      <ul class="trust">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </aside>`;
  }

  const field = (name, label, input, required) =>
    `<div class="field"><label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;

  const optCard = (attr, value, on, label, hint) => `
    <label class="opt radio${on ? ' is-on' : ''}">
      <input type="radio" name="${attr}" value="${esc(value)}" data-${attr}${on ? ' checked' : ''}>
      <span class="tick"></span>
      <span class="opt-stack"><span>${esc(label)}</span>${hint ? `<span class="opt-hint">${esc(hint)}</span>` : ''}</span>
    </label>`;

  function renderChoose() {
    return `<div class="options">${sess.calendars.map((c) => optCard('choose', c.slug, st.calendar === c.slug, c.name, c.blurb)).join('')}</div>`;
  }

  function renderBooked() {
    return `<div class="options list">
      ${optCard('booked', 'yes', st.booked === true, L.booked_yes_label, '')}
      ${optCard('booked', 'no', st.booked === false, L.booked_no_label, sess.price_cents > 0 ? `${sess.price_display}` : '')}
    </div>`;
  }

  function renderNumber() {
    return `<form class="step-form" novalidate>
      ${field('booking_number', L.booking_number_label,
    `<input class="input" id="f-booking_number" name="booking_number" data-number value="${esc(st.bookingNumber)}" autocomplete="off" spellcheck="false" placeholder="e.g. WU-10432">`,
    sess.booking_number_required)}
      ${L.booking_number_hint ? `<p class="muted" style="margin:-4px 0 0;font-size:14px">${esc(L.booking_number_hint)}</p>` : ''}
    </form>`;
  }

  function renderPrice() {
    const includes = (L.includes || []).filter(Boolean);
    return `<div class="price-panel">
      <div class="price-figure">
        <div class="price-amount">${esc(sess.price_display)}</div>
        <div class="muted">${esc(sess.duration_min)} minutes${st.calendar ? ` · ${esc(calName())}` : ''}</div>
      </div>
      ${L.price_blurb ? `<p>${esc(L.price_blurb)}</p>` : ''}
      ${includes.length ? `<ul class="trust">${includes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${sess.price_cents > 0 && !sess.payments_ready
    ? `<div class="form-error" role="alert">Card payments are not switched on yet. Please call us and we will book this for you.</div>`
    : `<p class="muted" style="font-size:14px">You will pick your time next, then pay securely on Stripe. We never see your card details.</p>`}
    </div>`;
  }

  function renderContact() {
    const f = sess.contact_fields || {};
    const show = (k) => f[k] === 'required' || f[k] === 'optional';
    const req = (k) => f[k] === 'required';
    let h = '<form class="step-form" novalidate><div class="grid-2">';
    if (show('first_name')) h += field('first_name', 'First name', `<input class="input" id="f-first_name" name="first_name" data-contact value="${esc(st.contact.first_name)}" autocomplete="given-name">`, req('first_name'));
    if (show('last_name')) h += field('last_name', 'Last name', `<input class="input" id="f-last_name" name="last_name" data-contact value="${esc(st.contact.last_name)}" autocomplete="family-name">`, req('last_name'));
    h += '</div>';
    h += field('email', 'Email', `<input class="input" id="f-email" name="email" type="email" data-contact value="${esc(st.contact.email)}" autocomplete="email" inputmode="email">`, true);
    if (show('phone')) h += field('phone', 'Mobile number', `<input class="input" id="f-phone" name="phone" type="tel" data-contact value="${esc(st.contact.phone)}" autocomplete="tel" inputmode="tel">`, req('phone'));
    if (show('sms_consent')) h += `<label class="check"><input type="checkbox" name="sms_consent" data-contact${st.contact.sms_consent ? ' checked' : ''}><span>${esc(biz.settings.sms_consent_text || 'Text me about my session.')}</span></label>`;
    h += `</form>`;
    return h;
  }

  const HEADS = {
    choose: () => ({ title: L.choose_label, sub: L.choose_hint }),
    booked: () => ({ title: L.booked_question, sub: '' }),
    number: () => ({ title: `What's your ${String(L.booking_number_label || 'booking number').toLowerCase()}?`, sub: L.booked_note }),
    price: () => ({ title: L.price_heading || sess.name, sub: '' }),
    contact: () => ({ title: 'Who is this session for?', sub: 'So we can send your confirmation.' }),
    schedule: () => ({ title: 'Pick your time', sub: st.calendar ? `Openings for ${calName()}.` : '' }),
  };

  function ctaLabel() {
    if (!isLast()) return cur() === 'price' ? 'Continue' : 'Continue';
    return payable() ? (L.pay_cta || 'Pay and pick a time') : (L.free_cta || 'Confirm my session');
  }

  function render() {
    const step = cur();
    const total = steps().length;
    const head = HEADS[step]();
    let body = '';
    if (step === 'choose') body = renderChoose();
    else if (step === 'booked') body = renderBooked();
    else if (step === 'number') body = renderNumber();
    else if (step === 'price') body = renderPrice();
    else if (step === 'contact') body = renderContact();
    else body = '<div id="scheduler"></div>';

    app.innerHTML = `<div class="shell"><div class="card booker">${side()}
      <main class="booker-main">
        <div class="progress" aria-label="Step ${st.i + 1} of ${total}"><div class="progress-bar"><span style="width:${Math.round(((st.i + 1) / total) * 100)}%"></span></div><div class="progress-count">${st.i + 1} / ${total}</div></div>
        <div class="step-head"><h2>${esc(head.title || '')}</h2>${head.sub ? `<p>${esc(head.sub)}</p>` : ''}</div>
        ${st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body">${body}</div>
        <div class="step-nav">
          <div>${st.i > 0 ? `<button type="button" class="btn btn-link" data-back>${icons.left} Back</button>` : `<span class="save-state ${st.saveState}"></span>`}</div>
          ${st.i > 0 ? `<span class="save-state ${st.saveState}"></span>` : ''}
          <button type="button" class="btn btn-primary btn-lg" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${esc(ctaLabel())} ${isLast() || st.busy ? '' : icons.right}</button>
        </div>
      </main></div></div>${BL.powered()}`;

    if (step === 'schedule') mountScheduler();
  }

  function mountScheduler() {
    const url = `/api/public/b/${encodeURIComponent(biz.slug)}/s/${encodeURIComponent(sess.slug)}/slots?calendar=${encodeURIComponent(st.calendar || '')}`;
    BL.Scheduler({
      root: $('#scheduler'), tz: st.tz, selected: st.slot, maxDaysAhead: 180, slotsUrl: url,
      onTzChange: (tz) => { st.tz = tz; },
      onSelect: (iso) => {
        st.slot = iso; st.error = null;
        const label = `${BL.fmtDate(iso, st.tz, { weekday: 'short', month: 'short', year: 'numeric' })} at ${BL.fmtTime(iso, st.tz)} (${st.tz})`;
        st.answers.requested_time = label;
        capture({ answers: { requested_time: label } }, true);
        const sideEl = $('.booker-side');
        if (sideEl) sideEl.outerHTML = side();
      },
    });
  }

  // ---------- validation + navigation ----------
  function validate() {
    const step = cur();
    if (step === 'choose' && !st.calendar) return 'Pick a location to see its calendar.';
    if (step === 'booked' && st.booked === null) return 'Let us know so we can point you the right way.';
    if (step === 'number' && sess.booking_number_required && !st.bookingNumber.trim()) return `Please enter your ${String(L.booking_number_label || 'booking number').toLowerCase()}.`;
    if (step === 'price' && sess.price_cents > 0 && !sess.payments_ready) return 'Card payments are not switched on yet. Please call us and we will book this for you.';
    if (step === 'contact') {
      const f = sess.contact_fields || {};
      const errs = {};
      if (f.first_name === 'required' && !st.contact.first_name.trim()) errs.first_name = 'Required';
      if (f.last_name === 'required' && !st.contact.last_name.trim()) errs.last_name = 'Required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.contact.email.trim())) errs.email = 'Enter a valid email';
      if (f.phone === 'required' && st.contact.phone.replace(/\D/g, '').length < 7) errs.phone = 'Enter a valid phone number';
      if (Object.keys(errs).length) { BL.fieldErrors(app, errs); return 'Please fix the highlighted fields.'; }
    }
    if (step === 'schedule' && !st.slot) return 'Pick a time to continue.';
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
  }

  async function submit() {
    st.busy = true; render();
    const payload = {
      calendar: st.calendar,
      start: st.slot,
      timezone: st.tz,
      contact: st.contact,
      answers: st.answers,
      lead_token: st.leadToken,
    };
    try {
      await saver.flush();
      // No card needed when they already paid, or when the session costs nothing.
      if (st.booked === true || sess.price_cents === 0) {
        payload.already_booked = st.booked === true;
        if (st.booked === true) payload.booking_number = st.bookingNumber;
        const r = await api('POST', `/api/public/b/${biz.slug}/s/${sess.slug}/claim`, payload);
        BL.store.del(storeKey);
        location.href = r.redirect;
        return;
      }
      const r = await api('POST', `/api/public/b/${biz.slug}/s/${sess.slug}/checkout`, payload);
      BL.store.del(storeKey);
      // Off to Stripe's hosted page. We come back to /session/:token.
      location.href = r.checkout_url;
    } catch (e) {
      st.busy = false;
      st.error = e.message;
      // A slot taken while they were filling in the form sends them back to the calendar.
      if (e.status === 409) { st.slot = null; st.i = steps().indexOf('schedule'); }
      if (e.details) BL.fieldErrors(app, e.details);
      render();
    }
  }

  // ---------- events ----------
  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) { e.preventDefault(); go(1); }
    else if (e.target.closest('[data-back]')) { e.preventDefault(); go(-1); }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });
  app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.input')) { e.preventDefault(); go(1); } });

  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-choose')) {
      st.calendar = t.value;
      st.slot = null;                       // a different city means a different calendar
      capture({ answers: { location: calName() } }, true);
      $$('[data-choose]', app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      setTimeout(() => go(1), 180);
    } else if (t.hasAttribute('data-booked')) {
      st.booked = t.value === 'yes';
      capture({ answers: { already_booked: st.booked ? 'Yes' : 'No' } }, true);
      $$('[data-booked]', app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      setTimeout(() => go(1), 180);
    } else if (t.hasAttribute('data-number')) {
      st.bookingNumber = t.value;
      capture({ answers: { booking_number: t.value } }, e.type === 'change');
    } else if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      const fl = t.closest('.field');
      if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change' || t.type === 'checkbox');
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.type === 'radio' || e.target.tagName === 'SELECT') onInput(e); });

  // ---------- boot ----------
  // Accepts ?city=houston&booked=no from a short CTA on the website.
  function prefill() {
    const city = params.get('city') || params.get('calendar');
    if (city) {
      const hit = sess.calendars.find((c) => c.slug === city || c.name.toLowerCase() === city.toLowerCase());
      if (hit) st.calendar = hit.slug;
    }
    const booked = params.get('booked');
    if (booked === 'no' || booked === 'yes') st.booked = booked === 'yes';
    for (const k of ['first_name', 'last_name', 'email', 'phone']) {
      const v = params.get(k);
      if (v) st.contact[k] = String(v).slice(0, 200);
    }
    // Skip straight past anything the link already answered.
    const list = steps();
    let i = 0;
    while (i < list.length - 1) {
      const s = list[i];
      if (s === 'choose' && st.calendar) { i++; continue; }
      if (s === 'booked' && st.booked !== null) { i++; continue; }
      break;
    }
    st.i = i;
  }

  if (D.cancelled) st.error = 'Your payment was cancelled, so nothing was charged. Your time is free again — pick one when you are ready.';
  prefill();
  render();
})();
