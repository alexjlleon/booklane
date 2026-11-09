'use strict';
const db = require('../db');
const { token } = require('./security');
const { HttpError } = require('./router');

const COOKIE = 'bl_sess';
const TTL = 30 * 86400;
const secure = () => (process.env.BASE_URL || '').startsWith('https://');

function createSession(res, userId, businessId) {
  const t = token(32);
  db.run('INSERT INTO sessions (token, user_id, business_id, expires_at) VALUES (?,?,?,?)', t, userId, businessId || null, Date.now() + TTL * 1000);
  res.cookie(COOKIE, t, { maxAge: TTL, secure: secure(), sameSite: 'Lax' });
  return t;
}
function destroySession(req, res) {
  // Logging out while acting as someone logs the admin out too, not just back into their own account.
  if (req.session && req.session.return_token) db.run('DELETE FROM sessions WHERE token = ?', req.session.return_token);
  if (req.cookies[COOKIE]) db.run('DELETE FROM sessions WHERE token = ?', req.cookies[COOKIE]);
  res.cookie(COOKIE, '', { maxAge: 0, secure: secure() });
}

function loadSession(req) {
  const t = req.cookies[COOKIE];
  if (!t) return;
  const s = db.get('SELECT * FROM sessions WHERE token = ?', t);
  if (!s || s.expires_at < Date.now()) return;
  const user = db.get('SELECT id, email, name, timezone, phone, is_super_admin, email_verified FROM users WHERE id = ?', s.user_id);
  if (!user) return;
  let memberships = db.all("SELECT m.role, b.id, b.name, b.slug FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY b.name", user.id);
  if (s.impersonator_id) {
    // Acting as a teammate is limited to the one business it was started from, and only lasts while
    // the admin is still an admin there and the teammate is still on the team.
    const imp = db.get('SELECT id, name, email FROM users WHERE id = ?', s.impersonator_id);
    const stillAdmin = imp && db.get("SELECT 1 x FROM memberships WHERE user_id = ? AND business_id = ? AND status = 'active' AND role IN ('owner','admin')", imp.id, s.business_id);
    memberships = memberships.filter((x) => x.id === s.business_id);
    if (!stillAdmin || !memberships.length) { db.run('DELETE FROM sessions WHERE token = ?', t); return; }
    req.impersonator = imp;
    user.is_super_admin = 0;
  }
  req.session = s;
  req.user = user;
  req.memberships = memberships;
  // On a company's own domain, the admin is that company's admin, whatever was open last.
  const onDomain = req.hostBusiness ? memberships.find((x) => x.id === req.hostBusiness.id) : null;
  let m = onDomain || memberships.find((x) => x.id === s.business_id) || memberships[0];
  if (m && m.id !== s.business_id) db.run('UPDATE sessions SET business_id = ? WHERE token = ?', m.id, t);
  req.membership = m || null;
}

/**
 * Start acting as a teammate. The admin's own session is kept, untouched, so "Back to my account"
 * returns to it; the new one is short and can only see the one business.
 */
const ACT_AS_TTL = 2 * 3600;
function startActingAs(req, res, targetUserId) {
  const t = token(32);
  db.run('INSERT INTO sessions (token, user_id, business_id, expires_at, impersonator_id, return_token) VALUES (?,?,?,?,?,?)',
    t, targetUserId, req.membership.id, Date.now() + ACT_AS_TTL * 1000, req.user.id, req.session.token);
  res.cookie(COOKIE, t, { maxAge: ACT_AS_TTL, secure: secure(), sameSite: 'Lax' });
  return t;
}
/** End it and put the admin back in their own session, if that has not expired meanwhile. */
function stopActingAs(req, res) {
  const s = req.session;
  db.run('DELETE FROM sessions WHERE token = ?', s.token);
  const back = s.return_token ? db.get('SELECT * FROM sessions WHERE token = ?', s.return_token) : null;
  if (back && back.expires_at > Date.now()) {
    res.cookie(COOKIE, back.token, { maxAge: Math.floor((back.expires_at - Date.now()) / 1000), secure: secure(), sameSite: 'Lax' });
    return true;
  }
  res.cookie(COOKIE, '', { maxAge: 0, secure: secure() });
  return false;
}

/** Who to name in logs: "Alex Leon (as Zina)" while acting as someone, otherwise just the person. */
const actorName = (req) => (req.impersonator ? `${req.impersonator.name} (as ${req.user.name})` : req.user.name);

const ROLE_RANK = { host: 1, admin: 2, owner: 3 };
function requireAuth(req) {
  if (!req.user) throw new HttpError(401, 'Please log in');
}
function requireRole(min = 'host') {
  return (req) => {
    requireAuth(req);
    if (!req.membership) throw new HttpError(403, 'Create or join a business first');
    if ((ROLE_RANK[req.membership.role] || 0) < ROLE_RANK[min]) throw new HttpError(403, 'You do not have permission to do that');
  };
}

// Whoever runs Availvo itself, as opposed to the owner of one company on it.
const isPlatformAdmin = (user) => !!(user && user.is_super_admin);
function requirePlatformAdmin(req) {
  requireAuth(req);
  if (!isPlatformAdmin(req.user)) throw new HttpError(403, 'Only the Availvo platform admin can do that');
}

module.exports = { startActingAs, stopActingAs, actorName, ACT_AS_TTL, createSession, destroySession, loadSession, requireAuth, requireRole, requirePlatformAdmin, isPlatformAdmin, ROLE_RANK, COOKIE };
