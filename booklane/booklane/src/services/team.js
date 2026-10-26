'use strict';
// Team performance: what each person on the team has on their calendar, how much of their time is
// booked, and what came of it.
//
// Everything is counted from meetings whose START falls in the range, in the business's timezone,
// so "last 30 days" means the calls that happened (or were due to happen) in those 30 days, not
// the ones that happened to be booked then. Cancelled calls are counted but never treated as
// time worked.
const db = require('../db');
const T = require('../lib/time');
const S = require('./scheduling');

/** Resolve a range from the query: explicit dates, or the last N days ending today. */
function rangeFrom(business, { from, to, days } = {}) {
  const tz = business.timezone || 'America/Chicago';
  const today = T.utcToZoned(Date.now(), tz).date;
  let f = T.isDateStr(from) ? from : null;
  let t = T.isDateStr(to) ? to : null;
  if (!f || !t) {
    const n = Math.max(1, Math.min(366, Number(days) || 30));
    t = today;
    f = T.addDays(today, -(n - 1));
  }
  if (t < f) [f, t] = [t, f];
  // A range longer than a year would make the availability walk slow and the numbers meaningless.
  if (Date.parse(t) - Date.parse(f) > 366 * 86400000) f = T.addDays(t, -365);
  return {
    from: f, to: t, tz,
    fromIso: new Date(T.zonedToUtc(f, 0, tz)).toISOString(),
    toIso: new Date(T.zonedToUtc(T.addDays(t, 1), 0, tz)).toISOString(),
  };
}

const people = (businessId) => db.all(`SELECT u.id, u.name, u.email, u.timezone, m.role
  FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE m.business_id = ? AND m.status = 'active' AND COALESCE(u.is_resource, 0) = 0 ORDER BY u.name`, businessId);

/** Minutes this person was open for calls on each day of the range, from their hours and days off. */
function availableMinutes(user, range) {
  const cache = {};
  let total = 0;
  for (let d = range.from, guard = 0; d <= range.to && guard < 400; d = T.addDays(d, 1), guard++) {
    for (const [ws, we] of S.windowsFor(user.id, d, cache)) total += Math.max(0, we - ws);
  }
  return total;
}

const minutesOf = (b) => Math.max(0, Math.round((Date.parse(b.end_utc) - Date.parse(b.start_utc)) / 60000));

function rowFor(user, bookings, range, teamTotal) {
  const now = Date.now();
  const mine = bookings.filter((b) => b.host_user_id === user.id);
  const held = mine.filter((b) => b.status !== 'cancelled');
  const completed = mine.filter((b) => b.status === 'confirmed' && Date.parse(b.end_utc) <= now);
  const noShows = mine.filter((b) => b.status === 'no_show');
  const upcoming = mine.filter((b) => b.status === 'confirmed' && Date.parse(b.start_utc) > now);
  const cancelled = mine.filter((b) => b.status === 'cancelled');
  const bookedMin = held.reduce((n, b) => n + minutesOf(b), 0);
  const availMin = availableMinutes(user, range);
  const leadHours = held.map((b) => (Date.parse(b.start_utc) - Date.parse(b.created_at.replace(' ', 'T') + 'Z')) / 3600000).filter((h) => Number.isFinite(h) && h >= 0);

  // Leads this person worked: anyone they met with in the range, plus leads assigned to them.
  const leadIds = new Set(held.map((b) => b.lead_id).filter(Boolean));
  for (const r of db.all('SELECT id FROM leads WHERE owner_user_id = ? AND created_at >= ? AND created_at < ?', user.id, range.fromIso.replace('T', ' ').slice(0, 19), range.toIso.replace('T', ' ').slice(0, 19))) leadIds.add(r.id);
  const ids = [...leadIds];
  const q = ids.length
    ? db.get(`SELECT SUM(status != 'draft' AND total > 0) quotes, SUM(status = 'contract_requested') contracts,
        COALESCE(SUM(CASE WHEN status = 'contract_requested' THEN total ELSE 0 END), 0) contract_value
        FROM quotes WHERE lead_id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : { quotes: 0, contracts: 0, contract_value: 0 };
  const decided = completed.length + noShows.length;

  return {
    id: user.id, name: user.name, email: user.email, role: user.role,
    meetings: mine.length,
    held: held.length,
    completed: completed.length,
    upcoming: upcoming.length,
    cancelled: cancelled.length,
    no_shows: noShows.length,
    show_rate: decided ? Math.round((completed.length / decided) * 100) : null,
    cancel_rate: mine.length ? Math.round((cancelled.length / mine.length) * 100) : null,
    booked_hours: Math.round((bookedMin / 60) * 10) / 10,
    available_hours: Math.round((availMin / 60) * 10) / 10,
    utilization: availMin ? Math.round((bookedMin / availMin) * 100) : null,
    share: teamTotal ? Math.round((held.length / teamTotal) * 100) : null,
    avg_lead_days: leadHours.length ? Math.round((leadHours.reduce((a, b) => a + b, 0) / leadHours.length / 24) * 10) / 10 : null,
    leads: ids.length,
    quotes: q.quotes || 0,
    contracts: q.contracts || 0,
    contract_value: q.contract_value || 0,
    has_hours: !!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', user.id),
    calendars: db.get('SELECT COUNT(*) c FROM calendar_connections WHERE user_id = ?', user.id).c,
  };
}

function bookingsIn(businessId, range, userId) {
  return db.all(`SELECT b.*, e.name event_name, e.color FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id
    WHERE b.business_id = ? AND b.start_utc >= ? AND b.start_utc < ?${userId ? ' AND b.host_user_id = ?' : ''}`,
  businessId, range.fromIso, range.toIso, ...(userId ? [userId] : []));
}

function teamStats(business, query = {}) {
  const range = rangeFrom(business, query);
  const all = bookingsIn(business.id, range);
  const teamTotal = all.filter((b) => b.status !== 'cancelled').length;
  const rows = people(business.id).map((u) => rowFor(u, all, range, teamTotal));
  const sum = (k) => rows.reduce((n, r) => n + (r[k] || 0), 0);
  const decided = sum('completed') + sum('no_shows');
  const booked = sum('booked_hours'), avail = sum('available_hours');
  return {
    range: { from: range.from, to: range.to, timezone: range.tz },
    people: rows,
    totals: {
      meetings: sum('meetings'), held: sum('held'), completed: sum('completed'), upcoming: sum('upcoming'),
      cancelled: sum('cancelled'), no_shows: sum('no_shows'),
      show_rate: decided ? Math.round((sum('completed') / decided) * 100) : null,
      booked_hours: Math.round(booked * 10) / 10, available_hours: Math.round(avail * 10) / 10,
      utilization: avail ? Math.round((booked / avail) * 100) : null,
      leads: sum('leads'), quotes: sum('quotes'), contracts: sum('contracts'), contract_value: sum('contract_value'),
    },
  };
}

const meetingOut = (b) => ({
  id: b.id, token: b.token, start_utc: b.start_utc, end_utc: b.end_utc, status: b.status,
  name: b.name, email: b.email, phone: b.phone, event_name: b.event_name, color: b.color,
  lead_id: b.lead_id, cancel_reason: b.cancel_reason,
});

/** One person: their numbers, how they split across booking pages, and their meetings. */
function personDetail(business, userId, query = {}) {
  const user = people(business.id).find((u) => u.id === Number(userId));
  if (!user) return null;
  const range = rangeFrom(business, query);
  const all = bookingsIn(business.id, range);
  const teamTotal = all.filter((b) => b.status !== 'cancelled').length;
  const mine = all.filter((b) => b.host_user_id === user.id);
  const byPage = {};
  for (const b of mine) {
    const k = b.event_name || 'Deleted page';
    byPage[k] = byPage[k] || { page: k, meetings: 0, cancelled: 0, no_shows: 0 };
    byPage[k].meetings++;
    if (b.status === 'cancelled') byPage[k].cancelled++;
    if (b.status === 'no_show') byPage[k].no_shows++;
  }
  const now = new Date().toISOString();
  const upcoming = db.all(`SELECT b.*, e.name event_name, e.color FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id
    WHERE b.business_id = ? AND b.host_user_id = ? AND b.status = 'confirmed' AND b.start_utc >= ? ORDER BY b.start_utc LIMIT 100`, business.id, user.id, now);
  const past = mine.filter((b) => b.start_utc < now).sort((a, b) => (a.start_utc < b.start_utc ? 1 : -1));
  return {
    range: { from: range.from, to: range.to, timezone: range.tz },
    person: rowFor(user, all, range, teamTotal),
    by_page: Object.values(byPage).sort((a, b) => b.meetings - a.meetings),
    upcoming: upcoming.map(meetingOut),
    past: past.map(meetingOut),
  };
}

module.exports = { teamStats, personDetail, rangeFrom, availableMinutes };
