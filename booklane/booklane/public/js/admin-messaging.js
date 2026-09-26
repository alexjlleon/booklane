/* Admin: scheduled emails and texts around a booking */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const CHANNELS = { email: 'Email only', sms: 'Text only', both: 'Email and text' };
  const KINDS = { transactional: 'About their appointment', marketing: 'Promotional' };
  const stat = (k, v, s, color) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${esc(String(v))}</div><div class="s">${s}</div></div>`;

  // Minutes <-> a friendly number + unit, so nobody has to type 4320.
  const UNITS = { minutes: 1, hours: 60, days: 1440 };
  function splitOffset(mins) {
    const m = Math.max(0, Number(mins) || 0);
    if (m === 0) return { n: 0, unit: 'hours' };
    if (m % 1440 === 0) return { n: m / 1440, unit: 'days' };
    if (m % 60 === 0) return { n: m / 60, unit: 'hours' };
    return { n: m, unit: 'minutes' };
  }

  A.route('/automations', {
    title: 'Automations',
    async render() {
      const d = await api('GET', '/automations');
      A.cache.auto = d;
      const s = d.summary;

      const smsBanner = d.sms.ready ? '' : `<div class="panel warn-box"><h2>Texting is not connected yet</h2>
        <p class="desc">Automations can still send emails. Texts need Twilio credentials in Railway: <b>${d.sms.needs.map(esc).join('</b>, <b>')}</b>.</p>
        <div class="small">Once the number exists, point its <b>A messaging comes in</b> webhook at <code class="code">${esc(d.sms.inbound_url)}</code> <button type="button" class="btn btn-link btn-sm" data-copy="${esc(d.sms.inbound_url)}">Copy</button> so replies and STOP requests reach us.</div></div>`;

      return `${smsBanner}
      <div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Automations</h1><div class="small muted" style="margin-top:2px">Emails and texts that go out on their own, before and after each booking.</div></div>
        <div class="row"><a class="btn btn-ghost" href="#/messages">View the queue</a><button type="button" class="btn btn-primary" data-new>New automation</button></div>
      </div>

      <div class="stats">
        ${stat('Waiting to send', s.queued, 'scheduled and not yet due')}
        ${stat('Sent this week', s.sent_7d, `${s.sms_segments_7d} text segment${s.sms_segments_7d === 1 ? '' : 's'}`)}
        ${stat('Failed', s.failed, s.failed ? '<a href="#/messages?status=failed">Look at these</a>' : 'nothing stuck', s.failed ? '#c0392b' : undefined)}
        ${stat('Opted out of texts', s.optouts, 'replied STOP')}
      </div>

      <div class="panel">
        <div class="panel-head"><div><h2>Your automations</h2><p class="desc" style="margin:0">Texts are held until ${s.quiet_hours.to}am in the customer's own timezone.</p></div></div>
        ${d.automations.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Goes out</th><th>Channel</th><th>Applies to</th><th class="num">Sent</th><th></th></tr></thead><tbody>
          ${d.automations.map((a) => `<tr${a.active ? '' : ' style="opacity:.55"'}>
            <td><b>${esc(a.name)}</b>${a.active ? '' : ' <span class="pill lost">Off</span>'}${a.kind === 'marketing' ? ' <span class="pill quoted">Promotional</span>' : ''}
              ${a.subject ? `<div class="small muted">${esc(a.subject)}</div>` : ''}</td>
            <td class="small">${esc(a.timing)}</td>
            <td class="small">${esc(CHANNELS[a.channel] || a.channel)}</td>
            <td class="small">${describeScope(a, d)}</td>
            <td class="num">${a.sent || ''}${a.failed ? ` <span style="color:#c0392b">(${a.failed} failed)</span>` : ''}</td>
            <td class="num"><button type="button" class="btn btn-ghost btn-sm" data-edit="${a.id}">Edit</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : `<div class="empty-state"><h3>Nothing scheduled yet</h3>
          <p>Add a reminder before the appointment, a thank-you after it, or a nudge for consults that did not book. You write the words; the timing and conditions are set here.</p>
          <button type="button" class="btn btn-primary" data-new>Write your first one</button></div>`}
      </div>`;
    },
    mount(root) {
      root.addEventListener('click', (e) => {
        if (e.target.closest('[data-new]')) return editAutomation(null);
        const ed = e.target.closest('[data-edit]');
        if (ed) return editAutomation((A.cache.auto.automations || []).find((a) => a.id === Number(ed.dataset.edit)));
      });
    },
  });

  function describeScope(a, d) {
    const bits = [];
    if (a.event_type_ids.length) bits.push(a.event_type_ids.map((id) => esc((d.event_types.find((e) => e.id === id) || {}).name || '?')).join(', '));
    if (a.calendar_ids.length) bits.push(a.calendar_ids.map((id) => esc((d.calendars.find((c) => c.id === id) || {}).name || '?')).join(', '));
    if (a.service_match.length) bits.push(`interested in ${a.match_mode === 'all' ? 'all of' : ''} ${a.service_match.map(esc).join(', ')}`);
    if (a.skip_if_rebooked) bits.push('unless they rebooked');
    return bits.length ? bits.join(' · ') : '<span class="muted">everything</span>';
  }

  // ------------------------------------------------------------ editor
  function editAutomation(a) {
    const d = A.cache.auto || { event_types: [], calendars: [], services: [], variables: [], triggers: {}, sms: {} };
    const off = splitOffset(a ? a.offset_min : 1440);
    const chosenEt = new Set(a ? a.event_type_ids : []);
    const chosenCal = new Set(a ? a.calendar_ids : []);

    const varList = d.variables.map(([name, help]) =>
      `<button type="button" class="btn btn-ghost btn-sm" data-var="{{${name}}}" title="${esc(help)}">${esc(name)}</button>`).join(' ');

    A.drawer(`<div class="drawer-head"><div><div class="small muted">Automation</div><h2>${a ? esc(a.name) : 'New automation'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
    <form id="auto-form">
      <div class="panel stack">
        ${A.field('Name', A.input('name', a ? a.name : ''), 'Just for you, e.g. "Morning-of text"')}
        <div class="cols-even">
          ${A.field('When', A.select('trigger', a ? a.trigger : 'before', d.triggers))}
          ${A.field('Channel', A.select('channel', a ? a.channel : 'email', CHANNELS))}
        </div>
        <div class="field"><label>How long</label>
          <div class="row" style="gap:8px">
            <input class="input" style="max-width:110px" data-bind="offset_n" data-type="number" type="number" min="0" value="${off.n}">
            <select class="select" style="max-width:150px" data-bind="offset_unit">${Object.keys(UNITS).map((u) => `<option value="${u}" ${u === off.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
            <span class="small muted" id="timing-echo"></span>
          </div>
          <div class="help">Set 0 to send as soon as it is triggered.</div>
        </div>
        ${A.field('Kind', A.select('kind', a ? a.kind : 'transactional', KINDS), 'Promotional messages are the ones people complain about. Keep reminders and directions marked as being about their appointment.')}
      </div>

      <div class="panel stack">
        <h2>Who gets it</h2>
        <p class="desc" style="margin:0">Leave everything unticked to send for every booking.</p>
        <div class="field"><label>Only these consultation types</label>
          <div class="stack" style="gap:6px;max-height:190px;overflow:auto">${d.event_types.map((e) => `<label class="check"><input type="checkbox" data-et="${e.id}" ${chosenEt.has(e.id) ? 'checked' : ''}><span>${esc(e.name)}${e.kind === 'session' ? ' <span class="small muted">(session)</span>' : ''}</span></label>`).join('') || '<span class="muted small">None set up yet.</span>'}</div>
        </div>
        <div class="field"><label>Only these calendars or markets</label>
          <div class="stack" style="gap:6px;max-height:160px;overflow:auto">${d.calendars.map((c) => `<label class="check"><input type="checkbox" data-cal="${c.id}" ${chosenCal.has(c.id) ? 'checked' : ''}><span>${esc(c.name)}</span></label>`).join('') || '<span class="muted small">None set up yet.</span>'}</div>
        </div>
        ${A.field('Only if interested in these services', A.textarea('service_match', (a ? a.service_match : []).join('\n'), 'rows="3" data-type="lines"'),
    `One per line. Matches loosely, so "photo booth" catches "Photo Booth (3 hours)".${d.services.length ? ` You have: ${d.services.slice(0, 8).map(esc).join(', ')}${d.services.length > 8 ? '…' : ''}` : ''}`)}
        ${A.field('Match', A.select('match_mode', a ? a.match_mode : 'any', { any: 'Any one of them is enough', all: 'They must want all of them' }))}
        ${A.toggle('skip_if_rebooked', a ? a.skip_if_rebooked : false, 'Skip if they have already booked something else since')}
      </div>

      <div class="panel stack">
        <div class="row between"><h2>What it says</h2><div class="small muted">Click to insert: ${varList}</div></div>
        <div id="email-fields" class="stack">
          ${A.field('Subject', A.input('subject', a ? (a.subject || '') : ''))}
          ${A.field('Email', A.textarea('body_html', a ? (a.body_html || '') : '', 'rows="8"'), 'Plain paragraphs are fine — blank lines become paragraphs and it is wrapped in your branding automatically.')}
        </div>
        <div id="sms-fields" class="stack">
          ${A.field('Text message', A.textarea('sms_body', a ? (a.sms_body || '') : '', 'rows="4"'), '<span id="seg-echo"></span>')}
        </div>
      </div>

      <div class="panel stack">
        <div class="row between"><h2>Preview</h2><button type="button" class="btn btn-ghost btn-sm" data-preview>Refresh preview</button></div>
        <div id="preview-out"><span class="muted small">Press refresh to see this filled in with real booking details.</span></div>
        <hr>
        <div class="row" style="gap:8px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><label>Send a test to</label><input class="input" id="test-to" placeholder="you@example.com or your mobile"></div>
          <button type="button" class="btn btn-ghost" data-test="email">Test email</button>
          <button type="button" class="btn btn-ghost" data-test="sms" ${d.sms.ready ? '' : 'disabled title="Texting is not connected yet"'}>Test text</button>
        </div>
      </div>

      <div class="panel stack">
        ${A.toggle('active', a ? a.active : false, 'Switched on — send this automatically')}
        <div class="small muted">Changing the timing or conditions drops anything already queued for this automation. Bookings made afterwards use the new version.</div>
      </div>

      <div class="row between" style="margin-top:16px">
        ${a ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
        <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
        <button type="submit" class="btn btn-primary">${a ? 'Save' : 'Create'}</button></div>
      </div>
    </form>`, (el) => {
      const collect = () => {
        const body = A.collect(el);
        body.offset_min = Math.round((Number(body.offset_n) || 0) * (UNITS[body.offset_unit] || 1));
        delete body.offset_n; delete body.offset_unit;
        body.event_type_ids = $$('[data-et]', el).filter((x) => x.checked).map((x) => Number(x.dataset.et));
        body.calendar_ids = $$('[data-cal]', el).filter((x) => x.checked).map((x) => Number(x.dataset.cal));
        return body;
      };

      // Show only the fields the chosen channel actually uses.
      const syncChannel = () => {
        const ch = el.querySelector('[data-bind="channel"]').value;
        $('#email-fields', el).style.display = ch === 'sms' ? 'none' : '';
        $('#sms-fields', el).style.display = ch === 'email' ? 'none' : '';
      };
      const syncTiming = () => {
        const b = collect();
        $('#timing-echo', el).textContent = describeLocal(b.trigger, b.offset_min);
      };
      const syncSeg = () => {
        const text = el.querySelector('[data-bind="sms_body"]').value || '';
        const box = $('#seg-echo', el);
        if (!text.trim()) { box.textContent = 'Merge fields change the final length, so the preview count is the one to trust.'; return; }
        const rough = text.length;
        box.innerHTML = `About ${rough} characters before merge fields are filled in. ${/[^\u0000-\u007F]/.test(text) ? '<b>Contains a special character</b>, which halves how much fits per segment — straight quotes and no emoji keep it cheaper.' : ''}`;
      };
      el.addEventListener('change', (ev) => { if (ev.target.matches('[data-bind="channel"]')) syncChannel(); syncTiming(); });
      el.addEventListener('input', (ev) => { if (ev.target.matches('[data-bind="sms_body"]')) syncSeg(); if (ev.target.matches('[data-bind="offset_n"]')) syncTiming(); });
      syncChannel(); syncTiming(); syncSeg();

      // Clicking a merge field drops it where the cursor was.
      el.addEventListener('click', (ev) => {
        const v = ev.target.closest('[data-var]');
        if (!v) return;
        ev.preventDefault();
        const target = el.querySelector('textarea:focus, input[data-bind="subject"]:focus') || el.querySelector('[data-bind="body_html"]');
        if (!target) return;
        const at = target.selectionStart ?? target.value.length;
        target.value = target.value.slice(0, at) + v.dataset.var + target.value.slice(target.selectionEnd ?? at);
        target.focus();
        target.selectionStart = target.selectionEnd = at + v.dataset.var.length;
        syncSeg();
      });

      $('[data-preview]', el).addEventListener('click', async () => {
        const out = $('#preview-out', el);
        out.innerHTML = '<span class="spinner"></span>';
        try {
          const p = await api('POST', '/automations/preview', { ...collect(), id: a ? a.id : undefined });
          out.innerHTML = `
            ${p.unknown_variables.length ? `<div class="warn-box panel" style="padding:12px;margin:0 0 12px"><b>Check your spelling.</b> These are not real fields and will come out blank: ${p.unknown_variables.map((x) => `<code class="code">{{${esc(x)}}}</code>`).join(' ')}</div>` : ''}
            <div class="small muted" style="margin-bottom:8px">Filled in with ${esc(p.using)} · goes out ${esc(p.due_example)}</div>
            ${p.email_html ? `<div class="small muted">Subject: <b>${esc(p.subject)}</b></div>
              <iframe style="width:100%;height:340px;border:1px solid var(--line);border-radius:12px;background:#fff;margin-top:6px" sandbox srcdoc="${esc(p.email_html)}"></iframe>` : ''}
            ${p.sms_text ? `<div style="margin-top:12px"><div class="small muted">Text message</div>
              <div class="panel" style="padding:12px;white-space:pre-wrap;background:#eef6ff;border-color:#cfe2f7">${esc(p.sms_text)}</div>
              <div class="small muted" style="margin-top:4px">${p.sms.characters} characters · ${p.sms.encoding} · <b>${p.sms.segments} segment${p.sms.segments === 1 ? '' : 's'}</b>${p.sms.segments > 1 ? ' — you are billed per segment' : ''}</div></div>` : ''}`;
        } catch (e) { out.innerHTML = `<div class="small" style="color:#c0392b">${esc(e.message)}</div>`; }
      });

      $$('[data-test]', el).forEach((btn) => btn.addEventListener('click', async () => {
        const channel = btn.dataset.test;
        const to = $('#test-to', el).value.trim();
        if (!to) return A.toast('Enter where to send the test first', true);
        btn.disabled = true;
        try {
          const r = await A.guard(() => api('POST', '/automations/test', { ...collect(), id: a ? a.id : undefined, channel, to }), null);
          A.toast(`Test ${channel === 'sms' ? 'text' : 'email'} sent to ${r.to}`);
        } catch (e) { /* toast already shown */ } finally { btn.disabled = false; }
      }));

      $('#auto-form', el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        let body;
        try { body = collect(); } catch (err) { return A.toast(err.message, true); }
        try {
          const saved = await A.guard(() => (a ? api('PATCH', `/automations/${a.id}`, body) : api('POST', '/automations', body)), a ? 'Saved' : 'Automation created');
          if (saved && saved.requeued_note) A.toast(saved.requeued_note);
          A.closeDrawer(); A.render();
        } catch (err) { A.showErrors(el, err.details); }
      });

      const del = $('[data-del]', el);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${a.name}"? Anything already queued for it is dropped.`)) return;
        try { await A.guard(() => api('DELETE', `/automations/${a.id}`), 'Deleted'); A.closeDrawer(); A.render(); } catch (e) { /* toast shown */ }
      });
    });
  }

  function describeLocal(trigger, mins) {
    const m = Math.max(0, mins || 0);
    const human = m === 0 ? 'straight away' : m % 1440 === 0 ? `${m / 1440} day${m / 1440 === 1 ? '' : 's'}` : m % 60 === 0 ? `${m / 60} hour${m / 60 === 1 ? '' : 's'}` : `${m} minutes`;
    if (trigger === 'before') return `→ ${human} before the appointment`;
    if (trigger === 'after') return `→ ${human} after the appointment`;
    if (trigger === 'booked') return m ? `→ ${human} after they book` : '→ the moment they book';
    if (trigger === 'cancelled') return m ? `→ ${human} after it is cancelled` : '→ when it is cancelled';
    return m ? `→ ${human} after it moves` : '→ when it moves';
  }

  // ------------------------------------------------------------ the queue
  const STATUS = { '': 'All', queued: 'Waiting', sent: 'Sent', failed: 'Failed', skipped: 'Skipped', cancelled: 'Cancelled' };

  A.route('/messages', {
    title: 'Message queue',
    async render(params, query) {
      const q = new URLSearchParams();
      if (query.status) q.set('status', query.status);
      const d = await api('GET', `/messages?${q}`);
      const s = d.summary;
      return `<div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Message queue</h1><div class="small muted" style="margin-top:2px">Everything scheduled, sent, or held back — and why.</div></div>
        <div class="row"><a class="btn btn-ghost" href="#/automations">Automations</a><button type="button" class="btn btn-ghost" data-run>Send what is due now</button></div>
      </div>

      <div class="stats">
        ${stat('Waiting', s.queued, 'not yet due')}
        ${stat('Sent this week', s.sent_7d, `${s.sms_segments_7d} text segment${s.sms_segments_7d === 1 ? '' : 's'}`)}
        ${stat('Failed', s.failed, s.failed ? 'gave up after retrying' : 'nothing stuck', s.failed ? '#c0392b' : undefined)}
        ${stat('Opted out', s.optouts, 'replied STOP')}
      </div>

      <div class="panel">
        <div class="panel-head"><div class="tabs">${Object.entries(STATUS).map(([k, v]) => `<a href="#/messages${k ? `?status=${k}` : ''}" class="${(query.status || '') === k ? 'active' : ''}">${esc(v)}</a>`).join('')}</div></div>
        ${d.rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Due</th><th>Automation</th><th>To</th><th>Customer</th><th>Channel</th><th>Status</th><th></th></tr></thead><tbody>
          ${d.rows.map((r) => `<tr>
            <td class="small ${r.status === 'queued' ? '' : 'muted'}">${esc(A.dt(r.due, { weekday: 'short' }))}</td>
            <td class="small">${esc(r.automation || '—')}${r.subject ? `<div class="small muted">${esc(r.subject)}</div>` : ''}</td>
            <td class="small">${esc(r.to)}</td>
            <td class="small">${esc(r.customer || '—')}${r.booking_token ? ` <a href="/booking/${esc(r.booking_token)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
            <td class="small">${r.channel === 'sms' ? 'Text' : 'Email'}</td>
            <td>${A.pill(r.status)}${r.error ? `<div class="small" style="color:#c0392b;max-width:240px">${esc(r.error)}</div>` : ''}${r.skip_reason ? `<div class="small muted" style="max-width:240px">${esc(r.skip_reason)}</div>` : ''}</td>
            <td class="num">${r.status === 'queued' ? `<button type="button" class="btn btn-ghost btn-sm" data-cancel="${r.id}">Cancel</button>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty-state"><h3>Nothing here</h3><p>Messages appear as soon as an automation is switched on and someone books.</p></div>'}
      </div>`;
    },
    mount(root) {
      root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-run]')) {
          const r = await A.guard(() => api('POST', '/messages/run', {}), null);
          A.toast(`Sent ${r.sent}, skipped ${r.skipped}, failed ${r.failed}`);
          return A.render();
        }
        const c = e.target.closest('[data-cancel]');
        if (c && confirm('Cancel this message so it never goes out?')) {
          await A.guard(() => api('POST', `/messages/${c.dataset.cancel}/cancel`, {}), 'Cancelled');
          A.render();
        }
      });
    },
  });
})();
