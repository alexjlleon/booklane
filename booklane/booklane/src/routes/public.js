'use strict';
const db = require('../db');
const T = require('../lib/time');
const { HttpError } = require('../lib/router');
const { rateLimit } = require('../lib/security');
const { baseUrl, bool } = require('../lib/util');
const { buildIcs, googleCalendarLink } = require('../lib/ics');
const { page, APP_NAME } = require('../views');
const B = require('../services/business');
const ORG = require('../services/org');
const L = require('../services/leads');
const S = require('../services/scheduling');
const Q = require('../services/quotes');
const BK = require('../services/bookings');
const SESS = require('../services/sessions');
const PROD = require('../services/products');
const FORMS = require('../services/forms');
const MSG = require('../services/messaging');
const stripe = require('../lib/stripe');
const payments = require('../lib/payments');
const sms = require('../lib/sms');
const { LOCATION_TYPES } = require('../defaults');

const writeLimit = rateLimit({ windowMs: 60000, max: 90 });
const createLimit = rateLimit({ windowMs: 10 * 60000, max: 40 });
const bookLimit = rateLimit({ windowMs: 10 * 60000, max: 15 });
const payLimit = rateLimit({ windowMs: 10 * 60000, max: 12 });

function getBusiness(slug) {
  const b = B.bySlug(slug);
  if (!b) throw new HttpError(404, 'Business not found');
  return b;
}
function getEventType(business, slug) {
  const et = BK.hydrateEt(db.get('SELECT * FROM event_types WHERE business_id = ? AND slug = ? AND active = 1', business.id, slug));
  if (!et) throw new HttpError(404, 'This booking page is not available');
  return et;
}
const publicBusiness = (b) => ({ id: b.id, slug: b.slug, name: b.name, logo_url: b.logo_url, brand_color: b.brand_color, timezone: b.timezone, phone: b.phone, email: b.email, website: b.website, settings: B.publicSettings(b) });
function publicEventType(et, teamsById) {
  const hosts = S.hostsFor(et.id).map((h) => ({ name: h.name }));
  // The list passes a lookup it built once; a single page has no list to share, so it reads its own.
  const team = !et.team_id ? null
    : teamsById ? teamsById.get(Number(et.team_id))
      : db.get('SELECT id, name, color FROM teams WHERE id = ? AND active = 1', et.team_id) || null;
  return { id: et.id, slug: et.slug, name: et.name, description: et.description, duration_min: et.duration_min, location_type: et.location_type,
    location_label: LOCATION_TYPES[et.location_type], location_value: et.location_type === 'in_person' ? et.location_value : null,
    max_days_ahead: et.max_days_ahead, color: et.color, steps: et.steps, hosts, settings: et.settings,
    booking_type_id: et.booking_type_id || null,
    // The team is shown on the card, so the customer can see who runs this without it deciding how
    // the page is laid out. An inactive team is simply not named, rather than named and misleading.
    team: team ? { id: team.id, name: team.name, color: team.color } : null };
}
const activeEventTypes = (b) => db.all('SELECT * FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id', b.id).map(BK.hydrateEt);
/**
 * What the public page needs: the pages themselves, and the same pages gathered under their type
 * headings in the order the admin put them in.
 *
 * Both, not one: eventTypes stays a flat list so anything already reading it keeps working, and a
 * page with no type still appears there and in a final group of its own. A booking page that takes
 * bookings must never vanish from the list for want of a label.
 */
function publicBookingPages(b) {
  const teamsById = new Map(ORG.listTeams(b.id).map((t) => [t.id, t]));
  const pages = activeEventTypes(b).map((et) => publicEventType(et, teamsById));
  return { eventTypes: pages, bookingGroups: ORG.groupByType(b.id, pages) };
}

module.exports = function publicRoutes(app) {
  // ---------- Pages ----------
  app.get('/b/:slug', (req, res) => {
    const b = getBusiness(req.params.slug);
    const embed = bool(req.query.embed);
    res.html(page({ title: `${b.name} · Book a call`, description: b.settings.tagline, business: b, embed, scripts: ['common.js', 'profile.js'],
      data: { business: publicBusiness(b), ...publicBookingPages(b) } }));
  });

  app.get('/b/:slug/quote', (req, res) => {
    const b = getBusiness(req.params.slug);
    if (!b.settings.quote.enabled) throw new HttpError(404, 'Quotes are not enabled');
    const callEt = b.settings.quote.call_event_type_id ? db.get('SELECT slug FROM event_types WHERE id = ? AND business_id = ? AND active = 1', b.settings.quote.call_event_type_id, b.id) : null;
    const fallbackEt = callEt || db.get('SELECT slug FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1', b.id);
    res.html(page({ title: `${b.settings.quote.title} · ${b.name}`, description: b.settings.quote.intro, business: b, embed: bool(req.query.embed), scripts: ['pricing.js', 'common.js', 'quote.js'],
      data: { business: publicBusiness(b), catalog: Q.catalog(b.id), callEventSlug: fallbackEt?.slug || null } }));
  });

  app.get('/b/:slug/:event', (req, res) => {
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    let services = [];
    try { services = Q.catalog(b.id).map((s) => s.name); } catch { /* ignore */ }
    res.html(page({ title: `${et.name} · ${b.name}`, description: et.description || b.settings.tagline, business: b, embed: bool(req.query.embed), scripts: ['common.js', 'scheduler.js', 'booking.js'],
      data: { business: publicBusiness(b), eventType: publicEventType(et), serviceNames: services } }));
  });

  // ---------- Sessions you can buy ----------
  app.get('/b/:slug/s/:event', (req, res) => {
    const b = getBusiness(req.params.slug);
    const et = SESS.bySlug(b, req.params.event);
    res.html(page({ title: `${et.name} · ${b.name}`, description: et.description || b.settings.tagline, business: b, embed: bool(req.query.embed),
      scripts: ['common.js', 'scheduler.js', 'session.js'],
      data: { business: publicBusiness(b), session: SESS.publicSession(et, b), cancelled: req.query.cancelled ? true : false } }));
  });

  // Where Stripe sends them back to. The webhook usually lands first, but this page also asks
  // Stripe directly, so a slow webhook never leaves someone staring at a spinner.
  app.get('/session/:token', (req, res) => {
    const order = SESS.orderByToken(req.params.token);
    if (!order) throw new HttpError(404, 'Not found');
    const b = B.byId(order.business_id);
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Finishing up · ${b.name}`, business: b, scripts: ['common.js', 'session-return.js'],
      data: { business: publicBusiness(b), order: SESS.publicOrder(order) } }));
  });

  // ---------- Custom forms ----------
  app.get('/b/:slug/f/:form', (req, res) => {
    const b = getBusiness(req.params.slug);
    const f = FORMS.bySlug(b, req.params.form);
    res.html(page({ title: `${f.name} · ${b.name}`, description: f.description || b.settings.tagline, business: b, embed: bool(req.query.embed),
      scripts: ['common.js', 'scheduler.js', 'form.js'],
      data: { business: publicBusiness(b), form: FORMS.publicForm(b, f), cancelled: req.query.cancelled ? true : false } }));
  });

  // Where a form that charges sends people back to.
  app.get('/b/:slug/f/:form/done', (req, res) => {
    const b = getBusiness(req.params.slug);
    const f = FORMS.bySlug(b, req.params.form);
    const order = PROD.orderByToken(req.query.order);
    if (!order || order.business_id !== b.id) throw new HttpError(404, 'Not found');
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Thank you · ${b.name}`, business: b, scripts: ['common.js', 'scheduler.js', 'product-return.js'],
      data: { business: publicBusiness(b), order: PROD.publicOrder(b, order), orderToken: order.token, form: { slug: f.slug, name: f.name } } }));
  });

  app.get('/api/public/b/:slug/f/:form', (req) => {
    const b = getBusiness(req.params.slug);
    return { form: FORMS.publicForm(b, FORMS.bySlug(b, req.params.form)) };
  });

  // Slots for a form's calendar step. The booking page it names owns the hours and the hosts.
  app.get('/api/public/b/:slug/f/:form/slots', async (req) => {
    const b = getBusiness(req.params.slug);
    const f = FORMS.bySlug(b, req.params.form);
    const step = f.steps.find((x) => x.type === 'schedule');
    if (!step || !step.event_type_id) throw new HttpError(409, 'This form has no calendar on it.');
    const row = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ? AND active = 1', step.event_type_id, b.id);
    if (!row) throw new HttpError(404, 'That calendar is not available.');
    const et = BK.hydrateEt(row);
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : b.timezone;
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 30);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const slots = await S.computeSlots(et, from, to, tz);
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((x) => x.start);
    return { timezone: tz, from, to, days };
  });

  // Price a product step's selection, so the running total on the page is the server's figure.
  app.post('/api/public/b/:slug/f/:form/quote', (req) => {
    const b = getBusiness(req.params.slug);
    const f = FORMS.bySlug(b, req.params.form);
    const step = f.steps.find((x) => x.type === 'product');
    if (!step || !step.product_id) throw new HttpError(409, 'This form has nothing to price.');
    const product = db.get('SELECT * FROM products WHERE id = ? AND business_id = ? AND active = 1', step.product_id, b.id);
    if (!product) throw new HttpError(409, 'That product is not available.');
    const priced = PROD.priceSelection(product, (req.body || {}).selection || {});
    return {
      total_cents: priced.total_cents,
      lines: priced.lines.map((l) => ({ label: l.label, detail: l.detail || '', qty: l.qty, unit_cents: l.unit_cents, line_cents: l.unit_cents * l.qty })),
    };
  });

  app.post('/api/public/b/:slug/f/:form/submit', async (req) => {
    writeLimit(req);
    const b = getBusiness(req.params.slug);
    const f = FORMS.bySlug(b, req.params.form);
    return FORMS.submit(b, f, req.body || {});
  });

  // ---------- Products you can buy outright ----------
  // A product is paid for first and scheduled afterwards, which is the opposite order to a session.
  // Nothing here trusts a price from the browser: every total is recomputed from the product row.
  app.get('/b/:slug/p/:product', (req, res) => {
    const b = getBusiness(req.params.slug);
    const p = PROD.bySlug(b, req.params.product);
    res.html(page({ title: `${p.name} · ${b.name}`, description: p.description || b.settings.tagline, business: b, embed: bool(req.query.embed),
      scripts: ['common.js', 'product.js'],
      data: { business: publicBusiness(b), product: PROD.publicProduct(b, p), cancelled: req.query.cancelled ? true : false } }));
  });

  // Where Stripe sends them back to.
  app.get('/b/:slug/p/:product/done', (req, res) => {
    const b = getBusiness(req.params.slug);
    PROD.bySlug(b, req.params.product);
    const order = PROD.orderByToken(req.query.order);
    if (!order || order.business_id !== b.id) throw new HttpError(404, 'Not found');
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Thank you · ${b.name}`, business: b, scripts: ['common.js', 'scheduler.js', 'product-return.js'],
      data: { business: publicBusiness(b), order: PROD.publicOrder(b, order), orderToken: order.token } }));
  });

  // The link in the confirmation email, for anyone who closed the tab before booking their call.
  app.get('/b/:slug/schedule/:token', (req, res) => {
    const b = getBusiness(req.params.slug);
    const order = PROD.orderByScheduleToken(req.params.token);
    if (!order || order.business_id !== b.id) throw new HttpError(404, 'Not found');
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Book your call · ${b.name}`, business: b, scripts: ['common.js', 'scheduler.js', 'product-return.js'],
      data: { business: publicBusiness(b), order: PROD.publicOrder(b, order), orderToken: order.token } }));
  });

  app.get('/api/public/b/:slug/p/:product', (req) => {
    const b = getBusiness(req.params.slug);
    return { product: PROD.publicProduct(b, PROD.bySlug(b, req.params.product)) };
  });

  // The running total the page shows comes from here, so what they read is what they will be charged.
  app.post('/api/public/b/:slug/p/:product/quote', (req) => {
    const b = getBusiness(req.params.slug);
    const p = PROD.bySlug(b, req.params.product);
    const priced = PROD.priceSelection(p, (req.body || {}).selection || {});
    return {
      total_cents: priced.total_cents,
      lines: priced.lines.map((l) => ({ label: l.label, detail: l.detail || '', qty: l.qty, unit_cents: l.unit_cents, line_cents: l.unit_cents * l.qty })),
    };
  });

  app.post('/api/public/b/:slug/p/:product/checkout', async (req) => {
    writeLimit(req);
    const b = getBusiness(req.params.slug);
    const p = PROD.bySlug(b, req.params.product);
    return PROD.startCheckout(b, p, req.body || {});
  });

  app.get('/api/public/orders/:token/slots', async (req) => {
    const order = PROD.orderByToken(req.params.token);
    if (!order || order.order_kind !== 'product') throw new HttpError(404, 'Not found');
    const b = B.byId(order.business_id);
    const prod = order.product_id ? PROD.hydrate(db.get('SELECT * FROM products WHERE id = ?', order.product_id)) : null;
    if (!prod || !prod.followup_event_type_id) throw new HttpError(409, 'There is nothing to schedule for this order.');
    const row = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ? AND active = 1', prod.followup_event_type_id, b.id);
    if (!row) throw new HttpError(404, 'That booking page is not available.');
    const et = BK.hydrateEt(row);
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : b.timezone;
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 30);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const slots = await S.computeSlots(et, from, to, tz);
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((x) => x.start);
    return { timezone: tz, from, to, days, event: { name: et.name, duration_min: et.duration_min } };
  });

  app.post('/api/public/orders/:token/schedule', async (req) => {
    writeLimit(req);
    const order = PROD.orderByToken(req.params.token);
    if (!order || order.order_kind !== 'product') throw new HttpError(404, 'Not found');
    const b = B.byId(order.business_id);
    return { order: await PROD.scheduleFollowup(b, order, req.body || {}) };
  });

  app.get('/api/public/b/:slug/s/:event', (req) => {
    const b = getBusiness(req.params.slug);
    return { session: SESS.publicSession(SESS.bySlug(b, req.params.event), b) };
  });

  app.get('/api/public/b/:slug/s/:event/slots', async (req) => {
    const b = getBusiness(req.params.slug);
    const et = SESS.bySlug(b, req.params.event);
    const cal = SESS.resolveCalendar(b, et, req.query.calendar);
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : (cal.timezone || b.timezone);
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 30);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const slots = await S.computeSlots(et, from, to, tz, { restrictHostIds: [cal.user_id] });
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((s) => s.start);
    return { timezone: tz, from, to, calendar: cal.slug, days };
  });

  // Book without a card. Either they already paid and have a booking number, or the session is
  // free. The service refuses the free path on any session that actually has a price.
  app.post('/api/public/b/:slug/s/:event/claim', async (req) => {
    bookLimit(req);
    const b = getBusiness(req.params.slug);
    const et = SESS.bySlug(b, req.params.event);
    const body = req.body || {};
    const { booking } = await SESS.claimBooked(b, et, body, { alreadyBooked: body.already_booked !== false });
    return { token: booking.token, redirect: `/booking/${booking.token}?new=1` };
  });

  // Not booked yet: hold the slot and hand back a Stripe Checkout URL.
  app.post('/api/public/b/:slug/s/:event/checkout', async (req) => {
    payLimit(req);
    const b = getBusiness(req.params.slug);
    const et = SESS.bySlug(b, req.params.event);
    return SESS.startCheckout(b, et, req.body || {});
  });

  // One path, two kinds of order. A session order reports where to send them once the slot is
  // booked; a product order reports what they bought and whether a call still needs scheduling.
  app.get('/api/public/orders/:token', async (req) => {
    const order = SESS.orderByToken(req.params.token);
    if (!order) throw new HttpError(404, 'Not found');
    if (order.order_kind === 'product') {
      const b = B.byId(order.business_id);
      return { order: PROD.publicOrder(b, await PROD.reconcile(order)) };
    }
    return { order: await SESS.reconcileOrder(order) };
  });

  // Stripe posts here. The signature check is what stops anyone faking a paid order, so an
  // unverified body is never parsed as an event.
  /**
   * One webhook endpoint per provider per business.
   *
   * The business is in the path rather than the body because the signature has to be checked with
   * that business's own key before any field of the payload is read -- and Square signs the
   * notification URL along with the body, so the URL has to be the one registered anyway.
   */
  app.post('/api/public/:provider/webhook/:slug', async (req, res) => {
    const provider = req.params.provider === 'square' ? 'square' : 'stripe';
    let business;
    try { business = getBusiness(req.params.slug); } catch { res.statusCode = 404; return res.json({ error: 'Unknown business' }); }

    let event;
    try {
      event = payments.verifyWebhook(provider, req.rawBody, req.headers, { business });
    } catch (e) {
      console.error(`[${provider} webhook] rejected:`, e.message);
      res.statusCode = 400;
      return res.json({ error: 'Invalid signature' });
    }
    try {
      const result = await SESS.handleStripeEvent(event, { provider, business });
      return res.json({ received: true, result });
    } catch (e) {
      // Answer 500 so the provider retries a transient failure rather than giving up on it.
      console.error(`[${provider} webhook]`, event.type, e.message);
      res.statusCode = 500;
      return res.json({ error: 'Could not process that event' });
    }
  });

  // The original Stripe endpoint, kept working for any webhook already registered against it.
  app.post('/api/public/stripe/webhook', async (req, res) => {
    let event;
    try {
      event = stripe.verifyWebhook(req.rawBody, req.headers['stripe-signature']);
    } catch (e) {
      console.error('[stripe webhook] rejected:', e.message);
      res.statusCode = 400;
      return res.json({ error: 'Invalid signature' });
    }
    try {
      const result = await SESS.handleStripeEvent(event, { provider: 'stripe' });
      return res.json({ received: true, result });
    } catch (e) {
      // Answer 500 so Stripe retries a transient failure rather than giving up on it.
      console.error('[stripe webhook]', event.type, e.message);
      res.statusCode = 500;
      return res.json({ error: 'Could not process that event' });
    }
  });

  // Twilio posts replies here. A STOP must be honoured, so the signature is checked first:
  // without it, anyone could post a forged STOP and silence our messages to a real customer,
  // or a forged reply that looks like it came from them.
  app.post('/api/public/sms/inbound', (req, res) => {
    const params = req.rawBody ? Object.fromEntries(new URLSearchParams(req.rawBody)) : {};
    try {
      sms.verifyWebhook(`${baseUrl()}/api/public/sms/inbound`, params, req.headers['x-twilio-signature']);
    } catch (e) {
      console.error('[sms inbound] rejected:', e.message);
      res.statusCode = 403;
      return res.text('<Response/>', 'text/xml');
    }
    let result = null;
    try {
      result = MSG.handleInboundSms({ from: params.From, to: params.To, body: params.Body, sid: params.MessageSid });
    } catch (e) {
      console.error('[sms inbound]', e.message);
    }
    // Twilio sends its own STOP confirmation, so stay quiet and do not double-reply.
    res.set('X-Booklane-Action', (result && result.action) || 'none');
    return res.text('<Response/>', 'text/xml');
  });

  app.get('/q/:token', (req, res) => {
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Quote not found');
    const b = B.byId(q.business_id);
    const callEt = b.settings.quote.call_event_type_id ? db.get('SELECT slug FROM event_types WHERE id = ? AND business_id = ? AND active = 1', b.settings.quote.call_event_type_id, b.id) : db.get('SELECT slug FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1', b.id);
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Your quote · ${b.name}`, business: b, scripts: ['pricing.js', 'common.js', 'quote-view.js'],
      data: { business: publicBusiness(b), quote: Q.publicQuote(q, b), catalog: Q.catalog(b.id), callEventSlug: callEt?.slug || null } }));
  });

  app.get('/booking/:token', (req, res) => {
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Booking not found');
    const { et, business, host } = BK.bookingView(bk);
    res.set('X-Robots-Tag', 'noindex');
    res.html(page({ title: `Your booking · ${business.name}`, business, scripts: ['common.js', 'scheduler.js', 'manage.js'],
      data: { business: publicBusiness(business), eventType: et ? publicEventType(et) : null, booking: bookingPublic(bk, et, business, host), reschedule: bool(req.query.reschedule) } }));
  });

  function bookingPublic(bk, et, business, host) {
    const start = Date.parse(bk.start_utc), end = Date.parse(bk.end_utc);
    const summary = `${et?.name || 'Call'} with ${business.name}`;
    return { token: bk.token, status: bk.status, start: bk.start_utc, end: bk.end_utc, timezone: bk.invitee_tz, name: bk.name, email: bk.email, location: bk.location,
      host: host?.name, event_name: et?.name, duration_min: et?.duration_min, cancel_reason: bk.cancel_reason,
      google_link: googleCalendarLink({ start, end, summary, location: bk.location, description: `${baseUrl()}/booking/${bk.token}` }), ics_url: `/api/public/bookings/${bk.token}/ics` };
  }

  // ---------- Booking API ----------
  app.get('/api/public/b/:slug/e/:event/slots', async (req) => {
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    const tz = T.isValidTz(req.query.tz) ? req.query.tz : b.timezone;
    const from = T.isDateStr(req.query.from) ? req.query.from : T.utcToZoned(Date.now(), tz).date;
    let to = T.isDateStr(req.query.to) ? req.query.to : T.addDays(from, 30);
    if (to < from) to = from;
    if (Date.parse(to) - Date.parse(from) > 62 * 86400000) to = T.addDays(from, 62);
    const exclude = req.query.reschedule ? db.get('SELECT id FROM bookings WHERE token = ?', req.query.reschedule)?.id : undefined;
    const slots = await S.computeSlots(et, from, to, tz, { excludeBookingId: exclude });
    const days = {};
    for (const [d, list] of Object.entries(slots)) days[d] = list.map((s) => s.start);
    return { timezone: tz, from, to, days };
  });

  app.post('/api/public/b/:slug/leads', (req) => {
    createLimit(req);
    const b = getBusiness(req.params.slug);
    const body = req.body || {};
    let et = null;
    if (body.event_type_slug) et = db.get('SELECT id FROM event_types WHERE business_id = ? AND slug = ?', b.id, body.event_type_slug);
    const lead = L.createLead(b, { source: body.source === 'quote' ? 'quote' : 'booking', eventTypeId: et?.id, meta: { ...(body.meta || {}), user_agent: req.headers['user-agent'] } });
    B.logActivity(b.id, lead.id, 'started', `Started the ${lead.source === 'quote' ? 'quote builder' : 'booking form'}`);
    return { token: lead.token };
  });

  app.get('/api/public/leads/:token', (req) => {
    const lead = L.byToken(req.params.token);
    if (!lead) throw new HttpError(404, 'Not found');
    return L.publicLead(lead);
  });

  const patchLead = (req) => {
    writeLimit(req);
    const lead = L.byToken(req.params.token);
    if (!lead) throw new HttpError(404, 'Not found');
    const updated = L.updateLead(lead, req.body || {});
    return { ok: true, status: updated.status };
  };
  app.patch('/api/public/leads/:token', patchLead);
  app.post('/api/public/leads/:token/beacon', (req, res) => { try { patchLead(req); } catch { /* beacons are fire-and-forget */ } res.statusCode = 204; res.end(); });

  app.post('/api/public/b/:slug/e/:event/book', async (req) => {
    bookLimit(req);
    const b = getBusiness(req.params.slug);
    const et = getEventType(b, req.params.event);
    const body = req.body || {};
    let lead = body.lead_token ? L.byToken(body.lead_token) : null;
    if (lead && lead.business_id !== b.id) lead = null;
    if (!lead) lead = L.createLead(b, { source: 'booking', eventTypeId: et.id });
    let quote = body.quote_token ? Q.byToken(body.quote_token) : null;
    if (quote && quote.business_id !== b.id) quote = null;
    if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) body.answers = {};
    if (quote) body.answers.quote_total = String(quote.total);
    const contact = body.contact && typeof body.contact === 'object' ? body.contact : {};
    const booking = await BK.createBooking({ business: b, et, startIso: body.start, tz: body.timezone, contact, answers: body.answers || {}, lead, quote });
    if (quote) db.run("UPDATE quotes SET next_step = 'call', status = CASE WHEN status = 'draft' THEN 'submitted' ELSE status END, updated_at = datetime('now') WHERE id = ?", quote.id);
    return { token: booking.token, redirect: `/booking/${booking.token}?new=1` };
  });

  app.get('/api/public/bookings/:token/ics', (req, res) => {
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    const { et, business, host } = BK.bookingView(bk);
    res.set('Content-Disposition', 'attachment; filename="booking.ics"');
    res.text(buildIcs({ uid: `booking-${bk.id}-${bk.token.slice(0, 8)}@booklane`, start: Date.parse(bk.start_utc), end: Date.parse(bk.end_utc), summary: `${et?.name || 'Call'} with ${business.name}`,
      description: `${baseUrl()}/booking/${bk.token}`, location: bk.location, organizerName: business.name, organizerEmail: host?.email, attendeeName: bk.name, attendeeEmail: bk.email, method: 'PUBLISH', cancelled: bk.status === 'cancelled' }), 'text/calendar; charset=utf-8');
  });

  app.post('/api/public/bookings/:token/cancel', async (req) => {
    writeLimit(req);
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    await BK.cancelBooking(bk, req.body?.reason, 'invitee');
    return { ok: true };
  });

  app.post('/api/public/bookings/:token/reschedule', async (req) => {
    bookLimit(req);
    const bk = db.get('SELECT * FROM bookings WHERE token = ?', req.params.token);
    if (!bk) throw new HttpError(404, 'Not found');
    const updated = await BK.rescheduleBooking(bk, req.body?.start, req.body?.timezone);
    return { ok: true, start: updated.start_utc };
  });

  // ---------- Quote API ----------
  app.post('/api/public/b/:slug/quotes', (req) => {
    createLimit(req);
    const b = getBusiness(req.params.slug);
    const body = req.body || {};
    let lead = body.lead_token ? L.byToken(body.lead_token) : null;
    if (lead && lead.business_id !== b.id) lead = null;
    if (!lead) {
      lead = L.createLead(b, { source: 'quote', meta: { ...(body.meta || {}), user_agent: req.headers['user-agent'] } });
      B.logActivity(b.id, lead.id, 'started', 'Started the quote builder');
    }
    const q = Q.createQuote(b, lead);
    return { token: q.token, lead_token: lead.token };
  });

  app.get('/api/public/quotes/:token', (req) => {
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    return Q.publicQuote(q, B.byId(q.business_id));
  });

  app.patch('/api/public/quotes/:token', (req) => {
    writeLimit(req);
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    const b = B.byId(q.business_id);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const locked = !['draft', 'submitted'].includes(q.status);
    if (locked && (body.details || body.selections)) throw new HttpError(409, 'This quote is locked because a contract was requested. Contact us to make changes.');
    if (body.details) db.run("UPDATE quotes SET details = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify({ ...db.json(q.details, {}), ...Q.sanitizeDetails({ ...db.json(q.details, {}), ...body.details }, b) }), q.id);
    if (body.selections) Q.recalc(b, q, Q.sanitizeSelections(body.selections));
    let lead = q.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', q.lead_id) : null;
    // The lead this quote belonged to can be gone - deleted in the admin while the customer still
    // had the page open. Without this, they retype their details, every save quietly lands nowhere,
    // and nothing they do will ever let them request a contract. Give the quote a lead again.
    if (!lead && body.contact && typeof body.contact === 'object') {
      lead = L.createLead(b, { source: 'quote', meta: { user_agent: req.headers['user-agent'] } });
      db.run('UPDATE quotes SET lead_id = ? WHERE id = ?', lead.id, q.id);
      B.logActivity(b.id, lead.id, 'started', 'Came back to a quote whose contact record was gone');
    }
    if (lead) {
      const details = db.json(Q.byToken(q.token).details, {});
      const quoteAnswers = { event_type: details.event_type, event_date: details.event_date, venue: details.venue, city: details.city, guests: details.guests };
      const fresh = Q.byToken(q.token);
      const services = db.json(fresh.line_items, []).map((l) => l.name);
      const extra = services.length ? { services, quote_total: String(fresh.total) } : {};
      L.updateLead(lead, { ...body, answers: { ...Object.fromEntries(Object.entries(quoteAnswers).filter(([, v]) => v)), ...extra } });
    }
    return Q.publicQuote(Q.byToken(q.token), b);
  });

  async function quoteAction(req, fn) {
    bookLimit(req);
    const q = Q.byToken(req.params.token);
    if (!q) throw new HttpError(404, 'Not found');
    const b = B.byId(q.business_id);
    // A missing lead is handled downstream as missing contact details, which the page answers by
    // walking the customer back to the contact step. A flat error here would strand them instead.
    const lead = q.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', q.lead_id) : null;
    return fn(b, q, lead);
  }
  app.post('/api/public/quotes/:token/submit', (req) => quoteAction(req, async (b, q, lead) => ({ quote: Q.publicQuote(await Q.submitQuote(b, q, lead), b) })));
  app.post('/api/public/quotes/:token/contract', (req) => quoteAction(req, async (b, q, lead) => {
    const r = await Q.requestContract(b, q, lead, req.body || {});
    return { quote: Q.publicQuote(r.quote, b) };
  }));
  app.post('/api/public/quotes/:token/callback', (req) => quoteAction(req, async (b, q, lead) => ({ quote: Q.publicQuote(await Q.requestCallback(b, q, lead, req.body || {}), b) })));

  // Is the business free on a given event date? Used by the "we're available" step.
  app.get('/api/public/b/:slug/date-check', (req) => {
    const b = getBusiness(req.params.slug);
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Pick a date first.');
    const hit = db.get('SELECT note FROM blocked_dates WHERE business_id = ? AND date = ?', b.id, date);
    return { date, available: !hit, note: hit ? String(hit.note || '').slice(0, 200) : '' };
  });

  // ---------- Embed script ----------
  app.get('/embed.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.text(`(function(){var base=${JSON.stringify(baseUrl())};
function src(){try{return encodeURIComponent(location.href.slice(0,500))}catch(e){return ''}}
function stitle(){try{return encodeURIComponent((document.title||'').slice(0,120))}catch(e){return ''}}
function frame(url,el){var f=document.createElement('iframe');f.src=url+(url.indexOf('?')>-1?'&':'?')+'embed=1&src='+src()+'&stitle='+stitle();f.style.cssText='width:100%;border:0;min-height:640px;display:block;color-scheme:normal';f.setAttribute('title','${APP_NAME} booking');f.setAttribute('loading','lazy');el.appendChild(f);return f}
window.addEventListener('message',function(e){if(e.origin!==base||!e.data||e.data.type!=='booklane:height')return;var fs=document.querySelectorAll('iframe');for(var i=0;i<fs.length;i++){if(fs[i].contentWindow===e.source){fs[i].style.height=e.data.height+'px'}}});
function inline(){var els=document.querySelectorAll('[data-booklane]');for(var i=0;i<els.length;i++){var el=els[i];if(el.__bl)continue;el.__bl=1;frame(base+'/'+el.getAttribute('data-booklane').replace(/^\\//,''),el)}}
function popup(path){var o=document.createElement('div');o.style.cssText='position:fixed;inset:0;background:rgba(15,12,30,.6);z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:16px';var box=document.createElement('div');box.style.cssText='background:#fff;border-radius:16px;width:100%;max-width:980px;max-height:92vh;overflow:auto;position:relative';var x=document.createElement('button');x.innerHTML='&times;';x.setAttribute('aria-label','Close');x.style.cssText='position:absolute;top:8px;right:12px;font-size:28px;background:none;border:0;cursor:pointer;z-index:2';x.onclick=function(){o.remove()};o.onclick=function(e){if(e.target===o)o.remove()};box.appendChild(x);o.appendChild(box);document.body.appendChild(o);frame(base+'/'+path.replace(/^\\//,''),box)}
function cta(el){if(el.__bl)return;el.__bl=1;
var path=el.getAttribute('data-booklane-cta').replace(/^\\//,'');
var fieldName=el.getAttribute('data-field')||'event_date';
var label=el.getAttribute('data-label')||'';
var btn=el.getAttribute('data-button')||'Check availability';
var ph=el.getAttribute('data-placeholder')||'';
var color=el.getAttribute('data-color')||'';
var itype=/date/.test(fieldName)?'date':/phone|tel/.test(fieldName)?'tel':/email/.test(fieldName)?'email':'text';
var f=document.createElement('form');
f.style.cssText='display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;font:inherit';
var wrap=document.createElement('label');
wrap.style.cssText='display:flex;flex-direction:column;gap:4px;flex:1;min-width:180px;font:inherit';
if(label){var sp=document.createElement('span');sp.textContent=label;sp.style.cssText='font-size:14px;font-weight:600';wrap.appendChild(sp)}
var input=document.createElement('input');
input.type=itype;input.name=fieldName;input.placeholder=ph;input.required=true;
input.style.cssText='font:inherit;padding:12px 14px;border:1px solid rgba(0,0,0,.18);border-radius:10px;width:100%;box-sizing:border-box;background:#fff';
if(itype==='date'){try{input.min=new Date().toISOString().slice(0,10)}catch(e){}}
wrap.appendChild(input);
var go=document.createElement('button');
go.type='submit';go.textContent=btn;
go.style.cssText='font:inherit;font-weight:700;padding:12px 20px;border:0;border-radius:10px;cursor:pointer;color:#fff;background:'+(color||'#5b3df5');
f.appendChild(wrap);f.appendChild(go);
f.addEventListener('submit',function(e){e.preventDefault();
  var v=(input.value||'').trim();if(!v){input.focus();return}
  popup(path+(path.indexOf('?')>-1?'&':'?')+encodeURIComponent(fieldName)+'='+encodeURIComponent(v));
});
el.appendChild(f)}
function ctas(){var els=document.querySelectorAll('[data-booklane-cta]');for(var i=0;i<els.length;i++)cta(els[i])}
window.Booklane={popup:popup,inline:inline,ctas:ctas};
document.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-booklane-popup]');if(t){e.preventDefault();popup(t.getAttribute('data-booklane-popup'))}});
function init(){inline();ctas()}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();})();`, 'application/javascript; charset=utf-8');
  });
};
