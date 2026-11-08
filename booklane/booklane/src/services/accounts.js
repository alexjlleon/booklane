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

/**
 * What deleting this person's account would take with it, for the confirmation screen.
 * A company goes too when they are its only owner; one with another owner stays and just loses them.
 */
function deletionPlan(userId) {
  const user = db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) return null;
  const owned = db.all(`SELECT b.id, b.name,
      (SELECT COUNT(*) FROM memberships o WHERE o.business_id = b.id AND o.role = 'owner' AND o.status = 'active' AND o.user_id != ?) other_owners,
      (SELECT COUNT(*) FROM memberships p JOIN users pu ON pu.id = p.user_id WHERE p.business_id = b.id AND p.status = 'active' AND p.user_id != ? AND pu.is_resource = 0) other_people,
      (SELECT COUNT(*) FROM bookings k WHERE k.business_id = b.id) bookings,
      (SELECT COUNT(*) FROM leads l WHERE l.business_id = b.id) leads
    FROM businesses b JOIN memberships m ON m.business_id = b.id
    WHERE m.user_id = ? AND m.role = 'owner' AND m.status = 'active' ORDER BY b.name`, userId, userId, userId);
  return {
    email: user.email,
    blocked: user.is_super_admin ? 'This is the Availvo platform admin account, which runs the whole platform. It cannot be deleted from here.' : null,
    companies_deleted: owned.filter((b) => !b.other_owners).map(({ id, name, other_people, bookings, leads }) => ({ id, name, other_people, bookings, leads })),
    companies_kept: owned.filter((b) => b.other_owners).map(({ id, name }) => ({ id, name }))
      .concat(db.all("SELECT b.id, b.name FROM businesses b JOIN memberships m ON m.business_id = b.id WHERE m.user_id = ? AND m.role != 'owner' AND m.status = 'active' ORDER BY b.name", userId)),
  };
}

function removeUploads(businessId) {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = path.join(process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'), 'uploads', String(Number(businessId)));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { console.error('[delete account] uploads', e.message); }
}

/**
 * Delete an account for good: the person, every company they alone own (with its pages, bookings,
 * leads, quotes, forms, images and market calendars), and their calendar connections, which are
 * also revoked with Google so no access is left behind. Required by the App Store and Google Play.
 */
async function deleteAccount(userId) {
  const plan = deletionPlan(userId);
  if (!plan) return null;
  if (plan.blocked) { const e = new Error(plan.blocked); e.status = 422; throw e; }
  const calendars = require('./calendars');
  const companyIds = plan.companies_deleted.map((b) => b.id);
  // Market and designer calendars belong to a company, not a person, so they go with it.
  const resources = companyIds.length ? db.all(`SELECT DISTINCT u.id FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE u.is_resource = 1 AND m.business_id IN (${companyIds.map(() => '?').join(',')})`, ...companyIds).map((r) => r.id) : [];
  const userIds = [userId, ...resources];
  const conns = db.all(`SELECT * FROM calendar_connections WHERE user_id IN (${userIds.map(() => '?').join(',')})`, ...userIds);
  db.tx(() => {
    for (const id of companyIds) {
      db.run('DELETE FROM email_log WHERE business_id = ?', id);
      db.run('DELETE FROM businesses WHERE id = ?', id);
    }
    for (const id of resources) db.run('DELETE FROM users WHERE id = ? AND is_resource = 1', id);
    db.run('DELETE FROM users WHERE id = ?', userId);
  });
  for (const id of companyIds) removeUploads(id);
  for (const c of conns) { try { await calendars.revoke(c); } catch { /* best effort */ } }
  try {
    await sendEmail({
      to: plan.email, subject: `Your ${brand.name} account was deleted`,
      html: layout(brand, {
        heading: 'Your account is deleted',
        body: `<p>Your ${esc(brand.name)} account and its login are gone.${plan.companies_deleted.length ? ` So is ${esc(plan.companies_deleted.map((b) => b.name).join(', '))}, with its booking pages, bookings, leads and settings.` : ''} Connected calendars were disconnected.</p><p>If you did not do this, reply to this email right away.</p>`,
      }),
    });
    await sendEmail({
      to: process.env.SUPPORT_EMAIL || 'alex@weddingsunlimited.com', subject: `${brand.name} account deleted: ${plan.email}`,
      html: layout(brand, { heading: 'An account was deleted', body: rows([['Email', plan.email], ['Companies deleted', plan.companies_deleted.map((b) => b.name).join(', ') || 'None'], ['Left behind in', plan.companies_kept.map((b) => b.name).join(', ') || 'None']]) }),
    });
  } catch (e) { console.error('[delete account] email', e.message); }
  return plan;
}

/**
 * A one-minute, single-use link that logs the app's user in inside the phone's real browser. Google
 * will not let anyone sign in to it inside an app's web view, so connecting a calendar from the app
 * has to happen in the browser, and this saves typing the password a second time.
 */
function issueHandoff(userId) { return issue('handoff', userId, 60 * 1000); }

function listCompanies() {
  return db.all(`SELECT b.id, b.name, b.slug, b.access, b.activated, b.suspended_at, b.created_at,
      u.name owner_name, u.email owner_email,
      (SELECT COUNT(*) FROM bookings k WHERE k.business_id = b.id) bookings,
      (SELECT COUNT(*) FROM memberships m WHERE m.business_id = b.id AND m.status = 'active') people
    FROM businesses b
    LEFT JOIN users u ON u.id = (SELECT m.user_id FROM memberships m WHERE m.business_id = b.id AND m.role = 'owner' ORDER BY m.rowid LIMIT 1)
    ORDER BY b.id DESC`);
}

module.exports = { consume, sendVerification, sendReset, markVerified, listCompanies, deletionPlan, deleteAccount, issueHandoff };
