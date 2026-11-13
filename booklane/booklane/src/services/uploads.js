'use strict';
// Files a business uploads for its pages: logos, banners, backgrounds, photos on choices, and its
// own brand fonts.
//
// Stored on the data volume next to the database, named by their own hash so the same picture
// uploaded twice is one file, and served at /u/<business id>/<hash>.<ext>. Only real raster images
// are accepted, checked by their first bytes rather than by the name or the type the browser
// claims: an SVG can carry script, so it is refused outright.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('../lib/router');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const ROOT = path.join(DATA_DIR, 'uploads');
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FONT_BYTES = 2 * 1024 * 1024;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const FONT_TYPES = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** A font file, told by its first bytes: WOFF2, WOFF, TrueType or OpenType. */
function sniffFont(buf) {
  if (buf.length < 12) return null;
  const tag = buf.slice(0, 4).toString('latin1');
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'wOFF') return 'woff';
  if (tag === 'OTTO') return 'otf';
  if (tag === 'true' || buf.readUInt32BE(0) === 0x00010000) return 'ttf';
  return null;
}

/**
 * The pixel size of an image, read from its header, or null when it cannot be found. `ext` is
 * what sniff() said the file is.
 */
function dimensions(buf, ext) {
  try {
    if (ext === 'png') return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
    if (ext === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (ext === 'webp') {
      const kind = buf.slice(12, 16).toString('ascii');
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff) }; }
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (ext === 'jpg') {
      // Walk the segments to the frame header (SOF0-SOF15, bar the three that are not frames).
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* a cut-off file */ }
  return null;
}

function decode(base64, what) {
  const raw = String(base64 || '').replace(/^data:[^;,]*;base64,/, '');
  if (!raw) throw new HttpError(400, `No ${what} was uploaded.`);
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new HttpError(400, `That ${what} is empty.`);
  return buf;
}
function store(businessId, buf, ext) {
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
  const dir = path.join(ROOT, String(Number(businessId)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return `/u/${Number(businessId)}/${name}`;
}

/** Save one of the company's own font files and return its address. */
function saveFont(businessId, base64) {
  const buf = decode(base64, 'font');
  if (buf.length > MAX_FONT_BYTES) throw new HttpError(413, 'That font file is too large. Keep it under 2MB (a .woff2 file is the smallest).');
  const ext = sniffFont(buf);
  if (!ext) throw new HttpError(415, 'Use a .woff2, .woff, .ttf or .otf font file.');
  return { url: store(businessId, buf, ext), bytes: buf.length, type: FONT_TYPES[ext] };
}

/**
 * Save one image for a business and return the address to use for it. A logo (`kind: 'logo'`)
 * must also be the right size and shape; see services/brand.js for the rules.
 */
function save(businessId, base64, { kind } = {}) {
  if (kind === 'font') return saveFont(businessId, base64);
  const buf = decode(base64, 'image');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'That image is too large. Keep it under 5MB.');
  const ext = sniff(buf);
  if (!ext) throw new HttpError(415, 'Use a PNG, JPG, GIF or WebP image.');
  const size = dimensions(buf, ext);
  if (kind === 'logo') {
    const BRAND = require('./brand');
    const problem = BRAND.logoProblem(size && size.width, size && size.height);
    if (problem) throw new HttpError(422, problem);
    return { url: store(businessId, buf, ext), bytes: buf.length, type: TYPES[ext], width: size.width, height: size.height, shape: BRAND.logoShape(size.width, size.height) };
  }
  return Object.assign({ url: store(businessId, buf, ext), bytes: buf.length, type: TYPES[ext] }, size || {});
}
/** Resolve /u/<id>/<name> to a file, or null. Names are only ever our own hash names. */
function resolve(id, name) {
  if (!/^\d+$/.test(String(id)) || !/^[0-9a-f]{24}\.(png|jpg|gif|webp|woff2|woff|ttf|otf)$/.test(String(name))) return null;
  const file = path.join(ROOT, String(id), String(name));
  try { return fs.statSync(file).isFile() ? { file, type: TYPES[name.split('.').pop()] || FONT_TYPES[name.split('.').pop()] } : null; } catch { return null; }
}

module.exports = { save, saveFont, resolve, sniff, sniffFont, dimensions, MAX_BYTES, MAX_FONT_BYTES, ROOT };
