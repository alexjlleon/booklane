'use strict';
const db = require('../db');
const Pricing = require('../../public/js/pricing.js');
const { token } = require('../lib/security');
const { HttpError } = require('../lib/router');
const { clampStr, baseUrl, esc, isEmail, money } = require('../lib/util');
const { sendEmail, layout, rows } = require('../lib/email');
const B = require('./business');
const L = require('./leads');
const { sendWebhook, pushToBoothBook } = require('./integrations');

function hydrateService(s) {
  if (!s) return s;
  s.option_groups = db.json(s.option_groups, []);
  s.addons = db.json(s.addons, []);
  s.active = !!s.active;
  return s;
}
const catalog = (businessId, { all = false } = {}) =>
  db.all(`SELECT * FROM services WHERE business_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, id`, businessId).map(hydrateService);

function sanitizeSelections(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((s) => s && typeof s === 'object').slice(0, 40).map((s) => ({
    service_id: Number(s.service_id), qty: Number(s.qty) || undefined,
    options: Object.fromEntries(Object.entries(s.options || {}).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 40)) : String(v ?? '').slice(0, 40)])),
    addons: Object.fromEntries(Object.entries(s.addons || {}).slice(0, 40).map(([k, v]) => [String(k).slice(0, 40), Math.max(0, Math.min(999, Number(v) || 0))])),
  })).filter((s) => Number.isFinite(s.service_id));
}

// The details step is configurable, so any field id the business defined is allowed through,
// alongside the built-ins other parts of the app (emails, BoothBook mapping) still read by name.
function sanitizeDetails(d, business) {
  d = d && typeof d === 'object' ? d : {};
  const out = { event_type: clampStr(d.event_type, 80), event_date: /^\d{4}-\d{2}-\d{2}$/.test(d.event_date || '') ? d.event_date : null,
    venue: clampStr(d.venue, 200), city: clampStr(d.city, 120), guests: clampStr(d.guests, 40), notes: clampStr(d.notes, 3000) };
  for (const f of (business && business.settings && business.settings.quote.fields) || []) {
    if (out[f.id] !== undefined) continue;
    const v = d[f.id];
    out[f.id] = Array.isArray(v) ? v.slice(0, 40).map((x) => clampStr(x, 120)) : clampStr(v, 500);
  }
  return out;
}

function recalc(business, quote, selections) {
  const calc = Pricing.calculate(catalog(business.id), selections, business.settings.quote);
  db.run(`UPDATE quotes SET selections = ?, line_items = ?, subtotal = ?, discount = ?, tax = ?, total = ?, deposit = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(selections), JSON.stringify(calc.lines), calc.subtotal, calc.discount, calc.tax, calc.total, calc.deposit, quote.id);
  return calc;
}

function createQuote(business, lead) {
  const t = token(18);
  const expires = new Date(Date.now() + (business.settings.quote.expires_days || 14) * 86400000).toISOString();
  const { lastId } = db.run('INSERT INTO quotes (business_id, lead_id, token, expires_at) VALUES (?,?,?,?)', business.id, lead.id, t, expires);
  return db.get('SELECT * FROM quotes WHERE id = ?', lastId);
}
const byToken = (t) => db.get('SELECT * FROM quotes WHERE token = ?', String(t || ''));

function publicQuote(q, business) {
  const lead = q.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', q.lead_id) : null;
  const calc = { lines: db.json(q.line_items, []), subtotal: q.subtotal, discount: q.discount, tax: q.tax, total: q.total, deposit: q.deposit };
  const fresh = Pricing.calculate(catalog(business.id), db.json(q.selections, []), business.settings.quote);
  return {
    token: q.token, status: q.status, details: db.json(q.details, {}), selections: db.json(q.selections, []), ...calc,
    discount_label: fresh.discount_label, tax_rate: fresh.tax_rate, next_bundle: fresh.next_bundle,
    next_step: q.next_step, contract_request: db.json(q.contract_request, null), callback_request: db.json(q.callback_request, null),
    expires_at: q.expires_at, created_at: q.created_at, updated_at: q.updated_at, lead: lead ? L.publicLead(lead) : null, url: `${baseUrl()}/q/${q.token}`,
  };
}

function quotePayload(q, business) {
  const p = publicQuote(q, business);
  delete p.lead;
  return p;
}

function quoteSummaryHtml(q, business) {
  const cur = business.settings.quote.currency;
  const lines = db.json(q.line_items, []);
  const details = db.json(q.details, {});
  const lineRows = lines.map((l) => [
    `${l.name}${l.options.length ? ` (${l.options.map((o) => o.name).join(', ')})` : ''}${l.pricing_type !== 'flat' ? ` × ${l.qty} ${l.unit_label || ''}` : ''}${l.addons.length ? ` + ${l.addons.map((a) => `${a.name}${a.qty > 1 ? ' ×' + a.qty : ''}`).join(', ')}` : ''}`,
    money(l.amount, cur)]);
  return rows([['Event', [details.event_type, details.event_date].filter(Boolean).join(' · ')], ['Venue', [details.venue, details.city].filter(Boolean).join(', ')], ['Guests', details.guests]]) +
    rows([...lineRows, q.discount ? ['Discount', '−' + money(q.discount, cur)] : null, q.tax ? ['Tax', money(q.tax, cur)] : null, ['Total', money(q.total, cur)], q.deposit ? ['Deposit to book', money(q.deposit, cur)] : null].filter(Boolean));
}

function requireContact(lead) {
  const errors = {};
  if (!lead.first_name) errors.first_name = 'Required';
  if (!isEmail(lead.email || '')) errors.email = 'Enter a valid email';
  if (Object.keys(errors).length) throw new HttpError(422, 'We need your name and email first', errors);
}

async function notifyTeam(business, q, lead, subject, heading, extraPairs = []) {
  await sendEmail({
    to: B.teamEmails(business), businessId: business.id, subject,
    html: layout(business, {
      heading,
      body: rows([['Name', L.leadName(lead)], ['Email', lead.email], ['Phone', lead.phone], ...extraPairs]) + quoteSummaryHtml(q, business),
      cta: { label: 'Open lead', url: `${baseUrl()}/app#/leads/${lead.id}` },
    }),
  });
}

async function submitQuote(business, q, lead) {
  requireContact(lead);
  if (q.status === 'draft') db.run("UPDATE quotes SET status = 'submitted', updated_at = datetime('now') WHERE id = ?", q.id);
  if (lead.status === 'partial') L.setStatus(lead, 'quoted', { complete: true });
  const fresh = byToken(q.token);
  B.logActivity(business.id, lead.id, 'quote', `Built a quote for ${money(fresh.total, business.settings.quote.currency)}`, { quote_id: q.id });
  await sendEmail({
    to: lead.email, businessId: business.id, fromName: business.name, replyTo: business.email,
    subject: `Your ${business.name} quote: ${money(fresh.total, business.settings.quote.currency)}`,
    html: layout(business, { heading: `Here's your quote, ${esc(lead.first_name)}`, body: quoteSummaryHtml(fresh, business) + `<p style="color:#8a8697;font-size:13px">${esc(business.settings.quote.terms)}</p>`, cta: { label: 'View or update your quote', url: `${baseUrl()}/q/${q.token}` } }),
  });
  if (business.settings.notifications.notify_on_quote) await notifyTeam(business, fresh, lead, `New quote: ${L.leadName(lead)} · ${money(fresh.total, business.settings.quote.currency)}`, 'A customer built a quote');
  await sendWebhook(business, 'quote.submitted', { quote: quotePayload(fresh, business), lead: L.leadPayload(db.get('SELECT * FROM leads WHERE id = ?', lead.id)) }, lead.id);
  return fresh;
}

async function requestContract(business, q, lead, body) {
  requireContact(lead);
  if (!db.json(q.line_items, []).length) throw new HttpError(422, 'Add at least one service to your quote first');
  const cf = business.settings.quote.contract_fields;
  const req = {
    legal_name: clampStr(body.legal_name || L.leadName(lead), 160),
    billing_address: cf.billing_address ? clampStr(body.billing_address, 300) : undefined,
    venue_address: cf.venue_address ? clampStr(body.venue_address, 300) : undefined,
    event_start_time: cf.event_start_time ? clampStr(body.event_start_time, 20) : undefined,
    event_end_time: cf.event_end_time ? clampStr(body.event_end_time, 20) : undefined,
    planner_name: cf.planner_name ? clampStr(body.planner_name, 160) : undefined,
    notes: clampStr(body.notes, 3000), agreed_terms: !!body.agreed_terms, requested_at: new Date().toISOString(),
  };
  const details = db.json(q.details, {});
  if (business.settings.quote.require_event_date && !details.event_date) throw new HttpError(422, 'Add your event date so we can check availability', { event_date: 'Required' });
  db.run("UPDATE quotes SET status = 'contract_requested', next_step = 'contract', contract_request = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(req), q.id);
  L.setStatus(lead, 'contract_requested', { complete: true });
  const fresh = byToken(q.token);
  B.logActivity(business.id, lead.id, 'contract', `Requested a contract for ${money(fresh.total, business.settings.quote.currency)}`, { quote_id: q.id });

  await sendEmail({
    to: lead.email, businessId: business.id, fromName: business.name, replyTo: business.email,
    subject: `We got your contract request, ${lead.first_name}!`,
    html: layout(business, { heading: 'Contract request received', body: `<p>Thanks! Our team is checking availability for your date and will send your contract shortly. Here's what you requested:</p>${quoteSummaryHtml(fresh, business)}`, cta: { label: 'View your quote', url: `${baseUrl()}/q/${q.token}` } }),
  });
  if (business.settings.notifications.notify_on_contract) {
    await notifyTeam(business, fresh, lead, `Contract requested: ${L.leadName(lead)} · ${money(fresh.total, business.settings.quote.currency)}`, 'Send this customer a contract',
      [['Legal name', req.legal_name], ['Billing address', req.billing_address], ['Venue address', req.venue_address], ['Event time', [req.event_start_time, req.event_end_time].filter(Boolean).join(' – ')], ['Planner', req.planner_name], ['Notes', req.notes]]);
  }
  const leadNow = db.get('SELECT * FROM leads WHERE id = ?', lead.id);
  const bb = (business.settings.integrations.boothbook.push_on || []).includes('contract.requested') ? await pushToBoothBook(business, leadNow, fresh) : { skipped: true };
  await sendWebhook(business, 'contract.requested', { quote: quotePayload(byToken(q.token), business), lead: L.leadPayload(leadNow), contract_request: req }, lead.id);
  return { quote: byToken(q.token), boothbook: bb.skipped ? 'skipped' : bb.ok ? 'synced' : 'failed' };
}

async function requestCallback(business, q, lead, body) {
  const errors = {};
  if (!lead.first_name) errors.first_name = 'Required';
  if (String(lead.phone || '').replace(/\D/g, '').length < 7) errors.phone = 'We need a phone number to call you';
  if (Object.keys(errors).length) throw new HttpError(422, 'Add your name and phone number so we can call you', errors);
  const req = { preferred_day: clampStr(body.preferred_day, 40), preferred_time: clampStr(body.preferred_time, 40), notes: clampStr(body.notes, 2000), requested_at: new Date().toISOString() };
  db.run("UPDATE quotes SET next_step = 'callback', callback_request = ?, status = CASE WHEN status = 'draft' THEN 'submitted' ELSE status END, updated_at = datetime('now') WHERE id = ?", JSON.stringify(req), q.id);
  if (['partial', 'quoted'].includes(lead.status)) L.setStatus(lead, 'callback_requested', { complete: true });
  const fresh = byToken(q.token);
  B.logActivity(business.id, lead.id, 'callback', `Asked for a call back (${[req.preferred_day, req.preferred_time].filter(Boolean).join(', ') || 'any time'})`);
  if (business.settings.notifications.notify_on_callback) {
    await notifyTeam(business, fresh, lead, `Call back requested: ${L.leadName(lead)} ${lead.phone}`, 'Please call this customer', [['Best day', req.preferred_day], ['Best time', req.preferred_time], ['Notes', req.notes]]);
  }
  await sendEmail({
    to: lead.email, businessId: business.id, fromName: business.name, replyTo: business.email,
    subject: `We'll call you soon, ${lead.first_name}`,
    html: layout(business, { heading: 'Talk soon!', body: `<p>We'll call you at <b>${esc(lead.phone)}</b>${req.preferred_time ? ` (${esc([req.preferred_day, req.preferred_time].filter(Boolean).join(', '))})` : ''} to go over your quote.</p>`, cta: { label: 'View your quote', url: `${baseUrl()}/q/${q.token}` } }),
  });
  await sendWebhook(business, 'callback.requested', { quote: quotePayload(fresh, business), lead: L.leadPayload(db.get('SELECT * FROM leads WHERE id = ?', lead.id)), callback: req }, lead.id);
  return fresh;
}

module.exports = { catalog, hydrateService, sanitizeSelections, sanitizeDetails, recalc, createQuote, byToken, publicQuote, quotePayload, submitQuote, requestContract, requestCallback, quoteSummaryHtml };
