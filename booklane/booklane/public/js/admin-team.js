/* Admin: team performance, one person's calls, and the actions an admin takes on anyone's calls
   (reschedule, cancel, mark a no-show). The Bookings screen reuses A.bookingActions. */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;

  const stat = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div><div class="s">${s || ''}</div></div>`;
  const pct = (n) => (n === null || n === undefined ? '<span class="muted">-</span>' : `${n}%`);
  const num = (n) => (n === null || n === undefined ? '-' : String(n));

  // ---------- range ----------
  const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['month', 'This month']];
  function rangeQuery(q) {
    if (q.range === 'month') {
      const d = new Date();
      const first = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      const today = `${first.slice(0, 8)}${String(d.getDate()).padStart(2, '0')}`;
      return `from=${first}&to=${today}`;
    }
    return `days=${Number(q.range) || 30}`;
  }
  const rangeTabs = (base, q) => `<div class="seg">${RANGES.map(([k, l]) => `<button data-range="${k}" class="${(q.range || '30') === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const prettyRange = (r) => `${A.dt(r.from + 'T12:00:00Z', { hour: undefined, minute: undefined })} to ${A.dt(r.to + 'T12:00:00Z', { hour: undefined, minute: undefined })}`;

  function utilBar(r) {
    if (r.utilization === null) return `<span class="small muted">${r.has_hours ? 'No open hours in range' : 'No hours set'}</span>`;
    const w = Math.min(100, r.utilization);
    const color = r.utilization >= 85 ? '#c0392b' : r.utilization >= 60 ? '#b7791f' : 'var(--brand, #5b3df5)';
    return `<div class="util"><div class="util-bar"><span style="width:${w}%;background:${color}"></span></div>
      <div class="small muted">${r.booked_hours}h of ${r.available_hours}h · <b>${r.utilization}%</b></div></div>`;
  }

  function setupFlags(r) {
    const flags = [];
    if (!r.has_hours) flags.push('<span class="pill partial">No hours</span>');
    if (!r.calendars) flags.push('<span class="pill partial">No calendar</span>');
    return flags.join(' ');
  }

  // ---------- Team performance ----------
  A.route('/team-stats', {
    title: 'Team performance',
    async render(p, q) {
      const d = await api('GET', `/team-stats?${rangeQuery(q)}`);
      const t = d.totals;
      const rows = d.people;
      return `<div class="topbar"><div><h1>Team performance</h1><div class="sub">${esc(prettyRange(d.range))}. Counted by when each call was scheduled to happen.</div></div>
        <div class="tools">${rangeTabs('team-stats', q)}</div></div>

        <div class="stats">
          ${stat('Calls held', t.held, `${t.completed} done · ${t.upcoming} still to come`)}
          ${stat('Show rate', t.show_rate === null ? '-' : `${t.show_rate}%`, `${t.no_shows} no-show${t.no_shows === 1 ? '' : 's'} · ${t.cancelled} cancelled`)}
          ${stat('Time booked', t.utilization === null ? '-' : `${t.utilization}%`, `${t.booked_hours}h of ${t.available_hours}h open`)}
          ${stat('Contracts', t.contracts, `${A.money(t.contract_value)} · from ${t.quotes} quote${t.quotes === 1 ? '' : 's'}`)}
        </div>

        <div class="panel">
          ${rows.length ? `<div class="table-wrap"><table class="t team-table"><thead><tr>
            <th>Person</th><th class="num">Held</th><th class="num">Upcoming</th><th class="num">Show rate</th><th class="num">Cancelled</th>
            <th>Time booked</th><th class="num">Share</th><th class="num">Lead time</th><th class="num">Leads</th><th class="num">Quotes</th><th class="num">Contracts</th></tr></thead>
            <tbody>${rows.map((r) => `<tr class="clickable" data-person="${r.id}">
              <td><b><a href="#/team-stats/${r.id}${q.range ? `?range=${esc(q.range)}` : ''}">${esc(r.name)}</a></b><div class="small muted">${esc(A.label(r.role))} ${setupFlags(r)}</div></td>
              <td class="num">${r.held}</td>
              <td class="num">${r.upcoming}</td>
              <td class="num">${pct(r.show_rate)}${r.no_shows ? `<div class="small muted">${r.no_shows} no-show${r.no_shows === 1 ? '' : 's'}</div>` : ''}</td>
              <td class="num">${r.cancelled}${r.cancel_rate ? `<div class="small muted">${r.cancel_rate}%</div>` : ''}</td>
              <td>${utilBar(r)}</td>
              <td class="num">${pct(r.share)}</td>
              <td class="num">${r.avg_lead_days === null ? '-' : `${r.avg_lead_days}d`}</td>
              <td class="num">${r.leads}</td>
              <td class="num">${r.quotes}</td>
              <td class="num">${r.contracts}${r.contract_value ? `<div class="small muted">${esc(A.money(r.contract_value))}</div>` : ''}</td>
            </tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><h3>No one on the team yet</h3><p>Invite people under People. They show up here once they accept.</p></div>'}
        </div>
        <p class="small muted">Share is each person's slice of the calls held, which is how you can see round robin spreading the work. Lead time is how far ahead customers book. A call counts as a no-show only once someone marks it, from the person's page or from Bookings.</p>`;
    },
    mount(root, p, q) {
      root.addEventListener('click', (e) => {
        const rangeBtn = e.target.closest('[data-range]');
        if (rangeBtn) return A.go(`#/team-stats?range=${rangeBtn.dataset.range}`);
        const row = e.target.closest('[data-person]');
        if (row && !e.target.closest('a')) A.go(`#/team-stats/${row.dataset.person}${q.range ? `?range=${q.range}` : ''}`);
      });
    },
  });

  // ---------- One person ----------
  function meetingRow(b, kind) {
    const when = `${A.dt(b.start_utc, { weekday: 'short' })}`;
    const who = b.lead_id ? `<a href="#/leads/${b.lead_id}">${esc(b.name || b.email || 'Customer')}</a>` : esc(b.name || b.email || 'Customer');
    let actions = '';
    if (kind === 'upcoming') {
      actions = `<button class="btn btn-ghost btn-sm" data-resched="${b.id}">Reschedule</button> <button class="btn btn-ghost btn-sm" data-handoff="${b.id}">Pass on</button> <button class="btn btn-ghost btn-sm" data-cancel="${b.id}">Cancel</button>`;
    } else if (b.status === 'confirmed') {
      actions = `<span class="pill booked">Showed</span> <button class="btn btn-link btn-sm" data-noshow="${b.id}">Mark no-show</button>`;
    } else if (b.status === 'no_show') {
      actions = `<span class="pill lost">No-show</span> <button class="btn btn-link btn-sm" data-showed="${b.id}">They showed up</button>`;
    } else {
      actions = A.pill(b.status);
    }
    return `<tr><td class="small" style="white-space:nowrap"><b>${esc(when)}</b></td>
      <td><span class="pill" style="background:${esc(b.color || '#eee')}22;color:${esc(b.color || '#444')}">${esc(b.event_name || 'Call')}</span></td>
      <td><b>${who}</b><div class="small muted">${esc([b.email, b.phone].filter(Boolean).join(' · '))}</div>${b.cancel_reason ? `<div class="small muted">Reason: ${esc(b.cancel_reason)}</div>` : ''}</td>
      <td class="num" style="white-space:nowrap">${actions}</td></tr>`;
  }

  A.route('/team-stats/:id', {
    title: 'Team member',
    async render(p, q) {
      const d = await api('GET', `/team-stats/${encodeURIComponent(p.id)}?${rangeQuery(q)}`);
      A.cache.teamPerson = d;
      const r = d.person;
      return `<div class="topbar"><div><a href="#/team-stats${q.range ? `?range=${esc(q.range)}` : ''}" class="small">← Team performance</a>
          <h1 style="margin-top:6px">${esc(r.name)}</h1><div class="sub">${esc(r.email)} · ${esc(A.label(r.role))} · ${esc(prettyRange(d.range))} ${setupFlags(r)}</div></div>
        <div class="tools">${rangeTabs(`team-stats/${r.id}`, q)}
          <a class="btn btn-ghost" href="#/availability?user_id=${r.id}">Edit hours</a>
          <a class="btn btn-ghost" href="#/bookings?host=${r.id}">All bookings</a></div></div>

        <div class="stats">
          ${stat('Calls held', r.held, `${r.completed} done · ${r.upcoming} upcoming`)}
          ${stat('Show rate', r.show_rate === null ? '-' : `${r.show_rate}%`, `${r.no_shows} no-show${r.no_shows === 1 ? '' : 's'} · ${r.cancelled} cancelled`)}
          ${stat('Time booked', r.utilization === null ? '-' : `${r.utilization}%`, `${r.booked_hours}h of ${r.available_hours}h open`)}
          ${stat('Share of team calls', r.share === null ? '-' : `${r.share}%`, r.avg_lead_days === null ? '' : `booked ${r.avg_lead_days} days ahead on average`)}
          ${stat('Leads → contracts', `${r.leads} → ${r.contracts}`, `${r.quotes} quote${r.quotes === 1 ? '' : 's'} · ${esc(A.money(r.contract_value))}`)}
        </div>

        ${d.by_page.length ? `<div class="panel"><h2>By booking page</h2><div class="table-wrap"><table class="t"><thead><tr><th>Page</th><th class="num">Calls</th><th class="num">Cancelled</th><th class="num">No-shows</th></tr></thead>
          <tbody>${d.by_page.map((x) => `<tr><td>${esc(x.page)}</td><td class="num">${x.meetings}</td><td class="num">${x.cancelled}</td><td class="num">${x.no_shows}</td></tr>`).join('')}</tbody></table></div></div>` : ''}

        <div class="panel"><h2>Upcoming</h2>
          ${d.upcoming.length ? `<div class="table-wrap"><table class="t"><tbody>${d.upcoming.map((b) => meetingRow(b, 'upcoming')).join('')}</tbody></table></div>` : '<p class="muted">Nothing booked yet.</p>'}</div>

        <div class="panel"><h2>Past calls in this range</h2>
          ${d.past.length ? `<div class="table-wrap"><table class="t"><tbody>${d.past.map((b) => meetingRow(b, 'past')).join('')}</tbody></table></div>` : '<p class="muted">No calls in this range.</p>'}</div>`;
    },
    mount(root, p, q) {
      root.addEventListener('click', (e) => {
        const rangeBtn = e.target.closest('[data-range]');
        if (rangeBtn) return A.go(`#/team-stats/${p.id}?range=${rangeBtn.dataset.range}`);
        A.bookingActions.handle(e, () => A.render());
      });
    },
  });

  // ---------- shared actions on a booking ----------
  async function setNoShow(id, value) {
    await A.guard(() => api('POST', `/bookings/${id}/no-show`, { no_show: value }), value ? 'Marked as a no-show' : 'Marked as showed up');
  }

  async function cancel(id, done) {
    // An in-page form rather than prompt(): a browser dialog blocks the page and is easy to miss.
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Booking</div><h2>Cancel this call</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <form id="cancel-form" class="panel stack">
        ${A.field('Reason', '<textarea class="textarea" rows="3" name="reason" placeholder="Optional. The customer sees this in their cancellation email."></textarea>')}
        <div class="row between"><button type="button" class="btn btn-ghost" data-close-drawer>Keep it</button><button type="submit" class="btn btn-danger">Cancel the call</button></div>
      </form>`, (el) => {
      $('#cancel-form', el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const reason = $('[name="reason"]', el).value;
        try { await A.guard(() => api('POST', `/bookings/${id}/cancel`, { reason }), 'Call cancelled'); A.closeDrawer(); done(); } catch (err) { /* toast shown */ }
      });
    });
  }

  function reschedule(id, done) {
    const tz = A.tz();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    let from = today;
    let picked = null;
    const addDays = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

    A.drawer(`<div class="drawer-head"><div><div class="small muted">Reschedule</div><h2>Pick a new time</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <div class="panel stack"><div class="row between"><button type="button" class="btn btn-ghost btn-sm" data-prev>← Earlier</button><b class="small" data-label></b><button type="button" class="btn btn-ghost btn-sm" data-next>Later →</button></div>
        <div data-slots><div class="empty-state"><span class="spinner"></span></div></div>
        <div class="help">Times in ${esc(tz)}. The customer gets a rescheduled email and a new invite, and their reminders move with it.</div>
        <div class="row between"><button type="button" class="btn btn-ghost" data-close-drawer>Keep the current time</button><button type="button" class="btn btn-primary" data-confirm disabled>Move the call</button></div></div>`, (el) => {
      const slotsEl = $('[data-slots]', el);
      const confirmBtn = $('[data-confirm]', el);
      async function load() {
        picked = null; confirmBtn.disabled = true; confirmBtn.textContent = 'Move the call';
        $('[data-label]', el).textContent = `${A.dt(from + 'T12:00:00Z', { hour: undefined, minute: undefined })} onward`;
        $('[data-prev]', el).disabled = from <= today;
        slotsEl.innerHTML = '<div class="empty-state"><span class="spinner"></span></div>';
        try {
          const r = await api('GET', `/bookings/${id}/slots?from=${from}&to=${addDays(from, 13)}&tz=${encodeURIComponent(tz)}`);
          const days = Object.entries(r.days).filter(([, list]) => list.length);
          slotsEl.innerHTML = days.length ? days.map(([d, list]) => `<div class="resched-day"><div class="small"><b>${esc(A.dt(d + 'T12:00:00Z', { weekday: 'long', hour: undefined, minute: undefined }))}</b></div>
            <div class="resched-times">${list.map((s) => `<button type="button" class="btn btn-ghost btn-sm" data-slot="${esc(s.start)}" title="${s.same_host ? 'Same person' : 'With someone else on this page'}">${esc(A.dt(s.start, { month: undefined, day: undefined }))}${s.same_host ? '' : ' *'}</button>`).join('')}</div></div>`).join('')
            + (days.some(([, l]) => l.some((s) => !s.same_host)) ? '<p class="small muted">* Their current host is busy then, so the call would go to someone else on this page.</p>' : '')
            : '<p class="muted">No open times in these two weeks. Try later, or check this page\'s hours.</p>';
        } catch (err) { slotsEl.innerHTML = `<p class="muted">${esc(err.message)}</p>`; }
      }
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-prev]')) { from = addDays(from, -14); if (from < today) from = today; return load(); }
        if (e.target.closest('[data-next]')) { from = addDays(from, 14); return load(); }
        const s = e.target.closest('[data-slot]');
        if (s) {
          picked = s.dataset.slot;
          $$('[data-slot]', el).forEach((x) => x.classList.toggle('btn-primary', x === s));
          confirmBtn.disabled = false;
          confirmBtn.textContent = `Move to ${A.dt(picked, { weekday: 'short' })}`;
          return;
        }
        if (e.target.closest('[data-confirm]') && picked) {
          confirmBtn.disabled = true;
          try {
            await A.guard(() => api('POST', `/bookings/${id}/reschedule`, { start: picked, timezone: tz }), 'Call moved. The customer has been emailed.');
            A.closeDrawer(); done();
          } catch (err) { confirmBtn.disabled = false; if (err.status === 409) load(); }
        }
      });
      load();
    });
  }

  // Pass a call to someone else on its booking page, same time. Busy people are listed but greyed out
  // with the reason, so it is clear why they cannot take it.
  function handoff(id, done) {
    A.drawer(`<div class="drawer-head"><div><div class="small muted">Booking</div><h2>Pass this call on</h2></div><button class="icon-x" data-close-drawer aria-label="Close">&times;</button></div>
      <form id="handoff-form" class="panel stack"><div data-who><div class="empty-state"><span class="spinner"></span></div></div></form>`, async (el) => {
      const box = $('[data-who]', el);
      let r;
      try { r = await api('GET', `/bookings/${id}/handoff`); } catch (err) { box.innerHTML = `<p class="muted">${esc(err.message)}</p>`; return; }
      const free = r.people.filter((p) => p.free);
      box.innerHTML = `<p class="small">${esc(r.event.name)}, ${esc(A.dt(r.start_utc, { weekday: 'short' }))}. Now with <b>${esc(r.host.name || 'nobody')}</b>. Same time, new person.</p>`
        + (r.people.length ? `<div class="stack" style="gap:6px">${r.people.map((p) => `<label class="row" style="gap:8px;${p.free ? '' : 'opacity:.55'}"><input type="radio" name="to" value="${p.id}" ${p.free ? '' : 'disabled'}> <span>${esc(p.name)}${p.free ? '' : ` <span class="small muted">(${esc(p.reason)})</span>`}</span></label>`).join('')}</div>`
          : '<p class="muted">Nobody else is a host on this booking page. Add people to the page to be able to pass its calls on.</p>')
        + (r.people.length && !free.length ? '<p class="small muted">Nobody else is free at this time. Reschedule it instead, or ask a teammate to free up the slot.</p>' : '')
        + (r.people.length ? `${A.field('Note for them', '<textarea class="textarea" rows="3" name="note" placeholder="Optional. Anything they should know before the call."></textarea>')}
          <label class="row" style="gap:8px"><input type="checkbox" name="notify" checked> <span>Email the customer who they will be talking to now (with an updated invite)</span></label>
          <div class="row between"><button type="button" class="btn btn-ghost" data-close-drawer>Keep it</button><button type="submit" class="btn btn-primary" disabled data-go>Pass it on</button></div>` : '');
      const go = $('[data-go]', el);
      el.addEventListener('change', (e) => { if (e.target.name === 'to' && go) { go.disabled = false; go.textContent = `Pass to ${r.people.find((p) => String(p.id) === e.target.value).name}`; } });
      $('#handoff-form', el).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const to = $('[name="to"]:checked', el); if (!to) return;
        go.disabled = true;
        try {
          await A.guard(() => api('POST', `/bookings/${id}/handoff`, { user_id: Number(to.value), note: $('[name="note"]', el).value, notify_customer: $('[name="notify"]', el).checked }), 'Call passed on. They have been emailed.');
          A.closeDrawer(); done();
        } catch (err) { go.disabled = false; }
      });
    });
  }

  A.bookingActions = {
    reschedule, cancel, setNoShow, handoff,
    /** Wire the buttons any meeting list uses. Returns true when it handled the click. */
    handle(e, done) {
      const rs = e.target.closest('[data-resched]'); if (rs) { reschedule(Number(rs.dataset.resched), done); return true; }
      const ho = e.target.closest('[data-handoff]'); if (ho) { handoff(Number(ho.dataset.handoff), done); return true; }
      const c = e.target.closest('[data-cancel]'); if (c) { cancel(Number(c.dataset.cancel), done); return true; }
      const ns = e.target.closest('[data-noshow]'); if (ns) { setNoShow(Number(ns.dataset.noshow), true).then(done).catch(() => {}); return true; }
      const sh = e.target.closest('[data-showed]'); if (sh) { setNoShow(Number(sh.dataset.showed), false).then(done).catch(() => {}); return true; }
      return false;
    },
  };
})();
