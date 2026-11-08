'use strict';
// Phone notifications for the Availvo app, spoken to Apple and Google directly with no SDKs (the same
// zero-dependency rule as Twilio and Resend).
//
// iPhone: Apple Push Notification service over HTTP/2, authenticated with a short-lived ES256 token
// made from the team's .p8 key. One key works for every app on the team and never expires.
// Android: Firebase Cloud Messaging HTTP v1, authenticated with an OAuth token made from a Firebase
// service account.
//
// Every send answers { ok, dead, error }. `dead` means the provider says this install will never
// receive anything again (app deleted, token rotated), so the caller should forget the token.
const crypto = require('node:crypto');
const http2 = require('node:http2');
const config = require('./config');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * A .p8 key pasted into a one-line box loses its line breaks. Rebuild a proper PEM from whatever
 * arrived, so a key pasted either way works.
 */
function normalizePem(text, label = 'PRIVATE KEY') {
  const s = String(text || '').replace(/\\n/g, '\n').trim();
  if (!s) return '';
  const body = s.replace(/-----(BEGIN|END)[^-]*-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(body)) return '';
  return `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------- Apple

function apnsSettings() {
  return {
    keyId: config.get('APNS_KEY_ID'),
    teamId: config.get('APNS_TEAM_ID'),
    key: normalizePem(config.get('APNS_PRIVATE_KEY')),
    bundleId: config.get('APNS_BUNDLE_ID') || 'co.availvo.app',
  };
}
const apnsConfigured = () => { const s = apnsSettings(); return !!(s.keyId && s.teamId && s.key); };

let apnsJwt = null; // { token, at, fingerprint }
function apnsToken() {
  const s = apnsSettings();
  const fingerprint = `${s.keyId}:${s.teamId}:${crypto.createHash('sha256').update(s.key).digest('hex').slice(0, 12)}`;
  // Apple wants a token reused for up to an hour, and refuses one made more often than every 20 minutes.
  if (apnsJwt && apnsJwt.fingerprint === fingerprint && Date.now() - apnsJwt.at < 50 * 60000) return apnsJwt.token;
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: s.keyId }));
  const claims = b64url(JSON.stringify({ iss: s.teamId, iat: Math.floor(Date.now() / 1000) }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: s.key, dsaEncoding: 'ieee-p1363' });
  apnsJwt = { token: `${head}.${claims}.${b64url(sig)}`, at: Date.now(), fingerprint };
  return apnsJwt.token;
}

const APNS_HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const sessions = {};
function apnsSession(env) {
  const cur = sessions[env];
  if (cur && !cur.closed && !cur.destroyed) return cur;
  const s = http2.connect(APNS_HOSTS[env]);
  s.on('error', () => { /* a dropped connection is simply reopened on the next send */ });
  s.on('goaway', () => s.close());
  s.setTimeout(5 * 60000, () => s.close());
  s.unref();
  sessions[env] = s;
  return s;
}

function apnsRequest(env, deviceToken, payload, s) {
  return new Promise((resolve) => {
    let req;
    try {
      req = apnsSession(env).request({
        ':method': 'POST', ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${apnsToken()}`, 'apns-topic': s.bundleId,
        'apns-push-type': 'alert', 'apns-priority': '10', 'content-type': 'application/json',
      });
    } catch (e) { resolve({ status: 0, reason: e.message }); return; }
    let status = 0, body = '';
    req.setTimeout(10000, () => { req.close(); resolve({ status: 0, reason: 'Timed out talking to Apple' }); });
    req.on('response', (h) => { status = Number(h[':status']); });
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => { let reason = ''; try { reason = JSON.parse(body).reason || ''; } catch { /* empty body on success */ } resolve({ status, reason }); });
    req.on('error', (e) => resolve({ status: 0, reason: e.message }));
    req.end(JSON.stringify(payload));
  });
}

async function sendApns(deviceToken, msg) {
  const s = apnsSettings();
  if (!apnsConfigured()) return { ok: false, error: 'Apple notifications are not set up' };
  const payload = { aps: { alert: { title: msg.title, body: msg.body }, sound: 'default', 'thread-id': msg.thread || 'availvo' }, url: msg.url || '' };
  // App Store and TestFlight builds use production; a build run from Xcode uses the sandbox. The
  // token alone does not say which, so production is tried first and the sandbox only when Apple
  // says the token is not one of its production tokens.
  let r = await apnsRequest('production', deviceToken, payload, s);
  if (r.status === 400 && r.reason === 'BadDeviceToken') r = await apnsRequest('sandbox', deviceToken, payload, s);
  if (r.status === 200) return { ok: true };
  const dead = r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered' || r.reason === 'DeviceTokenNotForTopic';
  return { ok: false, dead, error: `Apple said ${r.status || 'nothing'}${r.reason ? ` (${r.reason})` : ''}` };
}

// ---------------------------------------------------------------- Google

function fcmAccount() {
  const raw = config.get('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    const a = JSON.parse(raw);
    const key = normalizePem(a.private_key);
    if (!a.project_id || !a.client_email || !key) return null;
    return { projectId: a.project_id, email: a.client_email, key };
  } catch { return null; }
}
const fcmConfigured = () => !!fcmAccount();

let fcmAccess = null; // { token, exp, email }
async function fcmToken(a) {
  if (fcmAccess && fcmAccess.email === a.email && fcmAccess.exp - Date.now() > 5 * 60000) return fcmAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: a.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), a.key);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }).toString(),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google refused the service account (${j.error_description || j.error || res.status})`);
  fcmAccess = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, email: a.email };
  return fcmAccess.token;
}

async function sendFcm(deviceToken, msg) {
  const a = fcmAccount();
  if (!a) return { ok: false, error: 'Android notifications are not set up' };
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.projectId)}/messages:send`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await fcmToken(a)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body },
        data: { url: msg.url || '' },
        android: { priority: 'HIGH', notification: { sound: 'default', tag: msg.thread || undefined } },
      } }),
    });
    if (res.ok) return { ok: true };
    const j = await res.json().catch(() => ({}));
    const code = ((j.error && j.error.details) || []).map((d) => d.errorCode).find(Boolean) || (j.error && j.error.status) || '';
    const dead = res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && /registration token/i.test((j.error && j.error.message) || ''));
    return { ok: false, dead, error: `Google said ${res.status}${code ? ` (${code})` : ''}` };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ---------------------------------------------------------------- shared

// Tests swap this out so nothing ever reaches Apple or Google.
let transport = { ios: sendApns, android: sendFcm };
function setTransport(t) { transport = t || { ios: sendApns, android: sendFcm }; }

async function send(platform, deviceToken, msg) {
  const fn = transport[platform];
  if (!fn) return { ok: false, error: `Unknown platform ${platform}` };
  return fn(deviceToken, msg);
}

/** Read-only check for the Integrations card: do the saved keys actually work? */
async function check() {
  const out = { ios: null, android: null };
  if (apnsConfigured()) {
    try { apnsJwt = null; apnsToken(); out.ios = { ok: true, message: 'Apple key reads correctly. Apple only confirms it fully on the first real notification.' }; }
    catch (e) { out.ios = { ok: false, message: `The .p8 key could not be read: ${e.message}` }; }
  } else out.ios = { ok: false, message: 'Not set up yet.' };
  const a = fcmAccount();
  if (a) {
    try { fcmAccess = null; await fcmToken(a); out.android = { ok: true, message: `Google accepted the service account for project ${a.projectId}.` }; }
    catch (e) { out.android = { ok: false, message: e.message }; }
  } else out.android = { ok: false, message: config.get('FCM_SERVICE_ACCOUNT') ? 'That service account JSON could not be read.' : 'Not set up yet.' };
  return out;
}

module.exports = { send, check, setTransport, apnsConfigured, fcmConfigured, normalizePem };
