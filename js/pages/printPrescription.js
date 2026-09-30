import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { requireAuth } from '../core/auth.js';
import { ROLES } from '../config/constants.js';
import { uhidOf } from '../utils/uhid.js';

// Session 308c — this page had no auth gate at all until now (it was unreachable from any real
// caller, per a repo-wide search). Roles that legitimately view/print a prescription: doctor/
// trainee_doctor (their own consultations/orders), receptionist (counter reprints), pharmacist
// (dispensing reference), nurse (IPD take-home meds), mrd_staff (records reprints). super_admin
// bypasses this list entirely per requireAuth()'s own convention.
await requireAuth([
  ROLES.DOCTOR, ROLES.TRAINEE_DOCTOR, ROLES.RECEPTIONIST, ROLES.PHARMACIST, ROLES.NURSE, ROLES.MRD_STAFF,
]);

wireDelegatedEvents();

function _esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Session 308c — loads a SPECIFIC prescription by id (?rxId=) rather than "the visit's latest row",
// so a visit with more than one prescription over time always prints the one actually asked for.
// ?visitId= alone is kept for backward compatibility (no caller in this codebase currently links to
// this page at all — confirmed by search — but the URL contract is documented in user-manual.html,
// so an existing bookmark/hand-typed link still resolves to the visit's latest prescription as before.
const params  = new URLSearchParams(window.location.search);
const rxId    = params.get('rxId');
const visitIdParam = params.get('visitId');

if (!rxId && !visitIdParam) {
  document.getElementById('state-msg').textContent = 'No prescription or visit ID provided.';
  throw new Error('No rxId/visitId');
}

// Read tenant from sessionStorage (set by auth.js on login)
const tenant = JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}');

async function load() {
  // 1. The prescription itself — by id if given, else the visit's latest (legacy fallback).
  const PRESC_COLS = 'id, visit_id, review_status, prepared_by_name, prescriber_display_name, prescriber_hpr_id, prescriber_registration_number';
  let presc = null;
  if (rxId) {
    const { data } = await supabase.from('prescriptions').select(PRESC_COLS).eq('id', rxId).maybeSingle();
    presc = data;
    if (!presc) { document.getElementById('state-msg').textContent = 'Prescription not found.'; return; }
  } else {
    const { data } = await supabase.from('prescriptions').select(PRESC_COLS)
      .eq('visit_id', visitIdParam).order('created_at', { ascending: false }).limit(1).maybeSingle();
    presc = data || null;
  }
  const visitId = presc?.visit_id || visitIdParam;

  // 2. Visit + patient
  const { data: visit } = await supabase
    .from('visits')
    .select('id, token_number, chief_complaint, created_at, doctor_id, patients(id, uhid, name, phone, abha_number)')
    .eq('id', visitId)
    .single();

  if (!visit) {
    document.getElementById('state-msg').textContent = 'Visit not found.';
    return;
  }

  // 3. Doctor / prescriber block. Session 308c: HPR ID/registration number must come from the
  // prescription's own server-set snapshot (taken at finalization), never live from profiles --
  // that live join is exactly the bug this feature closes (a later credential correction must not
  // silently change what an already-printed prescription shows). Qualification isn't a
  // credential-of-record the same way, so it still reads live. Three print modes:
  //   'draft'    review_status is not yet 'finalized' -- an intern's un-countersigned order.
  //   'dual'     finalized, and the author differs from the credentialed signer (a PG scholar
  //              prescribing under a consultant, or a trainee's IPD order a doctor countersigned) --
  //              print BOTH names.
  //   'normal'   finalized, author IS the signer (the ordinary case) -- print ONE doctor block.
  //   'fallback' no snapshot at all (a prescription that predates this feature, or none exists for
  //              this visit) -- live name only from visit.doctor_id, never a live HPR/registration.
  let mode = 'fallback';
  let doctorName = '—', doctorQual = '', doctorHpr = '', doctorReg = '';
  let preparedName = '', preparedHpr = '', preparedReg = '';

  if (visit.doctor_id) {
    const { data: doc } = await supabase.from('profiles').select('full_name, qualification').eq('id', visit.doctor_id).single();
    doctorName = doc?.full_name || '—';
    doctorQual = doc?.qualification || '';
  }

  if (presc && presc.review_status !== 'finalized') {
    mode = 'draft';
  } else if (presc?.prescriber_display_name) {
    doctorName = presc.prescriber_display_name;
    doctorHpr  = presc.prescriber_hpr_id || '';
    doctorReg  = presc.prescriber_registration_number || '';
    if (presc.prepared_by_name && presc.prepared_by_name !== presc.prescriber_display_name) {
      mode = 'dual';
      preparedName = presc.prepared_by_name;
      // prepared_by_hpr_id/registration_number exist for the rare case a trainee already holds one
      // (e.g. HPR ID, settable for any staff role via the pre-existing set_staff_hpr_id()); shown
      // only if present, same "only if present" rule as the prescriber's own credentials.
    } else {
      mode = 'normal';
    }
  }
  // else: mode stays 'fallback' -- doctorName already has the live profile name from above;
  // doctorHpr/doctorReg stay blank rather than reading a live value that could have changed since.

  // 4. Consultation notes (diagnosis, advice, follow-up)
  const { data: notesRows } = await supabase
    .from('consultation_notes')
    .select('modern_diagnosis, ayurveda_diagnosis, pathya, apathya, followup_date, followup_notes, rx_instructions')
    .eq('visit_id', visitId)
    .order('created_at', { ascending: false })
    .limit(1);
  const notes = notesRows?.[0] || {};

  // 5. Prescription items
  let items = [];
  if (presc) {
    const { data: rows } = await supabase
      .from('prescription_items')
      .select('medicine_name, dosage, frequency, duration, anupana, quantity')
      .eq('prescription_id', presc.id);
    items = rows || [];
  }

  render(visit, { mode, doctorName, doctorQual, doctorHpr, doctorReg, preparedName, preparedHpr, preparedReg }, notes, items);
}


function render(visit, rx, notes, items) {
  const patient = visit.patients;
  const date    = new Date(visit.created_at).toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'});
  const hasDiag = notes.modern_diagnosis || notes.ayurveda_diagnosis;
  const hasAdvice = notes.pathya || notes.apathya;
  const { mode, doctorName, doctorQual, doctorHpr, doctorReg, preparedName, preparedHpr, preparedReg } = rx;

  const draftBanner = mode === 'draft'
    ? `<div style="background:#fff3cd;border:1.5px solid #e0a800;border-radius:8px;padding:10px 14px;margin:10px 0;font-weight:700;color:#7a5c00;text-align:center">
        DRAFT — not valid until countersigned by a doctor
       </div>` : '';

  const doctorBlockHtml = mode === 'draft' ? '' : mode === 'dual' ? `
        <div class="doctor-name">Dr. ${_esc(preparedName)}</div>
        ${preparedHpr ? `<div class="reg-num">HPR ID: ${_esc(preparedHpr)}</div>` : ''}
        ${preparedReg ? `<div class="reg-num">Reg. No: ${_esc(preparedReg)}</div>` : ''}
        <div class="doctor-name" style="margin-top:4px">for Dr. ${_esc(doctorName)}</div>
        ${doctorHpr ? `<div class="reg-num">HPR ID: ${_esc(doctorHpr)}</div>` : ''}
        ${doctorReg ? `<div class="reg-num">Reg. No: ${_esc(doctorReg)}</div>` : ''}
    ` : `
        <div class="doctor-name">${_esc(doctorName)}</div>
        ${doctorQual ? `<div class="doctor-qual">${_esc(doctorQual)}</div>` : ''}
        ${doctorHpr  ? `<div class="reg-num">HPR ID: ${_esc(doctorHpr)}</div>` : ''}
        ${doctorReg  ? `<div class="reg-num">Reg. No: ${_esc(doctorReg)}</div>` : ''}
    `;

  const sigBlockHtml = mode === 'draft' ? '' : `
      <div class="sig-block">
        <div class="sig-line">${mode === 'dual' ? `Dr. ${_esc(preparedName)} for Dr. ${_esc(doctorName)}` : _esc(doctorName)}<br><span style="font-size:11px;color:var(--text-muted)">Signature &amp; Stamp</span></div>
      </div>`;

  document.getElementById('rx-card').innerHTML = `

    <!-- Clinic header -->
    <div class="rx-header">
      <div class="clinic-header-row">
        ${tenant.logo_url ? `<img class="clinic-logo" src="${_esc(tenant.logo_url)}" alt=""/>` : ''}
        <div>
          <div class="clinic-name">${_esc(tenant.name || 'AyurXpert Clinic')}</div>
          ${tenant.tagline ? `<div class="clinic-tagline">${_esc(tenant.tagline)}</div>` : ''}
          <div class="clinic-type">${_esc(_tenantTypeLabel(tenant.type))}</div>
          <div class="clinic-address">${_esc([tenant.full_address || tenant.address, tenant.city, tenant.state].filter(Boolean).join(', '))}</div>
          ${tenant.gstin ? `<div class="clinic-gstin">GSTIN: ${_esc(tenant.gstin)}</div>` : ''}
        </div>
      </div>
      <div class="doctor-block">${doctorBlockHtml}</div>
    </div>

    ${draftBanner}

    <!-- Patient info -->
    <div class="pt-strip">
      <div class="pt-field">
        <label>Patient</label>
        <span>${_esc(patient?.name) || '—'}</span>
      </div>
      <div class="pt-field">
        <label>UHID</label>
        <span>${_esc(uhidOf(patient))}</span>
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
      ${sigBlockHtml}
    </div>

    <div class="rx-powered">Powered by AyurXpert HMS · ayurxpert.com</div>
  `;
}

function _tenantTypeLabel(type) {
  const map = { clinic:'Ayurveda Clinic', hospital:'Ayurveda Hospital', teaching_hospital:'Ayurveda Teaching Hospital', pk_center:'Panchakarma Centre', dispensary:'Dispensary', college:'Ayurveda College', pharma:'Pharmacy', wellness:'Wellness Centre' };
  return map[type] || 'Healthcare Centre';
}

load();
