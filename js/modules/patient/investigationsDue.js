// Follow-up consultation layout, phase 4b (Session 295) -- "⏳ Investigations advised
// last visit" card on doctor.html's History tab + outside-lab result entry.
//
// Agreed with Dr. Venkatesh: reception usually never knows tests were advised; the
// clinician seeing the follow-up (doctor / PG / intern) looks at the previous visit, asks
// the patient, and records an outside lab's result right here, in today's consultation.
// Optional photo/PDF of the report goes to the private 'lab-reports' bucket
// (<tenant>/<patient>/<order>/<file>, clinical roles of the same hospital only).
//
// Shows, for this department: every lab order from the most recent previous visit, plus
// any older "before next visit" order still not done; and last visit's free-text
// "Lab / Imaging advised" notes (doctors often type these instead of placing an order).

let _ctx = null;            // { supabase, esc, tenantId, patientId, currentVisitId, userId }
let _orders = [];           // orders shown in the card
let _modalOrder = null;     // order being completed, or null = new outside report
let _token = 0;

const _fmtD = d => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d)
  .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const _todayStr = () => new Date().toLocaleDateString('en-CA');

export function resetInvestigationsDue() {
  _token++; _orders = []; _ctx = null;
  const card = document.getElementById('inv-due-card');
  if (card) { card.hidden = true; document.getElementById('inv-due-body').innerHTML = ''; }
}

export async function loadInvestigationsDue(ctx) {
  const token = ++_token;
  _ctx = ctx;
  const { supabase, esc, prevVisits } = ctx;
  const card = document.getElementById('inv-due-card');
  if (!card) return;
  if (!prevVisits?.length) { card.hidden = true; return; }
  const last = prevVisits[0];
  const ids = prevVisits.map(v => v.id);
  const SEL = 'id, visit_id, status, order_date, due_timing, due_by, payment_status, performed_outside, outside_lab_name, outside_report_date, outside_report_path, review_status, lab_order_items(id, test_name, panel_label, result_value, result_unit, reference_range, is_abnormal, is_critical)';
  const [oR, nR, tR] = await Promise.all([
    supabase.from('lab_orders').select(SEL)
      .eq('tenant_id', ctx.tenantId).in('visit_id', ids).order('created_at', { ascending: true }),
    supabase.from('consultation_notes').select('inv_lab, inv_imaging, review_status, is_deleted')
      .eq('visit_id', last.id).order('created_at', { ascending: false }),
    // Outside reports added during THIS consultation ("+ Add outside report") live on
    // today's visit -- list them too, so the doctor sees what was just recorded.
    supabase.from('lab_orders').select(SEL)
      .eq('tenant_id', ctx.tenantId).eq('visit_id', ctx.currentVisitId).eq('performed_outside', true)
      .order('created_at', { ascending: true }),
  ]);
  if (token !== _token) return;
  if (oR.error) console.warn('[investigations due]', oR.error.message);
  const notes = (nR.data || []).find(n => !n.is_deleted && (!n.review_status || n.review_status === 'finalized')) || {};
  _orders = (oR.data || []).filter(o => (!o.review_status || o.review_status === 'finalized')
    && (o.visit_id === last.id || (o.due_timing === 'next_visit' && o.status !== 'completed')))
    .concat(tR.data || []);

  const text = [['Lab advised', notes.inv_lab], ['Imaging advised', notes.inv_imaging]]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `<div class="inv-note"><span class="inv-note-k">${k} (as written):</span> ${esc(v)}</div>`).join('');

  if (!_orders.length && !text) { card.hidden = true; return; }
  document.getElementById('inv-due-ref').textContent = `advised ${_fmtD(last.created_at)}`;
  document.getElementById('inv-due-body').innerHTML =
    (_orders.length ? _orders.map(o => _orderRow(o, esc)).join('') : '<div class="inv-empty">No lab order was placed last visit.</div>') + text;
  card.hidden = false;
}

function _testsSummary(o, esc) {
  const items = o.lab_order_items || [];
  const withResult = items.filter(i => i.result_value !== null && i.result_value !== '');
  if (withResult.length) {
    return withResult.map(i => `<span class="inv-res${i.is_critical ? ' crit' : i.is_abnormal ? ' abn' : ''}">${esc(i.test_name)} <strong>${esc(i.result_value)}</strong>${i.result_unit ? ' ' + esc(i.result_unit) : ''}${i.is_critical ? ' ⚠ critical' : i.is_abnormal ? ' ⚠' : ''}</span>`).join(' · ');
  }
  const byPanel = {}, single = [];
  items.forEach(i => i.panel_label ? (byPanel[i.panel_label] = 1) : single.push(i.test_name));
  return esc([...Object.keys(byPanel), ...single].join(', ') || '—');
}

function _orderRow(o, esc) {
  let status, action = '';
  if (o.status === 'completed' && o.performed_outside) {
    status = `<span class="inv-st ok">✅ Outside lab: ${esc(o.outside_lab_name || '—')}${o.outside_report_date ? ' · ' + _fmtD(o.outside_report_date) : ''}</span>`;
    if (o.outside_report_path) action = `<button type="button" class="inv-btn" data-onclick="openLabReportFile" data-onclick-a0="${esc(o.outside_report_path)}">📄 Report</button>`;
  } else if (o.status === 'completed') {
    status = '<span class="inv-st ok">✅ Report ready (our lab)</span>';
  } else if (o.payment_status === 'pending' && o.status === 'pending') {
    status = `<span class="inv-st no">❌ Not done yet${o.due_by ? ' · was due ' + _fmtD(o.due_by) : ''}</span>`;
    action = `<button type="button" class="inv-btn inv-btn-primary" data-onclick="openOutsideResult" data-onclick-a0="${o.id}">Enter outside result</button>`;
  } else {
    status = '<span class="inv-st wait">⏳ In progress at our lab</span>';
  }
  return `<div class="inv-row">
    <div class="inv-main">
      <div class="inv-tests">🧪 ${_testsSummary(o, esc)}</div>
      <div class="inv-meta">${status}${o.due_timing === 'next_visit' ? ' <span class="inv-tag">📅 advised for next visit</span>' : ''}</div>
      ${o.status === 'pending' && o.payment_status === 'pending' ? '<div class="inv-hint">Or send the patient to reception to pay and have it done at our lab today.</div>' : ''}
    </div>
    ${action ? `<div class="inv-act">${action}</div>` : ''}
  </div>`;
}

// ── Outside-lab result modal ────────────────────────────────────────────────
function _itemRow(it, editableName, esc) {
  return `<div class="oor-row"${it.id ? ` data-item-id="${it.id}"` : ''}>
    <input type="text" class="oor-test" value="${esc(it.test_name || '')}" placeholder="Test name" aria-label="Test name" ${editableName ? '' : 'readonly'}>
    <input type="text" class="oor-val" placeholder="Result" aria-label="Result for ${esc(it.test_name || 'test')}">
    <input type="text" class="oor-unit" placeholder="Unit" aria-label="Unit">
    <input type="text" class="oor-ref" placeholder="Normal range" aria-label="Normal range">
    <label class="oor-abn"><input type="checkbox" class="oor-abn-chk"> Abnormal</label>
    ${editableName ? '<button type="button" class="oor-rm" data-onclick="oorRemoveRow" data-onclick-a0="@this" aria-label="Remove test">✕</button>' : '<span></span>'}
  </div>`;
}

window.openOutsideResult = function(orderId) {
  if (!_ctx) return;
  const { esc } = _ctx;
  _modalOrder = orderId ? _orders.find(o => o.id === orderId) || null : null;
  document.getElementById('oor-title').textContent = _modalOrder ? 'Enter outside lab result' : 'Add outside lab report';
  document.getElementById('oor-lab').value = '';
  const date = document.getElementById('oor-date');
  date.value = ''; date.max = _todayStr();
  document.getElementById('oor-file').value = '';
  document.getElementById('oor-err').textContent = '';
  document.getElementById('oor-rows').innerHTML = _modalOrder
    ? (_modalOrder.lab_order_items || []).map(i => _itemRow(i, false, esc)).join('')
    : _itemRow({}, true, esc);
  document.getElementById('oor-add-row').hidden = !!_modalOrder;
  document.getElementById('oor-overlay').style.display = 'flex';
  document.getElementById('oor-lab').focus();
};
window.closeOutsideResult = function() { document.getElementById('oor-overlay').style.display = 'none'; _modalOrder = null; };
window.oorAddRow = function() {
  document.getElementById('oor-rows').insertAdjacentHTML('beforeend', _itemRow({}, true, _ctx.esc));
  document.querySelector('#oor-rows .oor-row:last-child .oor-test')?.focus();
};
window.oorRemoveRow = function(btn) { btn.closest('.oor-row')?.remove(); };

window.saveOutsideResult = async function() {
  if (!_ctx) return;
  const { supabase, tenantId, patientId, currentVisitId, userId } = _ctx;
  const err = document.getElementById('oor-err');
  const lab = document.getElementById('oor-lab').value.trim();
  const date = document.getElementById('oor-date').value;
  const rows = [...document.querySelectorAll('#oor-rows .oor-row')].map(r => ({
    id: r.dataset.itemId || null,
    test_name: r.querySelector('.oor-test').value.trim(),
    result_value: r.querySelector('.oor-val').value.trim(),
    result_unit: r.querySelector('.oor-unit').value.trim() || null,
    reference_range: r.querySelector('.oor-ref').value.trim() || null,
    is_abnormal: r.querySelector('.oor-abn-chk').checked,
  }));
  const filled = rows.filter(r => r.test_name && r.result_value);
  const file = document.getElementById('oor-file').files[0] || null;
  if (!lab) { err.textContent = 'Enter the outside lab\'s name.'; return; }
  if (!date) { err.textContent = 'Enter the report date.'; return; }
  if (date > _todayStr()) { err.textContent = 'Report date cannot be in the future.'; return; }
  if (!filled.length && !file) { err.textContent = 'Enter at least one result, or attach the report.'; return; }
  if (file && !/^(image\/|application\/pdf$)/.test(file.type)) { err.textContent = 'Attach a photo or a PDF.'; return; }
  if (file && file.size > 10 * 1024 * 1024) { err.textContent = 'The file is larger than 10 MB.'; return; }

  const btn = document.getElementById('oor-save');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  const now = new Date().toISOString();
  try {
    let orderId = _modalOrder?.id;
    const outside = {
      performed_outside: true, status: 'completed', outside_lab_name: lab, outside_report_date: date,
      outside_entered_by: userId, outside_entered_at: now, outside_entered_visit_id: currentVisitId,
      result_entered_at: now,
    };
    if (orderId) {
      const { error } = await supabase.from('lab_orders').update(outside).eq('id', orderId);
      if (error) throw error;
      for (const r of filled.filter(x => x.id)) {
        const { error: e2 } = await supabase.from('lab_order_items').update({
          result_value: r.result_value, result_unit: r.result_unit, reference_range: r.reference_range,
          is_abnormal: r.is_abnormal, entered_by: userId, entered_at: now,
        }).eq('id', r.id);
        if (e2) throw e2;
      }
    } else {
      // Advised only as text last time (no order placed): record it on today's visit.
      const { data: o, error } = await supabase.from('lab_orders').insert({
        tenant_id: tenantId, visit_id: currentVisitId, priority: 'routine', ordered_by: userId,
        review_status: 'finalized', due_timing: 'today', ...outside,
      }).select('id').single();
      if (error) throw error;
      orderId = o.id;
      if (filled.length) {
        const { error: e2 } = await supabase.from('lab_order_items').insert(filled.map(r => ({
          order_id: orderId, tenant_id: tenantId, test_name: r.test_name, test_category: 'other',
          result_value: r.result_value, result_unit: r.result_unit, reference_range: r.reference_range,
          is_abnormal: r.is_abnormal, entered_by: userId, entered_at: now,
        })));
        if (e2) throw e2;
      }
    }
    if (file) {
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `${tenantId}/${patientId}/${orderId}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from('lab-reports').upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { error: pErr } = await supabase.from('lab_orders').update({ outside_report_path: path }).eq('id', orderId);
      if (pErr) throw pErr;
    }
    window.closeOutsideResult();
    await loadInvestigationsDue(_ctx);
    window.dispatchEvent(new CustomEvent('ax:outside-result-saved'));   // doctor.js refreshes its lab box
  } catch (e) {
    err.textContent = 'Could not save: ' + (e?.message || e);
  } finally {
    btn.disabled = false; btn.textContent = 'Save result';
  }
};

// Signed, short-lived link to a private report file (also used by the Visit History panel).
window.openLabReportFile = async function(path) {
  if (!_ctx && !window._axSupabase) return;
  const sb = _ctx?.supabase || window._axSupabase;
  const { data, error } = await sb.storage.from('lab-reports').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { alert('Could not open the report: ' + (error?.message || 'not found')); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
};
