'use strict';
// "Log in as" a teammate, and teammates' Outlook calendars reached through an admin's own Outlook.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'availvo-acting-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

const db = require('../src/db');
const { app } = require('../src/server');
const { encrypt } = require('../src/lib/security');

let server, base;
async function req(method, url, body, { cookie } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

before(async () => {
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
});
after(() => server.close());

let owner, ownerId, hostId, adminCookie, adminId;

async function join(email, name, role) {
  const inv = await req('POST', '/api/admin/team', { name, email, role }, { cookie: owner });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const row = db.get('SELECT invite_token FROM memberships WHERE user_id = ?', inv.data.user_id);
  const acc = await req('POST', '/api/admin/auth/accept', { token: row.invite_token, name, password: 'password123' });
  assert.equal(acc.status, 200, JSON.stringify(acc.data));
  return { id: inv.data.user_id, cookie: acc.cookie };
}

test('set up a company with an owner, an admin and a host', async () => {
  require('../src/lib/security').resetRateLimits();
  const r = await req('POST', '/api/admin/auth/signup', { name: 'Alex Owner', email: 'alex@wu.test', password: 'password123', business_name: 'WU Test', timezone: 'America/Chicago', accept_terms: true });
  assert.equal(r.status, 200);
  owner = r.cookie;
  ownerId = db.get("SELECT id FROM users WHERE email = 'alex@wu.test'").id;
  const h = await join('zina@wu.test', 'Zina Host', 'host');
  hostId = h.id;
  const a = await join('kenny@wu.test', 'Kenny Admin', 'admin');
  adminId = a.id; adminCookie = a.cookie;
});

test('an owner can log in as a host, act as them, and go back', async () => {
  const r = await req('POST', `/api/admin/team/${hostId}/login-as`, {}, { cookie: owner });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const acting = r.cookie;
  assert.ok(acting && acting !== owner);

  const me = (await req('GET', '/api/admin/auth/me', null, { cookie: acting })).data;
  assert.equal(me.user.id, hostId);
  assert.equal(me.business.role, 'host');
  assert.equal(me.acting_as.by.id, ownerId);
  assert.equal(me.platform_admin, false, 'the platform admin flag does not carry over');

  // Their work: hours can be changed, and the change is recorded against the owner.
  const hours = await req('PUT', '/api/admin/availability', { rules: [{ weekday: 2, start_min: 600, end_min: 900 }] }, { cookie: acting });
  assert.equal(hours.status, 200);
  assert.equal(db.get('SELECT start_min FROM availability_rules WHERE user_id = ?', hostId).start_min, 600);

  // Not who they are.
  assert.equal((await req('PATCH', '/api/admin/me', { current_password: 'password123', new_password: 'hijacked99' }, { cookie: acting })).status, 403);
  assert.equal((await req('POST', '/api/admin/push/devices', { token: 'x'.repeat(64), platform: 'ios' }, { cookie: acting })).status, 403);
  assert.equal((await req('POST', '/api/admin/account/delete', { password: 'password123', confirm: 'DELETE' }, { cookie: acting })).status, 403);
  assert.equal((await req('POST', '/api/admin/auth/handoff', { next: '/app' }, { cookie: acting })).status, 403);
  assert.equal((await req('POST', '/api/admin/businesses', { name: 'Side gig' }, { cookie: acting })).status, 403);
  assert.equal((await req('POST', `/api/admin/team/${adminId}/login-as`, {}, { cookie: acting })).status, 403);

  // The host can see who was in their account and what changed.
  const back = await req('POST', '/api/admin/auth/stop-acting', {}, { cookie: acting });
  assert.equal(back.status, 200);
  assert.equal(back.data.back, true);
  assert.equal(back.cookie, owner, 'the owner\'s own session is restored');
  assert.equal((await req('GET', '/api/admin/auth/me', null, { cookie: acting })).status, 401, 'the acting session is gone');
  assert.equal((await req('GET', '/api/admin/auth/me', null, { cookie: owner })).data.user.id, ownerId);

  const hostLogin = await req('POST', '/api/admin/auth/login', { email: 'zina@wu.test', password: 'password123' });
  const log = (await req('GET', '/api/admin/account/access-log', null, { cookie: hostLogin.cookie })).data;
  assert.ok(log.some((l) => l.action === 'login' && l.actor === 'Alex Owner'));
  assert.ok(log.some((l) => l.action === 'change' && /PUT \/availability/.test(l.detail)));
  assert.ok(!log.some((l) => /me$/.test(l.detail || '') && l.action !== 'change'));
});

test('an admin cannot log in as an owner; a host cannot log in as anyone', async () => {
  assert.equal((await req('POST', `/api/admin/team/${ownerId}/login-as`, {}, { cookie: adminCookie })).status, 403);
  assert.equal((await req('POST', `/api/admin/team/${hostId}/login-as`, {}, { cookie: adminCookie })).status, 200);
  const hostLogin = await req('POST', '/api/admin/auth/login', { email: 'zina@wu.test', password: 'password123' });
  assert.equal((await req('POST', `/api/admin/team/${adminId}/login-as`, {}, { cookie: hostLogin.cookie })).status, 403);
  assert.equal((await req('POST', `/api/admin/team/${ownerId}/login-as`, {}, { cookie: owner })).status, 422, 'not yourself');
});

test('logging out while acting logs the admin out too; losing admin rights ends it', async () => {
  const r = await req('POST', `/api/admin/team/${hostId}/login-as`, {}, { cookie: adminCookie });
  const out = await req('POST', '/api/admin/auth/logout', {}, { cookie: r.cookie });
  assert.equal(out.status, 200);
  assert.equal((await req('GET', '/api/admin/auth/me', null, { cookie: adminCookie })).status, 401);

  const again = await req('POST', '/api/admin/auth/login', { email: 'kenny@wu.test', password: 'password123' });
  adminCookie = again.cookie;
  const r2 = await req('POST', `/api/admin/team/${hostId}/login-as`, {}, { cookie: adminCookie });
  db.run("UPDATE memberships SET role = 'host' WHERE user_id = ?", adminId);
  assert.equal((await req('GET', '/api/admin/auth/me', null, { cookie: r2.cookie })).status, 401);
  db.run("UPDATE memberships SET role = 'admin' WHERE user_id = ?", adminId);
});

// ---------- Shared Outlook calendars ----------

function fakeGraph({ calendarStatus = 200, canEdit = true, scopes = 'Calendars.ReadWrite Calendars.ReadWrite.Shared User.Read' } = {}) {
  const calls = [];
  const jwt = `x.${Buffer.from(JSON.stringify({ scp: scopes })).toString('base64url')}.y`;
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith('https://')) return realFetch(url, opts);
    calls.push({ url: u, method: opts.method || 'GET', body: (() => { try { return JSON.parse(opts.body); } catch { return opts.body || null; } })(), auth: opts.headers && opts.headers.Authorization });
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.startsWith('https://login.microsoftonline.com/')) return json({ access_token: jwt, expires_in: 3600 });
    const denied = () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403);
    if (/\/users\/zina%40wu\.test\/calendar\?/.test(u)) return calendarStatus === 200 ? json({ canEdit, name: 'Calendar' }) : denied();
    if (/\/users\/zina%40wu\.test\/calendar\/calendarView/.test(u)) {
      if (calendarStatus !== 200) return denied();
      return json({ value: [{ subject: 'Dentist', start: { dateTime: '2030-01-08T16:00:00.0000000' }, end: { dateTime: '2030-01-08T17:00:00.0000000' }, showAs: 'busy', isAllDay: false }] });
    }
    if (u.endsWith('/me/calendar/getSchedule')) {
      return json({ value: [{ scheduleId: 'zina@wu.test', scheduleItems: [{ status: 'busy', start: { dateTime: '2030-01-08T18:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2030-01-08T19:00:00.0000000', timeZone: 'UTC' } }] }] });
    }
    if (/\/users\/zina%40wu\.test\/calendar\/events$/.test(u) && opts.method === 'POST') return canEdit ? json({ id: 'evt-1' }, 201) : denied();
    if (/\/users\/zina%40wu\.test\/calendar\/events\/evt-1$/.test(u)) return new Response(null, { status: 204 });
    return json({ error: { code: 'NotStubbed', message: u } }, 500);
  };
  return { calls, restore: () => { global.fetch = realFetch; } };
}

let sourceId;
test('an admin links a teammate\'s shared Outlook calendar through their own Outlook', async () => {
  process.env.MICROSOFT_CLIENT_ID = 'cid'; process.env.MICROSOFT_CLIENT_SECRET = 'secret';
  sourceId = db.run('INSERT INTO calendar_connections (user_id, provider, account_email, access_token, refresh_token, expires_at) VALUES (?,?,?,?,?,?)',
    ownerId, 'microsoft', 'alex@wu.test', encrypt('old'), encrypt('refresh'), Date.now() - 1000).lastId;
  const g = fakeGraph();
  try {
    const list = await req('GET', `/api/admin/team/${hostId}/calendars`, null, { cookie: owner });
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.sources.map((s) => s.id), [sourceId]);

    assert.equal((await req('POST', `/api/admin/team/${hostId}/calendars/shared`, { source_id: sourceId, mailbox: 'alex@wu.test' }, { cookie: owner })).status, 422, 'not your own calendar');
    const hostLogin = await req('POST', '/api/admin/auth/login', { email: 'zina@wu.test', password: 'password123' });
    assert.equal((await req('POST', `/api/admin/team/${hostId}/calendars/shared`, { source_id: sourceId }, { cookie: hostLogin.cookie })).status, 403, 'hosts cannot');

    const r = await req('POST', `/api/admin/team/${hostId}/calendars/shared`, { source_id: sourceId }, { cookie: owner });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.access, 'edit', JSON.stringify(r.data));
    const row = db.get('SELECT * FROM calendar_connections WHERE user_id = ?', hostId);
    assert.equal(row.mailbox, 'zina@wu.test');
    assert.equal(row.via_connection_id, sourceId);
    assert.equal(row.access_token, null, 'no sign-in of their own is stored');
    assert.equal(row.write_events, 1);

    // Busy times come from her calendar, read with the owner's token.
    const calendars = require('../src/services/calendars');
    const busy = await calendars.getBusy(hostId, Date.UTC(2030, 0, 8), Date.UTC(2030, 0, 9));
    assert.deepEqual(busy, [[Date.UTC(2030, 0, 8, 16), Date.UTC(2030, 0, 8, 17)]]);

    // Bookings go on her calendar, with no attendees (the customer already has our invite).
    const ev = await calendars.createEvent(hostId, { summary: 'Call', description: 'x', start: Date.UTC(2030, 0, 9, 15), end: Date.UTC(2030, 0, 9, 15, 30), attendeeEmail: 'cust@x.test', attendeeName: 'Cust', timezone: 'America/Chicago' });
    assert.equal(ev.event_id, 'evt-1');
    const post = g.calls.find((c) => c.method === 'POST' && c.url.endsWith('/users/zina%40wu.test/calendar/events'));
    assert.ok(post, 'event created on her calendar');
    assert.equal(post.body.attendees, undefined);
    await calendars.deleteEvent(ev);
    assert.ok(g.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/users/zina%40wu.test/calendar/events/evt-1')));

    // She sees it on her own Calendars screen, and whose Outlook it goes through.
    const mine = await req('GET', '/api/admin/calendars', null, { cookie: hostLogin.cookie });
    assert.equal(mine.data.connections[0].shared, true);
    assert.equal(mine.data.connections[0].via_email, 'alex@wu.test');
  } finally { g.restore(); }
});

test('not shared: free/busy still blocks times, and the admin is told what to ask for', async () => {
  const g = fakeGraph({ calendarStatus: 403 });
  try {
    const conn = db.get('SELECT id FROM calendar_connections WHERE user_id = ?', hostId);
    const r = await req('POST', `/api/admin/team/${hostId}/calendars/${conn.id}/check`, {}, { cookie: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.access, 'free_busy');
    assert.match(r.data.note, /Can edit/);
    const calendars = require('../src/services/calendars');
    calendars.clearBusyCache(hostId);
    const busy = await calendars.getBusy(hostId, Date.UTC(2030, 0, 8), Date.UTC(2030, 0, 9));
    assert.deepEqual(busy, [[Date.UTC(2030, 0, 8, 18), Date.UTC(2030, 0, 8, 19)]]);
  } finally { g.restore(); }

  // An old sign-in without the shared-calendar permission says so.
  const g2 = fakeGraph({ calendarStatus: 403, scopes: 'Calendars.ReadWrite User.Read' });
  try {
    db.run('UPDATE calendar_connections SET expires_at = 0 WHERE id = ?', sourceId);
    const conn = db.get('SELECT id FROM calendar_connections WHERE user_id = ?', hostId);
    const r = await req('POST', `/api/admin/team/${hostId}/calendars/${conn.id}/check`, {}, { cookie: owner });
    assert.equal(r.data.needs_scope, true);
    assert.match(r.data.note, /Reconnect your own Outlook/);
  } finally { g2.restore(); }
});

test('disconnecting the admin\'s Outlook removes the calendars that went through it', async () => {
  assert.equal(db.get('SELECT COUNT(*) c FROM calendar_connections WHERE via_connection_id = ?', sourceId).c, 1);
  const r = await req('DELETE', `/api/admin/calendars/${sourceId}`, null, { cookie: owner });
  assert.equal(r.status, 200);
  assert.equal(db.get('SELECT COUNT(*) c FROM calendar_connections WHERE user_id = ?', hostId).c, 0);
});
