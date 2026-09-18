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
  if (req.cookies[COOKIE]) db.run('DELETE FROM sessions WHERE token = ?', req.cookies[COOKIE]);
  res.cookie(COOKIE, '', { maxAge: 0, secure: secure() });
}

function loadSession(req) {
  const t = req.cookies[COOKIE];
  if (!t) return;
  const s = db.get('SELECT * FROM sessions WHERE token = ?', t);
  if (!s || s.expires_at < Date.now()) return;
  const user = db.get('SELECT id, email, name, timezone, phone, is_super_admin FROM users WHERE id = ?', s.user_id);
  if (!user) return;
  req.session = s;
  req.user = user;
  const memberships = db.all("SELECT m.role, b.id, b.name, b.slug FROM memberships m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = ? AND m.status = 'active' ORDER BY b.name", user.id);
  req.memberships = memberships;
  let m = memberships.find((x) => x.id === s.business_id) || memberships[0];
  if (m && m.id !== s.business_id) db.run('UPDATE sessions SET business_id = ? WHERE token = ?', m.id, t);
  req.membership = m || null;
}

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

module.exports = { createSession, destroySession, loadSession, requireAuth, requireRole, ROLE_RANK, COOKIE };
