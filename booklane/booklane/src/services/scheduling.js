'use strict';
const db = require('../db');
const T = require('../lib/time');
const calendars = require('./calendars');

function hostsFor(eventTypeId) {
  return db.all(`SELECT u.id, u.name, u.email, u.timezone FROM users u JOIN event_type_hosts h ON h.user_id = u.id WHERE h.event_type_id = ? ORDER BY u.id`, eventTypeId);
}

function windowsFor(userId, dateStr, cache) {
  if (!cache.rules) {
    cache.rules = db.all('SELECT weekday, start_min, end_min FROM availability_rules WHERE user_id = ?', userId);
    cache.overrides = db.all('SELECT date, start_min, end_min, unavailable FROM date_overrides WHERE user_id = ?', userId);
  }
  const ov = cache.overrides.filter((o) => o.date === dateStr);
  if (ov.length) {
    if (ov.some((o) => o.unavailable)) return [];
    return ov.filter((o) => o.end_min > o.start_min).map((o) => [o.start_min, o.end_min]);
  }
  const wd = T.weekdayOf(dateStr);
  return cache.rules.filter((r) => r.weekday === wd && r.end_min > r.start_min).map((r) => [r.start_min, r.end_min]);
}

function internalBusy(userId, fromMs, toMs, excludeBookingId) {
  return db.all(`SELECT b.id, b.start_utc, b.end_utc, b.event_type_id, COALESCE(e.buffer_before,0) bb, COALESCE(e.buffer_after,0) ba
    FROM bookings b LEFT JOIN event_types e ON e.id = b.event_type_id
    WHERE b.host_user_id = ? AND b.status = 'confirmed' AND b.end_utc > ? AND b.start_utc < ?`,
  userId, new Date(fromMs - 86400000).toISOString(), new Date(toMs + 86400000).toISOString())
    .filter((b) => b.id !== excludeBookingId)
    .map((b) => ({ start: Date.parse(b.start_utc) - b.bb * 60000, end: Date.parse(b.end_utc) + b.ba * 60000, event_type_id: b.event_type_id, startRaw: Date.parse(b.start_utc) }));
}

/**
 * Compute open slots for an event type between two dates (inclusive) in the invitee's timezone.
 * Returns { [dateInInviteeTz]: [{ start: ISO, hosts: [userId] }] }
 */
async function computeSlots(et, fromDate, toDate, inviteeTz, { excludeBookingId, restrictHostIds, now = Date.now() } = {}) {
  let hosts = hostsFor(et.id);
  // A session on a market calendar only offers that market's openings, never the other cities'.
  if (Array.isArray(restrictHostIds)) {
    const allow = new Set(restrictHostIds.map(Number));
    hosts = hosts.filter((h) => allow.has(Number(h.id)));
  }
  const result = {};
  if (!hosts.length) return result;
  const dur = et.duration_min * 60000;
  const earliest = now + et.min_notice_min * 60000;
  const latest = now + et.max_days_ahead * 86400000;
  const fromMs = Math.max(T.zonedToUtc(fromDate, 0, inviteeTz), earliest);
  const toMs = Math.min(T.zonedToUtc(T.addDays(toDate, 1), 0, inviteeTz), latest);
  if (toMs <= fromMs) return result;
  const interval = Math.max(5, et.slot_interval_min || et.duration_min) ;
  const slotMap = new Map();

  for (const host of hosts) {
    const tz = T.isValidTz(host.timezone) ? host.timezone : 'UTC';
    const cache = {};
    const busy = internalBusy(host.id, fromMs, toMs, excludeBookingId);
    const external = await calendars.getBusy(host.id, fromMs - 3600000, toMs + 3600000);
    const allBusy = busy.map((b) => [b.start, b.end]).concat(external);
    let d = T.utcToZoned(fromMs - 86400000, tz).date;
    const endD = T.utcToZoned(toMs + 86400000, tz).date;
    let guard = 0;
    while (d <= endD && guard++ < 400) {
      const windows = windowsFor(host.id, d, cache);
      let dayCount = null;
      for (const [ws, we] of windows) {
        for (let m = ws; m + et.duration_min <= we; m += interval) {
          const start = T.zonedToUtc(d, m, tz);
          if (start < fromMs || start >= toMs) continue;
          const end = start + dur;
          const s0 = start - et.buffer_before * 60000, e0 = end + et.buffer_after * 60000;
          if (allBusy.some(([bs, be]) => bs < e0 && be > s0)) continue;
          if (et.daily_limit > 0) {
            if (dayCount === null) {
              const dayStart = T.zonedToUtc(d, 0, tz), dayEnd = T.zonedToUtc(T.addDays(d, 1), 0, tz);
              dayCount = busy.filter((b) => b.event_type_id === et.id && b.startRaw >= dayStart && b.startRaw < dayEnd).length;
            }
            if (dayCount >= et.daily_limit) continue;
          }
          const iso = new Date(start).toISOString();
          if (!slotMap.has(iso)) slotMap.set(iso, []);
          slotMap.get(iso).push(host.id);
        }
      }
      d = T.addDays(d, 1);
    }
  }
  for (const iso of [...slotMap.keys()].sort()) {
    const day = T.utcToZoned(Date.parse(iso), inviteeTz).date;
    (result[day] ||= []).push({ start: iso, hosts: slotMap.get(iso) });
  }
  return result;
}

async function availableHostsAt(et, startMs, opts = {}) {
  const tz = 'UTC';
  const day = T.utcToZoned(startMs, tz).date;
  const slots = await computeSlots(et, T.addDays(day, -1), T.addDays(day, 1), tz, opts);
  const iso = new Date(startMs).toISOString();
  for (const list of Object.values(slots)) for (const s of list) if (s.start === iso) return s.hosts;
  return [];
}

const LEVELS = ['senior', 'junior', 'staff'];
const normLevel = (v) => (LEVELS.includes(v) ? v : 'staff');

/**
 * How many services the customer picked, read from the first "Pick several" question in the steps
 * they filled in. Choices that send them to another calendar ("I'm a client") are not services and
 * do not count, and nor does anything that is not one of the question's own choices. null when
 * there is no pick-several question to count from.
 */
function servicesCount(steps, answers = {}) {
  for (const step of steps || []) {
    for (const q of step.questions || []) {
      if (q.type !== 'multi') continue;
      const routes = q.routes || {};
      const valid = new Map((q.options || []).filter((o) => !routes[o]).map((o) => [String(o).trim().toLowerCase(), o]));
      const picked = new Set([].concat(answers[q.id] ?? []).map((x) => String(x).trim().toLowerCase()).filter((x) => valid.has(x)));
      return picked.size;
    }
  }
  return null;
}

/**
 * Which level to try first, then where to go when nobody there is free. Each level steps down first
 * (senior, then junior, then staff). Only when nobody at or below the starting level is free does
 * it step up, so a one-service call still gets booked rather than turned away.
 */
function levelOrder(count) {
  if (count >= 3) return ['senior', 'junior', 'staff'];
  if (count === 2) return ['junior', 'staff', 'senior'];
  return ['staff', 'junior', 'senior'];
}

/** Whether this page's booking type matches people to the number of services picked. */
function matchesByServices(et) {
  if (!et.booking_type_id) return false;
  const t = db.get('SELECT match_by_services FROM booking_types WHERE id = ? AND business_id = ?', et.booking_type_id, et.business_id);
  return !!(t && t.match_by_services);
}

function pickHost(et, hostIds, opts = {}) {
  if (!hostIds.length) return null;
  if (et.assignment !== 'round_robin' || hostIds.length === 1) return hostIds[0];
  // Sales pages: narrow to the right level before anything else. Priority and the even spread
  // below then decide between the people at that level.
  if (opts.servicesCount != null && matchesByServices(et)) {
    const lv = new Map(db.all(`SELECT user_id, level FROM memberships WHERE business_id = ? AND user_id IN (${hostIds.map(() => '?').join(',')})`, et.business_id, ...hostIds).map((r) => [r.user_id, normLevel(r.level)]));
    for (const level of levelOrder(opts.servicesCount)) {
      const at = hostIds.filter((id) => (lv.get(id) || 'staff') === level);
      if (at.length) { hostIds = at; break; }
    }
    if (hostIds.length === 1) return hostIds[0];
  }
  // Priority first: of the people free at this time, only the highest-rated are in the running.
  // A low-priority host still gets calls whenever nobody above them is free.
  const prio = new Map(db.all(`SELECT user_id, priority FROM event_type_hosts WHERE event_type_id = ? AND user_id IN (${hostIds.map(() => '?').join(',')})`, et.id, ...hostIds).map((r) => [r.user_id, r.priority]));
  const top = Math.max(...hostIds.map((id) => prio.get(id) ?? 2));
  hostIds = hostIds.filter((id) => (prio.get(id) ?? 2) === top);
  if (hostIds.length === 1) return hostIds[0];
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const stats = hostIds.map((id) => {
    const r = db.get(`SELECT COUNT(*) c, MAX(created_at) last FROM bookings WHERE host_user_id = ? AND event_type_id = ? AND created_at >= ? AND status != 'cancelled'`, id, et.id, since);
    return { id, c: r.c, last: r.last || '' };
  });
  stats.sort((a, b) => a.c - b.c || a.last.localeCompare(b.last) || a.id - b.id);
  return stats[0].id;
}

module.exports = { computeSlots, availableHostsAt, pickHost, hostsFor, windowsFor, servicesCount, levelOrder, matchesByServices, LEVELS };
