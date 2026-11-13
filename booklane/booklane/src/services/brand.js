'use strict';
// The brand kit: one company's colours, fonts, logo treatment and embed background, set once and
// used by every public page (booking pages, forms, the quote builder, sessions, the manage page).
//
// The server writes the kit into each page as CSS variables, so a page is on brand before any
// script runs. A page's own Look (services/form-style.js) then overrides whatever it sets itself.
const FSTYLE = require('./form-style');
const { BUSINESS_SETTINGS } = require('../defaults');

const DEF = BUSINESS_SETTINGS.brand;
const EMBED = ['transparent', 'page', 'custom'];
const LOGO_STYLES = ['tile', 'plain'];
const FONT_FILE = /^\/u\/\d+\/[0-9a-f]{24}\.(woff2|woff|ttf|otf)$/;
const FONT_FORMAT = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

const hex = (v) => (FSTYLE.isHex(v) ? v.toLowerCase() : '');
const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
const fontFile = (v) => (FONT_FILE.test(String(v || '')) ? String(v) : '');
const fileName = (v) => String(v || '').replace(/[^\w .()-]/g, '').slice(0, 80);

/** A brand kit safe to put in a page, with every gap filled from the defaults. */
function sanitize(raw) {
  const s = (raw && typeof raw === 'object') ? raw : {};
  const font_file = fontFile(s.font_file), heading_font_file = fontFile(s.heading_font_file);
  return {
    button_text: hex(s.button_text), background: hex(s.background), surface: hex(s.surface), text: hex(s.text), heading_color: hex(s.heading_color),
    font: Object.prototype.hasOwnProperty.call(FSTYLE.FONTS, s.font) ? s.font : DEF.font,
    heading_font: Object.prototype.hasOwnProperty.call(FSTYLE.FONTS, s.heading_font) ? s.heading_font : '',
    font_file, font_file_name: font_file ? fileName(s.font_file_name) : '',
    heading_font_file, heading_font_file_name: heading_font_file ? fileName(s.heading_font_file_name) : '',
    font_size: num(s.font_size, 12, 22, DEF.font_size),
    heading_size: num(s.heading_size, 14, 48, DEF.heading_size),
    embed_background: EMBED.includes(s.embed_background) ? s.embed_background : DEF.embed_background,
    embed_color: hex(s.embed_color),
    logo_style: LOGO_STYLES.includes(s.logo_style) ? s.logo_style : DEF.logo_style,
  };
}

/** A business's brand kit. */
const of = (business) => sanitize(business && business.settings && business.settings.brand);

// ---------- colour maths (the same sums as public/js/look.js) ----------
const rgbOf = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const isLight = (h) => { const [r, g, b] = rgbOf(h).map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45; };
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
function fontStack(f) {
  if (!f || f === 'System') return SANS;
  const kind = FSTYLE.FONTS[f];
  return `"${f}", ${kind === 'serif' ? 'Georgia, "Times New Roman", serif' : kind === 'script' ? 'cursive' : SANS}`;
}
const accentOf = (business) => (business && FSTYLE.isHex(business.brand_color) ? business.brand_color.toLowerCase() : '#6d4aff');

/** The colour behind an embedded page, or '' when the website should show through. */
function embedColor(business) {
  const k = of(business);
  if (k.embed_background === 'custom') return k.embed_color || '';
  if (k.embed_background === 'page') return k.background || '#f6f4f1';
  return '';
}

/**
 * The kit as CSS for the page's <head>: variables on :root, the company's own font files, and
 * the embed background. Everything in it has been through sanitize(), so nothing here can close
 * the style tag or reach outside it.
 */
function css(business) {
  const k = of(business);
  const accent = accentOf(business);
  const v = [`--brand:${accent}`, `--brand-rgb:${rgbOf(accent).join(',')}`, `--btn-ink:${k.button_text || (isLight(accent) ? '#1c1a22' : '#ffffff')}`];
  if (k.background) v.push(`--bg:${k.background}`);
  if (k.surface) v.push(`--surface:${k.surface}`, `--surface-2:color-mix(in srgb, ${k.surface} 94%, ${isLight(k.surface) ? '#000' : '#fff'})`);
  if (k.text) v.push(`--ink:${k.text}`, `--ink-2:color-mix(in srgb, ${k.text} 80%, transparent)`, `--muted:color-mix(in srgb, ${k.text} 60%, transparent)`);
  if (k.text || k.surface) v.push('--line:color-mix(in srgb, var(--ink) 12%, var(--surface))', '--line-2:color-mix(in srgb, var(--ink) 22%, var(--surface))');
  if (k.heading_color) v.push(`--heading-ink:${k.heading_color}`);
  v.push(`--font:${k.font_file ? `"Brand Text", ${fontStack(k.font)}` : fontStack(k.font)}`);
  v.push(`--heading-font:${k.heading_font_file ? `"Brand Heading", ${fontStack(k.heading_font || k.font)}` : k.heading_font ? fontStack(k.heading_font) : 'var(--font)'}`);
  v.push(`--fs:${k.font_size}px`, `--hs:${k.heading_size}px`);
  let out = `:root{${v.join(';')}}`;
  // One file per face. No weight is declared, so the browser thickens it for bold text itself
  // instead of dropping to another font.
  const face = (name, url) => `@font-face{font-family:"${name}";src:url("${url}") format("${FONT_FORMAT[url.split('.').pop()]}");font-display:swap}`;
  if (k.font_file) out += face('Brand Text', k.font_file);
  if (k.heading_font_file) out += face('Brand Heading', k.heading_font_file);
  const embed = embedColor(business);
  if (embed) out += `body.is-embed:not(.embed-clear){background-color:${embed}}`;
  return out;
}

/** The Google Fonts <link> tags the kit needs, or ''. An uploaded file replaces the named font. */
function fontLinks(business) {
  const k = of(business);
  return FSTYLE.fontLinks([k.font_file ? '' : k.font, k.heading_font_file ? '' : k.heading_font]);
}

/** What a public page's scripts need to know about the kit. */
function publicKit(business) {
  const k = of(business);
  return { logo_style: k.logo_style, button_text: k.button_text, font: k.font, heading_font: k.heading_font, has_heading_font: !!(k.heading_font || k.heading_font_file),
    font_size: k.font_size, heading_size: k.heading_size, embed_background: k.embed_background };
}

// ---------- logos ----------
// A logo has to be big enough to stay sharp on a phone's screen and shaped so it fits where logos
// go: square, or wider than it is tall. These are checked here as well as in the browser.
const LOGO = { min_side: 160, max_side: 2400, min_ratio: 0.9, max_ratio: 6, square: '512 × 512', wide: '800 × 200' };

/** Why an image of this size cannot be a logo, or '' when it can. */
function logoProblem(width, height) {
  if (!width || !height) return 'That image could not be read. Use a PNG, JPG, GIF or WebP.';
  const got = `Yours is ${width} × ${height}.`;
  if (Math.min(width, height) < LOGO.min_side) return `That logo is too small. It needs to be at least ${LOGO.min_side} pixels on its shorter side (${LOGO.square} for a square logo or ${LOGO.wide} for a wide one works well). ${got}`;
  if (Math.max(width, height) > LOGO.max_side) return `That logo is too large. Keep it under ${LOGO.max_side} pixels on its longer side. ${got}`;
  const ratio = width / height;
  if (ratio < LOGO.min_ratio) return `That logo is taller than it is wide. Use a square logo (like ${LOGO.square}) or a wide one (like ${LOGO.wide}). ${got}`;
  if (ratio > LOGO.max_ratio) return `That logo is too wide and thin. Keep it no more than ${LOGO.max_ratio} times as wide as it is tall (like ${LOGO.wide}). ${got}`;
  return '';
}
/** A square-ish logo suits the tile; anything wider is shown as it is. */
const logoShape = (width, height) => (width / height > 1.25 ? 'wide' : 'square');

module.exports = { sanitize, of, css, fontLinks, publicKit, embedColor, fontStack, accentOf, LOGO, logoProblem, logoShape, EMBED, LOGO_STYLES };
