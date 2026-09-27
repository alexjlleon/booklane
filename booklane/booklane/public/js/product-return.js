/* After the payment. Two jobs: reassure them the money landed, then get the design call on the
   calendar while they are still here. The same page backs the link in the confirmation email, so
   someone who closed the tab lands exactly here whenever they come back. */
(function () {
  'use strict';
  const { esc, api, icons, $ } = BL;
  const D = BL.data, biz = D.business;
  const app = document.getElementById('app');
  let order = D.order;
  const token = D.orderToken;
  let tries = 0;
  let tz = BL.guessTz();
  let slot = null;
  let busy = false;
  let error = null;
  let mode = 'auto';            // 'auto' | 'schedule' | 'later'

  const C = () => order.copy || {};

  const shell = (inner, wide) => `<div class="shell"><div class="card" style="max-width:${wide ? 760 : 560}px;margin:0 auto;padding:${wide ? '28px 24px' : '36px 28px'}">
    <div class="biz" style="justify-content:center">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
    ${inner}</div></div>${BL.powered()}`;

  const receipt = () => `<div class="cart" style="margin:18px 0">
    ${(order.items || []).map((i) => `<div class="cart-line"><span>${esc(i.label)}${i.detail ? `<span class="cart-detail">${esc(i.detail)}</span>` : ''}${i.qty > 1 ? ` <span class="muted">x${i.qty}</span>` : ''}</span><span>${esc(i.line_display)}</span></div>`).join('')}
    <div class="cart-line cart-total"><span>Paid</span><span>${esc(order.amount_display)}</span></div>
  </div>`;

  function renderWaiting() {
    app.innerHTML = shell(`
      <div class="spinner" style="margin:26px auto"></div>
      <h1 style="font-size:22px;margin:0 0 6px;text-align:center">Confirming your payment…</h1>
      <p class="muted" style="text-align:center">One moment. Please don't close this page.</p>`);
  }

  function renderBooked() {
    const when = order.booking
      ? `${BL.fmtDate(order.booking.start_utc, order.booking.timezone || tz, { weekday: 'long', month: 'long', year: 'numeric' })} at ${BL.fmtTime(order.booking.start_utc, order.booking.timezone || tz)}`
      : '';
    app.innerHTML = shell(`
      <div class="done-icon" style="margin:8px auto">${icons.check}</div>
      <h1 style="font-size:22px;margin:12px 0 6px;text-align:center">You're all set</h1>
      <p class="muted" style="text-align:center">Your album is paid for and your design call is booked${when ? ` for <b>${esc(when)}</b>` : ''}.</p>
      ${receipt()}
      ${order.booking ? `<p style="text-align:center"><a class="btn btn-link" href="/booking/${esc(order.booking.token)}">View or change the call</a></p>` : ''}`);
  }

  function renderLater() {
    app.innerHTML = shell(`
      <div class="done-icon" style="margin:8px auto">${icons.check}</div>
      <h1 style="font-size:22px;margin:12px 0 6px;text-align:center">${esc(C().paid_heading || 'Thank you')}</h1>
      <p class="muted" style="text-align:center">${esc(C().skipped_blurb || '')}</p>
      ${receipt()}
      <div style="text-align:center;margin-top:8px"><button type="button" class="btn btn-primary" data-open>${esc(C().schedule_cta || 'Pick a time')}</button></div>`);
  }

  function renderSchedule() {
    app.innerHTML = shell(`
      <h1 style="font-size:22px;margin:8px 0 6px;text-align:center">${esc(C().paid_heading || 'Thank you, that is paid for')}</h1>
      <p class="muted" style="text-align:center;margin:0 0 6px">${esc(C().paid_blurb || '')}</p>
      ${receipt()}
      ${error ? `<div class="form-error" role="alert">${esc(error)}</div>` : ''}
      <div id="scheduler"></div>
      <div class="step-nav" style="margin-top:18px">
        <div><button type="button" class="btn btn-link" data-later>${esc(C().skip_label || 'I will schedule later')}</button></div>
        <button type="button" class="btn btn-primary btn-lg" data-confirm ${busy || !slot ? 'disabled' : ''}>${busy ? '<span class="spinner"></span>' : ''}Confirm this time</button>
      </div>`, true);
    BL.Scheduler({
      root: $('#scheduler'), tz, selected: slot, maxDaysAhead: 180,
      slotsUrl: `/api/public/orders/${encodeURIComponent(token)}/slots`,
      onTzChange: (next) => { tz = next; },
      onSelect: (iso) => { slot = iso; error = null; const b = $('[data-confirm]'); if (b) b.disabled = false; },
    });
  }

  function renderProblem(heading, detail, showRetry) {
    app.innerHTML = shell(`
      <h1 style="font-size:22px;margin:18px 0 6px;text-align:center">${esc(heading)}</h1>
      <p class="muted" style="text-align:center">${esc(detail)}</p>
      <div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${showRetry ? '<button type="button" class="btn btn-primary" data-retry>Check again</button>' : ''}
        ${biz.phone ? `<a class="btn btn-link" href="tel:${esc(biz.phone)}">Call ${esc(biz.phone)}</a>` : ''}
        ${biz.email ? `<a class="btn btn-link" href="mailto:${esc(biz.email)}">Email us</a>` : ''}
      </div>`);
  }

  function route() {
    if (order.booking) return renderBooked();
    if (order.paid) {
      if (!order.followup) return renderLater();          // nothing to schedule: just the receipt
      if (mode === 'later') return renderLater();
      return renderSchedule();
    }
    if (order.status === 'expired') return renderProblem('That checkout expired', 'Nothing was charged. Start again whenever you are ready.', false);
    if (order.status === 'failed' || order.status === 'cancelled') return renderProblem('Payment did not go through', 'Nothing was charged. You can try again, or call us and we will take your order.', false);
    if (tries >= 20) return renderProblem('Still waiting on the bank', 'This is taking longer than usual. If you were charged you will have a Stripe receipt by email — forward it to us and we will sort it out.', true);
    return renderWaiting();
  }

  async function poll() {
    tries += 1;
    try {
      const r = await api('GET', `/api/public/orders/${encodeURIComponent(token)}`);
      order = r.order;
    } catch (e) { /* a network blip is not a failed payment */ }
    route();
    if (!order.paid && tries < 20) setTimeout(poll, tries < 5 ? 1200 : 2500);
  }

  async function confirm() {
    if (!slot) { error = 'Pick a time to continue.'; return route(); }
    busy = true; route();
    try {
      const r = await api('POST', `/api/public/orders/${encodeURIComponent(token)}/schedule`, { start: slot, timezone: tz });
      order = r.order;
      busy = false;
      route();
    } catch (e) {
      busy = false;
      error = e.message || 'Could not book that time.';
      if (/just taken|another time/i.test(error)) slot = null;
      route();
    }
  }

  app.addEventListener('click', (e) => {
    if (e.target.closest('[data-confirm]')) { e.preventDefault(); confirm(); }
    else if (e.target.closest('[data-later]')) { e.preventDefault(); mode = 'later'; route(); }
    else if (e.target.closest('[data-open]')) { e.preventDefault(); mode = 'schedule'; route(); }
    else if (e.target.closest('[data-retry]')) { e.preventDefault(); tries = 0; poll(); }
  });

  route();
  if (!order.paid) setTimeout(poll, 900);
})();
