'use strict';
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');

// Block requests to private / internal networks (SSRF). Set ALLOW_PRIVATE_URLS=true for local development.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  const allowPrivate = process.env.ALLOW_PRIVATE_URLS === 'true';
  if (u.protocol !== 'https:' && !(allowPrivate && u.protocol === 'http:')) throw new Error('URL must use https://');
  if (allowPrivate) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('URL points to a private network address');
  return u;
}
const db = require('../db');
const { logActivity } = require('./business');
const { baseUrl } = require('../lib/util');

async function sendWebhook(business, event, payload, leadId) {
  const cfg = business?.settings?.integrations?.webhook;
  if (!cfg || !cfg.enabled || !cfg.url || !(cfg.events || []).includes(event)) return { skipped: true };
  const body = JSON.stringify({ event, business: { id: business.id, slug: business.slug, name: business.name }, sent_at: new Date().toISOString(), data: payload });
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Booklane-Webhook/1.0', 'X-Booklane-Event': event };
  if (cfg.secret) headers['X-Booklane-Signature'] = 'sha256=' + crypto.createHmac('sha256', cfg.secret).update(body).digest('hex');
  try {
    await assertSafeUrl(cfg.url);
    const r = await fetch(cfg.url, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    logActivity(business.id, leadId, 'webhook', `Webhook ${event} → ${r.status}`, { status: r.status });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    logActivity(business.id, leadId, 'webhook', `Webhook ${event} failed: ${e.message}`, { error: e.message });
    return { ok: false, error: e.message };
  }
}

function buildBoothBookPayload(business, lead, quote) {
  const cfg = business.settings.integrations.boothbook;
  const answers = db.json(lead?.answers, {});
  const details = db.json(quote?.details, {});
  const lines = db.json(quote?.line_items, []);
  const contract = db.json(quote?.contract_request, null);
  const summary = [
    quote ? `Quote ${baseUrl()}/q/${quote.token}` : null,
    ...lines.map((l) => `- ${l.name}${l.options.length ? ' (' + l.options.map((o) => o.name).join(', ') + ')' : ''}${l.pricing_type !== 'flat' ? ` x${l.qty} ${l.unit_label || ''}` : ''}: $${l.amount}`),
    quote ? `Total: $${quote.total}${quote.discount ? ` (incl. $${quote.discount} discount)` : ''}` : null,
    contract?.notes ? `Notes: ${contract.notes}` : null,
    answers.notes ? `Notes: ${answers.notes}` : null,
  ].filter(Boolean).join('\n');
  const values = {
    first_name: lead?.first_name, last_name: lead?.last_name, email: lead?.email, phone: lead?.phone,
    event_date: details.event_date || answers.event_date, event_type: details.event_type || answers.event_type,
    venue: details.venue || answers.venue, guests: details.guests, notes: summary,
    quote_total: quote?.total, quote_url: quote ? `${baseUrl()}/q/${quote.token}` : null, source: 'Booklane',
    event_start_time: contract?.event_start_time, event_end_time: contract?.event_end_time,
    venue_address: contract?.venue_address, billing_address: contract?.billing_address,
  };
  const payload = { key: cfg.key, secret: cfg.secret, ...cfg.static_fields };
  for (const [ours, theirs] of Object.entries(cfg.field_map || {})) {
    if (theirs && values[ours] != null && values[ours] !== '') payload[theirs] = String(values[ours]);
  }
  return payload;
}

async function pushToBoothBook(business, lead, quote, { test = false } = {}) {
  const cfg = business.settings.integrations.boothbook;
  if (!test && (!cfg.enabled || !cfg.url)) return { skipped: true };
  if (!cfg.url) return { ok: false, error: 'BoothBook URL is not set' };
  const payload = buildBoothBookPayload(business, lead, quote);
  const isJson = cfg.format === 'json';
  let result;
  try {
    await assertSafeUrl(cfg.url);
    const r = await fetch(cfg.url, {
      redirect: 'manual',
      method: 'POST',
      headers: { 'Content-Type': isJson ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: isJson ? JSON.stringify(payload) : new URLSearchParams(payload).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = (await r.text()).slice(0, 300);
    result = { ok: r.ok, status: r.status, response: text };
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  if (quote && !test) {
    const log = db.json(quote.sync_log, []);
    log.push({ at: new Date().toISOString(), target: 'boothbook', ...result });
    db.run('UPDATE quotes SET sync_status = ?, sync_log = ? WHERE id = ?', result.ok ? 'synced' : 'failed', JSON.stringify(log.slice(-20)), quote.id);
  }
  if (lead) logActivity(business.id, lead.id, 'boothbook', result.ok ? `Pushed to BoothBook (HTTP ${result.status})` : `BoothBook push failed: ${result.error || 'HTTP ' + result.status}`, result);
  return result;
}

module.exports = { assertSafeUrl, isPrivateIp, sendWebhook, pushToBoothBook, buildBoothBookPayload };
