import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

const params  = new URLSearchParams(window.location.search);
const visitId = params.get('visitId');

if (!visitId) {
  document.getElementById('state-msg').textContent = 'No visit ID provided.';
  throw new Error('No visitId');
}

// Read tenant from sessionStorage (set by auth.js on login)
const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');

async function load() {
  // 1. Visit + patient
  const { data: visit } = await supabase
    .from('visits')
    .select('id, token_number, chief_complaint, created_at, doctor_id, patients(id, name, phone, abha_number)')
    .eq('id', visitId)
    .single();

  if (!visit) {
    document.getElementById('state-msg').textContent = 'Visit not found.';
    return;
  }

  // 2. Doctor profile
  let doctorName = '—', doctorQual = '', doctorReg = '';
  if (visit.doctor_id) {
    const { data: doc } = await supabase
      .from('profiles')
      .select('full_name, qualification, registration_number')
      .eq('id', visit.doctor_id)
      .single();
    doctorName = doc?.full_name || '—';
    doctorQual = doc?.qualification || '';
    doctorReg  = doc?.registration_number || '';
  }

  // 3. Consultation notes (diagnosis, advice, follow-up)
  const { data: notesRows } = await supabase
    .from('consultation_notes')
    .select('modern_diagnosis, ayurveda_diagnosis, pathya, apathya, followup_date, followup_notes, rx_instructions')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false })
    .limit(1);
  const notes = notesRows?.[0] || {};

  // 4. Prescription
  const { data: presc } = await supabase
    .from('prescriptions')
    .select('id')
    .eq('visit_id', visitId)
    .maybeSingle();

  // 5. Prescription items
  let items = [];
  if (presc) {
    const { data: rows } = await supabase
      .from('prescription_items')
      .select('medicine_name, dosage, frequency, duration, anupana, quantity')
      .eq('prescription_id', presc.id);
    items = rows || [];
  }

  render(visit, doctorName, doctorQual, doctorReg, notes, items);
}

function _uhid(uuid) {
  return `AYX-${new Date().getFullYear()}-${(uuid||'').replace(/-/g,'').slice(-6).toUpperCase()}`;
}

function render(visit, doctorName, doctorQual, doctorReg, notes, items) {
  const patient = visit.patients;
  const date    = new Date(visit.created_at).toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
  const hasDiag = notes.modern_diagnosis || notes.ayurveda_diagnosis;
  const hasAdvice = notes.pathya || notes.apathya;

  document.getElementById('rx-card').innerHTML = `

    <!-- Clinic header -->
    <div class="rx-header">
      <div>
        <div class="clinic-name">${_esc(tenant.name || 'AyurXpert Clinic')}</div>
        <div class="clinic-type">${_esc(_tenantTypeLabel(tenant.type))}</div>
        <div class="clinic-address">${_esc([tenant.address, tenant.city, tenant.state].filter(Boolean).join(', '))}</div>
      </div>
      <div class="doctor-block">
        <div class="doctor-name">${_esc(doctorName)}</div>
        ${doctorQual ? `<div class="doctor-qual">${_esc(doctorQual)}</div>` : ''}
        ${doctorReg  ? `<div class="reg-num">Reg. No: ${_esc(doctorReg)}</div>` : ''}
      </div>
    </div>

    <!-- Patient info -->
    <div class="pt-strip">
      <div class="pt-field">
        <label>Patient</label>
        <span>${_esc(patient?.name) || '—'}</span>
      </div>
      <div class="pt-field">
        <label>UHID</label>
        <span>${_uhid(patient?.id)}</span>
      </div>
      <div class="pt-field">
        <label>Date</label>
        <span>${date}</span>
      </div>
      <div class="pt-field">
        <label>Token</label>
        <span>#${visit.token_number}</span>
      </div>
      <div class="pt-field">
        <label>Phone</label>
        <span>${_esc(patient?.phone) || '—'}</span>
      </div>
      ${patient?.abha_number ? `<div class="pt-field"><label>ABHA</label><span>${_esc(patient.abha_number)}</span></div>` : ''}
    </div>

    <!-- Diagnosis -->
    ${hasDiag ? `
    <div class="diag-box">
      ${notes.modern_diagnosis ? `<div class="diag-item"><label>Diagnosis</label><span>${_esc(notes.modern_diagnosis)}</span></div>` : ''}
      ${notes.ayurveda_diagnosis ? `<div class="diag-item"><label>Ayurveda Diagnosis</label><span>${_esc(notes.ayurveda_diagnosis)}</span></div>` : ''}
    </div>` : ''}

    <!-- Medicines -->
    <div class="rx-body">
      <div class="rx-symbol">&#8478;</div>
      ${items.length ? `
      <table class="med-table">
        <thead>
          <tr>
            <th style="width:24px">#</th>
            <th>Medicine</th>
            <th>Dosage</th>
            <th>Frequency</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, i) => `
            <tr>
              <td class="med-num">${i+1}.</td>
              <td>
                <div class="med-name">${_esc(item.medicine_name) || '—'}</div>
                ${item.anupana ? `<div class="med-anupana">with ${_esc(item.anupana)}</div>` : ''}
              </td>
              <td class="med-dose">${_esc(item.dosage) || '—'}</td>
              <td><span class="med-freq">${_esc(item.frequency) || '—'}</span></td>
              <td class="med-dose">${_esc(item.duration) || '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      ${notes.rx_instructions ? `<div style="margin-top:10px;font-size:12px;color:var(--text-mid);padding:8px 10px;background:var(--cream);border-radius:6px;border-left:3px solid var(--green-mid)">${_esc(notes.rx_instructions)}</div>` : ''}
      ` : '<div style="color:var(--text-muted);font-size:13px;padding:8px 0">No medicines prescribed.</div>'}
    </div>

    <!-- Advice -->
    ${hasAdvice ? `
    <div class="advice-box">
      ${notes.pathya ? `<div class="advice-col"><label>Pathya (Follow)</label><p>${_esc(notes.pathya)}</p></div>` : ''}
      ${notes.apathya ? `<div class="advice-col"><label>Apathya (Avoid)</label><p>${_esc(notes.apathya)}</p></div>` : ''}
    </div>` : ''}

    <!-- Follow-up + signature -->
    <div class="rx-footer">
      <div class="followup-block">
        ${notes.followup_date ? `
          <label>Review Date</label>
          <span>${new Date(notes.followup_date).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}</span>
          ${notes.followup_notes ? `<div class="followup-note">${_esc(notes.followup_notes)}</div>` : ''}
        ` : `<div style="font-size:12px;color:var(--text-muted)">Review date: _______________</div>`}
      </div>
      <div class="sig-block">
        <div class="sig-line">${_esc(doctorName)}<br><span style="font-size:11px;color:var(--text-muted)">Signature &amp; Stamp</span></div>
      </div>
    </div>

    <div class="rx-powered">Powered by AyurXpert HMS · ayurxpert.com</div>
  `;
}

function _tenantTypeLabel(type) {
  const map = { clinic:'Ayurveda Clinic', hospital:'Ayurveda Hospital', teaching_hospital:'Ayurveda Teaching Hospital', pk_center:'Panchakarma Centre', dispensary:'Dispensary', college:'Ayurveda College', pharma:'Pharmacy', wellness:'Wellness Centre' };
  return map[type] || 'Healthcare Centre';
}

load();
