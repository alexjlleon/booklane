/* Multi-step booking flow with partial lead capture */
(function () {
  'use strict';
  const { esc, api, icons, $, $$ } = BL;
  const D = BL.data, biz = D.business, et = D.eventType;
  const params = new URLSearchParams(location.search);
  const storeKey = `lead:${biz.slug}:${et.slug}`;

  const st = {
    i: 0, tz: BL.guessTz(), slot: null, answers: {}, contact: { first_name: '', last_name: '', email: '', phone: '', sms_consent: false },
    leadToken: null, quoteToken: params.get('quote') || null, busy: false, error: null, saveState: '', skip: new Set(),
  };
  const steps = et.steps;
  const app = document.getElementById('app');

  const saver = BL.createSaver({
    url: () => st.leadToken && `/api/public/leads/${st.leadToken}`,
    beaconUrl: () => st.leadToken && `/api/public/leads/${st.leadToken}/beacon`,
    onState: (s) => { st.saveState = s; const el = $('.save-state'); if (el) { el.className = 'save-state ' + s; el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Progress saved' : ''; } },
  });

  let leadPromise = null;
  function ensureLead() {
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
  function side() {
    const hosts = (et.hosts || []).map((h) => h.name).join(', ');
    return `<aside class="booker-side">
      <div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
      <div><h1 class="event-title">${esc(et.name)}</h1>${et.description ? `<p class="muted desc" style="margin:8px 0 0">${esc(et.description)}</p>` : ''}</div>
      <div class="meta-list">
        <div>${icons.clock}${et.duration_min} min</div>
        <div>${BL.locIcon(et.location_type)}${esc(et.location_type === 'in_person' && et.location_value ? et.location_value : et.location_label)}</div>
        ${hosts && et.hosts.length === 1 ? `<div>${icons.user}${esc(hosts)}</div>` : ''}
      </div>
      ${st.slot ? `<div class="selected-time">${icons.cal.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px;margin-right:6px"')}${esc(BL.fmtDate(st.slot, st.tz, { weekday: 'short', month: 'short' }))}, ${esc(BL.fmtTime(st.slot, st.tz))}</div>` : ''}
      ${biz.settings.urgency_text ? `<div class="urgency">${esc(biz.settings.urgency_text)}</div>` : ''}
      <ul class="trust">${(biz.settings.trust_points || []).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </aside>`;
  }

  function field(name, label, input, required) {
    return `<div class="field"><label for="f-${name}">${esc(label)}${required ? ' <span class="req">*</span>' : ''}</label>${input}</div>`;
  }

  function renderContact(step) {
    const f = step.fields || {};
    const c = st.contact;
    const inp = (name, type, auto, ph) => `<input class="input" id="f-${name}" name="${name}" type="${type}" autocomplete="${auto}" value="${esc(c[name] || '')}" placeholder="${esc(ph || '')}" data-contact>`;
    const show = (k) => f[k] !== 'hidden';
    return `<form class="step-form" novalidate>
      <div class="grid-2">${show('first_name') ? field('first_name', 'First name', inp('first_name', 'text', 'given-name'), f.first_name === 'required') : ''}${show('last_name') ? field('last_name', 'Last name', inp('last_name', 'text', 'family-name'), f.last_name === 'required') : ''}</div>
      ${field('email', 'Email', inp('email', 'email', 'email', 'you@example.com'), true)}
      ${show('phone') ? field('phone', 'Phone', inp('phone', 'tel', 'tel', '(555) 555-5555'), f.phone === 'required') : ''}
      ${show('sms_consent') ? `<label class="check"><input type="checkbox" name="sms_consent" data-contact ${c.sms_consent ? 'checked' : ''}><span>${esc(biz.settings.sms_consent_text)}</span></label>` : ''}
      ${biz.settings.privacy_note ? `<p class="muted small" style="margin-top:14px">${esc(biz.settings.privacy_note)}</p>` : ''}
    </form>`;
  }

  function questionOptions(q) {
    if (q.use_services && (D.serviceNames || []).length) return D.serviceNames.concat((q.options || []).filter((o) => !D.serviceNames.includes(o)));
    return q.options || [];
  }

  function renderQuestion(q) {
    const v = st.answers[q.id];
    const req = q.required;
    if (q.type === 'choice' || q.type === 'multi') {
      const multi = q.type === 'multi';
      const vals = [].concat(v || []);
      const opts = questionOptions(q).map((o) => `<label class="opt ${multi ? '' : 'radio'} ${vals.includes(o) ? 'is-on' : ''}"><input type="${multi ? 'checkbox' : 'radio'}" name="${esc(q.id)}" value="${esc(o)}" ${vals.includes(o) ? 'checked' : ''} data-q="${esc(q.id)}" data-multi="${multi ? 1 : 0}"><span class="tick"></span><span>${esc(o)}</span></label>`).join('');
      return `<div class="field" role="group" aria-label="${esc(q.label)}"><span class="label">${esc(q.label)}${req ? ' <span class="req">*</span>' : ''}</span><div class="options ${q.display === 'cards' ? '' : 'list'}"><input type="hidden" name="${esc(q.id)}">${opts}</div></div>`;
    }
    if (q.type === 'select') {
      return field(q.id, q.label, `<select class="select" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}"><option value="">Select…</option>${(q.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`, req);
    }
    if (q.type === 'textarea') return field(q.id, q.label, `<textarea class="textarea" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}">${esc(v || '')}</textarea>`, req);
    const type = q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text';
    const min = q.type === 'date' ? ` min="${BL.todayIn(st.tz)}"` : '';
    return field(q.id, q.label, `<input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="${type}"${min} value="${esc(v || '')}" data-q="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}">`, req);
  }

  function isLast() { return nextIndex(st.i) === -1; }
  function nextIndex(i) { for (let j = i + 1; j < steps.length; j++) if (!st.skip.has(j)) return j; return -1; }
  function prevIndex(i) { for (let j = i - 1; j >= 0; j--) if (!st.skip.has(j)) return j; return -1; }
  function visibleCount() { return steps.length - st.skip.size; }
  function visiblePos(i) { let n = 0; for (let j = 0; j <= i; j++) if (!st.skip.has(j)) n++; return n; }

  function render() {
    const step = steps[st.i];
    const pos = visiblePos(st.i), total = visibleCount();
    let body = '';
    if (step.type === 'schedule') body = '<div id="scheduler"></div>';
    else if (step.type === 'contact') body = renderContact(step);
    else body = `<form class="step-form" novalidate>${(step.questions || []).map(renderQuestion).join('')}</form>`;
    app.innerHTML = `<div class="shell"><div class="card booker">${side()}
      <main class="booker-main">
        <div class="progress" aria-label="Step ${pos} of ${total}"><div class="progress-bar"><span style="width:${Math.round((pos / total) * 100)}%"></span></div><div class="progress-count">${pos} / ${total}</div></div>
        <div class="step-head"><h2>${esc(step.title || '')}</h2>${step.subtitle ? `<p>${esc(step.subtitle)}</p>` : ''}</div>
        ${st.error ? `<div class="form-error" role="alert">${esc(st.error)}</div>` : ''}
        <div class="step-body">${body}</div>
        <div class="step-nav">
          <div>${prevIndex(st.i) >= 0 ? `<button type="button" class="btn btn-link" data-back>${icons.left} Back</button>` : `<span class="save-state ${st.saveState}">${st.saveState === 'saved' ? 'Progress saved' : ''}</span>`}</div>
          ${prevIndex(st.i) >= 0 ? `<span class="save-state ${st.saveState}">${st.saveState === 'saved' ? 'Progress saved' : ''}</span>` : ''}
          <button type="button" class="btn btn-primary btn-lg" data-next ${st.busy ? 'disabled' : ''}>${st.busy ? '<span class="spinner"></span>' : ''}${isLast() ? 'Book my call' : 'Continue'} ${isLast() || st.busy ? '' : icons.right}</button>
        </div>
      </main></div></div>${BL.powered()}`;
    if (step.type === 'schedule') {
      BL.Scheduler({ root: $('#scheduler'), slug: biz.slug, eventSlug: et.slug, tz: st.tz, selected: st.slot, maxDaysAhead: et.max_days_ahead,
        onTzChange: (tz) => { st.tz = tz; },
        onSelect: (iso) => {
          st.slot = iso; st.error = null;
          const label = `${BL.fmtDate(iso, st.tz, { weekday: 'short', month: 'short', year: 'numeric' })} at ${BL.fmtTime(iso, st.tz)} (${st.tz})`;
          st.answers.requested_time = label;
          capture({ answers: { requested_time: label } }, true);
          const sideEl = $('.booker-side');
          if (sideEl) sideEl.outerHTML = side();
          setTimeout(() => go(1), 180);
        },
      });
    }
    const focusable = $('.step-form .input, .step-form .select, .step-form .textarea');
    if (focusable && window.innerWidth > 860 && !BL.data.embed) focusable.focus({ preventScroll: true });
  }

  // --------- Validation ---------
  function validate(step) {
    const errors = {};
    if (step.type === 'schedule') { if (!st.slot) st.error = 'Pick a date and time to continue.'; return !st.slot ? { _: 1 } : errors; }
    if (step.type === 'contact') {
      const f = step.fields || {}, c = st.contact;
      if (f.first_name === 'required' && !c.first_name.trim()) errors.first_name = 'Required';
      if (f.last_name === 'required' && !c.last_name.trim()) errors.last_name = 'Required';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email.trim())) errors.email = 'Enter a valid email';
      if (f.phone === 'required' && c.phone.replace(/\D/g, '').length < 7) errors.phone = 'Enter a valid phone number';
    }
    if (step.type === 'questions') {
      for (const q of step.questions || []) {
        const v = st.answers[q.id];
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
    st.busy = true; render();
    try {
      await ensureLead();
      await saver.flush();
      const r = await api('POST', `/api/public/b/${biz.slug}/e/${et.slug}/book`, { lead_token: st.leadToken, quote_token: st.quoteToken, start: st.slot, timezone: st.tz, contact: st.contact, answers: st.answers });
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
    if (e.target.closest('[data-next]')) { e.preventDefault(); go(1); }
    else if (e.target.closest('[data-back]')) { e.preventDefault(); go(-1); }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });
  app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input.input')) { e.preventDefault(); go(1); } });
  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-contact')) {
      st.contact[t.name] = t.type === 'checkbox' ? t.checked : t.value;
      const field = t.closest('.field');
      if (field && field.classList.contains('has-error')) { field.classList.remove('has-error'); const fe = $('.field-error', field); if (fe) fe.remove(); }
      // capture contact fields as they are typed (valid email only saved server side)
      capture({ contact: { [t.name]: st.contact[t.name] } }, e.type === 'change' || t.type === 'checkbox');
    } else if (t.dataset.q) {
      const id = t.dataset.q;
      if (t.dataset.multi === '1') st.answers[id] = $$(`input[data-q="${CSS.escape(id)}"]:checked`, app).map((x) => x.value);
      else st.answers[id] = t.value;
      if (t.closest('.opt')) $$(`input[data-q="${CSS.escape(id)}"]`, app).forEach((x) => x.closest('.opt').classList.toggle('is-on', x.checked));
      capture({ answers: { [id]: st.answers[id] } }, t.type === 'radio' || t.type === 'checkbox' || e.type === 'change');
      if (t.type === 'radio') {
        const step = steps[st.i];
        if ((step.questions || []).length === 1 && !isLast()) setTimeout(() => go(1), 200);
      }
    }
  }
  app.addEventListener('input', onInput);
  app.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.type === 'radio' || e.target.tagName === 'SELECT' || e.target.type === 'date') onInput(e); });

  // --------- Boot: resume a saved lead or prefill from a quote ---------
  async function boot() {
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
    if (st.skip.has(st.i)) st.i = steps.findIndex((s) => s.type === 'schedule');
    render();
  }
  boot();
})();
