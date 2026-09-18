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
    const subtotal = r2(lines.reduce((a, l) => a + l.amount, 0));
    let discount = 0, discountLabel = '';
    const tiers = (settings.bundle_discounts || []).filter((t) => lines.length >= Number(t.min_services) && Number(t.percent) > 0)
      .sort((a, b) => Number(b.percent) - Number(a.percent));
    if (tiers.length) { discount = r2(subtotal * Number(tiers[0].percent) / 100); discountLabel = tiers[0].label || `Bundle discount (${tiers[0].percent}% off ${tiers[0].min_services}+ services)`; }
    const taxable = Math.max(0, subtotal - discount);
    const tax = r2(taxable * (Number(settings.tax_rate) || 0) / 100);
    const total = r2(taxable + tax);
    let deposit = 0;
    if (settings.deposit_type === 'flat') deposit = Math.min(total, Number(settings.deposit_value) || 0);
    else deposit = Math.min(total, Math.ceil(total * (Number(settings.deposit_value) || 0) / 100));
    // Upsell hint: how many more services unlock the next bundle tier
    const next = (settings.bundle_discounts || []).filter((t) => Number(t.min_services) > lines.length).sort((a, b) => a.min_services - b.min_services)[0];
    return {
      lines, subtotal, discount, discount_label: discountLabel, tax, tax_rate: Number(settings.tax_rate) || 0, total, deposit: r2(deposit),
      next_bundle: next ? { needed: Number(next.min_services) - lines.length, percent: Number(next.percent) } : null,
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

  return { calculate, priceService, money, startingPrice };
});
