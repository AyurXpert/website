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
let _imgOrders = [];        // imaging orders shown in the card
let _modalKind = 'lab';     // 'lab' | 'img' -- what the outside-report window is recording
let _token = 0;

const _fmtD = d => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d)
  .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const _todayStr = () => new Date().toLocaleDateString('en-CA');

export function resetInvestigationsDue() {
  _token++; _orders = []; _imgOrders = []; _ctx = null;
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
  const IMG = 'id, visit_id, modality, study_name, status, order_date, due_timing, due_by, is_outside_referral, outside_centre_name, performed_date, findings, impression, outside_report_path, outside_entered_at';
  const [oR, nR, tR, iR, itR] = await Promise.all([
    supabase.from('lab_orders').select(SEL)
      .eq('tenant_id', ctx.tenantId).in('visit_id', ids).order('created_at', { ascending: true }),
    supabase.from('consultation_notes').select('inv_lab, inv_imaging, review_status, is_deleted')
      .eq('visit_id', last.id).order('created_at', { ascending: false }),
    // Outside reports added during THIS consultation ("+ Add outside report") live on
    // today's visit -- list them too, so the doctor sees what was just recorded.
    supabase.from('lab_orders').select(SEL)
      .eq('tenant_id', ctx.tenantId).eq('visit_id', ctx.currentVisitId).eq('performed_outside', true)
      .order('created_at', { ascending: true }),
    // Session 295 -- imaging, same rules as labs.
    supabase.from('imaging_orders').select(IMG)
      .eq('tenant_id', ctx.tenantId).in('visit_id', ids).order('created_at', { ascending: true }),
    supabase.from('imaging_orders').select(IMG)
      .eq('tenant_id', ctx.tenantId).eq('visit_id', ctx.currentVisitId).not('outside_entered_at', 'is', null)
      .order('created_at', { ascending: true }),
  ]);
  if (token !== _token) return;
  if (oR.error) console.warn('[investigations due]', oR.error.message);
  const notes = (nR.data || []).find(n => !n.is_deleted && (!n.review_status || n.review_status === 'finalized')) || {};
  _orders = (oR.data || []).filter(o => (!o.review_status || o.review_status === 'finalized')
    && (o.visit_id === last.id || (o.due_timing === 'next_visit' && o.status !== 'completed')))
    .concat(tR.data || []);
  _imgOrders = (iR.data || []).filter(o => o.visit_id === last.id || (o.due_timing === 'next_visit' && o.status !== 'completed'))
    .concat(itR.data || []);

  const text = [['Lab advised', notes.inv_lab], ['Imaging advised', notes.inv_imaging]]
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `<div class="inv-note"><span class="inv-note-k">${k} (as written):</span> ${esc(v)}</div>`).join('');

  if (!_orders.length && !_imgOrders.length && !text) { card.hidden = true; return; }
  document.getElementById('inv-due-ref').textContent = `advised ${_fmtD(last.created_at)}`;
  document.getElementById('inv-due-body').innerHTML =
    (_orders.length || _imgOrders.length
      ? _orders.map(o => _orderRow(o, esc)).join('') + _imgOrders.map(o => _imgRow(o, esc)).join('')
      : '<div class="inv-empty">No lab or imaging order was placed last visit.</div>') + text;
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

const _MOD = { xray: 'X-Ray', usg: 'USG', ecg: 'ECG', echo: 'ECHO', doppler: 'Doppler', mri: 'MRI', ct: 'CT', outside: 'Imaging' };
function _imgRow(o, esc) {
  const outside = o.outside_entered_at || o.is_outside_referral;
  const concl = o.impression || o.findings;
  let status, action = '';
  if (o.status === 'completed') {
    status = outside
      ? `<span class="inv-st ok">✅ Outside centre: ${esc(o.outside_centre_name || '—')}${o.performed_date ? ' · ' + _fmtD(o.performed_date) : ''}</span>`
      : '<span class="inv-st ok">✅ Report ready (our centre)</span>';
    if (o.outside_report_path) action = `<button type="button" class="inv-btn" data-onclick="openLabReportFile" data-onclick-a0="${esc(o.outside_report_path)}">📄 Report</button>`;
  } else if (o.status === 'performed') {
    status = '<span class="inv-st wait">⏳ Done at our centre — report awaited</span>';
  } else {
    status = o.status === 'referred_outside'
      ? `<span class="inv-st wait">🔗 Referred to ${esc(o.outside_centre_name || 'outside centre')} — report not entered</span>`
      : `<span class="inv-st no">❌ Not done yet${o.due_by ? ' · was due ' + _fmtD(o.due_by) : ''}</span>`;
    action = `<button type="button" class="inv-btn inv-btn-primary" data-onclick="openOutsideImaging" data-onclick-a0="${o.id}">Enter outside report</button>`;
  }
  return `<div class="inv-row">
    <div class="inv-main">
      <div class="inv-tests">📡 ${esc(_MOD[o.modality] || o.modality || '')} — ${esc(o.study_name || '')}${concl ? `<div class="inv-concl">${esc(concl)}</div>` : ''}</div>
      <div class="inv-meta">${status}${o.due_timing === 'next_visit' ? ' <span class="inv-tag">📅 advised for next visit</span>' : ''}</div>
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

// Switches the window between lab-test rows and imaging findings/impression.
function _setKind(kind, isNew) {
  _modalKind = kind;
  document.getElementById('oor-lab-fields').hidden = kind !== 'lab';
  document.getElementById('oor-img-fields').hidden = kind !== 'img';
  document.getElementById('oor-img-new').hidden = !(kind === 'img' && isNew);
  document.getElementById('oor-lab-label').textContent = kind === 'img' ? 'Outside centre name *' : 'Outside lab name *';
  document.getElementById('oor-lab').placeholder = kind === 'img' ? 'e.g. Aarthi Scans, city diagnostic centre…' : 'e.g. Metropolis, Thyrocare…';
}
window.oorTypeChange = function() {
  _setKind(document.getElementById('oor-type').value, true);
  document.getElementById('oor-title').textContent = _modalKind === 'img' ? 'Add outside imaging report' : 'Add outside lab report';
};
function _resetCommon() {
  document.getElementById('oor-lab').value = '';
  const date = document.getElementById('oor-date');
  date.value = ''; date.max = _todayStr();
  document.getElementById('oor-file').value = '';
  document.getElementById('oor-err').textContent = '';
  ['oor-findings', 'oor-impression', 'oor-study'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('oor-mod').value = 'xray';
}

window.openOutsideImaging = function(orderId) {
  if (!_ctx) return;
  _modalOrder = _imgOrders.find(o => o.id === orderId) || null;
  if (!_modalOrder) return;
  _resetCommon();
  document.getElementById('oor-type-wrap').hidden = true;
  _setKind('img', false);
  document.getElementById('oor-title').textContent = 'Enter outside imaging report';
  document.getElementById('oor-img-study').textContent = `📡 ${_MOD[_modalOrder.modality] || _modalOrder.modality || ''} — ${_modalOrder.study_name || ''}`;
  if (_modalOrder.outside_centre_name) document.getElementById('oor-lab').value = _modalOrder.outside_centre_name;
  document.getElementById('oor-overlay').style.display = 'flex';
  document.getElementById('oor-lab').focus();
};

window.openOutsideResult = function(orderId) {
  if (!_ctx) return;
  const { esc } = _ctx;
  _modalOrder = orderId ? _orders.find(o => o.id === orderId) || null : null;
  _resetCommon();
  // "+ Add outside report" (no order) can be either kind; an existing lab order is lab.
  document.getElementById('oor-type-wrap').hidden = !!_modalOrder;
  document.getElementById('oor-type').value = 'lab';
  _setKind('lab', !_modalOrder);
  document.getElementById('oor-img-study').textContent = '';
  document.getElementById('oor-title').textContent = _modalOrder ? 'Enter outside lab result' : 'Add outside lab report';
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
  if (_modalKind === 'img') return _saveOutsideImaging();
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

// Session 295 -- outside imaging report: fills an existing order (advised last visit) or
// records a new one on today's visit (advised only as text). Never radiology work.
async function _saveOutsideImaging() {
  const { supabase, tenantId, patientId, currentVisitId, userId } = _ctx;
  const err = document.getElementById('oor-err');
  const centre = document.getElementById('oor-lab').value.trim();
  const date = document.getElementById('oor-date').value;
  const findings = document.getElementById('oor-findings').value.trim() || null;
  const impression = document.getElementById('oor-impression').value.trim() || null;
  const study = document.getElementById('oor-study').value.trim();
  const file = document.getElementById('oor-file').files[0] || null;
  if (!centre) { err.textContent = 'Enter the outside centre\'s name.'; return; }
  if (!date) { err.textContent = 'Enter the report date.'; return; }
  if (date > _todayStr()) { err.textContent = 'Report date cannot be in the future.'; return; }
  if (!_modalOrder && !study) { err.textContent = 'Enter the study / region.'; return; }
  if (!impression && !findings && !file) { err.textContent = 'Enter the impression or findings, or attach the report.'; return; }
  if (file && !/^(image\/|application\/pdf$)/.test(file.type)) { err.textContent = 'Attach a photo or a PDF.'; return; }
  if (file && file.size > 10 * 1024 * 1024) { err.textContent = 'The file is larger than 10 MB.'; return; }

  const btn = document.getElementById('oor-save');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  const now = new Date().toISOString();
  try {
    const outside = {
      is_outside_referral: true, outside_centre_name: centre, performed_date: date,
      findings, impression, status: 'completed', report_released_at: now, report_released_by: userId,
      outside_entered_by: userId, outside_entered_at: now, outside_entered_visit_id: currentVisitId,
    };
    let orderId = _modalOrder?.id;
    if (orderId) {
      const { error } = await supabase.from('imaging_orders').update(outside).eq('id', orderId);
      if (error) throw error;
    } else {
      const { data: o, error } = await supabase.from('imaging_orders').insert({
        tenant_id: tenantId, patient_id: patientId, visit_id: currentVisitId, ordered_by: userId,
        order_date: _todayStr(), modality: document.getElementById('oor-mod').value, study_name: study,
        priority: 'routine', due_timing: 'today', ...outside,
      }).select('id').single();
      if (error) throw error;
      orderId = o.id;
    }
    if (file) {
      const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
      const path = `${tenantId}/${patientId}/img-${orderId}/${Date.now()}-${safe}`;
      const { error: upErr } = await supabase.storage.from('lab-reports').upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { error: pErr } = await supabase.from('imaging_orders').update({ outside_report_path: path }).eq('id', orderId);
      if (pErr) throw pErr;
    }
    window.closeOutsideResult();
    await loadInvestigationsDue(_ctx);
  } catch (e) {
    err.textContent = 'Could not save: ' + (e?.message || e);
  } finally {
    btn.disabled = false; btn.textContent = 'Save result';
  }
}

// Signed, short-lived link to a private report file (also used by the Visit History panel).
window.openLabReportFile = async function(path) {
  if (!_ctx && !window._axSupabase) return;
  const sb = _ctx?.supabase || window._axSupabase;
  const { data, error } = await sb.storage.from('lab-reports').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { alert('Could not open the report: ' + (error?.message || 'not found')); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
};
