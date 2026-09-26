'use strict';
// Stripe Checkout with no npm packages: a form-encoded POST over https and an HMAC check on the
// webhook. Card details never reach this server -- the customer types them on Stripe's own page --
// so nothing here ever sees, logs or stores a card number.
const https = require('node:https');
const crypto = require('node:crypto');

const API_HOST = 'api.stripe.com';
const TOLERANCE_SEC = 300;

const config = require('./config');

const secretKey = () => (config.get('STRIPE_SECRET_KEY') || '').trim();
const webhookSecret = () => (config.get('STRIPE_WEBHOOK_SECRET') || '').trim();
const configured = () => /^sk_(test|live)_/.test(secretKey());
const liveMode = () => secretKey().startsWith('sk_live_');

class StripeError extends Error {
  constructor(message, { status, code, type } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

// Stripe's form encoding for nested data: a[b][c]=v, and arrays as a[0][b]=v.
function encode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (item && typeof item === 'object' ? encode(item, `${key}[${i}]`, out) : out.push(`${key}[${i}]=${encodeURIComponent(item)}`)));
    else if (typeof v === 'object') encode(v, key, out);
    else out.push(`${key}=${encodeURIComponent(typeof v === 'boolean' ? (v ? 'true' : 'false') : v)}`);
  }
  return out;
}

function request(method, path, params, { idempotencyKey, timeoutMs = 20000 } = {}) {
  if (!configured()) return Promise.reject(new StripeError('Card payments are not set up yet.', { code: 'not_configured' }));
  const body = params ? encode(params).join('&') : '';
  const headers = {
    Authorization: `Bearer ${secretKey()}`,
    'Stripe-Version': '2024-06-20',
    'User-Agent': 'Booklane (+https://github.com/alexjlleon/booklane)',
  };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  return new Promise((resolve, reject) => {
    const req = https.request({ host: API_HOST, port: 443, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* fall through to a generic error below */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        const err = json && json.error ? json.error : {};
        // Stripe's own decline messages are written for customers, so pass them through when present.
        reject(new StripeError(err.message || `Stripe returned ${res.statusCode}`, { status: res.statusCode, code: err.code, type: err.type }));
      });
    });
    req.on('error', (e) => reject(new StripeError(`Could not reach Stripe: ${e.message}`, { code: 'network' })));
    req.setTimeout(timeoutMs, () => req.destroy(new StripeError('Stripe timed out', { code: 'timeout' })));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Create a hosted Checkout page. Returns { id, url }.
 * expiresAt is a unix timestamp; Stripe requires it between 30 minutes and 24 hours out.
 */
async function createCheckoutSession({
  amountCents, currency = 'usd', productName, description, quantity = 1,
  successUrl, cancelUrl, customerEmail, clientReferenceId, metadata = {}, expiresAt, idempotencyKey,
}) {
  const cents = Math.round(Number(amountCents) || 0);
  if (!(cents > 0)) throw new StripeError('That session has no price set yet.', { code: 'no_amount' });
  const params = {
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: clientReferenceId,
    customer_email: customerEmail || undefined,
    customer_creation: 'if_required',
    allow_promotion_codes: true,
    billing_address_collection: 'auto',
    metadata,
    payment_intent_data: { description: description || productName, metadata },
    line_items: [{
      quantity: Math.max(1, Math.round(Number(quantity) || 1)),
      price_data: {
        currency: String(currency || 'usd').toLowerCase(),
        unit_amount: cents,
        product_data: { name: String(productName || 'Session').slice(0, 250), description: description ? String(description).slice(0, 500) : undefined },
      },
    }],
  };
  if (expiresAt) params.expires_at = Math.floor(expiresAt / 1000);
  const s = await request('POST', '/v1/checkout/sessions', params, { idempotencyKey });
  return { id: s.id, url: s.url, status: s.status, payment_status: s.payment_status, amount_total: s.amount_total };
}

function retrieveCheckoutSession(id) {
  return request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent`, null);
}

function expireCheckoutSession(id) {
  return request('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {});
}

function refund(paymentIntentId, { amountCents, reason } = {}) {
  return request('POST', '/v1/refunds', {
    payment_intent: paymentIntentId,
    amount: amountCents ? Math.round(amountCents) : undefined,
    reason: reason || undefined,
  });
}

/**
 * Verify a webhook against the signing secret and return the parsed event.
 * Throws if the signature does not match or the timestamp is outside the tolerance window,
 * which is what stops anyone from POSTing a fake "payment succeeded" to the endpoint.
 */
function verifyWebhook(rawBody, signatureHeader, secret = webhookSecret()) {
  if (!secret) throw new StripeError('Webhook signing secret is not set.', { code: 'no_webhook_secret' });
  if (!rawBody || !signatureHeader) throw new StripeError('Missing signature', { code: 'bad_signature' });
  const parts = {};
  for (const piece of String(signatureHeader).split(',')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    if (k === 'v1') (parts.v1 ||= []).push(v);
    else parts[k] = v;
  }
  const timestamp = parseInt(parts.t, 10);
  if (!Number.isFinite(timestamp)) throw new StripeError('Missing signature timestamp', { code: 'bad_signature' });
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SEC) throw new StripeError('Signature timestamp is too old', { code: 'stale_signature' });
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const ok = (parts.v1 || []).some((given) => {
    let buf;
    try { buf = Buffer.from(given, 'hex'); } catch { return false; }
    return buf.length === expected.length && crypto.timingSafeEqual(buf, expected);
  });
  if (!ok) throw new StripeError('Signature does not match', { code: 'bad_signature' });
  try { return JSON.parse(rawBody); } catch { throw new StripeError('Invalid webhook body', { code: 'bad_body' }); }
}

module.exports = {
  StripeError, configured, liveMode, encode, request,
  createCheckoutSession, retrieveCheckoutSession, expireCheckoutSession, refund, verifyWebhook,
};
