/* Month calendar + time slot picker */
(function () {
  'use strict';
  const { esc, api, icons } = BL;

  BL.Scheduler = function (opts) {
    const st = { tz: opts.tz, month: null, day: null, selected: opts.selected || null, cache: {}, loading: false, autoJumped: false };
    const root = opts.root;
    const today = () => BL.todayIn(st.tz);
    const monthOf = (d) => d.slice(0, 7);
    const addMonths = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
    const lastDay = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
    const maxMonth = () => { const d = new Date(Date.now() + (opts.maxDaysAhead || 60) * 86400000); return new Intl.DateTimeFormat('en-CA', { timeZone: st.tz, year: 'numeric', month: '2-digit' }).format(d).slice(0, 7); };

    async function load(month) {
      const key = st.tz + '|' + month;
      if (st.cache[key]) return st.cache[key];
      const from = month === monthOf(today()) ? today() : month + '-01';
      const q = new URLSearchParams({ from, to: lastDay(month), tz: st.tz });
      if (opts.rescheduleToken) q.set('reschedule', opts.rescheduleToken);
      const data = await api('GET', `/api/public/b/${encodeURIComponent(opts.slug)}/e/${encodeURIComponent(opts.eventSlug)}/slots?${q}`);
      st.cache[key] = data.days || {};
      return st.cache[key];
    }

    async function show(month) {
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
      if (!st.day || monthOf(st.day) !== month || !days[st.day]) st.day = avail[0] || null;
      render();
    }

    function render() {
      const month = st.month;
      const days = st.cache[st.tz + '|' + month] || {};
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
