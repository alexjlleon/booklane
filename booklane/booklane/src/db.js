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
`;
raw.exec(SCHEMA);
// Lightweight migrations for databases created by earlier versions
for (const sql of [
  "ALTER TABLE memberships ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
  'ALTER TABLE memberships ADD COLUMN invite_token TEXT',
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
