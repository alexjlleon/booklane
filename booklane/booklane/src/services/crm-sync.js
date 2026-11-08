'use strict';
// "They booked us" coming back from the company's CRM (BoothBook, through a Zap).
//
// BoothBook has no webhooks of its own, but Zapier's BoothBook app has a "New Booking" trigger.
// A Zap posts each new booking to this company's private address; we find that customer by email
// or phone and mark their call "booked on the call", which stops the no-show and not-booked
// follow-ups and starts any "booked on the call" automations.
//
// The address carries a per-company key, stored encrypted like the provider keys. Anyone without
// it gets a 404, the same as a company that has not switched this on.
const crypto = require('crypto');
const db = require('../db');
const { token, encrypt, decrypt } = require('../lib/security');
const { clampStr, isEmail } = require('../lib/util');
const sms = require('../lib/sms');
const B = require('./business');
const MSG = require('./messaging');

const KEY_NAME = 'CRM_BOOKED_KEY';

function keyFor(businessId) {
  const row = db.get('SELECT value FROM business_credentials WHERE business_id = ? AND key = ?', businessId, KEY_NAME);
  return row ? decrypt(row.value) : null;
}

/** Make (or replace) the key. The old address stops working at once. */
function rotateKey(businessId, userId) {
  const k = token(24);
  db.run(`INSERT INTO business_credentials (business_id, key, value, secret, updated_by, updated_at) VALUES (?,?,?,1,?,datetime('now'))
    ON CONFLICT(business_id, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')`,
  businessId, KEY_NAME, encrypt(k), userId || null);
  return k;
}
function removeKey(businessId) {
  db.run('DELETE FROM business_credentials WHERE business_id = ? AND key = ?', businessId, KEY_NAME);
}

const hookUrl = (business, key) => `${B.baseFor(business)}/api/public/hooks/crm-booked/${encodeURIComponent(business.slug)}?key=${encodeURIComponent(key)}`;

function keyMatches(businessId, given) {
  const want = keyFor(businessId);
  if (!want || !given) return false;
  const a = Buffer.from(String(want)); const b = Buffer.from(String(given));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Pull the customer out of whatever shape the Zap sends. Zapier field names vary with how the Zap
 * is mapped ("Client Email", "client__email", "E-mail"), so keys are compared loosely.
 */
function readPayload(body) {
  const flat = {};
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}_`);
      else flat[`${prefix}${k}`.toLowerCase().replace(/[^a-z0-9]+/g, '')] = v;
    }
  };
  walk(typeof body === 'object' && body ? body : {});
  const pick = (...names) => {
    for (const n of names) for (const [k, v] of Object.entries(flat)) if ((k === n || k.endsWith(n)) && v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    return '';
  };
  const email = pick('email', 'emailaddress').toLowerCase();
  const phones = Object.entries(flat).filter(([k, v]) => /(phone|telephone|mobile|cell)/.test(k) && v).map(([, v]) => sms.normalizeNumber(String(v))).filter(Boolean);
  return {
    email: isEmail(email) ? email : '',
    phones: [...new Set(phones)],
    name: pick('fullname', 'name') || [pick('firstname'), pick('lastname')].filter(Boolean).join(' '),
    external_id: clampStr(pick('bookingid', 'bookingnumber', 'reference', 'id'), 80),
    event_date: clampStr(pick('eventdate', 'date'), 40),
    total: clampStr(pick('total', 'grandtotal', 'amount', 'price'), 40),
  };
}

function remember(businessId, leadId, message, meta) {
  try { B.logActivity(businessId, leadId || null, 'crm_sync', clampStr(message, 400), meta); } catch (e) { /* log only */ }
}

/**
 * Mark the customer booked. Picks their most recent call that has happened; failing that, their
 * next upcoming one. Older calls of theirs have any remaining no-show or not-booked messages
 * cancelled, since they are a client now. Calls marked not valid are left alone.
 */
function markBooked(business, body) {
  const p = readPayload(body);
  if (!p.email && !p.phones.length) {
    remember(business.id, null, 'BoothBook booking received with no email or phone, so it could not be matched', { external_id: p.external_id });
    return { matched: false, reason: 'no email or phone in the payload' };
  }
  const rows = db.all(`SELECT b.* FROM bookings b JOIN event_types e ON e.id = b.event_type_id
    WHERE b.business_id = ? AND e.kind != 'session' AND b.status IN ('confirmed','no_show') ORDER BY b.start_utc DESC`, business.id)
    .filter((b) => (p.email && String(b.email || '').toLowerCase() === p.email) || (p.phones.length && p.phones.includes(sms.normalizeNumber(b.phone))));
  if (!rows.length) {
    remember(business.id, null, `BoothBook booking for ${p.name || p.email || p.phones[0]} matched no call in Availvo`, { email: p.email, phones: p.phones, external_id: p.external_id });
    return { matched: false, reason: 'no call found for that email or phone', email: p.email || null };
  }
  const now = Date.now();
  const past = rows.filter((b) => Date.parse(b.start_utc) <= now);
  const target = past[0] || rows[rows.length - 1];   // latest that happened, else the soonest upcoming
  const result = { matched: true, booking_id: target.id, name: target.name, already: target.outcome === 'booked' };
  if (target.outcome === 'invalid') {
    result.skipped = 'marked not a valid call';
  } else if (target.outcome !== 'booked') {
    MSG.setOutcome(target, 'booked', { by: 'BoothBook' });
  }
  // Their other calls: nothing more to chase.
  for (const b of rows) {
    if (b.id === target.id) continue;
    db.run(`UPDATE scheduled_messages SET status = 'cancelled', skip_reason = 'they booked (BoothBook)'
      WHERE booking_id = ? AND status = 'queued' AND automation_id IN (SELECT id FROM message_automations WHERE trigger IN ('no_show','not_booked'))`, b.id);
  }
  if (target.lead_id) {
    remember(business.id, target.lead_id, `Booked in BoothBook${p.external_id ? ` (#${p.external_id})` : ''}${p.event_date ? `, event ${p.event_date}` : ''}${p.total ? `, ${p.total}` : ''}`, { booking_id: target.id, external_id: p.external_id });
  } else {
    remember(business.id, null, `Booked in BoothBook: ${target.name || p.email}`, { booking_id: target.id, external_id: p.external_id });
  }
  return result;
}

/** The last few things the hook received, for the Integrations screen. */
function recent(businessId, limit = 8) {
  return db.all("SELECT message, created_at FROM activity WHERE business_id = ? AND type = 'crm_sync' ORDER BY id DESC LIMIT ?", businessId, limit);
}

module.exports = { keyFor, rotateKey, removeKey, hookUrl, keyMatches, readPayload, markBooked, recent };
