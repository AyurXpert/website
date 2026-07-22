// promoBanner.js — Session 125, consultant/stakeholder notice board.
//
// Shows the SAME full list of currently-active fee promos on every page
// that includes it -- deliberately not filtered per role/category ("notify
// all concerned stakeholders" was the literal ask, and splitting "which
// categories matter to nursing vs therapist" cleanly isn't worth the
// complexity when everyone can just see the same short list).
//
// Sourced directly from fee_structures -- no separate notice table. A promo
// disappears from here the instant promo_valid_until passes, same
// auto-revert guarantee as js/modules/billing/effectivePrice.js (the two
// deliberately share the same "now() < promo_valid_until" rule).
//
// Dismissal is per-fee, per-browser-session (sessionStorage) -- reappears
// next login, doesn't nag on every page navigation within a session. Same
// pattern as admin.js's tenant-migrations banner (renderMigrationBanner).
function _esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

export async function renderPromoBanner(containerId, { supabase, tenantId }) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const { data, error } = await supabase.from('fee_structures')
    .select('id,label,promo_price,promo_valid_until,promo_reason')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .not('promo_valid_until', 'is', null)
    .gt('promo_valid_until', new Date().toISOString());

  if (error || !data?.length) { el.innerHTML = ''; return; }

  const visible = data.filter(f => !sessionStorage.getItem('ax_dismissed_promo_' + f.id));
  if (!visible.length) { el.innerHTML = ''; return; }

  el.innerHTML = visible.map(f => `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff8e1;border:1.5px solid #e0c060;border-left:4px solid #c9902a;border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:12.5px;color:#7a5c00" data-promo-row="${_esc(f.id)}">
      <div>
        🎁 <strong>${_esc(f.label)}</strong> is now
        <strong>₹${Number(f.promo_price).toLocaleString('en-IN')}</strong>
        until ${new Date(f.promo_valid_until).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' })}
        ${f.promo_reason ? ' — ' + _esc(f.promo_reason) : ''}
      </div>
      <button style="background:none;border:1px solid #c9902a;color:#7a5c00;border-radius:6px;padding:2px 10px;font-size:11px;cursor:pointer;white-space:nowrap" data-promo-dismiss="${_esc(f.id)}">Dismiss</button>
    </div>`).join('');

  el.querySelectorAll('[data-promo-dismiss]').forEach(btn => {
    btn.addEventListener('click', () => {
      sessionStorage.setItem('ax_dismissed_promo_' + btn.dataset.promoDismiss, '1');
      btn.closest('[data-promo-row]')?.remove();
    });
  });
}
