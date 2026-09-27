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
  // Square is the other way to take a card. A business uses one or the other, never both at once.
  SQUARE_ACCESS_TOKEN: { secret: true, provider: 'square', label: 'Access token' },
  SQUARE_LOCATION_ID: { secret: false, provider: 'square', label: 'Location ID' },
  SQUARE_WEBHOOK_SIGNATURE_KEY: { secret: true, provider: 'square', label: 'Webhook signature key' },
  SQUARE_ENVIRONMENT: { secret: false, provider: 'square', label: 'Environment' },
  // Which one this business actually uses: 'stripe' or 'square'.
  PAYMENT_PROVIDER: { secret: false, provider: 'payments', label: 'Card payments through' },
};

const MASK = '•'.repeat(8);

// One cache per scope: 'global' for the platform-wide values, or the business id.
const caches = new Map();
function all(businessId) {
  const scope = businessId ? String(businessId) : 'global';
  if (caches.has(scope)) return caches.get(scope);
  const map = new Map();
  try {
    const rows = businessId
      ? db.all('SELECT key, value, secret FROM business_credentials WHERE business_id = ?', businessId)
      : db.all('SELECT key, value, secret FROM app_settings');
    for (const row of rows) {
      const v = row.secret ? decrypt(row.value) : row.value;
      if (v !== null && v !== undefined && v !== '') map.set(row.key, v);
    }
  } catch { /* table not created yet on a very old database */ }
  caches.set(scope, map);
  return map;
}
const invalidate = (businessId) => {
  if (businessId === undefined) caches.clear();
  else caches.delete(businessId ? String(businessId) : 'global');
};

/**
 * The value the app should actually use, most specific first:
 * this business, then the platform default, then the environment.
 */
function get(name, businessId) {
  if (businessId) {
    const own = all(businessId).get(name);
    if (own) return own;
  }
  const shared = all().get(name);
  if (shared) return shared;
  const env = process.env[name];
  return env ? String(env) : '';
}

/** Where the value came from: 'business', 'app', 'env', or null when unset. */
function source(name, businessId) {
  if (businessId && all(businessId).get(name)) return 'business';
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
function describe(name, businessId) {
  const value = get(name, businessId);
  return {
    key: name,
    label: KEYS[name] ? KEYS[name].label : name,
    set: !!value,
    source: source(name, businessId),
    hint: KEYS[name] && KEYS[name].secret ? hint(value) : value,
    secret: !!(KEYS[name] && KEYS[name].secret),
  };
}

function set(name, value, userId, businessId) {
  if (!KEYS[name]) throw new Error(`Unknown setting ${name}`);
  const clean = String(value == null ? '' : value).trim();
  if (!clean) return clear(name, businessId);
  const secret = KEYS[name].secret ? 1 : 0;
  const stored = secret ? encrypt(clean) : clean;
  if (businessId) {
    db.run(`INSERT INTO business_credentials (business_id, key, value, secret, updated_by, updated_at) VALUES (?,?,?,?,?,datetime('now'))
      ON CONFLICT(business_id, key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    businessId, name, stored, secret, userId || null);
  } else {
    db.run(`INSERT INTO app_settings (key, value, secret, updated_by, updated_at) VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_by = excluded.updated_by, updated_at = datetime('now')`,
    name, stored, secret, userId || null);
  }
  invalidate(businessId);
  return describe(name, businessId);
}

/** Remove the stored value, which falls back to the environment variable if there is one. */
function clear(name, businessId) {
  if (businessId) db.run('DELETE FROM business_credentials WHERE business_id = ? AND key = ?', businessId, name);
  else db.run('DELETE FROM app_settings WHERE key = ?', name);
  invalidate(businessId);
  return describe(name, businessId);
}

/**
 * Apply a patch from the admin form. A field left as the mask means "leave it alone", which is how
 * the screen can show that a key exists without ever having received its value.
 */
function applyPatch(patch, { provider, userId, businessId } = {}) {
  const changed = [];
  for (const [name, meta] of Object.entries(KEYS)) {
    if (provider && meta.provider !== provider) continue;
    if (!(name in (patch || {}))) continue;
    const raw = patch[name];
    if (raw === undefined || raw === null) continue;
    const str = String(raw);
    if (str === MASK || str.trim() === MASK) continue;
    set(name, str, userId, businessId);
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
