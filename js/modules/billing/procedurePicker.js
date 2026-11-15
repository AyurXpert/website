// procedurePicker.js -- Session 386b-2b M2 (TODO §596 b / d, owner-agreed design 13 Nov 2026; docs/handoff/session386b2b_plan_v3.md §B.3).
//
// The fee list IS the procedure list. On a register form the procedure is picked from the active fees of the procedure groups shown on
// that register (the server's procedure_choices); the fee comes with the procedure and the server sets the record's procedure name from the
// fee (whatever the page sends). A small "Details" box (side / site / size) is saved with the record (procedure_detail).
// Session 386b-2b M2c (owner 15 Nov 2026): a record ALWAYS has a fee from the list ("Not in list" is gone, page and server). When the
// organisation switched "Ask to add a procedure" on (Super Admin → Feature Modules; not set = OFF) the picker offers that button: the name,
// the section, a reason (required) and an optional suggested price go to the Fee committee (request_procedure_name) -- no record and no bill
// line is made; once the procedure is in the list it is recorded as usual. OFF = no button (the server refuses the request too).
// DOM nodes + textContent only (fee labels and typed names are data, never HTML).
import { getEffectivePrice } from './effectivePrice.js';
import { safeErrorMessage } from '../../utils/errors.js';

function _el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

/** H2 (owner 15 Nov 2026): spaces and quote marks off the start and the end of a name -- the same rule as the server (_clean_procedure_name). */
export function cleanProcedureName(s) {
  return String(s ?? '').replace(/^[\s“”"'‘’]+|[\s“”"'‘’]+$/g, '');
}

/** A suggested price as typed: '' = none; else a number > 0, <= 10,00,000, at most 2 decimals (null = not valid). */
export function parseSuggestedPrice(s) {
  const t = String(s ?? '').trim().replace(/,/g, '');
  if (t === '') return { none: true };
  const parts = t.split('.');   // digits, then at most one dot with 1-2 digits (no nested-quantifier regex)
  if (parts.length > 2 || !/^\d+$/.test(parts[0]) || (parts.length === 2 && !/^\d{1,2}$/.test(parts[1]))) return null;
  const n = Number(t);
  return n > 0 && n <= 1000000 ? { value: n } : null;
}

/** The procedures offered on one register (server: procedure_choices). */
export async function loadProcedureChoices(supabase, register) {
  const { data, error } = await supabase.rpc('procedure_choices', { p_register: register });
  return { choices: data || [], error: error || null };
}

// I1 (owner 15 Nov 2026): the "Ask to add a procedure" switch is the server's answer, asked when the form is built AND again whenever the
// page comes back into view (another tab, or the browser's Back button restoring the page from memory) -- never kept beyond that.
// One listener for the page; it refreshes the picker mounted last.
let _refreshAsk = null;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _refreshAsk) _refreshAsk(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted && _refreshAsk) _refreshAsk(); });
}

/** The active procedure groups shown on one register (for "Ask to add a procedure"). */
async function _groupsFor(supabase, tenantId, register) {
  const { data } = await supabase.from('procedure_groups').select('id, display_name, used_on, is_active')
    .eq('tenant_id', tenantId).eq('is_active', true).contains('used_on', [register]).order('sort_order');
  return data || [];
}

/**
 * mountProcedurePicker({ supabase, tenantId, register, select, hide })
 *   select: the page's existing fee <select> -- it becomes the procedure pick-list
 *   hide:   the page's old free-text procedure field rows (hidden)
 * Returns { ready, value(), reset() }.
 */
export function mountProcedurePicker({ supabase, tenantId, register, select, hide = [] }) {
  if (!select) return null;
  for (const h of hide) if (h) h.style.display = 'none';
  let wrap = select.parentElement.querySelector(':scope > .ax-proc-picker');
  if (!wrap) {
    wrap = _el('div', { class: 'ax-proc-picker', style: 'margin-top:6px' });
    select.insertAdjacentElement('afterend', wrap);
  }
  wrap.replaceChildren();
  select.setAttribute('aria-label', 'Procedure (from the fee list)');
  // H8 (owner 15 Nov 2026): a form opened a second time still showed the LAST list -- a choice made from it before the new list arrived
  // was wiped. Nothing can be chosen until this mount's list is in.
  select.replaceChildren(_el('option', { value: '' }, 'Loading the procedure list…'));
  const detail = _el('input', { type: 'text', maxlength: '200', placeholder: 'Details: side / site / size (optional)', 'aria-label': 'Procedure details', style: 'width:100%;min-height:44px;margin-top:6px' });
  // "Ask to add a procedure" (only where the organisation switched it on): a request only, no record
  const askBtn = _el('button', { type: 'button', class: 'btn btn-outline btn-sm', style: 'display:none;margin-top:6px;min-height:44px',
    title: 'Ask the Fee committee to add a procedure that is not in the list (nothing is recorded or billed now)' }, '＋ Ask to add a procedure');
  const askBox = _el('div', { style: 'display:none;margin-top:6px;padding:8px;border:1px dashed var(--gold, #c9902a);border-radius:6px;background:#fffdf5' });
  const askName = _el('input', { type: 'text', maxlength: '120', placeholder: 'Name of the procedure to add', 'aria-label': 'Name of the procedure to add', style: 'width:100%;min-height:44px' });
  const askGrp = _el('select', { 'aria-label': 'Section to add it to', style: 'width:100%;min-height:44px;margin-top:6px' });
  const askWhy = _el('input', { type: 'text', maxlength: '300', placeholder: 'Reason / details (required: who needs it, when)', 'aria-label': 'Reason or details (required)', style: 'width:100%;min-height:44px;margin-top:6px' });
  const askPrice = _el('input', { type: 'text', inputmode: 'decimal', maxlength: '12', placeholder: 'Suggested price ₹ (optional)', 'aria-label': 'Suggested price in rupees (optional)', style: 'width:100%;min-height:44px;margin-top:6px' });
  const askSend = _el('button', { type: 'button', class: 'btn btn-primary btn-sm', style: 'margin-top:6px;min-height:44px' }, 'Send to the Fee committee');
  const askMsg = _el('div', { role: 'status', style: 'font-size:12px;margin-top:6px' });
  askBox.append(_el('div', { style: 'font-size:12px;margin-bottom:4px' },
    'Nothing is recorded and nothing is billed now. When the Fee committee adds the procedure with a price, record it here from the list.'),
    askName, askGrp, askWhy, askPrice, askSend, askMsg);
  askBtn.addEventListener('click', () => { askBox.style.display = askBox.style.display === 'none' ? '' : 'none'; });
  askSend.addEventListener('click', async () => {
    const n = cleanProcedureName(askName.value), why = askWhy.value.trim();
    askName.value = n;   // the user sees the name as it is saved
    const bad = (m) => { askMsg.style.color = 'var(--red, #b03a2e)'; askMsg.setAttribute('role', 'alert'); askMsg.textContent = m; };
    if (n.length < 2 || /[<>]/.test(n) || /^[0-9.,]+$/.test(n)) return bad('Type the name of the procedure (2 to 120 characters, without < or >).');
    if (!askGrp.value) return bad('Choose the section the procedure should be added to.');
    if (why.length < 5 || /[<>]/.test(why)) return bad('Give the reason / details (5 to 300 characters, without < or >).');
    const pr = parseSuggestedPrice(askPrice.value);
    if (!pr) return bad('The suggested price must be more than 0 and at most ₹10,00,000, with at most 2 decimals — or leave it empty.');
    askSend.disabled = true;
    const { error } = await supabase.rpc('request_procedure_name', { p_group: askGrp.value, p_name: n, p_reason: why, p_suggested_price: pr.none ? null : pr.value });
    askSend.disabled = false;
    if (error) return bad(safeErrorMessage(error, 'The request could not be sent.'));
    askMsg.style.color = 'var(--green-deep, #1a4a2e)'; askMsg.setAttribute('role', 'status');
    askMsg.textContent = `Sent: "${n}" — the Fee committee is asked to add it. Record it once it appears in the list.`;
    askName.value = ''; askWhy.value = ''; askPrice.value = '';
  });
  wrap.append(askBtn, askBox, detail);
  let _labels = new Map();
  let _askOn = false;
  const _askSwitch = async () => {   // the server's answer; an error = OFF (the button stays hidden; the server refuses the request anyway)
    const sw = await supabase.rpc('_procedure_not_in_list_on', { p_tenant: tenantId });   // internal name: "Ask to add a procedure" ON / OFF
    _askOn = sw?.data === true;
    askBtn.style.display = _askOn ? '' : 'none';
    if (!_askOn) askBox.style.display = 'none';
  };
  _refreshAsk = () => { _askSwitch().catch(() => {}); };

  const ready = (async () => {
    const [{ choices, error }, groups] = await Promise.all([loadProcedureChoices(supabase, register), _groupsFor(supabase, tenantId, register),
      _askSwitch().catch(() => { _askOn = false; askBtn.style.display = 'none'; })]);
    const keep = select.value;   // H8: a choice made while the list loads is kept
    select.replaceChildren();
    select.appendChild(_el('option', { value: '' }, error ? 'Could not load the procedure list — reload the page' : 'Choose the procedure…'));
    _labels = new Map();
    for (const c of choices) {
      _labels.set(c.id, c.label);
      const price = Number(getEffectivePrice(c)) || 0;
      select.appendChild(_el('option', { value: c.id }, `${c.label} — ₹${price.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`));
    }
    if (keep && _labels.has(keep)) select.value = keep;
    askGrp.replaceChildren(_el('option', { value: '' }, 'Add it to which section?'));
    for (const g of groups) askGrp.appendChild(_el('option', { value: g.id }, g.display_name));
    if (groups.length === 1) askGrp.value = groups[0].id;
  })();

  return {
    ready,
    /** { error } or { feeId, name, detail } */
    value() {
      const v = select.value;
      const d = detail.value.trim();
      if (/[<>]/.test(d)) return { error: 'The details cannot contain < or >.' };
      if (!v || !_labels.has(v)) return { error: _askOn ? 'Choose the procedure from the list. If it is not there, use "Ask to add a procedure".'
                                                        : 'Choose the procedure from the list.' };
      return { feeId: v, name: _labels.get(v) || '', detail: d || null };
    },
    reset() {
      select.value = ''; detail.value = '';
    },
  };
}
