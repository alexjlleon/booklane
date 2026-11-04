/* Month calendar + time slot picker */
(function () {
  'use strict';
  const { esc, api, icons } = BL;

  BL.Scheduler = function (opts) {
    const st = { tz: opts.tz, month: null, day: null, selected: opts.selected || null, cache: {}, loading: false, autoJumped: false };
    // Booking pages and forms can add a "Check a date" box. It sits beside the calendar rather than
    // inside it, so redrawing the month never wipes a date someone is typing.
    const dc = opts.dateCheck ? opts.dateCheck.business.settings.date_check || {} : {};
    const dcTypes = [dc.meeting && ['meeting', 'A meeting'], dc.event && ['event', 'My event date']].filter(Boolean);
    let root = opts.root;
    let dcEl = null;
    if (dcTypes.length) {
      root.innerHTML = '<div data-sched></div><div class="dc" data-dc></div>';
      dcEl = root.querySelector('[data-dc]');
      root = root.querySelector('[data-sched]');
    }
    const dcs = { type: dcTypes.length ? dcTypes[0][0] : null, date: '', busy: false, result: null, run: 0 };
    const today = () => BL.todayIn(st.tz);
    const monthOf = (d) => d.slice(0, 7);
    const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
    const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
    const maxMonth = () => { const d = new Date(Date.now() + (opts.maxDaysAhead || 60) * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7); };

    // Sessions pass their own URL so the calendar only shows one market's openings.
    const slotsUrl = () => opts.slotsUrl || `/api/public/b/${encodeURIComponent(opts.slug)}/e/${encodeURIComponent(opts.eventSlug)}/slots`;
    // One place, used by whatever writes the cache and whatever reads it. Built in two places
    // these drifted apart, every read missed, and every calendar showed a month of dead dates.
    const cacheKey = (month) => `${st.tz}|${month}|${slotsUrl()}`;

    async function load(month) {
      const url = slotsUrl();
      const key = cacheKey(month);
      if (st.cache[key]) return st.cache[key];
      const from = month === monthOf(today()) ? today() : month + '-01';
      const q = new URLSearchParams({ from, to: lastDay(month), tz: st.tz });
      if (opts.rescheduleToken) q.set('reschedule', opts.rescheduleToken);
      const data = await api('GET', `${url}${url.includes('?') ? '&' : '?'}${q}`);
      st.cache[key] = data.days || {};
      return st.cache[key];
    }

    async function show(month, day) {
      st.month = month;
      st.loading = true; render();
      let days;
      try { days = await load(month); } catch (e) { st.loading = false; root.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; return; }
      st.loading = false;
      const avail = Object.keys(days).filter((d) => days[d].length).sort();
      if (!avail.length && !st.autoJumped && month < maxMonth()) { return show(addMonths(month, 1)); }
      st.autoJumped = true;
      if (st.selected) {
        const selDay = new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(st.selected));
        if (monthOf(selDay) === month) st.day = selDay;
      }
      if (day && days[day] && days[day].length) st.day = day;
      if (!st.day || monthOf(st.day) !== month || !days[st.day]) st.day = avail[0] || null;
      render();
    }

    function render() {
      const month = st.month;
      const days = st.cache[cacheKey(month)] || {};
      const [y, mo] = month.split('-').map(Number);
      const first = new Date(Date.UTC(y, mo - 1, 1));
      const lead = first.getUTCDay();
      const count = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const title = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(first);
      const t = today();
      let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => `<div class="cal-dow" aria-hidden="true">${d}</div>`).join('');
      for (let i = 0; i < lead; i++) cells += '<div></div>';
      for (let d = 1; d <= count; d++) {
        const ds = `${month}-${String(d).padStart(2, '0')}`;
        const has = !st.loading && days[ds] && days[ds].length;
        const cls = ['cal-day', has ? 'avail' : '', ds === st.day ? 'sel' : '', ds === t ? 'today' : ''].join(' ');
        cells += `<button type="button" class="${cls}" data-day="${ds}" ${has ? '' : 'disabled'} aria-label="${esc(BL.fmtDateStr(ds))}${has ? ', available' : ''}">${d}</button>`;
      }
      const slots = st.day && days[st.day] ? days[st.day] : [];
      const slotsHtml = st.loading
        ? Array.from({ length: 6 }, () => '<div class="skeleton" style="height:44px"></div>').join('')
        : !st.day ? `<div class="empty">No open times this month.<br><button type="button" class="btn btn-link" data-nav="1">Check next month ${icons.right}</button></div>`
          : slots.map((iso) => `<button type="button" class="slot${iso === st.selected ? ' sel' : ''}" data-slot="${iso}">${esc(BL.fmtTime(iso, st.tz))}</button>`).join('');
      root.innerHTML = `<div class="sched">
        <div>
          <div class="cal-head"><strong>${esc(title)}</strong><div class="cal-nav">
            <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous month" ${month <= monthOf(t) ? 'disabled' : ''}>${icons.left}</button>
            <button type="button" class="icon-btn" data-nav="1" aria-label="Next month" ${month >= maxMonth() ? 'disabled' : ''}>${icons.right}</button></div></div>
          <div class="cal-grid">${cells}</div>
          <div class="tz-row">${icons.clock.replace('<svg', '<svg width="16" height="16"')}<label class="sr-only" for="tz">Time zone</label><select id="tz">${BL.tzOptions(st.tz)}</select></div>
        </div>
        <div><div class="slots-title">${st.day ? esc(BL.fmtDateStr(st.day, { year: undefined })) : 'Times'}</div><div class="slots" role="list">${slotsHtml}</div></div>
      </div>`;
    }

    function renderDateCheck() {
      if (!dcEl) return;
      const r = dcs.result;
      const hint = dcs.type === 'event' ? 'See if we are free on the date of your event.' : 'See if we have meeting times open on a certain day.';
      dcEl.innerHTML = `<strong class="dc-title">Check a date</strong>
        ${dcTypes.length > 1 ? `<div class="dc-types" role="radiogroup" aria-label="What are you checking?">${dcTypes.map(([k, label]) => `<button type="button" role="radio" aria-checked="${k === dcs.type}" class="dc-type${k === dcs.type ? ' on' : ''}" data-dc-type="${k}">${label}</button>`).join('')}</div>` : ''}
        <p class="muted small dc-hint">${hint}</p>
        <div class="dc-row"><label class="sr-only" for="dc-date">Date to check</label><input class="input" type="date" id="dc-date" min="${today()}" value="${esc(dcs.date)}">
          <button type="button" class="btn btn-ghost" data-dc-check ${dcs.busy ? 'disabled' : ''}>${dcs.busy ? '<span class="spinner"></span>' : ''}Check</button></div>
        <div role="status">${r ? `<div class="dc-result ${r.tone}">${r.title ? `<strong>${esc(r.title)}</strong> ` : ''}${esc(r.text)}</div>` : ''}</div>`;
    }

    async function checkEvent(date, pretty) {
      const r = await api('GET', `/api/public/b/${encodeURIComponent(opts.dateCheck.business.slug)}/date-check?date=${date}`);
      const custom = (r.available ? dc.available_text : dc.taken_text) || '';
      opts.dateCheck.onEvent && opts.dateCheck.onEvent(date, !!r.available);
      if (r.available) return { tone: 'good', title: 'That date looks open!', text: custom.replace(/\{date\}/g, pretty) || `${pretty} is not on our booked list. Pick a time for a call and we will lock in the details.` };
      return { tone: 'warn', title: 'That date is in demand.', text: custom.replace(/\{date\}/g, pretty) || `We may already be booked on ${pretty}, but teams free up and we often have more than one. Let's talk.` };
    }

    async function checkMeeting(date, pretty) {
      const url = slotsUrl();
      const q = new URLSearchParams({ from: date, to: date, tz: st.tz });
      const data = await api('GET', `${url}${url.includes('?') ? '&' : '?'}${q}`);
      const open = ((data.days || {})[date] || []).length;
      if (open) {
        st.day = null; st.autoJumped = true;
        show(monthOf(date), date);
        return { tone: 'good', title: 'Yes!', text: `We have ${open} meeting time${open === 1 ? '' : 's'} open on ${pretty}. Pick one on the calendar.` };
      }
      const ahead = opts.maxDaysAhead || 60;
      if (Date.parse(date) - Date.parse(today()) > ahead * 86400000) return { tone: 'warn', title: 'Not open yet.', text: `We book meetings up to ${ahead} days ahead, so ${pretty} is too far out for now.` };
      return { tone: 'warn', title: 'No times that day.', text: `We have no meeting times open on ${pretty}. The highlighted days on the calendar are open.` };
    }

    async function runDateCheck() {
      const input = dcEl.querySelector('#dc-date');
      dcs.date = input.value;
      const date = dcs.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { dcs.result = { tone: 'warn', text: 'Pick a date first.' }; return renderDateCheck(); }
      if (date < today()) { dcs.result = { tone: 'warn', text: 'Pick a date that has not passed.' }; return renderDateCheck(); }
      const run = ++dcs.run;
      const type = dcs.type;
      dcs.busy = true; dcs.result = null; renderDateCheck();
      let result;
      try {
        result = await (type === 'event' ? checkEvent : checkMeeting)(date, BL.fmtDateStr(date));
      } catch (e) {
        // Never guess about a date: say the check failed and let them try again.
        result = { tone: 'warn', text: 'We could not check that date. Please try again.' };
      }
      if (run !== dcs.run) return;
      dcs.busy = false; dcs.result = result; renderDateCheck();
    }

    if (dcEl) {
      dcEl.addEventListener('click', (e) => {
        const t = e.target.closest('[data-dc-type]');
        if (t) { dcs.date = dcEl.querySelector('#dc-date').value; dcs.type = t.dataset.dcType; dcs.result = null; dcs.run++; dcs.busy = false; renderDateCheck(); return; }
        if (e.target.closest('[data-dc-check]')) runDateCheck();
      });
      // Enter here checks the date. It must not reach the page, where Enter means next step.
      dcEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); runDateCheck(); } });
      renderDateCheck();
    }

    root.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav && !nav.disabled) { st.day = null; st.autoJumped = true; return show(addMonths(st.month, Number(nav.dataset.nav))); }
      const day = e.target.closest('[data-day]');
      if (day && !day.disabled) { st.day = day.dataset.day; render(); return; }
      const slot = e.target.closest('[data-slot]');
      if (slot) { st.selected = slot.dataset.slot; render(); opts.onSelect && opts.onSelect(st.selected); }
    });
    root.addEventListener('change', (e) => {
      if (e.target.id === 'tz') { st.tz = e.target.value; st.day = null; st.autoJumped = false; opts.onTzChange && opts.onTzChange(st.tz); show(st.selected ? monthOf(new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(st.selected))) : monthOf(today())); }
    });

    const startMonth = st.selected ? new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit' }).format(new Date(st.selected)).slice(0, 7) : monthOf(today());
    show(startMonth);
    return { get tz() { return st.tz; }, get selected() { return st.selected; }, refresh() { st.cache = {}; show(st.month); } };
  };
})();
