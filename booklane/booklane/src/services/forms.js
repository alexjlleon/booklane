'use strict';
// Custom forms: build any flow out of ordered steps.
//
// The four step types the booking pages already had - questions, contact, a live date check, a
// calendar - plus two that let a form sell: `product` to choose options, and `payment` to charge.
//
// Money follows the order of the steps rather than a separate setting:
//   calendar ... then payment  -> hold the slot while they pay   (how a session works)
//   payment  ... then calendar -> take the money, schedule after (how an album works)
//   payment with no calendar   -> a plain purchase
//   neither                    -> the submission is just a lead
//
// Nothing here owns a calendar or a price. A schedule step names a booking page, a product step
// names a product, and this module reads them, so there is still one place to change hours and one
// place to change prices.
const db = require('../db');
const { HttpError } = require('../lib/router');
const { slugify, clampStr, int, deepMerge, money, isEmail, baseUrl } = require('../lib/util');

const STEP_TYPES = ['questions', 'contact', 'availability', 'schedule', 'product', 'payment', 'message'];
const Q_TYPES = ['text', 'textarea', 'number', 'date', 'select', 'choice', 'multi'];

const FORM_SETTINGS = {
  submit_cta: 'Submit',
  done_heading: 'Thank you',
  done_blurb: 'We have got this and will be in touch shortly.',
  redirect_url: '',
  notify: true,
};

const formSettings = (f) => deepMerge(FORM_SETTINGS, (typeof f.settings === 'string' ? db.json(f.settings, {}) : f.settings) || {});

function hydrate(f) {
  if (!f) return f;
  const parse = (v, fallback) => (typeof v === 'string' ? db.json(v, fallback) : (v ?? fallback));
  f.steps = parse(f.steps, []);
  f.settings = parse(f.settings, {});
  f.copy = formSettings(f);
  return f;
}

/**
 * Clean a step list coming from the builder. Anything unrecognised becomes a questions step rather
 * than being dropped, so a typo in the editor never silently loses someone's work.
 */
function sanitizeSteps(steps, business) {
  if (!Array.isArray(steps)) throw new HttpError(422, 'Steps must be a list', { steps: 'Expected a list' });
  const out = steps.slice(0, 20).map((s, i) => {
    const type = STEP_TYPES.includes(s.type) ? s.type : 'questions';
    const step = {
      key: slugify(s.key || s.title || `step-${i + 1}`) || `step-${i + 1}`,
      type,
      title: clampStr(s.title || '', 160),
      subtitle: clampStr(s.subtitle || '', 300),
    };
    if (type === 'message') step.body = clampStr(s.body || '', 2000);
    if (type === 'contact') {
      const f = s.fields || {};
      const mode = (v, def) => (['required', 'optional', 'hidden'].includes(v) ? v : def);
      step.fields = {
        first_name: mode(f.first_name, 'required'), last_name: mode(f.last_name, 'optional'),
        email: mode(f.email, 'required'), phone: mode(f.phone, 'optional'), sms_consent: mode(f.sms_consent, 'hidden'),
      };
      // However short the form, it has to leave some way to reach the person.
      if (step.fields.email === 'hidden' && step.fields.phone === 'hidden') step.fields.phone = 'required';
    }
    if (type === 'availability') {
      step.date_question_id = (slugify(s.date_question_id || 'event_date') || 'event_date').replace(/-/g, '_');
      step.available_text = clampStr(s.available_text || '', 300);
      step.unavailable_text = clampStr(s.unavailable_text || '', 300);
    }
    if (type === 'schedule') {
      step.event_type_id = int(s.event_type_id, 0) || null;
      if (business && step.event_type_id && !db.get('SELECT 1 FROM event_types WHERE id = ? AND business_id = ?', step.event_type_id, business.id)) step.event_type_id = null;
    }
    if (type === 'product') {
      step.product_id = int(s.product_id, 0) || null;
      if (business && step.product_id && !db.get('SELECT 1 FROM products WHERE id = ? AND business_id = ?', step.product_id, business.id)) step.product_id = null;
    }
    if (type === 'payment') {
      // Either it charges for a product chosen earlier, or it charges a fixed amount.
      step.source = s.source === 'fixed' ? 'fixed' : 'product';
      step.amount_cents = int(s.amount_cents, 0, 0, 100000000);
      step.label = clampStr(s.label || '', 160);
    }
    if (type === 'questions') {
      step.questions = (Array.isArray(s.questions) ? s.questions : []).slice(0, 20).map((q, j) => ({
        id: (slugify(q.id || q.label || `q${j + 1}`) || `q${j + 1}`).replace(/-/g, '_'),
        label: clampStr(q.label || 'Question', 200),
        type: Q_TYPES.includes(q.type) ? q.type : 'text',
        options: Array.isArray(q.options) ? q.options.map((o) => clampStr(String(o), 140)).filter(Boolean).slice(0, 40) : [],
        required: !!q.required,
        placeholder: clampStr(q.placeholder || '', 140),
        display: q.display === 'cards' ? 'cards' : 'list',
      }));
    }
    return step;
  });

  const keys = new Set();
  for (const s of out) { let k = s.key; let n = 2; while (keys.has(k)) k = `${s.key}-${n++}`; s.key = k; keys.add(k); }

  if (out.filter((s) => s.type === 'availability').length > 1) throw new HttpError(422, 'Only one date check per form', { steps: 'Two date checks' });
  if (out.filter((s) => s.type === 'schedule').length > 1) throw new HttpError(422, 'Only one calendar per form', { steps: 'Two calendars' });
  if (out.filter((s) => s.type === 'payment').length > 1) throw new HttpError(422, 'Only one payment step per form', { steps: 'Two payments' });

  const pay = out.find((s) => s.type === 'payment');
  if (pay && pay.source === 'product' && !out.some((s) => s.type === 'product')) {
    throw new HttpError(422, 'A payment step that charges for a product needs a product step before it', { steps: 'Missing product step' });
  }
  if (pay && pay.source === 'fixed' && !(pay.amount_cents > 0)) {
    throw new HttpError(422, 'Give the payment step an amount, or point it at a product', { steps: 'No amount' });
  }
  if (pay && pay.source === 'product') {
    const prodAt = out.findIndex((s) => s.type === 'product');
    const payAt = out.findIndex((s) => s.type === 'payment');
    if (prodAt > payAt) throw new HttpError(422, 'The product step has to come before the payment step', { steps: 'Product after payment' });
  }
  // Anything that takes money or books a time needs to know who the person is.
  if (out.some((s) => s.type === 'payment' || s.type === 'schedule') && !out.some((s) => s.type === 'contact')) {
    throw new HttpError(422, 'A form that books or charges needs a contact step', { steps: 'Missing contact step' });
  }
  // Holding a slot while someone pays needs the hold-and-expire machinery the sellable sessions
  // already have. Building a second implementation of that here is how double bookings happen, so
  // this refuses rather than quietly producing a form that takes money without reserving the time.
  const shape = shapeOf(out);
  if (shape.holds_slot) {
    throw new HttpError(422, 'Put the payment step before the calendar, so they pay and then pick a time. Charging after a time is picked means the slot has to be held during checkout, which is what a sellable Session already does - use one of those instead.', { steps: 'Calendar before payment' });
  }
  return out;
}

/** How this form handles money and time, worked out from the order of its steps. */
function shapeOf(steps) {
  const at = (t) => steps.findIndex((s) => s.type === t);
  const sched = at('schedule');
  const pay = at('payment');
  return {
    schedules: sched >= 0,
    charges: pay >= 0,
    // A calendar before the payment means the slot is theirs while they pay for it.
    holds_slot: sched >= 0 && pay >= 0 && sched < pay,
    schedules_after_payment: sched >= 0 && pay >= 0 && pay < sched,
    lead_only: sched < 0 && pay < 0,
  };
}

const listAll = (business) => db.all('SELECT * FROM forms WHERE business_id = ? ORDER BY sort, id', business.id).map(hydrate);

function byId(business, id) {
  const f = db.get('SELECT * FROM forms WHERE id = ? AND business_id = ?', int(id), business.id);
  if (!f) throw new HttpError(404, 'Not found');
  return hydrate(f);
}

function bySlug(business, slug) {
  const f = db.get('SELECT * FROM forms WHERE business_id = ? AND slug = ?', business.id, String(slug || ''));
  if (!f) throw new HttpError(404, 'Not found');
  if (!f.active) throw new HttpError(404, 'This form is not available right now.');
  return hydrate(f);
}

/** What the browser gets: the steps, plus enough about any referenced page or product to render. */
function publicForm(business, form) {
  const f = hydrate(form);
  const PROD = require('./products');
  const steps = f.steps.map((s) => {
    const out = Object.assign({}, s);
    if (s.type === 'schedule' && s.event_type_id) {
      const et = db.get('SELECT slug, name, duration_min, max_days_ahead FROM event_types WHERE id = ? AND active = 1', s.event_type_id);
      out.event = et ? { slug: et.slug, name: et.name, duration_min: et.duration_min, max_days_ahead: et.max_days_ahead } : null;
      delete out.event_type_id;
    }
    if (s.type === 'product' && s.product_id) {
      const p = db.get('SELECT * FROM products WHERE id = ? AND active = 1', s.product_id);
      out.product = p ? PROD.publicProduct(business, p) : null;
      delete out.product_id;
    }
    if (s.type === 'payment') out.amount_display = s.source === 'fixed' ? money(s.amount_cents / 100, 'USD') : '';
    return out;
  });
  return {
    slug: f.slug, name: f.name, description: f.description || '',
    steps, copy: f.copy, shape: shapeOf(f.steps),
  };
}

/** Check the answers a submission carries against the steps that asked for them. */
function validateAnswers(steps, body) {
  const errs = {};
  const answers = (body && typeof body.answers === 'object' && body.answers) || {};
  const contact = (body && body.contact) || {};
  for (const s of steps) {
    if (s.type === 'questions') {
      for (const q of s.questions || []) {
        if (!q.required) continue;
        const v = answers[q.id];
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
        if (empty) errs[`answers.${q.id}`] = 'Required';
      }
    }
    if (s.type === 'contact') {
      const f = s.fields || {};
      if (f.first_name === 'required' && !String(contact.first_name || '').trim()) errs['contact.first_name'] = 'Required';
      if (f.last_name === 'required' && !String(contact.last_name || '').trim()) errs['contact.last_name'] = 'Required';
      if (f.email !== 'hidden' && (f.email === 'required' || String(contact.email || '').trim())) {
        if (!isEmail(String(contact.email || '').trim())) errs['contact.email'] = 'Enter a valid email';
      }
      if (f.phone === 'required' && String(contact.phone || '').replace(/\D/g, '').length < 7) errs['contact.phone'] = 'Enter a valid phone number';
    }
  }
  if (Object.keys(errs).length) throw new HttpError(422, 'Please fix the highlighted fields', errs);
  return { answers, contact };
}

// ---------- submitting ----------

/**
 * Finish a form. What happens depends on the steps it has:
 *   nothing to book or buy -> record the lead and say thank you
 *   a calendar             -> create the booking
 *   a payment              -> hand back a Stripe Checkout URL; the booking, if any, is made on the
 *                             way back, once the money is in
 *
 * Contact details and answers are validated against the steps that asked for them, so a form that
 * never asked for a phone number is not rejected for missing one.
 */
async function submit(business, form, body = {}) {
  const f = hydrate(form);
  const { answers, contact } = validateAnswers(f.steps, body);
  const shape = shapeOf(f.steps);
  const L = require('./leads');
  const B = require('./business');

  let lead = body.lead_token ? L.byToken(body.lead_token) : null;
  if (lead && lead.business_id !== business.id) lead = null;
  if (!lead) lead = L.createLead(business, { source: 'form', meta: { form: f.slug } });
  db.run('UPDATE leads SET form_id = ? WHERE id = ?', f.id, lead.id);
  L.updateLead(lead, { contact, answers: Object.assign({ form: f.name }, answers) });

  db.run('UPDATE forms SET submissions = submissions + 1 WHERE id = ?', f.id);

  // Paying comes first whenever there is a payment step: nothing is booked on a promise.
  if (shape.charges) {
    const pay = f.steps.find((s) => s.type === 'payment');
    const PROD = require('./products');
    const stripe = require('../lib/stripe');
    if (!stripe.configured()) throw new HttpError(503, 'Card payments are not switched on yet. Please call us and we will take your order.');

    if (pay.source === 'product') {
      const prodStep = f.steps.find((s) => s.type === 'product');
      const product = db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', prodStep.product_id, business.id);
      if (!product) throw new HttpError(409, 'That product is not available any more.');
      const started = await PROD.startCheckout(business, product, {
        selection: body.selection || {},
        contact,
        lead_token: lead.token,
      });
      const sched = f.steps.find((s) => s.type === 'schedule');
      db.run('UPDATE orders SET form_id = ? WHERE token = ?', f.id, started.order_token);
      B.logActivity(business.id, lead.id, 'form', `Started checkout from ${f.name}`, { form_id: f.id });
      return Object.assign({ kind: 'checkout', schedules_after: !!sched }, started);
    }

    // A fixed amount: the figure comes from the saved step, never from the browser.
    const order = await fixedCheckout(business, f, pay, lead, contact, answers);
    B.logActivity(business.id, lead.id, 'form', `Started checkout from ${f.name}`, { form_id: f.id });
    return order;
  }

  if (shape.schedules) {
    const step = f.steps.find((s) => s.type === 'schedule');
    const row = db.get('SELECT * FROM event_types WHERE id = ? AND business_id = ? AND active = 1', step.event_type_id, business.id);
    if (!row) throw new HttpError(409, 'That calendar is not available any more.');
    const BK = require('./bookings');
    const booking = await BK.createBooking({
      business,
      et: BK.hydrateEt(row),
      startIso: String(body.start || ''),
      tz: body.timezone,
      contact,
      answers: Object.assign({ form: f.name }, answers),
      lead,
    });
    B.logActivity(business.id, lead.id, 'form', `Booked through ${f.name}`, { form_id: f.id, booking_id: booking.id });
    return { kind: 'booked', redirect: `/booking/${booking.token}` };
  }

  // Nothing to book or buy: the lead is the whole point.
  L.setStatus(lead, 'new', { complete: true });
  B.logActivity(business.id, lead.id, 'form', `Submitted ${f.name}`, { form_id: f.id });
  try { await notifyTeam(business, f, lead, contact, answers); } catch { /* the email log records it */ }
  return { kind: 'done', copy: f.copy, redirect: f.copy.redirect_url || '' };
}

/** A form that charges a set amount, with no product behind it. */
async function fixedCheckout(business, form, pay, lead, contact, answers) {
  const stripe = require('../lib/stripe');
  const { token } = require('../lib/security');
  const t = token(20);
  const label = clampStr(pay.label || form.name, 160);
  const orderId = db.run(`INSERT INTO orders (business_id, token, lead_id, form_id, order_kind, product_name, amount_cents, currency,
      status, provider, customer_name, customer_email, customer_phone, answers)
    VALUES (?,?,?,?,'product',?,?, 'USD','pending','stripe',?,?,?,?)`,
  business.id, t, lead.id, form.id, label, pay.amount_cents,
  clampStr([contact.first_name, contact.last_name].filter(Boolean).join(' '), 160),
  String(contact.email || '').trim().toLowerCase(), clampStr(contact.phone || '', 40),
  JSON.stringify(Object.assign({ form: form.name }, answers))).lastId;
  db.run('INSERT INTO order_items (order_id, kind, label, detail, unit_cents, qty, sort) VALUES (?,?,?,?,?,1,0)',
    orderId, 'product', label, '', pay.amount_cents);

  const base = baseUrl();
  try {
    const cs = await stripe.createCheckoutSession({
      amountCents: pay.amount_cents,
      productName: label,
      successUrl: `${base}/b/${business.slug}/f/${form.slug}/done?order=${t}`,
      cancelUrl: `${base}/b/${business.slug}/f/${form.slug}?cancelled=${t}`,
      customerEmail: String(contact.email || '').trim().toLowerCase() || undefined,
      clientReferenceId: t,
      metadata: { order_token: t, business: business.slug, form: form.slug },
      idempotencyKey: `form-${t}`,
    });
    db.run('UPDATE orders SET provider_session_id = ? WHERE id = ?', cs.id, orderId);
    return { kind: 'checkout', checkout_url: cs.url, order_token: t, total_cents: pay.amount_cents, schedules_after: false };
  } catch (e) {
    db.run("UPDATE orders SET status = 'failed', last_error = ? WHERE id = ?", clampStr(e.message, 300), orderId);
    throw e;
  }
}

async function notifyTeam(business, form, lead, contact, answers) {
  if (!form.copy.notify) return;
  const { sendEmail, layout, rows } = require('../lib/email');
  const B = require('./business');
  const to = B.teamEmails ? B.teamEmails(business.id) : [];
  if (!to.length) return;
  const pairs = [['Form', form.name], ['Name', [contact.first_name, contact.last_name].filter(Boolean).join(' ')], ['Email', contact.email], ['Phone', contact.phone]]
    .concat(Object.entries(answers).map(([k, v]) => [k.replace(/_/g, ' '), Array.isArray(v) ? v.join(', ') : String(v)]));
  await sendEmail({
    businessId: business.id,
    to,
    subject: `${form.name}: ${[contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'new submission'}`,
    html: layout(business, { heading: `New ${form.name} submission`, body: rows(pairs), cta: { label: 'Open the lead', url: `${baseUrl()}/app#/leads/${lead.token}` } }),
  });
}

// ---------- ready-made shapes ----------
//
// Starting points, not fixed flows: each one is written into the forms table and is then yours to
// edit. They wire themselves to whatever this business already has - a real product for the album
// one, a real booking page for the call - and say so plainly when a piece is missing, rather than
// producing a form that looks finished and cannot work.

const TEMPLATES = {
  'short-cta': {
    name: 'Quick enquiry',
    description: 'Two questions and a name. For a small button on the website.',
    build: () => ({
      steps: [
        { type: 'questions', title: 'What can we help with?', questions: [
          { id: 'interest', label: 'I am interested in', type: 'choice', display: 'cards', required: true,
            options: ['Photography', 'Videography', 'DJ and MC', 'Photo booth', 'Something else'] },
          { id: 'event_date', label: 'Event date, if you have one', type: 'date', required: false },
        ] },
        { type: 'contact', title: 'Where can we reach you?', subtitle: 'Name and email is plenty.',
          fields: { first_name: 'required', last_name: 'hidden', email: 'required', phone: 'optional', sms_consent: 'hidden' } },
      ],
      settings: { done_heading: 'Thanks, that is with us', done_blurb: 'We will come back to you shortly.' },
    }),
  },
  'sales-calendar': {
    name: 'Sales call booking',
    description: 'Date check, then a time with the sales team. For intentional visitors.',
    build: (b) => {
      const et = firstEventType(b);
      return {
        steps: [
          { type: 'questions', title: "What's your wedding date?", subtitle: 'We will check it against our calendar right now.',
            questions: [{ id: 'event_date', label: 'Event date', type: 'date', required: true }] },
          { type: 'questions', title: 'Tell us a little about the day', questions: [
            { id: 'venue', label: 'Venue or city', type: 'text', required: false, placeholder: 'e.g. The Grand Ballroom, Houston' },
            { id: 'services', label: 'What are you looking for?', type: 'multi', display: 'cards', required: false,
              options: ['Photography', 'Videography', 'DJ and MC', 'Photo booth', 'Lighting', 'Coordination'] },
            { id: 'guests', label: 'Roughly how many guests?', type: 'choice', required: false, options: ['Under 50', '50 to 100', '100 to 200', '200+'] },
          ] },
          { type: 'contact', title: 'Where can we reach you?', fields: { first_name: 'required', last_name: 'optional', email: 'required', phone: 'required', sms_consent: 'optional' } },
          { type: 'availability', title: 'Checking your date…', date_question_id: 'event_date' },
          { type: 'schedule', title: 'Pick a time for your call', subtitle: 'Fifteen minutes, no pressure.', event_type_id: et ? et.id : null },
        ],
        warnings: et ? [] : ['No booking page exists yet, so the calendar step has nothing to schedule against. Pick one on the calendar step.'],
      };
    },
  },
  'engagement-booking': {
    name: 'Engagement session booking',
    description: 'For someone whose session is already paid for: they pick a city and a time.',
    build: (b) => {
      const et = eventTypeBySlug(b, 'engagement-session') || firstEventType(b);
      return {
        steps: [
          { type: 'questions', title: 'Which city are you in?', subtitle: 'So we show you the right calendar.',
            questions: [{ id: 'city', label: 'City', type: 'choice', display: 'cards', required: true, options: marketNames(b) }] },
          { type: 'questions', title: 'Your booking number', subtitle: 'It is on your contract and your confirmation email.',
            questions: [{ id: 'booking_number', label: 'Booking number', type: 'text', required: true, placeholder: 'e.g. WU-10432' }] },
          { type: 'contact', title: 'Who are we photographing?', fields: { first_name: 'required', last_name: 'optional', email: 'required', phone: 'required', sms_consent: 'optional' } },
          { type: 'schedule', title: 'Pick your time', event_type_id: et ? et.id : null },
        ],
        warnings: et ? [] : ['No booking page exists yet for the calendar step.'],
      };
    },
  },
  'album-selling': {
    name: 'Album selling flow',
    description: 'Choose an album, pay, then book the design call.',
    build: (b) => {
      const product = db.get("SELECT * FROM products WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1", b.id);
      const et = eventTypeBySlug(b, 'photo-album') || firstEventType(b);
      return {
        steps: [
          { type: 'product', title: 'Choose your album', product_id: product ? product.id : null },
          { type: 'contact', title: 'Where should we send it?', fields: { first_name: 'required', last_name: 'optional', email: 'required', phone: 'optional', sms_consent: 'hidden' } },
          { type: 'payment', title: 'Your order', source: 'product' },
          { type: 'schedule', title: 'Book your design call', subtitle: 'Sit down with our designer and lay it out page by page.', event_type_id: et ? et.id : null },
        ],
        warnings: [product ? null : 'No product exists yet, so the album step has nothing to sell. Create one under Products first.',
          et ? null : 'No booking page exists yet for the design call.'].filter(Boolean),
      };
    },
  },
  'engagement-buy-book': {
    name: 'Engagement session, buy and book',
    description: 'Pay for the session, then pick a time.',
    build: (b) => {
      const et = eventTypeBySlug(b, 'engagement-session') || firstEventType(b);
      return {
        steps: [
          { type: 'questions', title: 'Which city are you in?', questions: [{ id: 'city', label: 'City', type: 'choice', display: 'cards', required: true, options: marketNames(b) }] },
          { type: 'contact', title: 'Who are we photographing?', fields: { first_name: 'required', last_name: 'optional', email: 'required', phone: 'required', sms_consent: 'optional' } },
          { type: 'payment', title: 'Your session', source: 'fixed', amount_cents: 49500, label: 'Engagement Session' },
          { type: 'schedule', title: 'Pick your time', event_type_id: et ? et.id : null },
        ],
        warnings: ['This charges first and books afterwards. If you would rather hold the slot while they pay, use the sellable Session instead - that is what it is built for.']
          .concat(et ? [] : ['No booking page exists yet for the calendar step.']),
      };
    },
  },
};

const firstEventType = (b) => db.get("SELECT * FROM event_types WHERE business_id = ? AND active = 1 AND kind = 'call' ORDER BY sort, id LIMIT 1", b.id)
  || db.get('SELECT * FROM event_types WHERE business_id = ? AND active = 1 ORDER BY sort, id LIMIT 1', b.id);
const eventTypeBySlug = (b, slug) => db.get('SELECT * FROM event_types WHERE business_id = ? AND slug = ? AND active = 1', b.id, slug);
function marketNames(b) {
  const rows = db.all("SELECT name FROM calendar_profiles WHERE business_id = ? AND kind = 'market' AND active = 1 ORDER BY sort, id", b.id);
  return rows.length ? rows.map((r) => r.name) : ['Houston', 'Austin', 'San Antonio', 'Dallas / Fort Worth', 'Phoenix'];
}

const templateList = () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description }));

function buildTemplate(business, id) {
  const t = TEMPLATES[id];
  if (!t) throw new HttpError(404, 'No such template');
  const built = t.build(business) || {};
  return {
    name: t.name, slug: id, description: t.description,
    steps: built.steps || [], settings: built.settings || {}, warnings: built.warnings || [],
  };
}

module.exports = {
  STEP_TYPES, Q_TYPES, FORM_SETTINGS, hydrate, sanitizeSteps, shapeOf,
  listAll, byId, bySlug, publicForm, validateAnswers, formSettings, submit,
  templateList, buildTemplate, TEMPLATES,
};
