/* Month calendar + time slot picker. Phones get a row of days and a grid of times instead. */
(function () {
  'use strict';
  const { esc, api, icons } = BL;

  BL.Scheduler = function (opts) {
    const st = { tz: opts.tz, month: null, day: null, selected: opts.selected || null, cache: {}, loading: false, autoJumped: false, allDates: false, stripTo: '', center: true, extending: false };
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

    // The row of days runs unbroken from today, so every month up to the one on show has to be in,
    // plus the one after it: otherwise the row would stop dead at the end of the month.
    function loadStrip(month) {
      const next = addMonths(month, 1);
      const end = next <= maxMonth() ? next : month;
      if (end > st.stripTo) st.stripTo = end;
      const months = [];
      for (let m = monthOf(today()); m <= st.stripTo; m = addMonths(m, 1)) months.push(m);
      return Promise.all(months.map(load));
    }

    async function show(month, day) {
      st.month = month;
      if (day) { st.allDates = false; st.center = true; }
      st.loading = true; render();
      let days;
      try {
        if (BL.isPhone()) await loadStrip(month);
        days = await load(month);
      } catch (e) { st.loading = false; root.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; return; }
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

    /** The month grid. The phone layout shows it too, behind "All dates". */
    function monthHtml() {
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
      return `<div class="cal-head"><strong>${esc(title)}</strong><div class="cal-nav">
            <button type="button" class="icon-btn" data-nav="-1" aria-label="Previous month" ${month <= monthOf(t) ? 'disabled' : ''}>${icons.left}</button>
            <button type="button" class="icon-btn" data-nav="1" aria-label="Next month" ${month >= maxMonth() ? 'disabled' : ''}>${icons.right}</button></div></div>
          <div class="cal-grid">${cells}</div>`;
    }

    const noTimes = () => `<div class="empty">No open times this month.${st.month < maxMonth() ? `<br><button type="button" class="btn btn-link" data-nav="1">Check next month ${icons.right}</button>` : ''}</div>`;

    function render() {
      syncBar();
      if (BL.isPhone()) return renderPhone();
      const days = st.cache[cacheKey(st.month)] || {};
      const slots = st.day && days[st.day] ? days[st.day] : [];
      const slotsHtml = st.loading
        ? Array.from({ length: 6 }, () => '<div class="skeleton" style="height:44px"></div>').join('')
        : !st.day ? noTimes()
          : slots.map((iso) => `<button type="button" class="slot${iso === st.selected ? ' sel' : ''}" data-slot="${iso}">${esc(BL.fmtTime(iso, st.tz))}</button>`).join('');
      root.innerHTML = `<div class="sched">
        <div>
          ${monthHtml()}
          <div class="tz-row">${icons.clock.replace('<svg', '<svg width="16" height="16"')}<label class="sr-only" for="tz">Time zone</label><select id="tz">${BL.tzOptions(st.tz)}</select></div>
        </div>
        <div><div class="slots-title">${st.day ? esc(BL.fmtDateStr(st.day, { year: undefined })) : 'Times'}</div><div class="slots" role="list">${slotsHtml}</div></div>
      </div>`;
    }

    // ---------- Phones: days across the top, times in a grid, less scrolling ----------
    const slotsOn = (ds) => (st.cache[cacheKey(monthOf(ds))] || {})[ds] || [];
    const lastBookable = () => new Date(Date.parse(today() + 'T12:00:00Z') + (opts.maxDaysAhead || 60) * 86400000).toISOString().slice(0, 10);
    const fullTime = (iso) => BL.fmtTime(iso, st.tz).replace(/(am|pm)$/, ' $1').toUpperCase();
    const hourOf = (iso) => Number(new Intl.DateTimeFormat('en-US', { timeZone: st.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso)));
    function tzName(tz) {
      try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName').value; }
      catch (e) { return tz; }
    }

    function dayTile(ds) {
      const open = slotsOn(ds).length;
      const on = ds === st.day;
      const dt = new Date(ds + 'T12:00:00Z');
      const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(dt);
      return `<button type="button" class="day-tile${open ? '' : ' full'}${on ? ' sel' : ''}" data-day="${ds}" ${open ? '' : 'disabled'} aria-pressed="${on}" aria-label="${esc(BL.fmtDateStr(ds))}, ${open ? `${open} open` : 'full'}"><span class="d-dow">${dow}</span><span class="d-num">${dt.getUTCDate()}</span><span class="d-open">${open ? `${open} open` : 'Full'}</span></button>`;
    }

    /** Every day from `from` to the end of the month `to`, stopping at the booking window. */
    function tiles(from, to) {
      const end = lastDay(to) < lastBookable() ? lastDay(to) : lastBookable();
      let html = '';
      for (let t = Date.parse(from + 'T12:00:00Z'); ; t += 86400000) {
        const ds = new Date(t).toISOString().slice(0, 10);
        if (ds > end) return html;
        html += dayTile(ds);
      }
    }

    function timesHtml() {
      if (st.loading) return '<div class="time-grid">' + Array.from({ length: 6 }, () => '<div class="skeleton" style="height:44px"></div>').join('') + '</div>';
      if (!st.day) return noTimes();
      const groups = [['Morning', 0, 12], ['Afternoon', 12, 17], ['Evening', 17, 24]];
      return groups.map(([label, from, to]) => {
        const list = slotsOn(st.day).filter((iso) => { const h = hourOf(iso); return h >= from && h < to; });
        if (!list.length) return '';
        return `<div class="time-label">${label}</div><div class="time-grid">${list.map((iso) => `<button type="button" class="slot${iso === st.selected ? ' sel' : ''}" data-slot="${iso}">${esc(fullTime(iso))}</button>`).join('')}</div>`;
      }).join('');
    }

    function renderPhone() {
      const old = root.querySelector('[data-strip]');
      const left = old ? old.scrollLeft : 0;
      const ready = !!st.cache[cacheKey(st.month)];
      const row = ready ? tiles(today(), st.stripTo || st.month) : Array.from({ length: 5 }, () => '<div class="skeleton day-tile-sk"></div>').join('');
      root.innerHTML = `<div class="sched-m">
        <section class="sched-card">
          <div class="sched-card-head"><strong>Pick a day</strong><button type="button" class="sched-link" data-all aria-expanded="${st.allDates}">${st.allDates ? 'Fewer dates' : 'All dates'} ${icons.right}</button></div>
          ${st.allDates ? monthHtml() : `<div class="day-strip" data-strip>${row}</div>`}
        </section>
        <section class="sched-card">
          <div class="sched-card-head"><strong>Pick a time</strong><span class="tz-pick"><span>${esc(tzName(st.tz))}${st.tz === BL.guessTz() ? ' · your zone' : ''}</span><label class="sr-only" for="tz">Time zone</label><select id="tz">${BL.tzOptions(st.tz)}</select></span></div>
          ${timesHtml()}
        </section>
      </div>`;
      const strip = root.querySelector('[data-strip]');
      if (!strip) return;
      const sel = strip.querySelector('.sel');
      if (st.center && sel) { strip.scrollLeft = sel.offsetLeft - sel.offsetWidth - 8; st.center = false; } else strip.scrollLeft = left;
    }

    // More days arrive as they swipe, added to the row in place so the swipe is not interrupted.
    async function extendStrip(strip) {
      if (st.extending || !st.stripTo || st.stripTo >= maxMonth()) return;
      st.extending = true;
      const tz = st.tz, next = addMonths(st.stripTo, 1);
      try {
        await load(next);
        if (tz === st.tz) { st.stripTo = next; strip.insertAdjacentHTML('beforeend', tiles(next + '-01', next)); }
      } catch (e) { /* The next swipe tries again. */ }
      st.extending = false;
    }

    /** Phones choose a time, then press Continue, so the page's own button waits for a time. */
    function syncBar() {
      const body = root.closest('.step-body');
      const nav = body && body.parentElement.querySelector(':scope > .step-nav');
      const next = nav && nav.querySelector('[data-next]');
      if (!next) return;
      let hint = nav.querySelector('.sched-hint');
      const phone = BL.isPhone();
      if (!next.querySelector('.spinner')) next.disabled = phone && !st.selected;
      nav.classList.toggle('sched-nav', phone);
      if (!phone) { if (hint) hint.remove(); return; }
      if (!hint) { nav.insertAdjacentHTML('afterbegin', '<div class="sched-hint" role="status"></div>'); hint = nav.querySelector('.sched-hint'); }
      const text = st.selected ? `${BL.fmtDate(st.selected, st.tz, { weekday: 'short', month: 'short' })} at ${fullTime(st.selected)}` : 'Select a time to continue';
      if (hint.textContent !== text) hint.textContent = text;
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
      if (day && !day.disabled) {
        st.day = day.dataset.day;
        if (BL.isPhone()) { st.month = monthOf(st.day); if (st.allDates) { st.allDates = false; st.center = true; } }
        render(); return;
      }
      if (e.target.closest('[data-all]')) { st.allDates = !st.allDates; st.center = true; render(); return; }
      const slot = e.target.closest('[data-slot]');
      if (slot) { st.selected = slot.dataset.slot; render(); opts.onSelect && opts.onSelect(st.selected); }
    });
    root.addEventListener('change', (e) => {
      if (e.target.id === 'tz') { st.tz = e.target.value; st.day = null; st.autoJumped = false; st.stripTo = ''; st.center = true; opts.onTzChange && opts.onTzChange(st.tz); show(st.selected ? monthOf(new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(st.selected))) : monthOf(today())); }
    });

    root.addEventListener('scroll', (e) => {
      const strip = e.target;
      if (strip.matches && strip.matches('[data-strip]') && strip.scrollWidth - strip.scrollLeft - strip.clientWidth < 240) extendStrip(strip);
    }, true);

    // Turning a tablet can cross the line between the two layouts.
    const media = window.matchMedia(BL.PHONE_QUERY);
    const onResize = () => {
      if (!root.isConnected) return media.removeEventListener('change', onResize);
      st.center = true;
      show(st.month, st.day || undefined);
    };
    media.addEventListener('change', onResize);

    const startMonth = st.selected ? new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit' }).format(new Date(st.selected)).slice(0, 7) : monthOf(today());
    show(startMonth);
    return { get tz() { return st.tz; }, get selected() { return st.selected; }, refresh() { st.cache = {}; st.stripTo = ''; show(st.month); } };
  };
})();
