'use strict';
const crypto = require('node:crypto');

const APP_SECRET = process.env.APP_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') console.warn('[security] APP_SECRET is not set. Set it in production so sessions and stored calendar tokens stay secure.');
  return 'dev-secret-change-me-please-0123456789';
})();
const KEY = crypto.createHash('sha256').update(APP_SECRET).digest();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, s, h] = stored.split('$');
  const expected = Buffer.from(h, 'base64');
  const actual = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}
const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function decrypt(payload) {
  if (!payload) return null;
  if (!payload.startsWith('v1:')) return payload;
  try {
    const [, iv, tag, data] = payload.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// Simple in-memory fixed-window rate limiter
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 60, key = (req) => req.ip } = {}) {
  return (req) => {
    const k = key(req) + ':' + windowMs + ':' + max;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.count++;
    if (b.count > max) { const e = new Error('Too many requests, please slow down.'); e.status = 429; throw e; }
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60000).unref();

module.exports = { hashPassword, verifyPassword, token, encrypt, decrypt, rateLimit, APP_SECRET };
