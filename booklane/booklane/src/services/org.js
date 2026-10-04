'use strict';
/**
 * Teams and booking types: the two ways a business files its booking pages.
 *
 * They answer different questions and are deliberately not the same list. A team is who does the
 * work - the imaging team runs engagement sessions, and it also runs headshots. A type is what kind
 * of booking it is - a sales call is a sales call whoever happens to take it. Folding them into one
 * field would mean one of them became a rename of the other the first time they disagreed.
 *
 * Both are per business, so one company's "Imaging Team" is never visible to another.
 */
const db = require('../db');
const { HttpError } = require('../lib/router');
const { clampStr } = require('../lib/util');

const COLOR = /^#[0-9a-f]{6}$/i;

const listTeams = (businessId, { all = false } = {}) =>
  db.all(`SELECT * FROM teams WHERE business_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, id`, businessId)
    .map((t) => ({ ...t, active: !!t.active, members: memberIds(t.id) }));

const memberIds = (teamId) => db.all('SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id', teamId).map((r) => r.user_id);

const listTypes = (businessId, { all = false } = {}) =>
  db.all(`SELECT * FROM booking_types WHERE business_id = ? ${all ? '' : 'AND active = 1'} ORDER BY sort, id`, businessId)
    .map((t) => ({ ...t, active: !!t.active }));

// Teams a person is on, for showing on their row in the people list.
const teamsOf = (businessId, userId) =>
  db.all('SELECT t.id, t.name FROM teams t JOIN team_members m ON m.team_id = t.id WHERE t.business_id = ? AND m.user_id = ? ORDER BY t.sort, t.id', businessId, userId);

function requireName(name, what) {
  // Trimmed before the check, because clampStr does not: a team called "   " passes an emptiness
  // test, then shows as a blank heading nobody can click on and nobody can find to rename.
  const n = String(clampStr(name, 80) || '').trim();
  if (!n) throw new HttpError(422, `Give this ${what} a name`, { name: 'Required' });
  return n;
}
// Two teams called the same thing is a mistake every time, and it makes the dropdown unusable.
function requireUnique(table, businessId, name, exceptId) {
  const hit = db.get(`SELECT id FROM ${table} WHERE business_id = ? AND lower(name) = lower(?) AND id != ?`, businessId, name, exceptId || 0);
  if (hit) throw new HttpError(409, `You already have one called "${name}"`, { name: 'Already used' });
}
const nextSort = (table, businessId) => ((db.get(`SELECT MAX(sort) m FROM ${table} WHERE business_id = ?`, businessId) || {}).m || 0) + 1;

function saveTeam(businessId, body, existing, validUserIds) {
  const name = requireName(body.name ?? existing?.name, 'team');
  requireUnique('teams', businessId, name, existing?.id);
  const f = {
    name, description: clampStr(body.description ?? existing?.description, 500),
    color: COLOR.test(body.color || '') ? body.color : existing?.color || '#6d4aff',
    active: body.active === undefined ? (existing ? existing.active : 1) : body.active ? 1 : 0,
  };
  return db.tx(() => {
    let id = existing?.id;
    const keys = Object.keys(f);
    if (id) db.run(`UPDATE teams SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND business_id = ?`, ...keys.map((k) => f[k]), id, businessId);
    else id = db.run(`INSERT INTO teams (business_id, sort, ${keys.join(', ')}) VALUES (?,?,${keys.map(() => '?').join(',')})`, businessId, nextSort('teams', businessId), ...keys.map((k) => f[k])).lastId;
    // Only touch the roster when one was sent, so saving a rename does not empty the team.
    if (Array.isArray(body.members)) {
      const valid = new Set(validUserIds);
      db.run('DELETE FROM team_members WHERE team_id = ?', id);
      for (const u of [...new Set(body.members.map(Number))].filter((u) => valid.has(u))) {
        db.run('INSERT INTO team_members (team_id, user_id) VALUES (?,?)', id, u);
      }
    }
    const row = db.get('SELECT * FROM teams WHERE id = ?', id);
    return { ...row, active: !!row.active, members: memberIds(id) };
  });
}

function saveType(businessId, body, existing) {
  const name = requireName(body.name ?? existing?.name, 'booking type');
  requireUnique('booking_types', businessId, name, existing?.id);
  const f = {
    name, description: clampStr(body.description ?? existing?.description, 500),
    active: body.active === undefined ? (existing ? existing.active : 1) : body.active ? 1 : 0,
  };
  const keys = Object.keys(f);
  let id = existing?.id;
  if (id) db.run(`UPDATE booking_types SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND business_id = ?`, ...keys.map((k) => f[k]), id, businessId);
  else id = db.run(`INSERT INTO booking_types (business_id, sort, ${keys.join(', ')}) VALUES (?,?,${keys.map(() => '?').join(',')})`, businessId, nextSort('booking_types', businessId), ...keys.map((k) => f[k])).lastId;
  const row = db.get('SELECT * FROM booking_types WHERE id = ?', id);
  return { ...row, active: !!row.active };
}

/**
 * Deleting a team or a type leaves the booking pages alone and simply unfiles them.
 *
 * The alternative - refusing while anything still points at it - means tidying up a list you no
 * longer use turns into hunting down every page that mentions it. An unfiled page still works and
 * still takes bookings; it just loses a label, which the admin says before it happens.
 */
function removeTeam(businessId, id) {
  return db.tx(() => {
    const n = db.run('UPDATE event_types SET team_id = NULL WHERE team_id = ? AND business_id = ?', id, businessId).changes;
    if (!db.run('DELETE FROM teams WHERE id = ? AND business_id = ?', id, businessId).changes) throw new HttpError(404, 'Not found');
    return { ok: true, pages_unassigned: n };
  });
}
function removeType(businessId, id) {
  return db.tx(() => {
    const n = db.run('UPDATE event_types SET booking_type_id = NULL WHERE booking_type_id = ? AND business_id = ?', id, businessId).changes;
    if (!db.run('DELETE FROM booking_types WHERE id = ? AND business_id = ?', id, businessId).changes) throw new HttpError(404, 'Not found');
    return { ok: true, pages_unassigned: n };
  });
}

// A page may only be filed under this business's own teams and types; anything else is dropped
// rather than stored, so a stale id in a form never points a page at another company's label.
const ownId = (table, businessId, value) => {
  const n = Number(value);
  if (!n) return null;
  return db.get(`SELECT 1 FROM ${table} WHERE id = ? AND business_id = ?`, n, businessId) ? n : null;
};
const teamIdFor = (businessId, v) => ownId('teams', businessId, v);
const typeIdFor = (businessId, v) => ownId('booking_types', businessId, v);

/**
 * Group booking pages for the public page: type headings in the order the admin set, each page
 * carrying its team. Pages with no type are not dropped - they go in a final group with no heading,
 * because a page that takes bookings must never disappear from the list for want of a label.
 */
function groupByType(businessId, pages) {
  const types = listTypes(businessId);
  const groups = types.map((t) => ({ id: t.id, name: t.name, description: t.description || '', pages: [] }));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const loose = { id: null, name: '', description: '', pages: [] };
  for (const p of pages) (byId.get(Number(p.booking_type_id)) || loose).pages.push(p);
  const out = groups.filter((g) => g.pages.length);
  if (loose.pages.length) out.push(loose);
  return out;
}

module.exports = { listTeams, listTypes, teamsOf, saveTeam, saveType, removeTeam, removeType, teamIdFor, typeIdFor, groupByType, memberIds };
