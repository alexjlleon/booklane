'use strict';
// Seeds a demo business so you can click through everything. Safe to run once; skips if the slug exists.
const db = require('../src/db');
const { hashPassword, token } = require('../src/lib/security');
const { createBusiness } = require('../src/services/setup');

const EMAIL = (process.env.SEED_EMAIL || 'owner@example.com').toLowerCase();
const PASSWORD = process.env.SEED_PASSWORD || token(9);
const NAME = process.env.SEED_BUSINESS || 'Weddings Unlimited';

if (db.get('SELECT 1 FROM businesses WHERE name = ?', NAME)) { console.log(`"${NAME}" already exists, nothing to do.`); process.exit(0); }

let owner = db.get('SELECT * FROM users WHERE email = ?', EMAIL);
let createdPassword = null;
if (!owner) {
  const id = db.run('INSERT INTO users (email, name, password_hash, timezone, is_super_admin) VALUES (?,?,?,?,1)', EMAIL, process.env.SEED_NAME || 'Alex', hashPassword(PASSWORD), 'America/Chicago').lastId;
  owner = db.get('SELECT * FROM users WHERE id = ?', id);
  createdPassword = PASSWORD;
}
const b = createBusiness({ name: NAME, timezone: 'America/Chicago', email: EMAIL, ownerId: owner.id, withDefaults: false });

// Second host to demo round robin
const hostEmail = `planner+${b.slug}@example.com`;
let host = db.get('SELECT * FROM users WHERE email = ?', hostEmail);
if (!host) host = db.get('SELECT * FROM users WHERE id = ?', db.run('INSERT INTO users (email, name, password_hash, timezone) VALUES (?,?,?,?)', hostEmail, 'Sample Planner', hashPassword(token(12)), 'America/Chicago').lastId);
db.run('INSERT OR IGNORE INTO memberships (user_id, business_id, role) VALUES (?,?,?)', host.id, b.id, 'host');
if (!db.get('SELECT 1 FROM availability_rules WHERE user_id = ?', host.id)) for (const wd of [2, 3, 4, 5, 6]) db.run('INSERT INTO availability_rules (user_id, weekday, start_min, end_min) VALUES (?,?,?,?)', host.id, wd, 10 * 60, 18 * 60);

const settings = {
  tagline: 'Book a quick call with our team or build your own quote. No hidden fees, ever.',
  urgency_text: 'Only a few call spots left this week',
  trust_points: ['Instant confirmation', 'No pressure, just answers', 'Your info is safe with us'],
  notifications: { team_emails: [EMAIL] },
  leads: { abandoned_after_min: 20, send_recovery_email: true, recovery_delay_min: 60 },
  quote: {
    title: 'Build your wedding quote',
    intro: 'Choose your services, packages and extras. Your price updates live. Transparent pricing, no hidden fees.',
    event_types: ['Wedding', 'Quinceañera', 'Corporate event', 'Birthday / Celebration', 'Other'],
    cities: ['Houston', 'Dallas / Fort Worth', 'Austin', 'San Antonio', 'Beaumont', 'Hill Country', 'Phoenix'],
    guest_ranges: ['Under 75', '75-150', '150-250', '250+'],
    bundle_discounts: [{ min_services: 2, percent: 5, label: 'Bundle & save 5%' }, { min_services: 3, percent: 10, label: 'Bundle & save 10%' }],
    tax_rate: 0, deposit_type: 'percent', deposit_value: 30,
  },
};
db.run('UPDATE businesses SET settings = ?, brand_color = ?, phone = ?, website = ? WHERE id = ?', JSON.stringify(settings), '#b0476b', '(555) 010-0100', 'https://example.com', b.id);

const steps = [
  { key: 'schedule', type: 'schedule', title: 'Pick a time for your free call', subtitle: '20 minutes. We call you.' },
  { key: 'contact', type: 'contact', title: 'Who are we talking to?', subtitle: 'So we can confirm your call and text a reminder.', fields: { first_name: 'required', last_name: 'required', email: 'required', phone: 'required', sms_consent: 'optional' } },
  { key: 'interests', type: 'questions', title: 'What are you interested in?', subtitle: 'Pick all that apply.', questions: [{ id: 'services', label: 'Services', type: 'multi', options: ['Not sure yet'], use_services: true, display: 'cards', required: false }] },
  { key: 'event', type: 'questions', title: 'Tell us about your day', subtitle: 'All optional, but it helps us prep.', questions: [
    { id: 'event_type', label: 'Type of event', type: 'choice', options: ['Wedding', 'Quinceañera', 'Corporate', 'Celebration', 'Other'], display: 'cards', required: false },
    { id: 'event_date', label: 'Event date', type: 'date', required: false },
    { id: 'venue', label: 'Venue or city', type: 'text', placeholder: 'e.g. The Grand Hall, Houston', required: false },
    { id: 'notes', label: 'Anything else?', type: 'textarea', required: false },
  ] },
];
const et1 = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, location_type, min_notice_min, slot_interval_min, max_days_ahead, steps, color, sort)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, b.id, 'discovery-call', 'Free discovery call', 'A relaxed 20 minute call to talk through your date, your vision and what it costs.', 20, 'phone', 180, 20, 45, JSON.stringify(steps), '#b0476b', 1).lastId;
const et2 = db.run(`INSERT INTO event_types (business_id, slug, name, description, duration_min, location_type, min_notice_min, slot_interval_min, max_days_ahead, steps, color, sort, buffer_after)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.id, 'quote-review', 'Quote review call', 'Walk through your custom quote with a planner and lock in your date.', 30, 'google_meet', 240, 30, 60,
JSON.stringify([steps[0], steps[1], { key: 'notes', type: 'questions', title: 'Anything you want to cover?', subtitle: '', questions: [{ id: 'notes', label: 'Questions for us', type: 'textarea', required: false }] }]), '#3d6b8f', 2, 15).lastId;
for (const et of [et1, et2]) for (const u of [owner.id, host.id]) db.run('INSERT INTO event_type_hosts (event_type_id, user_id) VALUES (?,?)', et, u);
db.run("UPDATE businesses SET settings = json_set(settings, '$.quote.call_event_type_id', ?) WHERE id = ?", et2, b.id);

const svc = (o) => db.run(`INSERT INTO services (business_id, category, name, description, pricing_type, base_price, unit_label, min_qty, max_qty, default_qty, option_groups, addons, badge, sort)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, b.id, o.category, o.name, o.description, o.pricing_type || 'flat', o.base_price || 0, o.unit_label || null, o.min_qty || 1, o.max_qty || 1, o.default_qty || 1,
JSON.stringify(o.option_groups || []), JSON.stringify(o.addons || []), o.badge || null, o.sort);

svc({ sort: 1, category: 'Entertainment', name: 'DJ & MC', badge: 'Most popular', description: 'Professional DJ and MC who runs your timeline, announcements and dance floor. Unlimited hours.',
  option_groups: [{ id: 'package', name: 'Package', mode: 'base', required: true, choices: [
    { id: 'essential', name: 'Essential', price: 1495, description: 'DJ/MC, ceremony + reception sound, wireless mics', default: true },
    { id: 'signature', name: 'Signature', price: 1995, description: 'Everything in Essential + dance floor lighting + planning meeting' },
    { id: 'luxe', name: 'Luxe', price: 2695, description: 'Everything in Signature + second DJ for cocktail hour' }] }],
  addons: [{ id: 'ceremony_sound', name: 'Separate ceremony location sound', price: 250, max: 1 }, { id: 'live_mix', name: 'Live musician add-on (sax or violin)', price: 650, max: 1 }] });
svc({ sort: 2, category: 'Photo & Video', name: 'Photography', description: 'Documentary style coverage with an online gallery. Unlimited hours, no overtime fees.',
  option_groups: [{ id: 'package', name: 'Package', mode: 'base', required: true, choices: [
    { id: 'one', name: 'One photographer', price: 2195, default: true }, { id: 'two', name: 'Two photographers', price: 2895 }] }],
  addons: [{ id: 'engagement', name: 'Engagement session', price: 395, max: 1 }, { id: 'album', name: 'Heirloom album', price: 695, max: 3 }] });
svc({ sort: 3, category: 'Photo & Video', name: 'Videography', description: 'Cinematic highlight film plus full ceremony and speeches.',
  option_groups: [{ id: 'package', name: 'Package', mode: 'base', required: true, choices: [{ id: 'highlight', name: 'Highlight film', price: 2195, default: true }, { id: 'feature', name: 'Highlight + feature film', price: 2995 }] }],
  addons: [{ id: 'drone', name: 'Drone footage', price: 350, max: 1 }, { id: 'raw', name: 'Raw footage delivery', price: 250, max: 1 }] });
svc({ sort: 4, category: 'Photo booths', name: 'Photo booth', description: 'Unlimited prints, digital sharing and a custom print design.',
  option_groups: [{ id: 'style', name: 'Booth style', mode: 'base', required: true, choices: [{ id: 'open', name: 'Open-air booth', price: 895, default: true }, { id: '360', name: '360 video booth', price: 1195 }, { id: 'glam', name: 'Black & white glam booth', price: 1295 }] }],
  addons: [{ id: 'guestbook', name: 'Scrapbook guest book + attendant', price: 195, max: 1 }, { id: 'props', name: 'Premium props package', price: 125, max: 1 }] });
svc({ sort: 5, category: 'Special FX & lighting', name: 'Uplighting', pricing_type: 'per_unit', base_price: 35, unit_label: 'lights', min_qty: 8, max_qty: 60, default_qty: 16, description: 'Wireless LED uplights in any color to transform your room.',
  addons: [{ id: 'monogram', name: 'Custom monogram projection', price: 295, max: 1 }] });
svc({ sort: 6, category: 'Special FX & lighting', name: 'Special FX moments', description: 'Make your first dance and grand exit unforgettable.',
  option_groups: [{ id: 'fx', name: 'Effects', mode: 'add', multi: true, required: false, choices: [{ id: 'clouds', name: 'Dancing on the clouds', price: 495 }, { id: 'sparks', name: 'Cold spark fountains (pair)', price: 595 }, { id: 'confetti', name: 'Confetti cannons', price: 295 }] }] });
svc({ sort: 7, category: 'Planning', name: 'Day-of coordination', description: 'A coordinator runs your timeline, vendors and ceremony so you can be present.',
  option_groups: [{ id: 'level', name: 'Coverage', mode: 'base', required: true, choices: [{ id: 'day', name: 'Day-of', price: 995, default: true }, { id: 'month', name: 'Month-of', price: 1595 }] }] });

console.log(`\nSeeded "${NAME}" → /b/${b.slug}`);
console.log(`Owner login: ${EMAIL}${createdPassword ? `  password: ${createdPassword}` : ' (existing user, password unchanged)'}`);
console.log('Note: service prices are sample placeholders. Edit them under Quote catalog.\n');
