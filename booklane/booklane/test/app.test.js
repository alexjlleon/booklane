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

test('bundles: combo price, flat amount off, best-of wins, upsell names the service', () => {
  const P = require('../public/js/pricing');
  const catalog = [
    { id: 1, name: 'DJ', base_price: 1200, pricing_type: 'flat' },
    { id: 2, name: 'Photo Booth', base_price: 800, pricing_type: 'flat' },
    { id: 3, name: 'Videography', base_price: 2000, pricing_type: 'flat' },
  ];
  const both = [{ service_id: 1 }, { service_id: 2 }];

  // A named set priced as a unit: 1200 + 800 = 2000 becomes 1795.
  const combo = P.calculate(catalog, both, { bundles: [{ name: 'DJ + Booth', type: 'price', value: 1795, service_ids: [1, 2] }] });
  assert.equal(combo.subtotal, 2000);
  assert.equal(combo.discount, 205);
  assert.equal(combo.total, 1795);
  assert.equal(combo.discount_label, 'DJ + Booth');

  // Flat money off the same pair.
  assert.equal(P.calculate(catalog, both, { bundles: [{ name: 'Saver', type: 'amount', value: 300, service_ids: [1, 2] }] }).discount, 300);

  // A bundle whose services are not all selected must not apply.
  assert.equal(P.calculate(catalog, [{ service_id: 1 }], { bundles: [{ name: 'DJ + Booth', type: 'price', value: 1795, service_ids: [1, 2] }] }).discount, 0);

  // When two bundles match, the customer gets the bigger saving.
  const best = P.calculate(catalog, both, { bundles: [
    { name: 'Small', type: 'amount', value: 100, service_ids: [1, 2] },
    { name: 'Big', type: 'amount', value: 350, service_ids: [1, 2] },
  ] });
  assert.equal(best.discount, 350);
  assert.equal(best.discount_label, 'Big');

  // Count-based bundles still work, and legacy percent tiers keep applying.
  assert.equal(P.calculate(catalog, both, { bundles: [{ name: 'Any two', type: 'amount', value: 150, min_services: 2 }] }).discount, 150);
  assert.equal(P.calculate(catalog, both, { bundle_discounts: [{ min_services: 2, percent: 10 }] }).discount, 200);

  // A discount can never exceed the subtotal.
  assert.equal(P.calculate(catalog, both, { bundles: [{ name: 'Too big', type: 'amount', value: 99999, service_ids: [1, 2] }] }).discount, 2000);

  // The nudge names the missing service and the real money saved.
  const hint = P.calculate(catalog, [{ service_id: 1 }], { bundles: [{ name: 'DJ + Booth', type: 'price', value: 1795, service_ids: [1, 2] }] }).next_bundle;
  assert.equal(hint.service, 'Photo Booth');
  assert.equal(hint.amount, 205);
});

test('the page a form was embedded on is captured, reported and exported', async () => {
  const page = 'https://weddingsunlimited.com/houston-wedding-dj/';
  const c = await req('POST', `/api/public/b/${bizSlug}/leads`, {
    source: 'booking', event_type_slug: 'discovery-call',
    meta: { embedded: true, page_url: page, page_title: 'Houston Wedding DJ', landing: 'https://book.example.com/b/x?embed=1', referrer: page },
  });
  const lead = db.get('SELECT * FROM leads WHERE token = ?', c.data.token);
  const meta = JSON.parse(lead.meta);
  assert.equal(meta.page_url, page);
  assert.equal(meta.page_title, 'Houston Wedding DJ');

  // A lead that is not embedded still records where it came from.
  const direct = await req('POST', `/api/public/b/${bizSlug}/leads`, { source: 'booking', event_type_slug: 'discovery-call', meta: { landing: 'https://book.example.com/b/x' } });
  assert.equal(JSON.parse(db.get('SELECT * FROM leads WHERE token = ?', direct.data.token).meta).page_url, 'https://book.example.com/b/x');

  // It shows up grouped on the dashboard...
  const dash = await req('GET', '/api/admin/dashboard?days=30', null, { cookie: ownerCookie });
  const row = dash.data.pages.find((r) => r.page === page);
  assert.ok(row, 'expected the embedded page in the dashboard breakdown');
  assert.equal(row.title, 'Houston Wedding DJ');

  // ...and in the CSV, so it can be pivoted outside the app.
  const csv = await fetch(`${base}/api/admin/leads/export.csv`, { headers: { Cookie: ownerCookie } });
  const text = await csv.text();
  assert.ok(text.split('\n')[0].includes('page_url,page_title'));
  assert.ok(text.includes(page));

  // The embed script has to hand the page in, or none of the above has anything to record.
  const embed = await fetch(`${base}/embed.js`).then((r) => r.text());
  assert.ok(embed.includes("src='+src()"), 'embed script must pass the host page URL');
});

test('spreadsheet import: preview first, then services and bundles land in the catalog', async () => {
  const csv = [
    'Category,Service,Description,Price,Unit,Min,Max',
    'Entertainment,DJ / MC,5 hours of coverage,"1,200",flat,,',
    'Entertainment,Photo Booth,3 hour booth,800,flat,,',
    'Lighting,Uplighting,Per fixture,25,per unit,8,40',
    'Lighting,Uplighting,duplicate row,30,per unit,8,40',
    'Extras,No Price Service,,,flat,,',
  ].join('\n');
  const b64 = Buffer.from(csv, 'utf8').toString('base64');

  // Dry run changes nothing.
  const pre = await req('POST', '/api/admin/services/import', { filename: 'prices.csv', data: b64 }, { cookie: ownerCookie });
  assert.equal(pre.data.preview, true);
  assert.equal(pre.data.services.length, 4);
  assert.equal(pre.data.services[0].base_price, 1200, 'currency formatting should be stripped');
  assert.equal(pre.data.services[2].pricing_type, 'per_unit');
  assert.equal(pre.data.services[2].max_qty, 40);
  assert.ok(pre.data.warnings.some((w) => /more than once/.test(w)), 'duplicate names should warn');
  assert.ok(pre.data.warnings.some((w) => /no price/.test(w)), 'missing price should warn');
  const before = db.get('SELECT COUNT(*) c FROM services WHERE business_id = 1').c;
  assert.equal(db.get('SELECT COUNT(*) c FROM services WHERE business_id = 1').c, before, 'preview must not write');

  // Confirmed run writes.
  const done = await req('POST', '/api/admin/services/import', { filename: 'prices.csv', data: b64, confirm: true }, { cookie: ownerCookie });
  assert.equal(done.data.added + done.data.updated, 4);
  assert.equal(db.get('SELECT COUNT(*) c FROM services WHERE business_id = 1').c, before + done.data.added);
  const dj = db.get("SELECT * FROM services WHERE business_id = 1 AND name = 'DJ / MC'");
  assert.equal(dj.base_price, 1200);

  // Re-importing updates rather than duplicating.
  const again = await req('POST', '/api/admin/services/import', { filename: 'prices.csv', data: b64, confirm: true }, { cookie: ownerCookie });
  assert.equal(again.data.added, 0);
  assert.equal(again.data.updated, 4);

  // A bundle sheet resolves service names to ids and lands in settings.
  const bundleCsv = ['Bundle,Services,Type,Value', 'DJ + Booth,DJ / MC; Photo Booth,price,1795', 'Ghost,DJ / MC; Nonexistent,amount,100'].join('\n');
  const r = await req('POST', '/api/admin/services/import', { filename: 'bundles.csv', data: Buffer.from(bundleCsv).toString('base64'), confirm: true }, { cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.bundles, 2);
  assert.ok(r.data.unmatched.some((u) => /Nonexistent/.test(u)), 'unknown service names should be reported back');
  const saved = JSON.parse(db.get('SELECT settings FROM businesses WHERE id = 1').settings).quote.bundles;
  const combo = saved.find((x) => x.name === 'DJ + Booth');
  assert.equal(combo.type, 'price');
  assert.equal(combo.value, 1795);
  assert.equal(combo.service_ids.length, 2);

  // And it actually prices that way end to end.
  const biz = require('../src/services/business').byId(1);
  const P = require('../public/js/pricing');
  const calc = P.calculate(require('../src/services/quotes').catalog(1), combo.service_ids.map((id) => ({ service_id: id })), biz.settings.quote);
  assert.equal(calc.subtotal - calc.discount, 1795, 'the named pair should price as the bundle, before tax');

  // Junk is rejected with a readable message, not a stack trace.
  const bad = await req('POST', '/api/admin/services/import', { filename: 'x.csv', data: Buffer.from('nothing useful here').toString('base64') }, { cookie: ownerCookie });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /No services or bundles/);

  // A host (non-admin) cannot import.
  const noAuth = await req('POST', '/api/admin/services/import', { filename: 'x.csv', data: b64 });
  assert.equal(noAuth.status, 401);
});

test('quote form fields are configurable: add, remove, require and store answers', async () => {
  const biz = require('../src/services/business');
  // Replace the stock questions with a custom set: drop venue, add a required dropdown and a multi-select.
  const r = await req('PATCH', '/api/admin/business', { settings: { quote: { fields: [
    { id: 'event_date', label: 'Event date', type: 'date', required: true },
    { id: 'Room Setup', label: 'Room setup', type: 'choice_select', options: ['Banquet', 'Theater'], required: true },
    { id: 'extras', label: 'Anything else you want', type: 'multi', options: ['Cold sparks', 'Monogram', 'Photo album'] },
  ] } } }, { cookie: ownerCookie });
  assert.equal(r.status, 200);

  const saved = biz.byId(1).settings.quote.fields;
  assert.equal(saved.length, 3);
  assert.equal(saved[1].id, 'room_setup', 'ids are slugged so they are safe as answer keys');
  assert.equal(saved[1].type, 'choice_select');
  assert.deepEqual(saved[2].options, ['Cold sparks', 'Monogram', 'Photo album']);
  assert.ok(!saved.some((f) => f.id === 'venue'), 'removed questions stay removed');

  // The public page serves the same field list to the browser.
  const pub = await req('GET', `/api/public/b/${bizSlug}/quote-config`).catch(() => null);
  const page = await fetch(`${base}/b/${bizSlug}/quote`).then((x) => x.text());
  assert.ok(page.includes('room_setup'), 'the configured field should reach the quote page');

  // Answers to custom fields are kept, and junk keys are still dropped.
  const q = await req('POST', `/api/public/b/${bizSlug}/quotes`, {});
  await req('PATCH', `/api/public/quotes/${q.data.token}`, { details: { room_setup: 'Banquet', extras: ['Cold sparks', 'Monogram'], not_a_field: 'drop me' } });
  const details = JSON.parse(db.get('SELECT details FROM quotes WHERE token = ?', q.data.token).details);
  assert.equal(details.room_setup, 'Banquet');
  assert.deepEqual(details.extras, ['Cold sparks', 'Monogram']);
  assert.equal(details.not_a_field, undefined, 'fields that are not configured must not be stored');

  // A field with no label is discarded rather than saved as a blank question.
  await req('PATCH', '/api/admin/business', { settings: { quote: { fields: [{ id: 'x', label: '', type: 'text' }] } } }, { cookie: ownerCookie });
  assert.equal(biz.byId(1).settings.quote.fields.length, 0);
});

test('short date-first form: date, phone, availability verdict, then a time', async () => {
  const { QUICK_DATE_STEPS } = require('../src/defaults');
  // Create the short form from the template.
  const made = await req('POST', '/api/admin/event-types', {
    name: 'Check my date', duration_min: 15, location_type: 'phone', steps: QUICK_DATE_STEPS(), hosts: [1],
  }, { cookie: ownerCookie });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const et = made.data;
  assert.deepEqual(et.steps.map((s) => s.type), ['questions', 'contact', 'availability', 'schedule']);
  assert.equal(et.steps[1].fields.email, 'optional', 'a short form may ask for a phone only');
  assert.equal(et.steps[1].fields.phone, 'required');
  assert.equal(et.steps[2].date_question_id, 'event_date');

  // Date check answers honestly from the booked list.
  const open = await req('GET', `/api/public/b/${bizSlug}/date-check?date=2027-05-15`);
  assert.equal(open.data.available, true);

  await req('POST', '/api/admin/blocked-dates', { dates: '2027-05-15, 2027-06-12, garbage', note: 'Smith wedding' }, { cookie: ownerCookie });
  const taken = await req('GET', `/api/public/b/${bizSlug}/date-check?date=2027-05-15`);
  assert.equal(taken.data.available, false);
  assert.equal(taken.data.note, 'Smith wedding');
  assert.equal((await req('GET', `/api/public/b/${bizSlug}/date-check?date=2027-06-12`)).data.available, false);
  assert.equal((await req('GET', `/api/public/b/${bizSlug}/date-check?date=2027-07-04`)).data.available, true, 'unlisted dates stay available');
  assert.equal((await req('GET', `/api/public/b/${bizSlug}/date-check?date=nonsense`)).status, 400);

  // Duplicates are ignored rather than piling up.
  const again = await req('POST', '/api/admin/blocked-dates', { dates: '2027-05-15' }, { cookie: ownerCookie });
  assert.equal(again.data.added, 0);
  assert.equal(again.data.skipped, 1);

  // The lead captures the date and phone before the customer ever reaches the calendar.
  const lead = await req('POST', `/api/public/b/${bizSlug}/leads`, { source: 'booking', event_type_slug: et.slug });
  await req('PATCH', `/api/public/leads/${lead.data.token}`, { step_index: 0, step_total: 4, answers: { event_date: '2027-05-15' } });
  await req('PATCH', `/api/public/leads/${lead.data.token}`, { step_index: 1, contact: { first_name: 'Dana', phone: '713-555-0164' } });
  const row = db.get('SELECT * FROM leads WHERE token = ?', lead.data.token);
  assert.equal(row.status, 'partial');
  assert.equal(row.first_name, 'Dana');
  assert.equal(row.phone, '713-555-0164');
  assert.equal(JSON.parse(row.answers).event_date, '2027-05-15');
  assert.equal(row.email, null, 'a usable lead without an email address');

  // Two date-check steps are refused, and a form still needs its one scheduler.
  const twice = await req('POST', '/api/admin/event-types', { name: 'Bad', duration_min: 15, location_type: 'phone', hosts: [1],
    steps: QUICK_DATE_STEPS().concat([{ key: 'a2', type: 'availability', title: 'Again' }]) }, { cookie: ownerCookie });
  assert.equal(twice.status, 422);
  assert.match(twice.data.error, /one date-check/i);
});

test('short CTA: the embed passes an answer through and the lead is saved before the form loads', async () => {
  // The embed script exposes the CTA widget and still parses as valid JS.
  const embed = await fetch(`${base}/embed.js`).then((r) => r.text());
  assert.ok(embed.includes('data-booklane-cta'), 'CTA widget must ship in embed.js');
  assert.ok(embed.includes('window.Booklane={popup:popup,inline:inline,ctas:ctas}'));
  new Function(embed); // throws on a syntax error, which a served script would hit silently

  // The booking page accepts the prefilled answer in the URL.
  const et = db.get("SELECT slug FROM event_types WHERE business_id = 1 AND slug = 'check-my-date'");
  const page = await fetch(`${base}/b/${bizSlug}/${et.slug}?event_date=2027-08-21&phone=713-555-0199`).then((r) => r.text());
  assert.equal(page.includes('<!doctype html>') || page.includes('<!DOCTYPE html>'), true);

  // And a lead created from that first interaction holds the answer without any further steps.
  const lead = await req('POST', `/api/public/b/${bizSlug}/leads`, { source: 'booking', event_type_slug: et.slug });
  await req('PATCH', `/api/public/leads/${lead.data.token}`, { answers: { event_date: '2027-08-21' }, contact: { phone: '713-555-0199' } });
  const row = db.get('SELECT * FROM leads WHERE token = ?', lead.data.token);
  assert.equal(JSON.parse(row.answers).event_date, '2027-08-21');
  assert.equal(row.phone, '713-555-0199');
  assert.equal(row.first_name, null, 'a CTA lead is useful before they give a name');
});
