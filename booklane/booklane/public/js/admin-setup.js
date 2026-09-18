/* Admin views: booking pages (event types), availability, calendars, share */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;
  const isAdmin = () => ['owner', 'admin'].includes(A.me.business.role);
  const base = () => A.me.app.base_url;

  // ---------- Event types list ----------
  A.route('/event-types', {
    title: 'Booking pages',
    async render() {
      const d = await api('GET', '/event-types');
      A.cache.et = d;
      const slug = A.me.business.slug;
      return `<div class="topbar"><div><h1>Booking pages</h1><div class="sub">Each call type gets its own link, steps and scheduling rules.</div></div>
        <div class="tools">${isAdmin() ? '<a class="btn btn-primary" href="#/event-types/new">+ New call type</a>' : ''}</div></div>
        ${d.event_types.length ? `<div class="card-list">${d.event_types.map((et) => `<div class="et-card"><div class="top" style="background:${esc(et.color)}"></div><div class="body">
          <div class="row between"><h3>${esc(et.name)}</h3>${et.active ? '' : '<span class="pill">Off</span>'}</div>
          <div class="small muted" style="margin:4px 0 10px">${et.duration_min} min · ${esc(d.location_types[et.location_type])} · ${et.steps.length} steps</div>
          <div class="small">${esc(et.hosts.map((h) => (d.members.find((m) => m.id === h) || {}).name).filter(Boolean).join(', '))}${et.hosts.length > 1 ? ` · ${et.assignment === 'round_robin' ? 'round robin' : 'first available'}` : ''}</div>
          <div class="small muted" style="margin-top:6px">${et.bookings_30d} booked in 30 days</div></div>
          <div class="foot"><button class="btn btn-link btn-sm" data-copy="${esc(base())}/b/${esc(slug)}/${esc(et.slug)}">Copy link</button>
          <div class="row" style="gap:4px"><a class="btn btn-ghost btn-sm" href="/b/${esc(slug)}/${esc(et.slug)}" target="_blank">Preview</a>${isAdmin() ? `<a class="btn btn-ghost btn-sm" href="#/event-types/${et.id}">Edit</a>` : ''}</div></div></div>`).join('')}</div>`
        : '<div class="panel"><div class="empty-state"><h3>No call types yet</h3><a class="btn btn-primary" href="#/event-types/new">Create one</a></div></div>'}`;
    },
  });

  // ---------- Event type editor ----------
  const Q_TYPES = { choice: 'Pick one', multi: 'Pick many', text: 'Short text', textarea: 'Long text', date: 'Date', number: 'Number', select: 'Dropdown' };
  const STEP_TYPES = { schedule: 'Pick a time', contact: 'Contact info', questions: 'Questions' };

  A.route('/event-types/:id', {
    title: 'Edit call type',
    async render(p) {
      const d = A.cache.et && A.cache.et.members ? A.cache.et : await api('GET', '/event-types');
      A.cache.et = d;
      const isNew = p.id === 'new';
      const src = isNew ? { name: '', slug: '', description: '', duration_min: 30, location_type: 'phone', location_value: '', buffer_before: 0, buffer_after: 0, min_notice_min: 240, max_days_ahead: 60, slot_interval_min: 30, daily_limit: 0, assignment: 'round_robin', color: '#5b3df5', active: true, hosts: [A.me.user.id], steps: d.default_steps }
        : d.event_types.find((e) => String(e.id) === p.id);
      if (!src) throw new Error('Call type not found');
      const et = (A.editing = JSON.parse(JSON.stringify(src)));
      return `<div class="topbar"><div><a href="#/event-types" class="small">← Booking pages</a><h1 style="margin-top:6px">${isNew ? 'New call type' : esc(et.name)}</h1></div>
        <div class="tools">${!isNew ? '<button class="btn btn-danger btn-sm" data-del>Delete</button>' : ''}<button class="btn btn-primary" data-save>Save</button></div></div>
        <div id="et-err"></div>
        <div class="cols-2"><div class="stack">
          <div class="panel" id="basics"><h2>Basics</h2><p class="desc">What customers see at the top of the page.</p>
            <div class="grid-2">${A.field('Name', A.input('name', et.name, 'placeholder="Discovery call"'))}${A.field('Link', `<div class="copy-row"><span class="small muted" style="white-space:nowrap">/${esc(A.me.business.slug)}/</span>${A.input('slug', et.slug, 'placeholder="auto"')}</div>`)}</div>
            ${A.field('Description', A.textarea('description', et.description, 'rows="2"'))}
            <div class="grid-2">${A.field('Length (minutes)', A.input('duration_min', et.duration_min, 'type="number" min="5" data-type="number"'))}${A.field('Color', A.input('color', et.color, 'type="color" style="height:46px;padding:4px"'))}</div>
            <div class="grid-2">${A.field('Where', A.select('location_type', et.location_type, d.location_types))}${A.field('Location details', A.input('location_value', et.location_value, 'placeholder="Address or meeting link"'), 'Used for in person, Zoom and custom. Google Meet / Teams links are created automatically when a calendar is connected.')}</div>
            ${A.toggle('active', et.active, 'Page is live')}
          </div>
          <div class="panel"><div class="panel-head"><div><h2>Form steps</h2><p class="desc" style="margin:0">Every step autosaves as a lead. Put Contact info early to capture more people who drop off.</p></div>
            <div class="row"><button class="btn btn-ghost btn-sm" data-add-step>+ Questions step</button></div></div><div id="steps" class="stack"></div></div>
        </div><div class="stack">
          <div class="panel" id="limits"><h2>Scheduling rules</h2>
            <div class="grid-2">${A.field('Minimum notice (hours)', `<input class="input" type="number" min="0" step="0.5" id="notice" value="${et.min_notice_min / 60}">`)}${A.field('Book up to (days ahead)', A.input('max_days_ahead', et.max_days_ahead, 'type="number" min="1" data-type="number"'))}</div>
            <div class="grid-2">${A.field('Start times every (min)', A.select('slot_interval_min', et.slot_interval_min, { 10: '10', 15: '15', 20: '20', 30: '30', 45: '45', 60: '60' }))}${A.field('Max per day (0 = no limit)', A.input('daily_limit', et.daily_limit, 'type="number" min="0" data-type="number"'))}</div>
            <div class="grid-2">${A.field('Buffer before (min)', A.input('buffer_before', et.buffer_before, 'type="number" min="0" data-type="number"'))}${A.field('Buffer after (min)', A.input('buffer_after', et.buffer_after, 'type="number" min="0" data-type="number"'))}</div>
          </div>
          <div class="panel" id="hosts"><h2>Who takes these calls</h2><p class="desc">Times show when any selected person is free.</p>
            <div class="stack" style="gap:8px">${d.members.map((m) => `<label class="check" style="font-size:14px"><input type="checkbox" data-host="${m.id}" ${et.hosts.includes(m.id) ? 'checked' : ''}><span><b>${esc(m.name)}</b> <span class="muted">${esc(m.email)}</span></span></label>`).join('')}</div>
            <div style="margin-top:14px">${A.field('When more than one person is free', A.select('assignment', et.assignment, { round_robin: 'Round robin (spread calls evenly)', single: 'Always first person listed' }))}</div>
          </div>
        </div></div>`;
    },
    mount(root, p) {
      const et = A.editing;
      const stepsEl = $('#steps', root);
      function renderSteps() {
        stepsEl.innerHTML = et.steps.map((s, i) => `<div class="step-card" data-si="${i}">
          <div class="step-card-head"><span class="step-num">${i + 1}</span><div style="flex:1"><div class="step-type">${STEP_TYPES[s.type]}</div></div>
            <button class="icon-x" data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-x" data-move="1" title="Move down" ${i === et.steps.length - 1 ? 'disabled' : ''}>↓</button>
            ${s.type === 'questions' ? '<button class="icon-x" data-remove-step title="Remove step">×</button>' : ''}</div>
          <div class="grid-2" style="margin-top:10px">${A.field('Title', `<input class="input" data-sf="title" value="${esc(s.title)}">`)}${A.field('Subtitle', `<input class="input" data-sf="subtitle" value="${esc(s.subtitle || '')}">`)}</div>
          ${s.type === 'contact' ? `<div class="mini-grid">${['first_name', 'last_name', 'phone', 'sms_consent'].map((f) => A.field(A.label(f === 'sms_consent' ? 'SMS consent box' : f), `<select class="select" data-cf="${f}">${['required', 'optional', 'hidden'].filter((o) => f !== 'sms_consent' || o !== 'required').map((o) => `<option ${s.fields[f] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`)).join('')}</div><div class="help">Email is always required.</div>` : ''}
          ${s.type === 'questions' ? `${(s.questions || []).map((q, qi) => `<div class="q-edit" data-qi="${qi}">
              <div class="row between"><b class="small">Question ${qi + 1}</b><button class="icon-x" data-remove-q title="Remove question">×</button></div>
              <div class="grid-2">${A.field('Label', `<input class="input" data-qf="label" value="${esc(q.label)}">`)}${A.field('Type', `<select class="select" data-qf="type">${Object.entries(Q_TYPES).map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}</div>
              ${['choice', 'multi', 'select'].includes(q.type) ? A.field('Options (one per line)', `<textarea class="textarea" rows="3" data-qf="options">${esc((q.options || []).join('\n'))}</textarea>`) : A.field('Placeholder', `<input class="input" data-qf="placeholder" value="${esc(q.placeholder || '')}">`)}
              <div class="row">${A.toggle('_', q.required, 'Required').replace('data-bind="_"', 'data-qf="required"')}${['choice', 'multi'].includes(q.type) ? A.toggle('_', q.display === 'cards', 'Show as cards').replace('data-bind="_"', 'data-qf="display"') : ''}${q.type === 'multi' || q.type === 'choice' ? A.toggle('_', q.use_services, 'Include quote services').replace('data-bind="_"', 'data-qf="use_services"') : ''}</div>
            </div>`).join('')}<button class="btn btn-link btn-sm" data-add-q>+ Add question</button>` : ''}
        </div>`).join('');
      }
      renderSteps();
      stepsEl.addEventListener('input', (e) => {
        const card = e.target.closest('[data-si]'); if (!card) return;
        const s = et.steps[Number(card.dataset.si)];
        if (e.target.dataset.sf) s[e.target.dataset.sf] = e.target.value;
        if (e.target.dataset.cf) s.fields[e.target.dataset.cf] = e.target.value;
        const qe = e.target.closest('[data-qi]');
        if (qe && e.target.dataset.qf) {
          const q = s.questions[Number(qe.dataset.qi)], f = e.target.dataset.qf;
          if (f === 'options') q.options = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean);
          else if (f === 'required' || f === 'use_services') q[f] = e.target.checked;
          else if (f === 'display') q.display = e.target.checked ? 'cards' : 'list';
          else q[f] = e.target.value;
          if (f === 'type') renderSteps();
        }
      });
      stepsEl.addEventListener('change', (e) => { if (e.target.dataset.qf === 'type' || e.target.dataset.cf) stepsEl.dispatchEvent(new Event('input', { bubbles: true })); });
      root.addEventListener('click', async (e) => {
        const card = e.target.closest('[data-si]');
        const i = card ? Number(card.dataset.si) : -1;
        if (e.target.closest('[data-move]')) { const d = Number(e.target.closest('[data-move]').dataset.move); const j = i + d; [et.steps[i], et.steps[j]] = [et.steps[j], et.steps[i]]; renderSteps(); }
        if (e.target.closest('[data-remove-step]') && confirm('Remove this step?')) { et.steps.splice(i, 1); renderSteps(); }
        if (e.target.closest('[data-add-q]')) { et.steps[i].questions.push({ id: '', label: 'New question', type: 'text', options: [], required: false }); renderSteps(); }
        if (e.target.closest('[data-remove-q]')) { et.steps[i].questions.splice(Number(e.target.closest('[data-qi]').dataset.qi), 1); renderSteps(); }
        if (e.target.closest('[data-add-step]')) { et.steps.push({ key: '', type: 'questions', title: 'A few more details', subtitle: '', questions: [{ id: '', label: 'Your question', type: 'text', options: [], required: false }] }); renderSteps(); }
        if (e.target.closest('[data-save]')) {
          const body = Object.assign({}, A.collect($('#basics', root)), A.collect($('#limits', root)), A.collect($('#hosts', root)));
          body.min_notice_min = Math.round(Number($('#notice', root).value || 0) * 60);
          body.hosts = $$('[data-host]', root).filter((x) => x.checked).map((x) => Number(x.dataset.host));
          body.steps = et.steps.map((s) => Object.assign({}, s, { questions: s.questions && s.questions.map((q) => Object.assign({}, q, { id: q.id || q.label })) }));
          try {
            const saved = p.id === 'new' ? await api('POST', '/event-types', body) : await api('PATCH', `/event-types/${p.id}`, body);
            A.cache.et = null; A.toast('Saved');
            if (p.id === 'new') A.go(`#/event-types/${saved.id}`); else A.render();
          } catch (err) { $('#et-err', root).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; A.showErrors(root, err.details); window.scrollTo(0, 0); }
        }
        if (e.target.closest('[data-del]') && confirm('Delete this call type? Existing bookings are kept.')) { await A.guard(() => api('DELETE', `/event-types/${p.id}`), 'Deleted'); A.cache.et = null; A.go('#/event-types'); }
      });
    },
  });

  // ---------- Availability ----------
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  A.route('/availability', {
    title: 'Availability',
    async render(p, q) {
      const d = await api('GET', `/availability${q.user_id ? '?user_id=' + q.user_id : ''}`);
      A.avail = { user: d.user, rules: d.rules, overrides: d.overrides, timezone: d.user.timezone };
      return `<div class="topbar"><div><h1>Availability</h1><div class="sub">When ${d.user.id === A.me.user.id ? 'you are' : esc(d.user.name) + ' is'} open for calls. Busy times on connected calendars are blocked automatically.</div></div>
        <div class="tools">${d.members.length > 1 ? `<select class="select" id="who" style="width:auto">${d.members.map((m) => `<option value="${m.id}" ${m.id === d.user.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}<button class="btn btn-primary" data-save>Save hours</button></div></div>
        <div class="cols-2"><div class="panel"><div class="panel-head"><h2>Weekly hours</h2><div style="min-width:240px">${A.tzSelect('timezone', d.user.timezone)}</div></div><div id="week"></div></div>
        <div class="panel"><h2>Date overrides</h2><p class="desc">Days off, holidays, or special hours for a single date.</p>
          <div class="row" style="margin-bottom:12px"><input class="input" type="date" id="ov-date" style="width:auto"><button class="btn btn-ghost btn-sm" data-ov="off">Mark unavailable</button><button class="btn btn-ghost btn-sm" data-ov="hours">Custom hours</button></div><div id="overrides"></div></div></div>`;
    },
    mount(root) {
      const st = A.avail;
      const who = $('#who', root); if (who) who.addEventListener('change', () => A.go('#/availability?user_id=' + who.value));
      function renderWeek() {
        $('#week', root).innerHTML = [1, 2, 3, 4, 5, 6, 0].map((wd) => {
          const rules = st.rules.map((r, i) => Object.assign({ i }, r)).filter((r) => r.weekday === wd);
          return `<div class="hours-row"><label class="toggle"><input type="checkbox" data-day="${wd}" ${rules.length ? 'checked' : ''}><span class="sw"></span><span>${DAYS[wd].slice(0, 3)}</span></label>
            <div class="hours-intervals">${rules.length ? rules.map((r) => `<div class="interval"><select class="select" data-r="${r.i}" data-k="start_min">${A.timeOptions(r.start_min)}</select><span>–</span><select class="select" data-r="${r.i}" data-k="end_min">${A.timeOptions(r.end_min)}</select><button class="icon-x" data-rm="${r.i}" title="Remove">×</button></div>`).join('')
              + `<div class="row" style="gap:2px"><button class="btn btn-link btn-sm" data-addint="${wd}">+ Add hours</button><button class="btn btn-link btn-sm" data-copyall="${wd}">Copy to all weekdays</button></div>` : '<span class="muted small" style="padding-top:8px">Unavailable</span>'}</div></div>`;
        }).join('');
      }
      function renderOverrides() {
        const el = $('#overrides', root);
        el.innerHTML = st.overrides.length ? st.overrides.map((o, i) => `<div class="interval" style="padding:8px 0;border-bottom:1px solid var(--line)"><b style="min-width:120px">${esc(A.date(o.date))}</b>
          ${o.unavailable ? '<span class="pill lost">Unavailable</span>' : `<select class="select" data-o="${i}" data-k="start_min">${A.timeOptions(o.start_min)}</select><span>–</span><select class="select" data-o="${i}" data-k="end_min">${A.timeOptions(o.end_min)}</select>`}
          <button class="icon-x" data-orm="${i}" style="margin-left:auto">×</button></div>`).join('') : '<p class="muted small">No overrides.</p>';
      }
      renderWeek(); renderOverrides();
      root.addEventListener('change', (e) => {
        const t = e.target;
        if (t.dataset.day !== undefined) { const wd = Number(t.dataset.day); if (t.checked) st.rules.push({ weekday: wd, start_min: 540, end_min: 1020 }); else st.rules = st.rules.filter((r) => r.weekday !== wd); renderWeek(); }
        if (t.dataset.r !== undefined) st.rules[Number(t.dataset.r)][t.dataset.k] = Number(t.value);
        if (t.dataset.o !== undefined) st.overrides[Number(t.dataset.o)][t.dataset.k] = Number(t.value);
        if (t.name === 'timezone') st.timezone = t.value;
      });
      root.addEventListener('click', async (e) => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.rm !== undefined) { st.rules.splice(Number(t.dataset.rm), 1); renderWeek(); }
        if (t.dataset.addint !== undefined) { const wd = Number(t.dataset.addint); const last = st.rules.filter((r) => r.weekday === wd).sort((a, b) => b.end_min - a.end_min)[0]; const s = Math.min(1380, last ? last.end_min + 60 : 540); st.rules.push({ weekday: wd, start_min: s, end_min: Math.min(1440, s + 120) }); renderWeek(); }
        if (t.dataset.copyall !== undefined) { const wd = Number(t.dataset.copyall); const src = st.rules.filter((r) => r.weekday === wd); st.rules = st.rules.filter((r) => r.weekday === wd || r.weekday === 0 || r.weekday === 6); for (const d of [1, 2, 3, 4, 5]) if (d !== wd) src.forEach((r) => st.rules.push({ weekday: d, start_min: r.start_min, end_min: r.end_min })); renderWeek(); }
        if (t.dataset.ov) { const date = $('#ov-date', root).value; if (!date) return A.toast('Pick a date first', true); st.overrides = st.overrides.filter((o) => o.date !== date || t.dataset.ov === 'hours'); st.overrides.push({ date, unavailable: t.dataset.ov === 'off', start_min: 540, end_min: 1020 }); st.overrides.sort((a, b) => a.date.localeCompare(b.date)); renderOverrides(); }
        if (t.dataset.orm !== undefined) { st.overrides.splice(Number(t.dataset.orm), 1); renderOverrides(); }
        if (t.hasAttribute('data-save')) {
          if (st.rules.some((r) => r.end_min <= r.start_min)) return A.toast('Each time range must end after it starts', true);
          await A.guard(() => api('PUT', '/availability', { user_id: st.user.id, timezone: st.timezone, rules: st.rules, overrides: st.overrides }), 'Hours saved');
          if (st.user.id === A.me.user.id) A.me = await api('GET', '/auth/me');
        }
      });
    },
  });

  // ---------- Calendars ----------
  A.route('/calendars', {
    title: 'Calendars',
    async render(p, q) {
      const d = await api('GET', '/calendars');
      if (q.connected) setTimeout(() => A.toast(`Connected ${q.connected}`), 50);
      if (q.error) setTimeout(() => A.toast(q.error, true), 50);
      const envNames = { google: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET', microsoft: 'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET' };
      return `<div class="topbar"><div><h1>Calendars</h1><div class="sub">Connect your calendar so busy times block bookings and new calls land on your calendar.</div></div></div>
        <div class="cols-even">${Object.entries(d.providers).map(([k, pr]) => `<div class="panel"><h2>${esc(pr.label)}</h2>
          ${pr.configured ? `<p class="desc">Checks your busy times and adds new bookings${k === 'google' ? ' with a Google Meet link' : ' with a Teams link'} when the call type uses it.</p><a class="btn btn-primary" href="/oauth/${k}/start">Connect ${esc(pr.label)}</a>`
            : `<div class="warn-box">Not set up on the server yet. Your admin needs to add ${envNames[k]} as environment variables.<div class="small" style="margin-top:8px">Redirect URI to register: <code>${esc(pr.redirect_uri)}</code></div></div>`}</div>`).join('')}</div>
        <div class="panel"><h2>Your connections</h2>${d.connections.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Account</th><th>Check for conflicts</th><th>Add new bookings here</th><th></th></tr></thead><tbody>
          ${d.connections.map((c) => `<tr><td><b>${esc(c.account_email || c.provider)}</b><div class="small muted">${esc(d.providers[c.provider].label)}</div>${c.last_error ? `<div class="small" style="color:var(--err)">${esc(c.last_error)}</div>` : ''}</td>
            <td>${A.toggle('_', c.check_busy, '').replace('data-bind="_"', `data-conn="${c.id}" data-k="check_busy"`)}</td><td>${A.toggle('_', c.write_events, '').replace('data-bind="_"', `data-conn="${c.id}" data-k="write_events"`)}</td>
            <td class="num"><button class="btn btn-danger btn-sm" data-disconnect="${c.id}">Disconnect</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No calendars connected. Until you connect one, only your weekly hours and existing bookings are used.</p>'}</div>`;
    },
    mount(root) {
      if (location.hash.includes('?')) history.replaceState(null, '', '#/calendars');
      root.addEventListener('change', async (e) => { const c = e.target.dataset.conn; if (c) { await A.guard(() => api('PATCH', `/calendars/${c}`, { [e.target.dataset.k]: e.target.checked }), 'Updated'); A.render(); } });
      root.addEventListener('click', async (e) => { const c = e.target.closest('[data-disconnect]'); if (c && confirm('Disconnect this calendar?')) { await A.guard(() => api('DELETE', `/calendars/${c.dataset.disconnect}`), 'Disconnected'); A.render(); } });
    },
  });

  // ---------- Share & embed ----------
  A.route('/share', {
    title: 'Share & embed',
    async render(p, q) {
      const [d, team, services] = await Promise.all([api('GET', '/event-types'), api('GET', '/team'), api('GET', '/services')]);
      const me = team.find((m) => m.id === A.me.user.id) || {};
      const b = A.me.business, url = base();
      const link = (label, path) => `<div class="field"><label>${esc(label)}</label><div class="copy-row"><input class="input" readonly value="${esc(url + path)}"><button class="btn btn-ghost btn-sm" data-copy="${esc(url + path)}">Copy</button><a class="btn btn-ghost btn-sm" href="${esc(path)}" target="_blank">Open</a></div></div>`;
      const inline = `<div data-booklane="b/${b.slug}"></div>\n<script src="${url}/embed.js" async></script>`;
      const popup = `<button data-booklane-popup="b/${b.slug}/quote">Build your quote</button>\n<script src="${url}/embed.js" async></script>`;
      const checklist = [
        [me.has_hours, 'Set your weekly hours', '#/availability'],
        [(me.calendars || []).length > 0, 'Connect Google or Outlook calendar', '#/calendars'],
        [services.length > 0, 'Add services and prices to your quote catalog', '#/catalog'],
        [team.length > 1, 'Invite your team', '#/team'],
      ];
      return `<div class="topbar"><div><h1>${q.welcome ? 'You are live!' : 'Share & embed'}</h1><div class="sub">Send these links anywhere, or drop the booking flow into your website.</div></div></div>
        ${q.welcome || checklist.some((c) => !c[0]) ? `<div class="panel"><h2>Finish setting up</h2><div class="stack" style="gap:8px;margin-top:12px">${checklist.map(([done, label, href]) => `<a href="${href}" class="row" style="text-decoration:none;color:inherit"><span class="pill ${done ? 'booked' : 'partial'}">${done ? 'Done' : 'To do'}</span><b>${esc(label)}</b></a>`).join('')}</div></div>` : ''}
        <div class="cols-even"><div class="panel"><h2>Links</h2><p class="desc">Your main page lets people choose between booking a call and building a quote.</p>
          ${link('Main page', `/b/${b.slug}`)}${link('Quote builder', `/b/${b.slug}/quote`)}${d.event_types.filter((e) => e.active).map((e) => link(e.name, `/b/${b.slug}/${e.slug}`)).join('')}
          <p class="help">Tip: add <code>?utm_source=instagram</code> to any link and it shows on the lead.</p></div>
        <div class="panel"><h2>Embed on your website</h2><p class="desc">Paste into a Custom HTML / code block (WordPress, Avada, Squarespace, Wix). The frame resizes itself.</p>
          <div class="field"><label>Inline (main page)</label><div class="code">${esc(inline)}</div><button class="btn btn-ghost btn-sm" style="align-self:flex-start" data-copy="${esc(inline)}">Copy code</button></div>
          <div class="field"><label>Popup button (quote builder)</label><div class="code">${esc(popup)}</div><button class="btn btn-ghost btn-sm" style="align-self:flex-start" data-copy="${esc(popup)}">Copy code</button></div>
          <p class="help">Swap the path for any link above, e.g. <code>b/${esc(b.slug)}/${esc((d.event_types[0] || {}).slug || 'discovery-call')}</code>.</p></div></div>`;
    },
  });
})();
