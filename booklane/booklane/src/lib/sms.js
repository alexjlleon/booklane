'use strict';
// Twilio with no npm packages: a form-encoded POST over https, plus signature checking on the
// inbound webhook so nobody can forge a "STOP" or a fake reply.
const https = require('node:https');
const crypto = require('node:crypto');

const API_HOST = 'api.twilio.com';

const config = require('./config');

const sid = () => (config.get('TWILIO_ACCOUNT_SID') || '').trim();
const authToken = () => (config.get('TWILIO_AUTH_TOKEN') || '').trim();
const fromNumber = () => (config.get('TWILIO_FROM_NUMBER') || '').trim();
const messagingService = () => (config.get('TWILIO_MESSAGING_SERVICE_SID') || '').trim();
const configured = () => /^AC[0-9a-f]{32}$/i.test(sid()) && !!authToken() && !!(fromNumber() || messagingService());

class SmsError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.status = status; this.code = code; }
}

/** US/CA-friendly E.164. Returns null when it clearly is not a dialable number. */
function normalizeNumber(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Refuse anything else. "832-555-1234 ext 2" would otherwise become +83255512342 and text a
  // stranger; a number we cannot read confidently is better skipped than guessed at.
  return null;
}

/**
 * GSM-7 vs UCS-2 segment maths. Worth showing in the editor: one stray curly quote or emoji
 * flips a message to 70 characters per segment and quietly triples the bill.
 */
const GSM = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
function segmentInfo(text) {
  const s = String(text || '');
  let unicode = false;
  let units = 0;
  for (const ch of s) {
    if (GSM.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    // UCS-2 counts UTF-16 code units, so an emoji outside the BMP costs two.
    units = s.length;
    const per = units <= 70 ? 70 : 67;
    return { encoding: 'UCS-2', units, segments: Math.max(1, Math.ceil(units / per)) };
  }
  const per = units <= 160 ? 160 : 153;
  return { encoding: 'GSM-7', units, segments: Math.max(1, Math.ceil(units / per)) };
}

function request(path, params, { timeoutMs = 20000, method = 'POST' } = {}) {
  const body = method === 'GET' ? '' : Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const auth = Buffer.from(`${sid()}:${authToken()}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: API_HOST, port: 443, method, path,
      headers: {
        Authorization: `Basic ${auth}`,
        ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* fall through */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        reject(new SmsError((json && json.message) || `Twilio returned ${res.statusCode}`, { status: res.statusCode, code: json && json.code }));
      });
    });
    req.on('error', (e) => reject(new SmsError(`Could not reach Twilio: ${e.message}`, { code: 'network' })));
    req.setTimeout(timeoutMs, () => req.destroy(new SmsError('Twilio timed out', { code: 'timeout' })));
    if (body) req.write(body);
    req.end();
  });
}

/** Send one text. Returns { sid, status, segments }. */
async function sendSms({ to, body, statusCallback }) {
  if (!configured()) throw new SmsError('Text messaging is not set up yet.', { code: 'not_configured' });
  const number = normalizeNumber(to);
  if (!number) throw new SmsError('That does not look like a mobile number.', { code: 'bad_number' });
  const text = String(body || '').trim();
  if (!text) throw new SmsError('The message is empty.', { code: 'empty' });
  const params = { To: number, Body: text.slice(0, 1600), StatusCallback: statusCallback || undefined };
  // A Messaging Service handles number pools and 10DLC registration, so prefer it when present.
  if (messagingService()) params.MessagingServiceSid = messagingService();
  else params.From = fromNumber();
  const r = await request(`/2010-04-01/Accounts/${encodeURIComponent(sid())}/Messages.json`, params);
  return { sid: r.sid, status: r.status, segments: segmentInfo(text).segments, to: number };
}

/**
 * Verify an inbound Twilio request. Twilio signs the full URL plus the sorted POST body with the
 * auth token, so a forged "STOP" from anywhere else fails here.
 */
function verifyWebhook(url, params, signatureHeader, token = authToken()) {
  if (!token) throw new SmsError('Twilio auth token is not set.', { code: 'no_token' });
  if (!signatureHeader) throw new SmsError('Missing signature', { code: 'bad_signature' });
  const data = Object.keys(params || {}).sort().reduce((acc, k) => acc + k + params[k], String(url));
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest();
  let given;
  try { given = Buffer.from(String(signatureHeader), 'base64'); } catch { throw new SmsError('Bad signature encoding', { code: 'bad_signature' }); }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new SmsError('Signature does not match', { code: 'bad_signature' });
  return true;
}

// What counts as opting out, and what undoes it. Twilio intercepts these for its own list too;
// we keep our own so the rule holds even if the number or provider changes later.
const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout', 'opt-out'];
const START_WORDS = ['start', 'unstop', 'yes', 'subscribe', 'optin', 'opt-in'];
const keywordOf = (body) => {
  const w = String(body || '').trim().toLowerCase().replace(/[.!,]+$/, '');
  if (STOP_WORDS.includes(w)) return 'stop';
  if (START_WORDS.includes(w)) return 'start';
  if (w === 'help' || w === 'info') return 'help';
  return null;
};

/** Read-only calls used by the connection check. */
const account = () => request(`/2010-04-01/Accounts/${encodeURIComponent(sid())}.json`, null, { method: 'GET' });
const lookupNumber = (number) => request(`/2010-04-01/Accounts/${encodeURIComponent(sid())}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`, null, { method: 'GET' });

module.exports = { SmsError, configured, sendSms, normalizeNumber, segmentInfo, verifyWebhook, keywordOf, fromNumber, messagingService, accountSid: sid, account, lookupNumber };
