// Doctor IPD part 4 (Session 298) -- discharge summary inside doctor.html's ward round
// view, pre-filled from the whole stay.
//
// Draft: ipd_discharge_summaries (one row per admission; doctors and PG/interns can edit,
// trainees only while unsigned -- RLS). Sign: sign_ipd_discharge_summary() RPC, doctor
// only -- copies the draft onto ipd_admissions' discharge_* columns (the same ones
// ipd.html's print and the ABDM DischargeSummary record read), orders the discharge if
// not already ordered, stops every active MAR order, and sends the take-home medicines
// to the pharmacy once (charged to the stay, like any IPD dispense).
// Print: js/modules/ipd/dischargePrint.js (shared with ipd.html).
import { fetchSamsarjanaHomeChart, buildDischargeSummaryHtml, printDischargeHtml } from './dischargePrint.js';

let _c = null;      // { supabase, esc, tenantId, userId, isTrainee, toast }
let _adm = null;
let _row = null;    // ipd_discharge_summaries row, if one exists
let _seq = 0;
let _token = 0;

const MAR_TO_FREQ = { once_daily: 'OD', twice_daily: 'BD', thrice_daily: 'TDS', four_times: 'QID', sos: 'SOS', hs: 'HS', qam: 'QAM', qpm: 'QPM' };
const FREQS = ['OD', 'BD', 'TDS', 'QID', 'SOS', 'HS', 'QAM', 'QPM'];
const _fmtD = d => d ? new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
const _localDate = d => (String(d).length === 10 ? String(d) : new Date(d).toLocaleDateString('en-CA'));
const _dayOf = d => {
  const start = new Date(_localDate(_adm.admission_date || _adm.admitted_at) + 'T00:00:00');
  return Math.max(1, Math.round((new Date(_localDate(d) + 'T00:00:00') - start) / 86400000) + 1);
};
const $ = id => document.getElementById(id);

export async function openDischarge(adm, ctx) {
  _c = ctx; _adm = adm; _row = null;
  const token = ++_token;
  $('ds-form').hidden = true;
  $('ds-prepare').hidden = false;
  $('ds-err').textContent = '';
  $('ds-sign').hidden = _c.isTrainee;
  $('ds-status').textContent = 'Loading…';
  const { data } = await _c.supabase.from('ipd_discharge_summaries').select('*').eq('admission_id', adm.id).maybeSingle();
  if (token !== _token) return;
  _row = data || null;
  _renderStatus();
}

export function closeDischarge() { _token++; _adm = null; _row = null; }

function _renderStatus() {
  const st = $('ds-status');
  const ordered = _adm.status === 'clinically_discharged';
  if (_row?.signed_at) {
    st.innerHTML = `<span class="ipdws-sign ok" style="display:inline-flex;margin:0">✓ Signed ${_c.esc(new Date(_row.signed_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}${ordered ? ' · discharge ordered' : ''}</span>`;
  } else if (_row) {
    st.innerHTML = `<span class="ipdws-sign wait" style="display:inline-flex;margin:0">📝 Draft saved${_row.author_is_trainee ? ' by PG/Intern' : ''} — awaiting a doctor’s signature</span>`;
  } else {
    st.textContent = ordered ? 'Discharge already ordered — no summary written yet.' : 'Not started.';
  }
  $('ds-prepare').textContent = _row ? 'Open discharge summary' : 'Prepare discharge summary';
  $('ds-print-btn').hidden = !_row?.signed_at;
}

// ── Form ─────────────────────────────────────────────────────────────────────
window.prepareDischargeSummary = async function() {
  if (!_adm) return;
  $('ds-prepare').hidden = true;
  $('ds-form').hidden = false;
  if (_row) _fillForm(_row);
  else await _prefillFromStay();
};

window.refreshDischargeFromStay = async function() {
  if (!confirm('Replace what is in the form with a fresh draft built from the stay? Unsaved edits will be lost.')) return;
  await _prefillFromStay();
};

function _fillForm(r) {
  $('ds-dx-ay').value = r.diagnosis_ayurveda || '';
  $('ds-dx-icd').value = r.diagnosis_icd10 || '';
  $('ds-course').value = r.course_in_hospital || '';
  $('ds-treatment').value = r.treatment_given || '';
  $('ds-inv').value = r.investigations || '';
  $('ds-condition').value = r.condition_at_discharge || 'improved';
  $('ds-pathya').value = r.pathya_apathya || '';
  $('ds-advice').value = r.advice || '';
  $('ds-fu').value = r.followup_date || '';
  $('ds-med-rows').innerHTML = '';
  _seq = 0;
  (r.take_home_meds || []).forEach(m => _addMedRow(m));
  if (!(r.take_home_meds || []).length) _addMedRow();
}

async function _prefillFromStay() {
  const token = _token;
  const sb = _c.supabase;
  const admId = _adm.id;
  $('ds-err').textContent = 'Building the draft from the stay…';
  const visitFilter = _adm.visit_id ? `ipd_admission_id.eq.${admId},visit_id.eq.${_adm.visit_id}` : `ipd_admission_id.eq.${admId}`;
  const [wr, mar, pk, lab, img, diet] = await Promise.all([
    sb.from('ward_round_notes').select('note_date, subjective, assessment, plan, improvement_pct, created_at')
      .eq('admission_id', admId).order('created_at', { ascending: true }),
    sb.from('nursing_mar').select('medicine_name, medicine_id, dose, route, frequency, timing, anupana, status, is_active, start_date, created_at, stopped_at')
      .eq('admission_id', admId).order('created_at', { ascending: true }),
    sb.from('pk_therapy_sessions').select('therapy_name, scheduled_date, status')
      .eq('ipd_admission_id', admId).eq('status', 'completed').order('scheduled_date', { ascending: true }),
    sb.from('lab_orders').select('order_date, status, lab_order_items(test_name, result_value, is_abnormal, is_critical)')
      .or(visitFilter).order('order_date', { ascending: true }),
    sb.from('imaging_orders').select('order_date, study_name, status, impression, findings')
      .or(visitFilter).order('order_date', { ascending: true }),
    sb.from('ipd_diet_orders').select('diet_type, instructions, created_at')
      .eq('admission_id', admId).order('created_at', { ascending: false }).limit(1),
  ]);
  if (token !== _token) return;

  const rounds = wr.data || [];
  const today = new Date();
  const stayDays = _dayOf(today);

  // Diagnosis -- latest round's assessment, else admission diagnosis.
  const latest = rounds[rounds.length - 1];
  $('ds-dx-ay').value = latest?.assessment || _adm.diagnosis_primary || '';
  $('ds-dx-icd').value = '';

  // Course in hospital
  const course = [];
  course.push(`Admitted on ${_fmtD(_adm.admission_date || _adm.admitted_at)}${_adm.diagnosis_primary ? ' with ' + _adm.diagnosis_primary : ''}. ${rounds.length} ward round${rounds.length === 1 ? '' : 's'} recorded up to Day ${stayDays} of stay.`);
  if (rounds.length) {
    const first = rounds[0];
    course.push(`Day ${_dayOf(first.note_date)} (first round): ${first.assessment || first.subjective || '—'}`);
    if (rounds.length > 1) course.push(`Day ${_dayOf(latest.note_date)} (latest round): ${latest.assessment || latest.subjective || '—'}`);
    const pcts = rounds.filter(r => r.improvement_pct !== null && r.improvement_pct !== undefined).map(r => `Day ${_dayOf(r.note_date)} ${r.improvement_pct > 0 ? '+' : ''}${r.improvement_pct}%`);
    if (pcts.length) course.push(`Improvement recorded on rounds: ${pcts.join(', ')}.`);
  }
  $('ds-course').value = course.join('\n');

  // Treatment given -- every medicine order + completed PK sessions.
  // Legacy (pre-Session 296) MAR rows have status defaulting to 'active' but is_active=false.
  const meds = (mar.data || []).map(m => ({ ...m, _active: m.status === 'active' && m.is_active !== false }));
  const tx = [];
  if (meds.length) {
    tx.push('Medicines:');
    meds.forEach(m => {
      const from = _fmtD(m.start_date || m.created_at);
      const to = m.stopped_at ? _fmtD(m.stopped_at) : (m._active ? 'discharge' : 'stopped');
      tx.push(`• ${[m.medicine_name, m.dose, m.route, (m.frequency || '').replace(/_/g, ' '), m.anupana ? 'with ' + m.anupana : ''].filter(Boolean).join(' ')} (${from} – ${to})`);
    });
  }
  const pkByName = new Map();
  (pk.data || []).forEach(s => {
    const g = pkByName.get(s.therapy_name) || { n: 0, from: s.scheduled_date, to: s.scheduled_date };
    g.n++; g.to = s.scheduled_date; pkByName.set(s.therapy_name, g);
  });
  if (pkByName.size) {
    tx.push('Panchakarma:');
    pkByName.forEach((g, name) => tx.push(`• ${name} — ${g.n} session${g.n === 1 ? '' : 's'} (${_fmtD(g.from)}${g.from !== g.to ? ' – ' + _fmtD(g.to) : ''})`));
  }
  $('ds-treatment').value = tx.join('\n');

  // Investigations
  const inv = [];
  (lab.data || []).forEach(o => {
    const items = (o.lab_order_items || []).filter(i => i.result_value);
    if (!items.length) return;
    inv.push(`${_fmtD(o.order_date)}: ` + items.map(i => `${i.test_name} ${i.result_value}${i.is_critical ? ' (CRITICAL)' : i.is_abnormal ? ' (abnormal)' : ''}`).join('; '));
  });
  (img.data || []).forEach(o => {
    if (!o.impression && !o.findings) return;
    inv.push(`${_fmtD(o.order_date)}: ${o.study_name} — ${o.impression || o.findings}`);
  });
  $('ds-inv').value = inv.join('\n');

  // Take-home = currently active MAR orders.
  $('ds-med-rows').innerHTML = '';
  _seq = 0;
  const active = meds.filter(m => m._active);
  active.forEach(m => _addMedRow({
    name: m.medicine_name, medicine_id: m.medicine_id, dose: m.dose, route: m.route,
    freq: MAR_TO_FREQ[m.frequency] || 'OD', dur: '', anupana: m.anupana, timing: m.timing,
  }));
  if (!active.length) _addMedRow();

  const d = (diet.data || [])[0];
  $('ds-pathya').value = d ? `Diet during stay: ${d.diet_type}${d.instructions ? ' (' + d.instructions + ')' : ''}` : '';
  $('ds-condition').value = 'improved';
  $('ds-advice').value = '';
  $('ds-fu').value = '';
  $('ds-err').textContent = '';
}

function _addMedRow(m = {}) {
  const id = ++_seq;
  const e = _c.esc;
  const div = document.createElement('div');
  div.className = 'ordm-row';
  div.id = `dsm-${id}`;
  div.dataset.medicineId = m.medicine_id || '';
  div.dataset.route = m.route || '';
  const freq = FREQS.includes(m.freq) ? m.freq : 'OD';
  div.innerHTML = `
    <div class="rx-col"><label>Medicine</label><input type="text" class="dsm-name" value="${e(m.name || '')}" placeholder="Medicine name"/></div>
    <div class="rx-col"><label>Dose</label><input type="text" class="dsm-dose" value="${e(m.dose || '')}" placeholder="e.g. 1 tab"/></div>
    <div class="rx-col"><label>Frequency</label><select class="dsm-freq">${FREQS.map(f => `<option value="${f}"${f === freq ? ' selected' : ''}>${f}</option>`).join('')}</select></div>
    <div class="rx-col"><label>Duration</label><input type="text" class="dsm-dur" value="${e(m.dur || '')}" placeholder="e.g. 15d"/></div>
    <div class="rx-col"><label>Anupana</label><input type="text" class="dsm-anupana" value="${e(m.anupana || '')}" placeholder="Warm water…"/></div>
    <div class="rx-col"><label>Timing</label><input type="text" class="dsm-timing" value="${e(m.timing || '')}" placeholder="After food…"/></div>
    <button type="button" class="btn-rm-rx" aria-label="Remove this medicine" data-onclick="removeDsMedRow" data-onclick-a0="${id}">×</button>`;
  $('ds-med-rows').appendChild(div);
}
window.addDsMedRow = () => _addMedRow();
window.removeDsMedRow = id => $(`dsm-${id}`)?.remove();

function _collect() {
  const v = id => $(id).value.trim() || null;
  const meds = [...document.querySelectorAll('#ds-med-rows .ordm-row')].map(row => ({
    name: row.querySelector('.dsm-name').value.trim(),
    medicine_id: row.dataset.medicineId || null,
    route: row.dataset.route || null,
    dose: row.querySelector('.dsm-dose').value.trim(),
    freq: row.querySelector('.dsm-freq').value,
    dur: row.querySelector('.dsm-dur').value.trim(),
    anupana: row.querySelector('.dsm-anupana').value.trim(),
    timing: row.querySelector('.dsm-timing').value.trim(),
  })).filter(m => m.name);
  return {
    tenant_id: _c.tenantId, admission_id: _adm.id,
    diagnosis_ayurveda: v('ds-dx-ay'), diagnosis_icd10: v('ds-dx-icd'),
    course_in_hospital: v('ds-course'), treatment_given: v('ds-treatment'), investigations: v('ds-inv'),
    condition_at_discharge: $('ds-condition').value || null,
    pathya_apathya: v('ds-pathya'), advice: v('ds-advice'), followup_date: $('ds-fu').value || null,
    take_home_meds: meds,
  };
}

async function _saveDraft() {
  const payload = _collect();
  const q = _row
    ? _c.supabase.from('ipd_discharge_summaries').update(payload).eq('id', _row.id)
    : _c.supabase.from('ipd_discharge_summaries').insert(payload);
  const { data, error } = await q.select('*').single();
  if (error) throw error;
  _row = data;
  return data;
}

window.saveDischargeDraft = async function() {
  if (!_adm) return;
  const btn = $('ds-save');
  btn.disabled = true; $('ds-err').textContent = '';
  try {
    await _saveDraft();
    _renderStatus();
    _c.toast?.(_c.isTrainee ? 'Discharge summary draft saved — a doctor needs to sign it.' : 'Discharge summary draft saved.', 'info');
  } catch (e) {
    $('ds-err').textContent = 'Could not save: ' + (e?.message || 'please try again.');
  } finally { btn.disabled = false; }
};

window.signDischargeSummary = async function() {
  if (!_adm || _c.isTrainee) return;
  const already = _adm.status === 'clinically_discharged';
  const nMeds = _collect().take_home_meds.length;
  const msg = already
    ? 'Sign this discharge summary? (Discharge is already ordered.)'
    : `Sign the discharge summary and ORDER DISCHARGE for ${_adm.patients?.name || 'this patient'}?\n\n• All active medicine orders on the MAR will be stopped.\n` +
      (nMeds ? `• ${nMeds} take-home medicine${nMeds === 1 ? '' : 's'} will be sent to the pharmacy (charged to the stay).\n` : '') +
      '• The nurse then reconciles stay charges, as with any discharge.';
  if (!confirm(msg)) return;
  const btn = $('ds-sign');
  btn.disabled = true; btn.textContent = 'Signing…'; $('ds-err').textContent = '';
  try {
    await _saveDraft();
    const { error } = await _c.supabase.rpc('sign_ipd_discharge_summary', { p_admission_id: _adm.id });
    if (error) throw error;
    const { data } = await _c.supabase.from('ipd_discharge_summaries').select('*').eq('id', _row.id).single();
    _row = data || _row;
    _adm.status = 'clinically_discharged';
    _renderStatus();
    _c.toast?.(already ? 'Discharge summary signed.' : 'Discharge summary signed and discharge ordered.', 'info');
    window.reloadIpdOrdersAfterDischarge?.();
  } catch (e) {
    $('ds-err').textContent = 'Could not sign: ' + (e?.message || 'please try again.');
  } finally { btn.disabled = false; btn.textContent = '✓ Sign & order discharge'; }
};

window.printDischargeFromRound = async function() {
  if (!_adm) return;
  const { data: adm, error } = await _c.supabase.from('ipd_admissions')
    .select('*, patients(id, name, phone, abha_number, age, gender), beds(bed_number, ward_name), departments(name), profiles!admitting_doctor_id(full_name)')
    .eq('id', _adm.id).single();
  if (error) { _c.toast?.('Could not load the admission for printing: ' + error.message, 'error'); return; }
  const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');
  const homeChart = await fetchSamsarjanaHomeChart(_c.supabase, _adm.id);
  let signerName = null;
  if (_row?.signed_by) {
    const { data: p } = await _c.supabase.from('profiles').select('full_name').eq('id', _row.signed_by).maybeSingle();
    signerName = p?.full_name || null;
  }
  printDischargeHtml(buildDischargeSummaryHtml({ adm, admId: _adm.id, tenant, homeChart, esc: _c.esc, signerName }));
};
