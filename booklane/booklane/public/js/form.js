/* A custom form: whatever steps the admin put on it, walked in order.
   Questions, contact details, a note, a live date check, a calendar.

   How it looks comes from form.style (see src/services/form-style.js): one of four layouts
   (full, minimal, thin, visual) plus any number of individual overrides. Looks never change
   what is asked, saved or booked.

   The page never decides availability: the calendar comes from the booking page the form names,
   so what is shown is what is real.

   The builder's live preview loads this same script at /app/form-preview and sends it the unsaved
   form over postMessage. In preview nothing is saved and submitting only shows the thank-you. */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, form = D.form;
  const PREVIEW = !!D.preview;
  const steps = form.steps;
  const storeKey = `form:${biz.slug}:${form.slug}`;
  const C = form.copy;
  const S = Object.assign({}, form.style || {});

  const st = {
    i: 0,
    tz: BL.guessTz(),
    answers: {},
    contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    slot: null,
    avail: null,          // the date check's answer
    leadToken: null,
    busy: false,
    error: null,
    saveState: '',
    typed: {},            // typed dates in progress: { qid: { m, d, y } }
    calMonth: {},         // which month each inline date calendar is showing
  };
  const app = document.getElementById('app');

  const cur = () => steps[st.i];
  const isLast = () => st.i === steps.length - 1;

  // ---------- the look (public/js/look.js, shared with booking pages) ----------
  const applyStyle = () => BL.Look.apply(S, biz);
  const logoHtml = () => BL.Look.logoHtml(S, biz);

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
    if (PREVIEW) return;
    ensureLead().then((t) => t && saver.queue(Object.assign({ step_index: st.i, step_key: cur().key, step_total: steps.length }, patch), now));
  }

  // ---------- pieces ----------
  function side() {
    return `<aside class="booker-side">
      ${S.show_logo !== false || S.show_name !== false ? `<div class="biz">${S.show_logo !== false ? logoHtml() : ''}${S.show_name !== false ? `<div class="biz-name">${esc(biz.name)}</div>` : ''}</div>` : ''}
      ${S.show_title !== false || (S.show_description !== false && form.description) ? `<div>${S.show_title !== false ? `<h1 class="event-title">${esc(form.name)}</h1>` : ''}${S.show_description !== false && form.description ? `<p class="muted desc" style="margin:8px 0 0">${esc(form.description)}</p>` : ''}</div>` : ''}
      ${st.slot ? `<div class="selected-time">${esc(BL.fmtDate(st.slot, st.tz, { weekday: 'short', month: 'short' }))}, ${esc(BL.fmtTime(st.slot, st.tz))}</div>` : ''}
      ${S.show_trust !== false ? `<ul class="trust">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
      ${BL.about([S.show_description !== false ? form.description : ''], S.show_trust !== false ? biz.settings.trust_points : [])}
    </aside>`;
  }

  const banner = () => BL.Look.banner(S);

  /** The top of a single-column form: banner, logo, name, title, description, as switched on. */
  const header = () => BL.Look.header(S, biz, { title: form.name, description: form.description });

  const progress = () => BL.Look.progress(S, steps.map((s) => s.title), st.i);

  // ----- questions: drawn by the shared kit, so booking pages get the same choices -----
  const K = BL.Look.kit({
    S, st, root: app,
    questions: () => cur().questions || [],
    onAnswer: (qid, value, { kind, el, changed }) => {
      clearErr(el);
      if (kind === 'pick') { capture({ answers: { [qid]: value } }, true); refreshNav(); return maybeAdvance(); }
      if (kind === 'step') return capture({ answers: { [qid]: value } }, false);
      if (changed) capture({ answers: { [qid]: value } }, true);
    },
  });
  const { field, has, optionDisplay, dateDisplay, renderQuestion } = K;

  function renderContact(step) {
    const f = step.fields || {};
    const show = (k) => f[k] !== 'hidden';
    const isReq = (k) => f[k] === 'required';
    const hide = S.show_labels === false;
    const inp = (n, t, ac, label) => `<input class="input" id="f-${n}" name="${n}" type="${t}" data-contact value="${esc(st.contact[n])}" autocomplete="${ac}" placeholder="${hide ? esc(label + (isReq(n) ? ' *' : '')) : ''}">`;
    const pair = (a, b) => (a && b ? 'grid-2' : '');
    return `<form class="step-form" novalidate>
      <div class="${pair(show('first_name'), show('last_name'))}">
        ${show('first_name') ? field('first_name', 'First name', inp('first_name', 'text', 'given-name', 'First name'), isReq('first_name')) : ''}
        ${show('last_name') ? field('last_name', 'Last name', inp('last_name', 'text', 'family-name', 'Last name'), isReq('last_name')) : ''}
      </div>
      <div class="${S.layout === 'thin' ? pair(show('email'), show('phone')) : ''}">
        ${show('email') ? field('email', 'Email', inp('email', 'email', 'email', 'Email'), isReq('email')) : ''}
        ${show('phone') ? field('phone', 'Mobile', inp('phone', 'tel', 'tel', 'Mobile'), isReq('phone')) : ''}
      </div>
      ${show('sms_consent') ? `<label class="check"><input type="checkbox" name="sms_consent" data-contact ${st.contact.sms_consent ? 'checked' : ''}><span>${esc(biz.settings.sms_consent_text || 'Text me about my booking')}</span></label>` : ''}
      ${biz.settings.privacy_note && S.layout !== 'thin' ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}
    </form>`;
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
    const pic = step.image ? `<div class="f-step-img"><img src="${esc(step.image)}" alt=""></div>` : '';
    if (step.type === 'questions') return `${pic}<form class="step-form q-grid" novalidate>${(step.questions || []).map(renderQuestion).join('')}</form>`;
    if (step.type === 'contact') return pic + renderContact(step);
    if (step.type === 'message') return `${pic}<div class="price-panel f-message"><p>${esc(step.body || '')}</p></div>`;
    if (step.type === 'availability') return pic + renderAvailability(step);
    if (step.type === 'schedule') return PREVIEW ? `${pic}<div class="f-preview-cal"><div class="muted">The live calendar from ${esc((step.event && step.event.name) || 'the booking page you picked')} shows here, with real open times.</div></div>` : `${pic}<div id="scheduler"></div>`;
    return pic;
  }

  const ctaLabel = () => (isLast() ? (C.submit_cta || 'Submit') : (S.continue_label || 'Continue'));

  /** One question that is a single pick: choosing it is the answer, so the step moves on by itself. */
  function advancesOnPick(step) {
    if (!S.auto_advance || !step || step.type !== 'questions' || isLast()) return false;
    const qs = step.questions || [];
    if (qs.length !== 1) return false;
    const q = qs[0];
    return (q.type === 'choice' && optionDisplay(q) !== 'dropdown') || (q.type === 'date' && dateDisplay(q) === 'calendar');
  }

  function nav(step) {
    const back = st.i > 0 && S.show_back !== false ? `<button type="button" class="btn btn-link" data-back>${icons.left} ${esc(S.back_label || 'Back')}</button>` : '';
    const hideNext = advancesOnPick(step) && !st.answers[(step.questions || [])[0].id];
    const next = hideNext ? '' : `<button type="button" class="btn btn-primary btn-lg f-next" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${esc(ctaLabel())} ${isLast() || st.busy ? '' : icons.right}</button>`;
    if (!back && !next) return '';
    return `<div class="step-nav"><div class="nav-left">${back}<span class="save-state ${st.saveState}"></span></div>${next}</div>`;
  }

  function stepHead(step) {
    const t = S.show_step_titles !== false && step.title ? `<h2>${esc(step.title)}</h2>` : '';
    const sub = S.show_subtitles !== false && step.subtitle ? `<p>${esc(step.subtitle)}</p>` : '';
    return t || sub ? `<div class="step-head">${t}${sub}</div>` : '';
  }

  function render() {
    const step = cur();
    const errHtml = st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : '';
    const inner = `${progress()}${stepHead(step)}${errHtml}<div class="step-body">${stepBody(step)}</div>${nav(step)}`;
    if ((S.layout || 'full') === 'full' && S.show_sidebar !== false) {
      app.innerHTML = `<div class="shell"><div class="card booker f-card">${side()}<main class="booker-main">${inner}</main></div></div>${BL.powered()}`;
    } else {
      app.innerHTML = `<div class="shell"><div class="card f-card f-single">${header()}<main class="f-main">${inner}</main></div></div>${BL.powered()}`;
    }
    if (step.type === 'schedule' && !PREVIEW) mountScheduler();
    if (step.type === 'availability') checkDate(step);
  }

  function mountScheduler() {
    BL.Scheduler({
      root: $('#scheduler'), tz: st.tz, selected: st.slot, maxDaysAhead: 180, calendarStyle: S.calendar_style,
      slotsUrl: `/api/public/b/${encodeURIComponent(biz.slug)}/f/${encodeURIComponent(form.slug)}/slots`,
      dateCheck: { business: biz, onEvent: (date, available) => {
        st.answers.event_date = date;
        capture({ answers: { event_date: date, date_available: available ? 'yes' : 'already booked' } }, true);
      } },
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
  // Errors are keyed by question id; markErrors finds the field whichever way it is drawn.
  function markErrors(errs) {
    for (const [k, msg] of Object.entries(errs)) {
      const el = app.querySelector(`[name="${CSS.escape(k)}"], [data-group="${CSS.escape(k)}"], [data-typed="${CSS.escape(k)}"]`);
      const f = el && el.closest('.field');
      if (f && !f.classList.contains('has-error')) { f.classList.add('has-error'); f.insertAdjacentHTML('beforeend', `<div class="field-error">${esc(msg)}</div>`); }
    }
  }

  function problems() {
    const step = cur();
    const errs = {};
    if (step.type === 'questions') {
      for (const q of step.questions || []) {
        const v = st.answers[q.id];
        const bad = K.dateProblem(q);
        if (bad) { errs[q.id] = bad; continue; }
        if (q.type === 'number' && has(v)) {
          const n = Number(v);
          if (!Number.isFinite(n)) { errs[q.id] = 'Enter a number'; continue; }
          if (has(q.min) && n < q.min) { errs[q.id] = `At least ${q.min}`; continue; }
          if (has(q.max) && n > q.max) { errs[q.id] = `At most ${q.max}`; continue; }
        }
        if (!q.required) continue;
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) errs[q.id] = 'Required';
      }
      return { errs, msg: 'Please fill in the highlighted fields.' };
    }
    if (step.type === 'contact') {
      const f = step.fields || {};
      if (f.first_name === 'required' && !st.contact.first_name.trim()) errs.first_name = 'Required';
      if (f.last_name === 'required' && !st.contact.last_name.trim()) errs.last_name = 'Required';
      if (f.email !== 'hidden' && (f.email === 'required' || st.contact.email.trim())) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(st.contact.email.trim())) errs.email = 'Enter a valid email';
      }
      if (f.phone === 'required' && st.contact.phone.replace(/\D/g, '').length < 7) errs.phone = 'Enter a valid phone number';
      return { errs, msg: 'Please fix the highlighted fields.' };
    }
    if (step.type === 'schedule' && !st.slot && !PREVIEW) return { errs, msg: 'Pick a time to continue.' };
    return { errs, msg: null };
  }

  async function go(dir) {
    st.error = null;
    if (dir > 0) {
      const p = problems();
      if (Object.keys(p.errs).length || (p.msg && cur().type === 'schedule')) {
        st.error = p.msg;
        render();
        markErrors(p.errs);
        const first = $('.field.has-error', app);
        if (first && first.getBoundingClientRect().top < 0) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (isLast()) return submit();
      st.i += 1;
    } else {
      st.i = Math.max(0, st.i - 1);
    }
    capture({}, false);
    render();
    // Keep the top of a new step in view on a long page or a phone.
    const card = $('.f-card', app);
    if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function submit() {
    if (PREVIEW) { done({ copy: C }); return; }
    st.busy = true; render();
    try {
      const r = await api('POST', `/api/public/b/${biz.slug}/f/${form.slug}/submit`, {
        lead_token: st.leadToken,
        contact: st.contact,
        answers: st.answers,
        start: st.slot,
        timezone: st.tz,
      });
      if (r.kind === 'booked' && r.redirect) { location.href = r.redirect; return; }
      if (r.redirect) { location.href = r.redirect; return; }
      done(r);
    } catch (e) {
      st.busy = false;
      st.error = e.message || 'Something went wrong. Please try again.';
      render();
      if (e.details) markErrors(Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k.replace(/^(answers|contact)\./, ''), v])));
    }
  }

  function done(r) {
    const c = (r && r.copy) || C;
    if (!PREVIEW) BL.store.del(storeKey);
    const showLogo = S.show_logo !== false, showName = S.show_name !== false;
    app.innerHTML = `<div class="shell"><div class="card f-card f-single f-done">${banner()}
      <main class="f-main">
      ${showLogo || showName ? `<div class="f-brand">${showLogo ? logoHtml() : ''}${showName ? `<div class="biz-name">${esc(biz.name)}</div>` : ''}</div>` : ''}
      <div class="done-icon">${icons.check}</div>
      <h1 class="f-title">${esc(c.done_heading || 'Thank you')}</h1>
      <p class="muted">${esc(c.done_blurb || '')}</p>
      ${PREVIEW ? '<p class="small muted" style="margin-top:18px">Preview only. Nothing was sent. <button type="button" class="btn btn-link btn-sm" data-restart>Start again</button></p>' : ''}
    </main></div></div>${BL.powered()}`;
  }

  // ---------- events ----------
  function clearErr(el) {
    const fl = el && el.closest('.field');
    if (fl && fl.classList.contains('has-error')) { fl.classList.remove('has-error'); const fe = $('.field-error', fl); if (fe) fe.remove(); }
    if (st.error && !$('.field.has-error', app)) { st.error = null; const fe = $('.form-error', app); if (fe) fe.remove(); }
  }
  function refreshNav() { const n = $('.step-nav', app); const html = nav(cur()); if (n) n.outerHTML = html || ''; else if (html) $('.step-body', app).insertAdjacentHTML('afterend', html); }
  function maybeAdvance() { if (advancesOnPick(cur())) setTimeout(() => go(1), 220); }

  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-next]')) { e.preventDefault(); return go(1); }
    if (e.target.closest('[data-back]')) { e.preventDefault(); return go(-1); }
    if (e.target.closest('[data-restart]')) { st.i = 0; st.answers = {}; st.typed = {}; return render(); }
    K.click(e);
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });

  function onInput(e) {
    const t = e.target;
    if (K.typed(t, e.type === 'change')) return;
    if (t.hasAttribute('data-q')) {
      const id = t.getAttribute('data-q');
      if (t.dataset.multi === '1') {
        const set = new Set([].concat(st.answers[id] || []));
        if (t.checked) set.add(t.value); else set.delete(t.value);
        st.answers[id] = [...set];
        $$(`[data-q="${CSS.escape(id)}"]`, app).forEach((x) => x.closest('.opt') && x.closest('.opt').classList.toggle('is-on', x.checked));
      } else if (t.type === 'radio') {
        st.answers[id] = t.value;
        $$(`[data-q="${CSS.escape(id)}"]`, app).forEach((x) => x.closest('.opt') && x.closest('.opt').classList.toggle('is-on', x.checked));
      } else if (t.type === 'range') {
        st.answers[id] = Number(t.value);
        const q = (cur().questions || []).find((x) => x.id === id) || {};
        const out = $(`[data-out="${CSS.escape(id)}"]`, app); if (out) out.textContent = `${t.value}${q.suffix ? ' ' + q.suffix : ''}`;
      } else {
        st.answers[id] = t.value;
      }
      clearErr(t);
      capture({ answers: { [id]: st.answers[id] } }, e.type === 'change');
      if (t.type === 'radio' && e.type === 'change') { refreshNav(); maybeAdvance(); }
    } else if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      clearErr(t);
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change' || t.type === 'checkbox');
    }
  }
  app.addEventListener('input', (e) => { if (e.target.type !== 'radio' && e.target.type !== 'checkbox') onInput(e); });
  app.addEventListener('change', (e) => {
    const t = e.target;
    if (['checkbox', 'radio', 'number', 'range', 'date'].includes(t.type) || t.tagName === 'SELECT' || t.hasAttribute('data-dpart')) onInput(e);
  });
  // Backspace in an empty date box steps back to the one before it.
  app.addEventListener('keydown', (e) => K.keydown(e));

  function empty(msg) { app.innerHTML = `<div class="shell"><div class="card f-card f-single">${header()}<main class="f-main"><p class="muted">${esc(msg)}</p></main></div></div>`; }

  // ---------- the builder's live preview ----------
  if (PREVIEW && window.parent !== window) {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'availvo:form-preview') return;
      const d = e.data;
      for (const k of Object.keys(S)) delete S[k];
      Object.assign(S, d.style || {});
      if (d.copy) Object.assign(C, d.copy);
      if (d.form) { form.name = d.form.name || ''; form.description = d.form.description || ''; }
      if (Array.isArray(d.steps)) {
        steps.splice(0, steps.length, ...d.steps);
        if (typeof d.focus === 'number') st.i = d.focus;
        st.i = Math.max(0, Math.min(st.i, steps.length - 1));
      }
      applyStyle();
      if (!steps.length) return empty('Add a step to see the form here.');
      render();
    });
    window.parent.postMessage({ type: 'availvo:form-preview-ready' }, location.origin);
    applyStyle();
    return empty('Loading the preview…');
  }

  applyStyle();
  if (!steps.length) return empty('This form has no steps yet.');
  render();
})();
