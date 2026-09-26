/* The page Stripe sends people back to. The webhook normally books the slot within a second or
   two; this polls until it has, and the server also asks Stripe directly so a slow webhook never
   leaves anyone stranded. */
(function () {
  'use strict';
  const { esc, api, icons } = BL;
  const D = BL.data, biz = D.business;
  const app = document.getElementById('app');
  let order = D.order;
  let tries = 0;

  const shell = (inner) => `<div class="shell"><div class="card" style="max-width:560px;margin:0 auto;padding:36px 28px;text-align:center">
    <div class="biz" style="justify-content:center">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div>
    ${inner}</div></div>${BL.powered()}`;

  function renderWaiting() {
    app.innerHTML = shell(`
      <div class="spinner" style="margin:26px auto"></div>
      <h1 style="font-size:22px;margin:0 0 6px">Confirming your payment…</h1>
      <p class="muted">Hold on a moment — we're locking in your time. Don't close this page.</p>`);
  }

  function renderDone() {
    app.innerHTML = shell(`
      <div class="done-icon" style="margin:8px auto">${icons.check}</div>
      <h1 style="font-size:22px;margin:12px 0 6px">You're booked!</h1>
      <p class="muted">Taking you to your confirmation…</p>`);
    setTimeout(() => { location.href = order.redirect; }, 700);
  }

  function renderProblem(heading, detail, showRetry) {
    app.innerHTML = shell(`
      <h1 style="font-size:22px;margin:18px 0 6px">${esc(heading)}</h1>
      <p class="muted">${esc(detail)}</p>
      <div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
        ${showRetry ? `<button type="button" class="btn btn-primary" data-retry>Check again</button>` : ''}
        ${biz.phone ? `<a class="btn btn-link" href="tel:${esc(biz.phone)}">Call ${esc(biz.phone)}</a>` : ''}
        ${biz.email ? `<a class="btn btn-link" href="mailto:${esc(biz.email)}">Email us</a>` : ''}
      </div>
      ${order.receipt_url ? `<p style="margin-top:14px"><a href="${esc(order.receipt_url)}" target="_blank" rel="noopener">View your Stripe receipt</a></p>` : ''}`);
  }

  function route() {
    if (order.redirect) return renderDone();
    if (order.status === 'paid' && !order.booking_token) {
      // They paid but the slot could not be written. Never imply it failed: their money is real.
      return renderProblem('Payment received', `We have your payment${order.amount_display ? ` of ${order.amount_display}` : ''}, but we could not finish putting the time on the calendar. Nothing is lost — call or email us and we will place it for you right away.`, true);
    }
    if (order.status === 'expired') return renderProblem('That checkout expired', 'Nothing was charged and your time was released. Start again and pick a time when you are ready.', false);
    if (order.status === 'failed' || order.status === 'cancelled') return renderProblem('Payment did not go through', 'Nothing was charged. You can try again, or call us and we will book it for you.', false);
    if (tries >= 20) return renderProblem('Still waiting on the bank', 'This is taking longer than usual. If you were charged you will have a Stripe receipt by email — forward it to us and we will confirm your time.', true);
    return renderWaiting();
  }

  async function poll() {
    tries += 1;
    try {
      const r = await api('GET', `/api/public/orders/${encodeURIComponent(order.token)}`);
      order = r.order;
    } catch (e) { /* keep waiting; a network blip is not a failed payment */ }
    route();
    if (!order.redirect && tries < 20 && ['pending', 'paid'].includes(order.status) && !order.booking_token) {
      setTimeout(poll, Math.min(3000, 600 + tries * 200));
    }
  }

  app.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) { tries = 0; renderWaiting(); poll(); } });

  route();
  if (!order.redirect) poll();
})();
