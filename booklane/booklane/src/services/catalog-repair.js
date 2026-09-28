'use strict';
/**
 * One-time repair for catalogs imported before combination pricing existed.
 *
 * A price sheet lists the things you sell and then what each combination of them costs, all in one
 * column. Imported by an older version, every one of those combination rows became its own card in
 * the picker, so a customer scrolled past seventy of them - and, worse, picking two services added
 * their two prices together, because nothing in the database said the pair had a price of its own.
 *
 * Re-uploading the sheet would fix it, but a wrong quote is showing customers a wrong number right
 * now, and no one should have to re-upload to stop that. So the same split the importer does runs
 * once over what is already stored, and is then marked done so it never fights a later hand edit.
 */
const db = require('../db');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const clean = (s) => String(s ?? '').trim();
// Kept identical to the importer's rule, so a repaired catalog and a freshly imported one agree.
const NOT_ELIGIBLE = /add.?on|extra|upgrade|featured|package|bundle/i;
// A ready-made package is a combination someone wrote out by hand. Add-ons are not.
const IS_PACKAGE = /featured|package|bundle/i;

const REPAIR_FLAG = 'combinations_repaired';
const sig = (ids) => ids.slice().sort((a, z) => a - z).join(',');

/**
 * Pull the combination rows out of one business's catalog.
 *
 * A row counts as a combination only when every part of its name is itself a service in the same
 * catalog. That is deliberately strict: a real product whose name happens to contain a plus sign
 * keeps its card and its price.
 */
function repairBusiness(businessId) {
  const out = { combinations: 0, packages_hidden: 0, marked_ineligible: 0, skipped: false };
  const biz = db.get('SELECT id, settings FROM businesses WHERE id = ?', businessId);
  if (!biz) return out;
  const settings = db.json(biz.settings, {});
  const quote = settings.quote || (settings.quote = {});
  if (quote[REPAIR_FLAG]) { out.skipped = true; return out; }

  const active = db.all('SELECT id, name, category, description, base_price FROM services WHERE business_id = ? AND active = 1', businessId);
  const byName = new Map(active.map((s) => [norm(s.name), s]));
  const bundles = Array.isArray(quote.bundles) ? quote.bundles.slice() : [];
  const known = new Set(bundles.map((b) => sig((b.service_ids || []).map(Number))));

  for (const s of active) {
    const parts = String(s.name).split('+').map(clean).filter(Boolean);
    if (parts.length < 2) continue;
    const ids = [];
    for (const p of parts) {
      const hit = byName.get(norm(p));
      if (!hit || hit.id === s.id) { ids.length = 0; break; }
      ids.push(hit.id);
    }
    if (!ids.length) continue;
    // "Calculator label: Grand Celebration Bundle." is what the customer should be told they got.
    const m = /calculator label:\s*([^.]+)\./i.exec(s.description || '');
    let label = m ? clean(m[1]) : '';
    if (!label || /^pair$/i.test(label)) label = parts.length === 2 ? 'Pair price' : 'Bundle price';
    if (!known.has(sig(ids))) {
      bundles.push({ name: String(s.name).slice(0, 80), type: 'price', value: Number(s.base_price) || 0,
        service_ids: ids, min_services: 0, label: label.slice(0, 80), exact: true });
      known.add(sig(ids));
    }
    db.run('UPDATE services SET active = 0 WHERE id = ? AND business_id = ?', s.id, businessId);
    out.combinations++;
  }
  if (!out.combinations) { quote[REPAIR_FLAG] = true; save(businessId, settings, bundles); return out; }

  // bundle_eligible arrived after these rows did, so they all defaulted to eligible. An add-on left
  // eligible silently breaks every combination it is added to: the mix no longer matches any row of
  // the table, and the customer is quoted the plain sum instead of the combination price.
  for (const s of db.all('SELECT id, category, bundle_eligible FROM services WHERE business_id = ?', businessId)) {
    const want = NOT_ELIGIBLE.test(s.category || '') ? 0 : 1;
    if (Number(s.bundle_eligible) === want) continue;
    db.run('UPDATE services SET bundle_eligible = ? WHERE id = ?', want, s.id);
    out.marked_ineligible++;
  }
  // With the table in place, a ready-made package card can only double-charge: ticking it and the
  // services it contains bills them twice, and the engine already names and prices that same
  // combination the moment those services are ticked. Hidden, not deleted - the row is still in the
  // catalog screen and one click brings it back.
  for (const s of db.all('SELECT id, category FROM services WHERE business_id = ? AND active = 1', businessId)) {
    if (!IS_PACKAGE.test(s.category || '')) continue;
    db.run('UPDATE services SET active = 0 WHERE id = ?', s.id);
    out.packages_hidden++;
  }
  quote[REPAIR_FLAG] = true;
  save(businessId, settings, bundles);
  return out;
}

function save(businessId, settings, bundles) {
  settings.quote.bundles = bundles;
  db.run('UPDATE businesses SET settings = ? WHERE id = ?', JSON.stringify(settings), businessId);
}

// Runs at boot. A failure here must never stop the server: a catalog that still needs repairing is
// worth a loud log line, not an outage.
function repairAll() {
  const totals = { businesses: 0, combinations: 0, packages_hidden: 0 };
  for (const b of db.all('SELECT id FROM businesses')) {
    try {
      const r = db.tx(() => repairBusiness(b.id));
      if (r.skipped || !r.combinations) continue;
      totals.businesses++; totals.combinations += r.combinations; totals.packages_hidden += r.packages_hidden;
      console.log(`[catalog-repair] business ${b.id}: ${r.combinations} combination rows became combination prices, ${r.packages_hidden} package cards hidden, ${r.marked_ineligible} services re-flagged`);
    } catch (e) { console.error('[catalog-repair]', b.id, e); }
  }
  return totals;
}

module.exports = { repairAll, repairBusiness };
