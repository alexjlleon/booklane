'use strict';
// Turns an uploaded spreadsheet into catalog services and bundle rules.
// Everything is parsed and reported first; nothing is written until the import is confirmed.
const db = require('../db');
const { parseWorkbook } = require('../lib/sheets');
const { slugify } = require('../lib/util');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = (s) => String(s ?? '').trim();

// Header aliases, so people can use the wording they already have in their price sheet.
const FIELDS = {
  name: ['name', 'service', 'servicename', 'item', 'product', 'lineitem', 'description1'],
  category: ['category', 'group', 'section', 'type', 'servicetype'],
  description: ['description', 'details', 'notes', 'whatsincluded', 'includes'],
  price: ['price', 'baseprice', 'amount', 'rate', 'cost', 'retail', 'listprice', 'startingat'],
  pricing_type: ['pricingtype', 'unit', 'pricing', 'per', 'billing'],
  unit_label: ['unitlabel', 'unitname', 'perwhat'],
  min_qty: ['min', 'minqty', 'minimum', 'minquantity'],
  max_qty: ['max', 'maxqty', 'maximum', 'maxquantity'],
  active: ['active', 'enabled', 'live', 'show'],
};
const BUNDLE_FIELDS = {
  name: ['bundle', 'bundlename', 'name', 'package', 'packagename', 'offer'],
  services: ['services', 'includes', 'items', 'servicelist', 'contains'],
  type: ['type', 'kind', 'discounttype', 'pricingtype'],
  value: ['value', 'price', 'amount', 'bundleprice', 'discount', 'total'],
  min_services: ['minservices', 'minimumservices', 'anyservices', 'count'],
};

function headerMap(row, spec) {
  const map = {};
  row.forEach((cell, i) => {
    const n = norm(cell);
    if (!n) return;
    for (const [field, aliases] of Object.entries(spec)) {
      if (map[field] === undefined && aliases.includes(n)) map[field] = i;
    }
  });
  return map;
}

// The header is not always row 1: people put a title or a blank line above it.
function findHeader(rows, spec, required) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const map = headerMap(rows[i], spec);
    if (required.every((f) => map[f] !== undefined)) return { index: i, map };
  }
  return null;
}

const money = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};
const isPerUnit = (v) => /per|each|unit|hour|hr|guest|person|fixture/i.test(String(v || ''));
const truthy = (v) => !/^(no|false|0|off|inactive|hidden)$/i.test(clean(v) || 'yes');

function readServices(rows, warnings, sheetName) {
  const found = findHeader(rows, FIELDS, ['name']);
  if (!found) { warnings.push(`Sheet "${sheetName}": no column that looks like a service name, so it was skipped.`); return []; }
  const { index, map } = found;
  const at = (row, f) => (map[f] === undefined ? '' : clean(row[map[f]]));
  const out = [];
  const seen = new Set();
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = at(row, 'name');
    if (!name) continue;
    if (seen.has(norm(name))) { warnings.push(`"${name}" appears more than once; only the first was kept.`); continue; }
    seen.add(norm(name));
    const pt = isPerUnit(at(row, 'pricing_type')) || (map.min_qty !== undefined && Number(at(row, 'max_qty')) > 1) ? 'per_unit' : 'flat';
    const min = Math.max(1, parseInt(at(row, 'min_qty'), 10) || 1);
    const max = Math.max(min, parseInt(at(row, 'max_qty'), 10) || (pt === 'per_unit' ? Math.max(min, 20) : 1));
    const price = money(at(row, 'price'));
    if (!price) warnings.push(`"${name}" has no price, so it will show as $0 until you set one.`);
    out.push({
      name: name.slice(0, 120), category: at(row, 'category').slice(0, 60), description: at(row, 'description').slice(0, 500),
      base_price: price, pricing_type: pt, unit_label: at(row, 'unit_label').slice(0, 40) || (pt === 'per_unit' ? 'unit' : ''),
      min_qty: min, max_qty: max, default_qty: min, active: truthy(at(row, 'active')) ? 1 : 0,
      // Add-ons and ready-made packages sit outside combination pricing: an add-on should never
      // stop a combination being recognised, and a package already IS a combination.
      bundle_eligible: /add.?on|extra|upgrade|featured|package|bundle/i.test(at(row, 'category')) ? 0 : 1,
    });
  }
  return out;
}

function readBundles(rows, warnings, sheetName) {
  const found = findHeader(rows, BUNDLE_FIELDS, ['name', 'value']);
  if (!found) { warnings.push(`Sheet "${sheetName}": could not find bundle name and value columns, so it was skipped.`); return []; }
  const { index, map } = found;
  const at = (row, f) => (map[f] === undefined ? '' : clean(row[map[f]]));
  const out = [];
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = at(row, 'name');
    if (!name) continue;
    const rawType = norm(at(row, 'type'));
    // "price" means the named services cost this together; "amount" is money off; "percent" is a rate.
    const type = /percent|pct|%/.test(rawType) ? 'percent' : /amount|off|discount|save/.test(rawType) ? 'amount' : 'price';
    const services = at(row, 'services').split(/[;|\n]|,(?![^(]*\))/).map((x) => clean(x)).filter(Boolean);
    out.push({
      name: name.slice(0, 80), type, value: money(at(row, 'value')),
      service_names: services, min_services: Math.max(0, parseInt(at(row, 'min_services'), 10) || 0), label: '',
    });
    if (!services.length && !parseInt(at(row, 'min_services'), 10)) {
      warnings.push(`Bundle "${name}" lists no services and no minimum count, so it can never apply.`);
    }
  }
  return out;
}

/**
 * Split one sheet that mixes services and combination prices.
 *
 * A price sheet often lists the six things you sell and then every combination of them, all in one
 * column: "Photography + DJ / MC + Videography". Those combination rows are prices, not things to
 * tick, so they become exact bundles and never appear as their own service.
 *
 * The combination has to be made entirely of rows that are services in their own right; anything
 * else is left alone and imported as an ordinary service, because it is probably a real product
 * whose name happens to contain a plus sign.
 */
function splitCombinationRows(services, warnings) {
  const byName = new Map(services.map((s) => [norm(s.name), s]));
  const plain = [];
  const combos = [];
  for (const s of services) {
    const parts = String(s.name).split('+').map((x) => clean(x)).filter(Boolean);
    const looksCombined = parts.length > 1 && parts.every((p) => byName.has(norm(p)) && norm(p) !== norm(s.name));
    if (!looksCombined) { plain.push(s); continue; }
    // "Calculator label: Grand Celebration Bundle." is what the customer should be told they got.
    const m = /calculator label:\s*([^.]+)\./i.exec(s.description || '');
    let label = m ? clean(m[1]) : '';
    if (!label || /^pair$/i.test(label)) label = parts.length === 2 ? 'Pair price' : 'Bundle price';
    combos.push({
      name: s.name.slice(0, 80), type: 'price', value: s.base_price,
      service_names: parts, min_services: 0, label: label.slice(0, 80), exact: true,
    });
  }
  if (combos.length) {
    warnings.push(`${combos.length} row${combos.length === 1 ? '' : 's'} named a combination of services (like "A + B"). Those were read as combination prices, not as separate things to tick.`);
    // A combination that costs more than its parts can never be right, and the quote engine will
    // ignore it rather than overcharge - but say so here, because it is almost always a typo.
    for (const c of combos) {
      const sum = c.service_names.reduce((a, n) => a + ((byName.get(norm(n)) || {}).base_price || 0), 0);
      if (sum && c.value > sum) {
        warnings.push(`"${c.name}" is priced at ${c.value}, more than the ${sum} those services cost separately. Customers will be quoted ${sum} until you fix it.`);
      }
    }
  }
  return { plain, combos };
}

// Parse and validate without touching the database.
function analyze(buf, filename) {
  const sheets = parseWorkbook(buf, filename);
  const warnings = [];
  let services = [], bundles = [];
  for (const sheet of sheets) {
    const rows = (sheet.rows || []).filter((r) => r.some((c) => clean(c) !== ''));
    if (!rows.length) continue;
    const isBundleSheet = /bundl|package|combo|discount/i.test(sheet.name)
      || (rows[0] || []).some((c) => ['bundle', 'bundlename', 'package'].includes(norm(c)));
    if (isBundleSheet) bundles = bundles.concat(readBundles(rows, warnings, sheet.name));
    else services = services.concat(readServices(rows, warnings, sheet.name));
  }
  // Combination rows arrive mixed in with the services; pull them out into bundles.
  const split = splitCombinationRows(services, warnings);
  services = split.plain;
  bundles = bundles.concat(split.combos);
  if (!services.length && !bundles.length) throw new Error('No services or bundles were found in that file. The first row should be column headings such as Category, Service, Price.');
  return { services, bundles, warnings, sheets: sheets.map((s) => ({ name: s.name, rows: (s.rows || []).length })) };
}

// Write it in. 'replace' clears the existing catalog first; 'merge' updates by name and adds the rest.
function apply(businessId, parsed, { mode = 'merge' } = {}) {
  const result = { added: 0, updated: 0, deactivated: 0, bundles: 0, unmatched: [] };
  db.tx(() => {
    if (mode === 'replace') {
      const keep = new Set(parsed.services.map((s) => norm(s.name)));
      for (const row of db.all('SELECT id, name FROM services WHERE business_id = ? AND active = 1', businessId)) {
        if (!keep.has(norm(row.name))) { db.run('UPDATE services SET active = 0 WHERE id = ?', row.id); result.deactivated++; }
      }
    }
    const existing = new Map(db.all('SELECT id, name FROM services WHERE business_id = ?', businessId).map((r) => [norm(r.name), r.id]));
    let sort = (db.get('SELECT MAX(sort) m FROM services WHERE business_id = ?', businessId) || {}).m || 0;
    for (const s of parsed.services) {
      const id = existing.get(norm(s.name));
      if (id) {
        db.run(`UPDATE services SET category = ?, description = ?, base_price = ?, pricing_type = ?, unit_label = ?,
          min_qty = ?, max_qty = ?, default_qty = ?, active = ?, bundle_eligible = ? WHERE id = ? AND business_id = ?`,
        s.category, s.description, s.base_price, s.pricing_type, s.unit_label, s.min_qty, s.max_qty, s.default_qty, s.active, s.bundle_eligible ?? 1, id, businessId);
        result.updated++;
      } else {
        const { lastId } = db.run(`INSERT INTO services (business_id, category, name, description, base_price, pricing_type, unit_label,
          min_qty, max_qty, default_qty, active, bundle_eligible, sort) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        businessId, s.category, s.name, s.description, s.base_price, s.pricing_type, s.unit_label, s.min_qty, s.max_qty, s.default_qty, s.active, s.bundle_eligible ?? 1, ++sort);
        existing.set(norm(s.name), lastId);
        result.added++;
      }
    }
    if (parsed.bundles.length) {
      const bundles = [];
      for (const b of parsed.bundles) {
        const ids = [];
        for (const nm of b.service_names || []) {
          const id = existing.get(norm(nm));
          if (id) ids.push(id); else result.unmatched.push(`${b.name}: "${nm}"`);
        }
        if (!ids.length && !b.min_services) continue;
        bundles.push({ name: b.name, type: b.type, value: b.value, service_ids: ids, min_services: b.min_services, label: b.label || '', exact: !!b.exact });
      }
      const biz = db.get('SELECT settings FROM businesses WHERE id = ?', businessId);
      const settings = db.json(biz.settings, {});
      settings.quote = Object.assign({}, settings.quote, { bundles });
      db.run("UPDATE businesses SET settings = ? WHERE id = ?", JSON.stringify(settings), businessId);
      result.bundles = bundles.length;
    }
  });
  return result;
}

module.exports = { analyze, apply };
