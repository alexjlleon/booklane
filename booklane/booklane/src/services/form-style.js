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
const FONTS = {
  'Plus Jakarta Sans': 'sans', Inter: 'sans', 'DM Sans': 'sans', Poppins: 'sans', Montserrat: 'sans', 'Work Sans': 'sans', Nunito: 'sans',
  'Playfair Display': 'serif', 'Cormorant Garamond': 'serif', Lora: 'serif', 'Libre Baskerville': 'serif', 'EB Garamond': 'serif',
  'Great Vibes': 'script', Parisienne: 'script',
  System: 'system',
};

const BASE = {
  layout: 'full',
  // Colours. Blank means "use the business's brand colour" / the built-in palette.
  accent: '', background: '', surface: '', text: '', button_text: '',
  background_image: '', overlay: 0,
  header_image: '', header_height: 160,
  logo_url: '',
  // What shows.
  show_logo: true, show_name: true, show_title: true, show_description: true, show_sidebar: true,
  show_trust: true, show_step_titles: true, show_subtitles: true, show_labels: true, show_back: true,
  // Progress.
  progress: 'bar', progress_count: true,
  // Type.
  font: 'Plus Jakarta Sans', heading_font: '', font_size: 15, heading_size: 26,
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
    layout: d.layout,
    accent: isHex(s.accent) ? s.accent.toLowerCase() : '',
    background: isHex(s.background) ? s.background.toLowerCase() : '',
    surface: isHex(s.surface) ? s.surface.toLowerCase() : '',
    text: isHex(s.text) ? s.text.toLowerCase() : '',
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
    font: Object.prototype.hasOwnProperty.call(FONTS, s.font) ? s.font : d.font,
    heading_font: Object.prototype.hasOwnProperty.call(FONTS, s.heading_font) ? s.heading_font : '',
    font_size: numIn(s.font_size, 12, 20, d.font_size),
    heading_size: numIn(s.heading_size, 14, 44, d.heading_size),
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
    custom_css: cleanCss(s.custom_css),
  };
}

/** The Google Fonts stylesheet a style needs, or '' when it only uses the built-in or system fonts. */
function fontHref(style) {
  const fams = [...new Set([style.font, style.heading_font].filter((f) => f && f !== 'System' && f !== 'Plus Jakarta Sans'))];
  if (!fams.length) return '';
  // Asking Google for a weight a family does not have fails the whole stylesheet, so each family
  // asks only for what it has.
  const weights = (f) => (FONTS[f] === 'script' ? '400' : ['Libre Baskerville'].includes(f) ? '400;700' : ['Cormorant Garamond', 'Lora'].includes(f) ? '400;500;600;700' : '400;500;600;700;800');
  return 'https://fonts.googleapis.com/css2?' + fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@${weights(f)}`).join('&') + '&display=swap';
}

module.exports = { LAYOUTS, PROGRESS, DATE_DISPLAYS, FONTS, BASE, PRESETS, LAYOUT_INFO, defaultsFor, sanitizeStyle, cleanUrl, cleanCss, fontHref };
