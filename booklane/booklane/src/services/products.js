'use strict';
// Purchasable products: something bought outright, then scheduled afterwards.
//
// A session is the other way round - you pick a time, and the slot is held while you pay. An album
// has no slot to hold: you buy it, and only then sit down with a designer. So a product order is
// paid first and scheduled second, and the two flows stay separate rather than one growing a flag.
//
// Products live in their own table rather than in `services`. The price-sheet importer deactivates
// any service missing from the uploaded sheet, so an album parked there would switch itself off the
// first time Alex imported a spreadsheet.
//
// Three shapes do the work:
//   1. option_groups - pick exactly one choice, and the choice can carry a price. The two albums are
//      two choices of one group, which is why they share a page. A group may name the choices it
//      `applies_to`, so the cover choice only appears once the 10x10 is picked.
//   2. addons - pick as many as you like, each with its own quantity.
//   3. followup_event_type_id - the booking page offered once the money is in.
const db = require('../db');
const { token } = require('../lib/security');
const { HttpError } = require('../lib/router');
const { slugify, clampStr, int, baseUrl, deepMerge, money, isEmail } = require('../lib/util');
const stripe = require('../lib/stripe');
const B = require('./business');
const L = require('./leads');

const PRODUCT_SETTINGS = {
  headline: '',
  choose_label: 'Choose your album',
  addons_label: 'Add anything else you would like',
  addons_hint: 'Optional. Your designer can talk you through these on the call.',
  qty_label: 'How many copies?',
  pay_cta: 'Pay and book the design call',
  paid_heading: 'Thank you, that is paid for',
  paid_blurb: 'Now pick a time with the design team and we will start laying out your album.',
  schedule_cta: 'Pick a time',
  skip_label: 'I will schedule later',
  skipped_blurb: 'No rush. The link in your confirmation email opens this page again whenever you are ready.',
};

const productSettings = (p) => deepMerge(PRODUCT_SETTINGS, (typeof p.settings === 'string' ? db.json(p.settings, {}) : p.settings) || {});

// Idempotent, like the session hydrator: rows arrive both straight from SQLite (JSON strings) and
// already parsed, and re-parsing an object would quietly blank every price.
function hydrate(p) {
  if (!p) return p;
  const parse = (v, fallback) => (typeof v === 'string' ? db.json(v, fallback) : (v ?? fallback));
  p.option_groups = parse(p.option_groups, []);
  p.addons = parse(p.addons, []);
  p.price_rules = parse(p.price_rules, []);
  p.settings = parse(p.settings, {});
  p.copy = productSettings(p);
  return p;
}

const listAll = (business) => db.all('SELECT * FROM products WHERE business_id = ? ORDER BY sort, id', business.id).map(hydrate);
const listActive = (business) => db.all('SELECT * FROM products WHERE business_id = ? AND active = 1 ORDER BY sort, id', business.id).map(hydrate);

function byId(business, id) {
  const p = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', int(id), business.id);
  if (!p) throw new HttpError(404, 'Not found');
  return hydrate(p);
}

function bySlug(business, slug) {
  const p = db.get('SELECT * FROM products WHERE business_id = ? AND slug = ?', business.id, String(slug || ''));
  if (!p) throw new HttpError(404, 'Not found');
  if (!p.active) throw new HttpError(404, 'This is not available right now.');
  return hydrate(p);
}

/** Does this group apply, given the choices picked so far? */
function groupApplies(group, chosenChoiceIds) {
  const gate = Array.isArray(group.applies_to) ? group.applies_to.filter(Boolean) : [];
  if (!gate.length) return true;
  return gate.some((id) => chosenChoiceIds.has(String(id)));
}

/**
 * Find the rule that fits the picked choices best.
 *
 * A rule is `{ when: { size: 'sq-8x8', cover: 'velvet' }, price_cents }`. It matches only if every
 * key it names was picked, and the most specific match wins, so a general rule can set a size's
 * price and a narrower one can override a single cover. Returns null when nothing matches, which
 * the caller must treat as "we cannot price this", never as free.
 */
function matchRule(rules, picks) {
  let best = null; let bestKeys = -1;
  for (const r of Array.isArray(rules) ? rules : []) {
    const when = (r && r.when && typeof r.when === 'object') ? r.when : {};
    const keys = Object.keys(when);
    let ok = true;
    for (const k of keys) if (String(picks[k] ?? '') !== String(when[k])) { ok = false; break; }
    if (!ok) continue;
    if (keys.length > bestKeys) { best = r; bestKeys = keys.length; }
  }
  return best;
}

/**
 * Price a selection from the database. The browser sends ids and quantities only - never money -
 * and every figure below comes from the product row, so editing a price in the page buys nothing.
 *
 * Returns { lines, total_cents, chosen } and throws 422 with field errors when a required choice is
 * missing or an id does not belong to this product.
 */
function priceSelection(product, selection = {}) {
  const p = hydrate(product);
  const errs = {};
  const wantOptions = (selection && typeof selection.options === 'object' && selection.options) || {};
  const wantAddons = (selection && typeof selection.addons === 'object' && selection.addons) || {};

  const minQty = Math.max(1, int(p.min_qty, 1));
  const maxQty = Math.max(minQty, int(p.max_qty, 10));
  let qty = int(selection.qty, int(p.default_qty, 1));
  if (qty < minQty || qty > maxQty) errs.qty = `Choose between ${minQty} and ${maxQty}.`;
  qty = Math.min(maxQty, Math.max(minQty, qty));

  // Groups are resolved in order, so a conditional group may only gate on a group above it.
  const chosenIds = new Set();
  const chosen = [];
  let unitCents = Math.max(0, int(p.base_cents, 0));

  for (const group of p.option_groups) {
    if (!group || !group.id) continue;
    const applies = groupApplies(group, chosenIds);
    const picked = wantOptions[group.id];
    if (!applies) {
      // A choice for a group that does not apply is ignored rather than rejected: they may have
      // picked the 10x10, chosen a cover, then changed to the 8x8 without the page clearing it.
      continue;
    }
    if (picked === undefined || picked === null || picked === '') {
      if (group.required !== false) errs[`options.${group.id}`] = 'Please choose one.';
      continue;
    }
    const choice = (group.choices || []).find((c) => c && String(c.id) === String(picked));
    if (!choice) { errs[`options.${group.id}`] = 'That choice is not available.'; continue; }
    chosenIds.add(String(choice.id));
    unitCents += Math.max(0, int(choice.price_cents, 0));
    chosen.push({ group: group.id, group_label: group.label || '', choice: String(choice.id), label: choice.label || '', price_cents: Math.max(0, int(choice.price_cents, 0)) });
  }

  // Report a missing or bogus choice before trying to price the combination, or "you forgot the
  // cover" would surface as the far more alarming "we cannot price that".
  if (Object.keys(errs).length) throw new HttpError(422, 'Please fix the highlighted fields', errs);

  // A product with a rule table is priced by the combination; one without keeps the simpler
  // behaviour of adding up whatever the individual choices cost.
  const picks = {};
  for (const c of chosen) picks[c.group] = c.choice;
  if ((p.price_rules || []).length) {
    const rule = matchRule(p.price_rules, picks);
    if (!rule) throw new HttpError(409, 'We do not have a price for that combination yet. Please call us and we will sort it out.');
    unitCents = Math.max(0, int(rule.price_cents, 0)) + Math.max(0, int(p.base_cents, 0));
  }

  const lines = [];
  const detail = chosen.filter((c) => c.label).map((c) => c.label).join(' / ');
  lines.push({ kind: 'product', product_id: p.id, label: p.name, detail, unit_cents: unitCents, qty });

  for (const addon of p.addons) {
    if (!addon || !addon.id) continue;
    const raw = wantAddons[addon.id];
    if (raw === undefined || raw === null || raw === '' || raw === false) continue;
    const cap = Math.max(1, int(addon.max_qty, 1));
    let n = raw === true ? 1 : int(raw, 0);
    if (n <= 0) continue;
    if (n > cap) { errs[`addons.${addon.id}`] = `Up to ${cap}.`; n = cap; }
    let unit = Math.max(0, int(addon.price_cents, 0));
    if ((addon.price_rules || []).length) {
      const rule = matchRule(addon.price_rules, picks);
      if (!rule) { errs[`addons.${addon.id}`] = 'Not available for that album.'; continue; }
      unit = Math.max(0, int(rule.price_cents, 0));
    }
    // An extra spread is physically in every copy of the album, so it multiplies with the order
    // quantity. A one-off extra (a rush fee, say) does not, which is what per_unit distinguishes.
    const perUnit = addon.per_unit !== false && !!addon.per_unit;
    const lineQty = perUnit ? n * qty : n;
    const detail = [clampStr(addon.unit_label || '', 60), perUnit && qty > 1 ? `${n} per album` : ''].filter(Boolean).join(' · ');
    lines.push({ kind: 'addon', product_id: p.id, addon_id: String(addon.id), label: addon.label || 'Extra', detail, unit_cents: unit, qty: lineQty });
  }

  if (Object.keys(errs).length) throw new HttpError(422, 'Please fix the highlighted fields', errs);

  const total = lines.reduce((sum, l) => sum + l.unit_cents * l.qty, 0);
  if (total <= 0) throw new HttpError(409, 'Nothing to pay for yet.');
  return { lines, total_cents: total, chosen, qty };
}

/** What the browser is allowed to know. Prices are here because they are on the page anyway. */
function publicProduct(business, p) {
  const x = hydrate(p);
  const c = x.copy;
  return {
    slug: x.slug,
    name: x.name,
    description: x.description || '',
    image_url: x.image_url || '',
    currency: x.currency,
    base_cents: x.base_cents,
    min_qty: Math.max(1, int(x.min_qty, 1)),
    max_qty: Math.max(1, int(x.max_qty, 10)),
    default_qty: Math.max(1, int(x.default_qty, 1)),
    option_groups: (x.option_groups || []).map((g) => ({
      id: g.id, label: g.label || '', hint: g.hint || '',
      required: g.required !== false,
      applies_to: Array.isArray(g.applies_to) ? g.applies_to : [],
      layout: g.layout === 'cards' || g.layout === 'swatches' ? g.layout : 'list',
      choices: (g.choices || []).map((ch) => ({ id: ch.id, label: ch.label || '', hint: ch.hint || '', image_url: ch.image_url || '', price_cents: Math.max(0, int(ch.price_cents, 0)) })),
    })),
    addons: (x.addons || []).map((a) => ({
      id: a.id, label: a.label || '', hint: a.hint || '',
      price_cents: Math.max(0, int(a.price_cents, 0)),
      max_qty: Math.max(1, int(a.max_qty, 1)),
      unit_label: a.unit_label || '',
      per_unit: !!a.per_unit,
      ui: a.ui === 'stepper' ? 'stepper' : 'check',
      price_rules: (a.price_rules || []).map((r) => ({ when: r.when || {}, price_cents: Math.max(0, int(r.price_cents, 0)) })),
    })),
    price_rules: (x.price_rules || []).map((r) => ({ when: r.when || {}, price_cents: Math.max(0, int(r.price_cents, 0)) })),
    base_pages: int((x.settings || {}).base_pages, 0, 0, 500),
    payments_ready: stripe.configured(),
    schedules_after: !!x.followup_event_type_id,
    copy: c,
  };
}

// ---------- buying ----------

const itemsFor = (orderId) => db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort, id', orderId);

function contactFrom(body) {
  const c = (body && body.contact) || {};
  const first = clampStr(c.first_name, 80);
  const last = clampStr(c.last_name, 80);
  const email = String(c.email || '').trim().toLowerCase();
  const phone = clampStr(c.phone, 40);
  const errs = {};
  if (!first) errs['contact.first_name'] = 'Required';
  if (!isEmail(email)) errs['contact.email'] = 'Enter a valid email';
  if (Object.keys(errs).length) throw new HttpError(422, 'Please fix the highlighted fields', errs);
  return { first_name: first, last_name: last, email, phone };
}

/**
 * Take payment for a cart. The order and its lines are written first so a webhook that arrives
 * before Stripe's reply still finds something to attach to, and the amount stored is the one this
 * function computed, not one the browser offered.
 */
async function startCheckout(business, product, body = {}) {
  const p = hydrate(product);
  const priced = priceSelection(p, body.selection || {});
  if (!stripe.configured()) throw new HttpError(503, 'Card payments are not switched on yet. Please call us and we will take your order.');
  const contact = contactFrom(body);

  let lead = body.lead_token ? L.byToken(body.lead_token) : null;
  if (lead && lead.business_id !== business.id) lead = null;
  if (!lead) lead = L.createLead(business, { source: 'product', meta: { product: p.slug } });

  const t = token(20);
  const summary = priced.lines.length > 1 ? `${p.name} + ${priced.lines.length - 1} extra${priced.lines.length > 2 ? 's' : ''}` : p.name;
  const answers = { product: p.name, options: priced.chosen.map((c) => `${c.group_label}: ${c.label}`).join(' | ') };

  const orderId = db.tx(() => {
    const id = db.run(`INSERT INTO orders (business_id, token, lead_id, product_id, order_kind, product_name,
        amount_cents, currency, status, provider, customer_name, customer_email, customer_phone, answers)
      VALUES (?,?,?,?,'product',?,?,?,'pending','stripe',?,?,?,?)`,
    business.id, t, lead.id, p.id, clampStr(summary, 160), priced.total_cents, p.currency,
    clampStr([contact.first_name, contact.last_name].filter(Boolean).join(' '), 160), contact.email, contact.phone,
    JSON.stringify(answers)).lastId;
    priced.lines.forEach((l, i) => db.run(
      'INSERT INTO order_items (order_id, product_id, kind, label, detail, unit_cents, qty, sort) VALUES (?,?,?,?,?,?,?,?)',
      id, p.id, l.kind, clampStr(l.label, 200), clampStr(l.detail || '', 300), l.unit_cents, l.qty, i));
    return id;
  });

  const base = baseUrl();
  try {
    const cs = await stripe.createCheckoutSession({
      items: priced.lines,
      currency: p.currency,
      description: summary,
      successUrl: `${base}/b/${business.slug}/p/${p.slug}/done?order=${t}`,
      cancelUrl: `${base}/b/${business.slug}/p/${p.slug}?cancelled=${t}`,
      customerEmail: contact.email,
      clientReferenceId: t,
      metadata: { order_token: t, business: business.slug, product: p.slug },
      idempotencyKey: `order-${t}`,
    });
    db.run('UPDATE orders SET provider_session_id = ? WHERE id = ?', cs.id, orderId);
    return { checkout_url: cs.url, order_token: t, total_cents: priced.total_cents };
  } catch (e) {
    db.run("UPDATE orders SET status = 'failed', last_error = ? WHERE id = ?", clampStr(e.message, 300), orderId);
    throw e;
  }
}

const orderByToken = (t) => db.get('SELECT * FROM orders WHERE token = ?', String(t || ''));
const orderByScheduleToken = (t) => db.get("SELECT * FROM orders WHERE schedule_token = ? AND order_kind = 'product'", String(t || ''));

/**
 * Money is in. Unlike a session there is no slot to confirm, so this only records the payment and
 * hands back a scheduling link. Written with a guarded UPDATE so a duplicate webhook cannot send a
 * second confirmation email.
 */
async function markPaid(order, { paymentIntent, receiptUrl, amountPaidCents } = {}) {
  const fresh = db.get('SELECT * FROM orders WHERE id = ?', order.id);
  if (!fresh) return null;
  const sched = fresh.schedule_token || token(20);
  const claimed = db.run(`UPDATE orders SET status = 'paid', paid_at = COALESCE(paid_at, datetime('now')),
      schedule_token = COALESCE(schedule_token, ?),
      provider_payment_intent = COALESCE(?, provider_payment_intent),
      provider_receipt_url = COALESCE(?, provider_receipt_url)
    WHERE id = ? AND status IN ('pending','paid')`,
  sched, paymentIntent || null, receiptUrl || null, fresh.id);

  const business = B.byId(fresh.business_id);
  if (Number.isFinite(amountPaidCents) && amountPaidCents !== fresh.amount_cents) {
    // Never silently accept a different figure: record it so it shows on the order.
    db.run("UPDATE orders SET last_error = ? WHERE id = ?", `Paid ${money(amountPaidCents / 100, fresh.currency)} against ${money(fresh.amount_cents / 100, fresh.currency)}`, fresh.id);
  }
  if (!claimed.changes) return db.get('SELECT * FROM orders WHERE id = ?', fresh.id);

  const after = db.get('SELECT * FROM orders WHERE id = ?', fresh.id);
  B.logActivity(business.id, after.lead_id, 'order', `Paid ${money(after.amount_cents / 100, after.currency)} for ${after.product_name}`, { order_id: after.id });
  try { await sendPaidEmail(business, after); } catch { /* the email log records the failure */ }
  return after;
}

async function sendPaidEmail(business, order) {
  const { sendEmail, layout, rows } = require('../lib/email');
  const p = order.product_id ? db.get('SELECT * FROM products WHERE id = ?', order.product_id) : null;
  const copy = p ? productSettings(p) : PRODUCT_SETTINGS;
  const items = itemsFor(order.id);
  const table = rows(items.map((i) => [
    `${i.label}${i.detail ? ` (${i.detail})` : ''}${i.qty > 1 ? ` x${i.qty}` : ''}`,
    money((i.unit_cents * i.qty) / 100, order.currency),
  ]).concat([['Total', money(order.amount_cents / 100, order.currency)]]));
  const link = `${baseUrl()}/b/${business.slug}/schedule/${order.schedule_token}`;
  const needsCall = !order.booking_id && !!(p && p.followup_event_type_id);
  await sendEmail({
    businessId: business.id,
    to: order.customer_email,
    subject: `${order.product_name} - order confirmed`,
    html: layout(business, {
      heading: copy.paid_heading,
      body: `<p>${needsCall ? copy.paid_blurb : 'We have your order and will be in touch.'}</p>${table}`,
      cta: needsCall ? { label: copy.schedule_cta, url: link } : null,
      footer: needsCall ? 'This link stays valid, so you can pick a time whenever suits you.' : '',
    }),
  });
}

/** Ask Stripe directly on the return page, because the webhook can lag a second or two. */
async function reconcile(order) {
  let o = db.get('SELECT * FROM orders WHERE id = ?', order.id);
  if (o.status === 'pending' && o.provider_session_id && stripe.configured()) {
    try {
      const cs = await stripe.retrieveCheckoutSession(o.provider_session_id);
      if (cs && (cs.payment_status === 'paid' || cs.payment_status === 'no_payment_required')) {
        const pi = typeof cs.payment_intent === 'string' ? cs.payment_intent : cs.payment_intent?.id;
        o = (await markPaid(o, { paymentIntent: pi, amountPaidCents: cs.amount_total })) || o;
      }
    } catch { /* leave it pending; the webhook is the source of truth */ }
  }
  return o;
}

/** Everything the return page and the scheduling page are allowed to show. */
function publicOrder(business, order) {
  const p = order.product_id ? hydrate(db.get('SELECT * FROM products WHERE id = ?', order.product_id)) : null;
  const booking = order.booking_id ? db.get('SELECT * FROM bookings WHERE id = ?', order.booking_id) : null;
  const et = p && p.followup_event_type_id ? db.get('SELECT * FROM event_types WHERE id = ? AND active = 1', p.followup_event_type_id) : null;
  return {
    token: order.token,
    status: order.status,
    paid: order.status === 'paid' || order.status === 'refunded',
    product_name: order.product_name,
    amount_display: money(order.amount_cents / 100, order.currency),
    items: itemsFor(order.id).map((i) => ({ label: i.label, detail: i.detail, qty: i.qty, line_display: money((i.unit_cents * i.qty) / 100, order.currency) })),
    customer_name: order.customer_name,
    schedule_token: order.status === 'paid' ? order.schedule_token : null,
    followup: et ? { slug: et.slug, name: et.name, duration_min: et.duration_min } : null,
    booking: booking ? { token: booking.token, start_utc: booking.start_utc, timezone: booking.invitee_tz } : null,
    copy: p ? p.copy : PRODUCT_SETTINGS,
  };
}

/**
 * Book the follow-up call against a paid order. Refuses unless the money is in, so the scheduling
 * link cannot be used as a free booking form for the designer's diary.
 */
async function scheduleFollowup(business, order, body = {}) {
  if (!(order.status === 'paid' || order.status === 'refunded')) throw new HttpError(409, 'That order has not been paid for yet.');
  if (order.booking_id) throw new HttpError(409, 'That call is already booked.');
  const p = order.product_id ? hydrate(db.get('SELECT * FROM products WHERE id = ?', order.product_id)) : null;
  if (!p || !p.followup_event_type_id) throw new HttpError(409, 'There is nothing to schedule for this order.');
  const row = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ? AND active = 1', p.followup_event_type_id, business.id);
  if (!row) throw new HttpError(404, 'That booking page is not available.');
  // createBooking expects parsed steps/settings, and rows out of SQLite carry JSON strings.
  const et = Object.assign({}, row, { steps: db.json(row.steps, []), settings: db.json(row.settings, {}) });

  const BK = require('./bookings');
  const [first = '', ...rest] = String(order.customer_name || '').split(' ');
  const contact = {
    first_name: first || 'Customer',
    last_name: rest.join(' '),
    email: order.customer_email,
    phone: order.customer_phone || '',
  };
  const answers = Object.assign(db.json(order.answers, {}), { order: order.token, paid: money(order.amount_cents / 100, order.currency) });
  const booking = await BK.createBooking({
    business,
    et,
    startIso: String(body.start || ''),
    tz: body.timezone,
    contact,
    answers,
    lead: order.lead_id ? db.get('SELECT * FROM leads WHERE id = ?', order.lead_id) : null,
  });
  db.run('UPDATE orders SET booking_id = ? WHERE id = ?', booking.id, order.id);
  B.logActivity(business.id, order.lead_id, 'booking', `Design call booked for ${order.product_name}`, { order_id: order.id, booking_id: booking.id });
  return publicOrder(business, db.get('SELECT * FROM orders WHERE id = ?', order.id));
}

module.exports = {
  PRODUCT_SETTINGS, hydrate, matchRule, listAll, listActive, byId, bySlug, priceSelection, publicProduct,
  groupApplies, productSettings, startCheckout, markPaid, reconcile, publicOrder, scheduleFollowup,
  orderByToken, orderByScheduleToken, itemsFor,
};
