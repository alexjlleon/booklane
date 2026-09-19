// Shared quote pricing engine. Used by the browser (live totals) and the server (source of truth).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BLPricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  function priceService(service, sel) {
    const pt = service.pricing_type || 'flat';
    const min = Math.max(1, Number(service.min_qty) || 1);
    const max = Math.max(min, Number(service.max_qty) || min);
    let qty = pt === 'flat' ? 1 : Math.min(max, Math.max(min, Math.round(Number(sel.qty) || Number(service.default_qty) || min)));
    let unit = Number(service.base_price) || 0;
    let flatAdds = 0;
    const options = [];
    for (const g of service.option_groups || []) {
      const chosenIds = [].concat((sel.options || {})[g.id] ?? []).filter((x) => x !== '' && x != null);
      let chosen = (g.choices || []).filter((c) => chosenIds.includes(c.id));
      if (!g.multi) chosen = chosen.slice(0, 1);
      if (!chosen.length && g.required) {
        const def = (g.choices || []).find((c) => c.default) || (g.choices || [])[0];
        if (def) chosen = [def];
      }
      for (const c of chosen) {
        const p = Number(c.price) || 0;
        if (g.mode === 'base') unit = p; else if (g.mode === 'per_unit') unit += p; else flatAdds += p;
        options.push({ group: g.name, name: c.name, price: p, mode: g.mode || 'add' });
      }
    }
    const addons = [];
    let addonTotal = 0;
    for (const a of service.addons || []) {
      let q = Number((sel.addons || {})[a.id]) || 0;
      const amax = Math.max(1, Number(a.max) || 1);
      q = Math.min(amax, Math.max(0, Math.round(q)));
      if (!q) continue;
      const amount = r2((Number(a.price) || 0) * (a.per === 'unit' ? qty * q : q));
      addonTotal += amount;
      addons.push({ id: a.id, name: a.name, qty: q, price: Number(a.price) || 0, amount });
    }
    const base = r2(unit * qty + flatAdds);
    return {
      service_id: service.id, name: service.name, category: service.category || '', pricing_type: pt,
      qty, unit_label: service.unit_label || '', unit_price: r2(unit), options, addons,
      base_amount: base, amount: r2(base + addonTotal),
    };
  }

  const sumOf = (lines) => r2(lines.reduce((a, l) => a + (Number(l.amount) || 0), 0));
  const idsOf = (lines) => new Set(lines.map((l) => Number(l.service_id)));

  // One shape for every bundle rule. Old percent-only tiers are folded in so existing settings keep working.
  function allBundles(settings) {
    const list = (settings.bundles || []).map((b) => ({
      name: String(b.name || ''), type: b.type === 'price' || b.type === 'amount' ? b.type : 'percent',
      value: Number(b.value) || 0,
      service_ids: (b.service_ids || []).map(Number).filter((n) => n > 0),
      min_services: Math.max(0, Number(b.min_services) || 0),
      label: String(b.label || ''),
    }));
    for (const t of settings.bundle_discounts || []) {
      list.push({ name: '', type: 'percent', value: Number(t.percent) || 0, service_ids: [],
        min_services: Math.max(1, Number(t.min_services) || 2), label: String(t.label || '') });
    }
    return list;
  }

  // A bundle applies either when every named service is selected, or when enough services are selected.
  function matchOf(b, lines) {
    if (b.service_ids.length) {
      const have = idsOf(lines);
      if (!b.service_ids.every((id) => have.has(id))) return null;
      const matched = lines.filter((l) => b.service_ids.includes(Number(l.service_id)));
      return { matched, sum: sumOf(matched) };
    }
    if (b.min_services && lines.length >= b.min_services) return { matched: lines, sum: sumOf(lines) };
    return null;
  }

  function savingsOf(b, m) {
    if (b.type === 'price') return r2(Math.max(0, m.sum - b.value));           // named services cost this instead
    if (b.type === 'amount') return r2(Math.max(0, Math.min(m.sum, b.value))); // flat money off
    return r2(m.sum * Math.max(0, Math.min(100, b.value)) / 100);
  }

  function labelOf(b) {
    if (b.label) return b.label;
    if (b.name) return b.name;
    if (b.type === 'price') return 'Bundle price';
    if (b.type === 'amount') return 'Bundle discount';
    return `Bundle discount (${b.value}% off ${b.service_ids.length ? 'selected services' : b.min_services + '+ services'})`;
  }

  // Only one bundle ever applies: whichever saves the customer the most. Keeps totals predictable.
  function bestBundle(lines, cap, settings) {
    let best = null;
    for (const b of allBundles(settings)) {
      const m = matchOf(b, lines);
      if (!m) continue;
      const savings = Math.min(cap, savingsOf(b, m));
      if (savings <= 0) continue;
      if (!best || savings > best.savings) best = { savings, label: labelOf(b), bundle: b };
    }
    return best;
  }

  // What adding one more service would unlock, for the nudge under the running total.
  function nextBundle(lines, catalog, settings, currentSavings) {
    const have = idsOf(lines);
    let best = null;
    const consider = (svc, needed, name) => {
      const projected = lines.concat([{ service_id: svc ? svc.id : -1, amount: svc ? startingPrice(svc) : 0 }]);
      const p = bestBundle(projected, sumOf(projected), settings);
      const gain = r2((p ? p.savings : 0) - currentSavings);
      if (gain > 0 && (!best || gain > best.amount)) best = { needed, service: name, amount: gain };
    };
    for (const b of allBundles(settings)) {
      if (b.service_ids.length) {
        const missing = b.service_ids.filter((id) => !have.has(id));
        if (missing.length !== 1) continue;
        const svc = (catalog || []).find((s) => Number(s.id) === missing[0]);
        if (svc) consider(svc, 1, svc.name);
      } else if (b.min_services === lines.length + 1) {
        const rest = (catalog || []).filter((s) => !have.has(Number(s.id)));
        const cheapest = rest.sort((a, z) => startingPrice(a) - startingPrice(z))[0];
        if (cheapest) consider(cheapest, 1, '');
      }
    }
    return best;
  }

  function calculate(catalog, selections, settings) {
    settings = settings || {};
    const byId = new Map((catalog || []).map((s) => [Number(s.id), s]));
    const lines = [];
    const seen = new Set();
    for (const sel of selections || []) {
      const s = byId.get(Number(sel.service_id));
      if (!s || seen.has(s.id)) continue;
      seen.add(s.id);
      lines.push(priceService(s, sel));
    }
    const subtotal = sumOf(lines);
    const applied = bestBundle(lines, subtotal, settings);
    const discount = applied ? applied.savings : 0;
    const discountLabel = applied ? applied.label : '';
    const taxable = Math.max(0, subtotal - discount);
    const tax = r2(taxable * (Number(settings.tax_rate) || 0) / 100);
    const total = r2(taxable + tax);
    let deposit = 0;
    if (settings.deposit_type === 'flat') deposit = Math.min(total, Number(settings.deposit_value) || 0);
    else deposit = Math.min(total, Math.ceil(total * (Number(settings.deposit_value) || 0) / 100));
    return {
      lines, subtotal, discount, discount_label: discountLabel, tax, tax_rate: Number(settings.tax_rate) || 0,
      total, deposit: r2(deposit), next_bundle: lines.length ? nextBundle(lines, catalog, settings, discount) : null,
    };
  }

  function money(n, currency) {
    const v = Number(n) || 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).format(v);
  }

  function startingPrice(service) {
    const g = (service.option_groups || []).find((x) => x.mode === 'base' && (x.choices || []).length);
    let base = g ? Math.min(...g.choices.map((c) => Number(c.price) || 0)) : Number(service.base_price) || 0;
    if (!base) {
      const prices = (service.option_groups || []).flatMap((x) => (x.choices || []).map((c) => Number(c.price) || 0)).filter((n) => n > 0);
      if (prices.length) base = Math.min(...prices);
    }
    const qty = service.pricing_type === 'flat' ? 1 : Math.max(1, Number(service.min_qty) || 1);
    return base * qty;
  }

  return { calculate, priceService, money, startingPrice, allBundles };
});
