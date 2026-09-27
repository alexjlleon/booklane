/* Admin: build a form out of ordered steps.
   Short ones for a button on the website, long ones for someone who means it. */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const STEP_LABEL = {
    questions: 'Questions', contact: 'Contact details', message: 'A note',
    availability: 'Date check', schedule: 'Calendar', product: 'Choose a product', payment: 'Payment',
  };
  const STEP_HINT = {
    questions: 'Any fields you like',
    contact: 'Name, email, phone',
    message: 'Just words. Useful for setting expectations.',
    availability: 'Checks a date they gave against your calendar',
    schedule: 'Pick a time on one of your booking pages',
    product: 'Choose album options, sizes, extras',
    payment: 'Take the money',
  };
  const Q_LABEL = { text: 'Short text', textarea: 'Long text', number: 'Number', date: 'Date', select: 'Dropdown', choice: 'Pick one', multi: 'Pick several' };
  const dollars = (c) => (Number(c || 0) / 100).toFixed(2);
  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div><div class="s">${s}</div></div>`;

  function shapeWords(sh) {
    if (sh.lead_only) return 'Captures a lead';
    const bits = [];
    if (sh.charges) bits.push(sh.schedules_after_payment ? 'Pays, then books' : 'Takes payment');
    else if (sh.schedules) bits.push('Books a time');
    return bits.join(' · ') || 'Captures a lead';
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
          <p>A form is any flow you want: two questions behind a button on the website, or a long one that checks a date, takes a payment and books a call. Start from a shape below, or build one from scratch.</p>
          <div class="row" style="justify-content:center;flex-wrap:wrap;gap:8px;margin-top:6px">
            ${data.templates.map((t) => `<button type="button" class="btn btn-ghost btn-sm" data-tpl="${esc(t.id)}" title="${esc(t.description)}">${esc(t.name)}</button>`).join('')}
            <button type="button" class="btn btn-primary btn-sm" data-new>Blank form</button>
          </div>
        </div></div>`;
      }

      return `<div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Forms</h1><div class="small muted" style="margin-top:2px">Custom flows. Your booking pages, sessions and products stay where they are.</div></div>
        <div class="row"><button type="button" class="btn btn-ghost" data-tpl-menu>Start from a shape</button><button type="button" class="btn btn-primary" data-new>New form</button></div>
      </div>

      <div class="stats">
        ${stat('Forms', data.forms.filter((f) => f.active).length, `of ${data.forms.length} · ${data.forms.filter((f) => !f.active).length} off`)}
        ${stat('Submissions', total, total ? '<a href="#/leads">see the leads</a>' : 'none yet')}
        ${stat('Taking payment', data.forms.filter((f) => f.shape.charges).length, 'of your forms')}
      </div>

      <div class="panel">
        <table class="table"><thead><tr><th>FORM</th><th>DOES</th><th>STEPS</th><th>SUBMISSIONS</th><th></th></tr></thead>
        <tbody>${data.forms.map((f) => `<tr${f.active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(f.name)}</b>${f.active ? '' : ' <span class="pill lost">Off</span>'}
            <div class="small muted"><a href="${esc(f.url)}" target="_blank">${esc(f.url.replace(/^https?:\/\/[^/]+/, ''))}</a></div></td>
          <td class="small">${esc(shapeWords(f.shape))}</td>
          <td class="small">${f.steps.map((s) => esc(STEP_LABEL[s.type] || s.type)).join(' → ') || '<span class="muted">empty</span>'}</td>
          <td>${f.leads || ''}</td>
          <td class="row" style="gap:6px">
            <button type="button" class="btn btn-link btn-sm" data-embed="${f.id}">Embed</button>
            <a class="btn btn-link btn-sm" href="${esc(f.url)}" target="_blank">View</a>
            <button type="button" class="btn btn-link btn-sm" data-edit="${f.id}">Edit</button>
          </td>
        </tr>`).join('')}</tbody></table>
      </div>`;
    },
    events(root) {
      const data = A.cache.forms;
      root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-new]')) return editForm(null, data);
        const ed = e.target.closest('[data-edit]');
        if (ed) return editForm(data.forms.find((f) => f.id === Number(ed.dataset.edit)), data);
        const em = e.target.closest('[data-embed]');
        if (em) return showEmbed(data.forms.find((f) => f.id === Number(em.dataset.embed)));
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
      <p class="help">Each one is a starting point wired to your own pages and products. Everything is editable afterwards.</p>
      <div class="stack">${data.templates.map((t) => `<button type="button" class="opt" style="text-align:left;width:100%" data-tpl="${esc(t.id)}">
        <span class="opt-stack"><span>${esc(t.name)}</span><span class="opt-hint">${esc(t.description)}</span></span></button>`).join('')}</div>`);
  }

  function showEmbed(f) {
    const iframe = `<iframe src="${f.url}?embed=1" style="width:100%;height:760px;border:0" loading="lazy" title="${f.name}"></iframe>`;
    const button = `<a href="${f.url}" class="wu-cta">${f.name}</a>`;
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Embed</div><h2>${esc(f.name)}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <div class="panel stack">
        ${A.field('Link', `<input class="input" readonly value="${esc(f.url)}">`, 'For a button, an email, or a QR code.')}
        ${A.field('On the page', `<textarea class="textarea" rows="3" readonly>${esc(iframe)}</textarea>`, 'Drops the whole form into a page. Good for a dedicated landing page.')}
        ${A.field('As a link', `<textarea class="textarea" rows="2" readonly>${esc(button)}</textarea>`, 'Style <code>.wu-cta</code> however you like on the site.')}
        <div class="row"><button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(f.url)}">Copy the link</button>
        <button type="button" class="btn btn-ghost btn-sm" data-copy="${esc(iframe)}">Copy the embed</button></div>
      </div>`);
  }

  // ---------------- the builder ----------------
  function editForm(x, data) {
    const steps = JSON.parse(JSON.stringify(x ? x.steps : []));
    const etOptions = Object.fromEntries([['', 'Choose a booking page…']].concat(data.event_types.map((e) => [e.id, e.name])));
    const prodOptions = Object.fromEntries([['', 'Choose a product…']].concat(data.products.map((p) => [p.id, p.name])));

    const questionRow = (si, qi, q) => `<tr>
      <td><input class="input" data-q-label="${si}.${qi}" value="${esc(q.label || '')}" placeholder="What is your wedding date?"></td>
      <td><select class="select" data-q-type="${si}.${qi}">${Object.entries(Q_LABEL).map(([v, l]) => `<option value="${v}" ${q.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
      <td><input class="input" data-q-opts="${si}.${qi}" value="${esc((q.options || []).join(', '))}" placeholder="Comma separated" ${['choice', 'multi', 'select'].includes(q.type) ? '' : 'disabled'}></td>
      <td style="text-align:center"><input type="checkbox" data-q-req="${si}.${qi}" ${q.required ? 'checked' : ''}></td>
      <td><button type="button" class="btn btn-link btn-sm" data-rm-q="${si}.${qi}">&times;</button></td>
    </tr>`;

    const stepBody = (s, i) => {
      if (s.type === 'questions') {
        return `<div class="field"><label>Fields</label>
          <table class="table compact"><thead><tr><th>Label</th><th style="width:130px">Type</th><th>Choices</th><th style="width:70px">Required</th><th></th></tr></thead>
          <tbody>${(s.questions || []).map((q, qi) => questionRow(i, qi, q)).join('')}</tbody></table>
          <button type="button" class="btn btn-ghost btn-sm" data-add-q="${i}">Add a field</button></div>`;
      }
      if (s.type === 'contact') {
        const modes = { required: 'Required', optional: 'Optional', hidden: 'Do not ask' };
        return `<div class="grid-2">${['first_name', 'last_name', 'email', 'phone', 'sms_consent'].map((k) => `
          ${A.field(k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), `<select class="select" data-c-field="${i}.${k}">${Object.entries(modes).map(([v, l]) => `<option value="${v}" ${(s.fields || {})[k] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}`).join('')}</div>`;
      }
      if (s.type === 'message') return A.field('What it says', `<textarea class="textarea" rows="3" data-s-body="${i}">${esc(s.body || '')}</textarea>`);
      if (s.type === 'availability') {
        return `${A.field('Which field holds the date', `<input class="input" data-s-date="${i}" value="${esc(s.date_question_id || 'event_date')}">`, 'The id of a date field on an earlier step. Usually event_date.')}
          ${A.field('If the date is free', `<input class="input" data-s-avail="${i}" value="${esc(s.available_text || '')}" placeholder="Good news, that date is open.">`)}
          ${A.field('If it is taken', `<input class="input" data-s-unavail="${i}" value="${esc(s.unavailable_text || '')}" placeholder="We may be booked, but let's talk.">`)}`;
      }
      if (s.type === 'schedule') {
        return A.field('Which calendar', `<select class="select" data-s-et="${i}">${Object.entries(etOptions).map(([v, l]) => `<option value="${v}" ${String(s.event_type_id || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
          'The booking page that owns the hours and the people. Change hours there, not here.');
      }
      if (s.type === 'product') {
        return A.field('Which product', `<select class="select" data-s-prod="${i}">${Object.entries(prodOptions).map(([v, l]) => `<option value="${v}" ${String(s.product_id || '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`,
          'Its options and prices come from Products.');
      }
      if (s.type === 'payment') {
        const fixed = s.source === 'fixed';
        return `${A.field('What are they paying for', `<select class="select" data-s-src="${i}"><option value="product" ${fixed ? '' : 'selected'}>Whatever they chose on the product step</option><option value="fixed" ${fixed ? 'selected' : ''}>A set amount</option></select>`)}
          ${A.field('Amount', `<input class="input" type="number" step="0.01" min="0" data-s-amt="${i}" value="${esc(dollars(s.amount_cents))}" ${fixed ? '' : 'disabled'}>`)}
          ${A.field('Shown as', `<input class="input" data-s-plabel="${i}" value="${esc(s.label || '')}" placeholder="Engagement Session">`)}`;
      }
      return '';
    };

    const stepHtml = (s, i) => `<div class="panel sub" data-step-row="${i}">
      <div class="row between">
        <b>${i + 1}. ${esc(STEP_LABEL[s.type] || s.type)}</b>
        <div class="row" style="gap:4px">
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
    </div>`;

    const body = () => `
      <div class="panel stack">
        ${A.field('Name', `<input class="input" data-bind="name" value="${esc(x ? x.name : '')}" placeholder="Quick enquiry">`, 'Only you see this.')}
        ${A.field('What the visitor reads at the top', `<textarea class="textarea" rows="2" data-bind="description">${esc(x ? x.description : '')}</textarea>`)}
        ${A.field('Button on the last step', `<input class="input" data-bind="settings.submit_cta" value="${esc((x && x.copy.submit_cta) || 'Submit')}">`)}
        ${A.field('Thank you heading', `<input class="input" data-bind="settings.done_heading" value="${esc((x && x.copy.done_heading) || 'Thank you')}">`)}
        ${A.field('Thank you message', `<input class="input" data-bind="settings.done_blurb" value="${esc((x && x.copy.done_blurb) || '')}">`)}
        ${A.field('Or send them to a page instead', `<input class="input" data-bind="settings.redirect_url" value="${esc((x && x.copy.redirect_url) || '')}" placeholder="https://weddingsunlimited.com/thank-you">`, 'Leave blank to show the message above.')}
        <label class="toggle"><input type="checkbox" data-bind="settings.notify" ${(!x || x.copy.notify) ? 'checked' : ''}><span class="sw"></span><span>Email the team on every submission</span></label>
        ${x ? A.toggle('active', x.active, 'Live on the website') : ''}
      </div>
      <div id="steps">${steps.map(stepHtml).join('')}</div>
      <div class="panel sub">
        <b>Add a step</b>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:8px">
          ${Object.keys(STEP_LABEL).map((t) => `<button type="button" class="btn btn-ghost btn-sm" data-add-step="${t}" title="${esc(STEP_HINT[t])}">${esc(STEP_LABEL[t])}</button>`).join('')}
        </div>
      </div>`;

    A.drawer(`<div class="drawer-head"><div><div class="small muted">Form</div><h2>${x ? esc(x.name) : 'New form'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <form id="form-form"><div id="form-body">${body()}</div>
        <div class="row between" style="margin-top:16px">
          ${x ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
          <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
          <button type="submit" class="btn btn-primary">${x ? 'Save form' : 'Create form'}</button></div>
        </div>
      </form>`, (root) => wire(root));

    function harvest(root) {
      $$('[data-step-row]', root).forEach((row) => {
        const i = Number(row.dataset.stepRow);
        const s = steps[i];
        if (!s) return;
        const val = (sel) => { const el = $(`[data-${sel}="${i}"]`, root); return el ? el.value : undefined; };
        s.title = val('s-title'); s.subtitle = val('s-sub');
        if (s.type === 'message') s.body = val('s-body');
        if (s.type === 'availability') { s.date_question_id = val('s-date'); s.available_text = val('s-avail'); s.unavailable_text = val('s-unavail'); }
        if (s.type === 'schedule') s.event_type_id = Number(val('s-et')) || null;
        if (s.type === 'product') s.product_id = Number(val('s-prod')) || null;
        if (s.type === 'payment') {
          s.source = val('s-src');
          const amt = $(`[data-s-amt="${i}"]`, root);
          if (amt) s.amount_cents = Math.round(Number(amt.value || 0) * 100);
          s.label = val('s-plabel');
        }
        if (s.type === 'contact') {
          s.fields = s.fields || {};
          for (const k of ['first_name', 'last_name', 'email', 'phone', 'sms_consent']) {
            const el = $(`[data-c-field="${i}.${k}"]`, root);
            if (el) s.fields[k] = el.value;
          }
        }
        if (s.type === 'questions') {
          (s.questions || []).forEach((q, qi) => {
            const lab = $(`[data-q-label="${i}.${qi}"]`, root);
            if (!lab) return;
            q.label = lab.value;
            q.type = $(`[data-q-type="${i}.${qi}"]`, root).value;
            q.required = $(`[data-q-req="${i}.${qi}"]`, root).checked;
            const opts = $(`[data-q-opts="${i}.${qi}"]`, root).value;
            q.options = opts.split(',').map((o) => o.trim()).filter(Boolean);
          });
        }
      });
    }
    const repaint = (root) => { harvest(root); $('#steps', root).innerHTML = steps.map(stepHtml).join(''); };

    function wire(root) {
      root.addEventListener('click', (e) => {
        const t = e.target;
        const add = t.closest('[data-add-step]');
        if (add) {
          harvest(root);
          const type = add.dataset.addStep;
          const fresh = { type, title: STEP_LABEL[type], subtitle: '' };
          if (type === 'questions') fresh.questions = [{ id: '', label: '', type: 'text', required: false, options: [] }];
          if (type === 'contact') fresh.fields = { first_name: 'required', last_name: 'optional', email: 'required', phone: 'optional', sms_consent: 'hidden' };
          if (type === 'payment') fresh.source = 'product';
          if (type === 'availability') fresh.date_question_id = 'event_date';
          steps.push(fresh); repaint(root); return;
        }
        const rm = t.closest('[data-rm-step]'); if (rm) { harvest(root); steps.splice(Number(rm.dataset.rmStep), 1); return repaint(root); }
        const up = t.closest('[data-up]'); if (up) { harvest(root); const i = Number(up.dataset.up); [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; return repaint(root); }
        const dn = t.closest('[data-down]'); if (dn) { harvest(root); const i = Number(dn.dataset.down); [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; return repaint(root); }
        const aq = t.closest('[data-add-q]'); if (aq) { harvest(root); steps[Number(aq.dataset.addQ)].questions.push({ id: '', label: '', type: 'text', required: false, options: [] }); return repaint(root); }
        const rq = t.closest('[data-rm-q]'); if (rq) { harvest(root); const [i, qi] = rq.dataset.rmQ.split('.').map(Number); steps[i].questions.splice(qi, 1); return repaint(root); }
      });
      // Changing a question's type or a payment's source changes which inputs make sense.
      root.addEventListener('change', (e) => {
        if (e.target.matches('[data-q-type],[data-s-src]')) repaint(root);
      });

      $('#form-form', root).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        harvest(root);
        let payload;
        try { payload = A.collect($('#form-body', root)); } catch (err) { return A.toast(err.message, true); }
        payload.steps = steps;
        if (!x) payload.active = true;
        try {
          await A.guard(() => (x ? api('PATCH', `/forms/${x.id}`, payload) : api('POST', '/forms', payload)), x ? 'Saved' : 'Form created');
          A.closeDrawer(); A.render();
        } catch (err) { A.showErrors(root, err.details); }
      });

      const del = $('[data-del]', root);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${x.name}"?${x.leads ? ' It has submissions, so it will be switched off instead.' : ''}`)) return;
        try { await A.guard(() => api('DELETE', `/forms/${x.id}`), 'Done'); A.closeDrawer(); A.render(); } catch (e) { /* toast shown */ }
      });
    }
  }
})();
