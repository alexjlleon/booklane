'use strict';
// Provider credentials, managed from the admin screen.
//
// Values are encrypted at rest with APP_SECRET, the same way connected calendar tokens already are.
// An environment variable is used when nothing is stored, so a deployment that sets these in
// Railway keeps working untouched; saving one in the app takes precedence from then on.
//
// Nothing in here ever returns a secret to the browser. `describe()` is what the admin screen gets:
// whether it is set, where it came from, and a masked tail.
const db = require('../db');
const { encrypt, decrypt } = require('./security');

// Every credential the app knows about. `secret: true` means encrypt it and never show it again.
const KEYS = {
  STRIPE_SECRET_KEY: { secret: true, provider: 'stripe', label: 'Secret key' },
  STRIPE_WEBHOOK_SECRET: { secret: true, provider: 'stripe', label: 'Webhook signing secret' },
  TWILIO_ACCOUNT_SID: { secret: false, provider: 'twilio', label: 'Account SID' },
  TWILIO_AUTH_TOKEN: { secret: true, provider: 'twilio', label: 'Auth token' },
  TWILIO_FROM_NUMBER: { secret: false, provider: 'twilio', label: 'From number' },
  TWILIO_MESSAGING_SERVICE_SID: { secret: false, provider: 'twilio', label: 'Messaging Service SID' },
  RESEND_API_KEY: { secret: true, provider: 'resend', label: 'API key' },
  EMAIL_FROM: { secret: false, provider: 'resend', label: 'Send from' },
};

const MASK = '•'.repeat(8);

let cache = null;
function all() {
  if (cache) return cache;
  cache = new Map();
  try {
    for (const row of db.all('SELECT key, value, secret FROM app_settings')) {
      const v = row.secret ? decrypt(row.value) : row.value;
      if (v !== null && v !== undefined && v !== '') cache.set(row.key, v);
    }
  } catch { /* table not created yet on a very old database */ }
  return cache;
}
const invalidate = () => { cache = null; };

/** The value the app should actually use: stored first, then the environment. */
function get(name) {
  const stored = all().get(name);
  if (stored) return stored;
  const env = process.env[name];
  return env ? String(env) : '';
}

/** 'app' when it came from the database, 'env' from the environment, null when unset. */
function source(name) {
  if (all().get(name)) return 'app';
  return process.env[name] ? 'env' : null;
}

/** A tail that identifies a key without revealing it. */
function hint(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return `${MASK}${s.slice(-2)}`;
  // Keep the recognisable prefix so live and test keys can be told apart at a glance.
  const prefix = (s.match(/^(sk_live|sk_test|whsec|re|AC|SK|MG)[_]?/) || [''])[0];
  return `${prefix}${MASK}${s.slice(-4)}`;
}

/** What the admin screen is allowed to know about one credential. */
function describe(name) {
  const value = get(name);
  return {
    key: name,
    label: KEYS[name] ? KEYS[name].label : name,
    set: !!value,
    source: source(name),
    hint: KEYS[name] && KEYS[name].secret ? hint(value) : value,
    secret: !!(KEYS[name] && KEYS[name].secret),
  };
}

function set(name, value, userId) {
  if (!KEYS[name]) throw new Error(`Unknown setting ${name}`);
  const clean = String(value == null ? '' : value).trim();
  if (!clean) return clear(name);
  const secret = KEYS[name].secret ? 1 : 0;
  db.run(`INSERT INTO app_settings (key, value, secret, updated_by, updated_at) VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = datetime('now')`,
  name, secret ? encrypt(clean) : clean, secret, userId || null);
  invalidate();
  return describe(name);
}

/** Remove the stored value, which falls back to the environment variable if there is one. */
function clear(name) {
  db.run('DELETE FROM app_settings WHERE key = ?', name);
  invalidate();
  return describe(name);
}

/**
 * Apply a patch from the admin form. A field left as the mask means "leave it alone", which is how
 * the screen can show that a key exists without ever having received its value.
 */
function applyPatch(patch, { provider, userId } = {}) {
  const changed = [];
  for (const [name, meta] of Object.entries(KEYS)) {
    if (provider && meta.provider !== provider) continue;
    if (!(name in (patch || {}))) continue;
    const raw = patch[name];
    if (raw === undefined || raw === null) continue;
    const str = String(raw);
    if (str === MASK || str.trim() === MASK) continue;
    set(name, str, userId);
    changed.push(name);
  }
  return changed;
}

const keysFor = (provider) => Object.entries(KEYS).filter(([, m]) => m.provider === provider).map(([k]) => k);

// Small scratch space for things like the result of the last payment test. Not a credential,
// so it is stored in the clear and may be shown.
function note(key, value) {
  db.run(`INSERT INTO app_settings (key, value, secret, updated_at) VALUES (?,?,0,datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, key, value == null ? null : JSON.stringify(value));
  invalidate();
}
function readNote(key) {
  const row = db.get('SELECT value FROM app_settings WHERE key = ?', key);
  if (!row || !row.value) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

module.exports = { KEYS, MASK, get, set, clear, source, describe, hint, applyPatch, keysFor, invalidate, note, readNote };
