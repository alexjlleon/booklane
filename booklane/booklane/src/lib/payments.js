'use strict';
// One contract, two providers.
//
// Everything that takes money -- sessions, products, forms -- goes through here and never touches
// Stripe or Square directly. Each business picks its own provider and supplies its own credentials,
// so two companies on this install can bank into two different accounts.
//
// The contract is deliberately small:
//   providerFor(bizId)      which provider this business uses, if any
//   createCheckout(...)     -> { provider, url }         a hosted page to send the buyer to
//   verifyWebhook(...)      -> the raw event, or throws  signature checked before anything is read
//   readEvent(...)          -> { kind, referenceId, ... } the same shape whoever sent it
//   refund(...)
//
// Webhooks arrive on a per-business URL. That matters: Square signs the notification URL along with
// the body, and it means we know whose signing key to check before reading a single field of an
// unverified payload.
const stripe = require('./stripe');
const square = require('./square');
const config = require('./config');
const { baseUrl } = require('./util');

const NAMES = { stripe: 'Stripe', square: 'Square' };

/** Which provider this business uses. An explicit choice wins; otherwise whichever is set up. */
function providerFor(bizId) {
  const chosen = (config.get('PAYMENT_PROVIDER', bizId) || '').trim().toLowerCase();
  if (chosen === 'square' || chosen === 'stripe') return chosen;
  if (square.configured(bizId)) return 'square';
  if (stripe.configured()) return 'stripe';
  return null;
}

function configured(bizId) {
  const p = providerFor(bizId);
  if (p === 'square') return square.configured(bizId);
  if (p === 'stripe') return stripe.configured();
  return false;
}

const liveMode = (bizId) => (providerFor(bizId) === 'square' ? square.liveMode(bizId) : stripe.liveMode());

/** The URL this business should paste into its provider's dashboard. */
const webhookUrl = (business, provider) => `${baseUrl()}/api/public/${provider || providerFor(business.id) || 'stripe'}/webhook/${business.slug}`;

/**
 * Send someone to a hosted payment page.
 *
 * `items` is the cart: [{ label, detail, unit_cents, qty }]. Both providers itemise it, so the
 * buyer sees the album and each extra on the payment page rather than one unexplained total.
 */
async function createCheckout(business, opts = {}) {
  const bizId = business.id;
  const provider = providerFor(bizId);
  if (!provider) throw new Error('Card payments are not switched on yet.');

  if (provider === 'square') {
    const out = await square.createCheckout({
      bizId,
      items: opts.items,
      amountCents: opts.amountCents,
      productName: opts.productName,
      description: opts.description,
      currency: opts.currency,
      successUrl: opts.successUrl,
      referenceId: opts.referenceId,
      customerEmail: opts.customerEmail,
      idempotencyKey: opts.idempotencyKey,
    });
    return { provider, id: out.id, url: out.url, orderId: out.orderId };
  }

  const cs = await stripe.createCheckoutSession({
    items: opts.items,
    amountCents: opts.amountCents,
    productName: opts.productName,
    description: opts.description,
    currency: opts.currency,
    successUrl: opts.successUrl,
    cancelUrl: opts.cancelUrl,
    customerEmail: opts.customerEmail,
    clientReferenceId: opts.referenceId,
    metadata: Object.assign({ order_token: opts.referenceId || '' }, opts.metadata || {}),
    expiresAt: opts.expiresAt,
    idempotencyKey: opts.idempotencyKey,
  });
  return { provider, id: cs.id, url: cs.url };
}

/** Check the signature and return the event. Throws rather than returning anything unverified. */
function verifyWebhook(provider, rawBody, headers, { business, notificationUrl } = {}) {
  if (provider === 'square') {
    return square.verifyWebhook(rawBody, headers, notificationUrl || webhookUrl(business, 'square'), business && business.id);
  }
  return stripe.verifyWebhook(rawBody, headers['stripe-signature']);
}

/**
 * Flatten a provider's event into the one shape the rest of the app understands.
 *
 * Square names the buyer's payment but not our order, so the reference has to be read back off the
 * order the payment belongs to -- one extra call, and the reason this is async.
 */
async function readEvent(provider, event, business) {
  if (provider === 'square') {
    const type = String(event.type || '');
    const obj = event.data?.object || {};
    const payment = obj.payment || obj.refund || {};
    if (/^payment\.(created|updated)$/.test(type)) {
      if (String(payment.status).toUpperCase() !== 'COMPLETED') return { kind: 'pending', id: event.event_id, status: payment.status };
      let referenceId = payment.reference_id || '';
      if (!referenceId && payment.order_id) {
        try {
          const o = await square.getOrder(payment.order_id, business.id);
          referenceId = o.order?.reference_id || '';
        } catch { /* fall through: an order we cannot read is an order we cannot match */ }
      }
      return {
        kind: 'paid', id: event.event_id, referenceId,
        paymentId: payment.id,
        amountCents: payment.amount_money?.amount ?? null,
        receiptUrl: payment.receipt_url || null,
      };
    }
    if (/^refund\.(created|updated)$/.test(type)) {
      const r = obj.refund || {};
      if (String(r.status).toUpperCase() !== 'COMPLETED') return { kind: 'pending', id: event.event_id };
      return { kind: 'refunded', id: event.event_id, paymentId: r.payment_id, amountCents: r.amount_money?.amount ?? null };
    }
    return { kind: 'ignored', id: event.event_id, type };
  }

  // Stripe
  const type = String(event.type || '');
  const obj = event.data?.object || {};
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    if (obj.payment_status && obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
      return { kind: 'pending', id: event.id, status: obj.payment_status };
    }
    const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
    return {
      kind: 'paid', id: event.id,
      referenceId: obj.client_reference_id || obj.metadata?.order_token || '',
      paymentId: pi, amountCents: obj.amount_total ?? null, receiptUrl: null,
      sessionId: obj.id,
    };
  }
  if (type === 'checkout.session.expired') return { kind: 'expired', id: event.id, referenceId: obj.client_reference_id || obj.metadata?.order_token || '', sessionId: obj.id };
  if (type === 'checkout.session.async_payment_failed') return { kind: 'failed', id: event.id, referenceId: obj.client_reference_id || obj.metadata?.order_token || '', sessionId: obj.id };
  if (type === 'charge.refunded') {
    const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : obj.payment_intent?.id;
    return { kind: 'refunded', id: event.id, paymentId: pi };
  }
  return { kind: 'ignored', id: event.id, type };
}

/**
 * Ask the provider directly whether an order was paid. The webhook is the source of truth, but it
 * can lag a second or two and the buyer is already looking at the return page.
 */
async function lookupCheckout(business, order) {
  const provider = order.provider === 'square' ? 'square' : 'stripe';
  if (provider === 'square') {
    if (!order.provider_session_id) return { paid: false };
    const res = await square.getOrder(order.provider_session_id, business.id);
    const o = res.order || {};
    const tender = (o.tenders || [])[0] || {};
    const paid = String(o.state || '').toUpperCase() === 'COMPLETED' || String(tender.card_details?.status || '').toUpperCase() === 'CAPTURED';
    return {
      paid,
      paymentId: tender.payment_id || tender.id || null,
      amountCents: o.total_money?.amount ?? null,
      receiptUrl: null,
    };
  }
  if (!order.provider_session_id) return { paid: false };
  const cs = await stripe.retrieveCheckoutSession(order.provider_session_id);
  const paid = cs && (cs.payment_status === 'paid' || cs.payment_status === 'no_payment_required');
  const pi = typeof cs?.payment_intent === 'string' ? cs.payment_intent : cs?.payment_intent?.id;
  return { paid: !!paid, paymentId: pi || null, amountCents: cs?.amount_total ?? null, receiptUrl: null, raw: cs };
}

function refund(business, { paymentId, amountCents, currency, reason }) {
  const provider = providerFor(business.id);
  if (provider === 'square') return square.refund({ bizId: business.id, paymentId, amountCents, currency, reason });
  return stripe.refund(paymentId, { amountCents, reason });
}

/** What the Integrations screen needs to know, without ever handing back a secret. */
function describe(business) {
  const bizId = business.id;
  const provider = providerFor(bizId);
  return {
    provider,
    provider_name: provider ? NAMES[provider] : null,
    configured: configured(bizId),
    mode: provider ? (liveMode(bizId) ? 'live' : 'test') : null,
    webhook_url: webhookUrl(business, provider || 'stripe'),
    stripe: { configured: stripe.configured(), webhook_url: webhookUrl(business, 'stripe') },
    square: { configured: square.configured(bizId), environment: square.environment(bizId), webhook_url: webhookUrl(business, 'square') },
  };
}

module.exports = { NAMES, providerFor, configured, liveMode, webhookUrl, createCheckout, verifyWebhook, readEvent, refund, describe, lookupCheckout };
