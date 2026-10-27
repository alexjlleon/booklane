'use strict';
// Images a business uploads for its forms: logos, banners, backgrounds, photos on choices.
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
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && (buf.slice(0, 6).toString('ascii') === 'GIF87a' || buf.slice(0, 6).toString('ascii') === 'GIF89a')) return 'gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** Save one image for a business and return the address to use for it. */
function save(businessId, base64) {
  const raw = String(base64 || '').replace(/^data:[^;,]*;base64,/, '');
  if (!raw) throw new HttpError(400, 'No image was uploaded.');
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new HttpError(400, 'That image is empty.');
  if (buf.length > MAX_BYTES) throw new HttpError(413, 'That image is too large. Keep it under 5MB.');
  const ext = sniff(buf);
  if (!ext) throw new HttpError(415, 'Use a PNG, JPG, GIF or WebP image.');
  const name = `${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24)}.${ext}`;
  const dir = path.join(ROOT, String(Number(businessId)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { url: `/u/${Number(businessId)}/${name}`, bytes: buf.length, type: TYPES[ext] };
}

/** Resolve /u/<id>/<name> to a file, or null. Names are only ever our own hash names. */
function resolve(id, name) {
  if (!/^\d+$/.test(String(id)) || !/^[0-9a-f]{24}\.(png|jpg|gif|webp)$/.test(String(name))) return null;
  const file = path.join(ROOT, String(id), String(name));
  try { return fs.statSync(file).isFile() ? { file, type: TYPES[name.split('.').pop()] } : null; } catch { return null; }
}

module.exports = { save, resolve, sniff, MAX_BYTES, ROOT };
