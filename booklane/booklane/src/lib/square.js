'use strict';
// Square Checkout with no npm packages: a JSON POST over https and an HMAC check on the webhook.
//
// Card details never reach this server -- the customer types them on Square's own hosted page --
// so nothing here ever sees, logs or stores a card number. Same shape as the Stripe module next to
// it, deliberately, so the provider layer can treat the two the same.
//
// Every call takes a businessId, because two businesses on this install can be connected to two
// different Square accounts. There is no module-level "current" account.
const https = require('node:https');
const crypto = require('node:crypto');

const config = require('./config');

const HOSTS = { production: 'connect.squareup.com', sandbox: 'connect.squareupsandbox.com' };
const API_VERSION = '2026-08-20';

const token = (bizId) => (config.get('SQUARE_ACCESS_TOKEN', bizId) || '').trim();
const locationId = (bizId) => (config.get('SQUARE_LOCATION_ID', bizId) || '').trim();
const signatureKey = (bizId) => (config.get('SQUARE_WEBHOOK_SIGNATURE_KEY', bizId) || '').trim();
const environment = (bizId) => ((config.get('SQUARE_ENVIRONMENT', bizId) || 'production').trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production');
const host = (bizId) => HOSTS[environment(bizId)];
const liveMode = (bizId) => environment(bizId) === 'production';
// A location is required to create a payment link, so an access token on its own is not enough.
const configured = (bizId) => !!token(bizId) && !!locationId(bizId);

class SquareError extends Error {
  constructor(message, { status, code, category } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.category = category;
  }
}

function request(method, path, body, { bizId, timeoutMs = 20000 } = {}) {
  if (!token(bizId)) return Promise.reject(new SquareError('Card payments are not set up yet.', { code: 'not_configured' }));
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  const options = {
    host: host(bizId),
    method,
    path,
    headers: {
      Authorization: `Bearer ${token(bizId)}`,
      'Square-Version': API_VERSION,
      Accept: 'application/json',
      ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
    timeout: timeoutMs,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        // Square returns { errors: [{ category, code, detail }] }.
        const first = (parsed.errors || [])[0] || {};
        reject(new SquareError(first.detail || `Square returned ${res.statusCode}`, { status: res.statusCode, code: first.code, category: first.category }));
      });
    });
    req.on('timeout', () => { req.destroy(new SquareError('Square took too long to answer.', { code: 'timeout' })); });
    req.on('error', (e) => reject(e instanceof SquareError ? e : new SquareError(e.message, { code: 'network' })));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * A hosted checkout page. `items` is [{ label, detail, unit_cents, qty }].
 *
 * The order carries our own token as its reference_id, which is how the webhook finds the order it
 * belongs to. Square has no equivalent of Stripe's client_reference_id on the payment link itself,
 * so the reference lives on the order and we read it back off the payment.
 */
async function createCheckout({
  bizId, items, amountCents, productName, description, currency = 'USD',
  successUrl, referenceId, customerEmail, idempotencyKey,
}) {
  if (!configured(bizId)) throw new SquareError('Card payments are not set up yet.', { code: 'not_configured' });
  const cur = String(currency || 'USD').toUpperCase();
  const lines = (Array.isArray(items) && items.length ? items : [{ label: productName || 'Payment', unit_cents: amountCents, qty: 1 }])
    .map((it) => {
      const unit = Math.round(Number(it.unit_cents) || 0);
      if (!(unit > 0)) throw new SquareError('A line on that order has no price.', { code: 'no_amount' });
      return {
        name: String(it.label || 'Item').slice(0, 500),
        quantity: String(Math.max(1, Math.round(Number(it.qty) || 1))),
        base_price_money: { amount: unit, currency: cur },
        ...(it.detail ? { note: String(it.detail).slice(0, 500) } : {}),
      };
    });

  const body = {
    idempotency_key: String(idempotencyKey || crypto.randomUUID()).slice(0, 128),
    order: {
      location_id: locationId(bizId),
      reference_id: String(referenceId || '').slice(0, 40),
      line_items: lines,
    },
    checkout_options: {
      allow_tipping: false,
      ask_for_shipping_address: false,
      ...(successUrl ? { redirect_url: successUrl } : {}),
    },
    ...(customerEmail ? { pre_populated_data: { buyer_email: customerEmail } } : {}),
    ...(description ? { description: String(description).slice(0, 500) } : {}),
  };

  const res = await request('POST', '/v2/online-checkout/payment-links', body, { bizId });
  const link = res.payment_link || {};
  return {
    id: link.id,
    url: link.url || link.long_url,
    orderId: link.order_id,
    amountTotal: (res.related_resources?.orders?.[0]?.total_money?.amount) ?? null,
  };
}

/**
 * Verify a webhook. Square signs the notification URL concatenated with the raw body, so the URL
 * we were reached on has to match the one registered, character for character.
 */
function verifyWebhook(rawBody, headers = {}, notificationUrl, bizId) {
  const key = signatureKey(bizId);
  if (!key) throw new SquareError('No webhook signature key is set.', { code: 'no_signature_key' });
  const given = headers['x-square-hmacsha256-signature'] || headers['X-Square-HmacSha256-Signature'];
  if (!given) throw new SquareError('Missing signature', { code: 'no_signature' });
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto.createHmac('sha256', key).update(String(notificationUrl || '') + body).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(given));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new SquareError('Signature does not match', { code: 'bad_signature' });
  try { return JSON.parse(body); } catch { throw new SquareError('Webhook body is not JSON', { code: 'bad_body' }); }
}

const getOrder = (orderId, bizId) => request('GET', `/v2/orders/${encodeURIComponent(orderId)}`, undefined, { bizId });
const getPayment = (paymentId, bizId) => request('GET', `/v2/payments/${encodeURIComponent(paymentId)}`, undefined, { bizId });

function refund({ paymentId, amountCents, currency = 'USD', reason, bizId, idempotencyKey }) {
  return request('POST', '/v2/refunds', {
    idempotency_key: String(idempotencyKey || crypto.randomUUID()).slice(0, 128),
    payment_id: paymentId,
    amount_money: { amount: Math.round(Number(amountCents) || 0), currency: String(currency).toUpperCase() },
    ...(reason ? { reason: String(reason).slice(0, 192) } : {}),
  }, { bizId });
}

/** Cheapest call that proves the token and location are real. */
async function checkConnection(bizId) {
  const res = await request('GET', '/v2/locations', undefined, { bizId });
  const locs = res.locations || [];
  const want = locationId(bizId);
  const hit = locs.find((l) => l.id === want);
  return {
    ok: !!hit,
    mode: environment(bizId),
    location_name: hit ? hit.name : null,
    locations: locs.map((l) => ({ id: l.id, name: l.name })),
    error: hit ? null : (want ? 'That location ID is not on this Square account.' : 'No location ID set yet.'),
  };
}

module.exports = {
  SquareError, configured, liveMode, environment, locationId,
  createCheckout, verifyWebhook, refund, getOrder, getPayment, checkConnection, API_VERSION,
};
