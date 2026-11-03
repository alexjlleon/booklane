'use strict';
// Self-service accounts: confirming an email, resetting a password, and the list of companies the
// platform admin looks after.
//
// Links are single use. Only a hash of each token is stored, so reading the database gives nobody
// a working link.
const crypto = require('node:crypto');
const db = require('../db');
const { token } = require('../lib/security');
const { baseUrl, esc } = require('../lib/util');
const { sendEmail, layout, rows } = require('../lib/email');

const HOUR = 3600 * 1000;
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const brand = { name: process.env.APP_NAME || 'Availvo' };

function issue(kind, userId, ttlMs) {
  db.run('DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?', userId, kind);
  db.run('DELETE FROM auth_tokens WHERE expires_at < ?', Date.now());
  const t = token(32);
  db.run('INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at) VALUES (?,?,?,?)', hash(t), userId, kind, Date.now() + ttlMs);
  return t;
}

/** Use up a link. Returns the user id, or null if it is wrong, spent or expired. */
function consume(kind, t) {
  if (!t) return null;
  const h = hash(t);
  const row = db.get('SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?', h, kind);
  if (!row) return null;
  db.run('DELETE FROM auth_tokens WHERE token_hash = ?', h);
  return row.expires_at >= Date.now() ? row.user_id : null;
}

async function sendVerification(user) {
  const t = issue('verify', user.id, 72 * HOUR);
  return sendEmail({
    to: user.email, subject: `Confirm your email to go live on ${brand.name}`,
    html: layout(brand, {
      heading: 'Confirm your email',
      body: `<p>Hi ${esc(user.name)}, press the button below and your booking pages go live. The link works for 3 days.</p>`,
      cta: { url: `${baseUrl()}/app#/verify/${t}`, label: 'Confirm my email' },
      footer: 'If you did not sign up, you can ignore this email.',
    }),
  });
}

async function sendReset(user) {
  const t = issue('reset', user.id, HOUR);
  return sendEmail({
    to: user.email, subject: `Reset your ${brand.name} password`,
    html: layout(brand, {
      heading: 'Reset your password',
      body: '<p>Press the button below to choose a new password. The link works for 1 hour.</p>',
      cta: { url: `${baseUrl()}/app#/reset/${t}`, label: 'Choose a new password' },
      footer: 'If you did not ask for this, you can ignore this email and your password stays the same.',
    }),
  });
}

/** Confirm a person and open the companies they own. Tells the platform admin about new ones. */
async function markVerified(userId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return;
  db.run('UPDATE users SET email_verified = 1 WHERE id = ?', userId);
  const waiting = db.all(`SELECT b.* FROM businesses b JOIN memberships m ON m.business_id = b.id
    WHERE m.user_id = ? AND m.role = 'owner' AND b.activated = 0`, userId);
  for (const b of waiting) {
    db.run('UPDATE businesses SET activated = 1 WHERE id = ?', b.id);
    await sendEmail({
      to: process.env.SUPPORT_EMAIL || 'alex@weddingsunlimited.com', subject: `New company on ${brand.name}: ${b.name}`,
      html: layout(brand, {
        heading: `${b.name} just signed up`,
        body: rows([['Company', b.name], ['Owner', user.name], ['Email', user.email]]),
        cta: { url: `${baseUrl()}/app#/companies`, label: 'Review it' },
        footer: 'They start with booking pages and limited email. Texting and their own domain stay off until you approve them.',
      }),
    });
  }
}

function listCompanies() {
  return db.all(`SELECT b.id, b.name, b.slug, b.access, b.activated, b.suspended_at, b.created_at,
      u.name owner_name, u.email owner_email,
      (SELECT COUNT(*) FROM bookings k WHERE k.business_id = b.id) bookings,
      (SELECT COUNT(*) FROM memberships m WHERE m.business_id = b.id AND m.status = 'active') people
    FROM businesses b
    LEFT JOIN users u ON u.id = (SELECT m.user_id FROM memberships m WHERE m.business_id = b.id AND m.role = 'owner' ORDER BY m.rowid LIMIT 1)
    ORDER BY b.id DESC`);
}

module.exports = { consume, sendVerification, sendReset, markVerified, listCompanies };
