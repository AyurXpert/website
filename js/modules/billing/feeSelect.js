// feeSelect.js -- Session 386b-2a (§540).
//
// The optional "Fee" dropdown of the forms whose IPD charge the server posts on completion (imaging, Major / Minor OT,
// Kshara Sutra, Kriya Kalpa, Anushastra, ipd.html OT procedures). The page only offers the organisation's own active fees of
// the right category; the server checks the fee again (own organisation, active, right category) and decides the price.
// Rehearsal fix 2 (owner, 13 Nov 2026): a procedure register offers ONLY the fees whose Register is that register
// (fee_structures.procedure_register, set in Fee Structure); an untagged procedure fee is offered nowhere -- the server refuses
// another register's fee anyway (_fee_fits).
// No fee chosen = the server raises an "unpriced item" for billing when the work is completed (never billed at ₹0).
// Options are built as DOM nodes with textContent (fee labels are data, never HTML).
import { getEffectivePrice } from './effectivePrice.js';

export const NO_FEE_TEXT = 'No fee chosen — billing will be asked to price it';

// The registers a procedure fee can belong to (the values the server accepts) and their names.
export const PROCEDURE_REGISTERS = [
  ['major_ot', 'Major OT'], ['minor_ot', 'Minor OT'], ['kriya_kalpa', 'Kriya Kalpa'], ['anushastra', 'Anushastra'],
  ['kshara_sutra', 'Kshara Sutra'], ['ipd_ot_procedure', 'IPD OT procedure'], ['panchakarma', 'Panchakarma'], ['other', 'Other'],
];
export const registerName = r => (PROCEDURE_REGISTERS.find(x => x[0] === r) || [null, '—'])[1];
// the register of each source table (the same map as the server's _fee_register_of)
export const TABLE_REGISTER = {
  ot_cases: 'major_ot', minor_ot_procedures: 'minor_ot', kriyakalpa_sessions: 'kriya_kalpa', anushastra_sessions: 'anushastra',
  ks_sessions: 'kshara_sutra', ks_thread_changes: 'kshara_sutra', ot_procedures: 'ipd_ot_procedure',
};

// The organisation's active fees of these categories (e.g. ['procedure'] or ['radiology']), sorted by label;
// opts.register (a procedure register) = only that register's procedure fees.
export async function loadFees(supabase, tenantId, categories, opts = {}) {
  if (!tenantId) return { fees: [], error: null };
  let q = supabase.from('fee_structures')
    .select('id,label,category,amount,promo_price,promo_valid_until,procedure_register')
    .eq('tenant_id', tenantId).eq('is_active', true).in('category', categories);
  if (opts.register) q = q.eq('procedure_register', opts.register);
  const { data, error } = await q.order('label', { ascending: true });
  return { fees: data || [], error: error || null };
}

export function feeOptionText(fee) {
  const price = Number(getEffectivePrice(fee)) || 0;
  return (fee.label || 'Fee') + ' — ₹' + price.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

// Fills a <select> with an empty first option (emptyText) + one option per fee. Keeps the current choice when it is still listed.
export function fillFeeSelect(select, fees, { emptyText = NO_FEE_TEXT, keep = true } = {}) {
  if (!select) return;
  const prev = keep ? select.value : '';
  select.replaceChildren();
  const none = document.createElement('option');
  none.value = '';
  none.textContent = emptyText;
  select.appendChild(none);
  for (const f of fees || []) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = feeOptionText(f);
    select.appendChild(o);
  }
  select.value = prev && (fees || []).some(f => f.id === prev) ? prev : '';
}

// Loads and fills in one step (a failed load leaves only the "no fee" choice -- the form still works, billing prices it later).
export async function loadFeeSelect(supabase, tenantId, select, categories, opts = {}) {
  const { fees, error } = await loadFees(supabase, tenantId, categories, { register: opts.register });
  fillFeeSelect(select, error ? [] : fees, opts);
  return { fees, error };
}

// The chosen fee id, or null.
export function feeIdOf(selectOrId) {
  const el = typeof selectOrId === 'string' ? document.getElementById(selectOrId) : selectOrId;
  return (el && el.value) ? el.value : null;
}
