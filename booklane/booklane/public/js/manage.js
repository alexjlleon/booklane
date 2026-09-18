/* Booking confirmation + reschedule/cancel page */
(function () {
  'use strict';
  const { esc, api, icons, $ } = BL;
  const D = BL.data, biz = D.business, et = D.eventType;
  let bk = D.booking;
  const isNew = new URLSearchParams(location.search).get('new') === '1';
  const app = document.getElementById('app');
  const tz = bk.timezone || BL.guessTz();
  let mode = D.reschedule ? 'reschedule' : 'view';
  let error = null, busy = false;

  function summary() {
    return `<div class="summary">
      <div><span class="k">What</span><span class="v">${esc(bk.event_name || 'Call')}</span></div>
      <div><span class="k">When</span><span class="v">${esc(BL.fmtDate(bk.start, tz, { year: 'numeric' }))}<br>${esc(BL.fmtTime(bk.start, tz))} – ${esc(BL.fmtTime(bk.end, tz))} <span class="muted">(${esc(BL.tzLabel(tz))})</span></span></div>
      ${bk.location ? `<div><span class="k">Where</span><span class="v">${/^https?:\/\//.test(bk.location) ? `<a href="${esc(bk.location)}" target="_blank" rel="noopener">${esc(bk.location)}</a>` : esc(bk.location)}</span></div>` : ''}
      ${bk.host ? `<div><span class="k">With</span><span class="v">${esc(bk.host)}</span></div>` : ''}
      <div><span class="k">Confirmation sent to</span><span class="v">${esc(bk.email)}</span></div>
    </div>`;
  }

  function render() {
    let inner;
    if (bk.status === 'cancelled') {
      inner = `<div class="done"><div class="done-icon" style="background:#fdecec;color:var(--err)">${icons.cal.replace('<svg', '<svg width="28" height="28"')}</div><h2>This call was cancelled</h2>
        <p class="muted">${bk.cancel_reason ? 'Reason: ' + esc(bk.cancel_reason) : 'No worries. You can book a new time whenever you are ready.'}</p>
        ${et ? `<div class="actions" style="margin-top:22px"><a class="btn btn-primary btn-lg" href="/b/${esc(biz.slug)}/${esc(et.slug)}">Book a new time</a></div>` : ''}</div>`;
    } else if (mode === 'reschedule') {
      inner = `<div class="step-head"><h2>Pick a new time</h2><p>Currently ${esc(BL.fmtDate(bk.start, tz, { weekday: 'short', month: 'short' }))} at ${esc(BL.fmtTime(bk.start, tz))}</p></div>
        ${error ? `<div class="form-error">${esc(error)}</div>` : ''}<div id="scheduler"></div>
        <div class="step-nav"><button class="btn btn-link" data-mode="view">${icons.left} Keep my current time</button></div>`;
    } else if (mode === 'cancel') {
      inner = `<div class="step-head"><h2>Cancel this call?</h2><p>${esc(BL.fmtDate(bk.start, tz))} at ${esc(BL.fmtTime(bk.start, tz))}</p></div>
        ${error ? `<div class="form-error">${esc(error)}</div>` : ''}
        <div class="field"><label for="reason">Reason (optional)</label><textarea class="textarea" id="reason" placeholder="Let us know if a different time would work better"></textarea></div>
        <div class="step-nav"><button class="btn btn-link" data-mode="view">${icons.left} Never mind</button><button class="btn btn-primary" data-cancel ${busy ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : ''}Cancel call</button></div>`;
    } else {
      inner = `<div class="done"><div class="done-icon">${icons.check}</div>
        <h2>${isNew ? `You're booked${bk.name ? ', ' + esc(bk.name.split(' ')[0]) : ''}!` : 'Your upcoming call'}</h2>
        <p class="muted">${isNew ? 'A calendar invite is on its way to your inbox.' : ''}</p>${summary()}
        <div class="actions"><a class="btn btn-ghost" href="${esc(bk.google_link)}" target="_blank" rel="noopener">Add to Google Calendar</a><a class="btn btn-ghost" href="${esc(bk.ics_url)}">Apple / Outlook (.ics)</a></div>
        <div class="actions" style="margin-top:18px"><button class="btn btn-link" data-mode="reschedule">Reschedule</button><button class="btn btn-link" data-mode="cancel">Cancel</button></div>
        ${biz.settings.quote.enabled && isNew ? `<p class="small muted" style="margin-top:24px">Want to see pricing before the call? <a href="/b/${esc(biz.slug)}/quote">Build your quote</a></p>` : ''}</div>`;
    }
    app.innerHTML = `<div class="shell"><div class="card booker" style="grid-template-columns:1fr;max-width:720px"><main class="booker-main" style="min-height:0">
      <div class="biz" style="margin-bottom:18px">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>${inner}</main></div></div>${BL.powered()}`;
    if (mode === 'reschedule' && et) {
      BL.Scheduler({ root: $('#scheduler'), slug: biz.slug, eventSlug: et.slug, tz, maxDaysAhead: et.max_days_ahead, rescheduleToken: bk.token,
        onSelect: async (iso) => {
          if (!confirm(`Move your call to ${BL.fmtDate(iso, tz)} at ${BL.fmtTime(iso, tz)}?`)) return;
          try {
            await api('POST', `/api/public/bookings/${bk.token}/reschedule`, { start: iso, timezone: tz });
            const dur = Date.parse(bk.end) - Date.parse(bk.start);
            bk = Object.assign({}, bk, { start: iso, end: new Date(Date.parse(iso) + dur).toISOString() });
            mode = 'view'; error = null; render();
          } catch (e) { error = e.message; render(); }
        } });
    }
  }
  app.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { mode = m.dataset.mode; error = null; render(); return; }
    if (e.target.closest('[data-cancel]')) {
      busy = true; render();
      try { await api('POST', `/api/public/bookings/${bk.token}/cancel`, { reason: ($('#reason') || {}).value }); bk.status = 'cancelled'; bk.cancel_reason = ($('#reason') || {}).value; } catch (err) { error = err.message; }
      busy = false; mode = 'view'; render();
    }
  });
  render();
})();
