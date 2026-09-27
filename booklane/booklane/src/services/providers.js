'use strict';
// The Integrations screen: is each provider connected, what is missing, and does it actually work.
//
// Nothing here returns a credential. Every check asks the provider a read-only question and reports
// back what it said, so "connected" means the key was genuinely accepted rather than merely present.
const https = require('node:https');
const db = require('../db');
const config = require('../lib/config');
const stripe = require('../lib/stripe');
const square = require('../lib/square');
const payments = require('../lib/payments');
const sms = require('../lib/sms');
const { baseUrl, clampStr, int } = require('../lib/util');
const { sendEmail, layout } = require('../lib/email');

const DIAGNOSTIC_NOTE = 'stripe.last_diagnostic';

// ---------------------------------------------------------------- shape

const fields = (provider, bizId) => config.keysFor(provider).map((k) => config.describe(k, bizId));

function stripeShape(business) {
  const bizId = business && business.id;
  const key = config.get('STRIPE_SECRET_KEY', bizId);
  const missing = [];
  if (!key) missing.push('STRIPE_SECRET_KEY');
  if (!config.get('STRIPE_WEBHOOK_SECRET', bizId)) missing.push('STRIPE_WEBHOOK_SECRET');
  return {
    provider: 'stripe',
    name: 'Stripe',
    what: 'Takes card payments for sessions.',
    ready: stripe.configured() && !!config.get('STRIPE_WEBHOOK_SECRET', bizId),
    mode: key ? (key.startsWith('sk_live_') ? 'live' : 'test') : null,
    missing,
    fields: fields('stripe', bizId),
    webhook: {
      url: business ? payments.webhookUrl(business, 'stripe') : `${baseUrl()}/api/public/stripe/webhook`,
      events: ['checkout.session.completed', 'checkout.session.expired', 'charge.refunded'],
      // If this is zero after a real payment, the webhook is not wired up correctly.
      received: db.get("SELECT COUNT(*) c FROM provider_events WHERE provider = 'stripe'").c,
    },
    activity: {
      paid_orders: db.get("SELECT COUNT(*) c FROM orders WHERE status = 'paid'").c,
      paid_total: (db.get("SELECT COALESCE(SUM(amount_cents),0) s FROM orders WHERE status = 'paid'").s || 0) / 100,
      stuck: db.get("SELECT COUNT(*) c FROM orders WHERE status = 'paid' AND booking_id IS NULL").c,
    },
    last_test: config.readNote(DIAGNOSTIC_NOTE),
  };
}

function squareShape(business) {
  const bizId = business && business.id;
  const token = config.get('SQUARE_ACCESS_TOKEN', bizId);
  const loc = config.get('SQUARE_LOCATION_ID', bizId);
  const missing = [];
  if (!token) missing.push('SQUARE_ACCESS_TOKEN');
  if (!loc) missing.push('SQUARE_LOCATION_ID');
  if (!config.get('SQUARE_WEBHOOK_SIGNATURE_KEY', bizId)) missing.push('SQUARE_WEBHOOK_SIGNATURE_KEY');
  return {
    provider: 'square',
    name: 'Square',
    what: 'Takes card payments, plus Cash App Pay and Afterpay, on Square-hosted checkout.',
    ready: square.configured(bizId) && !!config.get('SQUARE_WEBHOOK_SIGNATURE_KEY', bizId),
    mode: token ? square.environment(bizId) : null,
    missing,
    fields: fields('square', bizId),
    webhook: {
      url: business ? payments.webhookUrl(business, 'square') : '',
      events: ['payment.created', 'payment.updated', 'refund.updated'],
      // Square signs the notification URL as well as the body, so this has to match exactly.
      note: 'Paste this URL into Square exactly as shown. Square signs it along with the body, so even a trailing slash will make every event fail its signature check.',
      received: db.get("SELECT COUNT(*) c FROM provider_events WHERE provider = 'square'").c,
    },
    activity: {
      paid_orders: db.get("SELECT COUNT(*) c FROM orders WHERE status = 'paid' AND provider = 'square'").c,
      paid_total: (db.get("SELECT COALESCE(SUM(amount_cents),0) s FROM orders WHERE status = 'paid' AND provider = 'square'").s || 0) / 100,
    },
  };
}

function twilioShape() {
  const missing = [];
  if (!config.get('TWILIO_ACCOUNT_SID')) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.get('TWILIO_AUTH_TOKEN')) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.get('TWILIO_FROM_NUMBER') && !config.get('TWILIO_MESSAGING_SERVICE_SID')) missing.push('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
  return {
    provider: 'twilio',
    name: 'Twilio',
    what: 'Sends the text messages your automations schedule.',
    ready: sms.configured(),
    missing,
    fields: fields('twilio'),
    webhook: {
      url: `${baseUrl()}/api/public/sms/inbound`,
      label: 'Set this as "A message comes in" on your number, so replies and STOP requests reach us.',
      received: db.get("SELECT COUNT(*) c FROM sms_log WHERE direction = 'in'").c,
    },
    activity: {
      sent_7d: db.get("SELECT COUNT(*) c FROM sms_log WHERE direction = 'out' AND status != 'failed' AND created_at >= datetime('now','-7 day')").c,
      segments_7d: db.get("SELECT COALESCE(SUM(segments),0) s FROM sms_log WHERE direction = 'out' AND status != 'failed' AND created_at >= datetime('now','-7 day')").s || 0,
      failed_7d: db.get("SELECT COUNT(*) c FROM sms_log WHERE status = 'failed' AND created_at >= datetime('now','-7 day')").c,
      optouts: db.get('SELECT COUNT(*) c FROM sms_optouts').c,
    },
    // Worth saying out loud: a working key is not the same as deliverable texts in the US.
    note: 'US business texting also needs A2P 10DLC brand and campaign registration in Twilio. Until that is approved, carriers filter the messages even though Twilio accepts them.',
  };
}

function resendShape() {
  const from = config.get('EMAIL_FROM');
  const missing = [];
  if (!config.get('RESEND_API_KEY')) missing.push('RESEND_API_KEY');
  if (!from) missing.push('EMAIL_FROM');
  return {
    provider: 'resend',
    name: 'Resend',
    what: 'Sends confirmations, reminders and every other email.',
    ready: !!config.get('RESEND_API_KEY') && !!from,
    missing,
    fields: fields('resend'),
    activity: {
      sent_7d: db.get("SELECT COUNT(*) c FROM email_log WHERE status = 'sent' AND created_at >= datetime('now','-7 day')").c,
      failed_7d: db.get("SELECT COUNT(*) c FROM email_log WHERE status = 'failed' AND created_at >= datetime('now','-7 day')").c,
      // When there is no key the app logs emails instead of sending them, which is easy to miss.
      logged_only_7d: db.get("SELECT COUNT(*) c FROM email_log WHERE status = 'logged' AND created_at >= datetime('now','-7 day')").c,
    },
    note: from && !/@/.test(from) ? 'The send-from address does not look like an email address.' : null,
  };
}

function status(business) {
  const bizId = business && business.id;
  return {
    stripe: stripeShape(business),
    square: squareShape(business),
    twilio: twilioShape(),
    resend: resendShape(),
    // Which one this business takes cards through, and what it would use if nothing is chosen.
    payments: {
      chosen: (config.get('PAYMENT_PROVIDER', bizId) || '').toLowerCase() || null,
      effective: business ? payments.providerFor(bizId) : null,
      ready: business ? payments.configured(bizId) : false,
    },
    mask: config.MASK,
  };
}

// ---------------------------------------------------------------- live checks

function resendRequest(path) {
  const key = config.get('RESEND_API_KEY');
  return new Promise((resolve, reject) => {
    const req = https.request({ host: 'api.resend.com', port: 443, method: 'GET', path, headers: { Authorization: `Bearer ${key}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
        reject(Object.assign(new Error((json && (json.message || json.name)) || `Resend returned ${res.statusCode}`), { status: res.statusCode }));
      });
    });
    req.on('error', (e) => reject(new Error(`Could not reach Resend: ${e.message}`)));
    req.setTimeout(15000, () => req.destroy(new Error('Resend timed out')));
    req.end();
  });
}

async function checkStripe() {
  if (!stripe.configured()) return { ok: false, message: 'No secret key saved yet.' };
  try {
    const acct = await stripe.request('GET', '/v1/account', null);
    const live = !config.get('STRIPE_SECRET_KEY').startsWith('sk_test_');
    const bits = [];
    if (acct.business_profile && acct.business_profile.name) bits.push(acct.business_profile.name);
    if (acct.country) bits.push(acct.country);
    return {
      ok: true,
      message: `Connected to ${bits.join(' · ') || acct.id} in ${live ? 'live' : 'test'} mode.`,
      details: {
        account: acct.id,
        charges_enabled: !!acct.charges_enabled,
        payouts_enabled: !!acct.payouts_enabled,
        default_currency: acct.default_currency || null,
      },
      // A live key on an account that cannot charge yet is the trap worth naming.
      warning: live && !acct.charges_enabled ? 'This account cannot take charges yet. Finish Stripe’s onboarding before switching a session live.' : null,
    };
  } catch (e) {
    return { ok: false, message: e.message, status: e.status };
  }
}

async function checkTwilio() {
  if (!config.get('TWILIO_ACCOUNT_SID') || !config.get('TWILIO_AUTH_TOKEN')) return { ok: false, message: 'Account SID and auth token are both needed.' };
  try {
    const acct = await sms.account();
    const out = { ok: true, message: `Connected to ${acct.friendly_name || acct.sid} (${acct.status}).`, details: { status: acct.status, type: acct.type || null } };
    const number = config.get('TWILIO_FROM_NUMBER');
    if (number) {
      const found = await sms.lookupNumber(number);
      const hit = (found.incoming_phone_numbers || [])[0];
      if (!hit) out.warning = `${number} is not a number on this Twilio account, so texts will be rejected.`;
      else if (hit.capabilities && hit.capabilities.sms === false) out.warning = `${number} cannot send SMS.`;
      else out.message += ` ${number} is ready to send.`;
    } else if (config.get('TWILIO_MESSAGING_SERVICE_SID')) {
      out.message += ' Using a Messaging Service.';
    }
    if (acct.status && acct.status !== 'active') out.warning = `This Twilio account is ${acct.status}.`;
    return out;
  } catch (e) {
    return { ok: false, message: e.message, status: e.status };
  }
}

async function checkResend() {
  if (!config.get('RESEND_API_KEY')) return { ok: false, message: 'No API key saved yet.' };
  const from = config.get('EMAIL_FROM') || '';
  const domain = (from.match(/@([^>\s]+)/) || [])[1] || null;
  try {
    const r = await resendRequest('/domains');
    const list = r.data || r.domains || [];
    const match = domain ? list.find((d) => String(d.name || '').toLowerCase() === domain.toLowerCase()) : null;
    if (!domain) return { ok: true, message: 'Key accepted, but no send-from address is set.', warning: 'Set the send-from address so emails come from you.' };
    if (!list.length) return { ok: true, message: 'Key accepted. No sending domains are set up in Resend yet.', warning: `Add and verify ${domain} in Resend, or emails will not be delivered.` };
    if (!match) return { ok: true, message: `Key accepted, but ${domain} is not one of your Resend domains (${list.map((d) => d.name).join(', ')}).`, warning: `Either verify ${domain} in Resend or change the send-from address.` };
    const verified = String(match.status || '').toLowerCase() === 'verified';
    return {
      ok: true,
      message: `Key accepted and ${domain} is ${match.status}.`,
      details: { domain: match.name, status: match.status, region: match.region || null },
      warning: verified ? null : `${domain} is not verified yet, so Resend will refuse to send from it.`,
    };
  } catch (e) {
    // A restricted key can send mail but not list domains. That is fine; say so rather than failing.
    if (e.status === 401 || e.status === 403) return { ok: true, message: 'Key accepted, but it is not allowed to read domains, so verification cannot be checked here.', warning: null };
    return { ok: false, message: e.message, status: e.status };
  }
}

const CHECKS = { stripe: checkStripe, twilio: checkTwilio, resend: checkResend };
async function checkSquare(business) {
  const bizId = business && business.id;
  if (!square.configured(bizId)) return { ok: false, message: 'Save an access token and a location ID first.' };
  try {
    const r = await square.checkConnection(bizId);
    return {
      ok: r.ok,
      mode: r.mode,
      message: r.ok ? `Connected to ${r.location_name} (${r.mode}).` : r.error,
      locations: r.locations,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function check(provider, business) {
  if (provider === 'square') return { provider, ...(await checkSquare(business)) };
  const fn = CHECKS[provider];
  if (!fn) throw new Error('Unknown integration');
  return { provider, ...(await fn()) };
}

// ---------------------------------------------------------------- send a test

async function sendTestEmail(business, to) {
  const r = await sendEmail({
    to, businessId: business.id, fromName: business.name, replyTo: business.email,
    subject: `Test email from ${business.name}`,
    html: layout(business, {
      heading: 'This is a test',
      body: '<p>If you are reading this, Resend is connected and sending as you.</p><p>Nothing was sent to any customer.</p>',
    }),
  });
  if (r.status === 'failed') throw new Error(r.error || 'Resend rejected it.');
  if (r.status === 'logged') throw new Error('No Resend key is active, so the email was only written to the log.');
  return { ok: true, to, status: r.status };
}

async function sendTestSms(business, to) {
  const number = sms.normalizeNumber(to);
  if (!number) throw new Error('That does not look like a mobile number.');
  const body = `Test message from ${business.name}. Texting is connected. Reply STOP to opt out.`;
  const r = await sms.sendSms({ to: number, body });
  db.run('INSERT INTO sms_log (business_id, direction, to_addr, body, status, provider_sid, segments) VALUES (?,?,?,?,?,?,?)',
    business.id, 'out', number, `[test] ${body}`, r.status || 'sent', r.sid, r.segments);
  return { ok: true, to: number, segments: r.segments };
}

// ---------------------------------------------------------------- the $1 end-to-end test

/**
 * Prove the whole payment path, webhook included, with one real dollar.
 *
 * It deliberately does NOT charge a card from the server: it opens a Stripe Checkout page that the
 * owner completes with their own card, so no card details ever pass through this app. The point of
 * the exercise is the part that usually breaks, which is whether the webhook comes back.
 */
async function startDiagnosticCharge(business, user, { amountCents = 100 } = {}) {
  if (!stripe.configured()) throw new Error('Save a Stripe secret key first.');
  if (!config.get('STRIPE_WEBHOOK_SECRET')) throw new Error('Save the webhook signing secret first, otherwise this test cannot tell you whether the webhook works.');
  const cents = int(amountCents, 100, 50, 5000);
  const ref = `diag_${Date.now().toString(36)}`;
  const session = await stripe.createCheckoutSession({
    amountCents: cents,
    currency: 'usd',
    productName: 'Booklane connection test',
    description: 'A one-off test payment. Refund it in Stripe once it lands.',
    customerEmail: user.email,
    clientReferenceId: ref,
    // The webhook reads this and records the result instead of trying to create a booking.
    metadata: { diagnostic: '1', ref, started_by: String(user.id) },
    successUrl: `${baseUrl()}/app#/settings/integrations?tested=${ref}`,
    cancelUrl: `${baseUrl()}/app#/settings/integrations?tested=cancelled`,
    idempotencyKey: ref,
  });
  config.note(DIAGNOSTIC_NOTE, {
    ref, status: 'awaiting_payment', amount: cents / 100,
    started_at: new Date().toISOString(), started_by: user.email,
    mode: config.get('STRIPE_SECRET_KEY').startsWith('sk_live_') ? 'live' : 'test',
  });
  return { url: session.url, ref, amount: cents / 100 };
}

/** Called from the Stripe webhook when metadata says this was the connection test. */
function recordDiagnostic(event, obj) {
  const prev = config.readNote(DIAGNOSTIC_NOTE) || {};
  config.note(DIAGNOSTIC_NOTE, {
    ...prev,
    ref: (obj.metadata && obj.metadata.ref) || prev.ref || null,
    status: 'webhook_received',
    amount: typeof obj.amount_total === 'number' ? obj.amount_total / 100 : prev.amount,
    payment_intent: typeof obj.payment_intent === 'string' ? obj.payment_intent : (obj.payment_intent && obj.payment_intent.id) || null,
    event_id: event.id,
    completed_at: new Date().toISOString(),
  });
  return 'connection test recorded';
}

const lastDiagnostic = () => config.readNote(DIAGNOSTIC_NOTE);

module.exports = {
  status, check, checkStripe, checkTwilio, checkResend,
  sendTestEmail, sendTestSms, startDiagnosticCharge, recordDiagnostic, lastDiagnostic, DIAGNOSTIC_NOTE,
};
