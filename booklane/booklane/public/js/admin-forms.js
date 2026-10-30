/* Admin: build a form out of ordered steps, then make it look however you like.
   Short ones for a button on the website, long ones for someone who means it.

   The builder has three tabs (Steps, Look, Settings) and a live preview beside them. The preview
   is the real public form script running at /app/form-preview, fed the unsaved form over
   postMessage, so what you see is exactly what visitors will get. */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const STEP_LABEL = {
    questions: 'Questions', contact: 'Contact details', message: 'A note',
    availability: 'Date check', schedule: 'Calendar',
  };
  const STEP_HINT = {
    questions: 'Any fields you like',
    contact: 'Name, email, phone',
    message: 'Just words. Useful for setting expectations.',
    availability: 'Checks a date they gave against your calendar',
    schedule: 'Pick a time on one of your booking pages',
  };
  const Q_LABEL = { text: 'Short text', textarea: 'Long text', number: 'Number', date: 'Date', select: 'Dropdown', choice: 'Pick one', multi: 'Pick several' };
  const CHOICE_TYPES = ['choice', 'multi', 'select'];
  const LAYOUT_NAME = { full: 'Full', minimal: 'Minimal', thin: 'Thin', visual: 'Images and colors' };
  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div><div class="s">${s}</div></div>`;

  function shapeWords(sh) {
    if (sh.lead_only) return 'Captures a lead';
    return sh.schedules ? 'Books a time' : 'Captures a lead';
  }

  A.route('/forms', {
    title: 'Forms',
    async render() {
      const data = await api('GET', '/forms');
      A.cache.forms = data;
      const total = data.forms.reduce((n, f) => n + f.leads, 0);

      if (!data.forms.length) {
        return `<div class="panel"><div class="empty-state">
          <h3>No forms yet</h3>
          <p>A form is any flow you want: two questions behind a button on the website, or a long one that checks a date and books a call. Start from a shape below, or build one from scratch.</p>
          <div class="row" style="justify-content:center;flex-wrap:wrap;gap:8px;margin-top:6px">
            ${data.templates.map((t) => `<button type="button" class="btn btn-ghost btn-sm" data-tpl="${esc(t.id)}" title="${esc(t.description)}">${esc(t.name)}</button>`).join('')}
            <button type="button" class="btn btn-primary btn-sm" data-new>Blank form</button>
          </div>
        </div></div>`;
      }

      return `<div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Forms</h1><div class="small muted" style="margin-top:2px">Custom flows. Your booking pages and sessions stay where they are.</div></div>
        <div class="row"><button type="button" class="btn btn-ghost" data-tpl-menu>Start from a shape</button><button type="button" class="btn btn-primary" data-new>New form</button></div>
      </div>

      <div class="stats">
        ${stat('Forms', data.forms.filter((f) => f.active).length, `of ${data.forms.length} · ${data.forms.filter((f) => !f.active).length} off`)}
        ${stat('Submissions', total, total ? '<a href="#/leads">see the leads</a>' : 'none yet')}
        ${stat('Booking a time', data.forms.filter((f) => f.shape.schedules).length, 'of your forms')}
      </div>

      <div class="panel">
        <table class="table"><thead><tr><th>FORM</th><th>LOOK</th><th>DOES</th><th>STEPS</th><th>SUBMISSIONS</th><th></th></tr></thead>
        <tbody>${data.forms.map((f) => `<tr${f.active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(f.name)}</b>${f.active ? '' : ' <span class="pill lost">Off</span>'}
            <div class="small muted"><a href="${esc(f.url)}" target="_blank">${esc(f.url.replace(/^https?:\/\/[^/]+/, ''))}</a></div></td>
          <td class="small">${esc(LAYOUT_NAME[(f.style || {}).layout] || 'Full')}</td>
          <td class="small">${esc(shapeWords(f.shape))}</td>
          <td class="small">${f.steps.map((s) => esc(STEP_LABEL[s.type] || s.type)).join(' → ') || '<span class="muted">empty</span>'}</td>
          <td>${f.leads || ''}</td>
          <td class="row" style="gap:6px;flex-wrap:nowrap">
            <button type="button" class="btn btn-link btn-sm" data-embed="${f.id}">Embed</button>
            <a class="btn btn-link btn-sm" href="${esc(f.url)}" target="_blank">View</a>
            <button type="button" class="btn btn-link btn-sm" data-clone="${f.id}">Clone</button>
            <button type="button" class="btn btn-link btn-sm" data-edit="${f.id}">Edit</button>
          </td>
        </tr>`).join('')}</tbody></table>
      </div>`;
    },
    // The admin core calls mount(); this was named events() and never ran, so no button on this
    // screen did anything.
    mount(root) {
      const data = A.cache.forms;
      root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-new]')) return editForm(null, data);
        const ed = e.target.closest('[data-edit]');
        if (ed) return editForm(data.forms.find((f) => f.id === Number(ed.dataset.edit)), data);
        const em = e.target.closest('[data-embed]');
        if (em) return showEmbed(data.forms.find((f) => f.id === Number(em.dataset.embed)));
        const cl = e.target.closest('[data-clone]');
        if (cl) {
          try {
            const f = await A.guard(() => api('POST', `/forms/${cl.dataset.clone}/clone`, {}), 'Copied. The copy is switched off until you turn it on.');
            await A.render();
            const fresh = A.cache.forms;
            return editForm(fresh.forms.find((x) => x.id === f.id), fresh);
          } catch (err) { return; }
        }
        const tpl = e.target.closest('[data-tpl]');
        if (tpl) return fromTemplate(tpl.dataset.tpl);
        if (e.target.closest('[data-tpl-menu]')) return templateMenu(data);
      });
    },
  });

  async function fromTemplate(id) {
    try {
      const r = await A.guard(() => api('POST', '/forms/from-template', { template: id }), 'Form created');
      (r.warnings || []).forEach((w) => A.toast(w, true));
      A.closeDrawer(); A.render();
    } catch (e) { /* toast shown */ }
  }

  function templateMenu(data) {
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Start from</div><h2>A ready-made shape</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <p class="help">Each one is a starting point wired to your own booking pages. Everything is editable afterwards.</p>
      <div class="stack">${data.templates.map((t) => `<button type="button" class="opt" style="text-align:left;width:100%" data-tpl="${esc(t.id)}">
        <span class="opt-stack"><span>${esc(t.name)}</span><span class="opt-hint">${esc(t.description)}</span></span></button>`).join('')}</div>`,
    // The drawer sits outside the screen, so its buttons need their own handler.
    (el) => el.addEventListener('click', (e) => { const t = e.target.closest('[data-tpl]'); if (t) fromTemplate(t.dataset.tpl); }));
  }

  function showEmbed(f) {
    const origin = f.url.replace(/^(https?:\/\/[^/]+).*$/, '$1');
    const path = f.url.slice(origin.length).replace(/^\//, '');
    const layout = (f.style || {}).layout || 'full';
    const h = { full: 760, minimal: 680, thin: 260, visual: 900 }[layout] || 760;
    const script = `<div data-booklane="${path}"></div>\n<script src="${origin}/embed.js" async></script>`;
    const iframe = `<iframe src="${f.url}?embed=1" style="width:100%;height:${h}px;border:0" loading="lazy" title="${f.name}"></iframe>`;
    const button = `<a href="${f.url}" class="wu-cta">${f.name}</a>`;
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Embed</div><h2>${esc(f.name)}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <div class="panel stack">
        ${A.field('Link', `<input class="input" readonly value="${esc(f.url)}">`, 'For a button, an email, or a QR code.')}
        ${A.field('On the page (recommended)', `<textarea class="textarea" rows="3" readonly>${esc(script)}</textarea>`, 'Grows and shrinks to fit the form, so a Thin form takes only the room it needs.')}
        ${A.field('Plain iframe', `<textarea class="textarea" rows="3" readonly>${esc(iframe)}</textarea>`, `A fixed height, set for the ${esc(LAYOUT_NAME[layout] || 'Full')} look. Use this where scripts are not allowed.`)}
        ${A.field('As a link', `<textarea class="textarea" rows="2" readonly>${esc(button)}</textarea>`, 'Style <code>.wu-cta</code> however you like on the site.')}
        <div class="row"><button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(f.url)}">Copy the link</button>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(script)}">Copy the embed</button></div>
      </div>`);
  }

  // ---------------- small pieces for the Look tab ----------------
  const sel = (key, val, options) => `<select class="select" data-st="${key}">${Object.entries(options).map(([v, l]) => `<option value="${esc(v)}" ${String(val) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const tog = (key, on, label) => `<label class="toggle"><input type="checkbox" data-st="${key}" ${on ? 'checked' : ''}><span class="sw"></span><span>${esc(label)}</span></label>`;
  const num = (key, val, attrs) => `<input class="input" type="number" data-st="${key}" value="${esc(val)}" ${attrs || ''}>`;
  const txt = (key, val, attrs) => `<input class="input" data-st="${key}" value="${esc(val ?? '')}" ${attrs || ''}>`;
  const color = (key, val, placeholder) => `<div class="color-pick"><input type="color" data-st-color="${key}" value="${esc(val || placeholder || '#6d4aff')}" aria-label="Pick a colour"><input class="input" data-st="${key}" value="${esc(val || '')}" placeholder="Default" maxlength="7"><button type="button" class="btn btn-link btn-sm" data-clear-st="${key}" title="Use the default">Reset</button></div>`;
  // An image: a thumbnail, an Upload button, and the address, which can also be pasted.
  const imagePick = (attr, val, hint) => `<div class="img-pick">
      <div class="img-thumb ${val ? '' : 'empty'}" ${val ? `style="background-image:url('${esc(val)}')"` : ''}></div>
      <div class="img-pick-main">
        <div class="row" style="gap:6px;flex-wrap:nowrap"><input class="input" ${attr} value="${esc(val || '')}" placeholder="Upload, or paste an https:// address">
          <button type="button" class="btn btn-ghost btn-sm" data-upload>Upload</button>${val ? '<button type="button" class="btn btn-link btn-sm" data-clear-img>Remove</button>' : ''}</div>
        ${hint ? `<div class="help">${hint}</div>` : ''}
      </div></div>`;
  const section = (title, body, open) => `<details class="look-sec" ${open ? 'open' : ''} data-sec="${esc(title)}"><summary>${esc(title)}</summary><div class="look-body">${body}</div></details>`;

  // Tiny drawings of each layout, so the choice is visual rather than a word.
  const THUMB = {
    full: '<div class="lt lt-full"><i class="side"></i><i class="main"><b></b><b></b><b class="btn"></b></i></div>',
    minimal: '<div class="lt lt-min"><i class="main"><b class="t"></b><b></b><b></b><b class="btn wide"></b></i></div>',
    thin: '<div class="lt lt-thin"><i class="main"><b></b><b></b><b class="btn"></b></i></div>',
    visual: '<div class="lt lt-vis"><i class="main"><b class="ban"></b><b class="logo"></b><span class="pics"><b></b><b></b><b></b></span><b class="btn pill"></b></i></div>',
  };

  // ---------------- the builder ----------------
  function editForm(x, data) {
    const steps = JSON.parse(JSON.stringify(x ? x.steps : []));
    const layouts = (data.styles && data.styles.layouts) || [];
    const defaultsFor = (id) => Object.assign({}, (layouts.find((l) => l.id === id) || layouts[0] || {}).defaults || {});
    let style = Object.assign(defaultsFor('full'), x ? x.style : {});
    const fonts = (data.styles && data.styles.fonts) || ['Plus Jakarta Sans'];
    const etOptions = Object.fromEntries([['', 'Choose a booking page…']].concat(data.event_types.map((e) => [e.id, e.name])));
    const openQs = new Set();     // which questions have "More options" open, kept across repaints
    let tab = 'steps';
    let focusStep = 0;

    // ----- Steps tab -----
    const optionsBlock = (si, qi, q) => {
      if (!CHOICE_TYPES.includes(q.type)) return '';
      const imgs = q.option_images || {}, notes = q.option_notes || {};
      const rows = (q.options || []).map((o, oi) => `<div class="opt-row" data-opt-row="${si}.${qi}.${oi}">
          <div class="img-thumb sm ${imgs[o] ? '' : 'empty'}" ${imgs[o] ? `style="background-image:url('${esc(imgs[o])}')"` : ''}></div>
          <b class="opt-name">${esc(o)}</b>
          <input class="input input-sm" data-opt-note="${si}.${qi}.${oi}" value="${esc(notes[o] || '')}" placeholder="Small print under it (optional)">
          <input type="hidden" data-opt-img="${si}.${qi}.${oi}" value="${esc(imgs[o] || '')}">
          <button type="button" class="btn btn-ghost btn-sm" data-upload>${imgs[o] ? 'Change photo' : 'Add photo'}</button>
          ${imgs[o] ? `<button type="button" class="btn btn-link btn-sm" data-clear-img>Remove</button>` : ''}
        </div>`).join('');
      return `<div class="field"><label>Choices, one per line</label>
          <textarea class="textarea" rows="${Math.max(3, Math.min(10, (q.options || []).length + 1))}" data-q-opts="${si}.${qi}">${esc((q.options || []).join('\n'))}</textarea></div>
        ${(q.options || []).length && q.type !== 'select' ? `<div class="field"><label>Photos and notes for each choice</label><div class="help">Photos show when the choices are drawn as photo cards (set on the Look tab, or for this question below).</div><div class="opt-rows">${rows}</div></div>` : ''}`;
    };

    const moreOptions = (si, qi, q) => {
      const k = `${si}.${qi}`;
      const bits = [
        `<div class="grid-2">
          ${A.field('Placeholder', `<input class="input" data-q-ph="${k}" value="${esc(q.placeholder || '')}">`)}
          ${A.field('Width', `<select class="select" data-q-width="${k}"><option value="full" ${q.width !== 'half' ? 'selected' : ''}>Full row</option><option value="half" ${q.width === 'half' ? 'selected' : ''}>Half (sits beside the next half field)</option></select>`)}
        </div>`,
        A.field('Help text under the question', `<input class="input" data-q-help="${k}" value="${esc(q.help || '')}" placeholder="e.g. A rough guess is fine">`),
        `<div class="grid-2">${A.field('Answer id', `<input class="input" data-q-id="${k}" value="${esc(q.id || '')}" placeholder="made from the label">`, 'Used in exports, routing and the date check. Leave blank to make one from the label.')}</div>`,
      ];
      if (q.type === 'choice' || q.type === 'multi') {
        bits.push(A.field('Show the choices as', `<select class="select" data-q-display="${k}">
          ${[['', 'As the Look tab says'], ['cards', 'Cards'], ['list', 'A list'], ['pills', 'Pills'], ['images', 'Photo cards']].concat(q.type === 'choice' ? [['dropdown', 'A dropdown']] : []).map(([v, l]) => `<option value="${v}" ${(q.display || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`));
      }
      if (q.type === 'date') {
        bits.push(`<div class="grid-2">${A.field('Show the date as', `<select class="select" data-q-date="${k}">
          ${[['', 'As the Look tab says'], ['calendar', 'A calendar to click'], ['typed', 'Type the numbers (MM / DD / YYYY)'], ['picker', "The phone's date picker"]].map(([v, l]) => `<option value="${v}" ${(q.date_display || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
          <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" data-q-past="${k}" ${q.allow_past ? 'checked' : ''}><span>Allow dates in the past</span></label></div></div>`);
      }
      if (q.type === 'number') {
        bits.push(`<div class="grid-2">
          ${A.field('Show as', `<select class="select" data-q-numdisp="${k}">${[['input', 'A box to type in'], ['stepper', 'A box with − and + buttons'], ['slider', 'A slider']].map(([v, l]) => `<option value="${v}" ${(q.number_display || 'input') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
          ${A.field('Unit after it', `<input class="input" data-q-suffix="${k}" value="${esc(q.suffix || '')}" placeholder="e.g. guests">`)}
          ${A.field('Lowest', `<input class="input" type="number" data-q-min="${k}" value="${q.min ?? ''}">`)}
          ${A.field('Highest', `<input class="input" type="number" data-q-max="${k}" value="${q.max ?? ''}">`, q.number_display === 'slider' ? 'A slider needs both ends. Without them it runs 0 to 500.' : '')}
        </div>`);
      }
      return `<details class="q-more" data-q-more="${k}" ${openQs.has(k) ? 'open' : ''}><summary>More options</summary>${bits.join('')}</details>`;
    };

    const questionCard = (si, qi, q, count) => `<div class="q-card" data-q-card="${si}.${qi}">
      <div class="q-card-top">
        <input class="input" data-q-label="${si}.${qi}" value="${esc(q.label || '')}" placeholder="What is your wedding date?">
        <select class="select" data-q-type="${si}.${qi}">${Object.entries(Q_LABEL).map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <label class="check" title="Required"><input type="checkbox" data-q-req="${si}.${qi}" ${q.required ? 'checked' : ''}><span>Required</span></label>
        <div class="row" style="gap:0;flex-wrap:nowrap">
          <button type="button" class="btn btn-link btn-sm" data-q-up="${si}.${qi}" ${qi === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button type="button" class="btn btn-link btn-sm" data-q-down="${si}.${qi}" ${qi === count - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button type="button" class="btn btn-link btn-sm" data-rm-q="${si}.${qi}" aria-label="Remove">&times;</button>
        </div>
      </div>
      ${optionsBlock(si, qi, q)}
      ${moreOptions(si, qi, q)}
    </div>`;

    const stepBody = (s, i) => {
      if (s.type === 'questions') {
        return `<div class="field"><label>Fields</label>
          <div class="q-cards">${(s.questions || []).map((q, qi) => questionCard(i, qi, q, s.questions.length)).join('')}</div>
          <button type="button" class="btn btn-ghost btn-sm" data-add-q="${i}">Add a field</button></div>`;
      }
      if (s.type === 'contact') {
        const modes = { required: 'Required', optional: 'Optional', hidden: 'Do not ask' };
        return `<div class="grid-2">${['first_name', 'last_name', 'email', 'phone', 'sms_consent'].map((k) => `
          ${A.field(k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), `<select class="select" data-c-field="${i}.${k}">${Object.entries(modes).map(([v, l]) => `<option value="${v}" ${(s.fields || {})[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`).join('')}</div>`;
      }
      if (s.type === 'message') return A.field('What it says', `<textarea class="textarea" rows="3" data-s-body="${i}">${esc(s.body || '')}</textarea>`);
      if (s.type === 'availability') {
        return `${A.field('Which field holds the date', `<input class="input" data-s-date="${i}" value="${esc(s.date_question_id || 'event_date')}">`, 'The answer id of a date field on an earlier step. Usually event_date.')}
          ${A.field('If the date is free', `<input class="input" data-s-avail="${i}" value="${esc(s.available_text || '')}" placeholder="Good news, that date is open.">`)}
          ${A.field('If it is taken', `<input class="input" data-s-unavail="${i}" value="${esc(s.unavailable_text || '')}" placeholder="We may be booked, but let's talk.">`)}`;
      }
      if (s.type === 'schedule') {
        return A.field('Which calendar', `<select class="select" data-s-et="${i}">${Object.entries(etOptions).map(([v, l]) => `<option value="${v}" ${String(s.event_type_id || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
          'The booking page that owns the hours and the people. Change hours there, not here.');
      }
      return '';
    };

    const stepHtml = (s, i) => `<div class="panel sub step-card" data-step-row="${i}">
      <div class="row between">
        <b>${i + 1}. ${esc(STEP_LABEL[s.type] || s.type)}</b>
        <div class="row" style="gap:4px">
          <button type="button" class="btn btn-link btn-sm" data-show-step="${i}" title="Show this step in the preview">Preview</button>
          <button type="button" class="btn btn-link btn-sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="btn btn-link btn-sm" data-down="${i}" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="btn btn-link btn-sm" data-rm-step="${i}">Remove</button>
        </div>
      </div>
      <div class="small muted" style="margin:-4px 0 8px">${esc(STEP_HINT[s.type] || '')}</div>
      <div class="grid-2">
        ${A.field('Heading', `<input class="input" data-s-title="${i}" value="${esc(s.title || '')}">`)}
        ${A.field('Subheading', `<input class="input" data-s-sub="${i}" value="${esc(s.subtitle || '')}">`)}
      </div>
      ${stepBody(s, i)}
      <details class="q-more" ${s.image ? 'open' : ''}><summary>Picture at the top of this step</summary>${imagePick(`data-s-img="${i}"`, s.image, 'Optional. Shows above this step on every layout.')}</details>
    </div>`;

    const stepsTab = () => `<div id="steps">${steps.map(stepHtml).join('')}</div>
      <div class="panel sub">
        <b>Add a step</b>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
          ${Object.keys(STEP_LABEL).map((t) => `<button type="button" class="btn btn-ghost btn-sm" data-add-step="${t}" title="${esc(STEP_HINT[t])}">${esc(STEP_LABEL[t])}</button>`).join('')}
        </div>
      </div>`;

    // ----- Look tab -----
    const lookTab = () => {
      const s = style;
      const isFull = s.layout === 'full';
      return `<div class="panel">
        <b>Layout</b>
        <div class="help" style="margin:4px 0 12px">Picking one sets everything below to suit it. Your colours, images, fonts and custom CSS are kept.</div>
        <div class="layout-pick">${layouts.map((l) => `<button type="button" class="layout-card ${s.layout === l.id ? 'on' : ''}" data-layout="${l.id}">
          ${THUMB[l.id] || ''}<span class="lc-name">${esc(l.name)}</span><span class="lc-blurb">${esc(l.blurb)}</span></button>`).join('')}</div>
      </div>

      <div class="look">
      ${section('Progress', `<div class="grid-2">
          ${A.field('Show progress as', sel('progress', s.progress, { bar: 'A bar', steps: 'Named steps', dots: 'Dots', count: 'Step 2 of 4', none: 'Hide it' }))}
          ${s.progress === 'bar' ? `<div class="field"><label>&nbsp;</label>${tog('progress_count', s.progress_count, 'Show 2 / 4 beside the bar')}</div>` : ''}
        </div>`, true)}

      ${section('What shows', `<div class="tog-grid">
          ${tog('show_logo', s.show_logo, 'Logo')}
          ${tog('show_name', s.show_name, 'Business name')}
          ${tog('show_title', s.show_title, 'Form title')}
          ${tog('show_description', s.show_description, 'Description')}
          ${isFull ? tog('show_sidebar', s.show_sidebar, 'Side panel') : ''}
          ${tog('show_trust', s.show_trust, 'Trust points')}
          ${tog('show_step_titles', s.show_step_titles, 'Step headings')}
          ${tog('show_subtitles', s.show_subtitles, 'Step subheadings')}
          ${tog('show_labels', s.show_labels, 'Field labels (off puts them inside the box)')}
          ${tog('show_back', s.show_back, 'Back button')}
        </div>`, true)}

      ${section('Colors', `<div class="grid-2">
          ${A.field('Accent (buttons, selected choices)', color('accent', s.accent, data.brand_color || '#6d4aff'), 'Blank uses your brand colour.')}
          ${A.field('Button text', color('button_text', s.button_text, '#ffffff'), 'Blank picks black or white to suit the accent.')}
          ${A.field('Page background', color('background', s.background, '#f6f4f1'))}
          ${A.field('Card', color('surface', s.surface, '#ffffff'))}
          ${A.field('Text', color('text', s.text, '#1c1a22'))}
        </div>`, true)}

      ${section('Images', `
          ${A.field('Logo', imagePick('data-st="logo_url"', s.logo_url, data.logo_url ? 'Blank uses the logo from your business settings.' : 'No logo in your business settings yet, so the first letter of the name is used.'))}
          ${A.field('Banner across the top', imagePick('data-st="header_image"', s.header_image, 'Wide photos work best, about 1600 × 500.'))}
          ${A.field('Banner height (px)', num('header_height', s.header_height, 'min="60" max="420" step="10"'))}
          ${A.field('Page background photo', imagePick('data-st="background_image"', s.background_image))}
          ${A.field(`Darken the background photo (${s.overlay}%)`, `<input type="range" min="0" max="85" step="5" data-st="overlay" value="${esc(s.overlay)}" style="width:100%">`)}
        `, s.layout === 'visual')}

      ${section('Text', `<div class="grid-2">
          ${A.field('Font', sel('font', s.font, Object.fromEntries(fonts.map((f) => [f, f]))))}
          ${A.field('Heading font', sel('heading_font', s.heading_font, Object.fromEntries([['', 'Same as the text']].concat(fonts.map((f) => [f, f])))))}
          ${A.field('Text size (px)', num('font_size', s.font_size, 'min="12" max="20"'))}
          ${A.field('Heading size (px)', num('heading_size', s.heading_size, 'min="14" max="44"'))}
        </div>`)}

      ${section('Size and shape', `<div class="grid-2">
          ${A.field('Width (px)', num('width', s.width, 'min="0" max="1400" step="10"'), '0 means the layout\'s own width.')}
          ${A.field('Spacing', sel('density', s.density, { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' }))}
          ${A.field('Card corners (px)', num('radius', s.radius, 'min="0" max="40"'))}
          ${A.field('Field corners (px)', num('field_radius', s.field_radius, 'min="0" max="30"'))}
          ${A.field('Line up', sel('align', s.align, { left: 'Left', center: 'Centered' }))}
          <div class="field"><label>&nbsp;</label><div class="stack" style="gap:8px">${tog('shadow', s.shadow, 'Shadow')}${tog('border', s.border, 'Border')}</div></div>
        </div>`)}

      ${section('Buttons', `<div class="grid-2">
          ${A.field('Shape', sel('button_shape', s.button_shape, { square: 'Square', rounded: 'Rounded', pill: 'Pill' }))}
          ${A.field('Style', sel('button_style', s.button_style, { filled: 'Filled', outline: 'Outline' }))}
          ${A.field('Next button says', txt('continue_label', s.continue_label))}
          ${A.field('Back button says', txt('back_label', s.back_label))}
        </div>${tog('button_full', s.button_full, 'Full-width button')}<div class="help" style="margin-top:6px">The last step's button is set on the Settings tab.</div>`)}

      ${section('Choices', `<div class="grid-2">
          ${A.field('Draw choices as', sel('option_style', s.option_style, { cards: 'Cards', list: 'A list', pills: 'Pills', images: 'Photo cards' }), 'Each question can override this.')}
          ${A.field('Columns', sel('option_columns', s.option_columns, { auto: 'Fit the space', 1: '1', 2: '2', 3: '3', 4: '4' }))}
          ${A.field('Photo shape', sel('image_shape', s.image_shape, { square: 'Square', wide: 'Wide', tall: 'Tall', circle: 'Circle' }))}
          ${A.field('Photo fit', sel('image_fit', s.image_fit, { cover: 'Fill the frame', contain: 'Show the whole picture' }))}
        </div>${tog('auto_advance', s.auto_advance, 'Move on as soon as they pick (steps with a single pick-one question)')}`)}

      ${section('Dates', A.field('Date questions show as', sel('date_display', s.date_display, { calendar: 'A calendar to click', typed: 'Type the numbers (MM / DD / YYYY)', picker: "The phone's date picker" }), 'Each date question can override this under More options.'))}

      ${section('Custom CSS', A.field('Your own CSS', `<textarea class="textarea mono" rows="6" data-st="custom_css" placeholder=".f-title { letter-spacing: .02em; }">${esc(s.custom_css || '')}</textarea>`, 'Applies to this form only. Useful classes: <code>.f-card</code>, <code>.f-title</code>, <code>.step-head</code>, <code>.opt</code>, <code>.f-next</code>.'))}
      </div>`;
    };

    // ----- Settings tab -----
    const settingsTab = () => `<div class="panel stack">
        ${A.field('Name', `<input class="input" data-bind="name" value="${esc(x ? x.name : '')}" placeholder="Quick enquiry">`, 'Shows as the form title, if the title is switched on.')}
        ${A.field('What the visitor reads at the top', `<textarea class="textarea" rows="2" data-bind="description">${esc(x ? x.description : '')}</textarea>`)}
        ${A.field('Button on the last step', `<input class="input" data-bind="settings.submit_cta" value="${esc((x && x.copy.submit_cta) || 'Submit')}">`)}
        ${A.field('Thank you heading', `<input class="input" data-bind="settings.done_heading" value="${esc((x && x.copy.done_heading) || 'Thank you')}">`)}
        ${A.field('Thank you message', `<input class="input" data-bind="settings.done_blurb" value="${esc((x && x.copy.done_blurb) || '')}">`)}
        ${A.field('Or send them to a page instead', `<input class="input" data-bind="settings.redirect_url" value="${esc((x && x.copy.redirect_url) || '')}" placeholder="https://weddingsunlimited.com/thank-you">`, 'Leave blank to show the message above.')}
        <label class="toggle"><input type="checkbox" data-bind="settings.notify" ${(!x || x.copy.notify) ? 'checked' : ''}><span class="sw"></span><span>Email the team on every submission</span></label>
        ${x ? A.toggle('active', x.active, 'Live on the website') : ''}
      </div>`;

    A.drawer(`<div class="form-builder">
      <div class="fb-edit">
        <div class="drawer-head"><div><div class="small muted">Form</div><h2>${x ? esc(x.name) : 'New form'}</h2></div>
          <div class="row" style="gap:6px"><button type="button" class="btn btn-ghost btn-sm fb-preview-toggle" data-toggle-preview>Preview</button><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div></div>
        <div class="tabs" role="tablist">
          <a href="#" role="tab" data-tab="steps" class="on">Steps</a>
          <a href="#" role="tab" data-tab="look">Look</a>
          <a href="#" role="tab" data-tab="settings">Settings</a>
        </div>
        <form id="form-form">
          <div data-pane="steps">${stepsTab()}</div>
          <div data-pane="look" hidden>${lookTab()}</div>
          <div data-pane="settings" hidden id="form-body">${settingsTab()}</div>
          <div class="row between fb-actions">
            ${x ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
            <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
            <button type="submit" class="btn btn-primary">${x ? 'Save form' : 'Create form'}</button></div>
          </div>
        </form>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden data-file>
      </div>
      <div class="fb-preview">
        <div class="fb-preview-bar">
          <span class="small muted">Live preview</span>
          <div class="seg" role="group" aria-label="Preview size"><button type="button" class="on" data-device="desktop">Desktop</button><button type="button" data-device="phone">Phone</button></div>
        </div>
        <div class="fb-frame-wrap"><iframe class="fb-frame" src="/app/form-preview" title="Form preview"></iframe></div>
      </div>
    </div>`, (root) => {
      root.classList.add('drawer-form');
      wire(root);
    });

    // ----- reading the editor back into steps and style -----
    function harvest(root) {
      $$('[data-step-row]', root).forEach((row) => {
        const i = Number(row.dataset.stepRow);
        const s = steps[i];
        if (!s) return;
        const val = (attr) => { const el = $(`[data-${attr}="${i}"]`, root); return el ? el.value : undefined; };
        s.title = val('s-title'); s.subtitle = val('s-sub');
        s.image = val('s-img') || '';
        if (s.type === 'message') s.body = val('s-body');
        if (s.type === 'availability') { s.date_question_id = val('s-date'); s.available_text = val('s-avail'); s.unavailable_text = val('s-unavail'); }
        if (s.type === 'schedule') s.event_type_id = Number(val('s-et')) || null;
        if (s.type === 'contact') {
          s.fields = s.fields || {};
          for (const k of ['first_name', 'last_name', 'email', 'phone', 'sms_consent']) {
            const el = $(`[data-c-field="${i}.${k}"]`, root);
            if (el) s.fields[k] = el.value;
          }
        }
        if (s.type === 'questions') {
          (s.questions || []).forEach((q, qi) => {
            const k = `${i}.${qi}`;
            const g = (attr) => $(`[data-${attr}="${k}"]`, root);
            if (!g('q-label')) return;
            q.label = g('q-label').value;
            q.type = g('q-type').value;
            q.required = g('q-req').checked;
            if (g('q-ph')) q.placeholder = g('q-ph').value;
            if (g('q-help')) q.help = g('q-help').value;
            if (g('q-width')) q.width = g('q-width').value;
            if (g('q-id')) q.id = g('q-id').value.trim();
            if (g('q-display')) q.display = g('q-display').value;
            if (g('q-date')) { q.date_display = g('q-date').value; q.allow_past = g('q-past').checked; }
            if (g('q-numdisp')) {
              q.number_display = g('q-numdisp').value; q.suffix = g('q-suffix').value;
              q.min = g('q-min').value === '' ? null : Number(g('q-min').value);
              q.max = g('q-max').value === '' ? null : Number(g('q-max').value);
            }
            // Photos and notes are read against the choices as they were drawn, then the new list
            // is applied. A renamed choice in the same position keeps its photo.
            const old = q.options || [];
            const imgs = {}, notes = {};
            old.forEach((o, oi) => {
              const im = $(`[data-opt-img="${k}.${oi}"]`, root), nt = $(`[data-opt-note="${k}.${oi}"]`, root);
              if (im && im.value) imgs[o] = im.value; else if (q.option_images && q.option_images[o] && !im) imgs[o] = q.option_images[o];
              if (nt && nt.value) notes[o] = nt.value; else if (q.option_notes && q.option_notes[o] && !nt) notes[o] = q.option_notes[o];
            });
            const ta = g('q-opts');
            const fresh = ta ? ta.value.split('\n').map((o) => o.trim()).filter(Boolean) : old;
            if (ta && fresh.length === old.length) fresh.forEach((o, oi) => { if (o !== old[oi]) { if (imgs[old[oi]] && !imgs[o]) imgs[o] = imgs[old[oi]]; if (notes[old[oi]] && !notes[o]) notes[o] = notes[old[oi]]; } });
            q.options = fresh;
            q.option_images = Object.fromEntries(fresh.filter((o) => imgs[o]).map((o) => [o, imgs[o]]));
            q.option_notes = Object.fromEntries(fresh.filter((o) => notes[o]).map((o) => [o, notes[o]]));
          });
        }
      });
      $$('[data-q-more]', root).forEach((d) => { if (d.open) openQs.add(d.dataset.qMore); else openQs.delete(d.dataset.qMore); });
    }

    function harvestStyle(root) {
      const pane = $('[data-pane="look"]', root);
      $$('[data-st]', pane).forEach((el) => {
        const k = el.dataset.st;
        if (el.type === 'checkbox') style[k] = el.checked;
        else if (el.type === 'number' || el.type === 'range') style[k] = el.value === '' ? 0 : Number(el.value);
        else style[k] = el.value;
      });
      if (style.option_columns !== 'auto') style.option_columns = Number(style.option_columns) || 'auto';
    }

    function payload(root) {
      harvest(root); harvestStyle(root);
      const p = A.collect($('#form-body', root));
      p.steps = steps;
      p.settings = Object.assign(p.settings || {}, { style });
      return p;
    }

    const paneHtml = { steps: stepsTab, look: lookTab, settings: settingsTab };
    function repaint(root, which, opts) {
      // Callers that just added, removed or reordered steps or questions have already read the
      // screen. Reading it again here would write the old rows back by position over the new list
      // (removing question 1 would then wipe question 2 instead).
      if (!(opts && opts.harvested)) harvest(root);
      // After a layout change the style is already new; reading the old controls would undo it.
      if (!(opts && opts.styleIsFresh)) harvestStyle(root);
      const open = $$('.look-sec', root).filter((d) => d.open).map((d) => d.dataset.sec);
      const panes = which ? [which] : ['steps', 'look'];
      for (const p of panes) $(`[data-pane="${p}"]`, root).innerHTML = paneHtml[p]();
      if (panes.includes('look')) $$('.look-sec', root).forEach((d) => { if (open.includes(d.dataset.sec)) d.open = true; });
      sendPreview(root);
    }

    // ----- the live preview -----
    let previewReady = false, previewTimer = null;
    function sendPreview(root) {
      if (!previewReady) return;
      const frame = $('.fb-frame', root);
      if (!frame || !frame.contentWindow) return;
      let p;
      try { p = payload(root); } catch (e) { return; }
      const copy = Object.assign({}, data.defaults || {}, p.settings || {});
      delete copy.style;
      frame.contentWindow.postMessage({
        type: 'availvo:form-preview',
        style, copy, steps: JSON.parse(JSON.stringify(steps)), focus: focusStep,
        form: { name: p.name || '', description: p.description || '' },
      }, location.origin);
    }
    const schedulePreview = (root) => { clearTimeout(previewTimer); previewTimer = setTimeout(() => sendPreview(root), 160); };

    // ----- uploads -----
    function upload(root, onDone) {
      const input = $('[data-file]', root);
      input.value = '';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return A.toast('That image is too large. Keep it under 5MB.', true);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const r = await A.guard(() => api('POST', '/uploads', { data: reader.result }), 'Image uploaded');
            onDone(r.url);
          } catch (e) { /* toast shown */ }
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }

    function wire(root) {
      const frame = $('.fb-frame', root);
      const onMsg = (e) => {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'availvo:form-preview-ready') return;
        if (!frame || e.source !== frame.contentWindow) return;
        previewReady = true; sendPreview(root);
      };
      window.addEventListener('message', onMsg);
      // The drawer is removed from the page when it closes; stop listening then.
      const gone = new MutationObserver(() => { if (!document.body.contains(root)) { window.removeEventListener('message', onMsg); gone.disconnect(); } });
      gone.observe(document.body, { childList: true });

      root.addEventListener('click', (e) => {
        const t = e.target;
        const tb = t.closest('[data-tab]');
        if (tb) {
          e.preventDefault();
          harvest(root); harvestStyle(root);
          tab = tb.dataset.tab;
          $$('[data-tab]', root).forEach((a) => a.classList.toggle('on', a === tb));
          $$('[data-pane]', root).forEach((p) => { p.hidden = p.dataset.pane !== tab; });
          return;
        }
        if (t.closest('[data-toggle-preview]')) { root.classList.toggle('show-preview'); return; }
        const dev = t.closest('[data-device]');
        if (dev) { $$('[data-device]', root).forEach((b) => b.classList.toggle('on', b === dev)); $('.fb-frame-wrap', root).classList.toggle('phone', dev.dataset.device === 'phone'); return; }

        const lay = t.closest('[data-layout]');
        if (lay) {
          harvestStyle(root);
          // Brand pieces travel with you from layout to layout; structure comes from the new one.
          const keep = ['accent', 'background', 'surface', 'text', 'button_text', 'background_image', 'overlay', 'header_image', 'logo_url', 'font', 'heading_font', 'custom_css', 'continue_label', 'back_label'];
          const kept = Object.fromEntries(keep.map((k) => [k, style[k]]));
          style = Object.assign(defaultsFor(lay.dataset.layout), kept, { layout: lay.dataset.layout });
          repaint(root, 'look', { styleIsFresh: true });
          return;
        }
        const clr = t.closest('[data-clear-st]');
        if (clr) { const inp = $(`[data-st="${clr.dataset.clearSt}"]`, root); if (inp) inp.value = ''; harvestStyle(root); return sendPreview(root); }

        const up = t.closest('[data-upload]');
        if (up) {
          const box = up.closest('.img-pick, .opt-row');
          const target = box && $('input[data-st], input[data-s-img], input[data-opt-img]', box);
          if (!target) return;
          return upload(root, (url) => { target.value = url; repaint(root, target.dataset.st ? 'look' : 'steps'); });
        }
        const ci = t.closest('[data-clear-img]');
        if (ci) {
          const box = ci.closest('.img-pick, .opt-row');
          const target = box && $('input[data-st], input[data-s-img], input[data-opt-img]', box);
          if (target) { target.value = ''; repaint(root, target.dataset.st ? 'look' : 'steps'); }
          return;
        }

        const show = t.closest('[data-show-step]');
        if (show) { focusStep = Number(show.dataset.showStep); root.classList.add('show-preview'); return sendPreview(root); }

        const add = t.closest('[data-add-step]');
        if (add) {
          harvest(root);
          const type = add.dataset.addStep;
          const fresh = { type, title: STEP_LABEL[type], subtitle: '' };
          if (type === 'questions') fresh.questions = [{ id: '', label: '', type: 'text', required: false, options: [] }];
          if (type === 'contact') fresh.fields = { first_name: 'required', last_name: 'optional', email: 'required', phone: 'optional', sms_consent: 'hidden' };
          if (type === 'availability') fresh.date_question_id = 'event_date';
          steps.push(fresh); focusStep = steps.length - 1; return repaint(root, 'steps', { harvested: true });
        }
        const rm = t.closest('[data-rm-step]'); if (rm) { harvest(root); steps.splice(Number(rm.dataset.rmStep), 1); focusStep = Math.min(focusStep, steps.length - 1); return repaint(root, 'steps', { harvested: true }); }
        const upS = t.closest('[data-up]'); if (upS) { harvest(root); const i = Number(upS.dataset.up); [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; return repaint(root, 'steps', { harvested: true }); }
        const dn = t.closest('[data-down]'); if (dn) { harvest(root); const i = Number(dn.dataset.down); [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; return repaint(root, 'steps', { harvested: true }); }
        const aq = t.closest('[data-add-q]'); if (aq) { harvest(root); steps[Number(aq.dataset.addQ)].questions.push({ id: '', label: '', type: 'text', required: false, options: [] }); return repaint(root, 'steps', { harvested: true }); }
        const rq = t.closest('[data-rm-q]'); if (rq) { harvest(root); const [i, qi] = rq.dataset.rmQ.split('.').map(Number); steps[i].questions.splice(qi, 1); openQs.clear(); return repaint(root, 'steps', { harvested: true }); }
        const qu = t.closest('[data-q-up]'); if (qu) { harvest(root); const [i, qi] = qu.dataset.qUp.split('.').map(Number); const qs = steps[i].questions; [qs[qi - 1], qs[qi]] = [qs[qi], qs[qi - 1]]; openQs.clear(); return repaint(root, 'steps', { harvested: true }); }
        const qd = t.closest('[data-q-down]'); if (qd) { harvest(root); const [i, qi] = qd.dataset.qDown.split('.').map(Number); const qs = steps[i].questions; [qs[qi + 1], qs[qi]] = [qs[qi], qs[qi + 1]]; openQs.clear(); return repaint(root, 'steps', { harvested: true }); }
      });

      // Whichever step you are working in is the one the preview shows.
      root.addEventListener('focusin', (e) => {
        const row = e.target.closest('[data-step-row]');
        if (row && Number(row.dataset.stepRow) !== focusStep) { focusStep = Number(row.dataset.stepRow); schedulePreview(root); }
      });

      root.addEventListener('input', (e) => {
        const t = e.target;
        if (t.dataset.stColor) { const box = $(`[data-st="${t.dataset.stColor}"]`, root); if (box) box.value = t.value; }
        if (t.dataset.st && /^#[0-9a-f]{6}$/i.test(t.value)) { const c = $(`[data-st-color="${t.dataset.st}"]`, root); if (c) c.value = t.value; }
        if (t.dataset.st === 'overlay') { const lab = t.closest('.field') && $('label', t.closest('.field')); if (lab) lab.textContent = `Darken the background photo (${t.value}%)`; }
        schedulePreview(root);
      });
      // Changing a question's type, its choices or the layout changes which inputs make sense.
      root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.matches('[data-q-type], [data-q-opts], [data-q-display], [data-q-numdisp]')) return repaint(root, 'steps');
        if (t.matches('[data-st="show_sidebar"], [data-st="progress"]')) return repaint(root, 'look');
        if (t.matches('[data-st="logo_url"], [data-st="header_image"], [data-st="background_image"], [data-s-img]')) return repaint(root, t.dataset.st ? 'look' : 'steps');
        schedulePreview(root);
      });

      $('#form-form', root).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        let p;
        try { p = payload(root); } catch (err) { return A.toast(err.message, true); }
        if (!x) p.active = true;
        try {
          await A.guard(() => (x ? api('PATCH', `/forms/${x.id}`, p) : api('POST', '/forms', p)), x ? 'Saved' : 'Form created');
          A.closeDrawer(); A.render();
        } catch (err) {
          if (err.details && (err.details.name)) { $$('[data-tab]', root).find((a) => a.dataset.tab === 'settings').click(); }
          A.showErrors(root, err.details);
        }
      });

      const del = $('[data-del]', root);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${x.name}"?${x.leads ? ' It has submissions, so it will be switched off instead.' : ''}`)) return;
        try { await A.guard(() => api('DELETE', `/forms/${x.id}`), 'Done'); A.closeDrawer(); A.render(); } catch (e) { /* toast shown */ }
      });
    }
  }
})();
