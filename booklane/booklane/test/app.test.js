'use strict';
// End-to-end API tests. Run with: npm test
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booklane-test-'));
process.env.DB_FILE = path.join(dir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.ALLOW_PRIVATE_URLS = 'true';

const db = require('../src/db');
const { app, runJobs } = require('../src/server');
const T = require('../src/lib/time');

let server, base, hook, hookBase;
const hookHits = [];

async function req(method, url, body, { cookie, headers = {} } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

async function signup(email, business) {
  const r = await req('POST', '/api/admin/auth/signup', { name: 'Owner ' + business, email, password: 'password123', business_name: business, timezone: 'America/Chicago' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.cookie;
}

before(async () => {
  server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.BASE_URL = base;
  hook = http.createServer((q, s) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { hookHits.push({ url: q.url, headers: q.headers, body: b }); s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ok":true,"lead_id":42}'); }); });
  await new Promise((r) => hook.listen(0, r));
  hookBase = `http://127.0.0.1:${hook.address().port}`;
});
after(() => { server.close(); hook.close(); });

// Pick the next weekday date at least 3 days out
function nextWeekday(offset = 3) {
  let d = T.addDays(T.utcToZoned(Date.now(), 'America/Chicago').date, offset);
  while ([0, 6].includes(T.weekdayOf(d))) d = T.addDays(d, 1);
  return d;
}

let ownerCookie, bizSlug;

test('signup creates business, default call type and hours', async () => {
  ownerCookie = await signup('owner@test.dev', 'Acme Events');
  const me = await req('GET', '/api/admin/auth/me', null, { cookie: ownerCookie });
  assert.equal(me.data.business.role, 'owner');
  bizSlug = me.data.business.slug;
  assert.equal(bizSlug, 'acme-events');
  const page = await req('GET', `/b/${bizSlug}/discovery-call`);
  assert.equal(page.status, 200);
  assert.match(page.data, /Discovery call/);
});

test('slots respect hours, timezone and min notice', async () => {
  const day = nextWeekday();
  const r = await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/New_York`);
  const slots = r.data.days[day];
  assert.ok(slots.length > 0);
  // 9am Chicago == 10am New York
  assert.equal(T.utcToZoned(Date.parse(slots[0]), 'America/New_York').minutes, 10 * 60);
  const last = slots[slots.length - 1];
  assert.equal(T.utcToZoned(Date.parse(last), 'America/Chicago').minutes, 17 * 60 - 20);
});

test('partial lead capture saves each step and field', async () => {
  const c = await req('POST', `/api/public/b/${bizSlug}/leads`, { source: 'booking', event_type_slug: 'discovery-call', meta: { utm: { utm_source: 'instagram', evil: 'x' } } });
  const token = c.data.token;
  await req('PATCH', `/api/public/leads/${token}`, { step_index: 0, step_key: 'schedule', step_total: 4, answers: { requested_time: 'Tue 10am' } });
  await req('PATCH', `/api/public/leads/${token}`, { step_index: 1, step_key: 'contact', step_total: 4, contact: { first_name: 'Pat', email: 'not-an-email' } });
  await req('PATCH', `/api/public/leads/${token}`, { contact: { email: 'pat@example.com', phone: '713-555-0100' } });
  // sendBeacon posts text/plain
  const beacon = await fetch(`${base}/api/public/leads/${token}/beacon`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ step_index: 2, answers: { services: ['DJ'] } }) });
  assert.equal(beacon.status, 204);
  const lead = db.get('SELECT * FROM leads WHERE token = ?', token);
  assert.equal(lead.status, 'partial');
  assert.equal(lead.first_name, 'Pat');
  assert.equal(lead.email, 'pat@example.com');
  assert.equal(lead.max_step_index, 2);
  assert.deepEqual(JSON.parse(lead.answers), { requested_time: 'Tue 10am', services: ['DJ'] });
  assert.deepEqual(JSON.parse(lead.meta).utm, { utm_source: 'instagram' });

  // Abandoned job alerts the team once the lead is idle
  db.run("UPDATE leads SET last_activity_at = datetime('now', '-45 minutes') WHERE id = ?", lead.id);
  await runJobs();
  const alert = db.get("SELECT * FROM email_log WHERE subject LIKE 'Partial lead: Pat%'");
  assert.ok(alert, 'team got partial lead email');
  assert.match(alert.html, /pat@example.com/);
  await runJobs();
  assert.equal(db.get("SELECT COUNT(*) c FROM email_log WHERE subject LIKE 'Partial lead: Pat%'").c, 1, 'only alerted once');

  const list = await req('GET', '/api/admin/leads?status=partial', null, { cookie: ownerCookie });
  assert.ok(list.data.rows.some((r) => r.email === 'pat@example.com'));
});

test('booking completes lead, blocks double booking and honors buffers', async () => {
  const day = nextWeekday(4);
  const slots = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day];
  const lead = (await req('POST', `/api/public/b/${bizSlug}/leads`, { source: 'booking', event_type_slug: 'discovery-call' })).data.token;
  const contact = { first_name: 'Sam', last_name: 'Lee', email: 'sam@example.com', phone: '832-555-0101' };
  const missing = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { lead_token: lead, start: slots[0], timezone: 'America/Chicago', contact: { first_name: 'Sam', email: 'sam@example.com' } });
  assert.equal(missing.status, 422);
  assert.ok(missing.data.details.phone);
  const ok = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { lead_token: lead, start: slots[0], timezone: 'America/Chicago', contact, answers: { notes: 'hi' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(db.get('SELECT status FROM leads WHERE token = ?', lead).status, 'booked');
  const dup = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { start: slots[0], timezone: 'America/Chicago', contact: { ...contact, email: 'other@example.com' } });
  assert.equal(dup.status, 409);
  const after = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day];
  assert.ok(!after.includes(slots[0]));

  // buffer: add 30 min after-buffer to the type, next slot (20 min later) should vanish
  const et = db.get("SELECT id FROM event_types WHERE slug = 'discovery-call'");
  const patch = await req('PATCH', `/api/admin/event-types/${et.id}`, { buffer_after: 30 }, { cookie: ownerCookie });
  assert.equal(patch.status, 200, JSON.stringify(patch.data));
  const buffered = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day];
  assert.ok(!buffered.includes(slots[1]), 'slot inside buffer removed');
  await req('PATCH', `/api/admin/event-types/${et.id}`, { buffer_after: 0 }, { cookie: ownerCookie });

  // reschedule + cancel
  const bk = db.get('SELECT token FROM bookings ORDER BY id DESC LIMIT 1');
  const rs = await req('POST', `/api/public/bookings/${bk.token}/reschedule`, { start: slots[5], timezone: 'America/Chicago' });
  assert.equal(rs.status, 200, JSON.stringify(rs.data));
  const cancel = await req('POST', `/api/public/bookings/${bk.token}/cancel`, { reason: 'conflict' });
  assert.equal(cancel.status, 200);
  const ics = await fetch(`${base}/api/public/bookings/${bk.token}/ics`);
  assert.match(await ics.text(), /STATUS:CANCELLED/);
});

test('date overrides and round robin across hosts', async () => {
  const me = await req('GET', '/api/admin/auth/me', null, { cookie: ownerCookie });
  const add = await req('POST', '/api/admin/team', { name: 'Riley', email: 'riley@test.dev', role: 'host' }, { cookie: ownerCookie });
  assert.equal(add.status, 200);
  assert.equal(add.data.temp_password, undefined, 'no password is ever shown to the inviter');
  const inviteToken = add.data.invite_url.split('/accept/')[1];
  // invited (not yet accepted) people cannot be made hosts
  const early = await req('PATCH', `/api/admin/event-types/${db.get("SELECT id FROM event_types WHERE slug = 'discovery-call'").id}`, { hosts: [add.data.user_id] }, { cookie: ownerCookie });
  assert.deepEqual(early.data.hosts, [me.data.user.id]);
  const info = await req('GET', `/api/admin/auth/invite/${inviteToken}`);
  assert.equal(info.data.needs_password, true);
  const accepted = await req('POST', '/api/admin/auth/accept', { token: inviteToken, password: 'rileypass1' });
  assert.equal(accepted.status, 200);
  const rileyCookie = accepted.cookie;
  const rileyMe = await req('GET', '/api/admin/auth/me', null, { cookie: rileyCookie });
  assert.equal(rileyMe.data.business.role, 'host');
  const reuse = await req('POST', '/api/admin/auth/accept', { token: inviteToken, password: 'rileypass1' });
  assert.equal(reuse.status, 404);
  const et = db.get("SELECT id FROM event_types WHERE slug = 'discovery-call'");
  await req('PATCH', `/api/admin/event-types/${et.id}`, { hosts: [me.data.user.id, add.data.user_id] }, { cookie: ownerCookie });
  const day = nextWeekday(8);
  const slot = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day][2];
  const hosts = [];
  for (const email of ['a@x.dev', 'b@x.dev']) {
    const r = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { start: slot, timezone: 'America/Chicago', contact: { first_name: 'A', last_name: 'B', email, phone: '5555550100' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    hosts.push(db.get('SELECT host_user_id FROM bookings WHERE token = ?', r.data.token).host_user_id);
  }
  assert.notEqual(hosts[0], hosts[1], 'same slot went to two different hosts');
  const third = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { start: slot, timezone: 'America/Chicago', contact: { first_name: 'C', last_name: 'D', email: 'c@x.dev', phone: '5555550100' } });
  assert.equal(third.status, 409);

  // Owner marks a day off → only Riley remains
  const day2 = nextWeekday(10);
  await req('PUT', '/api/admin/availability', { rules: [1, 2, 3, 4, 5].map((w) => ({ weekday: w, start_min: 540, end_min: 1020 })), overrides: [{ date: day2, unavailable: true }] }, { cookie: ownerCookie });
  await req('PUT', `/api/admin/availability`, { user_id: add.data.user_id, rules: [], overrides: [] }, { cookie: ownerCookie });
  const none = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day2}&to=${day2}&tz=America/Chicago`)).data.days[day2];
  assert.equal(none, undefined, 'no slots when everyone is off');
});

test('quote pricing is computed server side; contract request emails, pushes to BoothBook and webhook', async () => {
  const svc = await req('POST', '/api/admin/services', {
    name: 'DJ', pricing_type: 'flat', option_groups: [{ name: 'Package', mode: 'base', required: true, choices: [{ name: 'Silver', price: 1000, default: true }, { name: 'Gold', price: 1500 }] }],
    addons: [{ name: 'Uplights', price: 30, max: 20 }],
  }, { cookie: ownerCookie });
  assert.equal(svc.status, 200, JSON.stringify(svc.data));
  const photo = await req('POST', '/api/admin/services', { name: 'Photo', pricing_type: 'hourly', base_price: 200, min_qty: 4, max_qty: 10 }, { cookie: ownerCookie });
  const settings = await req('PATCH', '/api/admin/business', { settings: {
    quote: { tax_rate: 10, bundle_discounts: [{ min_services: 2, percent: 10 }], deposit_type: 'percent', deposit_value: 25 },
    integrations: { boothbook: { enabled: true, url: `${hookBase}/boothbook`, key: 'K', secret: 'S3CRET' }, webhook: { enabled: true, url: `${hookBase}/hook`, secret: 'whsec' } },
  } }, { cookie: ownerCookie });
  assert.equal(settings.status, 200);
  assert.equal(settings.data.settings.integrations.boothbook.secret, '••••••••', 'secret masked');

  const created = await req('POST', `/api/public/b/${bizSlug}/quotes`, {});
  const qt = created.data.token;
  const gold = svc.data.option_groups[0].choices[1].id;
  const q = await req('PATCH', `/api/public/quotes/${qt}`, {
    step_index: 1, step_total: 4, details: { event_type: 'Wedding', event_date: '2027-04-10', venue: 'The Barn' },
    selections: [{ service_id: svc.data.id, options: { [svc.data.option_groups[0].id]: gold }, addons: { [svc.data.addons[0].id]: 10 } }, { service_id: photo.data.id, qty: 99 }],
    // client-sent totals must be ignored
    total: 1,
  });
  // DJ 1500 + 300 uplights = 1800; photo clamped to 10h = 2000; subtotal 3800; -10% = 3420; tax 342 = 3762; deposit ceil(940.5)=941
  assert.equal(q.data.subtotal, 3800);
  assert.equal(q.data.discount, 380);
  assert.equal(q.data.total, 3762);
  assert.equal(q.data.deposit, 941);

  const noContact = await req('POST', `/api/public/quotes/${qt}/contract`, {});
  assert.equal(noContact.status, 422);
  await req('PATCH', `/api/public/quotes/${qt}`, { step_index: 2, contact: { first_name: 'Jo', last_name: 'Park', email: 'jo@example.com', phone: '2815550199' } });
  const lead = db.get('SELECT * FROM leads WHERE id = (SELECT lead_id FROM quotes WHERE token = ?)', qt);
  assert.equal(lead.email, 'jo@example.com');
  assert.equal(JSON.parse(lead.answers).event_date, '2027-04-10', 'quote details mirrored onto the lead');

  hookHits.length = 0;
  const contract = await req('POST', `/api/public/quotes/${qt}/contract`, { legal_name: 'Jo Park', venue_address: '1 Farm Rd', notes: 'Sunset ceremony', agreed_terms: true });
  assert.equal(contract.status, 200, JSON.stringify(contract.data));
  assert.equal(contract.data.quote.status, 'contract_requested');
  const bb = hookHits.find((h) => h.url === '/boothbook');
  assert.ok(bb, 'BoothBook received the lead');
  const form = new URLSearchParams(bb.body);
  assert.equal(form.get('key'), 'K');
  assert.equal(form.get('secret'), 'S3CRET');
  assert.equal(form.get('telephone'), '2815550199');
  assert.match(form.get('notes'), /Total: \$3762/);
  const wh = hookHits.find((h) => h.url === '/hook' && h.headers['x-booklane-event'] === 'contract.requested');
  assert.ok(wh, 'webhook fired');
  assert.match(wh.headers['x-booklane-signature'], /^sha256=[a-f0-9]{64}$/);
  assert.equal(db.get('SELECT sync_status FROM quotes WHERE token = ?', qt).sync_status, 'synced');
  assert.ok(db.get("SELECT 1 FROM email_log WHERE subject LIKE 'Contract requested: Jo Park%'"));
  assert.equal(db.get('SELECT status FROM leads WHERE id = ?', lead.id).status, 'contract_requested');

  // Book a call from the quote reuses the same lead
  const day = nextWeekday(12);
  const slots = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day];
  const call = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { lead_token: lead.token, quote_token: qt, start: slots[0], timezone: 'America/Chicago', contact: { first_name: 'Jo', last_name: 'Park', email: 'jo@example.com', phone: '2815550199' }, answers: {} });
  assert.equal(call.status, 200, JSON.stringify(call.data));
  assert.equal(db.get('SELECT lead_id FROM bookings WHERE token = ?', call.data.token).lead_id, lead.id);
});

test('businesses are isolated and admin API rejects cross-site posts', async () => {
  const other = await signup('rival@test.dev', 'Rival Co');
  const lead = db.get("SELECT id FROM leads WHERE email = 'jo@example.com'");
  const peek = await req('GET', `/api/admin/leads/${lead.id}`, null, { cookie: other });
  assert.equal(peek.status, 404);
  const csrf = await req('PATCH', '/api/admin/business', { name: 'pwned' }, { cookie: ownerCookie, headers: { Origin: 'https://evil.example' } });
  assert.equal(csrf.status, 403);
  const form = await fetch(`${base}/api/admin/business`, { method: 'PATCH', headers: { Cookie: ownerCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'name=pwned' });
  assert.equal(form.status, 415);
  const anon = await req('GET', '/api/admin/leads');
  assert.equal(anon.status, 401);
  const csv = await fetch(`${base}/api/admin/leads/export.csv`, { headers: { Cookie: ownerCookie } });
  assert.match(await csv.text(), /pat@example.com/);
});

test('hardening: bad URLs, hostile settings, owner protection, SSRF guard', async () => {
  const bad = await fetch(`${base}/%E0%A4%A`);
  assert.equal(bad.status, 400);
  const hostile = await req('PATCH', '/api/admin/business', { settings: { integrations: { webhook: null, boothbook: 'x' }, quote: { tax_rate: '<img src=x onerror=alert(1)>', deposit_value: 20 } } }, { cookie: ownerCookie });
  assert.equal(hostile.status, 200);
  assert.equal(typeof hostile.data.settings.integrations.webhook, 'object');
  assert.equal(hostile.data.settings.quote.tax_rate, 10, 'non-numeric tax ignored');
  const day = nextWeekday(14);
  const slots = (await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`)).data.days[day];
  const r = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`, { start: slots[0], timezone: 'America/Chicago', contact: { first_name: 'Z', last_name: 'Z', email: 'z@x.dev', phone: '5555550100' }, answers: 'oops' });
  assert.equal(r.status, 200);

  // an admin cannot demote the owner
  const inv = await req('POST', '/api/admin/team', { name: 'Ad Min', email: 'admin2@test.dev', role: 'admin' }, { cookie: ownerCookie });
  const acc = await req('POST', '/api/admin/auth/accept', { token: inv.data.invite_url.split('/accept/')[1], password: 'adminpass1' });
  const me = await req('GET', '/api/admin/auth/me', null, { cookie: ownerCookie });
  const demote = await req('PATCH', `/api/admin/team/${me.data.user.id}`, { role: 'host' }, { cookie: acc.cookie });
  assert.equal(demote.status, 403);

  const { assertSafeUrl } = require('../src/services/integrations');
  process.env.ALLOW_PRIVATE_URLS = 'false';
  await assert.rejects(assertSafeUrl('http://example.com/hook'), /https/);
  await assert.rejects(assertSafeUrl('https://127.0.0.1/hook'), /private/);
  await assert.rejects(assertSafeUrl('https://[::1]/hook'), /private/);
  process.env.ALLOW_PRIVATE_URLS = 'true';
});

test('DST: 9am wall time stays 9am across the November change', () => {
  const before = T.zonedToUtc('2026-10-30', 540, 'America/Chicago');
  const afterDst = T.zonedToUtc('2026-11-02', 540, 'America/Chicago');
  assert.equal(new Date(before).toISOString(), '2026-10-30T14:00:00.000Z');
  assert.equal(new Date(afterDst).toISOString(), '2026-11-02T15:00:00.000Z');
});
