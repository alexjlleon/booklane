/* Business profile page: book a call or build a quote */
(function () {
  'use strict';
  const { esc, icons } = BL;
  const biz = BL.data.business, ets = BL.data.eventTypes || [];
  const q = biz.settings.quote;
  const embedQ = BL.data.embed ? '?embed=1' : '';
  const primary = ets[0];
  document.getElementById('app').innerHTML = `<div class="shell"><div class="card profile">
    <div class="profile-hero">${BL.logo(biz)}<h1>${esc(biz.name)}</h1><p>${esc(biz.settings.tagline || '')}</p>
      ${biz.settings.urgency_text ? `<div class="urgency" style="margin:16px auto 0">${esc(biz.settings.urgency_text)}</div>` : ''}</div>
    <div class="path-grid">
      ${primary ? `<a class="path" href="/b/${esc(biz.slug)}/${esc(primary.slug)}${embedQ}"><span class="dot">${icons.phone.replace('<svg', '<svg width="20" height="20"')}</span><h3>Book a call</h3><p>${esc(primary.duration_min)} minute ${esc((primary.location_label || '').toLowerCase())}. Pick a time that works for you.</p><span class="go">Pick a time →</span></a>` : ''}
      ${q.enabled ? `<a class="path" href="/b/${esc(biz.slug)}/quote${embedQ}"><span class="dot">${icons.tag}</span><h3>${esc(q.title)}</h3><p>${esc(q.intro)}</p><span class="go">Start my quote →</span></a>` : ''}
    </div>
    ${ets.length > 1 ? `<div class="section-label">All ways to meet</div><div class="et-list">${ets.map((e) => `<a class="et-row" href="/b/${esc(biz.slug)}/${esc(e.slug)}${embedQ}"><span class="bar" style="background:${esc(e.color)}"></span><div style="flex:1"><h4>${esc(e.name)}</h4><div class="muted small">${e.duration_min} min · ${esc(e.location_label)}</div></div>${icons.right}</a>`).join('')}</div>` : ''}
  </div></div>${BL.powered()}`;
})();
