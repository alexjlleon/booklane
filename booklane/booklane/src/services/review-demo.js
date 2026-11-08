'use strict';
// A ready-made demo company for Apple and Google app reviewers.
//
// Both stores refuse an app they cannot log in to, and a reviewer must never see a real company's
// customers. So the platform admin presses one button and gets a login to a made-up studio with
// booking pages, a teammate, leads and calls in the past and the future. Pressing it again gives a
// fresh password and tops the calls back up so they stay in the future; nothing is duplicated.
const db = require('../db');
const { hashPassword, token } = require('../lib/security');
const { createBusiness, ensureDefaultAvailability } = require('./setup');

const EMAIL = 'appreview@availvo.co';
const TEAMMATE = 'sam.rivera@brightoak.example';
const COMPANY = 'Bright Oak Studio';

const PEOPLE = [
  ['Dana Ruiz', 'dana.ruiz@example.com', '(713) 555-0142', 'Wedding photography and video'],
  ['Marcus Bell', 'marcus.bell@example.com', '(512) 555-0187', 'Family portraits'],
  ['Priya Shah', 'priya.shah@example.com', '(214) 555-0163', 'Engagement session'],
  ['Elena Torres', 'elena.torres@example.com', '(832) 555-0119', 'Headshots for a team of 12'],
  ['Jamal Carter', 'jamal.carter@example.com', '(210) 555-0175', 'Wedding photography'],
  ['Hannah Lee', 'hannah.lee@example.com', '(281) 555-0108', 'Brand photos for a bakery'],
  ['Owen Price', 'owen.price@example.com', '(469) 555-0131', 'Graduation portraits'],
  ['Sofia Nguyen', 'sofia.nguyen@example.com', '(737) 555-0156', 'Anniversary session'],
  ['Caleb Brooks', 'caleb.brooks@example.com', '(346) 555-0124', 'Event coverage'],
];

/** The next weekday at hour:minute in Central time, `days` ahead (negative = in the past). */
function slot(days, hour, minute = 0) {
  const T = require('../lib/time');
  let d = T.addDays(T.utcToZoned(Date.now(), 'America/Chicago').date, days);
  while ([0, 6].includes(T.weekdayOf(d))) d = T.addDays(d, days < 0 ? -1 : 1);
  return T.zonedToUtc(d, hour * 60 + minute, 'America/Chicago');
}

function pageFor(businessId, slug, name, description, duration, sort, hosts) {
  let et = db.get('SELECT * FROM event_types WHERE business_id = ? AND slug = ?', businessId, slug);
  if (!et) {
    const { NEUTRAL_STEPS } = require('./setup');
    const id = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, location_type, min_notice_min, slot_interval_min, steps, sort)
      VALUES (?,?,?,?,?,'phone',120,30,?,?)`, businessId, slug, name, description, duration, JSON.stringify(NEUTRAL_STEPS ? NEUTRAL_STEPS() : []), sort).lastId;
    et = db.get('SELECT * FROM event_types WHERE id = ?', id);
  }
  for (const h of hosts) db.run('INSERT OR IGNORE INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', et.id, h);
  return et;
}

function ensureReviewDemo() {
  const password = `Review-${token(6)}`;
  return db.tx(() => {
    let owner = db.get('SELECT * FROM users WHERE email = ?', EMAIL);
    if (owner) db.run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', hashPassword(password), owner.id);
    else {
      const id = db.run("INSERT INTO users (email, name, password_hash, timezone, email_verified, terms_accepted_at, phone) VALUES (?,?,?,?,1,datetime('now'),?)",
        EMAIL, 'Jordan Avery', hashPassword(password), 'America/Chicago', '(713) 555-0100').lastId;
      owner = db.get('SELECT * FROM users WHERE id = ?', id);
    }
    // Sign out anywhere the old password was used, so each review starts clean.
    db.run('DELETE FROM sessions WHERE user_id = ?', owner.id);

    let b = db.get("SELECT b.* FROM businesses b JOIN memberships m ON m.business_id = b.id WHERE m.user_id = ? AND m.role = 'owner' ORDER BY b.id LIMIT 1", owner.id);
    if (!b) {
      b = createBusiness({ name: COMPANY, timezone: 'America/Chicago', email: EMAIL, ownerId: owner.id, withDefaults: false, access: 'starter', activated: true, neutral: true });
      const s = JSON.parse(b.settings || '{}');
      s.tagline = 'Portraits, weddings and brand photography in Houston and Austin.';
      s.trust_points = ['Instant confirmation', 'No pressure, just answers', 'Reply within one business day'];
      db.run('UPDATE businesses SET settings = ?, phone = ?, website = ? WHERE id = ?', JSON.stringify(s), '(713) 555-0100', 'https://brightoak.example', b.id);
    }

    let mate = db.get('SELECT * FROM users WHERE email = ?', TEAMMATE);
    if (!mate) mate = db.get('SELECT * FROM users WHERE id = ?', db.run("INSERT INTO users (email, name, password_hash, timezone, email_verified) VALUES (?,?,?,?,1)", TEAMMATE, 'Sam Rivera', hashPassword(token(16)), 'America/Chicago').lastId);
    db.run("INSERT OR IGNORE INTO memberships (user_id, business_id, role, status) VALUES (?,?,'admin','active')", mate.id, b.id);
    ensureDefaultAvailability(owner.id);
    ensureDefaultAvailability(mate.id);

    const discovery = pageFor(b.id, 'discovery-call', 'Discovery call', 'A quick call to hear what you have in mind and answer your questions.', 20, 1, [owner.id, mate.id]);
    const planning = pageFor(b.id, 'planning-call', 'Planning call', 'For booked clients: shot list, timeline and locations.', 30, 2, [owner.id]);
    pageFor(b.id, 'quick-question', 'Quick question', 'Ten minutes for anything that does not fit an email.', 10, 3, [mate.id]);

    // Calls: keep a full week ahead and a few already held, so every screen has something on it.
    const upcoming = db.get("SELECT COUNT(*) c FROM bookings WHERE business_id = ? AND status = 'confirmed' AND start_utc > ?", b.id, new Date().toISOString()).c;
    if (upcoming < 5) {
      const plan = [[0, 1, 10, discovery, owner], [1, 1, 14, discovery, mate], [2, 2, 11, planning, owner], [3, 3, 9, discovery, owner], [4, 4, 15, discovery, mate], [5, 6, 13, planning, owner]];
      const past = db.get('SELECT COUNT(*) c FROM bookings WHERE business_id = ? AND start_utc < ?', b.id, new Date().toISOString()).c;
      const all = past ? plan : plan.concat([[6, -1, 10, discovery, owner, 'booked'], [7, -2, 14, discovery, mate, 'not_booked'], [8, -3, 11, discovery, owner, 'no_show'], [1, -4, 15, planning, owner, null]]);
      for (const [i, days, hour, et, host, outcome] of all) {
        const [name, email, phone, interest] = PEOPLE[i];
        const start = slot(days, hour);
        const leadId = db.run(`INSERT INTO leads (business_id, token, source, status, event_type_id, first_name, last_name, email, phone, answers, completed_at, last_activity_at, created_at)
          VALUES (?,?,'booking',?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now', ?))`,
        b.id, token(16), outcome === 'booked' ? 'won' : 'booked', et.id, name.split(' ')[0], name.split(' ')[1], email, phone,
        JSON.stringify({ notes: interest }), `-${Math.abs(days) + 2} day`).lastId;
        db.run(`INSERT INTO bookings (business_id, event_type_id, host_user_id, lead_id, token, start_utc, end_utc, invitee_tz, name, email, phone, location, answers, status, outcome, outcome_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.id, et.id, host.id, leadId, token(16), new Date(start).toISOString(), new Date(start + et.duration_min * 60000).toISOString(), 'America/Chicago',
        name, email, phone, `Phone call: ${phone}`, JSON.stringify({ notes: interest }), outcome === 'no_show' ? 'no_show' : 'confirmed', outcome || null, outcome ? new Date().toISOString() : null);
      }
    }
    // A couple of people who started a form and did not finish, so Leads shows what partials look like.
    if (!db.get("SELECT 1 FROM leads WHERE business_id = ? AND status = 'partial'", b.id)) {
      for (const [name, email, phone] of [['Rachel Kim', 'rachel.kim@example.com', '(713) 555-0191'], ['Tom Becker', 'tom.becker@example.com', null]]) {
        db.run(`INSERT INTO leads (business_id, token, source, status, event_type_id, first_name, last_name, email, phone, step_index, step_total, max_step_index, last_activity_at)
          VALUES (?,?,'booking','partial',?,?,?,?,?,1,3,1,datetime('now','-3 hour'))`, b.id, token(16), discovery.id, name.split(' ')[0], name.split(' ')[1], email, phone);
      }
    }
    return { email: EMAIL, password, company: b.name, slug: b.slug };
  });
}

module.exports = { ensureReviewDemo, EMAIL };
