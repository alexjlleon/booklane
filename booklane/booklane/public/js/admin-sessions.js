/* Admin: sellable sessions, the calendars behind them, and the money that came in */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const KINDS = { market: 'Market', person: 'Person' };
  const dollars = (cents) => (Number(cents || 0) / 100).toFixed(2);
  const stat = (k, v, s, color) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${esc(String(v))}</div><div class="s">${s}</div></div>`;

  function payBanner(pay) {
    if (!pay) return '';
    if (pay.configured && pay.webhook_secret_set) return '';
    const url = `<code class="code">${esc(pay.webhook_url)}</code> <button type="button" class="btn btn-link btn-sm" data-copy="${esc(pay.webhook_url)}">Copy</button>`;
    if (!pay.configured) {
      return `<div class="panel warn-box"><h2>Card payments are off</h2>
        <p class="desc">Sessions with a price cannot be bought until <b>STRIPE_SECRET_KEY</b> and <b>STRIPE_WEBHOOK_SECRET</b> are set. Add them under <a href="#/settings/integrations">Settings &rarr; Integrations</a>. People who already paid can still book with their booking number in the meantime.</p>
        <div class="small">In Stripe, add a webhook pointing at ${url} and subscribe it to <b>checkout.session.completed</b>, <b>checkout.session.expired</b> and <b>charge.refunded</b>.</div></div>`;
    }
    return `<div class="panel warn-box"><h2>One step left</h2>
      <p class="desc">Stripe can take payments, but <b>STRIPE_WEBHOOK_SECRET</b> is not set, so we never hear back that someone paid and the booking would not be created.</p>
      <div class="small">Add a webhook in Stripe pointing at ${url}, then paste its signing secret under <a href="#/settings/integrations">Settings &rarr; Integrations</a>.</div></div>`;
  }

  // ---------------- Sessions & markets ----------------
  A.route('/sessions', {
    title: 'Sessions',
    async render() {
      const [data, pay, cals] = await Promise.all([
        api('GET', '/sessions'),
        api('GET', '/payments').catch(() => null),
        api('GET', '/session-calendars').catch(() => []),
      ]);
      A.cache.sessions = data;
      A.cache.calendars = cals;
      const s = data.summary;

      if (!data.sessions.length && !cals.length) {
        return `${payBanner(pay)}<div class="panel"><div class="empty-state">
          <h3>No sessions yet</h3>
          <p>Set up your five markets and the sessions people can buy: engagement, bridal, boudoir and anniversary, plus album design on the designer's own calendar.</p>
          <button type="button" class="btn btn-primary" data-seed>Set up markets and sessions</button>
        </div></div>`;
      }

      const mode = pay && pay.configured ? `<span class="pill ${pay.mode === 'live' ? 'booked' : 'partial'}">Stripe ${esc(pay.mode)} mode</span>` : '<span class="pill lost">No card payments</span>';

      return `${payBanner(pay)}
      <div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Sessions &amp; markets</h1><div class="small muted" style="margin-top:2px">Sessions people buy and book themselves. ${mode}</div></div>
        <div class="row"><button type="button" class="btn btn-ghost" data-new-cal>Add a calendar</button><button type="button" class="btn btn-primary" data-new-session>New session</button></div>
      </div>

      <div class="stats">
        ${stat('Paid, last 30 days', A.money(s.paid_total), `${s.paid_count} order${s.paid_count === 1 ? '' : 's'} · <a href="#/orders?status=paid">View</a>`)}
        ${stat('Already booked', s.already_booked, 'came in with a booking number')}
        ${stat('Mid-checkout', s.pending, 'holding a slot right now')}
        ${stat('Needs attention', s.paid_but_unbooked, s.paid_but_unbooked ? '<a href="#/orders?status=paid">paid but not on a calendar</a>' : 'nothing stuck', s.paid_but_unbooked ? '#c0392b' : undefined)}
      </div>

      <div class="panel">
        <div class="panel-head"><div><h2>Sessions</h2><p class="desc" style="margin:0">Each one has its own price, length and calendars.</p></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Session</th><th>Price</th><th>Length</th><th>Offered on</th><th class="num">Sold</th><th></th></tr></thead><tbody>
        ${data.sessions.map((x) => `<tr${x.active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(x.name)}</b>${x.active ? '' : ' <span class="pill lost">Off</span>'}<div class="small muted">/s/${esc(x.slug)}</div></td>
          <td>${x.price_cents ? esc(A.money(x.price, x.currency)) : '<span class="muted small">not priced yet</span>'}</td>
          <td>${x.duration_min} min</td>
          <td class="small">${x.calendar_ids.length ? x.calendar_ids.map((id) => esc((data.calendars.find((c) => c.id === id) || {}).name || '?')).join(', ') : '<span class="pill partial">none yet</span>'}</td>
          <td class="num">${x.sold || ''}</td>
          <td class="num"><a class="btn btn-ghost btn-sm" href="${esc(x.public_url)}" target="_blank" rel="noopener">View</a>
            <button type="button" class="btn btn-ghost btn-sm" data-edit-session="${x.id}">Edit</button></td>
        </tr>`).join('')}
        </tbody></table></div>
      </div>

      <div class="panel">
        <div class="panel-head"><div><h2>Calendars</h2><p class="desc" style="margin:0">A market or a person. Each keeps its own hours and can have its own Google or Outlook calendar.</p></div></div>
        <div class="table-wrap"><table class="t"><thead><tr><th>Calendar</th><th>Type</th><th>Time zone</th><th>Hours</th><th>Connected</th><th class="num">Upcoming</th><th></th></tr></thead><tbody>
        ${cals.length ? cals.map((c) => `<tr${c.active ? '' : ' style="opacity:.55"'}>
          <td><b>${esc(c.name)}</b>${c.active ? '' : ' <span class="pill lost">Off</span>'}${c.blurb ? `<div class="small muted">${esc(c.blurb)}</div>` : ''}</td>
          <td class="small">${esc(KINDS[c.kind] || c.kind)}</td>
          <td class="small muted">${esc(c.timezone || '')}</td>
          <td>${c.has_hours ? '<span class="pill booked">Set</span>' : '<span class="pill partial">Not set</span>'}</td>
          <td class="small">${c.connections.length
    ? c.connections.map((x) => `<div><b>${esc(x.account_email || x.provider)}</b>${x.last_error ? ` <span style="color:var(--err)">${esc(x.last_error)}</span>` : ''}
        <button type="button" class="icon-x" data-drop-conn="${c.id}:${x.id}" title="Disconnect">&times;</button></div>`).join('')
    : `<span class="muted">—</span>`}
    ${A.me.app && A.me.app.calendars ? Object.entries(A.me.app.calendars).filter(([, pr]) => pr.configured)
    .map(([k, pr]) => `<a class="btn btn-link btn-sm" href="/oauth/${k}/start?calendar=${c.id}">+ ${esc(pr.label)}</a>`).join(' ') : ''}</td>
          <td class="num">${c.upcoming || ''}</td>
          <td class="num"><a class="btn btn-ghost btn-sm" href="#/availability?user_id=${c.user_id}">Hours</a>
            <button type="button" class="btn btn-ghost btn-sm" data-edit-cal="${c.id}">Edit</button></td>
        </tr>`).join('') : '<tr><td colspan="7" class="muted">No calendars yet. Add one, or <button type="button" class="btn btn-link btn-sm" data-seed>set up the five markets</button>.</td></tr>'}
        </tbody></table></div>
      </div>`;
    },
    mount(root) {
      root.addEventListener('click', async (e) => {
        const drop = e.target.closest('[data-drop-conn]');
        if (drop && confirm('Disconnect this calendar from the market?\n\nIts hours stay as they are; only the conflict checking stops.')) {
          const [calId, connId] = drop.dataset.dropConn.split(':');
          await A.guard(() => api('DELETE', `/session-calendars/${calId}/connection/${connId}`), 'Disconnected');
          return A.render();
        }
        if (e.target.closest('[data-seed]')) {
          const r = await A.guard(() => api('POST', '/sessions/seed', {}), 'Markets and sessions created');
          if (r && !r.calendars.length && !r.products.length) A.toast('Everything was already set up');
          return A.render();
        }
        if (e.target.closest('[data-new-session]')) return editSession(null);
        if (e.target.closest('[data-new-cal]')) return editCalendar(null);
        const es = e.target.closest('[data-edit-session]');
        if (es) return editSession(((A.cache.sessions || {}).sessions || []).find((x) => x.id === Number(es.dataset.editSession)));
        const ec = e.target.closest('[data-edit-cal]');
        if (ec) return editCalendar((A.cache.calendars || []).find((x) => x.id === Number(ec.dataset.editCal)));
      });
    },
  });

  // ---------------- edit a session ----------------
  function editSession(x) {
    const data = A.cache.sessions || { calendars: [], location_types: {}, defaults: {} };
    const s = x ? x.session : (data.defaults || {});
    const cals = (A.cache.calendars || data.calendars || []).filter((c) => c.active || (x && x.calendar_ids.includes(c.id)));
    const chosen = new Set(x ? x.calendar_ids : cals.filter((c) => c.kind === 'market').map((c) => c.id));

    A.drawer(`<div class="drawer-head"><div><div class="small muted">Session</div><h2>${x ? esc(x.name) : 'New session'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
    <form id="sess-form">
      <div class="panel stack">
        ${A.field('Name', A.input('name', x ? x.name : ''), 'What the customer sees, e.g. Engagement Session')}
        ${A.field('Description', A.textarea('description', x ? x.description : '', 'rows="2"'))}
        <div class="cols-even">
          ${A.field('Price', `<input class="input" data-bind="price_dollars" name="price_dollars" type="number" min="0" step="1" value="${x ? dollars(x.price_cents) : '0'}">`, 'In dollars. Leave at 0 and no one is asked to pay.')}
          ${A.field('Length (minutes)', `<input class="input" data-bind="duration_min" data-type="number" name="duration_min" type="number" min="5" step="5" value="${x ? x.duration_min : 90}">`)}
        </div>
        <div class="cols-even">
          ${A.field('Gap after (minutes)', `<input class="input" data-bind="buffer_after" data-type="number" type="number" min="0" step="5" value="${x ? x.buffer_after : 30}">`, 'Travel and reset time')}
          ${A.field('Offer times every (minutes)', `<input class="input" data-bind="slot_interval_min" data-type="number" type="number" min="5" step="5" value="${x ? x.slot_interval_min : 30}">`)}
        </div>
        <div class="cols-even">
          ${A.field('Needs notice (minutes)', `<input class="input" data-bind="min_notice_min" data-type="number" type="number" min="0" step="60" value="${x ? x.min_notice_min : 1440}">`, '1440 is one full day')}
          ${A.field('Bookable up to (days)', `<input class="input" data-bind="max_days_ahead" data-type="number" type="number" min="1" value="${x ? x.max_days_ahead : 180}">`)}
        </div>
        ${A.field('Where it happens', A.select('location_type', x ? x.location_type : 'in_person', data.location_types))}
        <div class="field"><label>Offered on</label>
          <div class="stack" style="gap:6px">${cals.length ? cals.map((c) => `<label class="check"><input type="checkbox" data-cal="${c.id}" ${chosen.has(c.id) ? 'checked' : ''}><span>${esc(c.name)}${c.active ? '' : ' (off)'}</span></label>`).join('') : '<span class="muted small">Add a calendar first.</span>'}</div>
          <div class="help">Tick more than one and the customer picks which first. Tick one and that step is skipped.</div>
        </div>
        ${x ? A.toggle('active', x.active, 'Live on the website') : ''}
      </div>

      <div class="panel stack">
        <h2>What the customer reads</h2>
        ${A.field('Location question', A.input('session.choose_label', s.choose_label), 'Only shown when more than one calendar is ticked')}
        ${A.field('Hint under it', A.input('session.choose_hint', s.choose_hint))}
        ${A.field('Already-booked question', A.input('session.booked_question', s.booked_question))}
        <div class="cols-even">
          ${A.field('"Yes" wording', A.input('session.booked_yes_label', s.booked_yes_label))}
          ${A.field('"No" wording', A.input('session.booked_no_label', s.booked_no_label))}
        </div>
        ${A.toggle('session.ask_booking_number', s.ask_booking_number, 'Ask for a booking number when they say yes')}
        <div class="cols-even">
          ${A.field('Booking number label', A.input('session.booking_number_label', s.booking_number_label))}
          ${A.field('Hint', A.input('session.booking_number_hint', s.booking_number_hint))}
        </div>
        ${A.toggle('session.booking_number_required', s.booking_number_required, 'Require it before they can continue')}
        ${A.field('Price screen blurb', A.textarea('session.price_blurb', s.price_blurb, 'rows="2"'))}
        ${A.field('What’s included', A.textarea('session.includes', (s.includes || []).join('\n'), 'rows="3" data-type="lines"'), 'One per line, shown next to the price')}
        <div class="cols-even">
          ${A.field('Pay button', A.input('session.pay_cta', s.pay_cta))}
          ${A.field('Button when there is no charge', A.input('session.free_cta', s.free_cta))}
        </div>
        ${A.field('Hold the slot for (minutes)', `<input class="input" data-bind="session.hold_minutes" data-type="number" type="number" min="10" max="180" value="${s.hold_minutes || 30}">`, 'How long they get to finish paying before the time goes back on sale')}
      </div>

      <div class="row between" style="margin-top:16px">
        ${x ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
        <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
        <button type="submit" class="btn btn-primary">${x ? 'Save session' : 'Create session'}</button></div>
      </div>
    </form>`, (el) => {
      $('#sess-form', el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        let body;
        try { body = A.collect(el); } catch (err) { return A.toast(err.message, true); }
        // The form is in dollars; the server and Stripe both work in cents.
        body.price_cents = Math.round(Number(body.price_dollars || 0) * 100);
        delete body.price_dollars;
        body.calendar_ids = $$('[data-cal]', el).filter((c) => c.checked).map((c) => Number(c.dataset.cal));
        if (!x) body.active = true;
        try {
          await A.guard(() => (x ? api('PATCH', `/sessions/${x.id}`, body) : api('POST', '/sessions', body)), x ? 'Saved' : 'Session created');
          A.closeDrawer(); A.render();
        } catch (err) { A.showErrors(el, err.details); }
      });
      const del = $('[data-del]', el);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${x.name}"? This cannot be undone.`)) return;
        try { await A.guard(() => api('DELETE', `/sessions/${x.id}`), 'Deleted'); A.closeDrawer(); A.render(); } catch (e) { /* toast already shown */ }
      });
    });
  }

  // ---------------- edit a calendar ----------------
  function editCalendar(c) {
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Calendar</div><h2>${c ? esc(c.name) : 'New calendar'}</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
    <form id="cal-form">
      <div class="panel stack">
        ${A.field('Name', A.input('name', c ? c.name : ''), 'A market like Houston, or a person like Album Designer')}
        ${c ? '' : A.field('Type', A.select('kind', 'market', KINDS), 'Markets are places you shoot. People are individuals with their own diary.')}
        ${A.field('Note for the customer', A.input('blurb', c ? c.blurb : ''), 'Optional, shown under the name when they choose')}
        ${A.field('Time zone', A.tzSelect('timezone', (c && c.timezone) || A.tz()))}
        ${c ? A.toggle('active', c.active, 'Offer this calendar') : ''}
        ${c
    ? `<div class="ok-box">Set this calendar's weekly hours and blackout dates on its <a href="#/availability?user_id=${c.user_id}">availability page</a>. Connect a Google or Outlook calendar there as well, so anything already in that diary blocks the time automatically.</div>`
    : '<div class="ok-box">New calendars start with Friday evenings and weekends open. You will land on its hours page next to set them properly.</div>'}
      </div>
      <div class="row between" style="margin-top:16px">
        ${c ? '<button type="button" class="btn btn-danger" data-del>Delete</button>' : '<span></span>'}
        <div class="row"><button type="button" class="btn btn-ghost" data-close-drawer>Cancel</button>
        <button type="submit" class="btn btn-primary">${c ? 'Save' : 'Create and set hours'}</button></div>
      </div>
    </form>`, (el) => {
      $('#cal-form', el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const body = A.collect(el);
        try {
          const saved = await A.guard(() => (c ? api('PATCH', `/session-calendars/${c.id}`, body) : api('POST', '/session-calendars', body)), c ? 'Saved' : 'Calendar created');
          A.closeDrawer();
          if (!c && saved && saved.user_id) return A.go(`#/availability?user_id=${saved.user_id}`);
          A.render();
        } catch (err) { A.showErrors(el, err.details); }
      });
      const del = $('[data-del]', el);
      if (del) del.addEventListener('click', async () => {
        if (!confirm(`Delete "${c.name}"?`)) return;
        try { await A.guard(() => api('DELETE', `/session-calendars/${c.id}`), 'Deleted'); A.closeDrawer(); A.render(); } catch (e) { /* toast already shown */ }
      });
    });
  }

  // ---------------- Orders ----------------
  const STATUS = { '': 'All', paid: 'Paid', not_required: 'Already booked', pending: 'Mid-checkout', expired: 'Expired', failed: 'Failed', refunded: 'Refunded' };

  A.route('/orders', {
    title: 'Session orders',
    async render(params, query) {
      const q = new URLSearchParams();
      if (query.status) q.set('status', query.status);
      const data = await api('GET', `/orders?${q}`);
      const s = data.summary;
      return `<div class="row between" style="margin-bottom:16px">
        <div><h1 style="font-size:24px;font-weight:800">Session orders</h1><div class="small muted" style="margin-top:2px">Everyone who bought a session, and everyone who booked one they already owned.</div></div>
        <a class="btn btn-ghost" href="/api/admin/orders/export.csv">Export CSV</a>
      </div>

      <div class="stats">
        ${stat('Paid, last 30 days', A.money(s.paid_total), `${s.paid_count} order${s.paid_count === 1 ? '' : 's'}`)}
        ${stat('Already booked', s.already_booked, 'used a booking number')}
        ${stat('Mid-checkout', s.pending, 'holding a slot')}
        ${stat('Needs attention', s.paid_but_unbooked, s.paid_but_unbooked ? 'paid but not on a calendar' : 'nothing stuck', s.paid_but_unbooked ? '#c0392b' : undefined)}
      </div>

      <div class="panel">
        <div class="panel-head"><div class="tabs">${Object.entries(STATUS).map(([k, v]) => `<a href="#/orders${k ? `?status=${k}` : ''}" class="${(query.status || '') === k ? 'active' : ''}">${esc(v)}</a>`).join('')}</div></div>
        ${data.rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>When</th><th>Customer</th><th>Session</th><th>Where</th><th class="num">Amount</th><th>Session time</th><th>Status</th></tr></thead><tbody>
          ${data.rows.map((o) => `<tr>
            <td class="small muted">${esc(A.ago(o.created_at))}</td>
            <td><b>${esc(o.customer_name || o.customer_email || '—')}</b><div class="small muted">${esc(o.customer_email || '')}${o.customer_phone ? ` · ${esc(o.customer_phone)}` : ''}</div></td>
            <td>${esc(o.product_name)}${o.booking_number ? `<div class="small muted">#${esc(o.booking_number)}</div>` : ''}</td>
            <td class="small">${esc(o.calendar || '—')}</td>
            <td class="num">${o.already_booked ? '<span class="muted small">already paid</span>' : esc(o.amount_display)}</td>
            <td class="small">${o.start ? esc(A.dt(o.start, { weekday: 'short' })) : '<span class="muted">—</span>'}${o.booking_token ? ` <a href="/booking/${esc(o.booking_token)}" target="_blank" rel="noopener">↗</a>` : ''}</td>
            <td>${A.pill(o.status)}${o.error ? `<div class="small" style="color:#c0392b;max-width:240px">${esc(o.error)}</div>` : ''}${o.receipt_url ? `<div class="small"><a href="${esc(o.receipt_url)}" target="_blank" rel="noopener">Receipt</a></div>` : ''}</td>
          </tr>`).join('')}
        </tbody></table></div>` : '<div class="empty-state"><h3>Nothing here yet</h3><p>Orders appear the moment someone starts a checkout.</p></div>'}
      </div>`;
    },
  });
})();
