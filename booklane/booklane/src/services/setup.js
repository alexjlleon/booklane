'use strict';
const db = require('../db');
const { DEFAULT_STEPS, SESSION_STEPS, SESSION_SETTINGS, DEFAULT_MARKETS, DEFAULT_SESSION_PRODUCTS } = require('../defaults');
const { slugify, deepMerge } = require('../lib/util');

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

/**
 * Create one sellable session and point it at a set of calendars.
 * Idempotent on slug, so running the seed twice does not duplicate anything.
 */
function createSessionProduct(business, { name, slug, description, duration_min = 90, price_cents = 0, location_type = 'in_person', calendarIds = [], session = {} }) {
  const S = require('./sessions');
  const finalSlug = slugify(slug || name) || 'session';
  let et = db.get('SELECT * FROM event_types WHERE business_id = ? AND slug = ?', business.id, finalSlug);
  if (!et) {
    const settings = { session: deepMerge(SESSION_SETTINGS, { price_cents, currency: business.settings?.quote?.currency || 'USD', ...session }) };
    const sort = (db.get('SELECT MAX(sort) m FROM event_types WHERE business_id = ?', business.id) || {}).m || 0;
    const { lastId } = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, location_type,
        buffer_after, min_notice_min, max_days_ahead, slot_interval_min, kind, steps, settings, sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,'session',?,?,?)`,
    business.id, finalSlug, name, description || null, duration_min, location_type,
    30, 24 * 60, 180, 30, JSON.stringify(SESSION_STEPS()), JSON.stringify(settings), sort + 1);
    et = db.get('SELECT * FROM event_types WHERE id = ?', lastId);
  }
  if (calendarIds.length) S.setProductCalendars(business, et, calendarIds);
  return et;
}

/**
 * Set up the markets and the sellable sessions. Safe to run on an existing business: calendars and
 * products are matched by slug, so nothing is duplicated and nothing already configured is reset.
 */
function seedSessions(business, { markets = DEFAULT_MARKETS, products = DEFAULT_SESSION_PRODUCTS, withAlbum = true } = {}) {
  const S = require('./sessions');
  const created = { calendars: [], products: [] };

  const marketIds = [];
  for (const m of markets) {
    const slug = slugify(m.name);
    let cal = db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND slug = ?', business.id, slug);
    if (!cal) {
      cal = S.createCalendar(business, { name: m.name, kind: 'market', timezone: m.timezone, blurb: m.blurb });
      created.calendars.push(cal.name);
    }
    marketIds.push(cal.id);
  }

  for (const p of products) {
    const before = db.get('SELECT 1 FROM event_types WHERE business_id = ? AND slug = ?', business.id, p.slug);
    createSessionProduct(business, { ...p, calendarIds: marketIds });
    if (!before) created.products.push(p.name);
  }

  if (withAlbum) {
    let designer = db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND slug = ?', business.id, 'album-designer');
    if (!designer) {
      designer = S.createCalendar(business, {
        name: 'Album Designer', kind: 'person', timezone: business.timezone,
        blurb: 'Design sessions run on the designer’s own calendar.',
        hours: [[1, 10 * 60, 17 * 60], [2, 10 * 60, 17 * 60], [3, 10 * 60, 17 * 60], [4, 10 * 60, 17 * 60]],
      });
      created.calendars.push(designer.name);
    }
    const before = db.get('SELECT 1 FROM event_types WHERE business_id = ? AND slug = ?', business.id, 'photo-album');
    createSessionProduct(business, {
      name: 'Photo Album', slug: 'photo-album', duration_min: 60, price_cents: 0, location_type: 'zoom',
      description: 'Choose your album, then sit down with our designer to lay it out page by page.',
      calendarIds: [designer.id],
      session: {
        choose_label: 'Who are you designing with?',
        booked_question: 'Have you already paid for your album?',
        booked_yes_label: 'Yes, it’s on my contract',
        booked_no_label: 'Not yet',
        price_blurb: 'Buy your album now, then book your design session on the next screen.',
        pay_cta: 'Buy the album and pick a time',
        free_cta: 'Book my design session',
      },
    });
    if (!before) created.products.push('Photo Album');
  }
  return created;
}

module.exports = { createBusiness, uniqueSlug, ensureDefaultAvailability, createSessionProduct, seedSessions };
