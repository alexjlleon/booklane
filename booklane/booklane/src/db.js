'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'booklane.db');

const raw = new DatabaseSync(DB_FILE);
raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Chicago', phone TEXT,
  is_super_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago', email TEXT, phone TEXT, website TEXT,
  logo_url TEXT, brand_color TEXT NOT NULL DEFAULT '#6d4aff', settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'host', PRIMARY KEY (user_id, business_id)
);
CREATE TABLE IF NOT EXISTS event_types (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT, duration_min INTEGER NOT NULL DEFAULT 30,
  location_type TEXT NOT NULL DEFAULT 'phone', location_value TEXT,
  buffer_before INTEGER NOT NULL DEFAULT 0, buffer_after INTEGER NOT NULL DEFAULT 0,
  min_notice_min INTEGER NOT NULL DEFAULT 240, max_days_ahead INTEGER NOT NULL DEFAULT 60,
  slot_interval_min INTEGER NOT NULL DEFAULT 30, daily_limit INTEGER NOT NULL DEFAULT 0,
  assignment TEXT NOT NULL DEFAULT 'round_robin', color TEXT NOT NULL DEFAULT '#6d4aff',
  steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, slug)
);
CREATE TABLE IF NOT EXISTS event_type_hosts (
  event_type_id INTEGER NOT NULL REFERENCES event_types(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (event_type_id, user_id)
);
CREATE TABLE IF NOT EXISTS availability_rules (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS date_overrides (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL, start_min INTEGER, end_min INTEGER, unavailable INTEGER NOT NULL DEFAULT 0
);
-- Event dates the business is already booked for, so a date-check form can answer honestly.
CREATE TABLE IF NOT EXISTS blocked_dates (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  date TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, date)
);
CREATE INDEX IF NOT EXISTS idx_blocked_dates ON blocked_dates (business_id, date);
CREATE TABLE IF NOT EXISTS calendar_connections (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, account_email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER,
  calendar_id TEXT NOT NULL DEFAULT 'primary', check_busy INTEGER NOT NULL DEFAULT 1, write_events INTEGER NOT NULL DEFAULT 1,
  last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE, source TEXT NOT NULL DEFAULT 'booking', status TEXT NOT NULL DEFAULT 'partial',
  event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  step_key TEXT, step_index INTEGER NOT NULL DEFAULT 0, step_total INTEGER NOT NULL DEFAULT 0, max_step_index INTEGER NOT NULL DEFAULT 0,
  first_name TEXT, last_name TEXT, email TEXT, phone TEXT, sms_consent INTEGER NOT NULL DEFAULT 0,
  answers TEXT NOT NULL DEFAULT '{}', meta TEXT NOT NULL DEFAULT '{}', notes TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  abandoned_notified_at TEXT, recovery_sent_at TEXT, completed_at TEXT,
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_business ON leads (business_id, last_activity_at);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, quote_id INTEGER,
  token TEXT NOT NULL UNIQUE, start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, invitee_tz TEXT,
  name TEXT, email TEXT, phone TEXT, location TEXT, status TEXT NOT NULL DEFAULT 'confirmed',
  answers TEXT NOT NULL DEFAULT '{}', external_events TEXT NOT NULL DEFAULT '[]',
  cancel_reason TEXT, rescheduled_from INTEGER, reminder_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_host ON bookings (host_user_id, start_utc);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category TEXT, name TEXT NOT NULL, description TEXT, image_url TEXT,
  pricing_type TEXT NOT NULL DEFAULT 'flat', base_price REAL NOT NULL DEFAULT 0, unit_label TEXT,
  min_qty INTEGER NOT NULL DEFAULT 1, max_qty INTEGER NOT NULL DEFAULT 1, default_qty INTEGER NOT NULL DEFAULT 1,
  option_groups TEXT NOT NULL DEFAULT '[]', addons TEXT NOT NULL DEFAULT '[]',
  badge TEXT, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL, token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft', details TEXT NOT NULL DEFAULT '{}', selections TEXT NOT NULL DEFAULT '[]',
  line_items TEXT NOT NULL DEFAULT '[]', subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0,
  tax REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, deposit REAL NOT NULL DEFAULT 0,
  next_step TEXT, contract_request TEXT, callback_request TEXT,
  sync_status TEXT, sync_log TEXT NOT NULL DEFAULT '[]', expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE, type TEXT NOT NULL, message TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity (lead_id, id);
CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY, business_id INTEGER, to_addr TEXT NOT NULL, subject TEXT NOT NULL, html TEXT,
  status TEXT NOT NULL, provider TEXT, error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL, created_at INTEGER NOT NULL
);
-- A bookable calendar: a market (Houston, Austin, ...) or a person (the album designer).
-- Hours, date overrides and the connected Google/Outlook calendar all hang off user_id, which is
-- how the scheduler already works, so a market gets a real calendar without special-casing anything.
CREATE TABLE IF NOT EXISTS calendar_profiles (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'market', slug TEXT NOT NULL, name TEXT NOT NULL,
  blurb TEXT, timezone TEXT, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_calendar_profiles ON calendar_profiles (business_id, kind, active);
-- One row per attempt to buy a session. A 'pending' row also holds the slot, so two people cannot
-- pay for the same time; abandoned holds expire on their own and free the slot back up.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  calendar_profile_id INTEGER REFERENCES calendar_profiles(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending', provider TEXT NOT NULL DEFAULT 'stripe',
  provider_session_id TEXT, provider_payment_intent TEXT, provider_receipt_url TEXT,
  customer_name TEXT, customer_email TEXT, customer_phone TEXT,
  already_booked INTEGER NOT NULL DEFAULT 0, booking_number TEXT,
  hold_host_user_id INTEGER, hold_start_utc TEXT, hold_end_utc TEXT, hold_expires_at INTEGER,
  invitee_tz TEXT, answers TEXT NOT NULL DEFAULT '{}', last_error TEXT,
  paid_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_business ON orders (business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_hold ON orders (hold_host_user_id, status, hold_expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_provider_session ON orders (provider_session_id);
-- Stripe redelivers webhooks, sometimes more than once. Remember what has already been handled.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT, image_url TEXT,
  -- Charged on top of whatever the chosen options cost. Zero when the options carry the whole price,
  -- which is how the albums work: the 8x8 and the 10x10 are two priced choices of one option group.
  base_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
  -- [{ id, label, hint, required, applies_to:[choiceId], choices:[{ id, label, price_cents }] }]
  -- applies_to lets a group show only when another group's choice is picked, so the cover choice
  -- appears for the 10x10 and not for the 8x8.
  option_groups TEXT NOT NULL DEFAULT '[]',
  -- [{ id, label, hint, price_cents, max_qty }]
  addons TEXT NOT NULL DEFAULT '[]',
  min_qty INTEGER NOT NULL DEFAULT 1, max_qty INTEGER NOT NULL DEFAULT 10, default_qty INTEGER NOT NULL DEFAULT 1,
  -- The booking page offered once it is paid for, e.g. the album design call.
  followup_event_type_id INTEGER REFERENCES event_types(id) ON DELETE SET NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, slug)
);
-- One row per cart line, priced by the server. The order's amount is the sum of these, never a
-- number the browser sent.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL, detail TEXT,
  unit_cents INTEGER NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
-- Custom forms: an ordered list of steps the customer walks through.
--
-- A form composes what already exists rather than keeping its own copy: a schedule step points at a
-- booking page for its hours and hosts, a product step points at a product for its options and
-- prices. One source of truth for a calendar, one for a price.
--
-- Where the payment step sits decides how the money works. Payment after a calendar step means the
-- slot is held while they pay, the way a session does it. Payment before means they buy first and
-- book afterwards, the way an album does. There is no separate setting; the order is the setting.
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, slug)
);
CREATE TABLE IF NOT EXISTS provider_events (
  provider TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (provider, event_id)
);
-- One rule: when to write, who to, and what to say. Conditions are stored as JSON id lists;
-- an empty list means "applies to everything", which is the common case.
CREATE TABLE IF NOT EXISTS message_automations (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',        -- email | sms | both
  kind TEXT NOT NULL DEFAULT 'transactional',   -- transactional | marketing
  trigger TEXT NOT NULL DEFAULT 'before',       -- booked | before | after | cancelled | rescheduled
  offset_min INTEGER NOT NULL DEFAULT 1440,     -- minutes before/after the appointment starts
  event_type_ids TEXT NOT NULL DEFAULT '[]',
  calendar_ids TEXT NOT NULL DEFAULT '[]',
  service_match TEXT NOT NULL DEFAULT '[]',
  match_mode TEXT NOT NULL DEFAULT 'any',       -- any | all
  skip_if_rebooked INTEGER NOT NULL DEFAULT 0,
  subject TEXT, body_html TEXT, sms_body TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_automations_business ON message_automations (business_id, active);
-- The outbox. The unique key is what stops a second job run from sending the same thing twice.
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  automation_id INTEGER REFERENCES message_automations(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  channel TEXT NOT NULL, to_addr TEXT NOT NULL,
  send_after INTEGER NOT NULL, due_at TEXT,
  status TEXT NOT NULL DEFAULT 'queued',        -- queued | sent | skipped | failed | cancelled
  subject TEXT, body TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, skip_reason TEXT, sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (automation_id, booking_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled_messages (status, send_after);
CREATE INDEX IF NOT EXISTS idx_sched_booking ON scheduled_messages (booking_id);
CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY, business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'out', to_addr TEXT, from_addr TEXT, body TEXT,
  status TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'twilio', provider_sid TEXT, error TEXT,
  segments INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_log ON sms_log (business_id, created_at);
-- Someone who texts STOP must never be texted again. Checked on every single send.
-- Provider credentials and small bits of app state. Secrets are encrypted with APP_SECRET and are
-- never read back out to the browser; the environment is used for anything not stored here.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY, value TEXT, secret INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Credentials belonging to one business.
--
-- app_settings stays as the platform-wide fallback, so nothing that works today stops working:
-- a key saved here wins for this business, then the platform default, then the environment. That
-- chain is what lets a second company bring its own payment account without touching the first.
CREATE TABLE IF NOT EXISTS business_credentials (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT, secret INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, key)
);
CREATE TABLE IF NOT EXISTS sms_optouts (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, phone)
);
`;
raw.exec(SCHEMA);
// Lightweight migrations for databases created by earlier versions
for (const sql of [
  "ALTER TABLE memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  'ALTER TABLE memberships ADD COLUMN invite_token TEXT',
  // 'call' is a plain scheduled call; 'session' is a sellable session with a price on it.
  "ALTER TABLE event_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'call'",
  // A login-less user row that exists only to own a calendar (a market, or the album designer).
  'ALTER TABLE users ADD COLUMN is_resource INTEGER NOT NULL DEFAULT 0',
  // Which custom form a lead or order came through, so a form can report its own results.
  'ALTER TABLE leads ADD COLUMN form_id INTEGER',
  'ALTER TABLE orders ADD COLUMN form_id INTEGER',
  // Orders grew from one session to a cart of lines; 'product' orders are scheduled after payment,
  // not before, so the slot columns stay empty for them.
  'ALTER TABLE orders ADD COLUMN product_id INTEGER',
  "ALTER TABLE orders ADD COLUMN order_kind TEXT NOT NULL DEFAULT 'session'",
  'ALTER TABLE orders ADD COLUMN schedule_token TEXT',
  // An album's price is a combination (size x cover), not a single choice, so the price lives in a
  // rule table rather than on one option. Extra spreads are priced the same way, by size and paper.
  "ALTER TABLE products ADD COLUMN price_rules TEXT NOT NULL DEFAULT '[]'",
]) { try { raw.exec(sql); } catch { /* column already exists */ } }

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
  return s;
}
const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));

const db = {
  raw,
  get: (sql, ...p) => { const r = stmt(sql).get(...norm(p)); return r ? { ...r } : undefined; },
  all: (sql, ...p) => stmt(sql).all(...norm(p)).map((r) => ({ ...r })),
  run: (sql, ...p) => { const r = stmt(sql).run(...norm(p)); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; },
  tx(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try { const out = fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
  },
  json(v, fallback) { if (v == null || v === '') return fallback; try { return JSON.parse(v); } catch { return fallback; } },
  file: DB_FILE,
};

module.exports = db;
