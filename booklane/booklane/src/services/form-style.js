'use strict';
// How a custom form looks. Everything here is presentation: it never changes what a form asks,
// what it saves or what it books.
//
// Four starting layouts, each a full set of defaults:
//   full     - the two-column booking-page look, with a side panel
//   minimal  - one narrow column, nothing but the questions
//   thin     - the least height possible, for a strip on a page
//   visual   - images and colours: a banner, photo option cards, a big logo
//
// Every individual setting can then be overridden, so a layout is a starting point, not a cage.
// Unknown or malformed values fall back to the layout's default rather than erroring, so an old
// form or a hand-edited payload always renders.

const LAYOUTS = ['full', 'minimal', 'thin', 'visual'];
const PROGRESS = ['bar', 'steps', 'dots', 'count', 'none'];
const DATE_DISPLAYS = ['calendar', 'typed', 'picker'];
// The time picker: a row of days and a grid of times, the month calendar, or days on phones and
// the month on wider screens.
const CALENDAR_STYLES = ['auto', 'days', 'month'];
// Every font on offer, with its kind (for the fallback stack) and the weights Google has for it.
// Asking Google for a weight a family does not have fails the whole stylesheet, so each family
// asks only for what it has.
const W = { full: '400;500;600;700;800', to7: '400;500;600;700', two: '400;700', one: '400' };
const FONT_LIST = [
  ['Plus Jakarta Sans', 'sans', W.full], ['Inter', 'sans', W.full], ['DM Sans', 'sans', W.full], ['Poppins', 'sans', W.full],
  ['Montserrat', 'sans', W.full], ['Work Sans', 'sans', W.full], ['Nunito', 'sans', W.full], ['Open Sans', 'sans', W.full],
  ['Raleway', 'sans', W.full], ['Manrope', 'sans', W.full], ['Outfit', 'sans', W.full], ['Figtree', 'sans', W.full],
  ['Mulish', 'sans', W.full], ['Urbanist', 'sans', W.full], ['Sora', 'sans', W.full], ['Roboto', 'sans', '400;500;700'],
  ['Lato', 'sans', W.two], ['Source Sans 3', 'sans', W.full], ['Josefin Sans', 'sans', W.to7], ['Quicksand', 'sans', W.to7],
  ['Oswald', 'sans', W.to7], ['Bebas Neue', 'sans', W.one],
  ['Playfair Display', 'serif', W.full], ['Cormorant Garamond', 'serif', W.to7], ['Lora', 'serif', W.to7],
  ['Libre Baskerville', 'serif', W.two], ['EB Garamond', 'serif', W.full], ['Merriweather', 'serif', W.two],
  ['DM Serif Display', 'serif', W.one], ['Fraunces', 'serif', W.full], ['Marcellus', 'serif', W.one], ['Cinzel', 'serif', W.full],
  ['Italiana', 'serif', W.one], ['Prata', 'serif', W.one],
  ['Great Vibes', 'script', W.one], ['Parisienne', 'script', W.one], ['Dancing Script', 'script', W.to7],
  ['Allura', 'script', W.one], ['Sacramento', 'script', W.one],
  ['System', 'system', ''],
];
const FONTS = Object.fromEntries(FONT_LIST.map(([f, kind]) => [f, kind]));
const FONT_WEIGHTS = Object.fromEntries(FONT_LIST.map(([f, , w]) => [f, w]));

const BASE = {
  layout: 'full',
  // Colours. Blank means "use the business's brand colour" / the built-in palette.
  accent: '', background: '', surface: '', text: '', heading_color: '', button_text: '',
  background_image: '', overlay: 0,
  // Embedded on a website: 'auto' shows this look's own background if it has one and otherwise does
  // what the brand kit says; 'transparent' lets the website show through; 'color' fills it in.
  embed_background: 'auto',
  header_image: '', header_height: 160,
  logo_url: '',
  // What shows.
  show_logo: true, show_name: true, show_title: true, show_description: true, show_sidebar: true,
  show_trust: true, show_step_titles: true, show_subtitles: true, show_labels: true, show_back: true,
  // Progress.
  progress: 'bar', progress_count: true,
  // Type. Blank and 0 mean "what the brand kit says"; a heading font of 'same' follows the text font.
  font: '', heading_font: '', font_size: 0, heading_size: 0,
  // Shape and space.
  width: 0, radius: 18, field_radius: 12, density: 'comfortable', align: 'left',
  shadow: true, border: true,
  // Buttons.
  button_shape: 'rounded', button_style: 'filled', button_full: false, continue_label: 'Continue', back_label: 'Back',
  // Choices.
  option_columns: 'auto', option_style: 'cards', image_shape: 'square', image_fit: 'cover',
  auto_advance: false,
  // Dates.
  date_display: 'calendar',
  // The calendar step.
  calendar_style: 'auto',
  // Escape hatch.
  custom_css: '',
};

// What each layout changes from the base. Choosing a layout in the editor fills these in, and
// they are also the fallback for anything left unset.
const PRESETS = {
  full: {},
  minimal: {
    show_sidebar: false, show_trust: false, show_name: false, show_description: false,
    width: 520, radius: 14, heading_size: 22, progress: 'bar', progress_count: false, density: 'comfortable',
    button_full: true, shadow: true,
  },
  thin: {
    show_sidebar: false, show_trust: false, show_logo: false, show_name: false, show_title: false, show_description: false,
    show_subtitles: false, width: 640, radius: 10, field_radius: 8, heading_size: 17, font_size: 14,
    progress: 'none', density: 'compact', shadow: false, border: true, auto_advance: true, date_display: 'typed',
    option_columns: 'auto', button_shape: 'rounded',
  },
  visual: {
    show_sidebar: false, show_trust: true, show_name: true, show_description: true,
    width: 760, radius: 22, field_radius: 14, heading_size: 28, progress: 'dots', align: 'center',
    header_height: 200, option_style: 'images', option_columns: 3, image_shape: 'square',
    button_shape: 'pill', density: 'spacious', shadow: true,
  },
};

const LAYOUT_INFO = {
  full: { name: 'Full', blurb: 'Side panel with your logo, title and trust points. The booking-page look.' },
  minimal: { name: 'Minimal', blurb: 'One narrow column. Just the questions, no extra fluff.' },
  thin: { name: 'Thin', blurb: 'The least height possible. For a strip on a page or a small embed.' },
  visual: { name: 'Images and colors', blurb: 'Banner image, big logo, photo choices and your colours.' },
};

const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const pick = (v, list, def) => (list.includes(v) ? v : def);
const numIn = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
// A size in px, where 0 means "use the brand kit's".
const sizeIn = (v, lo, hi, def) => (v === 0 || v === '0' || v === '' ? 0 : numIn(v, lo, hi, def));
const boolOr = (v, def) => (v === undefined || v === null ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

/**
 * An image address we are willing to put in a page: our own uploads, or https from anywhere.
 * No data: or javascript: URLs, nothing with quotes or brackets that could break out of CSS url().
 */
function cleanUrl(v) {
  const s = String(v || '').trim().slice(0, 600);
  if (!s) return '';
  if (/["'()<>\\\s]/.test(s)) return '';
  if (/^\/u\/[\w./-]+$/.test(s) && !s.includes('..')) return s;
  if (/^https:\/\/[^/]+/i.test(s)) return s;
  return '';
}

/** Custom CSS is the business's own, but it must never close the style tag it lives in. */
function cleanCss(v) {
  return String(v || '').replace(/<\/?\s*style/gi, '').replace(/</g, '').replace(/@import/gi, '').slice(0, 8000);
}

function defaultsFor(layout) {
  return Object.assign({}, BASE, PRESETS[pick(layout, LAYOUTS, 'full')], { layout: pick(layout, LAYOUTS, 'full') });
}

/** Clean a style object coming from the builder (or the database), filling gaps from its layout. */
function sanitizeStyle(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const d = defaultsFor(s.layout);
  const cols = s.option_columns === undefined || s.option_columns === null || s.option_columns === ''
    ? d.option_columns : (s.option_columns === 'auto' ? 'auto' : numIn(s.option_columns, 1, 4, 'auto'));
  return {
    v: 2,
    layout: d.layout,
    accent: isHex(s.accent) ? s.accent.toLowerCase() : '',
    background: isHex(s.background) ? s.background.toLowerCase() : '',
    surface: isHex(s.surface) ? s.surface.toLowerCase() : '',
    text: isHex(s.text) ? s.text.toLowerCase() : '',
    heading_color: isHex(s.heading_color) ? s.heading_color.toLowerCase() : '',
    embed_background: pick(s.embed_background, ['auto', 'transparent', 'color'], d.embed_background),
    button_text: isHex(s.button_text) ? s.button_text.toLowerCase() : '',
    background_image: cleanUrl(s.background_image),
    overlay: numIn(s.overlay, 0, 85, d.overlay),
    header_image: cleanUrl(s.header_image),
    header_height: numIn(s.header_height, 60, 420, d.header_height),
    logo_url: cleanUrl(s.logo_url),
    show_logo: boolOr(s.show_logo, d.show_logo),
    show_name: boolOr(s.show_name, d.show_name),
    show_title: boolOr(s.show_title, d.show_title),
    show_description: boolOr(s.show_description, d.show_description),
    show_sidebar: boolOr(s.show_sidebar, d.show_sidebar),
    show_trust: boolOr(s.show_trust, d.show_trust),
    show_step_titles: boolOr(s.show_step_titles, d.show_step_titles),
    show_subtitles: boolOr(s.show_subtitles, d.show_subtitles),
    show_labels: boolOr(s.show_labels, d.show_labels),
    show_back: boolOr(s.show_back, d.show_back),
    progress: pick(s.progress, PROGRESS, d.progress),
    progress_count: boolOr(s.progress_count, d.progress_count),
    font: Object.prototype.hasOwnProperty.call(FONTS, s.font) ? s.font : (s.font === '' ? '' : d.font),
    heading_font: Object.prototype.hasOwnProperty.call(FONTS, s.heading_font) ? s.heading_font : (s.heading_font === 'same' ? 'same' : ''),
    font_size: s.font_size === undefined || s.font_size === null ? d.font_size : sizeIn(s.font_size, 12, 22, d.font_size),
    heading_size: s.heading_size === undefined || s.heading_size === null ? d.heading_size : sizeIn(s.heading_size, 14, 48, d.heading_size),
    width: numIn(s.width, 0, 1400, d.width),
    radius: numIn(s.radius, 0, 40, d.radius),
    field_radius: numIn(s.field_radius, 0, 30, d.field_radius),
    density: pick(s.density, ['compact', 'comfortable', 'spacious'], d.density),
    align: pick(s.align, ['left', 'center'], d.align),
    shadow: boolOr(s.shadow, d.shadow),
    border: boolOr(s.border, d.border),
    button_shape: pick(s.button_shape, ['square', 'rounded', 'pill'], d.button_shape),
    button_style: pick(s.button_style, ['filled', 'outline'], d.button_style),
    button_full: boolOr(s.button_full, d.button_full),
    continue_label: String(s.continue_label ?? d.continue_label).slice(0, 60) || 'Continue',
    back_label: String(s.back_label ?? d.back_label).slice(0, 60) || 'Back',
    option_columns: cols,
    option_style: pick(s.option_style, ['cards', 'list', 'images', 'pills'], d.option_style),
    image_shape: pick(s.image_shape, ['square', 'wide', 'tall', 'circle'], d.image_shape),
    image_fit: pick(s.image_fit, ['cover', 'contain'], d.image_fit),
    auto_advance: boolOr(s.auto_advance, d.auto_advance),
    date_display: pick(s.date_display, DATE_DISPLAYS, d.date_display),
    calendar_style: pick(s.calendar_style, CALENDAR_STYLES, d.calendar_style),
    custom_css: cleanCss(s.custom_css),
  };
}

/**
 * A booking page's look. Pages saved before looks existed get the Full layout set up the way the
 * booking page always looked: choices as a list, the phone's date picker, single picks moving on
 * by themselves, and the old "Show the progress bar" switch.
 */
function bookingStyle(settings) {
  const st = settings || {};
  if (st.style && typeof st.style === 'object') return sanitizeStyle(st.style);
  return sanitizeStyle(Object.assign(defaultsFor('full'), { option_style: 'list', date_display: 'picker', auto_advance: true, progress: st.show_progress === false ? 'none' : 'bar' }));
}

/**
 * The Google Fonts stylesheet for a set of font names, or '' when none of them needs one. Plus
 * Jakarta Sans is already on every page, System needs nothing, and unknown names are ignored.
 */
function fontsHref(names) {
  const fams = [...new Set((names || []).filter((f) => f && FONT_WEIGHTS[f] && f !== 'Plus Jakarta Sans'))];
  if (!fams.length) return '';
  return 'https://fonts.googleapis.com/css2?' + fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${FONT_WEIGHTS[f]}`).join('&') + '&display=swap';
}
/**
 * The <link> tags for a set of font names: one stylesheet per family, so a family Google ever
 * refuses cannot take the others down with it.
 */
const fontLinks = (names) => [...new Set((names || []).filter(Boolean))].map((f) => fontsHref([f])).filter(Boolean).map((h) => `<link href="${h}" rel="stylesheet">`).join('');
/** The stylesheet one look needs for its own fonts (the brand kit's fonts come with the page). */
const fontHref = (style) => fontsHref([style.font, style.heading_font]);
const styleFontLinks = (style) => fontLinks([style.font, style.heading_font]);

/**
 * Looks saved before the brand kit stored the built-in font and sizes outright. Those now mean
 * "what the brand kit says", so such a look follows the company's brand the moment one is set, and
 * until then draws exactly as it did. Returns the upgraded look, or null when there is nothing to do.
 */
function upgradeStyle(style) {
  if (!style || typeof style !== 'object' || style.v === 2) return null;
  const s = Object.assign({}, style);
  if (s.font === 'Plus Jakarta Sans' || s.font === undefined) s.font = '';
  else if (!s.heading_font) s.heading_font = 'same';
  if (Number(s.font_size) === 15) s.font_size = 0;
  if ((s.layout || 'full') === 'full' && Number(s.heading_size) === 26) s.heading_size = 0;
  return sanitizeStyle(s);
}

module.exports = { LAYOUTS, PROGRESS, DATE_DISPLAYS, CALENDAR_STYLES, FONTS, FONT_WEIGHTS, fontsHref, fontLinks, styleFontLinks, upgradeStyle, isHex, bookingStyle, BASE, PRESETS, LAYOUT_INFO, defaultsFor, sanitizeStyle, cleanUrl, cleanCss, fontHref };
