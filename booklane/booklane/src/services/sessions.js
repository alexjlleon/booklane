'use strict';
// Sessions: engagement, bridal, boudoir, anniversary, album design.
//
// Two ideas carry the whole feature:
//   1. A calendar profile is a market (Houston) or a person (the album designer). It owns a
//      login-less user row, so the existing scheduler gives it hours, blackouts and a real
//      Google/Outlook calendar for free.
//   2. A session is an event type with kind='session'. Picking a city restricts the slot search to
//      that market's calendar. Booklane takes no payments: a session is booked, never bought.
const db = require('../db');
const T = require('../lib/time');
const { token, hashPassword } = require('../lib/security');
const { HttpError } = require('../lib/router');
const { slugify, clampStr, int, deepMerge, isEmail } = require('../lib/util');
const { SESSION_SETTINGS, SESSION_STEPS } = require('../defaults');
const B = require('./business');
const L = require('./leads');
const S = require('./scheduling');
const BK = require('./bookings');

// ---------- session products ----------

function sessionSettings(et) {
  const raw = db.json(et.settings, {});
  return deepMerge(SESSION_SETTINGS, raw.session || {});
}

// Idempotent on purpose: callers pass rows straight from the database (JSON strings) and rows that
// have already been through here (real objects). Re-parsing an object would throw away the settings
// and silently reset every price to zero.
function hydrate(et) {
  if (!et) return et;
  const parse = (v, fallback) => (typeof v === 'string' ? db.json(v, fallback) : (v ?? fallback));
  et.steps = parse(et.steps, []);
  et.settings = parse(et.settings, {});
  et.session = deepMerge(SESSION_SETTINGS, et.settings.session || {});
  return et;
}

function bySlug(business, slug) {
  const et = db.get("SELECT * FROM event_types WHERE business_id = ? AND slug = ? AND kind = 'session'", business.id, String(slug || ''));
  if (!et) throw new HttpError(404, 'Not found');
  if (!et.active) throw new HttpError(404, 'This session is not available right now.');
  return hydrate(et);
}

function listProducts(businessId, { includeInactive = false } = {}) {
  const rows = db.all(`SELECT * FROM event_types WHERE business_id = ? AND kind = 'session' ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort, id`, businessId);
  return rows.map(hydrate);
}

// ---------- calendar profiles ----------

function listCalendars(businessId, { kind, includeInactive = false } = {}) {
  const where = ['c.business_id = ?'];
  const args = [businessId];
  if (kind) { where.push('c.kind = ?'); args.push(kind); }
  if (!includeInactive) where.push('c.active = 1');
  return db.all(`SELECT c.*, u.email user_email, u.timezone user_timezone
    FROM calendar_profiles c JOIN users u ON u.id = c.user_id
    WHERE ${where.join(' AND ')} ORDER BY c.sort, c.name`, ...args);
}

function calendarById(businessId, id) {
  return db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND id = ?', businessId, int(id, 0));
}

function calendarBySlug(businessId, slug) {
  return db.get('SELECT * FROM calendar_profiles WHERE business_id = ? AND slug = ?', businessId, String(slug || ''));
}

/** The calendars a session is offered on, in the order they should be shown. */
function calendarsForProduct(et) {
  return db.all(`SELECT c.* FROM calendar_profiles c
    JOIN event_type_hosts h ON h.user_id = c.user_id
    WHERE h.event_type_id = ? AND c.business_id = ? AND c.active = 1
    ORDER BY c.sort, c.name`, et.id, et.business_id);
}

function uniqueCalendarSlug(businessId, base) {
  let slug = slugify(base) || 'calendar';
  let s = slug;
  let i = 2;
  while (db.get('SELECT 1 FROM calendar_profiles WHERE business_id = ? AND slug = ?', businessId, s)) s = `${slug}-${i++}`;
  return s;
}

/**
 * Create a calendar. The user row behind it cannot log in: it gets a random unusable password and
 * is_resource = 1, which the login route refuses. It exists purely to own hours and a calendar link.
 */
function createCalendar(business, { name, kind = 'market', timezone, blurb, hours } = {}) {
  const label = clampStr(String(name || '').trim(), 80);
  if (!label) throw new HttpError(422, 'Give the calendar a name', { name: 'Required' });
  const tz = T.isValidTz(timezone) ? timezone : business.timezone;
  const slug = uniqueCalendarSlug(business.id, label);
  return db.tx(() => {
    // A reserved, non-routable address so it can never collide with a real person's email.
    const email = `calendar+${business.slug}-${slug}@booklane.invalid`;
    let user = db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) {
      const { lastId } = db.run('INSERT INTO users (email, name, password_hash, timezone, is_resource) VALUES (?,?,?,?,1)',
        email, label, `disabled:${token(16)}`, tz);
      user = db.get('SELECT * FROM users WHERE id = ?', lastId);
    }
    if (!db.get('SELECT 1 FROM memberships WHERE user_id = ? AND business_id = ?', user.id, business.id)) {
      db.run("INSERT INTO memberships (user_id, business_id, role, status) VALUES (?,?,'host','active')", user.id, business.id);
    }
    const sort = (db.get('SELECT MAX(sort) m FROM calendar_profiles WHERE business_id = ?', business.id) || {}).m || 0;
    const { lastId } = db.run('INSERT INTO calendar_profiles (business_id, user_id, kind, slug, name, blurb, timezone, sort) VALUES (?,?,?,?,?,?,?,?)',
      business.id, user.id, kind === 'person' ? 'person' : 'market', slug, label, clampStr(blurb, 300), tz, sort + 1);
    // Weekends matter for photography, so seed something sane rather than Mon-Fri 9-5.
    const week = hours || [[0, 12 * 60, 19 * 60], [5, 15 * 60, 20 * 60], [6, 8 * 60, 19 * 60]];
    for (const [wd, start, end] of week) db.run('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES (?,?,?,?)', user.id, wd, start, end);
    return db.get('SELECT * FROM calendar_profiles WHERE id = ?', lastId);
  });
}

function updateCalendar(business, id, patch = {}) {
  const cal = calendarById(business.id, id);
  if (!cal) throw new HttpError(404, 'Not found');
  const name = patch.name !== undefined ? clampStr(String(patch.name).trim(), 80) : cal.name;
  if (!name) throw new HttpError(422, 'Give the calendar a name', { name: 'Required' });
  const tz = patch.timezone !== undefined && T.isValidTz(patch.timezone) ? patch.timezone : cal.timezone;
  db.run('UPDATE calendar_profiles SET name = ?, blurb = ?, timezone = ?, active = ?, sort = ? WHERE id = ?',
    name, patch.blurb !== undefined ? clampStr(patch.blurb, 300) : cal.blurb, tz,
    patch.active !== undefined ? (patch.active ? 1 : 0) : cal.active,
    patch.sort !== undefined ? int(patch.sort, cal.sort) : cal.sort, cal.id);
  // The scheduler reads the timezone off the user row, so keep the two in step.
  if (tz !== cal.timezone) db.run('UPDATE users SET timezone = ? WHERE id = ?', tz, cal.user_id);
  if (patch.name !== undefined) db.run('UPDATE users SET name = ? WHERE id = ?', name, cal.user_id);
  return calendarById(business.id, cal.id);
}

function setProductCalendars(business, et, calendarIds) {
  const wanted = (Array.isArray(calendarIds) ? calendarIds : []).map((x) => int(x, 0)).filter(Boolean);
  const valid = wanted.filter((id) => calendarById(business.id, id));
  db.tx(() => {
    // Only clear the hosts that are calendars, so a human host attached by hand survives.
    const calUsers = db.all('SELECT user_id FROM calendar_profiles WHERE business_id = ?', business.id).map((r) => r.user_id);
    for (const uid of calUsers) db.run('DELETE FROM event_type_hosts WHERE event_type_id = ? AND user_id = ?', et.id, uid);
    for (const id of valid) {
      const cal = calendarById(business.id, id);
      if (cal) db.run('INSERT OR IGNORE INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', et.id, cal.user_id);
    }
  });
  return calendarsForProduct(et);
}

// ---------- public flow ----------

function publicSession(et, business) {
  const cals = calendarsForProduct(et);
  const s = et.session;
  const contact = (et.steps || []).find((x) => x.type === 'contact');
  return {
    slug: et.slug,
    name: et.name,
    description: et.description || '',
    duration_min: et.duration_min,
    calendars: cals.map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb || '' })),
    labels: {
      choose_label: s.choose_label, choose_hint: s.choose_hint,
      booking_number_label: s.booking_number_label, booking_number_hint: s.booking_number_hint,
      intro_heading: s.intro_heading || '', intro_blurb: s.intro_blurb || '', book_cta: s.book_cta,
    },
    ask_booking_number: !!s.ask_booking_number,
    booking_number_required: !!(s.ask_booking_number && s.booking_number_required),
    contact_fields: contact?.fields || { first_name: 'required', email: 'required' },
    questions: (et.steps || []).filter((x) => x.type === 'questions'),
    timezone: business.timezone,
  };
}

function resolveCalendar(business, et, slug) {
  const cals = calendarsForProduct(et);
  if (!cals.length) throw new HttpError(409, 'This session has no calendar set up yet.');
  if (cals.length === 1 && !slug) return cals[0];
  const found = cals.find((c) => c.slug === String(slug || ''));
  if (!found) throw new HttpError(422, 'Pick a location first', { calendar: 'Required' });
  return found;
}

function normalizeBookingNumber(v) {
  return clampStr(String(v || '').trim().replace(/\s+/g, ' ').toUpperCase(), 60);
}

/**
 * Book a session on the chosen market's calendar. createBooking re-checks the slot inside its own
 * transaction, so two people racing for the same Saturday morning cannot both get it.
 */
async function bookSession(business, et, body = {}) {
  const s = et.session;
  const cal = resolveCalendar(business, et, body.calendar);
  const startMs = Date.parse(body.start);
  if (!Number.isFinite(startMs)) throw new HttpError(422, 'Pick a time first', { start: 'Required' });
  const tz = T.isValidTz(body.timezone) ? body.timezone : business.timezone;
  const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
  if (!isEmail(contact.email)) throw new HttpError(422, 'Please fix the highlighted fields', { email: 'Enter a valid email' });

  const number = s.ask_booking_number ? normalizeBookingNumber(body.booking_number) : '';
  if (s.ask_booking_number && s.booking_number_required && !number) {
    throw new HttpError(422, 'Please fix the highlighted fields', { booking_number: `${s.booking_number_label} is required` });
  }

  let lead = body.lead_token ? L.byToken(body.lead_token) : null;
  if (lead && lead.business_id !== business.id) lead = null;
  if (!lead) lead = L.createLead(business, { source: 'booking', eventTypeId: et.id, meta: { session: et.slug, calendar: cal.slug } });

  const answers = L.sanitizeAnswers(body.answers || {});
  answers.session = et.name;
  answers.location = cal.name;
  if (number) answers.booking_number = number;

  const booking = await BK.createBooking({
    business, et, startIso: new Date(startMs).toISOString(), tz, contact, answers, lead,
    restrictHostIds: [cal.user_id], placeId: body.place_id,
  });
  B.logActivity(business.id, lead.id, 'booking', `${et.name} booked in ${cal.name}${number ? ` against booking ${number}` : ''}`, { booking_id: booking.id });
  return { booking };
}

module.exports = {
  sessionSettings, hydrate, bySlug, listProducts, publicSession,
  listCalendars, calendarById, calendarBySlug, calendarsForProduct, createCalendar, updateCalendar, setProductCalendars, uniqueCalendarSlug, resolveCalendar,
  normalizeBookingNumber, bookSession, SESSION_STEPS,
};
