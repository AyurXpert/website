// Prescription print -- printPrescription.html?rxId=<id> (?visitId= = that visit's latest, kept for old links).
// Session 338: the SERVER decides ORIGINAL vs DUPLICATE COPY No. N (record_document_print('prescription', id)) and the
// page fails closed if that cannot be recorded; a draft (not yet countersigned) is shown as a DRAFT and never recorded.
// The prescriber's identity is the one STAMPED on the prescription when it was finalised (prescriber_identity:
// verified name, Reg. No., council, qualification, HPR ID); a prescription from before that stamp falls back to the
// Session 308c snapshot columns + the prescriber's current verified values. Organisation + demo flag come from the
// prescription's own tenant row. Shared helpers: signInGate, paperSize (A4 / A5), demoBanner, printPageSize.
// Built with DOM nodes / textContent only.
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { requireAuth } from '../core/auth.js';
import { ROLES } from '../config/constants.js';
import { uhidOf } from '../utils/uhid.js';
import { safeErrorMessage } from '../utils/errors.js';
import { ensureSignedIn } from '../utils/signInGate.js';
import { el } from '../modules/billing/invoiceLayout.js';
import { demoBannerEl } from '../modules/billing/demoBanner.js';
import { applyPaperSize, getPaperSizeFrom, mountPaperSizeSelect, watchPrintPageSize } from '../modules/billing/paperSize.js';
import { identityLines, liveIdentity } from '../utils/signerIdentity.js';

const SIZES = ['a4', 'a5'];
applyPaperSize(getPaperSizeFrom(SIZES));
wireDelegatedEvents();

const card     = document.getElementById('rx-card');
const printBtn = document.getElementById('print-btn');
const params   = new URLSearchParams(window.location.search);
const rxId     = params.get('rxId');
const visitIdParam = params.get('visitId');

function showMessage(msg) {
  card.replaceChildren(el('div', { class: 'state-msg', role: 'alert' }, msg));
  if (printBtn) printBtn.disabled = true;
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(iso) {
  if (!iso) return '—';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: '2-digit' })
    .formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return `${p.day} ${MON[Number(p.month) - 1]} ${p.year}`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function tenantTypeLabel(type) {
  const map = { clinic:'Ayurveda Clinic', hospital:'Ayurveda Hospital', teaching_hospital:'Ayurveda Teaching Hospital', pk_center:'Panchakarma Centre', dispensary:'Dispensary', college:'Ayurveda College', pharma:'Pharmacy', wellness:'Wellness Centre' };
  return map[type] || 'Healthcare Centre';
}

async function load() {
  if (!rxId && !visitIdParam) { showMessage('No prescription or visit ID provided.'); return; }
  // signed out / session ended: ask to sign in before touching the document
  if (!(await ensureSignedIn(supabase))) return;
  await requireAuth([ROLES.DOCTOR, ROLES.TRAINEE_DOCTOR, ROLES.RECEPTIONIST, ROLES.PHARMACIST, ROLES.NURSE, ROLES.MRD_STAFF]);

  const COLS = 'id, tenant_id, visit_id, doctor_id, finalized_by, review_status, is_deleted, created_at, prepared_by_name, '
             + 'prescriber_display_name, prescriber_hpr_id, prescriber_registration_number, prescriber_identity';
  let presc = null;
  if (rxId) {
    const { data } = await supabase.from('prescriptions').select(COLS).eq('id', rxId).maybeSingle();
    presc = data;
  } else {
    const { data } = await supabase.from('prescriptions').select(COLS)
      .eq('visit_id', visitIdParam).order('created_at', { ascending: false }).limit(1).maybeSingle();
    presc = data;
  }
  if (!presc) { showMessage('Prescription not found.'); return; }
  if (presc.is_deleted) { showMessage('This prescription was deleted.'); return; }

  const isDraft = presc.review_status !== 'finalized';
  // Print audit first: a finalised prescription is never shown without its Original / Duplicate marking (fail closed)
  let copy = null;
  if (!isDraft) {
    const rec = await supabase.rpc('record_document_print', { p_doc_type: 'prescription', p_doc_id: presc.id });
    if (rec.error) { showMessage(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return; }
    copy = rec.data;
  }

  const [{ data: visit }, { data: org }, { data: notesRows }, { data: items }] = await Promise.all([
    supabase.from('visits').select('id, token_number, created_at, patients(id, uhid, name, phone, abha_number)').eq('id', presc.visit_id).maybeSingle(),
    supabase.from('tenants').select('name, tagline, type, full_address, address, city, state, gstin, logo_url, is_demo').eq('id', presc.tenant_id).maybeSingle(),
    supabase.from('consultation_notes').select('modern_diagnosis, ayurveda_diagnosis, pathya, apathya, followup_date, followup_notes, rx_instructions')
      .eq('visit_id', presc.visit_id).order('created_at', { ascending: false }).limit(1),
    supabase.from('prescription_items').select('medicine_name, dosage, frequency, duration, anupana, quantity').eq('prescription_id', presc.id),
  ]);

  // The responsible prescriber: the stamp; else the 308c snapshot + current verified values (legacy)
  let signer = presc.prescriber_identity || null;
  if (!signer && !isDraft) {
    const live = await liveIdentity(supabase, presc.finalized_by || presc.doctor_id);
    signer = {
      ...(live || {}),
      name: presc.prescriber_display_name || live?.name || '—',
      registration_number: presc.prescriber_registration_number || live?.registration_number || null,
      hpr_id: presc.prescriber_hpr_id || live?.hpr_id || null,
    };
  }
  const preparedName = presc.prepared_by_name && signer?.name && presc.prepared_by_name !== signer.name ? presc.prepared_by_name : '';

  const draw = () => {
    render({ presc, visit, org: org || {}, notes: notesRows?.[0] || {}, items: items || [], signer, preparedName, isDraft, copy });
  };
  draw();
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw, { sizes: SIZES });
  watchPrintPageSize(() => card);
  if (printBtn) printBtn.disabled = false;
}

function render({ presc, visit, org, notes, items, signer, preparedName, isDraft, copy }) {
  const patient = visit?.patients || {};
  const isDup  = copy && copy.copy !== 'ORIGINAL';
  const copyNo = copy ? (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0) : null;

  const nodes = [];
  if (org.is_demo) nodes.push(demoBannerEl());

  // ── Header: organisation + prescriber ──
  const docBlock = el('div', { class: 'doctor-block' });
  if (!isDraft && signer) {
    if (preparedName) {
      docBlock.append(el('div', { class: 'doctor-name' }, `Dr. ${preparedName}`),
                      el('div', { class: 'doctor-name', style: 'margin-top:4px' }, `for Dr. ${signer.name}`));
    } else {
      docBlock.append(el('div', { class: 'doctor-name' }, signer.name || '—'));
    }
    for (const line of identityLines(signer)) docBlock.append(el('div', { class: 'reg-num' }, line));
  }
  nodes.push(el('div', { class: 'rx-header' },
    el('div', { class: 'clinic-header-row' },
      org.logo_url ? el('img', { class: 'clinic-logo', src: org.logo_url, alt: '' }) : null,
      el('div', null,
        el('div', { class: 'clinic-name' }, org.name || 'AyurXpert Clinic'),
        org.tagline ? el('div', { class: 'clinic-tagline' }, org.tagline) : null,
        el('div', { class: 'clinic-type' }, tenantTypeLabel(org.type)),
        el('div', { class: 'clinic-address' }, [org.full_address || org.address, org.city, org.state].filter(Boolean).join(', ')),
        org.gstin ? el('div', { class: 'clinic-gstin' }, `GSTIN: ${org.gstin}`) : null)),
    docBlock));

  // ── Copy marking (same number in the header and the footer) ──
  if (isDraft) {
    nodes.push(el('div', { class: 'draft-banner', role: 'note' }, 'DRAFT — not valid until countersigned by a doctor'));
  } else {
    nodes.push(el('div', { class: 'copy-strip' + (isDup ? ' dup' : '') }, isDup ? `DUPLICATE COPY · No. ${copyNo}` : 'Original'));
  }

  // ── Patient ──
  const field = (label, value) => el('div', { class: 'pt-field' }, el('label', null, label), el('span', null, value || '—'));
  nodes.push(el('div', { class: 'pt-strip' },
    field('Patient', patient.name), field('UHID', uhidOf(patient)), field('Date', fmtDate(visit?.created_at || presc.created_at)),
    field('Token', visit?.token_number != null ? `#${visit.token_number}` : '—'), field('Phone', patient.phone),
    patient.abha_number ? field('ABHA', patient.abha_number) : null));

  // ── Diagnosis ──
  if (notes.modern_diagnosis || notes.ayurveda_diagnosis) {
    nodes.push(el('div', { class: 'diag-box' },
      notes.modern_diagnosis ? el('div', { class: 'diag-item' }, el('label', null, 'Diagnosis'), el('span', null, notes.modern_diagnosis)) : null,
      notes.ayurveda_diagnosis ? el('div', { class: 'diag-item' }, el('label', null, 'Ayurveda Diagnosis'), el('span', null, notes.ayurveda_diagnosis)) : null));
  }

  // ── Medicines ──
  const body = el('div', { class: 'rx-body' }, el('div', { class: 'rx-symbol', 'aria-label': 'Prescription' }, '℞'));
  if (items.length) {
    body.append(el('table', { class: 'med-table' },
      el('thead', null, el('tr', null, ...['#', 'Medicine', 'Dosage', 'Frequency', 'Duration'].map(t => el('th', { scope: 'col' }, t)))),
      el('tbody', null, items.map((it, i) => el('tr', null,
        el('td', { class: 'med-num' }, `${i + 1}.`),
        el('td', null, el('div', { class: 'med-name' }, it.medicine_name || '—'),
          it.anupana ? el('div', { class: 'med-anupana' }, `with ${it.anupana}`) : null),
        el('td', { class: 'med-dose' }, it.dosage || '—'),
        el('td', null, el('span', { class: 'med-freq' }, it.frequency || '—')),
        el('td', { class: 'med-dose' }, it.duration || '—'))))));
    if (notes.rx_instructions) body.append(el('div', { class: 'rx-instr' }, notes.rx_instructions));
  } else {
    body.append(el('div', { class: 'rx-empty' }, 'No medicines prescribed.'));
  }
  nodes.push(body);

  // ── Advice ──
  if (notes.pathya || notes.apathya) {
    nodes.push(el('div', { class: 'advice-box' },
      notes.pathya ? el('div', { class: 'advice-col' }, el('label', null, 'Pathya (Follow)'), el('p', null, notes.pathya)) : null,
      notes.apathya ? el('div', { class: 'advice-col' }, el('label', null, 'Apathya (Avoid)'), el('p', null, notes.apathya)) : null));
  }

  // ── Follow-up + signature (name and identity under the line) ──
  const follow = el('div', { class: 'followup-block' });
  if (notes.followup_date) {
    follow.append(el('label', null, 'Review Date'), el('span', null, fmtDate(notes.followup_date + 'T12:00:00+05:30')),
      notes.followup_notes ? el('div', { class: 'followup-note' }, notes.followup_notes) : null);
  } else {
    follow.append(el('div', { class: 'followup-empty' }, 'Review date: _______________'));
  }
  const sig = el('div', { class: 'sig-block' });
  if (!isDraft) {
    sig.append(el('div', { class: 'sig-line' },
      el('div', { class: 'sig-name' }, preparedName ? `Dr. ${preparedName} for Dr. ${signer?.name || '—'}` : (signer?.name || '—')),
      ...identityLines(signer).map(l => el('div', { class: 'sig-cred' }, l)),
      el('div', { class: 'sig-caption' }, 'Signature & Stamp')));
  }
  nodes.push(el('div', { class: 'rx-footer' }, follow, sig));

  // ── Footer: copy line + powered-by ──
  if (isDup) {
    nodes.push(el('div', { class: 'copy-foot' }, `Duplicate copy no. ${copyNo}. ` + (copy.legacy
      ? 'Written before print tracking began; the original was printed at the time.'
      : `The original was first printed ${fmtDateTime(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`)));
  }
  nodes.push(el('div', { class: 'rx-powered' }, 'Powered by AyurXpert HMS · ayurxpert.com'));

  card.replaceChildren(...nodes);
}

window.printPrescriptionNow = () => window.print();

load().catch(err => showMessage(safeErrorMessage(err, 'Could not load the prescription.')));
