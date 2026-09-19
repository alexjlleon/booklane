/* Admin views: auth, dashboard, leads, bookings, quotes */
(function () {
  'use strict';
  const { esc, api, $, $$ } = A;
  const STATUSES = ['partial', 'booked', 'quoted', 'contract_requested', 'callback_requested', 'contacted', 'won', 'lost'];

  // ---------- Auth ----------
  function authView(mode) {
    return {
      public: true, title: mode === 'login' ? 'Log in' : 'Sign up',
      render: () => `<div class="auth"><div class="panel"><div class="logo-mark" style="margin:0;width:44px;height:44px;border-radius:12px"></div>
        <h1>${mode === 'login' ? 'Welcome back' : 'Create your booking page'}</h1>
        <p class="muted" style="margin-top:0">${mode === 'login' ? 'Log in to your dashboard.' : 'Takes about a minute. You can add more businesses later.'}</p>
        <div id="auth-err"></div>
        <form id="auth-form" novalidate>
          ${mode === 'signup' ? A.field('Your name', '<input class="input" name="name" autocomplete="name">') + A.field('Business name', '<input class="input" name="business_name" autocomplete="organization">') : ''}
          ${A.field('Email', '<input class="input" name="email" type="email" autocomplete="email">')}
          ${A.field('Password', `<input class="input" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">`)}
          <button class="btn btn-primary btn-lg btn-block" type="submit">${mode === 'login' ? 'Log in' : 'Create account'}</button>
        </form>
        <p class="small muted" style="text-align:center;margin-top:18px">${mode === 'login' ? 'New here? <a href="#/signup">Create an account</a>' : 'Already have an account? <a href="#/login">Log in</a>'}</p></div></div>`,
      mount(root) {
        $('#auth-form', root).addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(e.target));
          if (mode === 'signup') { try { body.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (x) { /* ignore */ } }
          const btn = $('button[type=submit]', root); btn.disabled = true;
          try {
            await api('POST', `/auth/${mode}`, body);
            A.me = await api('GET', '/auth/me');
            location.hash = mode === 'signup' ? '#/share?welcome=1' : '#/';
          } catch (err) {
            $('#auth-err', root).innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
            A.showErrors(root, err.details); btn.disabled = false;
          }
        });
      },
    };
  }
  A.route('/accept/:token', {
    public: true, title: 'Join team',
    async render(p) {
      let inv;
      try { inv = await api('GET', `/auth/invite/${encodeURIComponent(p.token)}`); } catch (e) { return `<div class="auth"><div class="panel"><h1>Invite not valid</h1><p class="muted">${esc(e.message)}. Ask for a new invite.</p><a class="btn btn-ghost" href="#/login">Log in</a></div></div>`; }
      return `<div class="auth"><div class="panel"><div class="logo-mark" style="margin:0;width:44px;height:44px;border-radius:12px"></div>
        <h1>Join ${esc(inv.business)}</h1><p class="muted" style="margin-top:0">${esc(inv.email)} · ${esc(A.label(inv.role))}</p><div id="auth-err"></div>
        <form id="accept-form" novalidate>${inv.needs_password ? A.field('Your name', `<input class="input" name="name" value="${esc(inv.name || '')}" autocomplete="name">`) + A.field('Create a password', '<input class="input" name="password" type="password" autocomplete="new-password">') : A.field('Your existing password', '<input class="input" name="password" type="password" autocomplete="current-password">')}
        <button class="btn btn-primary btn-lg btn-block" type="submit">Accept invite</button></form></div></div>`;
    },
    mount(root, p) {
      const f = $('#accept-form', root); if (!f) return;
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api('POST', '/auth/accept', Object.assign({ token: p.token }, Object.fromEntries(new FormData(f)))); A.me = await api('GET', '/auth/me'); location.hash = '#/availability'; }
        catch (err) { $('#auth-err', root).innerHTML = `<div class="form-error">${esc(err.message)}</div>`; A.showErrors(root, err.details); }
      });
    },
  });
  A.route('/login', authView('login'));
  A.route('/signup', authView('signup'));

  A.route('/account', {
    title: 'Account',
    render: () => `<div class="topbar"><div><h1>Your account</h1><div class="sub">${esc(A.me.user.email)}</div></div></div>
      <div class="cols-even"><form class="panel" id="me-form"><h2>Profile</h2><p class="desc">Your timezone controls how your working hours are read.</p>
        ${A.field('Name', A.input('name', A.me.user.name))}${A.field('Phone', A.input('phone', A.me.user.phone))}${A.field('Timezone', A.tzSelect('timezone', A.me.user.timezone))}
        <button class="btn btn-primary">Save profile</button></form>
      <form class="panel" id="pw-form"><h2>Change password</h2><p class="desc">Use at least 8 characters.</p>
        ${A.field('Current password', '<input class="input" type="password" name="current_password" data-bind="current_password" autocomplete="current-password">')}
        ${A.field('New password', '<input class="input" type="password" name="new_password" data-bind="new_password" autocomplete="new-password">')}
        <button class="btn btn-primary">Update password</button></form></div>`,
    mount(root) {
      $('#me-form', root).addEventListener('submit', async (e) => { e.preventDefault(); await A.guard(() => api('PATCH', '/me', A.collect(e.target)), 'Saved'); A.me = await api('GET', '/auth/me'); });
      $('#pw-form', root).addEventListener('submit', async (e) => { e.preventDefault(); try { await api('PATCH', '/me', A.collect(e.target)); A.toast('Password updated'); e.target.reset(); } catch (err) { A.toast(err.message, true); A.showErrors(e.target, err.details); } });
    },
  });

  // ---------- Dashboard ----------
  // Which page on the site the form was on when people started it.
  function pagesHtml(d) {
    const rows = (d.pages || []).filter((r) => r.page);
    if (!rows.length) return '<div class="empty-state"><h3>No page data yet</h3><p>Once the booking form is embedded on your site, each lead records the page it started on.</p></div>';
    const max = Math.max(...rows.map((r) => r.leads));
    const short = (u) => { try { const x = new URL(u); return (x.pathname === '/' ? x.hostname : x.pathname) + (x.search || ''); } catch (e) { return u; } };
    return `<div class="funnel">${rows.map((r) => `<div class="funnel-row">
      <span class="lbl" title="${esc(r.page)}"><a href="${esc(r.page)}" target="_blank" rel="noopener">${esc(r.title || short(r.page))}</a></span>
      <span class="bar"><span style="width:${max ? (r.leads / max) * 100 : 0}%"></span></span>
      <span class="n">${r.leads}<span class="drop" style="color:var(--ok)">${r.done} booked</span></span></div>`).join('')}</div>`;
  }

  function funnelHtml(d) {
    const groups = [];
    const quoteRows = d.funnelRows.filter((r) => r.source === 'quote');
    if (quoteRows.length) groups.push({ name: 'Quote builder', steps: ['Event details', 'Services', 'Contact', 'Review'], rows: quoteRows });
    for (const et of d.eventTypes) {
      const rows = d.funnelRows.filter((r) => r.source === 'booking' && r.event_type_id === et.id);
      if (rows.length) groups.push({ name: et.name, steps: et.steps, rows });
    }
    if (!groups.length) return '<div class="empty-state"><h3>No form activity yet</h3><p>Share your booking page to start seeing where people drop off.</p></div>';
    return groups.map((g) => {
      const total = g.rows.reduce((a, r) => a + r.c, 0);
      const done = g.rows.filter((r) => r.status !== 'partial').reduce((a, r) => a + r.c, 0);
      let prev = total;
      const rows = g.steps.map((label, i) => {
        const reached = g.rows.filter((r) => r.max_step_index >= i || r.status !== 'partial').reduce((a, r) => a + r.c, 0);
        const drop = prev - reached; prev = reached;
        return `<div class="funnel-row"><span class="lbl" title="${esc(label)}">${i + 1}. ${esc(label)}</span><span class="bar"><span style="width:${total ? (reached / total) * 100 : 0}%"></span></span><span class="n">${reached}${drop > 0 && i > 0 ? `<span class="drop">−${drop}</span>` : ''}</span></div>`;
      }).join('');
      return `<div style="margin-bottom:18px"><div class="row between" style="margin-bottom:8px"><b>${esc(g.name)}</b><span class="small muted">${done} of ${total} finished (${total ? Math.round((done / total) * 100) : 0}%)</span></div><div class="funnel">${rows}
        <div class="funnel-row"><span class="lbl">Completed</span><span class="bar"><span style="width:${total ? (done / total) * 100 : 0}%;background:var(--ok)"></span></span><span class="n">${done}</span></div></div></div>`;
    }).join('');
  }

  function sparkline(series, days) {
    if (!series.length) return '';
    const map = Object.fromEntries(series.map((s) => [s.d, s]));
    const pts = [];
    for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); pts.push({ d, leads: (map[d] || {}).leads || 0, completed: (map[d] || {}).completed || 0 }); }
    const max = Math.max(1, ...pts.map((p) => p.leads));
    const w = 600, h = 120, bw = w / pts.length;
    const bars = pts.map((p, i) => `<rect x="${i * bw + 1}" y="${h - (p.leads / max) * (h - 10)}" width="${Math.max(1, bw - 2)}" height="${(p.leads / max) * (h - 10)}" rx="2" fill="rgba(91,61,245,.22)"><title>${p.d}: ${p.leads} started, ${p.completed} finished</title></rect>
      <rect x="${i * bw + 1}" y="${h - (p.completed / max) * (h - 10)}" width="${Math.max(1, bw - 2)}" height="${(p.completed / max) * (h - 10)}" rx="2" fill="#5b3df5"></rect>`).join('');
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Leads per day">${bars}</svg><div class="row small muted" style="gap:14px;margin-top:6px"><span><b style="color:#5b3df5">■</b> Finished</span><span><b style="color:rgba(91,61,245,.3)">■</b> Started</span></div>`;
  }

  A.route('/', {
    title: 'Dashboard',
    async render(p, q) {
      const days = Number(q.days) || 30;
      const d = await api('GET', `/dashboard?days=${days}`);
      const L = d.leads, Q = d.quotes;
      const conv = L.total ? Math.round((L.completed / L.total) * 100) : 0;
      return `<div class="topbar"><div><h1>Hi ${esc(A.me.user.name.split(' ')[0])}</h1><div class="sub">Here's how ${esc(A.me.business.name)} is doing.</div></div>
        <div class="tools"><div class="seg">${[7, 30, 90].map((n) => `<button data-days="${n}" class="${n === days ? 'on' : ''}">${n}d</button>`).join('')}</div></div></div>
        <div class="stats">
          <div class="stat"><div class="k">Leads started</div><div class="v">${L.total || 0}</div><div class="s">${conv}% finished</div></div>
          <div class="stat"><div class="k">Partial leads to follow up</div><div class="v" style="color:#b7791f">${L.recoverable || 0}</div><div class="s"><a href="#/leads?status=partial&hide_anonymous=1">View partial leads →</a></div></div>
          <div class="stat"><div class="k">Upcoming calls</div><div class="v">${d.bookings.upcoming || 0}</div><div class="s">${d.bookings.created || 0} booked in ${days}d</div></div>
          <div class="stat"><div class="k">Contract requests</div><div class="v">${Q.contracts || 0}</div><div class="s">${A.money(Q.contract_value || 0)} requested · ${Q.callbacks || 0} callbacks</div></div>
        </div>
        <div class="cols-2">
          <div class="stack">
            <div class="panel"><div class="panel-head"><div><h2>Where people drop off</h2><p class="desc" style="margin:0">How far visitors get in each form. Every step they finish is saved as a lead.</p></div></div>${funnelHtml(d)}</div>
            <div class="panel"><div class="panel-head"><div><h2>Which pages bring bookings</h2><p class="desc" style="margin:0">Where each lead started, for forms embedded on your website.</p></div></div>${pagesHtml(d)}</div>
            <div class="panel"><h2>Leads per day</h2>${sparkline(d.series, days) || '<p class="muted">No leads yet.</p>'}</div>
          </div>
          <div class="stack">
            <div class="panel"><div class="panel-head"><h2>Next calls</h2><a href="#/bookings" class="small">All bookings →</a></div>
              ${d.upcoming.length ? `<div class="stack" style="gap:10px">${d.upcoming.map((b) => `<div class="row between"><div><b>${esc(b.name || b.email)}</b><div class="small muted">${esc(b.event_name || '')} · ${esc(b.host || '')}</div></div><div class="small" style="text-align:right;font-weight:600">${esc(A.dt(b.start_utc, { weekday: 'short' }))}</div></div>`).join('')}</div>` : '<p class="muted">No upcoming calls.</p>'}</div>
            <div class="panel"><div class="panel-head"><h2>Quote pipeline</h2><a href="#/quotes" class="small">All quotes →</a></div>
              <dl class="kv"><dt>Quotes built</dt><dd>${Q.built || 0}</dd><dt>Submitted value</dt><dd>${A.money(Q.pipeline || 0)}</dd><dt>Contract requests</dt><dd>${Q.contracts || 0}</dd></dl></div>
            <div class="panel"><h2>Recent activity</h2>${d.activity.length ? `<ul class="timeline" style="margin-top:12px">${d.activity.map((a) => `<li>${a.lead_id ? `<a href="#/leads/${a.lead_id}"><b>${esc(A.name(a))}</b></a> ` : ''}${esc(a.message)}<time>${esc(A.ago(a.created_at))}</time></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div>
          </div>
        </div>`;
    },
    mount(root) { root.addEventListener('click', (e) => { const b = e.target.closest('[data-days]'); if (b) A.go(`#/?days=${b.dataset.days}`); }); },
  });

  // ---------- Leads ----------
  const stepDots = (l) => { const total = l.step_total || 0; if (!total) return ''; const reached = l.status === 'partial' ? l.max_step_index + 1 : total; return `<span class="progress-mini" title="Reached step ${reached} of ${total}">${Array.from({ length: total }, (_, i) => `<i class="${i < reached ? 'on' : ''}"></i>`).join('')}</span>`; };

  A.route('/leads', {
    title: 'Leads',
    async render(p, q) {
      const qs = new URLSearchParams(Object.assign({ hide_anonymous: '1' }, q));
      const d = await api('GET', `/leads?${qs}`);
      const opts = (vals, sel, all) => `<option value="">${all}</option>` + vals.map((v) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${A.label(v)}</option>`).join('');
      return `<div class="topbar"><div><h1>Leads</h1><div class="sub">Everyone who started a form, including people who did not finish.</div></div>
        <div class="tools"><a class="btn btn-ghost btn-sm" href="/api/admin/leads/export.csv">Export CSV</a></div></div>
        <div class="panel"><div class="panel-head"><form class="filters" id="lf">
          <input class="input" name="q" placeholder="Search name, email, phone" value="${esc(q.q || '')}">
          <select class="select" name="status">${opts(STATUSES, q.status, 'All statuses')}</select>
          <select class="select" name="source">${opts(['booking', 'quote'], q.source, 'All forms')}</select>
          <label class="toggle small"><input type="checkbox" name="hide_anonymous" ${qs.get('hide_anonymous') === '1' ? 'checked' : ''}><span class="sw"></span><span>Only with contact info</span></label>
        </form><span class="small muted">${d.total} lead${d.total === 1 ? '' : 's'}</span></div>
        ${d.rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Name</th><th>Status</th><th>Form</th><th>Progress</th><th>Value / call</th><th>Last active</th></tr></thead><tbody>
          ${d.rows.map((l) => `<tr class="click" data-lead="${l.id}"><td><b>${esc(A.name(l))}</b><div class="small muted">${esc([l.email, l.phone].filter(Boolean).join(' · '))}</div></td>
            <td>${A.pill(l.status)}</td><td class="small">${esc(l.source === 'quote' ? 'Quote builder' : l.event_name || 'Booking')}</td><td>${stepDots(l)}</td>
            <td class="small">${l.quote_total ? `<b>${A.money(l.quote_total)}</b>` : ''}${l.booking_start ? `<div>${esc(A.dt(l.booking_start))}</div>` : ''}${!l.quote_total && !l.booking_start && l.answers.requested_time ? `<span class="muted">Wanted ${esc(l.answers.requested_time.split(' (')[0])}</span>` : ''}</td>
            <td class="small muted">${esc(A.ago(l.last_activity_at))}</td></tr>`).join('')}</tbody></table></div>
          <div class="row between" style="margin-top:14px">${d.page > 1 ? `<button class="btn btn-ghost btn-sm" data-page="${d.page - 1}">← Newer</button>` : '<span></span>'}${d.page * d.per < d.total ? `<button class="btn btn-ghost btn-sm" data-page="${d.page + 1}">Older →</button>` : ''}</div>`
          : '<div class="empty-state"><h3>No leads match</h3><p>Try clearing filters, or share your booking page to get your first lead.</p></div>'}</div>`;
    },
    mount(root, p, q) {
      const f = $('#lf', root);
      let t;
      const apply = () => { const fd = new FormData(f); const o = {}; for (const [k, v] of fd) if (v) o[k] = v === 'on' ? '1' : v; if (!fd.get('hide_anonymous')) o.hide_anonymous = '0'; A.go('#/leads?' + new URLSearchParams(o)); };
      f.addEventListener('change', apply);
      f.addEventListener('input', (e) => { if (e.target.name === 'q') { clearTimeout(t); t = setTimeout(apply, 450); } });
      f.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
      root.addEventListener('click', (e) => {
        const r = e.target.closest('[data-lead]'); if (r) A.go(`#/leads/${r.dataset.lead}`);
        const pg = e.target.closest('[data-page]'); if (pg) A.go('#/leads?' + new URLSearchParams(Object.assign({}, q, { page: pg.dataset.page })));
      });
      const qEl = $('input[name=q]', root); if (q.q) { qEl.focus(); qEl.setSelectionRange(qEl.value.length, qEl.value.length); }
    },
  });

  function answersTable(answers) {
    const entries = Object.entries(answers || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length));
    if (!entries.length) return '<p class="muted">No answers yet.</p>';
    return `<dl class="kv">${entries.map(([k, v]) => `<dt>${esc(A.label(k))}</dt><dd>${esc(Array.isArray(v) ? v.join(', ') : v)}</dd>`).join('')}</dl>`;
  }

  A.route('/leads/:id', {
    title: 'Lead',
    async render(p) {
      const d = await api('GET', `/leads/${p.id}`);
      const l = d.lead, cur = 'USD';
      const reached = l.status === 'partial' ? l.max_step_index + 1 : d.steps.length;
      const utm = Object.entries((l.meta && l.meta.utm) || {});
      return `<div class="topbar"><div><a href="#/leads" class="small">← Leads</a><h1 style="margin-top:6px">${esc(A.name(l))}</h1>
          <div class="sub">${A.pill(l.status)} · ${esc(l.source === 'quote' ? 'Quote builder' : (d.event_type || {}).name || 'Booking')} · started ${esc(A.ago(l.created_at))}</div></div>
        <div class="tools">
          ${l.phone ? `<a class="btn btn-ghost btn-sm" href="tel:${esc(l.phone)}">Call</a><a class="btn btn-ghost btn-sm" href="sms:${esc(l.phone)}">Text</a>` : ''}
          ${l.email ? `<a class="btn btn-ghost btn-sm" href="mailto:${esc(l.email)}">Email</a>` : ''}
          <select class="select btn-sm" id="status" style="width:auto">${STATUSES.map((s) => `<option value="${s}" ${s === l.status ? 'selected' : ''}>${A.label(s)}</option>`).join('')}</select>
        </div></div>
      ${l.status === 'partial' ? `<div class="warn-box" style="margin-bottom:16px"><b>Did not finish.</b> They reached step ${reached} of ${d.steps.length || '?'}${d.steps[l.max_step_index] ? ` (“${esc(d.steps[l.max_step_index])}”)` : ''}. Everything they entered is below.
        ${l.email ? `<div class="row" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-recovery>Send “finish where you left off” email</button><button class="btn btn-link btn-sm" data-copy="${esc(d.resume_url)}">Copy resume link</button></div>` : ''}</div>` : ''}
      <div class="cols-2"><div class="stack">
        <div class="panel"><h2>Contact</h2><dl class="kv" style="margin-top:12px"><dt>Name</dt><dd>${esc([l.first_name, l.last_name].filter(Boolean).join(' ') || '-')}</dd><dt>Email</dt><dd>${esc(l.email || '-')}</dd><dt>Phone</dt><dd>${esc(l.phone || '-')}</dd><dt>SMS consent</dt><dd>${l.sms_consent ? 'Yes' : 'No'}</dd></dl></div>
        <div class="panel"><h2>Answers</h2><div style="margin-top:12px">${answersTable(l.answers)}</div></div>
        ${d.quotes.filter((q) => q.total > 0).map((q) => `<div class="panel"><div class="panel-head"><h2>Quote · ${A.money(q.total, cur)}</h2><div class="row">${A.pill(q.status)}<a class="btn btn-ghost btn-sm" href="/q/${esc(q.token)}" target="_blank">Open ↗</a></div></div>
          <table class="t"><tbody>${q.line_items.map((li) => `<tr><td style="padding-left:0"><b>${esc(li.name)}</b><div class="small muted">${esc([li.options.map((o) => o.name).join(', '), li.pricing_type !== 'flat' ? li.qty + ' ' + (li.unit_label || '') : '', li.addons.map((a) => a.name + (a.qty > 1 ? ' ×' + a.qty : '')).join(', ')].filter(Boolean).join(' · '))}</div></td><td class="num" style="padding-right:0">${A.money(li.amount)}</td></tr>`).join('')}
          ${q.discount ? `<tr><td style="padding-left:0">Discount</td><td class="num" style="padding-right:0">−${A.money(q.discount)}</td></tr>` : ''}${q.tax ? `<tr><td style="padding-left:0">Tax</td><td class="num" style="padding-right:0">${A.money(q.tax)}</td></tr>` : ''}
          <tr><td style="padding-left:0"><b>Total</b> <span class="small muted">(deposit ${A.money(q.deposit)})</span></td><td class="num" style="padding-right:0"><b>${A.money(q.total)}</b></td></tr></tbody></table>
          ${q.contract_request ? `<h3 style="font-size:15px;margin:16px 0 8px">Contract request</h3>${answersTable(Object.fromEntries(Object.entries(q.contract_request).filter(([k]) => k !== 'agreed_terms')))}` : ''}
          ${q.callback_request ? `<h3 style="font-size:15px;margin:16px 0 8px">Call back request</h3>${answersTable(q.callback_request)}` : ''}
          <div class="row" style="margin-top:14px"><label class="small muted">Quote status</label><select class="select btn-sm" data-quote-status="${q.id}" style="width:auto">${['draft', 'submitted', 'contract_requested', 'contract_sent', 'signed', 'declined'].map((s) => `<option value="${s}" ${s === q.status ? 'selected' : ''}>${A.label(s)}</option>`).join('')}</select>
            <button class="btn btn-ghost btn-sm" data-boothbook>Push to BoothBook</button>${q.sync_status ? A.pill(q.sync_status) : ''}</div></div>`).join('')}
        ${d.bookings.length ? `<div class="panel"><h2>Calls</h2><table class="t" style="margin-top:8px"><tbody>${d.bookings.map((b) => `<tr><td style="padding-left:0"><b>${esc(A.dt(b.start_utc, { weekday: 'short', year: 'numeric' }))}</b><div class="small muted">${esc(b.event_name || '')} with ${esc(b.host || '')}</div></td><td>${A.pill(b.status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div><div class="stack">
        <div class="panel"><h2>Notes</h2><textarea class="textarea" id="notes" placeholder="Private notes for your team" style="margin-top:10px">${esc(l.notes || '')}</textarea><button class="btn btn-ghost btn-sm" style="margin-top:8px" data-save-notes>Save notes</button></div>
        <div class="panel"><h2>Timeline</h2><ul class="timeline" style="margin-top:12px">${d.activity.map((a) => `<li>${esc(a.message)}<time>${esc(A.dt(a.created_at))}</time></li>`).join('') || '<li>No activity</li>'}</ul></div>
        <div class="panel"><h2>Source</h2><dl class="kv" style="margin-top:12px">${(l.meta && l.meta.page_url) ? `<dt>Page</dt><dd class="small"><a href="${esc(l.meta.page_url)}" target="_blank" rel="noopener">${esc(l.meta.page_title || l.meta.page_url)}</a></dd>` : ''}${utm.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}<dt>Referrer</dt><dd class="small">${esc((l.meta && l.meta.referrer) || 'Direct')}</dd><dt>Embedded</dt><dd>${l.meta && l.meta.embedded ? 'Yes' : 'No'}</dd></dl></div>
        ${['owner', 'admin'].includes(A.me.business.role) ? '<button class="btn btn-danger btn-sm" data-delete>Delete lead</button>' : ''}
      </div></div>`;
    },
    mount(root, p) {
      $('#status', root).addEventListener('change', async (e) => { await A.guard(() => api('PATCH', `/leads/${p.id}`, { status: e.target.value }), 'Status updated'); A.render(); });
      root.addEventListener('change', async (e) => { const qs = e.target.closest('[data-quote-status]'); if (qs) { await A.guard(() => api('PATCH', `/quotes/${qs.dataset.quoteStatus}`, { status: qs.value }), 'Quote updated'); A.render(); } });
      root.addEventListener('click', async (e) => {
        if (e.target.closest('[data-save-notes]')) await A.guard(() => api('PATCH', `/leads/${p.id}`, { notes: $('#notes', root).value }), 'Notes saved');
        if (e.target.closest('[data-recovery]')) { await A.guard(() => api('POST', `/leads/${p.id}/recovery`, {}), 'Email sent'); A.render(); }
        if (e.target.closest('[data-boothbook]')) { const r = await A.guard(() => api('POST', `/leads/${p.id}/boothbook`, {})); A.toast(r.ok ? `BoothBook accepted it (HTTP ${r.status})` : `BoothBook error: ${r.error || 'HTTP ' + r.status}`, !r.ok); A.render(); }
        if (e.target.closest('[data-delete]') && confirm('Delete this lead and its history?')) { await A.guard(() => api('DELETE', `/leads/${p.id}`), 'Deleted'); A.go('#/leads'); }
      });
    },
  });

  // ---------- Bookings ----------
  A.route('/bookings', {
    title: 'Bookings',
    async render(p, q) {
      const scope = q.scope || 'upcoming';
      const rows = await api('GET', `/bookings?scope=${scope}${q.mine ? '&mine=1' : ''}`);
      let lastDay = '';
      return `<div class="topbar"><div><h1>Bookings</h1><div class="sub">Calls booked through your pages.</div></div>
        <div class="tools"><div class="seg">${['upcoming', 'past', 'cancelled'].map((s) => `<button data-scope="${s}" class="${s === scope ? 'on' : ''}">${A.label(s)}</button>`).join('')}</div>
        <label class="toggle small"><input type="checkbox" data-mine ${q.mine ? 'checked' : ''}><span class="sw"></span><span>Only mine</span></label></div></div>
        <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><tbody>${rows.map((b) => {
          const day = A.dt(b.start_utc, { weekday: 'long', month: 'long', day: 'numeric', hour: undefined, minute: undefined });
          const head = day !== lastDay ? `<tr><th colspan="5" style="background:#faf9f7">${esc(day)}</th></tr>` : ''; lastDay = day;
          return `${head}<tr><td style="width:120px"><b>${esc(A.dt(b.start_utc, { month: undefined, day: undefined }))}</b></td>
            <td><span class="pill" style="background:${esc(b.color || '#eee')}22;color:${esc(b.color || '#444')}">${esc(b.event_name || 'Call')}</span><div class="small muted" style="margin-top:4px">with ${esc(b.host || '-')}${b.synced ? ' · on calendar' : ''}</div></td>
            <td><b>${b.lead_id ? `<a href="#/leads/${b.lead_id}">${esc(b.name || b.email)}</a>` : esc(b.name || b.email)}</b><div class="small muted">${esc([b.email, b.phone].filter(Boolean).join(' · '))}</div></td>
            <td class="small">${esc(b.location || '')}${b.cancel_reason ? `<div class="muted">Reason: ${esc(b.cancel_reason)}</div>` : ''}</td>
            <td class="num">${b.status === 'confirmed' && scope === 'upcoming' ? `<button class="btn btn-ghost btn-sm" data-cancel="${b.id}">Cancel</button>` : A.pill(b.status)}</td></tr>`;
        }).join('')}</tbody></table></div>` : `<div class="empty-state"><h3>No ${scope} bookings</h3><p>${scope === 'upcoming' ? 'Share your booking page to fill your calendar.' : ''}</p></div>`}</div>`;
    },
    mount(root, p, q) {
      root.addEventListener('click', async (e) => {
        const s = e.target.closest('[data-scope]'); if (s) A.go(`#/bookings?scope=${s.dataset.scope}${q.mine ? '&mine=1' : ''}`);
        const c = e.target.closest('[data-cancel]');
        if (c) { const reason = prompt('Reason for cancelling (sent to the customer)', ''); if (reason === null) return; await A.guard(() => api('POST', `/bookings/${c.dataset.cancel}/cancel`, { reason }), 'Booking cancelled'); A.render(); }
      });
      root.addEventListener('change', (e) => { if (e.target.matches('[data-mine]')) A.go(`#/bookings?scope=${q.scope || 'upcoming'}${e.target.checked ? '&mine=1' : ''}`); });
    },
  });

  // ---------- Quotes ----------
  A.route('/quotes', {
    title: 'Quotes',
    async render(p, q) {
      const rows = await api('GET', `/quotes${q.status ? '?status=' + q.status : ''}`);
      const statuses = ['draft', 'submitted', 'contract_requested', 'contract_sent', 'signed', 'declined'];
      const total = rows.reduce((a, r) => a + (r.status !== 'draft' && r.status !== 'declined' ? r.total : 0), 0);
      return `<div class="topbar"><div><h1>Quotes</h1><div class="sub">${rows.length} quotes · ${A.money(total)} open value</div></div>
        <div class="tools"><select class="select" id="qs" style="width:auto"><option value="">All statuses</option>${statuses.map((s) => `<option value="${s}" ${s === q.status ? 'selected' : ''}>${A.label(s)}</option>`).join('')}</select></div></div>
        <div class="panel">${rows.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Customer</th><th>Event</th><th>Services</th><th>Status</th><th class="num">Total</th><th>Updated</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="click" data-lead="${r.lead_id}"><td><b>${esc(A.name(r))}</b><div class="small muted">${esc(r.email || '')}</div></td><td class="small">${esc([r.details.event_type, r.details.event_date ? A.date(r.details.event_date) : ''].filter(Boolean).join(' · '))}<div class="muted">${esc(r.details.city || '')}</div></td>
          <td class="small">${esc(r.services.join(', '))}</td><td>${A.pill(r.status)}${r.next_step === 'callback' ? ' <span class="pill callback_requested">Call back</span>' : r.next_step === 'call' ? ' <span class="pill booked">Call booked</span>' : ''}</td><td class="num"><b>${A.money(r.total)}</b></td><td class="small muted">${esc(A.ago(r.updated_at))}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty-state"><h3>No quotes yet</h3><p>Add services to your quote catalog and share the quote builder link.</p><a class="btn btn-primary" href="#/catalog">Set up catalog</a></div>'}</div>`;
    },
    mount(root) {
      $('#qs', root).addEventListener('change', (e) => A.go('#/quotes' + (e.target.value ? '?status=' + e.target.value : '')));
      root.addEventListener('click', (e) => { const r = e.target.closest('[data-lead]'); if (r && r.dataset.lead !== 'null') A.go(`#/leads/${r.dataset.lead}`); });
    },
  });
})();
