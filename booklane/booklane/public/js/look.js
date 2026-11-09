/* The look of a guest page, shared by custom forms and booking pages.

   A look (see src/services/form-style.js) is a layout plus any number of overrides: colours, fonts,
   what shows, progress, buttons, how choices and dates are drawn, the calendar style. This file
   turns one into the page: CSS variables and body classes, the header, the progress marker, and
   the question fields. Looks never change what is asked, saved or booked. */
(function () {
  'use strict';
  const { esc, icons } = BL;

  // ---------- colours, fonts, classes ----------
  const FONT_KIND = { 'Playfair Display': 'serif', 'Cormorant Garamond': 'serif', Lora: 'serif', 'Libre Baskerville': 'serif', 'EB Garamond': 'serif', 'Great Vibes': 'script', Parisienne: 'script' };
  const fontStack = (f) => {
    if (!f || f === 'System') return 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    const kind = FONT_KIND[f];
    return `"${f}", ${kind === 'serif' ? 'Georgia, "Times New Roman", serif' : kind === 'script' ? 'cursive' : 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'}`;
  };
  // The server adds the font link for a saved look; a preview can switch fonts, so load on demand.
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

  function apply(S, biz) {
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

  // ---------- page pieces ----------
  const logoUrl = (S, biz) => S.logo_url || biz.logo_url || '';
  const logoHtml = (S, biz) => (logoUrl(S, biz) ? `<div class="biz-logo"><img src="${esc(logoUrl(S, biz))}" alt="${esc(biz.name)}"></div>` : BL.logo(biz));
  const banner = (S) => (S.header_image ? `<div class="f-banner" style="background-image:url('${esc(S.header_image)}')"></div>` : '');
  /** Two columns (side panel) or one, as the look says. */
  const sideLayout = (S) => (S.layout || 'full') === 'full' && S.show_sidebar !== false;

  /** The top of a single-column page: banner, logo, name, title, description, as switched on. */
  function header(S, biz, o) {
    const b = banner(S);
    const showLogo = S.show_logo !== false, showName = S.show_name !== false;
    const trust = biz.settings.trust_points || [];
    const bits = [
      showLogo || showName ? `<div class="f-brand">${showLogo ? logoHtml(S, biz) : ''}${showName ? `<div class="biz-name">${esc(biz.name)}</div>` : ''}</div>` : '',
      S.show_title !== false && o.title ? `<h1 class="f-title">${esc(o.title)}</h1>` : '',
      S.show_description !== false && o.description ? `<p class="f-desc">${esc(o.description)}</p>` : '',
      o.extra || '',
      S.show_trust !== false && S.layout === 'visual' && trust.length ? `<ul class="f-trust">${trust.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '',
    ].join('');
    return `${b}${bits ? `<header class="f-head${b ? ' over-banner' : ''}">${bits}</header>` : ''}`;
  }

  /** Where they are: a bar, named steps, dots or "Step 2 of 4". `titles` are the steps on show. */
  function progress(S, titles, i) {
    const n = titles.length, at = i + 1;
    if (n < 2 || S.progress === 'none') return '';
    const label = `Step ${at} of ${n}`;
    if (S.progress === 'count') return `<div class="f-progress count" aria-label="${label}">${label}</div>`;
    if (S.progress === 'dots') return `<div class="f-progress dots" role="img" aria-label="${label}">${titles.map((_, k) => `<span class="${k < i ? 'past' : k === i ? 'on' : ''}"></span>`).join('')}</div>`;
    if (S.progress === 'steps') {
      return `<ol class="f-progress named" aria-label="${label}">${titles.map((t, k) => `<li class="${k < i ? 'past' : k === i ? 'on' : ''}"><span class="n">${k < i ? '✓' : k + 1}</span><span class="t">${esc(t || `Step ${k + 1}`)}</span></li>`).join('')}</ol>`;
    }
    return `<div class="progress" aria-label="${label}"><div class="progress-bar"><span style="width:${Math.round((at / n) * 100)}%"></span></div>${S.progress_count === false ? '' : `<div class="progress-count">${at} / ${n}</div>`}</div>`;
  }

  // ---------- questions ----------
  /**
   * Draws questions the way the look says and handles the parts that need more than a plain input
   * (the inline date calendar, typed dates, the number stepper).
   *
   * st holds answers, typed, calMonth and tz. The page keeps handling ordinary inputs ([data-q]);
   * onAnswer(qid, value, { kind, el, changed }) tells it about the rest, so it can save and move on.
   */
  function kit({ S, st, root, questions, optionsFor, displayOf, onAnswer }) {
    const has = (x) => x !== null && x !== undefined && x !== '';
    const req = (r) => (r ? ' <span class="req">*</span>' : '');
    const field = (name, label, input, required, extra = {}) =>
      `<div class="field${extra.half ? ' half' : ''}"><label for="f-${esc(name)}">${esc(label)}${req(required)}</label>${extra.help ? `<div class="f-help">${esc(extra.help)}</div>` : ''}${input}</div>`;
    const groupHead = (q) => `<span class="label">${esc(q.label)}${req(q.required)}</span>${q.help ? `<div class="f-help">${esc(q.help)}</div>` : ''}`;
    // With labels hidden, the placeholder carries the question.
    const ph = (q) => esc(q.placeholder || (S.show_labels === false ? q.label + (q.required ? ' *' : '') : ''));
    const opts = (q) => (optionsFor ? optionsFor(q) : q.options || []);
    const find = (qid) => (questions() || []).find((x) => x.id === qid);

    function optionDisplay(q) {
      if (q.type === 'select') return 'dropdown';
      return (displayOf ? displayOf(q) : q.display) || S.option_style || 'cards';
    }
    function renderChoices(q) {
      const multi = q.type === 'multi';
      const vals = [].concat(st.answers[q.id] ?? []);
      const disp = optionDisplay(q);
      if (disp === 'dropdown' && !multi) return renderSelect(q);
      const imgs = q.option_images || {}, notes = q.option_notes || {};
      const list = opts(q).map((o) => {
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
      return `<div class="field${q.width === 'half' ? ' half' : ''}" role="group" aria-label="${esc(q.label)}" data-group="${esc(q.id)}">${groupHead(q)}<div class="options ${cls}">${list}</div></div>`;
    }
    function renderSelect(q) {
      const v = st.answers[q.id];
      return field(q.id, q.label, `<select class="select" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}"><option value="">${ph(q) || 'Select…'}</option>${opts(q).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`, q.required, { help: q.help, half: q.width === 'half' });
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
    function renderNumber(q) {
      const v = st.answers[q.id];
      const half = q.width === 'half';
      const attrs = `${has(q.min) ? ` min="${q.min}"` : ''}${has(q.max) ? ` max="${q.max}"` : ''}`;
      const suffix = q.suffix ? `<span class="num-suffix">${esc(q.suffix)}</span>` : '';
      const o = { help: q.help, half };
      if (q.number_display === 'slider') {
        const lo = has(q.min) ? q.min : 0, hi = has(q.max) ? q.max : 500;
        const val = has(v) ? v : lo;
        return field(q.id, q.label, `<div class="num-slider"><input type="range" id="f-${esc(q.id)}" name="${esc(q.id)}" min="${lo}" max="${hi}" value="${esc(String(val))}" data-q="${esc(q.id)}"><output data-out="${esc(q.id)}">${has(v) ? esc(String(v)) + (q.suffix ? ' ' + esc(q.suffix) : '') : 'Choose'}</output></div>`, q.required, o);
      }
      if (q.number_display === 'stepper') {
        return field(q.id, q.label, `<div class="num-stepper"><button type="button" class="icon-btn" data-step-num="-1" data-nq="${esc(q.id)}" aria-label="Less">−</button><input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="number" inputmode="numeric"${attrs} value="${esc(v ?? '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}"><button type="button" class="icon-btn" data-step-num="1" data-nq="${esc(q.id)}" aria-label="More">+</button>${suffix}</div>`, q.required, o);
      }
      return field(q.id, q.label, `<div class="num-wrap"><input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="number" inputmode="numeric"${attrs} value="${esc(v ?? '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}">${suffix}</div>`, q.required, o);
    }

    function renderQuestion(q) {
      const v = st.answers[q.id];
      if (q.type === 'choice' || q.type === 'multi') return renderChoices(q);
      if (q.type === 'select') return renderSelect(q);
      if (q.type === 'date') return renderDate(q);
      if (q.type === 'number') return renderNumber(q);
      const o = { help: q.help, half: q.width === 'half' };
      if (q.type === 'textarea') return field(q.id, q.label, `<textarea class="textarea" id="f-${esc(q.id)}" name="${esc(q.id)}" data-q="${esc(q.id)}" placeholder="${ph(q)}">${esc(v || '')}</textarea>`, q.required, o);
      return field(q.id, q.label, `<input class="input" id="f-${esc(q.id)}" name="${esc(q.id)}" type="text" value="${esc(v || '')}" data-q="${esc(q.id)}" placeholder="${ph(q)}">`, q.required, o);
    }

    // ----- the controls a plain input listener cannot handle -----
    /** True when the click was one of ours. */
    function click(e) {
      const cn = e.target.closest('[data-cal-nav]');
      if (cn) {
        if (cn.disabled) return true;
        const qid = cn.dataset.calQ;
        const q = find(qid);
        const base = st.calMonth[qid] || (st.answers[qid] || BL.todayIn(st.tz)).slice(0, 7);
        const [y, m] = base.split('-').map(Number);
        st.calMonth[qid] = new Date(Date.UTC(y, m - 1 + Number(cn.dataset.calNav), 1)).toISOString().slice(0, 7);
        const box = root.querySelector(`[data-cal="${CSS.escape(qid)}"]`);
        if (box && q) box.outerHTML = dateCal(q);
        return true;
      }
      const pd = e.target.closest('[data-pick-date]');
      if (pd) {
        if (pd.disabled) return true;
        const qid = pd.dataset.pickDate;
        const q = find(qid);
        st.answers[qid] = pd.dataset.date;
        st.calMonth[qid] = pd.dataset.date.slice(0, 7);
        let box = root.querySelector(`[data-cal="${CSS.escape(qid)}"]`);
        if (box && q) { box.outerHTML = dateCal(q); box = root.querySelector(`[data-cal="${CSS.escape(qid)}"]`); }
        onAnswer(qid, st.answers[qid], { kind: 'pick', el: box, changed: true });
        return true;
      }
      const sn = e.target.closest('[data-step-num]');
      if (sn) {
        const qid = sn.dataset.nq;
        const q = find(qid) || {};
        let n = (Number(st.answers[qid]) || 0) + Number(sn.dataset.stepNum);
        if (has(q.min)) n = Math.max(q.min, n);
        if (has(q.max)) n = Math.min(q.max, n);
        st.answers[qid] = n;
        const inp = root.querySelector(`#f-${CSS.escape(qid)}`); if (inp) inp.value = n;
        onAnswer(qid, n, { kind: 'step', el: inp, changed: true });
        return true;
      }
      return false;
    }

    /** A key in one of the three typed-date boxes. True when it was one. */
    function typed(t, isChange) {
      if (!t.hasAttribute || !t.hasAttribute('data-dpart')) return false;
      const qid = t.dataset.dq;
      const wrap = t.closest('[data-typed]');
      const part = (p) => (wrap.querySelector(`[data-dpart="${p}"]`) || {}).value || '';
      const clean = t.value.replace(/\D/g, '');
      if (clean !== t.value) t.value = clean;
      const parts = { m: part('m'), d: part('d'), y: part('y') };
      st.typed[qid] = parts;
      // Move along once a box is full, the way people type a date.
      if (!isChange) {
        const p = t.dataset.dpart, v = t.value;
        const full = p === 'y' ? false : (v.length >= 2 || (p === 'm' && Number(v) > 1) || (p === 'd' && Number(v) > 3));
        if (full) { const nx = wrap.querySelector(`[data-dpart="${p === 'm' ? 'd' : 'y'}"]`); if (nx) { nx.focus(); nx.select(); } }
      }
      const y = Number(parts.y), m = Number(parts.m), d = Number(parts.d);
      const prev = st.answers[qid];
      st.answers[qid] = parts.y.length === 4 && validYmd(y, m, d) ? `${y}-${pad(m)}-${pad(d)}` : '';
      onAnswer(qid, st.answers[qid], { kind: 'typed', el: wrap, changed: st.answers[qid] !== prev });
      return true;
    }

    /** Backspace in an empty date box steps back to the one before it. */
    function keydown(e) {
      const t = e.target;
      if (e.key === 'Backspace' && t.hasAttribute && t.hasAttribute('data-dpart') && !t.value) {
        const prevBox = t.dataset.dpart === 'y' ? 'd' : t.dataset.dpart === 'd' ? 'm' : null;
        if (prevBox) { e.preventDefault(); t.closest('[data-typed]').querySelector(`[data-dpart="${prevBox}"]`).focus(); }
        return true;
      }
      return false;
    }

    /** A typed date half filled in is a mistake worth saying, not an empty answer. */
    function dateProblem(q) {
      const v = st.answers[q.id], t = st.typed[q.id];
      if (q.type !== 'date') return null;
      if (t && (t.m || t.d || t.y) && !v) return 'Enter a full date, like 06 / 14 / 2027';
      if (v && !q.allow_past && v < BL.todayIn(st.tz)) return 'Pick a date that has not passed';
      return null;
    }

    return { field, ph, has, optionDisplay, dateDisplay, renderQuestion, click, typed, keydown, dateProblem };
  }

  BL.Look = { apply, fontStack, logoHtml, banner, header, progress, sideLayout, kit };
})();
