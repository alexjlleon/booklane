'use strict';
// The Integrations screen: is each provider connected, what is missing, and does it actually work.
//
// Nothing here returns a credential. Every check asks the provider a read-only question and reports
// back what it said, so "connected" means the key was genuinely accepted rather than merely present.
const https = require('node:https');
const db = require('../db');
const config = require('../lib/config');
const sms = require('../lib/sms');
const { baseUrl } = require('../lib/util');
const { sendEmail, layout } = require('../lib/email');

// ---------------------------------------------------------------- shape

const fields = (provider, bizId) => config.keysFor(provider).map((k) => config.describe(k, bizId));

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

/**
 * Is this domain set up to send in Resend? Returns { domain, status, records } where status is
 * Resend's own word ('verified', 'pending', 'failed', 'not_added'), or 'unknown' when the key in
 * use is not allowed to read domains.
 */
async function resendDomainStatus(domain) {
  if (!domain) return null;
  if (!config.get('RESEND_API_KEY')) return { domain, status: 'no_key' };
  try {
    const list = (await resendRequest('/domains')).data || [];
    const hit = list.find((d) => String(d.name || '').toLowerCase() === domain.toLowerCase());
    if (!hit) return { domain, status: 'not_added' };
    let records = [];
    try { records = ((await resendRequest(`/domains/${encodeURIComponent(hit.id)}`)).records || []).map((r) => ({ type: r.type, name: r.name, value: r.value, status: r.status, priority: r.priority })); } catch { /* list status is enough */ }
    return { domain, status: String(hit.status || 'unknown').toLowerCase(), records };
  } catch (e) {
    if (e.status === 401 || e.status === 403) return { domain, status: 'unknown' };
    return { domain, status: 'error', message: e.message };
  }
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

function status() {
  return {
    twilio: twilioShape(),
    resend: resendShape(),
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

const CHECKS = { twilio: checkTwilio, resend: checkResend };

async function check(provider) {
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

module.exports = {
  status, check, checkTwilio, checkResend,
  sendTestEmail, sendTestSms, resendDomainStatus,
};
