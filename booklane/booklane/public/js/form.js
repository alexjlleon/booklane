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

  // ---------- the look ----------
  const FONT_KIND = { 'Playfair Display': 'serif', 'Cormorant Garamond': 'serif', Lora: 'serif', 'Libre Baskerville': 'serif', 'EB Garamond': 'serif', 'Great Vibes': 'script', Parisienne: 'script' };
  const fontStack = (f) => {
    if (!f || f === 'System') return 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const kind = FONT_KIND[f];
    return `"${f}", ${kind === 'serif' ? 'Georgia, "Times New Roman", serif' : kind === 'script' ? 'cursive' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}`;
  };
  // The server adds the font link for a saved form; the preview can switch fonts, so load on demand.
  function ensureFont(f) {
    if (!f || f === 'System' || f === 'Plus Jakarta Sans') return;
    const id = 'font-' + f.replace(/\W+/g, '-');
    if (document.getElementById(id)) return;
    const w = FONT_KIND[f] === 'script' ? '400' : f === 'Libre Baskerville' ? '400;700' : (f === 'Cormorant Garamond' || f === 'Lora') ? '400;500;600;700' : '400;500;600;700;800';
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${w}&display=swap`;
    document.head.appendChild(l);
  }
  const rgbOf = (hex) => { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  const light = (hex) => { const [r, g, b] = rgbOf(hex).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45; };
  const STYLE_CLASSES = /^(layout|density|align|btn|img|fit)-|^(no-shadow|no-border|labels-hidden|has-bg-image|has-custom-bg|fixed-cols|btn-full)$/;

  function applyStyle() {
    const root = document.documentElement;
    root.removeAttribute('style');
    document.body.className = document.body.className.split(' ').filter((c) => c && !STYLE_CLASSES.test(c)).join(' ');
    const r = root.style;
    const accent = isHex(S.accent) ? S.accent : (isHex(biz.brand_color) ? biz.brand_color : null);
    if (accent) { r.setProperty('--brand', accent); r.setProperty('--brand-rgb', rgbOf(accent).join(',')); }
    r.setProperty('--btn-ink', isHex(S.button_text) ? S.button_text : (accent && light(accent) ? '#1c1a22' : '#ffffff'));
    if (isHex(S.surface)) { r.setProperty('--surface', S.surface); r.setProperty('--surface-2', `color-mix(in srgb, ${S.surface} 94%, ${light(S.surface) ? '#000' : '#fff'})`); }
    if (isHex(S.text)) {
      r.setProperty('--ink', S.text);
      r.setProperty('--ink-2', `color-mix(in srgb, ${S.text} 80%, transparent)`);
      r.setProperty('--muted', `color-mix(in srgb, ${S.text} 60%, transparent)`);
    }
    if (isHex(S.text) || isHex(S.surface)) {
      r.setProperty('--line', 'color-mix(in srgb, var(--ink) 12%, var(--surface))');
      r.setProperty('--line-2', 'color-mix(in srgb, var(--ink) 22%, var(--surface))');
    }
    if (isHex(S.background)) r.setProperty('--bg', S.background);
    if (S.background_image) {
      const o = Math.max(0, Math.min(85, Number(S.overlay) || 0)) / 100;
      r.setProperty('--bg-image', `linear-gradient(rgba(0,0,0,${o}), rgba(0,0,0,${o})), url("${S.background_image}")`);
    }
    ensureFont(S.font); ensureFont(S.heading_font);
    r.setProperty('--font', fontStack(S.font));
    r.setProperty('--heading-font', S.heading_font ? fontStack(S.heading_font) : 'var(--font)');
    if (S.font_size) r.setProperty('--fs', `${S.font_size}px`);
    if (S.heading_size) r.setProperty('--hs', `${S.heading_size}px`);
    if (S.radius !== undefined) r.setProperty('--radius', `${S.radius}px`);
    if (S.field_radius !== undefined) { r.setProperty('--field-radius', `${S.field_radius}px`); r.setProperty('--radius-sm', `${S.field_radius}px`); }
    if (S.width) r.setProperty('--form-width', `${S.width}px`);
    r.setProperty('--header-h', `${S.header_height || 160}px`);
    if (S.option_columns && S.option_columns !== 'auto') r.setProperty('--opt-cols', String(S.option_columns));

    const cls = document.body.classList;
    cls.add('form-page', `layout-${S.layout || 'full'}`, `density-${S.density || 'comfortable'}`, `align-${S.align || 'left'}`,
      `btn-${S.button_shape || 'rounded'}`, `btn-${S.button_style || 'filled'}`, `img-${S.image_shape || 'square'}`, `fit-${S.image_fit || 'cover'}`);
    if (S.button_full) cls.add('btn-full');
    if (S.shadow === false) cls.add('no-shadow');
    if (S.border === false) cls.add('no-border');
    if (S.show_labels === false) cls.add('labels-hidden');
    if (S.background_image) cls.add('has-bg-image');
    if (isHex(S.background) || S.background_image) cls.add('has-custom-bg');
    if (S.option_columns && S.option_columns !== 'auto') cls.add('fixed-cols');
    let tag = document.getElementById('form-custom-css');
    if (!tag) { tag = document.createElement('style'); tag.id = 'form-custom-css'; document.head.appendChild(tag); }
    tag.textContent = S.custom_css || '';
  }

  const logoUrl = () => S.logo_url || biz.logo_url || '';
  const logoHtml = () => (logoUrl() ? `<div class="biz-logo"><img src="${esc(logoUrl())}" alt="${esc(biz.name)}"></div>` : BL.logo(biz));

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
    </aside>`;
  }

  const banner = () => (S.header_image ? `<div class="f-banner" style="background-image:url('${esc(S.header_image)}')"></div>` : '');

  /** The top of a single-column form: banner, logo, name, title, description, as switched on. */
  function header() {
    const b = banner();
    const showLogo = S.show_logo !== false;
    const showName = S.show_name !== false;
    const trust = biz.settings.trust_points || [];
    const bits = [
      showLogo || showName ? `<div class="f-brand">${showLogo ? logoHtml() : ''}${showName ? `<div class="biz-name">${esc(biz.name)}</div>` : ''}</div>` : '',
      S.show_title !== false && form.name ? `<h1 class="f-title">${esc(form.name)}</h1>` : '',
      S.show_description !== false && form.description ? `<p class="f-desc">${esc(form.description)}</p>` : '',
      S.show_trust !== false && S.layout === 'visual' && trust.length ? `<ul class="f-trust">${trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '',
    ].join('');
    return `${b}${bits ? `<header class="f-head${b ? ' over-banner' : ''}">${bits}</header>` : ''}`;
  }

  function progress() {
    const n = steps.length, at = st.i + 1;
    if (n < 2 || S.progress === 'none') return '';
    const label = `Step ${at} of ${n}`;
    if (S.progress === 'count') return `<div class="f-progress count" aria-label="${label}">${label}</div>`;
    if (S.progress === 'dots') {
      return `<div class="f-progress dots" role="img" aria-label="${label}">${steps.map((_, i) => `<span class="${i < st.i ? 'past' : i === st.i ? 'on' : ''}"></span>`).join('')}</div>`;
    }
    if (S.progress === 'steps') {
      return `<ol class="f-progress named" aria-label="${label}">${steps.map((s, i) => `<li class="${i < st.i ? 'past' : i === st.i ? 'on' : ''}"><span class="n">${i < st.i ? '✓' : i + 1}</span><span class="t">${esc(s.title || `Step ${i + 1}`)}</span></li>`).join('')}</ol>`;
    }
    return `<div class="progress" aria-label="${label}"><div class="progress-bar"><span style="width:${Math.round((at / n) * 100)}%"></span></div>${S.progress_count === false ? '' : `<div class="progress-count">${at} / ${n}</div>`}</div>`;
  }

  const req = (r) => (r ? ' <span class="req">*</span>' : '');
  const field = (name, label, input, required, extra = {}) =>
    `<div class="field${extra.half ? ' half' : ''}"><label for="f-${esc(name)}">${esc(label)}${req(required)}</label>${extra.help ? `<div class="f-help">${esc(extra.help)}</div>` : ''}${input}</div>`;
  const groupHead = (q) => `<span class="label">${esc(q.label)}${req(q.required)}</span>${q.help ? `<div class="f-help">${esc(q.help)}</div>` : ''}`;
  // With labels hidden, the placeholder carries the question.
  const ph = (q) => esc(q.placeholder || (S.show_labels === false ? q.label + (q.required ? ' *' : '') : ''));

  // ----- choices -----
  function optionDisplay(q) {
    if (q.type === 'select') return 'dropdown';
    return q.display || S.option_style || 'cards';
  }
  function renderChoices(q) {
    const multi = q.type === 'multi';
    const vals = [].concat(st.answers[q.id] || []);
    const disp = optionDisplay(q);
    if (disp === 'dropdown' && !multi) return renderSelect(q);
    const imgs = q.option_images || {}, notes = q.option_notes || {};
    const opts = (q.options || []).map((o) => {
      const on = vals.includes(o);
      const input = `<input type="${multi ? 'checkbox' : 'radio'}" name="${esc(q.id)}" value="${esc(o)}" ${on ? 'checked' : ''} data-q="${esc(q.id)}" data-multi="${multi ? 1 : 0}">`;
      const note = notes[o] ? `<span class="opt-note">${esc(notes[o])}</span>` : '';
      if (disp === 'images') {
        const pic = imgs[o] ? `<span class="opt-img"><img src="${esc(imgs[o])}" alt="" loading="lazy"></span>` : `<span class="opt-img blank"><span>${esc(o.trim().charAt(0).toUpperCase())}</span></span>`;
        return `<label class="opt photo ${on ? 'is-on' : ''}">${input}${pic}<span class="opt-text"><span class="opt-label">${esc(o)}</span>${note}</span><span class="tick${multi ? '' : ' round'}"></span></label>`;
      }
      if (disp === 'pills') return `<label class="opt pill ${on ? 'is-on' : ''}">${input}<span>${esc(o)}</span></label>`;
      return `<label class="opt ${multi ? '' : 'radio'} ${on ? 'is-on' : ''}">${input}<span class="tick"></span><span class="opt-text"><span class="opt-label">${esc(o)}</span>${note}</span></label>`;
    }).join('');
    const cls = disp === 'images' ? 'images' : disp === 'pills' ? 'pills' : disp === 'list' ? 'list' : 'cards';
    return `<div class="field${q.width === 'half' ? ' half' : ''}" role="group" aria-label="${esc(q.label)}" data-group="${esc(q.id)}">${groupHead(q)}<div class="options ${cls}">${opts}</div></div>`;
  }
  function renderSelect(q) {
    const v = st.answers[q.id];
    return field(q.id, q.label, `<select class="select" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}"><option value="">${ph(q) || 'Select…'}</option>${(q.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`, q.required, { help: q.help, half: q.width === 'half' });
  }

  // ----- dates: an inline calendar, three number boxes, or the phone's own picker -----
  const dateDisplay = (q) => q.date_display || S.date_display || 'picker';
  const pad = (n) => String(n).padStart(2, '0');
  const validYmd = (y, m, d) => (y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate());

  function dateCal(q) {
    const today = BL.todayIn(st.tz);
    const v = st.answers[q.id] || '';
    const month = st.calMonth[q.id] || (v || today).slice(0, 7);
    const [y, mo] = month.split('-').map(Number);
    const first = new Date(Date.UTC(y, mo - 1, 1));
    const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const title = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first);
    let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('');
    for (let i = 0; i < first.getUTCDay(); i++) cells += '<div></div>';
    for (let d = 1; d <= count; d++) {
      const ds = `${month}-${pad(d)}`;
      const off = !q.allow_past && ds < today;
      cells += `<button type="button" class="cal-day${off ? '' : ' avail'}${ds === v ? ' sel' : ''}${ds === today ? ' today' : ''}" data-pick-date="${esc(q.id)}" data-date="${ds}" ${off ? 'disabled' : ''} aria-label="${esc(BL.fmtDateStr(ds))}">${d}</button>`;
    }
    const prevOff = !q.allow_past && month <= today.slice(0, 7);
    return `<div class="datecal" data-cal="${esc(q.id)}">
      <div class="cal-head"><strong>${esc(title)}</strong><div class="cal-nav">
        <button type="button" class="icon-btn" data-cal-nav="-1" data-cal-q="${esc(q.id)}" aria-label="Previous month" ${prevOff ? 'disabled' : ''}>${icons.left}</button>
        <button type="button" class="icon-btn" data-cal-nav="1" data-cal-q="${esc(q.id)}" aria-label="Next month">${icons.right}</button></div></div>
      <div class="cal-grid">${cells}</div>
      ${v ? `<div class="datecal-picked">${esc(BL.fmtDate(v + 'T12:00:00Z', 'UTC', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</div>` : ''}
    </div>`;
  }

  function dateTyped(q) {
    const v = st.answers[q.id] || '';
    const t = st.typed[q.id] || (v ? { y: v.slice(0, 4), m: v.slice(5, 7), d: v.slice(8, 10) } : { m: '', d: '', y: '' });
    const box = (part, val, cls, phd, max, label) => `<input class="input dpart ${cls}" inputmode="numeric" autocomplete="off" maxlength="${max}" data-dpart="${part}" data-dq="${esc(q.id)}" value="${esc(val || '')}" placeholder="${phd}" aria-label="${label}"${part === 'm' ? ` id="f-${esc(q.id)}"` : ''}>`;
    return `<div class="datetyped" data-typed="${esc(q.id)}">${box('m', t.m, 'dp-2', 'MM', 2, 'Month')}<span class="sep">/</span>${box('d', t.d, 'dp-2', 'DD', 2, 'Day')}<span class="sep">/</span>${box('y', t.y, 'dp-4', 'YYYY', 4, 'Year')}</div>`;
  }

  function renderDate(q) {
    const disp = dateDisplay(q);
    const half = q.width === 'half';
    if (disp === 'calendar') return `<div class="field${half ? ' half' : ''}" data-group="${esc(q.id)}">${groupHead(q)}${dateCal(q)}</div>`;
    if (disp === 'typed') return field(q.id, q.label, dateTyped(q), q.required, { help: q.help, half });
    const min = q.allow_past ? '' : ` min="${BL.todayIn(st.tz)}"`;
    return field(q.id, q.label, `<input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="date"${min} value="${esc(st.answers[q.id] || '')}" data-q="${esc(q.id)}">`, q.required, { help: q.help, half });
  }

  // ----- numbers: a box, a - n + stepper, or a slider -----
  const has = (x) => x !== null && x !== undefined && x !== '';
  function renderNumber(q) {
    const v = st.answers[q.id];
    const half = q.width === 'half';
    const attrs = `${has(q.min) ? ` min="${q.min}"` : ''}${has(q.max) ? ` max="${q.max}"` : ''}`;
    const suffix = q.suffix ? `<span class="num-suffix">${esc(q.suffix)}</span>` : '';
    const opts = { help: q.help, half };
    if (q.number_display === 'slider') {
      const lo = has(q.min) ? q.min : 0, hi = has(q.max) ? q.max : 500;
      const val = has(v) ? v : lo;
      return field(q.id, q.label, `<div class="num-slider"><input type="range" id="f-${esc(q.id)}" name="${esc(q.id)}" min="${lo}" max="${hi}" value="${esc(String(val))}" data-q="${esc(q.id)}"><output data-out="${esc(q.id)}">${has(v) ? esc(String(v)) + (q.suffix ? ' ' + esc(q.suffix) : '') : 'Choose'}</output></div>`, q.required, opts);
    }
    if (q.number_display === 'stepper') {
      return field(q.id, q.label, `<div class="num-stepper"><button type="button" class="icon-btn" data-step-num="-1" data-nq="${esc(q.id)}" aria-label="Less">−</button><input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="number" inputmode="numeric"${attrs} value="${esc(v ?? '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}"><button type="button" class="icon-btn" data-step-num="1" data-nq="${esc(q.id)}" aria-label="More">+</button>${suffix}</div>`, q.required, opts);
    }
    return field(q.id, q.label, `<div class="num-wrap"><input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="number" inputmode="numeric"${attrs} value="${esc(v ?? '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}">${suffix}</div>`, q.required, opts);
  }

  function renderQuestion(q) {
    const v = st.answers[q.id];
    if (q.type === 'choice' || q.type === 'multi') return renderChoices(q);
    if (q.type === 'select') return renderSelect(q);
    if (q.type === 'date') return renderDate(q);
    if (q.type === 'number') return renderNumber(q);
    const opts = { help: q.help, half: q.width === 'half' };
    if (q.type === 'textarea') return field(q.id, q.label, `<textarea class="textarea" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}" placeholder="${ph(q)}">${esc(v || '')}</textarea>`, q.required, opts);
    return field(q.id, q.label, `<input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="text" value="${esc(v || '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}">`, q.required, opts);
  }

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
        const t = st.typed[q.id];
        if (q.type === 'date' && t && (t.m || t.d || t.y) && !v) { errs[q.id] = 'Enter a full date, like 06 / 14 / 2027'; continue; }
        if (q.type === 'date' && v && !q.allow_past && v < BL.todayIn(st.tz)) { errs[q.id] = 'Pick a date that has not passed'; continue; }
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
    const cn = e.target.closest('[data-cal-nav]');
    if (cn && !cn.disabled) {
      const qid = cn.dataset.calQ;
      const q = (cur().questions || []).find((x) => x.id === qid);
      const base = st.calMonth[qid] || (st.answers[qid] || BL.todayIn(st.tz)).slice(0, 7);
      const [y, m] = base.split('-').map(Number);
      st.calMonth[qid] = new Date(Date.UTC(y, m - 1 + Number(cn.dataset.calNav), 1)).toISOString().slice(0, 7);
      const box = $(`[data-cal="${CSS.escape(qid)}"]`, app);
      if (box && q) box.outerHTML = dateCal(q);
      return;
    }
    const pd = e.target.closest('[data-pick-date]');
    if (pd && !pd.disabled) {
      const qid = pd.dataset.pickDate;
      const q = (cur().questions || []).find((x) => x.id === qid);
      st.answers[qid] = pd.dataset.date;
      st.calMonth[qid] = pd.dataset.date.slice(0, 7);
      const box = $(`[data-cal="${CSS.escape(qid)}"]`, app);
      clearErr(box);
      if (box && q) box.outerHTML = dateCal(q);
      capture({ answers: { [qid]: st.answers[qid] } }, true);
      refreshNav();
      return maybeAdvance();
    }
    const sn = e.target.closest('[data-step-num]');
    if (sn) {
      const qid = sn.dataset.nq;
      const q = (cur().questions || []).find((x) => x.id === qid) || {};
      let n = (Number(st.answers[qid]) || 0) + Number(sn.dataset.stepNum);
      if (has(q.min)) n = Math.max(q.min, n);
      if (has(q.max)) n = Math.min(q.max, n);
      st.answers[qid] = n;
      const inp = $(`#f-${CSS.escape(qid)}`, app); if (inp) inp.value = n;
      clearErr(inp);
      capture({ answers: { [qid]: n } }, false);
    }
  });
  app.addEventListener('submit', (e) => { e.preventDefault(); go(1); });

  function onTyped(t, isChange) {
    const qid = t.dataset.dq;
    const wrap = t.closest('[data-typed]');
    const part = (p) => ($(`[data-dpart="${p}"]`, wrap) || {}).value || '';
    const clean = t.value.replace(/\D/g, '');
    if (clean !== t.value) t.value = clean;
    const parts = { m: part('m'), d: part('d'), y: part('y') };
    st.typed[qid] = parts;
    // Move along once a box is full, the way people type a date.
    if (!isChange) {
      const p = t.dataset.dpart, v = t.value;
      const full = p === 'y' ? false : (v.length >= 2 || (p === 'm' && Number(v) > 1) || (p === 'd' && Number(v) > 3));
      if (full) { const nx = $(`[data-dpart="${p === 'm' ? 'd' : 'y'}"]`, wrap); if (nx) { nx.focus(); nx.select(); } }
    }
    const y = Number(parts.y), m = Number(parts.m), d = Number(parts.d);
    const prev = st.answers[qid];
    st.answers[qid] = parts.y.length === 4 && validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : '';
    clearErr(wrap);
    if (st.answers[qid] !== prev) capture({ answers: { [qid]: st.answers[qid] } }, true);
  }

  function onInput(e) {
    const t = e.target;
    if (t.hasAttribute('data-dpart')) return onTyped(t, e.type === 'change');
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
  app.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Backspace' && t.hasAttribute && t.hasAttribute('data-dpart') && !t.value) {
      const prevBox = t.dataset.dpart === 'y' ? 'd' : t.dataset.dpart === 'd' ? 'm' : null;
      if (prevBox) { e.preventDefault(); $(`[data-dpart="${prevBox}"]`, t.closest('[data-typed]')).focus(); }
    }
  });

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
