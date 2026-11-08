'use strict';
// Who gets a phone notification, and remembering which phones they have.
//
// Notifications follow the emails the team already gets, so nobody is told about something on their
// phone that they would not also have been emailed about:
//   bookings - the host of a call: booked, moved, cancelled, or passed to them
//   leads    - whoever gets contract-request alerts
//   replies  - whoever gets "a customer texted back" alerts
// Each person can switch any of the three off on their account page. Sending never throws and never
// holds up the thing that caused it.
const db = require('../db');
const push = require('../lib/push');
const { clampStr } = require('../lib/util');

const CATEGORIES = ['bookings', 'leads', 'replies'];
const PLATFORMS = ['ios', 'android'];

function prefsOf(user) {
  const p = db.json(user && user.push_prefs, {}) || {};
  return Object.fromEntries(CATEGORIES.map((c) => [c, p[c] !== false]));
}

function setPrefs(userId, patch) {
  const user = db.get('SELECT push_prefs FROM users WHERE id = ?', userId);
  const next = prefsOf(user);
  for (const c of CATEGORIES) if (patch && typeof patch[c] === 'boolean') next[c] = patch[c];
  db.run('UPDATE users SET push_prefs = ? WHERE id = ?', JSON.stringify(next), userId);
  return next;
}

/** An install says hello. The same token moving to another login moves with it. */
function register(userId, { platform, token, app_version, device_name } = {}) {
  const t = String(token || '').trim();
  if (!PLATFORMS.includes(platform) || t.length < 20 || t.length > 4096 || /\s/.test(t)) return null;
  db.run(`INSERT INTO push_devices (user_id, platform, token, app_version, device_name) VALUES (?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, platform = excluded.platform, app_version = excluded.app_version,
      device_name = excluded.device_name, last_error = NULL, last_seen_at = datetime('now')`,
  userId, platform, t, clampStr(app_version, 40), clampStr(device_name, 80));
  return db.get('SELECT id, platform, device_name, app_version, created_at, last_seen_at FROM push_devices WHERE token = ?', t);
}

function unregister(userId, token) {
  return db.run('DELETE FROM push_devices WHERE user_id = ? AND token = ?', userId, String(token || '')).changes;
}

function devicesFor(userId) {
  return db.all('SELECT id, platform, device_name, app_version, last_error, created_at, last_seen_at FROM push_devices WHERE user_id = ? ORDER BY last_seen_at DESC', userId);
}
function removeDevice(userId, id) {
  return db.run('DELETE FROM push_devices WHERE user_id = ? AND id = ?', userId, id).changes;
}

const configured = () => ({ ios: push.apnsConfigured(), android: push.fcmConfigured() });

/** Send one message to every phone of these people who want this kind of notification. */
async function notifyUsers(userIds, category, msg) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(Number))];
  if (!ids.length) return { sent: 0, failed: 0 };
  let sent = 0, failed = 0;
  for (const uid of ids) {
    const user = db.get('SELECT id, push_prefs FROM users WHERE id = ?', uid);
    if (!user || (category && !prefsOf(user)[category])) continue;
    for (const d of db.all('SELECT * FROM push_devices WHERE user_id = ?', uid)) {
      let r;
      try { r = await push.send(d.platform, d.token, { title: clampStr(msg.title, 120), body: clampStr(msg.body, 240), url: msg.url, thread: category }); }
      catch (e) { r = { ok: false, error: e.message }; }
      if (r.ok) { sent++; db.run("UPDATE push_devices SET last_error = NULL WHERE id = ?", d.id); continue; }
      failed++;
      if (r.dead) db.run('DELETE FROM push_devices WHERE id = ?', d.id);
      else db.run('UPDATE push_devices SET last_error = ? WHERE id = ?', clampStr(r.error, 300), d.id);
    }
  }
  return { sent, failed };
}

/** Fire and forget, for use next to an email that is already going out. */
function notify(userIds, category, msg) {
  notifyUsers(userIds, category, msg).catch((e) => console.error('[push]', e.message));
}

/** Members of a company whose address is on an alert list. Lists can name outsiders; they get email only. */
function membersWithEmails(businessId, emails) {
  const wanted = new Set((emails || []).map((e) => String(e).toLowerCase()));
  if (!wanted.size) return [];
  return db.all("SELECT u.id, u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active'", businessId)
    .filter((u) => wanted.has(String(u.email).toLowerCase())).map((u) => u.id);
}

module.exports = { CATEGORIES, prefsOf, setPrefs, register, unregister, devicesFor, removeDevice, configured, notifyUsers, notify, membersWithEmails };
