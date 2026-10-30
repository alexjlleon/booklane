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
-- Who does the work, and what kind of work it is. Two separate questions: the imaging team runs
-- engagement sessions, but it also runs headshots, and a sales call is a sales call whoever takes
-- it. Keeping them apart means a booking page can be filed under both without either one being a
-- rename of the other.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT, color TEXT NOT NULL DEFAULT '#6d4aff',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_business ON teams (business_id, active);
-- A person can be on more than one team: the photographer who also takes sales calls is on both,
-- and making them pick one would mean duplicating them.
CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE IF NOT EXISTS booking_types (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_booking_types_business ON booking_types (business_id, active);
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
-- Custom forms: an ordered list of steps the customer walks through.
--
-- A form composes what already exists rather than keeping its own copy: a schedule step points at a
-- booking page for its hours and hosts. One source of truth for a calendar.
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY, business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  steps TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  submissions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (business_id, slug)
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
-- a key saved here wins for this business, then the platform default, then the environment.
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
  // 'call' is a plain scheduled call; 'session' is booked on a market or designer calendar.
  "ALTER TABLE event_types ADD COLUMN kind TEXT NOT NULL DEFAULT 'call'",
  // A login-less user row that exists only to own a calendar (a market, or the album designer).
  'ALTER TABLE users ADD COLUMN is_resource INTEGER NOT NULL DEFAULT 0',
  // Which custom form a lead came through, so a form can report its own results.
  'ALTER TABLE leads ADD COLUMN form_id INTEGER',
  // Whether this service takes part in combination pricing. Add-ons and ready-made packages do
  // not: a guest book sitting in the basket must never stop a combination from being recognised.
  'ALTER TABLE services ADD COLUMN bundle_eligible INTEGER NOT NULL DEFAULT 1',
  // Which team runs this booking page, and what kind of booking it is. Set on the page rather than
  // worked out from whoever is hosting: a page can draw hosts from more than one team, and moving a
  // person between teams should not silently re-file the pages they happen to cover.
  'ALTER TABLE event_types ADD COLUMN team_id INTEGER',
  'ALTER TABLE event_types ADD COLUMN booking_type_id INTEGER',
  // Round robin priority per host on a page: 3 high, 2 medium, 1 low. When several people are free
  // for a time, only the highest priority among them is considered; the even spread happens within
  // that tier. Everyone starts at medium, which is exactly how round robin behaved before.
  'ALTER TABLE event_type_hosts ADD COLUMN priority INTEGER NOT NULL DEFAULT 2',
  // Whether an all-day entry on a connected calendar blocks bookings. Off by default: in a
  // business whose calendar carries an all-day entry per job, treating those as solid busy time
  // blacks out every working day, and the booking page silently offers nothing at all.
  'ALTER TABLE calendar_connections ADD COLUMN busy_all_day INTEGER NOT NULL DEFAULT 0',
  // The ways a customer may choose to meet on this page. Empty means the single location_type
  // below is the only one, which is every page that existed before this column did.
  "ALTER TABLE event_types ADD COLUMN location_options TEXT NOT NULL DEFAULT '[]'",
  // Who the connection being authorised is FOR. A market calendar has no login of its own, so an
  // admin signs in to their own account and attaches it to the market; user_id stays the person
  // who authorised it, which is what the callback checks.
  'ALTER TABLE oauth_states ADD COLUMN target_user_id INTEGER',
  // Which of those the customer picked, so a reschedule keeps their choice rather than quietly
  // moving a Zoom call onto the phone.
  'ALTER TABLE bookings ADD COLUMN place_id TEXT',
  // Each company can have its own address (book.weddingsunlimited.com). Its pages are served there
  // at clean paths, and every link Booklane sends for it points there.
  'ALTER TABLE businesses ADD COLUMN custom_domain TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_domain ON businesses (custom_domain)',
  // Where a calendar sign-in started, so the platform-wide callback can hand it back to that domain.
  'ALTER TABLE oauth_states ADD COLUMN return_origin TEXT',
  // A calendar whose sign-in has stopped working (revoked, expired, or unreadable): bookings no
  // longer see its busy times, so people are told. alerted_at is when they were last told.
  'ALTER TABLE calendar_connections ADD COLUMN needs_reconnect INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE calendar_connections ADD COLUMN alerted_at INTEGER',
  'ALTER TABLE calendar_connections ADD COLUMN checked_at INTEGER',
  // A person's level for sales routing: 'senior', 'junior' or 'staff' (NULL reads as staff).
  // Per business, because the same person can be senior at one company and staff at another.
  'ALTER TABLE memberships ADD COLUMN level TEXT',
  // A booking type whose pages hand each call to a level by how many services the customer picked:
  // three or more to senior staff, two to junior staff, one to staff.
  'ALTER TABLE booking_types ADD COLUMN match_by_services INTEGER NOT NULL DEFAULT 0',
  // How many services were picked when it was booked, so a reschedule routes the same way.
  'ALTER TABLE bookings ADD COLUMN services_count INTEGER',
  // Which team an automation belongs to, for filtering the list. NULL means "work it out from the
  // booking pages it applies to". A label only: it never changes who receives the message.
  'ALTER TABLE message_automations ADD COLUMN team_id INTEGER',
  // The note left when a call was passed to a teammate, shown to them in the handoff email.
  'ALTER TABLE bookings ADD COLUMN handoff_note TEXT',
]) { try { raw.exec(sql); } catch { /* column already exists */ } }

// Booklane no longer takes payments. Drop what the shop, the paid sessions and the card providers
// left behind. Children before parents, so the foreign keys never see a dangling row. Every step is
// IF EXISTS, so this is a no-op on a database that never had them and on every boot after the first.
for (const sql of [
  'DROP TABLE IF EXISTS order_items',
  'DROP TABLE IF EXISTS orders',
  'DROP TABLE IF EXISTS products',
  'DROP TABLE IF EXISTS provider_events',
  // Card-provider keys and the old $1 test result. Nothing reads them any more.
  "DELETE FROM app_settings WHERE substr(key, 1, 7) IN ('STRIPE_', 'SQUARE_') OR key IN ('PAYMENT_PROVIDER', 'stripe.last_diagnostic')",
  "DELETE FROM business_credentials WHERE substr(key, 1, 7) IN ('STRIPE_', 'SQUARE_') OR key = 'PAYMENT_PROVIDER'",
]) { try { raw.exec(sql); } catch (e) { console.error('[db] cleanup step failed:', e.message); } }

// Sessions saved while they could be sold carry a price and checkout copy, and their booking-number
// setting meant "required when they say they already paid". With no payment branch left, that
// setting would demand a number from every new customer, so it becomes optional here. Only rows
// that still have a price key are touched, which makes this run once per session and never again.
try {
  const RETIRED = ['price_cents', 'currency', 'booked_question', 'booked_yes_label', 'booked_no_label', 'booked_note',
    'price_heading', 'price_blurb', 'includes', 'pay_cta', 'free_cta', 'paid_note', 'hold_minutes'];
  for (const row of raw.prepare("SELECT id, settings FROM event_types WHERE kind = 'session'").all()) {
    let settings;
    try { settings = JSON.parse(row.settings || '{}'); } catch { continue; }
    const sess = settings && settings.session;
    if (!sess || !Object.prototype.hasOwnProperty.call(sess, 'price_cents')) continue;
    for (const k of RETIRED) delete sess[k];
    sess.booking_number_required = false;
    raw.prepare('UPDATE event_types SET settings = ? WHERE id = ?').run(JSON.stringify(settings), row.id);
  }
} catch (e) { console.error('[db] session settings cleanup failed:', e.message); }

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
