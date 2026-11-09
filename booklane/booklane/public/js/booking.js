/* Multi-step booking flow with partial lead capture.

   How it looks comes from the page's look (eventType.style, see src/services/form-style.js),
   drawn by public/js/look.js, the same engine custom forms use. In preview (the admin's Look
   editor) nothing is saved or booked, and the editor sends new looks over postMessage. */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, et = D.eventType;
  const params = new URLSearchParams(location.search);
  const storeKey = `lead:${biz.slug}:${et.slug}`;
  const S = Object.assign({}, et.style || {});
  const PREVIEW = !!D.preview;

  const st = {
    i: 0, tz: BL.guessTz(), slot: null, answers: {}, contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    leadToken: null, quoteToken: params.get('quote') || null, busy: false, error: null, saveState: '', skip: new Set(),
    // Preselected, so somebody who scrolls straight to the calendar still books the first way this
    // page offers rather than nothing at all.
    placeId: ((et.places || [])[0] || {}).id || null,
    guests: [], guestDraft: '', guestsOpen: false, guestError: null,
    typed: {}, calMonth: {},   // typed dates in progress, and the month each inline date calendar shows
  };
  const MAX_GUESTS = 5;
  const guestsOn = () => (et.settings || {}).allow_guests !== false;
  const steps = et.steps;

  // An answer can route the booking to another page's calendar (an existing client to the planning
  // team, say). The server makes the same decision from the answers; this just shows the right times.
  function routeTarget() {
    for (const step of steps) {
      for (const q of step.questions || []) {
        const routes = q.routes || {};
        for (const option of [].concat(st.answers[q.id] ?? [])) if (routes[option]) return routes[option];
      }
    }
    return null;
  }
  const bookingEt = () => routeTarget() || et;
  const app = document.getElementById('app');

  const saver = BL.createSaver({
    url: () => st.leadToken && `/api/public/leads/${st.leadToken}`,
    beaconUrl: () => st.leadToken && `/api/public/leads/${st.leadToken}/beacon`,
    onState: (s) => { st.saveState = s; const el = $('.save-state'); if (el) { el.className = 'save-state ' + s; el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Progress saved' : ''; } },
  });

  let leadPromise = null;
  function ensureLead() {
    if (PREVIEW) return Promise.resolve(null);
    if (st.leadToken) return Promise.resolve(st.leadToken);
    if (!leadPromise) {
      leadPromise = api('POST', `/api/public/b/${biz.slug}/leads`, { source: 'booking', event_type_slug: et.slug, meta: BL.leadMeta() })
        .then((r) => { st.leadToken = r.token; BL.store.set(storeKey, { token: r.token, at: Date.now() }); saver.queue(progressPatch(), true); return r.token; })
        .catch(() => { leadPromise = null; return null; });
    }
    return leadPromise;
  }
  const progressPatch = () => ({ step_index: st.i, step_key: steps[st.i].key, step_total: steps.length });
  function capture(patch, immediate) { ensureLead().then((t) => t && saver.queue(Object.assign(progressPatch(), patch), immediate)); }

  // --------- Rendering ---------
  const logoHtml = () => BL.Look.logoHtml(S, biz);
  const titleOf = () => bookingEt().name;
  const descOf = () => (!routeTarget() && et.description ? et.description : '');

  /** Length, where, who, and the time they picked. Refreshed in place when they pick one. */
  function meta() {
    const hosts = (et.hosts || []).map((h) => h.name).join(', ');
    return `<div class="bk-meta"><div class="meta-list">
        <div>${icons.clock}${bookingEt().duration_min} min</div>
        <div>${BL.locIcon(et.location_type)}${esc(et.location_type === 'in_person' && et.location_value ? et.location_value : et.location_label)}</div>
        ${hosts && et.hosts.length === 1 ? `<div>${icons.user}${esc(hosts)}</div>` : ''}
      </div>
      ${st.slot ? `<div class="selected-time">${icons.cal.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px"')}${esc(BL.fmtDate(st.slot, st.tz, { weekday: 'short', month: 'short' }))}, ${esc(BL.fmtTime(st.slot, st.tz))}</div>` : ''}</div>`;
  }
  function refreshMeta() { const el = $('.bk-meta', app); if (el) el.outerHTML = meta(); }

  function side() {
    const trust = S.show_trust !== false ? (biz.settings.trust_points || []) : [];
    const showLogo = S.show_logo !== false, showName = S.show_name !== false;
    const title = S.show_title !== false, desc = S.show_description !== false && descOf();
    return `<aside class="booker-side">
      ${showLogo || showName ? `<div class="biz">${showLogo ? logoHtml() : ''}${showName ? `<div class="biz-name">${esc(biz.name)}</div>` : ''}</div>` : ''}
      ${title || desc ? `<div>${title ? `<h1 class="event-title">${esc(titleOf())}</h1>` : ''}${desc ? `<p class="muted desc" style="margin:8px 0 0">${esc(desc)}</p>` : ''}</div>` : ''}
      ${meta()}
      ${biz.settings.urgency_text ? `<div class="urgency">${esc(biz.settings.urgency_text)}</div>` : ''}
      ${trust.length ? `<ul class="trust">${trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${BL.about([S.show_description !== false ? descOf() : ''], trust)}
    </aside>`;
  }

  /** One column: banner, logo, title, and the call's details under them. */
  const header = () => BL.Look.header(S, biz, { title: titleOf(), description: descOf(), extra: meta() });

  function field(name, label, input, required) {
    return `<div class="field"><label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
  }
  // With labels hidden by the look, the placeholder carries the label.
  const hidden = () => S.show_labels === false;

  // "We're available!" — answered from the dates the business has marked as taken.
  function renderAvailability(step) {
    const a = st.avail;
    const when = dateAnswer(step);
    const pretty = when ? BL.fmtDate(when + 'T12:00:00Z', 'UTC', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
    if (!when) return `<div class="done"><p class="muted">Tell us your date and we'll check it.</p></div>`;
    if (!a || a.loading) return `<div class="done"><div class="spinner" style="margin:10px auto"></div><p class="muted">Checking ${esc(pretty)}…</p></div>`;
    if (a.available) {
      return `<div class="done"><div class="done-icon">${icons.check}</div>
        <h2 style="margin:10px 0 4px">We're available!</h2>
        <p class="muted">${esc(step.available_text || `${pretty} is open. Grab a time and we'll talk through the details.`)}</p></div>`;
    }
    return `<div class="done"><div class="done-icon" style="background:#fdf1e7;color:#b4690e">${icons.check}</div>
      <h2 style="margin:10px 0 4px">That date is in demand</h2>
      <p class="muted">${esc(step.unavailable_text || `We may already be booked on ${pretty}, but teams free up and we often have more than one. Let's talk.`)}</p></div>`;
  }

  const dateAnswer = (step) => {
    const id = step.date_question_id || 'event_date';
    const v = st.answers[id];
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : '';
  };

  async function checkDate(step) {
    const when = dateAnswer(step);
    if (!when || (st.avail && st.avail.date === when)) return;
    st.avail = { loading: true, date: when };
    try {
      const r = await fetch(`/api/public/b/${encodeURIComponent(biz.slug)}/date-check?date=${when}`).then((x) => x.json());
      st.avail = { date: when, available: !!r.available };
      capture({ answers: { date_available: r.available ? 'yes' : 'already booked' } }, true);
    } catch (e) {
      // If the check fails, say nothing rather than claiming a date is taken.
      st.avail = { date: when, available: true };
    }
    if ((steps[st.i] || {}).type === 'availability') render();
  }

  function renderGuests() {
    const list = st.guests.length ? `<ul class="guest-list">${st.guests.map((g) => `<li><span>${esc(g)}</span><button type="button" class="btn btn-link btn-sm" data-guest-remove="${esc(g)}">Remove</button></li>`).join('')}</ul>` : '';
    if (!st.guestsOpen && !st.guests.length) return `<div class="guests"><button type="button" class="btn btn-link btn-sm guest-open" data-guest-open>+ Add guests</button></div>`;
    return `<div class="guests">${list}${st.guests.length < MAX_GUESTS ? `<div class="field ${st.guestError ? 'has-error' : ''}"><label for="f-guest">Guest email</label>
      <div class="guest-add"><input class="input" id="f-guest" name="guest" type="email" inputmode="email" placeholder="guest@example.com" value="${esc(st.guestDraft)}" data-guest-input>
      <button type="button" class="btn btn-ghost" data-guest-add>Add</button></div>${st.guestError ? `<div class="field-error">${esc(st.guestError)}</div>` : ''}</div>` : ''}
      <p class="muted small">Guests get the calendar invite and reminders. You can add up to ${MAX_GUESTS}.</p></div>`;
  }

  // Just this block, so the rest of the step does not fade back in on every guest.
  function repaintGuests() {
    const el = $('.guests');
    if (el) el.outerHTML = renderGuests();
    const input = $('#f-guest');
    if (input) input.focus();
  }

  // Adds whatever is typed in the guest box. False when it is not a usable address.
  function commitGuest() {
    const email = st.guestDraft.trim().toLowerCase();
    st.guestError = null;
    if (!email) return true;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { st.guestError = 'Enter a valid email'; return false; }
    if (email !== st.contact.email.trim().toLowerCase() && !st.guests.includes(email)) st.guests.push(email);
    st.guestDraft = '';
    return true;
  }

  function renderContact(step) {
    const f = step.fields || {};
    const c = st.contact;
    const inp = (name, type, auto, ph, label, req) => `<input class="input" id="f-${name}" name="${name}" type="${type}" autocomplete="${auto}" value="${esc(c[name] || '')}" placeholder="${esc(hidden() ? label + (req ? ' *' : '') : ph || '')}" data-contact>`;
    const show = (k) => f[k] !== 'hidden';
    const rq = { first_name: f.first_name === 'required', last_name: f.last_name === 'required', email: f.email !== 'optional', phone: f.phone === 'required' };
    return `<form class="step-form" novalidate>
      <div class="grid-2">${show('first_name') ? field('first_name', 'First name', inp('first_name', 'text', 'given-name', '', 'First name', rq.first_name), rq.first_name) : ''}${show('last_name') ? field('last_name', 'Last name', inp('last_name', 'text', 'family-name', '', 'Last name', rq.last_name), rq.last_name) : ''}</div>
      ${show('email') ? field('email', 'Email', inp('email', 'email', 'email', 'you@example.com', 'Email', rq.email), rq.email) : ''}
      ${show('phone') ? field('phone', 'Phone', inp('phone', 'tel', 'tel', '(555) 555-5555', 'Phone', rq.phone), rq.phone) : ''}
      ${guestsOn() ? renderGuests() : ''}
      ${show('sms_consent') ? `<label class="check"><input type="checkbox" name="sms_consent" data-contact ${c.sms_consent ? 'checked' : ''}><span>${esc(biz.settings.sms_consent_text)}</span></label>` : ''}
      ${biz.settings.privacy_note ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}
    </form>`;
  }

  function questionOptions(q) {
    if (q.use_services && (D.serviceNames || []).length) return D.serviceNames.concat((q.options || []).filter((o) => !D.serviceNames.includes(o)));
    return q.options || [];
  }

  // Questions are drawn by the shared kit, so a booking page can show choices as cards, a list,
  // pills or photo cards and dates as a calendar, typed boxes or the phone's picker.
  // "list" is what the old Show as cards switch saved when off, so it means "as the look says".
  const K = BL.Look.kit({
    S, st, root: app,
    questions: () => (steps[st.i] || {}).questions || [],
    optionsFor: questionOptions,
    displayOf: (q) => (q.display && q.display !== 'list' ? q.display : ''),
    onAnswer: (qid, value, { kind, el, changed }) => {
      const fl = el && el.closest('.field');
      if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
      if (changed) capture({ answers: { [qid]: value } }, kind !== 'step');
      if (kind === 'pick') maybeAdvance();
    },
  });
  const renderQuestion = (q) => K.renderQuestion(q);
  /** A step that is one single pick moves on by itself, if the look says so. */
  function maybeAdvance() {
    const step = steps[st.i];
    if (S.auto_advance === false || !step || step.type !== 'questions' || (step.questions || []).length !== 1 || isLast()) return;
    setTimeout(() => go(1), 200);
  }

  function isLast() { return nextIndex(st.i) === -1; }
  function nextIndex(i) { for (let j = i + 1; j < steps.length; j++) if (!st.skip.has(j)) return j; return -1; }
  function prevIndex(i) { for (let j = i - 1; j >= 0; j--) if (!st.skip.has(j)) return j; return -1; }
  function visibleCount() { return steps.length - st.skip.size; }
  function visiblePos(i) { let n = 0; for (let j = 0; j <= i; j++) if (!st.skip.has(j)) n++; return n; }

  /**
   * How they want to meet, asked above the calendar rather than on a screen of its own.
   *
   * One way of meeting needs no question, so the chooser only appears when there is a real choice.
   * It does not change which times are free, so picking one never reloads the calendar.
   */
  function placeChooser() {
    const places = et.places || [];
    if (places.length < 2) return '';
    return `<div class="place-pick" style="margin-bottom:18px">
      <div class="label" style="margin-bottom:8px">How should we meet?</div>
      <div class="options list">${places.map((p) => `<label class="opt radio ${p.id === st.placeId ? 'is-on' : ''}">
        <input type="radio" name="place" value="${esc(p.id)}" ${p.id === st.placeId ? 'checked' : ''} data-place>
        <span class="tick"></span>
        <span><b>${esc(p.label)}</b>${p.detail ? `<div class="small muted">${esc(p.detail)}</div>` : ''}${p.note ? `<div class="small muted">${esc(p.note)}</div>` : ''}</span>
      </label>`).join('')}</div></div>`;
  }

  function stepHead(step) {
    if (step.type === 'availability' && st.avail && !st.avail.loading) return '';
    const t = S.show_step_titles !== false && step.title ? `<h2>${esc(step.title)}</h2>` : '';
    const sub = S.show_subtitles !== false && step.subtitle ? `<p>${esc(step.subtitle)}</p>` : '';
    return t || sub ? `<div class="step-head">${t}${sub}</div>` : '';
  }

  function nav(step) {
    const back = prevIndex(st.i) >= 0 && S.show_back !== false ? `<button type="button" class="btn btn-link" data-back>${icons.left} ${esc(S.back_label || 'Back')}</button>` : '';
    const label = isLast() ? esc((et.settings || {}).book_button || 'Book my call') : esc(step.type === 'availability' ? (step.cta || 'Set up a call') : (S.continue_label || 'Continue'));
    return `<div class="step-nav"><div class="nav-left">${back}<span class="save-state ${st.saveState}">${st.saveState === 'saved' ? 'Progress saved' : ''}</span></div>
      <button type="button" class="btn btn-primary btn-lg f-next" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${label} ${isLast() || st.busy ? '' : icons.right}</button></div>`;
  }

  let sched = null;
  function render() {
    const step = steps[st.i];
    const shown = steps.map((s, i) => i).filter((i) => !st.skip.has(i));
    let body = '';
    if (step.type === 'schedule') body = (routeTarget() ? '' : placeChooser()) + '<div id="scheduler"></div>';
    else if (step.type === 'availability') body = renderAvailability(step);
    else if (step.type === 'contact') body = renderContact(step);
    else body = `<form class="step-form q-grid" novalidate>${(step.questions || []).map(renderQuestion).join('')}</form>`;
    const inner = `${BL.Look.progress(S, shown.map((i) => steps[i].title), shown.indexOf(st.i))}
        ${stepHead(step)}
        ${st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body">${body}</div>
        ${nav(step)}`;
    app.innerHTML = BL.Look.sideLayout(S)
      ? `<div class="shell"><div class="card booker f-card">${side()}<main class="booker-main">${inner}</main></div></div>${BL.powered()}`
      : `<div class="shell"><div class="card f-card f-single">${header()}<main class="f-main">${inner}</main></div></div>${BL.powered()}`;
    if (step.type === 'schedule') {
      sched = BL.Scheduler({ root: $('#scheduler'), slug: biz.slug, eventSlug: bookingEt().slug, tz: st.tz, selected: st.slot, maxDaysAhead: bookingEt().max_days_ahead,
        calendarStyle: S.calendar_style,
        dateCheck: { business: biz, onEvent: (date, available) => {
          st.answers.event_date = date;
          capture({ answers: { event_date: date, date_available: available ? 'yes' : 'already booked' } }, true);
        } },
        onTzChange: (tz) => { st.tz = tz; },
        onSelect: (iso) => {
          st.slot = iso; st.error = null;
          const label = `${BL.fmtDate(iso, st.tz, { weekday: 'short', month: 'short', year: 'numeric' })} at ${BL.fmtTime(iso, st.tz)} (${st.tz})`;
          st.answers.requested_time = label;
          capture({ answers: { requested_time: label } }, true);
          refreshMeta();
          // With the row of days they press Continue, as the bar under the times says.
          if (!(sched && sched.days)) setTimeout(() => go(1), 180);
        },
      });
    }
    if (step.type === 'availability') checkDate(step);
    const focusable = $('.step-form .input, .step-form .select, .step-form .textarea');
    if (focusable && window.innerWidth > 860 && !BL.data.embed && !PREVIEW) focusable.focus({ preventScroll: true });
  }

  // --------- Validation ---------
  function validate(step) {
    const errors = {};
    if (step.type === 'availability') return errors;
    if (step.type === 'schedule') { if (!st.slot) st.error = 'Pick a date and time to continue.'; return !st.slot ? { _: 1 } : errors; }
    if (step.type === 'contact') {
      // An address typed but never added would otherwise be dropped without them knowing.
      if (!commitGuest()) return { guest: st.guestError };
      const f = step.fields || {}, c = st.contact;
      if (f.first_name === 'required' && !c.first_name.trim()) errors.first_name = 'Required';
      if (f.last_name === 'required' && !c.last_name.trim()) errors.last_name = 'Required';
      const email = c.email.trim();
      if (f.email !== 'hidden' && (f.email === 'required' || email)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email';
      }
      // We must be able to reach them somehow, even on a short form that only asks for a phone.
      if (f.email === 'hidden' && f.phone === 'hidden') errors._ = 'This form has no way to contact you.';
      if (f.phone === 'required' && c.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number';
    }
    if (step.type === 'questions') {
      for (const q of step.questions || []) {
        const v = st.answers[q.id];
        const bad = K.dateProblem(q);
        if (bad) { errors[q.id] = bad; continue; }
        if (q.required && (v == null || v === '' || (Array.isArray(v) && !v.length))) errors[q.id] = 'Required';
      }
    }
    return errors;
  }

  async function go(dir) {
    const step = steps[st.i];
    if (dir > 0) {
      const errors = validate(step);
      if (Object.keys(errors).length) {
        if (step.type === 'schedule') return render();
        st.error = null; BL.fieldErrors(app, errors); return;
      }
      st.error = null;
      if (step.type === 'contact') capture({ contact: st.contact }, true);
      if (isLast()) return book();
      st.i = nextIndex(st.i);
    } else {
      st.i = Math.max(0, prevIndex(st.i));
      st.error = null;
    }
    capture({}, true);
    render();
    if (!BL.data.embed) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function book() {
    if (PREVIEW) { st.error = 'Preview only. Nothing was booked.'; return render(); }
    st.busy = true; render();
    try {
      await ensureLead();
      await saver.flush();
      const r = await api('POST', `/api/public/b/${biz.slug}/e/${et.slug}/book`, { lead_token: st.leadToken, quote_token: st.quoteToken, start: st.slot, timezone: st.tz, contact: st.contact, guests: st.guests, answers: st.answers, place_id: st.placeId });
      BL.store.del(storeKey);
      location.href = r.redirect;
    } catch (e) {
      st.busy = false;
      if (e.status === 409) {
        st.slot = null; st.error = e.message;
        st.i = steps.findIndex((s) => s.type === 'schedule');
        return render();
      }
      st.error = e.message;
      if (e.details) {
        const ci = steps.findIndex((s) => s.type === 'contact');
        if (Object.keys(e.details).some((k) => ['first_name', 'last_name', 'email', 'phone'].includes(k))) st.i = ci;
      }
      render();
      if (e.details) BL.fieldErrors(app, e.details);
    }
  }

  // --------- Events ---------
  app.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-guest-remove]');
    if (remove) { st.guests = st.guests.filter((g) => g !== remove.dataset.guestRemove); return repaintGuests(); }
    if (e.target.closest('[data-guest-open]')) { st.guestsOpen = true; return repaintGuests(); }
    if (e.target.closest('[data-guest-add]')) { commitGuest(); return repaintGuests(); }
    if (K.click(e)) return;
    if (e.target.closest('[data-next]')) { e.preventDefault(); go(1); }
    else if (e.target.closest('[data-back]')) { e.preventDefault(); go(-1); }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });
  app.addEventListener('keydown', (e) => {
    if (K.keydown(e)) return;
    if (e.key === 'Enter' && e.target.matches('[data-guest-input]')) { e.preventDefault(); commitGuest(); return repaintGuests(); }
    if (e.key === 'Enter' && e.target.matches('input.input')) { e.preventDefault(); go(1); } });
  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-guest-input')) { st.guestDraft = t.value; return; }
    if (K.typed(t, e.type === 'change')) return;
    if (t.hasAttribute('data-place')) {
      st.placeId = t.value;
      const chosen = (et.places || []).find((p) => p.id === t.value);
      // Recorded as an answer too, so it shows on the lead and in the team's notification without
      // anyone having to open the booking to find out which one they picked.
      if (chosen) { st.answers.how_we_meet = chosen.label; capture({ answers: { how_we_meet: chosen.label } }, true); }
      $$('[data-place]', app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      return;
    }
    if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      const field = t.closest('.field');
      if (field && field.classList.contains('has-error')) { field.classList.remove('has-error'); const fe = $('.field-error', field); if (fe) fe.remove(); }
      // capture contact fields as they are typed (valid email only saved server side)
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change' || t.type === 'checkbox');
    } else if (t.dataset.q) {
      const id = t.dataset.q;
      const before = bookingEt().slug;
      if (t.dataset.multi === '1') st.answers[id] = $$(`input[data-q="${CSS.escape(id)}"]:checked`, app).map((x) => x.value);
      else st.answers[id] = t.value;
      // A different calendar means a time picked earlier may not exist on it.
      if (bookingEt().slug !== before) { st.slot = null; const sideEl = $('.booker-side'); if (sideEl) sideEl.outerHTML = side(); else refreshMeta(); }
      if (t.closest('.opt')) $$(`input[data-q="${CSS.escape(id)}"]`, app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      capture({ answers: { [id]: st.answers[id] } }, t.type === 'radio' || t.type === 'checkbox' || e.type === 'change');
      if (t.type === 'radio' && e.type === 'change') maybeAdvance();
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { const t = e.target; if (['checkbox', 'radio', 'date', 'number', 'range'].includes(t.type) || t.tagName === 'SELECT' || t.hasAttribute('data-dpart')) onInput(e); });

  // Accepts ?event_date=…&first_name=…&phone=…&email=… from a short CTA on the website.
  async function prefillFromUrl() {
    const CONTACT = ['first_name', 'last_name', 'email', 'phone'];
    const ids = new Set(steps.flatMap((s) => (s.questions || []).map((q) => q.id)));
    const answers = {}, contact = {};
    for (const [k, v] of params) {
      const val = String(v || '').slice(0, 300);
      if (!val) continue;
      if (CONTACT.includes(k)) contact[k] = val;
      else if (ids.has(k)) answers[k] = val;
    }
    if (!Object.keys(answers).length && !Object.keys(contact).length) return;
    st.answers = Object.assign({}, st.answers, answers);
    Object.assign(st.contact, contact);
    // Save it straight away: this is the whole point of the short CTA.
    capture({ answers, contact }, true);
    // Jump past steps whose questions are all answered already.
    steps.forEach((step, idx) => {
      if (step.type !== 'questions') return;
      const qs = step.questions || [];
      if (qs.length && qs.every((q) => { const a = st.answers[q.id]; return Array.isArray(a) ? a.length : String(a || '').trim(); })) st.skip.add(idx);
    });
    let i = 0;
    while (i < steps.length - 1 && st.skip.has(i)) i++;
    st.i = i;
  }

  // --------- Boot: resume a saved lead or prefill from a quote ---------
  async function boot() {
    BL.Look.apply(S, biz);
    if (PREVIEW) return startPreview();
    const resume = params.get('resume') || (BL.store.get(storeKey) || {}).token;
    if (resume) {
      try {
        const lead = await api('GET', `/api/public/leads/${encodeURIComponent(resume)}`);
        if (lead.status === 'partial' || params.get('resume')) {
          st.leadToken = lead.token;
          st.answers = lead.answers || {};
          Object.assign(st.contact, lead.contact);
          const target = Math.min(lead.max_step_index, steps.length - 1);
          st.i = steps[target] && steps[target].type === 'schedule' ? target : Math.max(0, target);
          // schedule step must be re-confirmed if the slot is not in memory
          const schedIdx = steps.findIndex((s) => s.type === 'schedule');
          if (schedIdx <= st.i) st.i = schedIdx;
          if (lead.status !== 'partial') { st.leadToken = null; }
        }
      } catch (e) { BL.store.del(storeKey); }
    }
    if (st.quoteToken) {
      try {
        const q = await api('GET', `/api/public/quotes/${encodeURIComponent(st.quoteToken)}`);
        if (q.lead) {
          st.leadToken = q.lead.token;
          Object.assign(st.contact, q.lead.contact);
          st.answers = Object.assign({}, q.lead.answers, st.answers);
          // Skip the contact step when the quote already has name + email + phone, and skip question steps already answered
          steps.forEach((s, idx) => {
            if (s.type === 'contact' && st.contact.first_name && st.contact.email && (s.fields.phone !== 'required' || st.contact.phone)) st.skip.add(idx);
            if (s.type === 'questions' && (s.questions || []).every((qq) => !qq.required)) st.skip.add(idx);
          });
        }
      } catch (e) { st.quoteToken = null; }
    }
    // Prefill from the URL, so a one-field CTA on the website can hand its answer over
    // and the customer never re-types what they already gave us.
    await prefillFromUrl();
    if (st.skip.has(st.i)) st.i = steps.findIndex((s) => s.type === 'schedule');
    render();
  }
  // The Look editor's live preview: the real page, fed each change of look as it is made.
  function startPreview() {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'availvo:booking-preview') return;
      for (const k of Object.keys(S)) delete S[k];
      Object.assign(S, e.data.style || {});
      if (typeof e.data.step === 'number') { st.i = Math.max(0, Math.min(e.data.step, steps.length - 1)); st.error = null; }
      BL.Look.apply(S, biz);
      render();
    });
    if (window.parent !== window) window.parent.postMessage({ type: 'availvo:booking-preview-ready' }, location.origin);
    render();
  }

  boot();
})();
