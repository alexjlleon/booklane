'use strict';
const db = require('../db');
const { DEFAULT_STEPS } = require('../defaults');
const { slugify } = require('../lib/util');

function uniqueSlug(base) {
  let slug = slugify(base) || 'business';
  const reserved = ['app', 'api', 'static', 'admin', 'login', 'signup', 'oauth', 'embed', 'b', 'q', 'booking'];
  if (reserved.includes(slug)) slug += '-co';
  let s = slug, i = 2;
  while (db.get('SELECT 1 FROM businesses WHERE slug = ?', s)) s = `${slug}-${i++}`;
  return s;
}

function ensureDefaultAvailability(userId) {
  if (db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', userId)) return;
  for (const wd of [1, 2, 3, 4, 5]) db.run('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES (?,?,?,?)', userId, wd, 9 * 60, 17 * 60);
}

function createBusiness({ name, timezone, email, ownerId, withDefaults = true }) {
  const slug = uniqueSlug(name);
  const { lastId } = db.run('INSERT INTO businesses (slug, name, timezone, email) VALUES (?,?,?,?)', slug, name, timezone || 'America/Chicago', email || null);
  db.run('INSERT INTO memberships (user_id, business_id, role) VALUES (?,?,?)', ownerId, lastId, 'owner');
  ensureDefaultAvailability(ownerId);
  if (withDefaults) {
    const et = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, location_type, min_notice_min, slot_interval_min, steps)
      VALUES (?,?,?,?,?,?,?,?,?)`, lastId, 'discovery-call', 'Discovery call', 'A quick call to learn about your event and answer your questions.', 20, 'phone', 240, 20, JSON.stringify(DEFAULT_STEPS()));
    db.run('INSERT INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', et.lastId, ownerId);
  }
  return db.get('SELECT * FROM businesses WHERE id = ?', lastId);
}

module.exports = { createBusiness, uniqueSlug, ensureDefaultAvailability };
