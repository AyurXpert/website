// Session 306 — "Correct entry" for statutory registers.
// A register entry is never edited or deleted (sql/session306_statutory_registers_lockdown.sql):
// a mistake is fixed by a NEW entry that names the one it corrects (corrects_id) and gives a
// reason. The server numbers every entry per organisation (entry_no) and marks the corrected one
// (superseded_by / superseded_by_no); lists show it struck through, totals skip it.
//
// Usage on a page:
//   initCorrections(supabase, tenantId);
//   defineCorrection('bmw_pickups', { title:'CBWTF pickup', canWrite, reload: loadPickups, fields:[…] });
//   row html:  `<tr class="${corrRowClass(r)}"><td>…${corrCell('bmw_pickups', r)}</td>…`
//   totals:    activeRows(rows)   ·   aggregate queries: .is('superseded_by', null)
// Lists that select explicit columns must add CORR_COLS.

import { safeErrorMessage } from '../../utils/errors.js';

export const CORR_COLS = 'entry_no,corrects_id,corrects_no,correction_reason,superseded_by,superseded_by_no';

// never copied from the original into the correcting entry
const SYSTEM_COLS = ['id', 'created_at', 'entered_by', 'entry_no', 'corrects_id', 'corrects_no',
  'correction_reason', 'superseded_by', 'superseded_by_no'];

let _sb = null, _tenantId = null;
const _defs = {};
let _active = null;          // { table, original }

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initCorrections(supabase, tenantId) {
  _sb = supabase; _tenantId = tenantId;
  if (document.getElementById('reg-corr-style')) return;
  const st = document.createElement('style');
  st.id = 'reg-corr-style';
  st.textContent = `
    tr.reg-superseded > td { text-decoration: line-through; opacity: .6 }
    .reg-meta { display:inline-block; text-decoration:none; margin-top:4px; font-size:11px; line-height:1.4; font-weight:500 }
    .reg-no { color: var(--text-muted,#6b7c72) }
    .reg-by { color: var(--purple,#8b1a6b); font-weight:700 }
    .reg-fix { color: var(--blue,#1a4080) }
    .reg-correct-btn { display:inline-block; text-decoration:none; min-height:44px; min-width:44px; margin-top:4px; padding:0 12px;
      border:1.5px solid var(--gold,#c9902a); background:#fffaf0; color:#7a5310; border-radius:7px; font:600 12px 'DM Sans',sans-serif; cursor:pointer }
    .reg-correct-btn:focus-visible { outline:3px solid var(--gold,#c9902a); outline-offset:2px }
    #reg-corr-overlay { position:fixed; inset:0; background:rgba(15,30,20,.45); display:none; align-items:flex-start; justify-content:center; z-index:1200; overflow-y:auto; padding:24px 16px }
    #reg-corr-overlay.open { display:flex }
    #reg-corr-box { background:#fff; border-radius:12px; width:100%; max-width:560px; padding:20px 22px; box-shadow:0 10px 40px rgba(0,0,0,.25); font-family:'DM Sans',sans-serif }
    #reg-corr-box h2 { font-family:'Cormorant Garamond',serif; font-size:22px; color:var(--green-deep,#1a4a2e); margin:0 0 4px }
    #reg-corr-box .sub { font-size:12px; color:var(--text-muted,#6b7c72); margin-bottom:14px }
    #reg-corr-box .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px 14px }
    #reg-corr-box label { display:block; font-size:12px; font-weight:600; color:var(--text-mid,#3d5a47); margin-bottom:4px }
    #reg-corr-box input, #reg-corr-box select, #reg-corr-box textarea { width:100%; box-sizing:border-box; min-height:40px; border:1.5px solid var(--border,#d8e4dc); border-radius:7px; padding:6px 10px; font:13px 'DM Sans',sans-serif }
    #reg-corr-box input[type=checkbox] { width:auto; min-height:0 }
    #reg-corr-box .full { grid-column:1/-1 }
    #reg-corr-box .reason { margin-top:14px; padding:12px; background:#fffaf0; border:1.5px solid var(--gold,#c9902a); border-radius:8px }
    #reg-corr-box .err { color:var(--red,#b91c1c); font-size:13px; margin-top:10px; min-height:18px }
    #reg-corr-box .actions { display:flex; gap:10px; justify-content:flex-end; margin-top:14px }
    #reg-corr-box .actions button { min-height:44px; padding:0 18px; border-radius:8px; font:600 13px 'DM Sans',sans-serif; cursor:pointer }
    #reg-corr-box .btn-cancel { background:#fff; border:1.5px solid var(--border,#d8e4dc) }
    #reg-corr-box .btn-save { background:var(--green-deep,#1a4a2e); color:#fff; border:none }
  `;
  document.head.appendChild(st);

  const ov = document.createElement('div');
  ov.id = 'reg-corr-overlay';
  ov.innerHTML = `<div id="reg-corr-box" role="dialog" aria-modal="true" aria-labelledby="reg-corr-title">
      <h2 id="reg-corr-title">Correct entry</h2>
      <div class="sub" id="reg-corr-sub"></div>
      <div class="grid" id="reg-corr-fields"></div>
      <div class="reason">
        <label for="reg-corr-reason">Reason for correction (required)</label>
        <textarea id="reg-corr-reason" rows="2" maxlength="500" placeholder="e.g. Weight entered in grams instead of kg"></textarea>
      </div>
      <div class="err" id="reg-corr-err" role="alert"></div>
      <div class="actions">
        <button type="button" class="btn-cancel" data-onclick="closeRegisterCorrection">Cancel</button>
        <button type="button" class="btn-save" id="reg-corr-save" data-onclick="saveRegisterCorrection">Save correction</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) window.closeRegisterCorrection(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && ov.classList.contains('open')) window.closeRegisterCorrection(); });
}

// cfg: { title, canWrite, reload, fields:[{k,label,type,options,full}], mode:'copy'|'reverse' }
export function defineCorrection(table, cfg) {
  _defs[table] = { mode: 'copy', fields: [], ...cfg };
}

export function corrRowClass(r) {
  return r?.superseded_by ? 'reg-superseded' : '';
}

export function activeRows(rows) {
  return (rows || []).filter(r => !r.superseded_by);
}

// Serial number + correction notes + the Correct button, placed inside a row's first cell.
export function corrCell(table, r) {
  const d = _defs[table];
  if (!r) return '';
  const parts = [];
  if (r.entry_no != null) parts.push(`<span class="reg-meta reg-no">#${_esc(r.entry_no)}</span>`);
  if (r.superseded_by) {
    parts.push(`<span class="reg-meta reg-by">✎ Corrected by #${_esc(r.superseded_by_no ?? '—')}</span>`);
  }
  if (r.corrects_id) {
    parts.push(`<span class="reg-meta reg-fix" title="${_esc(r.correction_reason)}">↳ Corrects #${_esc(r.corrects_no ?? '—')}: ${_esc(r.correction_reason)}</span>`);
  }
  const reversal = d?.mode === 'reverse' && r.transaction_type === 'correction';
  if (d?.canWrite && !r.superseded_by && !reversal) {
    parts.push(`<button type="button" class="reg-correct-btn" data-onclick="openRegisterCorrection" data-onclick-a0="${_esc(table)}" data-onclick-a1="${_esc(r.id)}" aria-label="Correct entry #${_esc(r.entry_no ?? '')}">Correct</button>`);
  }
  return parts.length ? '<br>' + parts.join('<br>') : '';
}

function _inputHtml(f, val) {
  const id = 'reg-corr-f-' + f.k;
  const cls = f.full || f.type === 'textarea' ? ' class="full"' : '';
  let ctl;
  if (f.type === 'select') {
    const opts = (f.options || []).map(o => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return `<option value="${_esc(v)}"${String(val ?? '') === String(v) ? ' selected' : ''}>${_esc(l)}</option>`;
    }).join('');
    ctl = `<select id="${id}"><option value="">—</option>${opts}</select>`;
  } else if (f.type === 'textarea') {
    ctl = `<textarea id="${id}" rows="2">${_esc(val)}</textarea>`;
  } else if (f.type === 'checkbox') {
    return `<div${cls}><label><input type="checkbox" id="${id}"${val ? ' checked' : ''}> ${_esc(f.label)}</label></div>`;
  } else {
    const t = f.type || 'text';
    let v = val ?? '';
    if (t === 'time' && v) v = String(v).slice(0, 5);
    ctl = `<input id="${id}" type="${t}"${t === 'number' ? ' step="any"' : ''} value="${_esc(v)}">`;
  }
  return `<div${cls}><label for="${id}">${_esc(f.label)}</label>${ctl}</div>`;
}

function _readField(f) {
  const el = document.getElementById('reg-corr-f-' + f.k);
  if (!el) return undefined;
  if (f.type === 'checkbox') return el.checked;
  const v = el.value.trim();
  if (v === '') return null;
  if (f.type === 'number') return Number(v);
  return v;
}

window.openRegisterCorrection = async function (table, id) {
  const d = _defs[table];
  if (!d || !_sb) return;
  const { data, error } = await _sb.from(table).select('*').eq('id', id).eq('tenant_id', _tenantId).maybeSingle();
  if (error || !data) { alert(safeErrorMessage(error, 'Could not load this entry.')); return; }
  if (data.superseded_by) { alert(`This entry has already been corrected by #${data.superseded_by_no}.`); return; }
  _active = { table, original: data };
  document.getElementById('reg-corr-title').textContent = `Correct ${d.title} #${data.entry_no ?? ''}`;
  document.getElementById('reg-corr-sub').textContent = d.mode === 'reverse'
    ? 'This cancels the entry by adding a reversing entry (the quantity goes back into the running balance). The original stays in the register, struck through. Then add the correct entry as normal.'
    : 'A new entry is added with the values below. The original stays in the register, struck through, marked "corrected by".';
  document.getElementById('reg-corr-fields').innerHTML = d.mode === 'reverse' ? '' : d.fields.map(f => _inputHtml(f, data[f.k])).join('');
  document.getElementById('reg-corr-reason').value = '';
  document.getElementById('reg-corr-err').textContent = '';
  document.getElementById('reg-corr-save').disabled = false;
  document.getElementById('reg-corr-overlay').classList.add('open');
  (document.querySelector('#reg-corr-fields input, #reg-corr-fields select, #reg-corr-fields textarea') || document.getElementById('reg-corr-reason')).focus();
};

window.closeRegisterCorrection = function () {
  document.getElementById('reg-corr-overlay')?.classList.remove('open');
  _active = null;
};

window.saveRegisterCorrection = async function () {
  if (!_active) return;
  const { table, original } = _active;
  const d = _defs[table];
  const err = document.getElementById('reg-corr-err');
  const reason = document.getElementById('reg-corr-reason').value.trim();
  if (reason.length < 5) { err.textContent = 'Please give a reason (at least 5 characters).'; document.getElementById('reg-corr-reason').focus(); return; }

  let payload;
  if (d.mode === 'reverse') {
    payload = { tenant_id: original.tenant_id, medicine_id: original.medicine_id, medicine_name: original.medicine_name,
      unit: original.unit, transaction_type: 'correction', quantity: original.quantity, balance: 0 };
  } else {
    payload = {};
    for (const [k, v] of Object.entries(original)) {
      if (SYSTEM_COLS.includes(k)) continue;
      payload[k] = v;
    }
    d.fields.forEach(f => { const v = _readField(f); if (v !== undefined) payload[f.k] = v; });
  }
  payload.corrects_id = original.id;
  payload.correction_reason = reason;

  const btn = document.getElementById('reg-corr-save');
  btn.disabled = true;
  const { error } = await _sb.from(table).insert(payload);
  btn.disabled = false;
  if (error) { err.textContent = safeErrorMessage(error, 'Could not save the correction.'); return; }
  window.closeRegisterCorrection();
  try { await d.reload?.(); } catch (e) { console.error(e); }
};
