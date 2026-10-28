// pharmacy-dashboard.html -- Session 365a. Read only. Every figure comes from the server (pharmacy_dashboard(), stock_ledger());
// the sales are the pharmacy part of the ONE finance calculation, totalled here by summarisePeriod() (the return-date rule:
// Gross / Returns / Net, Collected = receipts - refunds of the period). Readers (Q12): pharmacist, dept_admin -- the Medical
// Superintendent views only --, accountant, finance_manager, super_admin; the server refuses anyone else.
import { requireAuth, getCurrentTenantId, getCurrentRole, getCurrentProfile } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { localDateStr, todayLocalStr } from '../utils/dateUtils.js';
import { summarisePeriod } from '../modules/billing/billCategory.js';

await requireAuth(['pharmacist', 'dept_admin', 'super_admin', 'accountant', 'finance_manager'], 'login.html');
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const role = getCurrentRole();
const desig = String(getCurrentProfile()?.designation || '').toLowerCase();
const $ = id => document.getElementById(id);
const money = v => '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtD = d => { if (!d) return '—'; const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd} ${MON[Number(m) - 1]} ${y}`; };
const REASON = { opening: 'Opening balance', receipt: 'Goods receipt', receipt_cancel: 'GRN cancelled', sale: 'Sale', customer_return: 'Customer return',
                 adjust: 'Stock adjustment', disposal: 'Disposal', other: 'Other' };

// the MS / MD / Principal see the figures only (no links to the pharmacy's working pages); so do the accounts roles
const VIEW_ONLY_DESIGS = ['medical_superintendent', 'medical_director', 'principal'];
const isWriter = role === 'super_admin' || ((role === 'pharmacist' || role === 'dept_admin') && !VIEW_ONLY_DESIGS.includes(desig));
document.querySelectorAll('[data-writer]').forEach(a => { a.hidden = !isWriter; });

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (v === null || v === undefined) continue; if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  for (const c of kids) if (c !== null && c !== undefined) e.append(c instanceof Node ? c : String(c));
  return e;
}
const empty = msg => el('div', { class: 'empty', text: msg });
function table(head, rows) {
  return el('table', {}, el('thead', {}, el('tr', {}, ...head.map(h => el('th', { class: h.num ? 'num' : null, text: h.t })))),
    el('tbody', {}, ...rows.map(r => el('tr', {}, ...r.map((c, i) => el('td', { class: head[i].num ? 'num' : null }, c))))));
}

// ── the period ──
function setPreset(p) {
  const today = todayLocalStr();
  if (p === 'today') { $('p-from').value = today; $('p-to').value = today; }
  else if (p === '7') { $('p-from').value = localDateStr(new Date(Date.now() - 6 * 86400000)); $('p-to').value = today; }
  else if (p === 'month') { $('p-from').value = today.slice(0, 8) + '01'; $('p-to').value = today; }
  const custom = p === 'custom';
  $('p-from').disabled = !custom; $('p-to').disabled = !custom;
}
$('p-preset').addEventListener('change', e => setPreset(e.target.value));
$('p-go').addEventListener('click', load);

async function load() {
  $('d-err').textContent = '';
  const { data: d, error } = await supabase.rpc('pharmacy_dashboard', { p_from: $('p-from').value, p_to: $('p-to').value });
  if (error || !d) { $('d-err').textContent = safeErrorMessage(error, 'Could not load the pharmacy dashboard.'); return; }

  // sales: the one shared calculation
  const s = summarisePeriod(d.sales?.bills || [], d.sales?.activity || {});
  $('s-gross').textContent = money(s.gross); $('s-bills').textContent = `${s.bills} bill${s.bills === 1 ? '' : 's'}`;
  $('s-returns').textContent = money(s.returns); $('s-rcount').textContent = `${s.returnsCount} return${s.returnsCount === 1 ? '' : 's'} / cancellation${s.returnsCount === 1 ? '' : 's'}`;
  $('s-net').textContent = money(s.net); $('s-coll').textContent = money(s.collected);

  // stock
  const st = d.stock || {};
  $('k-cost').textContent = money(st.value_cost); $('k-mrp').textContent = money(st.value_mrp);
  $('k-batches').textContent = `${st.units || 0} units · ${st.medicines || 0} medicines · ${st.batches || 0} batches${st.no_cost ? ` · ${st.no_cost} batch${st.no_cost === 1 ? '' : 'es'} with no cost price` : ''}`;
  const low = d.low_stock || [];
  $('k-low').textContent = String(low.length);
  $('k-exp').textContent = String(d.expired?.units || 0); $('k-expval').textContent = `${d.expired?.batches || 0} batch${Number(d.expired?.batches) === 1 ? '' : 'es'} · ${money(d.expired?.value_cost)} at cost`;

  $('c-low').replaceChildren(low.length
    ? table([{ t: 'Medicine' }, { t: 'In stock', num: true }, { t: 'Reorder level', num: true }, { t: '' }],
        low.map(m => [m.name + (m.unit ? ` [${m.unit}]` : ''), String(m.stock), String(m.reorder_level),
                      el('span', { class: 'tag ' + (m.out_of_stock ? 'out' : 'low'), text: m.out_of_stock ? 'Out of stock' : 'Low' })]))
    : empty('No medicine is at or below its reorder level.'));

  const ne = d.near_expiry || {};
  const nb = n => `${n || 0} batch${Number(n) === 1 ? '' : 'es'}`;
  const buckets = el('div', { class: 'note', text: `≤ 30 days: ${nb(ne.d30?.batches)} (${ne.d30?.units || 0} units, ${money(ne.d30?.value_cost)}) · 31–60 days: ${nb(ne.d60?.batches)} (${ne.d60?.units || 0} units) · 61–90 days: ${nb(ne.d90?.batches)} (${ne.d90?.units || 0} units)` });
  $('c-exp').replaceChildren(buckets, (ne.items || []).length
    ? table([{ t: 'Medicine' }, { t: 'Batch' }, { t: 'Expiry' }, { t: 'Days', num: true }, { t: 'Units', num: true }],
        ne.items.map(i => [i.name, i.batch_number || '—', fmtD(i.expiry_date), String(i.days), String(i.units)]))
    : empty('Nothing expires within 90 days.'));

  $('c-expired').replaceChildren((d.expired?.items || []).length
    ? table([{ t: 'Medicine' }, { t: 'Batch' }, { t: 'Expired' }, { t: 'Units', num: true }],
        d.expired.items.map(i => [i.name, i.batch_number || '—', fmtD(i.expiry_date), String(i.units)]))
    : empty('No expired stock on the shelf.'),
    el('div', { class: 'note', text: 'Expired stock is removed through Inventory → ± → Expiry disposal (the disposal register, with a witness).' }));

  const tq = d.top?.by_qty || [], tv = d.top?.by_value || [];
  $('c-topq').replaceChildren(tq.length ? table([{ t: 'Medicine' }, { t: 'Qty', num: true }, { t: 'Value', num: true }], tq.map(t => [t.name, String(t.qty), money(t.value)])) : empty('No pharmacy sales in this period.'),
    el('div', { class: 'note', text: 'Sold in the period less the returns completed in the period (a cancelled bill is left out).' }));
  $('c-topv').replaceChildren(tv.length ? table([{ t: 'Medicine' }, { t: 'Value', num: true }, { t: 'Qty', num: true }], tv.map(t => [t.name, money(t.value), String(t.qty)])) : empty('No pharmacy sales in this period.'));

  $('c-ret').replaceChildren(
    el('div', {}, el('strong', { text: String(d.pending_returns || 0) }), ' customer return(s) waiting for approval'),
    el('div', { style: 'margin-top:6px' }, el('strong', { text: String(d.refunds_due?.count || 0) }), ` credit-note cash refund(s) due — ${money(d.refunds_due?.amount)}`),
    el('div', { class: 'note', text: 'Approvals and refund payouts are done in the POS (Returns / Bills).' }));

  const pu = d.purchases || {};
  $('c-pur').replaceChildren(
    el('div', {}, el('strong', { text: String(pu.count || 0) }), ` goods receipt(s) in the period — taxable ${money(pu.taxable)}, GST ${money(pu.tax)}, total ${money(pu.total)}`),
    el('div', { style: 'margin-top:6px' }, 'Input tax credit on them: ', el('strong', { text: money(pu.itc) })),
    el('div', { class: 'note', text: 'Supplier dues and ageing come with supplier payments (session 365c); open purchase orders with session 365d.' }));

  $('ledger-check').textContent = Number(d.ledger_unbalanced) === 0
    ? '✓ The stock ledger balances: every batch’s movements add up to its stock.'
    : `⚠ ${d.ledger_unbalanced} batch(es) whose ledger does not add up to the stock — report this to support.`;
}

// ── the stock ledger of one medicine ──
async function loadMedicines() {
  const { data } = await supabase.from('medicines').select('id, name, unit').eq('tenant_id', tenantId).eq('is_active', true).order('name');
  $('l-med').replaceChildren(el('option', { value: '', text: '— Choose —' }),
    ...(data || []).map(m => el('option', { value: m.id, text: m.unit ? `${m.name} [${m.unit}]` : m.name })));
}
$('l-go').addEventListener('click', async () => {
  const mid = $('l-med').value;
  if (!mid) { $('c-ledger').replaceChildren(empty('Choose a medicine.')); return; }
  const { data, error } = await supabase.rpc('stock_ledger', { p_medicine: mid, p_from: $('p-from').value, p_to: $('p-to').value });
  if (error || !data) { $('c-ledger').replaceChildren(el('div', { class: 'err', text: safeErrorMessage(error, 'Could not load the stock ledger.') })); return; }
  const batches = data.batches || [];
  if (!batches.length) { $('c-ledger').replaceChildren(empty('This medicine has no stock batches.')); return; }
  const parts = [];
  for (const b of batches) {
    parts.push(el('div', { style: 'margin-top:10px;font-weight:600;color:var(--green-deep)',
      text: `Batch ${b.batch_number || '(opening stock)'}${b.expiry_date ? ' · exp ' + fmtD(b.expiry_date) : ''} — opening ${b.opening}, in ${b.in}, out ${b.out}, closing ${b.closing}${b.has_ledger ? '' : ' (no movement since the ledger started)'}` }));
    if ((b.rows || []).length) {
      parts.push(table([{ t: 'Date' }, { t: 'What' }, { t: 'Ref.' }, { t: 'Qty', num: true }, { t: 'Balance', num: true }, { t: 'By' }],
        b.rows.map(r => [fmtD(r.date), (REASON[r.reason] || r.reason) + (r.note ? ` — ${r.note}` : ''), r.ref_no || '—',
                         (r.qty > 0 ? '+' : '') + r.qty, String(r.after), r.by || '—'])));
    }
  }
  $('c-ledger').replaceChildren(...parts);
});

setPreset('today');
await Promise.all([load(), loadMedicines()]);
