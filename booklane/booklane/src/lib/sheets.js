'use strict';
// Minimal spreadsheet readers with no dependencies: CSV and the parts of .xlsx we need.
// An .xlsx is a zip of XML, and Node's zlib can inflate the entries, so we read the
// container by hand rather than pulling in a library the registry won't give us.
const zlib = require('node:zlib');

// ---------- zip ----------
function readZip(buf) {
  const files = new Map();
  // End of central directory: scan back from the tail, it is at most 64KB in.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no zip directory found).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Local header repeats the name and extra lengths; the payload starts after them.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    } catch (e) { /* skip entries we cannot inflate */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------- tiny XML helpers ----------
const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const tagsOf = (xml, tag) => xml.match(new RegExp(`<${tag}\\b[^>]*(?:/>|>[\\s\\S]*?</${tag}>)`, 'g')) || [];
const attr = (frag, name) => { const m = frag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decode(m[1]) : ''; };

// Column letters to a zero-based index: A→0, B→1, AA→26.
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------- xlsx ----------
function parseXlsx(buf) {
  const files = readZip(buf);
  const get = (name) => (files.has(name) ? files.get(name).toString('utf8') : '');

  const shared = [];
  for (const si of tagsOf(get('xl/sharedStrings.xml'), 'si')) {
    shared.push((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => decode(t.replace(/<[^>]+>/g, ''))).join(''));
  }

  // Sheet order and names live in workbook.xml; the file each points at is in the rels.
  const rels = new Map();
  for (const r of tagsOf(get('xl/_rels/workbook.xml.rels'), 'Relationship')) {
    rels.set(attr(r, 'Id'), attr(r, 'Target').replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [];
  for (const sh of tagsOf(get('xl/workbook.xml'), 'sheet')) {
    const name = attr(sh, 'name');
    const rid = attr(sh, 'r:id') || attr(sh, 'id');
    const target = rels.get(rid) || `worksheets/sheet${sheets.length + 1}.xml`;
    const xml = get(`xl/${target}`) || get(target);
    sheets.push({ name, rows: xml ? sheetRows(xml, shared) : [] });
  }
  if (!sheets.length) throw new Error('That .xlsx has no readable sheets.');
  return sheets;
}

function sheetRows(xml, shared) {
  const rows = [];
  for (const rowXml of tagsOf(xml, 'row')) {
    const cells = [];
    for (const c of tagsOf(rowXml, 'c')) {
      const i = colIndex(attr(c, 'r') || '');
      const type = attr(c, 't');
      let value = '';
      if (type === 'inlineStr') {
        value = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => decode(t.replace(/<[^>]+>/g, ''))).join('');
      } else {
        const v = c.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? decode(v[1]) : '';
        value = type === 's' ? (shared[Number(raw)] ?? '') : raw;
      }
      if (i >= 0) cells[i] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

// ---------- csv ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Returns [{ name, rows }] for any supported file.
function parseWorkbook(buf, filename = '') {
  const isXlsx = /\.xlsx$/i.test(filename) || (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b);
  if (isXlsx) return parseXlsx(buf);
  if (/\.xls$/i.test(filename)) throw new Error('Old .xls files are not supported. Save as .xlsx or .csv and try again.');
  const text = buf.toString('utf8');
  const sep = /\t/.test(text.split('\n')[0] || '') && !/,/.test(text.split('\n')[0] || '') ? '\t' : ',';
  const rows = sep === '\t' ? text.split(/\r?\n/).map((l) => l.split('\t')) : parseCsv(text);
  return [{ name: 'Sheet1', rows: rows.filter((r) => r.some((c) => String(c).trim() !== '')) }];
}

module.exports = { parseWorkbook, parseXlsx, parseCsv, readZip };
