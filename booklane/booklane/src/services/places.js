'use strict';
/**
 * The ways a customer may choose to meet on one booking page.
 *
 * A discovery call can be a phone call or a Zoom, and the customer knows which they want better
 * than we do. The page keeps a list; the one they pick decides what goes on the calendar invite,
 * what the confirmation says, and whether a Teams or Meet link gets created.
 *
 * A page that offers one way is the same thing with a list of one, so the single location_type
 * every page had before this existed keeps working untouched and needs no migration.
 */
const { LOCATION_TYPES } = require('../defaults');
const { clampStr, slugify } = require('../lib/util');

const typeOf = (t) => (LOCATION_TYPES[t] ? t : 'phone');
// Only these carry an address or a link; a phone call has nothing to put there, and a Meet or
// Teams link is created per booking rather than typed in once.
const NEEDS_VALUE = new Set(['in_person', 'custom', 'zoom']);

function conform(raw, i) {
  const type = typeOf(raw && raw.type);
  const label = clampStr(raw && raw.label, 80) || '';
  return {
    id: (slugify(clampStr(raw && raw.id, 40) || label || type) || `place_${i}`).slice(0, 40),
    type,
    label: label || LOCATION_TYPES[type],
    note: clampStr(raw && raw.note, 200) || '',
    value: NEEDS_VALUE.has(type) ? clampStr(raw && raw.value, 500) || '' : '',
  };
}

/** What the admin sent, cleaned up. Duplicate ids are made unique so a choice always resolves. */
function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const [i, raw] of list.slice(0, 8).entries()) {
    const p = conform(raw, i);
    let id = p.id, n = 2;
    while (seen.has(id)) id = `${p.id}-${n++}`;
    seen.add(id);
    out.push({ ...p, id });
  }
  return out;
}

/**
 * Every way this page can be met, always at least one.
 *
 * Falling back to the page's own location_type is what keeps this from being a migration: a page
 * that never defined a list behaves exactly as it did, and the rest of the app can stop caring
 * which of the two it is looking at.
 */
function placesFor(et) {
  const list = Array.isArray(et.location_options) ? et.location_options : [];
  if (list.length) return list;
  const type = typeOf(et.location_type);
  return [{ id: 'default', type, label: LOCATION_TYPES[type], note: '', value: NEEDS_VALUE.has(type) ? et.location_value || '' : '' }];
}

/**
 * The one the customer picked. An unknown id falls back to the first rather than failing: the
 * choice is a preference, and losing it must never cost somebody their booking.
 */
function placeFor(et, id) {
  const all = placesFor(et);
  return all.find((p) => p.id === String(id || '')) || all[0];
}

// What the customer and the calendar invite are told. The phone number is theirs, so it is only
// ever read back to them from what they typed, never stored on the page.
function placeText(place, contact, joinUrl) {
  switch (place.type) {
    case 'phone': return contact && contact.phone ? `Phone call: we will call you at ${contact.phone}` : 'Phone call';
    case 'google_meet': case 'teams': return joinUrl || `${LOCATION_TYPES[place.type]} (link will be sent)`;
    default: return place.value || place.label || LOCATION_TYPES[place.type] || '';
  }
}

// What the public page needs to draw the chooser. An in-person address is worth showing up front;
// a Zoom or custom link is not handed out until there is a booking.
const publicPlace = (p) => ({
  id: p.id, type: p.type, label: p.label, note: p.note,
  detail: p.type === 'in_person' ? p.value : '',
});

module.exports = { sanitize, placesFor, placeFor, placeText, publicPlace, NEEDS_VALUE };
