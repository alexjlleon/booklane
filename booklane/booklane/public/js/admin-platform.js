/* Admin views: every company on the platform. Only the platform admin gets here. */
(function () {
  'use strict';
  const { esc, api, $$ } = A;

  const status = (c) => {
    if (c.suspended_at) return '<span class="pill lost">Suspended</span>';
    if (!c.activated) return '<span class="pill partial">Email not confirmed</span>';
    return c.access === 'full' ? '<span class="pill booked">Full access</span>' : '<span class="pill quoted">New, not approved</span>';
  };
  const row = (c) => `<tr><td data-label="Company"><b>${esc(c.name)}</b><div class="small muted">/b/${esc(c.slug)}</div></td>
    <td data-label="Owner">${esc(c.owner_name || '')}<div class="small muted">${esc(c.owner_email || '')}</div></td>
    <td data-label="Signed up">${esc(String(c.created_at || '').slice(0, 10))}</td>
    <td data-label="Bookings">${c.bookings}</td>
    <td data-label="Status">${status(c)}</td>
    <td data-label="Actions"><div class="row" style="gap:6px;flex-wrap:wrap">
      <button class="btn btn-ghost btn-sm" data-co="${c.id}" data-set="access" data-val="${c.access === 'full' ? 'starter' : 'full'}">${c.access === 'full' ? 'Remove approval' : 'Approve'}</button>
      <button class="btn btn-ghost btn-sm" data-co="${c.id}" data-set="suspended" data-val="${c.suspended_at ? 'false' : 'true'}">${c.suspended_at ? 'Restore' : 'Suspend'}</button>
    </div></td></tr>`;

  A.route('/companies', {
    title: 'Companies',
    async render() {
      if (!A.me.platform_admin) return '<div class="panel"><div class="empty-state"><h3>Not available</h3></div></div>';
      const { companies } = await api('GET', '/platform/companies');
      return `<div class="topbar"><div><h1>Companies</h1><div class="sub">Everyone on the platform. New companies get booking pages and limited email. Approving also turns on texting and their own domain.</div></div></div>
        <div class="panel table-wrap"><table class="t"><thead><tr><th>Company</th><th>Owner</th><th>Signed up</th><th>Bookings</th><th>Status</th><th></th></tr></thead>
        <tbody>${companies.map(row).join('')}</tbody></table></div>`;
    },
    mount(root) {
      $$('[data-co]', root).forEach((btn) => btn.addEventListener('click', async () => {
        btn.disabled = true;
        const val = btn.dataset.set === 'suspended' ? btn.dataset.val === 'true' : btn.dataset.val;
        try { await api('PATCH', `/platform/companies/${btn.dataset.co}`, { [btn.dataset.set]: val }); A.render(); } catch (e) { A.toast(e.message, true); btn.disabled = false; }
      }));
    },
  });
})();
