// Doctor IPD part 2 (Session 295) -- ward rounds inside doctor.html.
//
// Clicking an admitted patient in the IPD queue opens this view instead of a new ipd.html
// tab: header (bed, day of stay, diagnosis, flags) + a date-wise rail of previous rounds
// (newest first, like OPD Visit History) + today's round form. Previous rounds open in the
// shared #vh-panel side panel. Data: ward_round_notes (same table as ipd.html's SOAP
// drawer; extended by sql/session295e_ward_round_notes_v2.sql).
//
// Dr. Venkatesh's choices: SOAP + Ayurvedic daily assessment + the latest nursing vitals
// (snapshotted onto the note) + improvement % since the last round; several labelled
// rounds a day; PG / intern notes are saved "awaiting countersign" until a doctor
// countersigns (enforced server-side by trg_ward_round_guard + RLS).

let _c = null;        // { supabase, esc, tenantId, userId, isTrainee, toast, fmtDate, getInventory }
let _adm = null;      // the open admission (row from doctor.js's IPD list)
let _notes = [];
let _vitals = null;   // latest nursing_vitals row
let _token = 0;
let _lastSavedRoundId = null;   // this session's most-recently-saved round note id, for tagging new orders

// ── Orders panel (Session 296 -- doctor IPD part 3, build session 1: Medicines only;
// Investigations/Diet/Panchakarma are shells for the next session, see doctor_ipd_plan.md) ──
let _orderTab = 'meds';
let _medRowSeq = 0;
let _activeOrders = [];
const FREQ_TO_MAR = { OD: 'once_daily', BD: 'twice_daily', TDS: 'thrice_daily', QID: 'four_times', SOS: 'sos', HS: 'hs', QAM: 'qam', QPM: 'qpm' };
const ROUTE_LABEL = { oral: 'Oral', iv: 'IV', im: 'IM', sc: 'SC', nasal: 'Nasal', topical: 'Topical', rectal: 'Rectal', sublingual: 'Sublingual' };

const ROUND_LABEL = { morning: 'Morning', evening: 'Evening', night: 'Night', emergency: 'Emergency', other: 'Other' };
// Day of stay in LOCAL dates (admission day = Day 1). admitted_at is a UTC timestamp, so
// its first 10 chars can be the previous day for an evening admission in IST -- use the
// admission_date column, else the timestamp converted to a local date.
const _localDate = d => (String(d).length === 10 ? String(d) : new Date(d).toLocaleDateString('en-CA'));
const _day = (a, d) => {
  const start = new Date(_localDate(a.admission_date || a.admitted_at) + 'T00:00:00');
  const end = new Date(_localDate(d) + 'T00:00:00');
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
};
const _fmtD = d => new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const _defaultLabel = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 20 ? 'evening' : 'night'; };
const _pctText = v => v > 0 ? `${v}% better` : v < 0 ? `${Math.abs(v)}% worse` : 'No change';

export function isIpdRoundOpen() { return !!_adm; }

export async function openIpdRound(adm, ctx) {
  _c = ctx; _adm = adm;
  const token = ++_token;
  const e = _c.esc;
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('c-history').style.display = 'none';
  document.getElementById('c-ipd').style.display = '';
  window.closeVhPanel?.();

  const today = new Date();
  document.getElementById('ipdws-name').textContent = adm.patients?.name || '—';
  document.getElementById('ipdws-meta').textContent = [
    adm.beds?.ward_name, adm.beds?.bed_number ? 'Bed ' + adm.beds.bed_number : null, adm.departments?.name,
    `Day ${_day(adm, today)}${adm.advice?.expected_duration_days ? ' / ' + adm.advice.expected_duration_days : ''}`,
    adm.diagnosis_primary,
  ].filter(Boolean).join(' · ');
  document.getElementById('ipdws-flags').innerHTML = adm._flagsHtml || '';
  document.getElementById('ipdws-open').href = `ipd.html?admission_id=${encodeURIComponent(adm.id)}`;
  document.getElementById('ipdws-trainee-note').hidden = !_c.isTrainee;
  _resetForm();
  _lastSavedRoundId = null;
  _orderTab = 'meds';
  _resetOrderForm();
  _switchOrderPane();
  _loadActiveOrders(adm.id);

  const [nR, vR] = await Promise.all([
    _c.supabase.from('ward_round_notes')
      .select('id, note_date, round_label, subjective, objective, assessment, plan, nadi, agni, mala, mutra, nidra, koshtha, improvement_pct, vitals_snapshot, author_is_trainee, countersigned_by, countersigned_at, created_at, doctor_id, profiles(full_name)')
      .eq('admission_id', adm.id).order('created_at', { ascending: false }),
    _c.supabase.from('nursing_vitals')
      .select('recorded_at, shift, temperature, pulse, respiratory_rate, spo2, bp_systolic, bp_diastolic, blood_sugar, pain_score, weight')
      .eq('admission_id', adm.id).order('recorded_at', { ascending: false }).limit(1),
  ]);
  if (token !== _token) return;
  if (nR.error) _c.toast?.('Could not load ward rounds: ' + nR.error.message, 'error');
  _notes = nR.data || [];
  _vitals = (vR.data || [])[0] || null;
  _renderVitals();
  _renderRail();
  void e;
}

export function closeIpdRound() {
  _token++; _adm = null; _notes = []; _vitals = null;
  _activeOrders = []; _lastSavedRoundId = null;
  window.closeVhPanel?.();
  const el = document.getElementById('c-ipd');
  if (el) el.style.display = 'none';
}
window.closeIpdRound = function() {
  closeIpdRound();
  document.getElementById('welcome').style.display = '';
};

function _resetForm() {
  ['ipdws-s', 'ipdws-o', 'ipdws-a', 'ipdws-p', 'ipdws-nadi', 'ipdws-mala', 'ipdws-mutra'].forEach(id => { document.getElementById(id).value = ''; });
  ['ipdws-agni', 'ipdws-nidra', 'ipdws-koshtha'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('ipdws-label').value = _defaultLabel();
  const imp = document.getElementById('ipdws-imp');
  window.progClear?.(imp);   // back to "Not recorded" (shared slider helper, visitTimeline.js)
  document.getElementById('ipdws-err').textContent = '';
}

function _vitalsLine(v) {
  if (!v) return '';
  const parts = [
    v.temperature != null ? `T ${v.temperature}°F` : null, v.pulse != null ? `P ${v.pulse}/min` : null,
    v.respiratory_rate != null ? `RR ${v.respiratory_rate}` : null, v.spo2 != null ? `SpO₂ ${v.spo2}%` : null,
    v.bp_systolic != null ? `BP ${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : null,
    v.blood_sugar != null ? `Sugar ${v.blood_sugar}` : null, v.pain_score != null ? `Pain ${v.pain_score}/10` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
function _renderVitals() {
  const box = document.getElementById('ipdws-vitals');
  const e = _c.esc;
  box.innerHTML = _vitals
    ? `<strong>Latest nursing vitals</strong> <span class="ipdws-muted">(${e(new Date(_vitals.recorded_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}${_vitals.shift ? ' · ' + e(_vitals.shift) : ''})</span><div>${e(_vitalsLine(_vitals)) || '—'}</div>`
    : '<span class="ipdws-muted">No nursing vitals recorded yet for this admission.</span>';
}

function _renderRail() {
  const e = _c.esc;
  document.getElementById('ipdws-count').textContent = `${_notes.length} round${_notes.length === 1 ? '' : 's'}`;
  document.getElementById('ipdws-list').innerHTML =
    `<div class="vh-item vh-today" aria-current="true"><span class="vh-date">Today — new round</span><span class="vh-sub">Day ${_day(_adm, new Date())}</span></div>` +
    (_notes.length ? _notes.map(n => {
      const tags = [
        n.author_is_trainee && !n.countersigned_at ? '<span class="vh-tag vh-tag-warn">PG/Intern · awaiting countersign</span>' : '',
        n.author_is_trainee && n.countersigned_at ? '<span class="vh-tag">✓ Countersigned</span>' : '',
        n.improvement_pct !== null && n.improvement_pct !== undefined ? `<span class="vh-tag vh-tag-prog">${n.improvement_pct > 0 ? '📈' : n.improvement_pct < 0 ? '📉' : '➖'} ${e(_pctText(n.improvement_pct))}</span>` : '',
      ].join('');
      return `<button type="button" class="vh-item" data-ipd-note="${n.id}" data-onclick="openIpdRoundNote" data-onclick-a0="${n.id}">
        <span class="vh-date">Day ${_day(_adm, n.note_date)} · ${e(_fmtD(n.note_date))}</span>
        <span class="vh-sub">${e(ROUND_LABEL[n.round_label] || 'Round')}${n.profiles?.full_name ? ' · ' + e(n.profiles.full_name) : ''}</span>
        ${n.assessment || n.subjective ? `<span class="vh-dx">${e(n.assessment || n.subjective)}</span>` : ''}
        ${tags ? `<span class="vh-tags">${tags}</span>` : ''}
      </button>`;
    }).join('') : '<div class="ipdws-muted" style="padding:10px">No rounds recorded yet.</div>');
}

const _row = (k, v) => v === null || v === undefined || String(v).trim() === '' ? '' :
  `<div class="vh-row"><span class="vh-k">${k}</span><span class="vh-v">${_c.esc(v)}</span></div>`;
const _sec = (t, b) => b ? `<section class="vh-sec"><h4>${t}</h4>${b}</section>` : '';

window.openIpdRoundNote = function(id) {
  const n = _notes.find(x => x.id === id);
  if (!n) return;
  document.querySelectorAll('#ipdws-list .vh-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`#ipdws-list [data-ipd-note="${id}"]`)?.classList.add('active');
  document.getElementById('vh-panel-title').textContent = `Day ${_day(_adm, n.note_date)} · ${_fmtD(n.note_date)} · ${ROUND_LABEL[n.round_label] || 'Round'}`;
  document.getElementById('vh-panel-sub').textContent = [n.profiles?.full_name, n.author_is_trainee ? 'PG / Intern' : null,
    new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ');
  const canSign = !_c.isTrainee && n.author_is_trainee && !n.countersigned_at;
  document.getElementById('vh-panel-body').innerHTML = [
    n.author_is_trainee ? `<div class="ipdws-sign ${n.countersigned_at ? 'ok' : 'wait'}">${n.countersigned_at
      ? '✓ Countersigned ' + _c.esc(new Date(n.countersigned_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
      : '⏳ PG / Intern note — awaiting a doctor’s countersign'}${canSign ? ` <button type="button" class="vh-btn vh-btn-primary" data-onclick="countersignIpdRound" data-onclick-a0="${n.id}">✓ Countersign</button>` : ''}</div>` : '',
    _sec('🌡 Vitals at the time', n.vitals_snapshot ? `<div class="vh-v">${_c.esc(_vitalsLine(n.vitals_snapshot))}</div>` : ''),
    _sec('📝 Subjective', _row('Complaints', n.subjective)),
    _sec('🩺 Objective', _row('Examination', n.objective)),
    _sec('🌿 Ayurvedic assessment', _row('Nadi', n.nadi) + _row('Agni', n.agni) + _row('Mala', n.mala) + _row('Mutra', n.mutra) + _row('Nidra', n.nidra) + _row('Koshtha', n.koshtha)),
    _sec('📈 Progress', n.improvement_pct === null || n.improvement_pct === undefined ? '' : _row('Since last round', _pctText(n.improvement_pct))),
    _sec('📋 Assessment', _row('Assessment', n.assessment)),
    _sec('➡ Plan', _row('Plan', n.plan)),
  ].join('') || '<div class="vh-empty">Empty note.</div>';
  const p = document.getElementById('vh-panel');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  window._vhRelayout?.();
  document.getElementById('vh-panel-close').focus();
};

window.countersignIpdRound = async function(id) {
  const { error } = await _c.supabase.from('ward_round_notes').update({ countersigned_by: _c.userId }).eq('id', id);
  if (error) { _c.toast?.('Could not countersign: ' + error.message, 'error'); return; }
  const n = _notes.find(x => x.id === id);
  if (n) n.countersigned_at = new Date().toISOString();
  _c.toast?.('Round note countersigned.', 'info');
  _renderRail();
  window.openIpdRoundNote(id);
};

window.saveIpdRound = async function() {
  if (!_adm || !_c) return;
  const v = id => document.getElementById(id).value.trim();
  const imp = document.getElementById('ipdws-imp');
  const note = {
    tenant_id: _c.tenantId, admission_id: _adm.id, doctor_id: _c.userId,
    note_date: new Date().toLocaleDateString('en-CA'), round_label: document.getElementById('ipdws-label').value,
    subjective: v('ipdws-s') || null, objective: v('ipdws-o') || null,
    assessment: v('ipdws-a') || null, plan: v('ipdws-p') || null,
    nadi: v('ipdws-nadi') || null, agni: v('ipdws-agni') || null, mala: v('ipdws-mala') || null,
    mutra: v('ipdws-mutra') || null, nidra: v('ipdws-nidra') || null, koshtha: v('ipdws-koshtha') || null,
    improvement_pct: imp.dataset.set === '1' ? Number(imp.value) : null,
    vitals_snapshot: _vitals,
  };
  const err = document.getElementById('ipdws-err');
  if (!note.subjective && !note.objective && !note.assessment && !note.plan) {
    err.textContent = 'Write at least one of Subjective, Objective, Assessment or Plan.';
    return;
  }
  const btn = document.getElementById('ipdws-save');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  const { data, error } = await _c.supabase.from('ward_round_notes').insert(note)
    .select('id, note_date, round_label, subjective, objective, assessment, plan, nadi, agni, mala, mutra, nidra, koshtha, improvement_pct, vitals_snapshot, author_is_trainee, countersigned_by, countersigned_at, created_at, doctor_id, profiles(full_name)').single();
  btn.disabled = false; btn.textContent = '✓ Save round note';
  if (error) { err.textContent = 'Could not save: ' + error.message; return; }
  _notes.unshift(data);
  _lastSavedRoundId = data.id;   // new orders placed this visit get tagged to this round
  _renderRail();
  _resetForm();
  _c.toast?.(data.author_is_trainee ? 'Round note saved — awaiting a doctor’s countersign.' : 'Round note saved.', 'info');
};

// ── Orders panel (Medicines) ──────────────────────────────────────────────────
window.switchOrderTab = function(tab) {
  _orderTab = tab;
  _switchOrderPane();
};

function _switchOrderPane() {
  ['meds', 'inv', 'diet', 'pk'].forEach(t => {
    document.getElementById(`ordt-tab-${t}`)?.classList.toggle('active', t === _orderTab);
    const pane = document.getElementById(`ordt-pane-${t}`);
    if (pane) pane.style.display = t === _orderTab ? '' : 'none';
  });
}

function _resetOrderForm() {
  _medRowSeq = 0;
  const rows = document.getElementById('ordm-rows');
  if (rows) rows.innerHTML = '';
  document.getElementById('ordm-err').textContent = '';
  _addOrderMedRow();
}

function _addOrderMedRow() {
  const id = ++_medRowSeq;
  const e = _c.esc;
  const div = document.createElement('div');
  div.className = 'ordm-row';
  div.id = `ordm-${id}`;
  div.innerHTML = `
    <div class="rx-col">
      <label>Medicine Name</label>
      <div class="rx-wrap">
        <input type="text" class="ordm-name" placeholder="Start typing…" autocomplete="off"/>
        <div class="typeahead" id="ordm-ta-${id}"></div>
      </div>
    </div>
    <div class="rx-col"><label>Dose</label><input type="text" class="ordm-dose" placeholder="e.g. 3g"/></div>
    <div class="rx-col"><label>Route</label>
      <select class="ordm-route">${Object.entries(ROUTE_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </div>
    <div class="rx-col"><label>Frequency</label>
      <select class="ordm-freq">${Object.keys(FREQ_TO_MAR).map(v => `<option value="${v}">${v}</option>`).join('')}</select>
    </div>
    <div class="rx-col"><label>Duration</label><input type="text" class="ordm-dur" placeholder="e.g. 5d"/></div>
    <div class="rx-col"><label>Anupana</label><input type="text" class="ordm-anupana" placeholder="Warm water, Milk…"/></div>
    <div class="rx-col"><label>Timing / Instructions</label><input type="text" class="ordm-timing" placeholder="Before food, after food…"/></div>
    <button type="button" class="btn-rm-rx" title="Remove this medicine" aria-label="Remove this medicine row" data-onclick="removeOrderMedRow" data-onclick-a0="${id}">×</button>
  `;
  document.getElementById('ordm-rows').appendChild(div);

  const nameInput = div.querySelector('.ordm-name');
  const ta = document.getElementById(`ordm-ta-${id}`);
  nameInput.addEventListener('input', function() {
    const inv = _c.getInventory?.() || [];
    const q = this.value.toLowerCase().trim();
    if (q.length < 2 || !inv.length) { ta.classList.remove('show'); return; }
    const results = inv.filter(i => i.medicine.name.toLowerCase().includes(q)).slice(0, 8);
    if (!results.length) { ta.classList.remove('show'); return; }
    ta.innerHTML = results.map(i => `<div class="ta-item" data-name="${e(i.medicine.name)}" data-mid="${i.medicine.id}"><span class="ta-name">${e(i.medicine.name)}</span></div>`).join('');
    ta.classList.add('show');
  });
  ta.addEventListener('click', ev => {
    const item = ev.target.closest('.ta-item');
    if (!item) return;
    nameInput.value = item.dataset.name;
    nameInput.dataset.medicineId = item.dataset.mid;
    ta.classList.remove('show');
  });
  nameInput.addEventListener('blur', () => setTimeout(() => ta.classList.remove('show'), 200));
}
window.addOrderMedRow = _addOrderMedRow;

window.removeOrderMedRow = function(id) {
  document.getElementById(`ordm-${id}`)?.remove();
};

function _getOrderMedRows() {
  return [...document.querySelectorAll('#ordm-rows .ordm-row')].map(row => ({
    name:        row.querySelector('.ordm-name')?.value?.trim() || '',
    medicine_id: row.querySelector('.ordm-name')?.dataset?.medicineId || null,
    dose:        row.querySelector('.ordm-dose')?.value?.trim() || '',
    route:       row.querySelector('.ordm-route')?.value || 'oral',
    freq:        row.querySelector('.ordm-freq')?.value || 'OD',
    dur:         row.querySelector('.ordm-dur')?.value?.trim() || '',
    anupana:     row.querySelector('.ordm-anupana')?.value?.trim() || '',
    timing:      row.querySelector('.ordm-timing')?.value?.trim() || '',
  })).filter(r => r.name);
}

window.saveIpdOrders = async function() {
  if (!_adm || !_c) return;
  const rows = _getOrderMedRows();
  const err = document.getElementById('ordm-err');
  if (!rows.length) { err.textContent = 'Add at least one medicine.'; return; }
  const btn = document.getElementById('ordm-save');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';

  try {
    const reviewStatus = _c.isTrainee ? 'pending_review' : 'finalized';
    let prescriptionId = null;
    if (_adm.visit_id) {
      const { data: presc, error: pErr } = await _c.supabase.from('prescriptions')
        .insert({
          tenant_id: _c.tenantId, visit_id: _adm.visit_id, patient_id: _adm.patient_id,
          patient_type: 'ipd', doctor_id: _c.userId, review_status: reviewStatus,
        }).select('id').single();
      if (pErr) throw pErr;
      prescriptionId = presc.id;
      await _c.supabase.from('prescription_items').insert(rows.map(r => ({
        prescription_id: prescriptionId, medicine_id: r.medicine_id, medicine_name: r.name,
        dosage: r.dose, frequency: r.freq, duration: r.dur, anupana: r.anupana, timing: r.timing || null, quantity: 1,
      })));
    }

    const marRows = rows.map(r => ({
      tenant_id: _c.tenantId, admission_id: _adm.id, medicine_name: r.name, dose: r.dose,
      route: r.route, frequency: FREQ_TO_MAR[r.freq] || 'other', instructions: r.timing || null,
      timing: r.timing || null, anupana: r.anupana || null, medicine_id: r.medicine_id,
      ward_round_id: _lastSavedRoundId, prescription_id: prescriptionId,
    }));
    const { error: mErr } = await _c.supabase.from('nursing_mar').insert(marRows);
    if (mErr) throw mErr;

    _c.toast?.(
      _c.isTrainee
        ? `${rows.length} medicine order${rows.length === 1 ? '' : 's'} placed — awaiting a doctor’s countersign.`
        : `${rows.length} medicine order${rows.length === 1 ? '' : 's'} placed.`,
      'info'
    );
    _resetOrderForm();
    _loadActiveOrders(_adm.id);
  } catch (e) {
    err.textContent = 'Could not save orders: ' + (e?.message || 'please try again.');
  } finally {
    btn.disabled = false; btn.textContent = '✓ Save orders';
  }
};

async function _loadActiveOrders(admissionId) {
  const token = _token;
  const { data } = await _c.supabase.from('nursing_mar')
    .select('id, medicine_name, dose, route, frequency, timing, anupana, status, author_role, is_verbal_order, countersigned_at, stopped_at, created_at, prescription_id')
    .eq('admission_id', admissionId).order('created_at', { ascending: false });
  if (token !== _token) return;
  _activeOrders = data || [];
  _renderActiveOrders();
}

function _renderActiveOrders() {
  const e = _c.esc;
  const box = document.getElementById('ordm-active');
  if (!box) return;
  if (!_activeOrders.length) { box.innerHTML = '<div class="ordm-empty">No medicine orders yet.</div>'; return; }
  box.innerHTML = _activeOrders.map(m => {
    const needsSign = m.author_role && m.author_role !== 'doctor' && !m.countersigned_at;
    const provenance = m.is_verbal_order
      ? (needsSign ? '<span class="ipdws-sign wait" style="display:inline-flex;padding:2px 8px;margin:0">🗣 Verbal order</span>' : '<span class="ipdws-sign ok" style="display:inline-flex;padding:2px 8px;margin:0">🗣 Verbal · ✓ signed</span>')
      : m.author_role === 'trainee'
        ? (needsSign ? '<span class="ipdws-sign wait" style="display:inline-flex;padding:2px 8px;margin:0">🧑‍🎓 Trainee order</span>' : '<span class="ipdws-sign ok" style="display:inline-flex;padding:2px 8px;margin:0">🧑‍🎓 Trainee · ✓ signed</span>')
        : '';
    const canSign = !_c.isTrainee && needsSign;
    const canStop = m.status === 'active';
    return `<div class="ordm-active-row ${m.status === 'stopped' ? 'stopped' : ''}">
      <div>
        <div class="ordm-active-name">${e(m.medicine_name)} ${m.status === 'stopped' ? '<span style="color:var(--red);font-weight:600;font-size:11px">STOPPED</span>' : ''}</div>
        <div class="ordm-active-meta">${e(m.dose)} · ${e(ROUTE_LABEL[m.route] || m.route)} · ${e((m.frequency || '').replace(/_/g, ' '))}${m.timing ? ' · ' + e(m.timing) : ''}</div>
        ${provenance ? `<div style="margin-top:4px">${provenance}</div>` : ''}
      </div>
      <div class="ordm-active-actions">
        ${canSign ? `<button type="button" class="ordm-btn ordm-btn-sign" data-onclick="countersignOrder" data-onclick-a0="${m.id}">✓ Countersign</button>` : ''}
        ${canStop ? `<button type="button" class="ordm-btn ordm-btn-stop" data-onclick="stopOrder" data-onclick-a0="${m.id}">Stop</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

window.stopOrder = async function(id) {
  if (!confirm('Stop this medicine order? The nurse will no longer see it as active.')) return;
  const { error } = await _c.supabase.from('nursing_mar').update({ status: 'stopped' }).eq('id', id);
  if (error) { _c.toast?.('Could not stop order: ' + error.message, 'error'); return; }
  _c.toast?.('Order stopped.', 'info');
  _loadActiveOrders(_adm.id);
};

window.countersignOrder = async function(id) {
  const { error } = await _c.supabase.from('nursing_mar').update({ countersigned_by: _c.userId }).eq('id', id);
  if (error) { _c.toast?.('Could not countersign: ' + error.message, 'error'); return; }
  // Finalize the linked pharmacy order too, if it was held back pending this countersign.
  const m = _activeOrders.find(x => x.id === id);
  if (m?.prescription_id) {
    await _c.supabase.from('prescriptions')
      .update({ review_status: 'finalized', finalized_by: _c.userId })
      .eq('id', m.prescription_id).eq('review_status', 'pending_review');
  }
  _c.toast?.('Order countersigned.', 'info');
  _loadActiveOrders(_adm.id);
};
