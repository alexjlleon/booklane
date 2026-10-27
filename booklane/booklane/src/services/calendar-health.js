'use strict';
// Keeping connected calendars connected.
//
// A calendar sign-in can stop working without anyone noticing: the person removes access in their
// Google account, Google retires a sign-in that has sat unused for months, or the stored token can
// no longer be read. From then on the booking pages stop seeing that calendar's busy times and stop
// adding events to it, which is how double bookings happen. Nothing on the page looks wrong.
//
// So every few hours each connection is refreshed on purpose. One that needs signing in again is
// flagged, and the person and the business's owners and admins get an email with a link straight to
// the screen where they reconnect. The email repeats every few days until it is fixed, and the
// flag clears itself the moment the calendar is connected again.
const db = require('../db');
const calendars = require('./calendars');
const { esc } = require('../lib/util');

const CHECK_EVERY_MS = 6 * 3600000;
const REMIND_EVERY_MS = 3 * 86400000;
const PROVIDER_NAME = { google: 'Google Calendar', microsoft: 'Outlook calendar' };

let lastSweep = 0;

/** Who to tell about one broken connection, per business it matters to. */
function audiences(conn) {
  const owner = db.get('SELECT id, name, email, is_resource FROM users WHERE id = ?', conn.user_id);
  if (!owner) return [];
  // A market or designer calendar belongs to the business that owns its calendar profile; a person
  // belongs to every business they are an active member of.
  const bizIds = owner.is_resource
    ? db.all('SELECT DISTINCT business_id id FROM calendar_profiles WHERE user_id = ?', owner.id).map((r) => r.id)
    : db.all("SELECT business_id id FROM memberships WHERE user_id = ? AND status = 'active'", owner.id).map((r) => r.id);
  const out = [];
  for (const id of bizIds) {
    const admins = db.all("SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE m.business_id = ? AND m.status = 'active' AND m.role IN ('owner','admin') AND u.is_resource = 0", id).map((r) => r.email);
    const label = owner.is_resource
      ? (db.get('SELECT name FROM calendar_profiles WHERE user_id = ? AND business_id = ?', owner.id, id) || {}).name || 'A shared calendar'
      : owner.name || owner.email;
    const to = [...new Set([...(owner.is_resource ? [] : [owner.email]), ...admins].filter(Boolean).map((e) => e.toLowerCase()))];
    if (to.length) out.push({ businessId: id, to, label, resource: !!owner.is_resource, ownerEmail: owner.is_resource ? null : owner.email });
  }
  return out;
}

async function alert(conn) {
  const { sendEmail, layout } = require('../lib/email');
  const B = require('./business');
  const what = PROVIDER_NAME[conn.provider] || 'calendar';
  for (const a of audiences(conn)) {
    const business = B.byId(a.businessId);
    if (!business) continue;
    const who = a.resource ? `The ${a.label} calendar` : `${a.label}'s ${what}`;
    const whoHtml = esc(who);
    const acct = conn.account_email ? ` (${esc(conn.account_email)})` : '';
    await sendEmail({
      businessId: business.id,
      to: a.to,
      subject: `Action needed: reconnect ${a.resource ? `the ${a.label} calendar` : `${a.label}'s ${what}`}`,
      html: layout(business, {
        heading: `${who} needs reconnecting`,
        body: `<p style="margin:0 0 12px">${whoHtml}${acct} has stopped responding to ${esc(business.name)}'s booking pages. Until it is reconnected, bookings cannot see the busy times on it and new bookings will not be added to it, so a time that is really taken could be booked.</p>
          <p style="margin:0 0 12px">This usually means the access was removed in the ${conn.provider === 'google' ? 'Google' : 'Microsoft'} account, or the sign-in expired. Reconnecting takes about a minute.</p>
          <p style="margin:0;color:#6b6878;font-size:13px">What the calendar said: ${esc(conn.last_error || 'sign-in no longer accepted')}</p>`,
        cta: { label: 'Reconnect the calendar', url: B.linkFor(business, a.resource ? '/app#/sessions' : '/app#/calendars') },
        footer: esc('We will remind you every few days until it is reconnected.'),
      }),
    });
  }
  db.run('UPDATE calendar_connections SET alerted_at = ? WHERE id = ?', Date.now(), conn.id);
}

/** Email about every flagged connection that has not been mentioned recently. */
async function alertPending(now = Date.now()) {
  const due = db.all('SELECT * FROM calendar_connections WHERE needs_reconnect = 1 AND (alerted_at IS NULL OR alerted_at < ?)', now - REMIND_EVERY_MS);
  for (const c of due) { try { await alert(c); } catch (e) { console.warn('[calendar-health] alert failed:', e.message); } }
  return due.length;
}

/** Refresh every connection that is not already known to be broken. Runs at most every 6 hours. */
async function sweep({ force = false, now = Date.now() } = {}) {
  if (!force && now - lastSweep < CHECK_EVERY_MS) return null;
  lastSweep = now;
  const rows = db.all('SELECT * FROM calendar_connections WHERE needs_reconnect = 0');
  let broken = 0;
  for (const c of rows) {
    if (!calendars.isConfigured(c.provider)) continue;
    const r = await calendars.checkConnection(c);
    if (!r.ok && r.reconnect) broken += 1;
  }
  return { checked: rows.length, broken };
}

/** The job loop calls this every minute; it does real work only when something is due. */
async function run() {
  await sweep();
  await alertPending();
}

/** Broken connections a signed-in person should see a banner about. */
function problemsFor(userId, membership) {
  const own = db.all('SELECT id, provider, account_email, last_error FROM calendar_connections WHERE user_id = ? AND needs_reconnect = 1', userId)
    .map((c) => ({ ...c, whose: 'yours', screen: '#/calendars' }));
  if (!membership || !['owner', 'admin'].includes(membership.role)) return own;
  const others = db.all(`SELECT c.id, c.provider, c.account_email, c.last_error, u.name, u.is_resource FROM calendar_connections c JOIN users u ON u.id = c.user_id
      WHERE c.needs_reconnect = 1 AND c.user_id != ? AND (
        u.id IN (SELECT user_id FROM memberships WHERE business_id = ? AND status = 'active')
        OR u.id IN (SELECT user_id FROM calendar_profiles WHERE business_id = ?))`, userId, membership.id, membership.id)
    .map((c) => ({ id: c.id, provider: c.provider, account_email: c.account_email, last_error: c.last_error, whose: c.name || 'A team member', screen: c.is_resource ? '#/sessions' : '#/team' }));
  return own.concat(others);
}

module.exports = { run, sweep, alertPending, problemsFor, audiences, CHECK_EVERY_MS, REMIND_EVERY_MS, _reset: () => { lastSweep = 0; } };
