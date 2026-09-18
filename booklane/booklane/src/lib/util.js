'use strict';
const { HttpError } = require('./router');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const isEmail = (s) => typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s.trim());
const clampStr = (s, max = 500) => (s == null ? null : String(s).slice(0, max));
const int = (v, def = 0, min = -Infinity, max = Infinity) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const num = (v, def = 0) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
const money = (n, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(Number(n) || 0);
function assert(cond, status, msg) { if (!cond) throw new HttpError(status, msg); }
const baseUrl = () => (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
function deepMerge(target, src) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target && typeof target[k] === 'object' && !Array.isArray(target[k])) out[k] = deepMerge(target[k], v);
    else out[k] = v;
  }
  return out;
}

module.exports = { esc, slugify, isEmail, clampStr, int, num, bool, money, assert, baseUrl, deepMerge };
