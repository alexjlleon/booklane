/* Shareable quote page */
(function () {
  'use strict';
  const { esc, icons } = BL;
  const D = BL.data, biz = D.business, q = D.quote, qs = biz.settings.quote;
  const money = (n) => window.BLPricing.money(n, qs.currency);
  const d = q.details || {};
  const lineDesc = (l) => [l.options.map((o) => o.name).join(', '), l.pricing_type !== 'flat' ? `${l.qty} ${l.unit_label || ''}` : '', l.addons.map((a) => `${a.name}${a.qty > 1 ? ' ×' + a.qty : ''}`).join(', ')].filter(Boolean).join(' · ');
  const statusText = { contract_requested: 'Contract requested', contract_sent: 'Contract sent', signed: 'Booked', declined: 'Closed', submitted: 'Saved', draft: 'Draft' }[q.status] || q.status;
  const expired = q.expires_at && Date.parse(q.expires_at) < Date.now() && !['contract_requested', 'contract_sent', 'signed'].includes(q.status);
  const name = q.lead ? [q.lead.contact.first_name, q.lead.contact.last_name].filter(Boolean).join(' ') : '';
  document.getElementById('app').innerHTML = `<div class="shell"><div class="card booker" style="grid-template-columns:1fr;max-width:760px"><main class="booker-main" style="min-height:0">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px"><div class="biz">${BL.logo(biz)}<div class="biz-name">${esc(biz.name)}</div></div><span class="badge">${esc(statusText)}</span></div>
    <div class="step-head"><h2>${name ? `Quote for ${esc(name)}` : 'Your quote'}</h2><p>${esc([d.event_type, d.event_date ? BL.fmtDateStr(d.event_date) : '', d.city, d.venue, d.guests ? d.guests + ' guests' : ''].filter(Boolean).join(' · '))}</p></div>
    ${expired ? '<div class="form-error">This quote has expired. Prices may have changed, so update it to get current pricing.</div>' : ''}
    <table class="review-table">${(q.lines || []).map((l) => `<tr><td><b>${esc(l.name)}</b><div class="sub">${esc(lineDesc(l))}</div></td><td>${money(l.amount)}</td></tr>`).join('') || '<tr><td class="muted">No services selected yet</td><td></td></tr>'}
      ${q.discount ? `<tr><td style="color:var(--ok)">${esc(q.discount_label || 'Discount')}</td><td style="color:var(--ok)">−${money(q.discount)}</td></tr>` : ''}
      ${q.tax ? `<tr><td>Tax</td><td>${money(q.tax)}</td></tr>` : ''}
      <tr><td><b style="font-size:18px">Total</b>${q.deposit ? `<div class="sub">${money(q.deposit)} deposit reserves your date</div>` : ''}</td><td style="font-size:22px">${money(q.total)}</td></tr></table>
    <p class="terms">${esc(qs.terms)}${q.expires_at ? ` Quote valid until ${esc(BL.fmtDate(q.expires_at, biz.timezone, { weekday: undefined, year: 'numeric' }))}.` : ''}</p>
    <div class="actions" style="justify-content:flex-start;margin-top:18px">
      ${['draft', 'submitted'].includes(q.status) || expired ? `<a class="btn btn-primary" href="/b/${esc(biz.slug)}/quote?resume=${esc(q.token)}">${icons.doc} Continue or edit</a>` : ''}
      ${D.callEventSlug && qs.next_steps.book_call ? `<a class="btn btn-ghost" href="/b/${esc(biz.slug)}/${esc(D.callEventSlug)}?quote=${esc(q.token)}">Book a call about this quote</a>` : ''}
      <button class="btn btn-link" onclick="window.print()">Print</button>
    </div>
  </main></div></div>${BL.powered()}`;
})();
