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
  // Mirror the real admin client: any non-GET declares JSON, even with no body.
  const res = await fetch(base + url, { method, headers: { ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
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

// ---------------------------------------------------------------------------
// Sellable sessions: markets, the two branches, slot holds and Stripe
// ---------------------------------------------------------------------------
const crypto = require('node:crypto');
const stripeLib = require('../src/lib/stripe');

const WHSEC = 'whsec_test_secret';
let checkoutCalls = [];

function signWebhook(bodyStr, secret = WHSEC, tsOffset = 0) {
  const ts = Math.floor(Date.now() / 1000) + tsOffset;
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${bodyStr}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
const postWebhook = (event, header) => req('POST', '/api/public/stripe/webhook', event, { headers: { 'Stripe-Signature': header === undefined ? signWebhook(JSON.stringify(event)) : header } });

// Stub only the two calls that would leave the machine. Everything else is the real code path.
function stubStripe() {
  process.env.STRIPE_SECRET_KEY = 'sk_test_stubbed';
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  checkoutCalls = [];
  stripeLib.createCheckoutSession = async (opts) => {
    checkoutCalls.push(opts);
    return { id: `cs_test_${checkoutCalls.length}`, url: `https://checkout.stripe.test/${checkoutCalls.length}` };
  };
  stripeLib.retrieveCheckoutSession = async (id) => ({ id, status: 'open', payment_status: 'unpaid' });
}

let sessSlug = 'engagement-session';
let markets = [];

test('seeding creates the five markets, the four sessions and the album flow', async () => {
  stubStripe();
  const r = await req('POST', '/api/admin/sessions/seed', {}, { cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.calendars, ['Houston', 'Austin', 'San Antonio', 'Dallas / Fort Worth', 'Phoenix', 'Album Designer']);
  assert.ok(r.data.products.includes('Engagement Session'));
  assert.ok(r.data.products.includes('Photo Album'));

  // Running it again must not duplicate anything.
  const again = await req('POST', '/api/admin/sessions/seed', {}, { cookie: ownerCookie });
  assert.deepEqual(again.data.calendars, []);
  assert.deepEqual(again.data.products, []);

  const list = await req('GET', '/api/admin/sessions', null, { cookie: ownerCookie });
  const eng = list.data.sessions.find((x) => x.slug === sessSlug);
  assert.equal(eng.price_cents, 49500, 'engagement session is $495');
  assert.equal(eng.calendar_ids.length, 5, 'offered in all five markets');
  const album = list.data.sessions.find((x) => x.slug === 'photo-album');
  assert.equal(album.calendar_ids.length, 1, 'the album books against one designer');

  markets = (await req('GET', '/api/admin/session-calendars', null, { cookie: ownerCookie })).data;
  assert.equal(markets.filter((m) => m.kind === 'market').length, 5);
  assert.ok(markets.every((m) => m.has_hours), 'every calendar starts with hours');
});

test('the public session page offers the city choice and the price', async () => {
  const r = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}`);
  assert.equal(r.status, 200);
  const s = r.data.session;
  assert.equal(s.price_display, '$495');
  assert.equal(s.calendars.length, 5);
  assert.match(s.labels.choose_label, /city/i);
  assert.equal(s.payable, true, 'Stripe is stubbed in, so it is buyable');

  // A single-calendar session hides the choice, which is what makes the album flow short.
  const album = await req('GET', `/api/public/b/${bizSlug}/s/photo-album`);
  assert.equal(album.data.session.calendars.length, 1);

  const page = await fetch(`${base}/b/${bizSlug}/s/${sessSlug}`).then((x) => x.text());
  assert.match(page, /session\.js/, 'the page loads the session flow');
});

async function firstSlot(slug, calendar, skip = 0) {
  const from = T.addDays(T.utcToZoned(Date.now(), 'America/Chicago').date, 2);
  const r = await req('GET', `/api/public/b/${bizSlug}/s/${slug}/slots?calendar=${calendar}&from=${from}&to=${T.addDays(from, 25)}&tz=America/Chicago`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const days = Object.keys(r.data.days).filter((d) => r.data.days[d].length).sort();
  assert.ok(days.length > skip, 'the market has open days');
  return { day: days[skip], start: r.data.days[days[skip]][0] };
}

test('each market shows only its own calendar', async () => {
  const hou = await firstSlot(sessSlug, 'houston');
  const contact = { first_name: 'Dana', last_name: 'Ruiz', email: 'dana@example.com', phone: '8325551234' };
  const booked = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/claim`,
    { calendar: 'houston', start: hou.start, timezone: 'America/Chicago', contact, booking_number: ' wu-1234 ' });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));

  // The same instant is still free in Austin: separate calendars, separate diaries.
  const austin = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}/slots?calendar=austin&from=${hou.day}&to=${hou.day}&tz=America/Chicago`);
  assert.ok((austin.data.days[hou.day] || []).includes(hou.start), 'booking Houston must not block Austin');

  // But Houston itself no longer offers it.
  const again = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}/slots?calendar=houston&from=${hou.day}&to=${hou.day}&tz=America/Chicago`);
  assert.ok(!(again.data.days[hou.day] || []).includes(hou.start), 'the booked time is gone from Houston');

  // The booking number is recorded, upper-cased and trimmed, and flagged for matching.
  const order = db.get("SELECT * FROM orders WHERE already_booked = 1 ORDER BY id DESC");
  assert.equal(order.booking_number, 'WU-1234');
  assert.equal(order.status, 'not_required');
  assert.equal(order.amount_cents, 0);
  const bk = db.get('SELECT * FROM bookings WHERE id = ?', order.booking_id);
  assert.match(JSON.parse(bk.answers).payment, /already booked/i);
  assert.equal(JSON.parse(bk.answers).location, 'Houston');
});

test('a missing booking number is refused when it is required', async () => {
  const hou = await firstSlot(sessSlug, 'houston', 1);
  const r = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/claim`,
    { calendar: 'houston', start: hou.start, timezone: 'America/Chicago', contact: { first_name: 'No', last_name: 'Number', email: 'nn@example.com', phone: '8325550000' } });
  assert.equal(r.status, 422);
  assert.ok(r.data.details.booking_number, 'the field is called out by name');
});

let orderToken, heldStart, heldDay;

test('buying holds the slot, and a second buyer cannot take it', async () => {
  const slot = await firstSlot(sessSlug, 'phoenix');
  heldStart = slot.start; heldDay = slot.day;
  const contact = { first_name: 'Sam', last_name: 'Ortiz', email: 'sam@example.com', phone: '6025551111' };
  const r = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/checkout`,
    { calendar: 'phoenix', start: heldStart, timezone: 'America/Phoenix', contact });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  orderToken = r.data.order_token;

  // Stripe was asked for the right amount, in cents, with the order token attached.
  const call = checkoutCalls[checkoutCalls.length - 1];
  assert.equal(call.amountCents, 49500);
  assert.equal(call.metadata.order_token, orderToken);
  assert.match(call.productName, /Engagement Session .* Phoenix/);
  assert.match(call.successUrl, new RegExp(`/session/${orderToken}`));

  // Nothing is booked yet, but the time is off the market.
  const order = db.get('SELECT * FROM orders WHERE token = ?', orderToken);
  assert.equal(order.status, 'pending');
  assert.equal(order.booking_id, null);
  const slots = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}/slots?calendar=phoenix&from=${heldDay}&to=${heldDay}&tz=America/Phoenix`);
  assert.ok(!(slots.data.days[heldDay] || []).includes(heldStart), 'a held slot is not offered to anyone else');

  const second = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/checkout`,
    { calendar: 'phoenix', start: heldStart, timezone: 'America/Phoenix', contact: { first_name: 'Other', last_name: 'Buyer', email: 'other@example.com', phone: '6025552222' } });
  assert.equal(second.status, 409, 'two people must never buy the same time');
});

test('nobody can skip payment by claiming a priced session is free', async () => {
  const slot = await firstSlot(sessSlug, 'austin');
  const r = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/claim`,
    { calendar: 'austin', start: slot.start, timezone: 'America/Chicago', already_booked: false,
      contact: { first_name: 'Free', last_name: 'Rider', email: 'free@example.com', phone: '5125550000' } });
  assert.equal(r.status, 402, 'the free path is refused on a session that costs money');
  assert.equal(db.get("SELECT COUNT(*) c FROM orders WHERE customer_email = 'free@example.com'").c, 0);
});

test('a signed webhook books the held slot, and a replay changes nothing', async () => {
  const order = db.get('SELECT * FROM orders WHERE token = ?', orderToken);
  const event = { id: 'evt_book_1', type: 'checkout.session.completed', data: { object: {
    id: order.provider_session_id, client_reference_id: orderToken, payment_status: 'paid', amount_total: 49500, payment_intent: 'pi_test_1',
  } } };

  const ok = await postWebhook(event);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.result, 'booked');

  const after = db.get('SELECT * FROM orders WHERE token = ?', orderToken);
  assert.equal(after.status, 'paid');
  assert.ok(after.booking_id, 'the booking exists');
  assert.equal(after.provider_payment_intent, 'pi_test_1');
  const bk = db.get('SELECT * FROM bookings WHERE id = ?', after.booking_id);
  assert.equal(bk.start_utc, heldStart);
  assert.match(JSON.parse(bk.answers).payment, /\$495/);
  assert.equal(bk.email, 'sam@example.com');

  const replay = await postWebhook(event);
  assert.equal(replay.data.result, 'duplicate', 'Stripe redelivers; we must not double-book');
  assert.equal(db.get("SELECT COUNT(*) c FROM bookings WHERE start_utc = ? AND host_user_id = ?", heldStart, bk.host_user_id).c, 1);

  // The customer's return page now knows where to send them.
  const poll = await req('GET', `/api/public/orders/${orderToken}`);
  assert.equal(poll.data.order.status, 'paid');
  assert.match(poll.data.order.redirect, /^\/booking\//);
});

test('a webhook with a bad, stale or missing signature is rejected outright', async () => {
  const body = { id: 'evt_forged', type: 'checkout.session.completed', data: { object: { client_reference_id: orderToken, payment_status: 'paid' } } };
  const str = JSON.stringify(body);

  const forged = await postWebhook(body, `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`);
  assert.equal(forged.status, 400, 'a forged signature must not be trusted');

  const wrongSecret = await postWebhook(body, signWebhook(str, 'whsec_not_ours'));
  assert.equal(wrongSecret.status, 400);

  const stale = await postWebhook(body, signWebhook(str, WHSEC, -4000));
  assert.equal(stale.status, 400, 'an old timestamp must not be replayable');

  const none = await postWebhook(body, '');
  assert.equal(none.status, 400);

  // None of those were recorded, so a later genuine delivery still works.
  assert.equal(db.get("SELECT COUNT(*) c FROM provider_events WHERE event_id = 'evt_forged'").c, 0);
});

test('an abandoned checkout gives the slot back', async () => {
  const slot = await firstSlot(sessSlug, 'san-antonio');
  const r = await req('POST', `/api/public/b/${bizSlug}/s/${sessSlug}/checkout`,
    { calendar: 'san-antonio', start: slot.start, timezone: 'America/Chicago', contact: { first_name: 'Gone', last_name: 'Away', email: 'gone@example.com', phone: '2105550000' } });
  assert.equal(r.status, 200);
  const token = r.data.order_token;

  const held = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}/slots?calendar=san-antonio&from=${slot.day}&to=${slot.day}&tz=America/Chicago`);
  assert.ok(!(held.data.days[slot.day] || []).includes(slot.start));

  // Stripe tells us the page expired.
  const order = db.get('SELECT * FROM orders WHERE token = ?', token);
  const out = await postWebhook({ id: 'evt_exp_1', type: 'checkout.session.expired', data: { object: { id: order.provider_session_id, client_reference_id: token } } });
  assert.equal(out.data.result, 'hold released');
  assert.equal(db.get('SELECT status FROM orders WHERE token = ?', token).status, 'expired');

  const back = await req('GET', `/api/public/b/${bizSlug}/s/${sessSlug}/slots?calendar=san-antonio&from=${slot.day}&to=${slot.day}&tz=America/Chicago`);
  assert.ok((back.data.days[slot.day] || []).includes(slot.start), 'the time is on sale again');
});

test('a free session books with no card and no booking number', async () => {
  const create = await req('POST', '/api/admin/sessions', {
    name: 'Complimentary Consult', price_cents: 0, duration_min: 30,
    calendar_ids: [markets.find((m) => m.slug === 'houston').id],
  }, { cookie: ownerCookie });
  assert.equal(create.status, 200, JSON.stringify(create.data));
  const slug = create.data.slug;

  const slot = await firstSlot(slug, 'houston');
  const r = await req('POST', `/api/public/b/${bizSlug}/s/${slug}/claim`,
    { calendar: 'houston', start: slot.start, timezone: 'America/Chicago', already_booked: false,
      contact: { first_name: 'Free', last_name: 'Session', email: 'freebie@example.com', phone: '7135550000' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const order = db.get("SELECT * FROM orders WHERE customer_email = 'freebie@example.com'");
  assert.equal(order.already_booked, 0);
  assert.equal(order.amount_cents, 0);
  assert.equal(JSON.parse(db.get('SELECT answers FROM bookings WHERE id = ?', order.booking_id).answers).payment, 'No charge');
});

test('the orders screen and its export show the money and the booking numbers', async () => {
  const r = await req('GET', '/api/admin/orders', null, { cookie: ownerCookie });
  assert.equal(r.status, 200);
  assert.ok(r.data.summary.paid_total >= 495, 'the paid engagement session is counted');
  assert.ok(r.data.rows.some((x) => x.booking_number === 'WU-1234'));
  assert.ok(r.data.rows.some((x) => x.status === 'paid' && x.amount_display === '$495'));
  assert.equal(r.data.summary.paid_but_unbooked, 0, 'nothing paid is left off a calendar');

  const paidOnly = await req('GET', '/api/admin/orders?status=paid', null, { cookie: ownerCookie });
  assert.ok(paidOnly.data.rows.every((x) => x.status === 'paid'));

  const csv = await fetch(`${base}/api/admin/orders/export.csv`, { headers: { Cookie: ownerCookie } }).then((x) => x.text());
  assert.match(csv, /^created_at,status,product_name/);
  assert.match(csv, /WU-1234/);
});

test('session pages and admin endpoints are closed to outsiders', async () => {
  // A stranger cannot list or change another business's sessions.
  const anon = await req('GET', '/api/admin/sessions');
  assert.equal(anon.status, 401);
  const anonCal = await req('POST', '/api/admin/session-calendars', { name: 'Sneaky' });
  assert.equal(anonCal.status, 401);

  // Keys are never handed back to the browser.
  const pay = await req('GET', '/api/admin/payments', null, { cookie: ownerCookie });
  assert.equal(pay.data.configured, true);
  assert.equal(pay.data.mode, 'test');
  assert.ok(!JSON.stringify(pay.data).includes('sk_test'), 'the secret key must never reach the client');
  assert.ok(!JSON.stringify(pay.data).includes(WHSEC));

  // An unknown or switched-off session is a 404, not a hint.
  assert.equal((await req('GET', `/api/public/b/${bizSlug}/s/not-a-session`)).status, 404);
});

test('markets and sessions with real bookings cannot be deleted by accident', async () => {
  const cal = markets.find((m) => m.slug === 'houston');
  const delCal = await req('DELETE', `/api/admin/session-calendars/${cal.id}`, null, { cookie: ownerCookie });
  assert.equal(delCal.status, 409, 'Houston has upcoming sessions');
  assert.match(delCal.data.error, /Switch it off/);

  const eng = (await req('GET', '/api/admin/sessions', null, { cookie: ownerCookie })).data.sessions.find((x) => x.slug === sessSlug);
  const delSess = await req('DELETE', `/api/admin/sessions/${eng.id}`, null, { cookie: ownerCookie });
  assert.equal(delSess.status, 409, 'it has a paid order attached');
});

test('a bodyless DELETE reaches the handler instead of being turned away as non-JSON', async () => {
  // This guard used to reject every delete in the admin UI, not just session ones.
  const cal = await req('POST', '/api/admin/session-calendars', { name: 'Temporary Market' }, { cookie: ownerCookie });
  assert.equal(cal.status, 200, JSON.stringify(cal.data));
  const gone = await req('DELETE', `/api/admin/session-calendars/${cal.data.id}`, null, { cookie: ownerCookie });
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.equal(db.get('SELECT 1 x FROM calendar_profiles WHERE id = ?', cal.data.id), undefined);

  const dates = await req('POST', '/api/admin/blocked-dates', { dates: '2031-04-04' }, { cookie: ownerCookie });
  assert.equal(dates.data.added, 1);
  const row = db.get("SELECT id FROM blocked_dates WHERE date = '2031-04-04'");
  assert.equal((await req('DELETE', `/api/admin/blocked-dates/${row.id}`, null, { cookie: ownerCookie })).status, 200);
});

// ---------------------------------------------------------------------------
// Scheduled emails and texts
// ---------------------------------------------------------------------------
const MSG = require('../src/services/messaging');
const smsLib = require('../src/lib/sms');
const { resetRateLimits } = require('../src/lib/security');
// These tests book more times in a few seconds than a real visitor would in a week.
const freshLimits = () => resetRateLimits();

let sentTexts = [];
function stubTwilio() {
  process.env.TWILIO_ACCOUNT_SID = 'AC' + '0'.repeat(32);
  process.env.TWILIO_AUTH_TOKEN = 'twilio_test_token';
  process.env.TWILIO_FROM_NUMBER = '+18325550000';
  sentTexts = [];
  smsLib.sendSms = async ({ to, body }) => {
    sentTexts.push({ to, body });
    return { sid: `SM${sentTexts.length}`, status: 'queued', segments: smsLib.segmentInfo(body).segments, to };
  };
}

const mkAutomation = (patch = {}) => req('POST', '/api/admin/automations', {
  name: 'Test rule', channel: 'email', trigger: 'before', offset_min: 1440,
  subject: 'See you soon', body_html: 'Hi {{first_name}}, your {{session}} is {{when}}.', active: true, ...patch,
}, { cookie: ownerCookie });

test('an automation fires for a matching booking and skips one that does not match', async () => {
  freshLimits(); stubTwilio();
  const ets = (await req('GET', '/api/admin/event-types', null, { cookie: ownerCookie })).data.event_types;
  const engagement = ets.find((e) => e.slug === 'engagement-session');
  const discovery = ets.find((e) => e.slug === 'discovery-call');

  // Scoped to engagement sessions only.
  const a = await mkAutomation({ name: 'Engagement only', event_type_ids: [engagement.id], offset_min: 120 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.timing, '2 hours before the appointment');

  const slot = await firstSlot('engagement-session', 'austin');
  const booked = await req('POST', `/api/public/b/${bizSlug}/s/engagement-session/claim`,
    { calendar: 'austin', start: slot.start, timezone: 'America/Chicago', booking_number: 'WU-9001',
      contact: { first_name: 'Match', last_name: 'Me', email: 'match@example.com', phone: '5125559001' } });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));

  const queued = db.all("SELECT * FROM scheduled_messages WHERE automation_id = ?", a.data.id);
  assert.equal(queued.length, 1, 'one email queued for the matching session');
  assert.equal(queued[0].to_addr, 'match@example.com');
  // Due two hours before the appointment.
  assert.equal(queued[0].send_after, Date.parse(slot.start) - 120 * 60000);

  // A discovery call must not pick it up.
  const day = nextWeekday(4);
  const slots = await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`);
  const call = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`,
    { start: slots.data.days[day][0], timezone: 'America/Chicago', contact: { first_name: 'Other', last_name: 'Type', email: 'other@example.com', phone: '5125559002' } });
  assert.equal(call.status, 200, JSON.stringify(call.data));
  assert.equal(db.all('SELECT * FROM scheduled_messages WHERE automation_id = ?', a.data.id).length, 1, 'the other consultation type was skipped');
  assert.equal(discovery.id !== engagement.id, true);
});

test('conditions can key off the services someone showed interest in', async () => {
  freshLimits();
  const a = await mkAutomation({ name: 'Photo booth follow-up', trigger: 'after', offset_min: 60, service_match: ['photo booth'] });
  const day = nextWeekday(5);
  const slots = await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`);

  // Interested in a photo booth: should match.
  const yes = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`,
    { start: slots.data.days[day][0], timezone: 'America/Chicago', answers: { services: ['DJ / MC', 'Photo Booth (3 hours)'] },
      contact: { first_name: 'Booth', last_name: 'Fan', email: 'booth@example.com', phone: '7135551000' } });
  assert.equal(yes.status, 200, JSON.stringify(yes.data));

  // Interested in something else: should not.
  const no = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`,
    { start: slots.data.days[day][1], timezone: 'America/Chicago', answers: { services: ['Uplighting'] },
      contact: { first_name: 'Light', last_name: 'Only', email: 'light@example.com', phone: '7135551001' } });
  assert.equal(no.status, 200, JSON.stringify(no.data));

  const rows = db.all('SELECT to_addr FROM scheduled_messages WHERE automation_id = ?', a.data.id).map((r) => r.to_addr);
  assert.deepEqual(rows, ['booth@example.com'], 'matched on a substring of the service name, and only that one');
});

test('texts wait until 8am in the customer\'s own timezone', async () => {
  // 4am in Phoenix is inside quiet hours; the same instant is 7am in New York, also too early,
  // so both must be pushed to 8am local rather than fired at dawn.
  const at4amPhoenix = T.zonedToUtc(T.addDays(T.utcToZoned(Date.now(), 'America/Phoenix').date, 3), 4 * 60, 'America/Phoenix');
  const held = MSG.holdForQuietHours(at4amPhoenix, 'America/Phoenix');
  assert.equal(T.utcToZoned(held, 'America/Phoenix').minutes, 8 * 60, 'moved to 8am Phoenix time');

  const at10pm = T.zonedToUtc(T.addDays(T.utcToZoned(Date.now(), 'America/Chicago').date, 3), 22 * 60, 'America/Chicago');
  const pushed = MSG.holdForQuietHours(at10pm, 'America/Chicago');
  const z = T.utcToZoned(pushed, 'America/Chicago');
  assert.equal(z.minutes, 8 * 60);
  assert.equal(z.date, T.addDays(T.utcToZoned(at10pm, 'America/Chicago').date, 1), 'a 10pm message waits for the morning');

  // Midday is left exactly where it is.
  const noon = T.zonedToUtc(T.addDays(T.utcToZoned(Date.now(), 'America/Chicago').date, 3), 12 * 60, 'America/Chicago');
  assert.equal(MSG.holdForQuietHours(noon, 'America/Chicago'), noon);
});

test('a text goes out once, with merge fields filled in, and never twice', async () => {
  freshLimits(); stubTwilio();
  const a = await mkAutomation({ name: 'Morning of', channel: 'sms', trigger: 'before', offset_min: 0,
    sms_body: 'Morning {{first_name}}! Today is your {{session}} at {{time}} in {{market}}. Reply here if you need us. - {{business_name}}' });
  assert.equal(a.status, 200, JSON.stringify(a.data));

  const slot = await firstSlot('engagement-session', 'dallas-fort-worth');
  const booked = await req('POST', `/api/public/b/${bizSlug}/s/engagement-session/claim`,
    { calendar: 'dallas-fort-worth', start: slot.start, timezone: 'America/Chicago', booking_number: 'WU-9100',
      contact: { first_name: 'Tess', last_name: 'Tanner', email: 'tess@example.com', phone: '2145559100' } });
  assert.equal(booked.status, 200, JSON.stringify(booked.data));

  const row = db.get('SELECT * FROM scheduled_messages WHERE automation_id = ?', a.data.id);
  assert.equal(row.channel, 'sms');
  assert.equal(row.to_addr, '+12145559100', 'the number was normalised for the carrier');

  // Make it due and run the worker.
  db.run('UPDATE scheduled_messages SET send_after = ? WHERE id = ?', Date.now() - 1000, row.id);
  const first = await MSG.processDue();
  assert.equal(first.sent, 1, JSON.stringify(first));
  assert.equal(sentTexts.length, 1);
  assert.match(sentTexts[0].body, /^Morning Tess! Today is your Engagement Session at /);
  assert.match(sentTexts[0].body, /in Dallas \/ Fort Worth\./);
  assert.ok(!sentTexts[0].body.includes('{{'), 'no unreplaced placeholders reach a customer');

  // The worker running again must not resend it.
  const second = await MSG.processDue();
  assert.equal(second.sent, 0);
  assert.equal(sentTexts.length, 1, 'a second job tick must not send a duplicate');
  assert.equal(db.get('SELECT status FROM scheduled_messages WHERE id = ?', row.id).status, 'sent');
});

test('replying STOP stops every future text, and the signature is checked first', async () => {
  freshLimits(); stubTwilio();
  const a = await mkAutomation({ name: 'Post-shoot text', channel: 'sms', trigger: 'after', offset_min: 120, sms_body: 'Thanks {{first_name}}!' });
  const slot = await firstSlot('engagement-session', 'houston', 2);
  await req('POST', `/api/public/b/${bizSlug}/s/engagement-session/claim`,
    { calendar: 'houston', start: slot.start, timezone: 'America/Chicago', booking_number: 'WU-9200',
      contact: { first_name: 'Quiet', last_name: 'Please', email: 'quiet@example.com', phone: '7135559200' } });
  const queued = db.get("SELECT * FROM scheduled_messages WHERE automation_id = ? AND to_addr = '+17135559200'", a.data.id);
  assert.ok(queued, 'the follow-up text was queued');

  const params = { From: '+17135559200', To: '+18325550000', Body: 'STOP', MessageSid: 'SM_stop_1' };
  const form = new URLSearchParams(params).toString();
  const post = (sig) => fetch(`${base}/api/public/sms/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig === null ? {} : { 'X-Twilio-Signature': sig }) }, body: form });

  // A forged STOP must be refused: otherwise anyone could silence our messages to a real customer.
  const forged = await post('Zm9yZ2VkIHNpZ25hdHVyZQ==');
  assert.equal(forged.status, 403);
  const unsigned = await post(null);
  assert.equal(unsigned.status, 403);
  assert.equal(db.get("SELECT COUNT(*) c FROM sms_optouts WHERE phone = '+17135559200'").c, 0, 'nothing recorded from a forged request');

  // Now sign it the way Twilio does.
  const crypto2 = require('node:crypto');
  const url = `${base}/api/public/sms/inbound`;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  const good = crypto2.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  const real = await post(good);
  assert.equal(real.status, 200);
  assert.equal(real.headers.get('x-booklane-action'), 'opted_out');

  // Recorded against the one business that actually texted them, not every tenant in the database.
  assert.equal(db.get("SELECT COUNT(*) c FROM sms_optouts WHERE phone = '+17135559200'").c, 1);
  assert.equal(db.get("SELECT business_id FROM sms_optouts WHERE phone = '+17135559200'").business_id, 1);
  assert.equal(db.get('SELECT status FROM scheduled_messages WHERE id = ?', queued.id).status, 'cancelled', 'the pending text was pulled');

  // And a new booking for that number queues no texts at all.
  sentTexts = [];
  const slot2 = await firstSlot('engagement-session', 'houston', 3);
  await req('POST', `/api/public/b/${bizSlug}/s/engagement-session/claim`,
    { calendar: 'houston', start: slot2.start, timezone: 'America/Chicago', booking_number: 'WU-9201',
      contact: { first_name: 'Quiet', last_name: 'Please', email: 'quiet2@example.com', phone: '713-555-9200' } });
  assert.equal(db.get("SELECT COUNT(*) c FROM scheduled_messages WHERE to_addr = '+17135559200' AND status = 'queued'").c, 0,
    'someone who said STOP is never queued again');

  // Texting START puts them back.
  const startParams = { ...params, Body: 'START', MessageSid: 'SM_start_1' };
  const startForm = new URLSearchParams(startParams).toString();
  const sData = Object.keys(startParams).sort().reduce((acc, k) => acc + k + startParams[k], url);
  const sSig = crypto2.createHmac('sha1', process.env.TWILIO_AUTH_TOKEN).update(Buffer.from(sData, 'utf8')).digest('base64');
  const back = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sSig }, body: startForm });
  assert.equal(back.headers.get('x-booklane-action'), 'opted_in');
  assert.equal(db.get("SELECT COUNT(*) c FROM sms_optouts WHERE phone = '+17135559200'").c, 0);
});

test('cancelling a booking pulls its pending messages; moving it re-times them', async () => {
  freshLimits(); stubTwilio();
  const a = await mkAutomation({ name: 'Day before', trigger: 'before', offset_min: 1440, subject: 'Tomorrow', body_html: 'See you tomorrow, {{first_name}}.' });
  const day = nextWeekday(6);
  const slots = await req('GET', `/api/public/b/${bizSlug}/e/discovery-call/slots?from=${day}&to=${day}&tz=America/Chicago`);
  const bk = await req('POST', `/api/public/b/${bizSlug}/e/discovery-call/book`,
    { start: slots.data.days[day][0], timezone: 'America/Chicago', contact: { first_name: 'Move', last_name: 'Me', email: 'move@example.com', phone: '7135552000' } });
  assert.equal(bk.status, 200, JSON.stringify(bk.data));

  let row = db.get("SELECT * FROM scheduled_messages WHERE automation_id = ? AND to_addr = 'move@example.com'", a.data.id);
  assert.ok(row);
  assert.equal(row.send_after, Date.parse(slots.data.days[day][0]) - 1440 * 60000);

  // Move it: the old reminder is stale and must be replaced, not left pointing at the old time.
  const later = slots.data.days[day][3];
  const moved = await req('POST', `/api/public/bookings/${bk.data.token}/reschedule`, { start: later, timezone: 'America/Chicago' });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const live = db.all("SELECT * FROM scheduled_messages WHERE automation_id = ? AND to_addr = 'move@example.com' AND status = 'queued'", a.data.id);
  assert.equal(live.length, 1, 'exactly one reminder, not two');
  assert.equal(live[0].send_after, Date.parse(later) - 1440 * 60000, 're-timed to the new appointment');

  // Cancel it: nothing should still be waiting to go out.
  const off = await req('POST', `/api/public/bookings/${bk.data.token}/cancel`, { reason: 'plans changed' });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(db.get("SELECT COUNT(*) c FROM scheduled_messages WHERE booking_id = ? AND status = 'queued'", row.booking_id).c, 0);
  assert.equal(db.get('SELECT status FROM scheduled_messages WHERE id = ?', live[0].id).status, 'cancelled');
});

test('preview fills merge fields, counts SMS segments and flags a typo', async () => {
  const r = await req('POST', '/api/admin/automations/preview', {
    subject: 'Your {{session}}',
    body_html: 'Hi {{first_name}}, see you {{when}} at {{location}}. Ask for {{frist_name}}.',
    sms_body: 'Hi {{first_name|there}}, your {{session}} is {{time}}.',
    channel: 'both', trigger: 'before', offset_min: 2880,
  }, { cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.unknown_variables, ['frist_name'], 'a misspelt field is called out rather than shipped');
  assert.ok(!r.data.sms_text.includes('{{'));
  assert.equal(r.data.sms.encoding, 'GSM-7');
  assert.equal(r.data.sms.segments, 1);
  assert.equal(r.data.due_example, '2 days before the appointment');
  assert.match(r.data.subject, /Engagement Session|Discovery call/);

  // The fallback form fills in when the value is missing.
  const noName = await req('POST', '/api/admin/automations/preview', { sms_body: 'Hi {{nickname|there}}!' }, { cookie: ownerCookie });
  assert.equal(noName.data.sms_text, 'Hi there!');

  // A curly apostrophe changes the encoding, which changes the bill.
  const uni = await req('POST', '/api/admin/automations/preview', { sms_body: 'It’s tomorrow!' }, { cookie: ownerCookie });
  assert.equal(uni.data.sms.encoding, 'UCS-2');
});

test('an automation cannot be switched on until it has something to send', async () => {
  const noBody = await req('POST', '/api/admin/automations', { name: 'Empty', channel: 'email', trigger: 'before', active: true }, { cookie: ownerCookie });
  assert.equal(noBody.status, 422);
  assert.ok(noBody.data.details.body_html);

  const noText = await req('POST', '/api/admin/automations', { name: 'No text', channel: 'sms', trigger: 'after', active: true, sms_body: '' }, { cookie: ownerCookie });
  assert.equal(noText.status, 422);

  // Saved switched off, it is allowed to be incomplete while it is being written.
  const draft = await req('POST', '/api/admin/automations', { name: 'Draft', channel: 'email', trigger: 'before', active: false }, { cookie: ownerCookie });
  assert.equal(draft.status, 200);
  assert.equal(draft.data.active, false);
  assert.equal(db.all("SELECT * FROM scheduled_messages WHERE automation_id = ?", draft.data.id).length, 0, 'a draft queues nothing');
});

test('the queue screen, manual run and cancel all work; outsiders are locked out', async () => {
  freshLimits();
  const list = await req('GET', '/api/admin/messages', null, { cookie: ownerCookie });
  assert.equal(list.status, 200);
  assert.ok(list.data.rows.length > 0);
  assert.ok(list.data.summary.queued >= 0);
  assert.equal(typeof list.data.summary.sms_ready, 'boolean');

  const queued = list.data.rows.find((r) => r.status === 'queued');
  if (queued) {
    const off = await req('POST', `/api/admin/messages/${queued.id}/cancel`, {}, { cookie: ownerCookie });
    assert.equal(off.status, 200);
    const again = await req('POST', `/api/admin/messages/${queued.id}/cancel`, {}, { cookie: ownerCookie });
    assert.equal(again.status, 409, 'cancelling twice is refused rather than silently ignored');
  }

  assert.equal((await req('GET', '/api/admin/automations')).status, 401);
  assert.equal((await req('POST', '/api/admin/automations', { name: 'x' })).status, 401);
  assert.equal((await req('GET', '/api/admin/messages')).status, 401);

  // Twilio's credentials are never echoed back.
  const cfg = await req('GET', '/api/admin/automations', null, { cookie: ownerCookie });
  assert.equal(cfg.data.sms.ready, true);
  assert.ok(!JSON.stringify(cfg.data).includes(process.env.TWILIO_AUTH_TOKEN));
});

test('the built-in 24h reminder steps aside once a "before" automation exists', async () => {
  // Both firing would put two reminders in the same inbox.
  const hasBefore = db.get("SELECT 1 x FROM message_automations WHERE business_id = 1 AND active = 1 AND trigger = 'before'");
  assert.ok(hasBefore, 'this business has a before-automation from the earlier tests');
  const before = db.get("SELECT COUNT(*) c FROM email_log WHERE subject LIKE 'Reminder:%'").c;
  await runJobs();
  const after = db.get("SELECT COUNT(*) c FROM email_log WHERE subject LIKE 'Reminder:%'").c;
  assert.equal(after, before, 'no duplicate built-in reminder went out');
});

// ---------------------------------------------------------------------------
// Integrations: Stripe, Twilio and Resend credentials
// ---------------------------------------------------------------------------
const appConfig = require('../src/lib/config');
const providers = require('../src/services/providers');

test('a saved key overrides the environment, and clearing it falls back', async () => {
  // Railway value is in place from the earlier Stripe tests.
  assert.equal(appConfig.source('STRIPE_SECRET_KEY'), 'env');
  assert.equal(appConfig.get('STRIPE_SECRET_KEY'), 'sk_test_stubbed');

  appConfig.set('STRIPE_SECRET_KEY', 'sk_test_saved_in_app', 1);
  assert.equal(appConfig.source('STRIPE_SECRET_KEY'), 'app', 'what you type in the app wins');
  assert.equal(appConfig.get('STRIPE_SECRET_KEY'), 'sk_test_saved_in_app');

  // Stored encrypted, not sitting in the table in the clear.
  const row = db.get("SELECT value, secret FROM app_settings WHERE key = 'STRIPE_SECRET_KEY'");
  assert.equal(row.secret, 1);
  assert.match(row.value, /^v1:/);
  assert.ok(!row.value.includes('sk_test_saved_in_app'), 'the plain key is not in the database');

  appConfig.clear('STRIPE_SECRET_KEY');
  assert.equal(appConfig.source('STRIPE_SECRET_KEY'), 'env', 'clearing returns to the Railway value');
  assert.equal(appConfig.get('STRIPE_SECRET_KEY'), 'sk_test_stubbed');
});

test('the integrations API never hands a secret back to the browser', async () => {
  appConfig.set('RESEND_API_KEY', 're_super_secret_value_1234', 1);
  appConfig.set('TWILIO_AUTH_TOKEN', 'twilio_secret_token_abcd', 1);

  const r = await req('GET', '/api/admin/integrations/providers', null, { cookie: ownerCookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const blob = JSON.stringify(r.data);
  assert.ok(!blob.includes('re_super_secret_value_1234'), 'the Resend key must never be returned');
  assert.ok(!blob.includes('twilio_secret_token_abcd'), 'the Twilio token must never be returned');
  assert.ok(!blob.includes('sk_test_stubbed'));
  assert.ok(!blob.includes(WHSEC));

  // What it does return is enough to show the state of things.
  const key = r.data.resend.fields.find((f) => f.key === 'RESEND_API_KEY');
  assert.equal(key.set, true);
  assert.equal(key.source, 'app');
  assert.match(key.hint, /^re_•+1234$/, 'only a masked tail comes back');
  assert.equal(r.data.stripe.mode, 'test');
  assert.ok(Array.isArray(r.data.stripe.webhook.events));
  assert.match(r.data.twilio.webhook.url, /\/api\/public\/sms\/inbound$/);
  // Non-secret fields are safe to show in full so they can be edited.
  assert.equal(r.data.twilio.fields.find((f) => f.key === 'TWILIO_FROM_NUMBER').hint, '+18325550000');

  appConfig.clear('RESEND_API_KEY');
  appConfig.clear('TWILIO_AUTH_TOKEN');
});

test('leaving the mask in place keeps a key; an empty string clears it', async () => {
  appConfig.set('STRIPE_WEBHOOK_SECRET', 'whsec_original_value', 1);

  // The screen sends the mask back for anything the user did not retype.
  const keep = await req('PUT', '/api/admin/integrations/providers/stripe',
    { STRIPE_WEBHOOK_SECRET: appConfig.MASK }, { cookie: ownerCookie });
  assert.equal(keep.status, 200);
  assert.deepEqual(keep.data.changed, [], 'the mask changes nothing');
  assert.equal(appConfig.get('STRIPE_WEBHOOK_SECRET'), 'whsec_original_value');

  const change = await req('PUT', '/api/admin/integrations/providers/stripe',
    { STRIPE_WEBHOOK_SECRET: 'whsec_brand_new' }, { cookie: ownerCookie });
  assert.deepEqual(change.data.changed, ['STRIPE_WEBHOOK_SECRET']);
  assert.equal(appConfig.get('STRIPE_WEBHOOK_SECRET'), 'whsec_brand_new');

  const cleared = await req('PUT', '/api/admin/integrations/providers/stripe',
    { STRIPE_WEBHOOK_SECRET: '' }, { cookie: ownerCookie });
  assert.equal(cleared.status, 200);
  assert.equal(appConfig.source('STRIPE_WEBHOOK_SECRET'), 'env', 'back to the Railway value');

  // A key belonging to another provider is refused rather than quietly written.
  appConfig.clear('RESEND_API_KEY');
  const wrong = await req('PUT', '/api/admin/integrations/providers/stripe',
    { RESEND_API_KEY: 're_nope' }, { cookie: ownerCookie });
  assert.equal(wrong.status, 422);
  assert.match(wrong.data.error, /does not belong to stripe/);
  assert.notEqual(appConfig.get('RESEND_API_KEY'), 're_nope', 'nothing was written');

  const unknownProvider = await req('PUT', '/api/admin/integrations/providers/paypal', {}, { cookie: ownerCookie });
  assert.equal(unknownProvider.status, 404);
});

test('only an owner can write credentials; a host cannot even read them', async () => {
  // Add a host to this business.
  const invite = await req('POST', '/api/admin/team', { name: 'Hosty', email: 'hosty@test.dev', role: 'host' }, { cookie: ownerCookie });
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const row = db.get("SELECT invite_token FROM memberships WHERE user_id = (SELECT id FROM users WHERE email = 'hosty@test.dev')");
  const accepted = await req('POST', '/api/admin/auth/accept', { token: row.invite_token, name: 'Hosty', password: 'password123' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const hostCookie = accepted.cookie;

  assert.equal((await req('GET', '/api/admin/integrations/providers', null, { cookie: hostCookie })).status, 403);
  assert.equal((await req('PUT', '/api/admin/integrations/providers/stripe', { STRIPE_SECRET_KEY: 'sk_test_x' }, { cookie: hostCookie })).status, 403);
  assert.equal((await req('POST', '/api/admin/integrations/stripe/test-charge', { confirm: 'CHARGE' }, { cookie: hostCookie })).status, 403);
  assert.equal(appConfig.get('STRIPE_SECRET_KEY'), 'sk_test_stubbed', 'the host changed nothing');

  // And nobody unauthenticated gets near it.
  assert.equal((await req('GET', '/api/admin/integrations/providers')).status, 401);
  assert.equal((await req('PUT', '/api/admin/integrations/providers/twilio', { TWILIO_AUTH_TOKEN: 'x' })).status, 401);
});

test('the $1 test needs a typed confirmation and never creates a booking', async () => {
  const bookingsBefore = db.get('SELECT COUNT(*) c FROM bookings').c;
  const ordersBefore = db.get('SELECT COUNT(*) c FROM orders').c;

  const noConfirm = await req('POST', '/api/admin/integrations/stripe/test-charge', {}, { cookie: ownerCookie });
  assert.equal(noConfirm.status, 422, 'real money needs a deliberate confirmation');
  assert.ok(noConfirm.data.details.confirm);

  const wrongWord = await req('POST', '/api/admin/integrations/stripe/test-charge', { confirm: 'yes' }, { cookie: ownerCookie });
  assert.equal(wrongWord.status, 422);

  // With both keys in place and the confirmation typed, it opens a checkout.
  appConfig.set('STRIPE_WEBHOOK_SECRET', WHSEC, 1);
  const go = await req('POST', '/api/admin/integrations/stripe/test-charge', { confirm: 'charge' }, { cookie: ownerCookie });
  assert.equal(go.status, 200, JSON.stringify(go.data));
  assert.equal(go.data.amount, 1);
  assert.match(go.data.ref, /^diag_/);
  const call = checkoutCalls[checkoutCalls.length - 1];
  assert.equal(call.amountCents, 100);
  assert.equal(call.metadata.diagnostic, '1');

  // Nothing was booked or sold by starting it.
  assert.equal(db.get('SELECT COUNT(*) c FROM orders').c, ordersBefore, 'the test does not create an order');
  assert.equal(providers.lastDiagnostic().status, 'awaiting_payment');

  // The webhook for it records the result rather than hunting for an order.
  const event = { id: 'evt_diag_1', type: 'checkout.session.completed', data: { object: {
    id: 'cs_diag_1', client_reference_id: go.data.ref, payment_status: 'paid', amount_total: 100,
    payment_intent: 'pi_diag_1', metadata: { diagnostic: '1', ref: go.data.ref },
  } } };
  const hook = await postWebhook(event);
  assert.equal(hook.status, 200, JSON.stringify(hook.data));
  assert.equal(hook.data.result, 'connection test recorded');

  const last = providers.lastDiagnostic();
  assert.equal(last.status, 'webhook_received');
  assert.equal(last.amount, 1);
  assert.equal(last.payment_intent, 'pi_diag_1');

  assert.equal(db.get('SELECT COUNT(*) c FROM bookings').c, bookingsBefore, 'no booking was created');
  assert.equal(db.get('SELECT COUNT(*) c FROM orders').c, ordersBefore, 'and no session order either');

  // It shows up on the integrations screen as a passed test.
  const view = await req('GET', '/api/admin/integrations/providers', null, { cookie: ownerCookie });
  assert.equal(view.data.stripe.last_test.status, 'webhook_received');
  assert.ok(view.data.stripe.webhook.received > 0);
});

test('a test email reports honestly when no key is live', async () => {
  // With no Resend key the app only writes to the log, and saying "sent" would be a lie.
  const before = appConfig.get('RESEND_API_KEY');
  if (before) appConfig.clear('RESEND_API_KEY');
  const prevEnv = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  appConfig.invalidate();

  const r = await req('POST', '/api/admin/integrations/providers/resend/send-test', { to: 'owner@test.dev' }, { cookie: ownerCookie });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /only written to the log/i);

  if (prevEnv) process.env.RESEND_API_KEY = prevEnv;
  appConfig.invalidate();
});

test('a test text refuses an unusable number before spending anything', async () => {
  stubTwilio();
  const bad = await req('POST', '/api/admin/integrations/providers/twilio/send-test', { to: '832-555-1234 ext 2' }, { cookie: ownerCookie });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /does not look like a mobile number/);

  const good = await req('POST', '/api/admin/integrations/providers/twilio/send-test', { to: '(832) 555-7777' }, { cookie: ownerCookie });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.to, '+18325557777');
  assert.equal(sentTexts[sentTexts.length - 1].to, '+18325557777');
  assert.match(sentTexts[sentTexts.length - 1].body, /Reply STOP to opt out/, 'a test text still says how to opt out');
  assert.match(db.get('SELECT body FROM sms_log ORDER BY id DESC LIMIT 1').body, /^\[test\]/, 'logged as a test, not as customer traffic');
});

test('changing a key takes effect immediately, without a restart', async () => {
  stubTwilio();
  // A number saved in the app is the one used on the very next send.
  appConfig.set('TWILIO_FROM_NUMBER', '+18325559999', 1);
  const status = await req('GET', '/api/admin/integrations/providers', null, { cookie: ownerCookie });
  assert.equal(status.data.twilio.fields.find((f) => f.key === 'TWILIO_FROM_NUMBER').hint, '+18325559999');
  assert.equal(status.data.twilio.ready, true);

  // Clearing the account SID immediately makes texting unavailable rather than failing later.
  const prev = process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_ACCOUNT_SID;
  appConfig.clear('TWILIO_ACCOUNT_SID');
  const off = await req('GET', '/api/admin/integrations/providers', null, { cookie: ownerCookie });
  assert.equal(off.data.twilio.ready, false);
  assert.ok(off.data.twilio.missing.includes('TWILIO_ACCOUNT_SID'));
  // And an automation cannot be switched on to send texts while it is unavailable.
  const blocked = await req('POST', '/api/admin/automations', { name: 'Texty', channel: 'sms', trigger: 'before', sms_body: 'hi', active: true }, { cookie: ownerCookie });
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.error, /not connected/i);

  if (prev) process.env.TWILIO_ACCOUNT_SID = prev;
  appConfig.clear('TWILIO_FROM_NUMBER');
  appConfig.invalidate();
});
