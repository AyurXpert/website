import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config/constants.js';
import { requireAuth, getCurrentProfile, getCurrentTenant } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

requireAuth(['nurse','super_admin','dept_admin','doctor']);
initNavbar();
wireDelegatedEvents();

const supabase  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const profile   = getCurrentProfile();
const tenant    = getCurrentTenant();
const tenantId  = tenant?.id;
const userId    = profile?.id;

let _admissions = [];
let _activeAdm  = null;
let _activeTab  = 'vitals';
let _shift      = 'morning';

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('nursing-date').value = new Date().toISOString().slice(0,10);
document.getElementById('io-date-label').textContent = new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});

// Load departments for ward selector
const { data: depts } = await supabase.from('departments')
  .select('id,name,ncism_code').eq('tenant_id', tenantId).eq('is_active', true).order('name');
const wardSel = document.getElementById('ward-select');
(depts||[]).forEach(d => {
  const opt = document.createElement('option');
  opt.value = d.id; opt.textContent = d.name + (d.ncism_code ? ' ('+d.ncism_code+')' : '');
  wardSel.appendChild(opt);
});

// ── Tab switching ─────────────────────────────────────────────────────────────
window.switchTab = function(tab, el) {
  document.querySelectorAll('.module-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _activeTab = tab;
  ['vitals','mar','io','notes','handover','ward-proc','risk'].forEach(t => {
    const el = document.getElementById('tab-'+t);
    if (el) el.hidden = t !== tab;
  });
  if (tab === 'ward-proc') {
    document.getElementById('wp-date').value = new Date().toISOString().slice(0,10);
    loadWardProcedures();
  }
  if (tab === 'risk') loadRiskHistory();
  if (_activeAdm) loadTabData(tab);
};

window.setShift = function(el, shift) {
  document.querySelectorAll('.shift-pill').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _shift = shift;
};

// ── Load patients in ward ─────────────────────────────────────────────────────
window.loadWardPatients = async function() {
  const deptId = document.getElementById('ward-select').value;
  if (!deptId) return;
  const { data } = await supabase.from('ipd_admissions')
    .select('id,admission_date,diagnosis_primary,patients(id,name,age,gender,phone),beds(bed_number,ward_name)')
    .eq('tenant_id', tenantId).eq('department_id', deptId).eq('status','admitted')
    .order('admission_date');
  _admissions = data || [];
  document.getElementById('pt-list-count').textContent = _admissions.length;
  const list = document.getElementById('patient-list');
  if (!_admissions.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;font-size:13px;color:var(--text-muted)">No admitted patients in this ward</div>';
    return;
  }
  list.innerHTML = _admissions.map(a => `
    <div class="pt-list-item${_activeAdm?.id===a.id?' active':''}" data-onclick="selectPatient" data-onclick-a0="${a.id}">
      <div class="pt-li-name">${a.patients?.name||'—'}</div>
      <div class="pt-li-meta">
        Bed ${a.beds?.bed_number||'?'} · ${a.patients?.age||'?'}/${(a.patients?.gender||'').charAt(0).toUpperCase()||'?'} · Day ${_daysSince(a.admission_date)}
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;font-style:italic">${a.diagnosis_primary||'—'}</div>
    </div>`).join('');
};

window.selectPatient = function(id) {
  _activeAdm = _admissions.find(a => a.id === id);
  if (!_activeAdm) return;
  document.getElementById('no-patient-msg').style.display = 'none';
  document.getElementById('patient-content').style.display = 'block';
  document.getElementById('rp-pt-name').textContent = _activeAdm.patients?.name || '—';
  document.getElementById('rp-pt-meta').textContent =
    `Age ${_activeAdm.patients?.age||'?'} · ${(_activeAdm.patients?.gender||'').charAt(0).toUpperCase()||'?'} · ${_activeAdm.diagnosis_primary||'—'} · Admitted ${_fmtDate(_activeAdm.admission_date)}`;
  document.getElementById('rp-bed-badge').textContent = 'Bed ' + (_activeAdm.beds?.bed_number||'—');
  loadWardPatients(); // refresh active state
  loadTabData(_activeTab);
};

function loadTabData(tab) {
  if (tab === 'vitals')   loadVitals();
  if (tab === 'mar')      loadMar();
  if (tab === 'io')       loadIo();
  if (tab === 'notes')    loadNotes();
  if (tab === 'handover') loadHandovers();
}

// ── Vitals Chart ──────────────────────────────────────────────────────────────
const VITAL_LIMITS = {
  pulse:  { low:40, high:130, msg:'Pulse abnormal' },
  rr:     { low:8,  high:30,  msg:'Respiratory rate abnormal' },
  spo2:   { low:90, high:null,msg:'SpO₂ low — check oxygen' },
  bp:     { low:80, high:180, msg:'BP abnormal' },
  sugar:  { low:60, high:400, msg:'Blood sugar critical' },
};

window.checkVital = function(name, val) {
  const v = parseFloat(val);
  const lim = VITAL_LIMITS[name];
  const el = document.getElementById('w-'+name);
  if (!el || !lim || isNaN(v)) { if(el) el.textContent=''; return; }
  if ((lim.low !== null && v < lim.low) || (lim.high !== null && v > lim.high))
    el.textContent = '⚠ ' + lim.msg;
  else el.textContent = '';
};

window._updatePainDisplay = function(val) {
  document.getElementById('v-pain-display').textContent = val;
};

window.saveVitals = async function() {
  if (!_activeAdm) return;
  const payload = {
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    patient_id:     _activeAdm.patients?.id,
    recorded_by:    userId,
    recorded_at:    new Date().toISOString(),
    shift:          _shift,
    temperature:    parseFloat(document.getElementById('v-temp').value) || null,
    pulse:          parseInt(document.getElementById('v-pulse').value) || null,
    respiratory_rate:parseInt(document.getElementById('v-rr').value) || null,
    spo2:           parseInt(document.getElementById('v-spo2').value) || null,
    bp_systolic:    parseInt(document.getElementById('v-bps').value) || null,
    bp_diastolic:   parseInt(document.getElementById('v-bpd').value) || null,
    blood_sugar:    parseFloat(document.getElementById('v-sugar').value) || null,
    weight:         parseFloat(document.getElementById('v-weight').value) || null,
    observation:    document.getElementById('v-obs').value.trim() || null,
    pain_score:     document.getElementById('v-pain-score').value !== '' ? parseInt(document.getElementById('v-pain-score').value) : null,
  };
  const { error } = await supabase.from('nursing_vitals').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not record vitals.')); return; }
  _alert('success', 'Vitals recorded.');
  ['v-temp','v-pulse','v-rr','v-spo2','v-bps','v-bpd','v-sugar','v-weight','v-obs'].forEach(id => {
    const el = document.getElementById(id); if(el) el.value='';
  });
  ['w-pulse','w-rr','w-spo2','w-bp','w-sugar'].forEach(id => {
    const el = document.getElementById(id); if(el) el.textContent='';
  });
  loadVitals();
};

async function loadVitals() {
  const since = new Date(Date.now() - 7*24*3600*1000).toISOString();
  const { data } = await supabase.from('nursing_vitals')
    .select('*').eq('admission_id', _activeAdm.id)
    .gte('recorded_at', since).order('recorded_at', { ascending:false });
  const tbody = document.getElementById('vitals-tbody');
  if (!data?.length) { tbody.innerHTML='<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--text-muted)">No vitals recorded yet</td></tr>'; return; }
  tbody.innerHTML = data.map(v => `<tr>
    <td>${new Date(v.recorded_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})} ${new Date(v.recorded_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}</td>
    <td>${v.temperature||'—'}</td>
    <td class="${v.pulse&&(v.pulse<40||v.pulse>130)?'alert-val':''}">${v.pulse||'—'}</td>
    <td class="${v.respiratory_rate&&(v.respiratory_rate<8||v.respiratory_rate>30)?'alert-val':''}">${v.respiratory_rate||'—'}</td>
    <td class="${v.spo2&&v.spo2<90?'alert-val':''}">${v.spo2||'—'}</td>
    <td class="${v.bp_systolic&&(v.bp_systolic<80||v.bp_systolic>180)?'alert-val':''}">${v.bp_systolic&&v.bp_diastolic?v.bp_systolic+'/'+v.bp_diastolic:'—'}</td>
    <td class="${v.blood_sugar&&(v.blood_sugar<60||v.blood_sugar>400)?'alert-val':''}">${v.blood_sugar||'—'}</td>
    <td style="font-size:11px">${v.observation||'—'}</td>
  </tr>`).join('');
}

// ── MAR ───────────────────────────────────────────────────────────────────────
async function loadMar() {
  const today = new Date().toISOString().slice(0,10);
  const { data: meds } = await supabase.from('nursing_mar')
    .select('*').eq('admission_id', _activeAdm.id).eq('is_active', true).order('created_at');
  const { data: given } = await supabase.from('nursing_mar_given')
    .select('*').eq('admission_id', _activeAdm.id).gte('given_at', today+'T00:00').order('given_at', {ascending:false});

  const FREQ_TIMES = {
    once_daily:['08:00'], twice_daily:['08:00','20:00'], thrice_daily:['08:00','14:00','20:00'],
    four_times:['08:00','12:00','16:00','20:00'], sos:['SOS'], stat:['STAT'], other:['As ordered']
  };

  if (!meds?.length) {
    document.getElementById('mar-content').innerHTML = `<div style="text-align:center;padding:30px;color:var(--text-muted)">No medicines in MAR yet. Click "+ Add Medicine" to add.</div>`;
    return;
  }

  const rows = meds.map(m => {
    const times = FREQ_TIMES[m.frequency] || ['—'];
    const timeCols = times.map(t => {
      const rec = (given||[]).find(g => g.mar_id === m.id && g.scheduled_time === t);
      const status = rec?.status || 'due';
      return `<td><span class="mar-status ms-${status}">${{given:'Given',held:'Held',refused:'Refused',due:'Due'}[status]||status}</span>
        ${status==='due' && t!=='SOS'&&t!=='STAT' ? `<br><button data-onclick="markGiven" data-onclick-a0="${m.id}" data-onclick-a1="${t}" style="font-size:10px;padding:2px 6px;border-radius:4px;background:#1a4a2e;color:#fff;border:none;cursor:pointer;margin-top:3px">✓ Give</button>` : ''}</td>`;
    }).join('');
    return `<tr>
      <td><div style="font-weight:600">${m.medicine_name}</div><div style="font-size:10px;color:var(--text-muted)">${m.dose} · ${m.route} · ${m.frequency?.replace(/_/g,' ')}</div>${m.instructions?`<div style="font-size:10px;color:var(--text-mid)">${m.instructions}</div>`:''}</td>
      ${timeCols}
    </tr>`;
  }).join('');

  const allTimes = [...new Set(meds.flatMap(m => (FREQ_TIMES[m.frequency]||['—'])))];
  document.getElementById('mar-content').innerHTML = `<div style="overflow-x:auto"><table class="mar-table">
    <thead><tr><th>Medicine</th>${allTimes.map(t=>`<th>${t}</th>`).join('')}</tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

window.markGiven = async function(marId, time) {
  if (!_activeAdm) return;
  const { error } = await supabase.from('nursing_mar_given').insert({
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    mar_id:         marId,
    given_by:       userId,
    given_at:       new Date().toISOString(),
    scheduled_time: time,
    status:         'given',
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not update MAR.')); return; }
  loadMar();
};

window.openAddMar = function() {
  document.getElementById('mar-start').value = new Date().toISOString().slice(0,10);
  document.getElementById('mar-modal-overlay').style.display = 'flex';
};
window.closeAddMar = function() { document.getElementById('mar-modal-overlay').style.display = 'none'; };
window._closeAddMarIfBackdrop = function(isTarget) { if (isTarget) closeAddMar(); };

window.saveMarMed = async function() {
  if (!_activeAdm) return;
  const { error } = await supabase.from('nursing_mar').insert({
    tenant_id:     tenantId,
    admission_id:  _activeAdm.id,
    medicine_name: document.getElementById('mar-med-name').value.trim(),
    dose:          document.getElementById('mar-dose').value.trim(),
    route:         document.getElementById('mar-route').value,
    frequency:     document.getElementById('mar-freq').value,
    start_date:    document.getElementById('mar-start').value || null,
    end_date:      document.getElementById('mar-end').value || null,
    instructions:  document.getElementById('mar-instructions').value.trim() || null,
    added_by:      userId,
    is_active:     true,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not add medicine to MAR.')); return; }
  _alert('success', 'Medicine added to MAR.');
  closeAddMar();
  loadMar();
};

// ── Intake-Output ─────────────────────────────────────────────────────────────
let _ioRows = { intake:[], output:[] };

function addIoRowHtml(type, label='', vol='') {
  const id = Date.now() + Math.random();
  const row = document.createElement('div');
  row.className = 'io-row';
  row.id = 'io-row-'+id;
  const sources = type==='intake'
    ? ['Oral Fluids','IV Fluids','NG Feeds','Blood Transfusion','Other']
    : ['Urine','Vomitus','Stool','Drain','Blood Loss','Other'];
  row.innerHTML = `
    <select style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:11px;font-family:'DM Sans',sans-serif;width:100%">
      ${sources.map(s=>`<option${s===label?' selected':''}>${s}</option>`).join('')}
    </select>
    <input type="number" placeholder="Volume (mL)" value="${vol}" data-oninput="calcIoTotals" style="height:32px;border:1.5px solid var(--border);border-radius:6px;padding:0 8px;font-size:12px;font-family:'DM Sans',sans-serif;width:100%"/>
    <span style="font-size:11px;color:var(--text-muted)">mL</span>
    <button data-onclick="_removeIoRow" data-onclick-a0="io-row-${id}" style="height:30px;width:28px;background:var(--red-light);border:1px solid #f5c6c6;border-radius:6px;cursor:pointer;font-size:12px;color:var(--red)">✕</button>`;
  document.getElementById(type+'-rows').appendChild(row);
  calcIoTotals();
}

window.addIoRow = addIoRowHtml;

window._removeIoRow = function(rowId) {
  document.getElementById(rowId)?.remove();
  calcIoTotals();
};

window.calcIoTotals = function() {
  const sum = id => [...document.querySelectorAll(`#${id}-rows input[type=number]`)].reduce((s,i)=>s+(parseFloat(i.value)||0),0);
  const tin = sum('intake'), tout = sum('output'), net = tin - tout;
  document.getElementById('total-intake').textContent = tin + ' mL';
  document.getElementById('total-output').textContent = tout + ' mL';
  const nb = document.getElementById('net-balance');
  nb.textContent = (net>=0?'+':'')+net + ' mL';
  nb.style.color = net < -500 ? 'var(--red)' : net > 500 ? 'var(--blue)' : 'var(--text-dark)';
};

async function loadIo() {
  const today = new Date().toISOString().slice(0,10);
  const { data } = await supabase.from('nursing_io')
    .select('*').eq('admission_id', _activeAdm.id).eq('record_date', today)
    .order('created_at', {ascending:false}).limit(1).maybeSingle();

  document.getElementById('intake-rows').innerHTML = '';
  document.getElementById('output-rows').innerHTML = '';
  if (data?.intake_items) data.intake_items.forEach(r => addIoRowHtml('intake', r.source, r.volume));
  else addIoRowHtml('intake');
  if (data?.output_items) data.output_items.forEach(r => addIoRowHtml('output', r.source, r.volume));
  else addIoRowHtml('output');
  calcIoTotals();
}

window.saveIo = async function() {
  if (!_activeAdm) return;
  const gatherRows = type => [...document.querySelectorAll(`#${type}-rows .io-row`)].map(row => ({
    source: row.querySelector('select').value,
    volume: parseFloat(row.querySelector('input').value) || 0,
  })).filter(r => r.volume > 0);

  const intake = gatherRows('intake'), output = gatherRows('output');
  const tin = intake.reduce((s,r)=>s+r.volume,0), tout = output.reduce((s,r)=>s+r.volume,0);
  const today = new Date().toISOString().slice(0,10);

  await supabase.from('nursing_io').upsert({
    tenant_id:      tenantId,
    admission_id:   _activeAdm.id,
    patient_id:     _activeAdm.patients?.id,
    record_date:    today,
    shift:          _shift,
    recorded_by:    userId,
    intake_items:   intake,
    output_items:   output,
    total_intake_ml:tin,
    total_output_ml:tout,
    net_balance_ml: tin - tout,
  }, { onConflict: 'admission_id,record_date,shift' });
  _alert('success', 'I/O chart saved.');
};

// ── Nursing Notes ─────────────────────────────────────────────────────────────
window.saveNote = async function() {
  if (!_activeAdm) return;
  const note = document.getElementById('note-text').value.trim();
  if (!note) { alert('Enter a note.'); return; }
  const time = document.getElementById('note-time').value || new Date().toTimeString().slice(0,5);
  const { error } = await supabase.from('nursing_notes').insert({
    tenant_id:    tenantId,
    admission_id: _activeAdm.id,
    patient_id:   _activeAdm.patients?.id,
    recorded_by:  userId,
    note_type:    document.getElementById('note-type').value,
    note_text:    note,
    note_time:    time,
    shift:        _shift,
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save note.')); return; }
  document.getElementById('note-text').value = '';
  _alert('success', 'Note saved.');
  loadNotes();
};

async function loadNotes() {
  const { data } = await supabase.from('nursing_notes')
    .select('*, profiles!recorded_by(full_name)')
    .eq('admission_id', _activeAdm.id).order('created_at', {ascending:false}).limit(30);
  const NOTE_TYPES = { general:'General', procedure:'Procedure', medication:'Medication', patient_education:'Pt Education', family_communication:'Family', incident:'⚠ Incident', doctor_call:'Doctor Call' };
  document.getElementById('notes-list').innerHTML = (data||[]).length ? (data||[]).map(n => `
    <div style="padding:10px 14px;background:var(--white);border:1.5px solid var(--border);border-radius:8px;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--cream);border:1px solid var(--border);color:var(--text-mid)">${NOTE_TYPES[n.note_type]||n.note_type}</span>
        <span style="font-size:11px;color:var(--text-muted)">${n.note_time||''} · ${n.shift} shift · ${n.profiles?.full_name||'Nurse'}</span>
      </div>
      <div style="font-size:13px;color:var(--text-dark)">${n.note_text}</div>
    </div>`) .join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No notes yet</div>';
}

// ── Shift Handover ────────────────────────────────────────────────────────────
window.saveHandover = async function() {
  if (!_activeAdm) return;
  const outNurse = document.getElementById('ho-out-nurse').value.trim();
  const inNurse  = document.getElementById('ho-in-nurse').value.trim();
  if (!outNurse || !inNurse) { _alert('error','Enter outgoing and incoming nurse names'); return; }
  const { error } = await supabase.from('nursing_handovers').insert({
    tenant_id:        tenantId,
    admission_id:     _activeAdm.id,
    patient_id:       _activeAdm.patients?.id,
    outgoing_nurse:   outNurse,
    incoming_nurse:   inNurse,
    shift:            _shift,
    condition:        document.getElementById('ho-condition').value,
    vitals_summary:   document.getElementById('ho-vitals').value.trim() || null,
    // SBAR fields
    situation:        document.getElementById('ho-situation')?.value.trim() || null,
    background:       document.getElementById('ho-background')?.value.trim() || null,
    key_events:       document.getElementById('ho-events').value.trim() || null,
    pending_meds:     document.getElementById('ho-pending-meds').value.trim() || null,
    instructions:     document.getElementById('ho-instructions').value.trim() || null,
    handover_at:      new Date().toISOString(),
  });
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save handover.')); return; }
  _alert('success', 'Handover saved.');
  loadHandovers();
};

async function loadHandovers() {
  const { data } = await supabase.from('nursing_handovers')
    .select('*').eq('admission_id', _activeAdm.id).order('handover_at', {ascending:false}).limit(10);
  const COND = { stable:'Stable', improving:'Improving', deteriorating:'⚠ Deteriorating', critical:'🔴 Critical' };
  document.getElementById('handover-list').innerHTML = (data||[]).length ? (data||[]).map(h=>`
    <div style="padding:12px 14px;background:var(--white);border:1.5px solid ${h.condition==='critical'?'#f5c6c6':h.condition==='deteriorating'?'#e8c060':'var(--border)'};border-radius:8px;margin-bottom:8px;font-size:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-weight:600">${h.outgoing_nurse||'—'} → ${h.incoming_nurse||'—'} <span style="font-weight:400;color:var(--text-muted)">(${h.shift} shift)</span></div>
        <span style="font-size:11px;font-weight:700;color:${h.condition==='critical'?'var(--red)':h.condition==='deteriorating'?'var(--gold)':'var(--green-mid)'}">${COND[h.condition]||h.condition}</span>
      </div>
      ${h.vitals_summary?`<div style="color:var(--text-mid)">Vitals: ${h.vitals_summary}</div>`:''}
      ${h.key_events?`<div style="margin-top:4px">Events: ${h.key_events}</div>`:''}
      ${h.instructions?`<div style="margin-top:4px;color:#1a4080">Next shift: ${h.instructions}</div>`:''}
    </div>`).join('') : '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">No handovers recorded</div>';
}

window.printHandover = function() { window.print(); };
window.printNursingChart = function() { window.print(); };

// ── §21k Ward Procedures ─────────────────────────────────────────────────────
window.saveWardProcedure = async function() {
  if (!_activeAdm) { _alert('error','Select a patient first'); return; }
  const proc = document.getElementById('wp-procedure').value.trim();
  if (!proc) { _alert('error','Procedure name is required'); return; }
  const payload = {
    tenant_id:         tenantId,
    ipd_admission_id:  _activeAdm.id,
    patient_id:        _activeAdm.patients?.id || null,
    procedure_date:    document.getElementById('wp-date').value || new Date().toISOString().slice(0,10),
    procedure_time:    document.getElementById('wp-time').value || null,
    procedure_name:    proc,
    done_by_designation: document.getElementById('wp-designation').value,
    outcome:           document.getElementById('wp-outcome').value,
    notes:             document.getElementById('wp-notes').value.trim() || null,
    done_by:           userId,
  };
  const { error } = await supabase.from('ward_procedures').insert(payload);
  if (error) {
    if (error.code === '42P01') _alert('error','Run session32_ncism_gaps.sql in Supabase first');
    else _alert('error', safeErrorMessage(error, 'Something went wrong. Please try again.'));
    return;
  }
  document.getElementById('wp-procedure').value = '';
  document.getElementById('wp-notes').value = '';
  document.getElementById('wp-outcome').value = 'successful';
  _alert('success', 'Procedure logged');
  loadWardProcedures();
};

window.loadWardProcedures = async function() {
  const el = document.getElementById('ward-proc-list');
  if (!_activeAdm) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">Select a patient to view procedures.</div>'; return; }
  const { data, error } = await supabase
    .from('ward_procedures')
    .select('*')
    .eq('ipd_admission_id', _activeAdm.id)
    .order('procedure_date', { ascending: false });
  if (error || !data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No procedures logged yet.</div>'; return; }
  el.innerHTML = data.map(p => `
    <div style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:#fafff7">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong style="font-size:13px">${p.procedure_name}</strong>
        <span style="font-size:11px;color:var(--text-muted)">${p.procedure_date} ${p.procedure_time ? p.procedure_time.slice(0,5) : ''}</span>
      </div>
      <div style="font-size:11px;color:var(--text-mid);margin-top:3px">${p.done_by_designation?.replace('_',' ')} · ${p.outcome?.replace('_',' ')} ${p.notes ? '· '+p.notes : ''}</div>
    </div>`).join('');
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtDate(d) { if(!d)return'—'; return new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'}); }
function _daysSince(d) { if(!d)return'?'; return Math.floor((Date.now()-new Date(d+'T00:00'))/86400000)+1; }
function _alert(type,msg) { const el=document.getElementById('alert-box');el.className=`alert ${type} show`;el.textContent=msg;setTimeout(()=>el.classList.remove('show'),4000); }

// ── NABH Risk Assessments ──────────────────────────────────────────────────────
window.calcMorse = function() {
  const score = ['morse-fall-hist','morse-sec-dx','morse-aid','morse-iv','morse-gait','morse-mental']
    .reduce((s,id) => s + parseInt(document.getElementById(id).value||0), 0);
  document.getElementById('morse-score').textContent = score;
  const lbl = document.getElementById('morse-risk-label');
  if (score < 25)       { lbl.textContent='Low Risk';    lbl.style.background='#e8f5ee'; lbl.style.color='#1a4a2e'; }
  else if (score <= 44) { lbl.textContent='Medium Risk'; lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else                  { lbl.textContent='High Risk';   lbl.style.background='#fdecea'; lbl.style.color='#8b1a1a'; }
};

window.calcBraden = function() {
  const score = ['braden-sensory','braden-moisture','braden-activity','braden-mobility','braden-nutrition','braden-friction']
    .reduce((s,id) => s + parseInt(document.getElementById(id).value||0), 0);
  document.getElementById('braden-score').textContent = score;
  const lbl = document.getElementById('braden-risk-label');
  if (score <= 9)       { lbl.textContent='High Risk';   lbl.style.background='#fdecea'; lbl.style.color='#8b1a1a'; }
  else if (score <= 12) { lbl.textContent='Medium Risk'; lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else if (score <= 14) { lbl.textContent='Low Risk';    lbl.style.background='#fff3cd'; lbl.style.color='#7a4a00'; }
  else                  { lbl.textContent='No Risk';     lbl.style.background='#e8f5ee'; lbl.style.color='#1a4a2e'; }
};

window.saveRiskAssessment = async function(type) {
  if (!_activeAdm) { _alert('error','Select a patient first'); return; }
  const interventions = document.getElementById('risk-interventions').value.trim();
  let payload = {
    tenant_id: tenantId,
    patient_id: _activeAdm.patients?.id,
    ipd_admission_id: _activeAdm.id,
    assessment_type: type,
    assessed_by: userId,
    interventions: interventions || null,
  };
  if (type === 'morse_fall') {
    const total = parseInt(document.getElementById('morse-score').textContent);
    const risk  = total < 25 ? 'low' : total <= 44 ? 'medium' : 'high';
    payload = { ...payload,
      morse_fall_history: parseInt(document.getElementById('morse-fall-hist').value),
      morse_secondary_dx: parseInt(document.getElementById('morse-sec-dx').value),
      morse_ambulatory_aid: parseInt(document.getElementById('morse-aid').value),
      morse_iv_heplock: parseInt(document.getElementById('morse-iv').value),
      morse_gait: parseInt(document.getElementById('morse-gait').value),
      morse_mental_status: parseInt(document.getElementById('morse-mental').value),
      morse_total: total, risk_level: risk,
    };
  } else {
    const total = parseInt(document.getElementById('braden-score').textContent);
    const risk  = total <= 9 ? 'high' : total <= 12 ? 'medium' : total <= 14 ? 'low' : 'low';
    payload = { ...payload,
      braden_sensory_perception: parseInt(document.getElementById('braden-sensory').value),
      braden_moisture: parseInt(document.getElementById('braden-moisture').value),
      braden_activity: parseInt(document.getElementById('braden-activity').value),
      braden_mobility: parseInt(document.getElementById('braden-mobility').value),
      braden_nutrition: parseInt(document.getElementById('braden-nutrition').value),
      braden_friction_shear: parseInt(document.getElementById('braden-friction').value),
      braden_total: total, risk_level: risk,
    };
  }
  const { error } = await supabase.from('risk_assessments').insert(payload);
  if (error) { _alert('error', safeErrorMessage(error, 'Could not save risk assessment.')); return; }
  document.getElementById('risk-saved-msg').style.display = '';
  setTimeout(() => { document.getElementById('risk-saved-msg').style.display = 'none'; }, 3000);
  loadRiskHistory();
};

async function loadRiskHistory() {
  if (!_activeAdm) return;
  const el = document.getElementById('risk-history');
  const { data } = await supabase.from('risk_assessments')
    .select('assessment_type,risk_level,morse_total,braden_total,assessment_datetime,profiles!assessed_by(full_name)')
    .eq('ipd_admission_id', _activeAdm.id)
    .order('assessment_datetime', { ascending: false }).limit(10);
  if (!data?.length) { el.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;font-size:13px">No assessments recorded yet.</div>'; return; }
  const typeLabel = { morse_fall:'Morse Fall', braden:'Braden (Pressure Ulcer)', dvt:'DVT', nutritional:'Nutritional' };
  const riskColor = { low:'#1a4a2e', medium:'#7a4a00', high:'#8b1a1a', very_high:'#8b1a1a' };
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7"><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Assessment</th><th style="padding:6px 10px;text-align:center;border-bottom:1.5px solid var(--border)">Score</th><th style="padding:6px 10px;text-align:center;border-bottom:1.5px solid var(--border)">Risk</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Assessed By</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Date/Time</th></tr></thead>
    <tbody>${data.map(r => `<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${typeLabel[r.assessment_type]||r.assessment_type}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:center;font-weight:600">${r.morse_total ?? r.braden_total ?? '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:center"><span style="font-size:11px;font-weight:600;color:${riskColor[r.risk_level]||'#333'};background:${riskColor[r.risk_level]||'#333'}15;padding:2px 8px;border-radius:10px;text-transform:capitalize">${r.risk_level||'—'}</span></td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${r.profiles?.full_name||'—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;color:var(--text-muted)">${new Date(r.assessment_datetime).toLocaleString('en-IN',{dateStyle:'short',timeStyle:'short'})}</td></tr>`).join('')}
    </tbody></table>`;
}
