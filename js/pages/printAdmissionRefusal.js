// "Refused admission against medical advice" signature form -- printAdmissionRefusal.html?adviceId=<id> (Session 356, TODO §265-A, D13).
// The refusal is RECORDED at the admission counter (reception.html -> refuse_admission_advice: reason, who, when; the advising
// doctor is alerted by the server); this page only prints what was stored. The SERVER decides Original vs DUPLICATE COPY No. N
// (record_document_print('admission_refusal', id)) and the page fails closed if that cannot be recorded. Paper: A4 / Letter
// (shared paperSize helper; a size change is never a new copy). Built with DOM nodes / textContent only.
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

const SIZES = ['a4', 'letter'];
applyPaperSize(getPaperSizeFrom(SIZES));
wireDelegatedEvents();

const card     = document.getElementById('mc-card');
const printBtn = document.getElementById('print-btn');
const adviceId = new URLSearchParams(window.location.search).get('adviceId');
// "this hospital" / "this clinic" / "this centre", by the organisation's type (same words as the medical certificate)
function placeWord(type) {
  if (['hospital', 'teaching_hospital', 'college'].includes(type)) return 'this hospital';
  if (['clinic', 'dispensary'].includes(type)) return 'this clinic';
  return 'this centre';
}
const SEX = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', o: 'Other', other: 'Other' };

function showMessage(msg) {
  card.replaceChildren(el('div', { class: 'state-msg', role: 'alert' }, msg));
  if (printBtn) printBtn.disabled = true;
}
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' }) : '';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

async function load() {
  if (!adviceId) { showMessage('No admission advice ID provided.'); return; }
  if (!(await ensureSignedIn(supabase))) return;
  // the admission counter, MRD and the advising doctor (the server's _admission_refusal_reader decides)
  await requireAuth([ROLES.RECEPTIONIST, ROLES.DEPT_ADMIN, ROLES.MRD_STAFF, ROLES.DOCTOR]);

  // Print audit first: never shown without its Original / Duplicate marking (fail closed)
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'admission_refusal', p_doc_id: adviceId });
  if (rec.error) { showMessage(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return; }
  const { data, error } = await supabase.rpc('get_admission_refusal_print', { p_advice_id: adviceId });
  if (error || !data) { showMessage(safeErrorMessage(error, 'Could not load the form.')); return; }

  const draw = () => render(data, rec.data);
  draw();
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw, { sizes: SIZES });
  watchPrintPageSize(() => card);
  printBtn.disabled = false;
}

function render(d, copy) {
  const a = d.advice || {}, pt = d.patient || {}, org = d.organisation || {};
  const isDup  = copy.copy !== 'ORIGINAL';
  const copyNo = Number(copy.print_no) || 1;
  const copyText = isDup ? `DUPLICATE COPY · No. ${copyNo}` : 'Original';
  const nodes = [];
  if (org.is_demo) nodes.push(demoBannerEl());

  nodes.push(el('div', { class: 'mc-header' },
    org.logo_url ? el('img', { class: 'mc-logo', src: org.logo_url, alt: '' }) : null,
    el('div', null,
      el('div', { class: 'org-name' }, org.name || ''),
      org.tagline ? el('div', { class: 'org-tagline' }, org.tagline) : null,
      el('div', { class: 'org-lines' }, [org.address, org.city, org.state].filter(Boolean).join(', ')),
      org.phone ? el('div', { class: 'org-lines' }, `Ph: ${org.phone}`) : null)));

  nodes.push(el('div', { class: 'mc-titlebar' },
    el('div', { class: 'mc-title' }, 'Refusal of Admission Against Medical Advice')));
  nodes.push(el('div', { class: 'copy-strip' + (isDup ? ' dup' : '') }, copyText));

  const sex = SEX[String(pt.gender || '').toLowerCase()] || '';
  const ageSex = [pt.age != null && pt.age !== '' ? `${pt.age} y` : '', sex].filter(Boolean).join(' / ');
  const row = (k, v) => [el('dt', null, k), el('dd', null, v || '—')];
  const body = el('div', { class: 'mc-body' },
    el('dl', { class: 'rf-grid' },
      ...row('Patient', pt.name), ...row('UHID', uhidOf(pt)), ...row('Age / Sex', ageSex), ...row('Phone', pt.phone),
      ...row('Advised by', a.doctor_name), ...row('Department', a.department), ...row('Advised on', fmtDate(a.advised_at)),
      ...row('Reason for admission', a.clinical_indication),
      ...row('Expected stay', a.expected_duration_days ? `${a.expected_duration_days} day${a.expected_duration_days > 1 ? 's' : ''}` : ''),
      ...row('Reason for refusal', a.refusal_reason), ...row('Recorded', `${fmtDateTime(a.refused_at)}${a.recorded_by ? ' by ' + a.recorded_by : ''}`)),
    el('div', { class: 'rf-decl' },
      el('p', null, `I, the patient / the relative of the patient named above, have been advised by the doctor named above that admission to ${placeWord(org.type)} is necessary for the condition stated above.`),
      el('p', null, 'The nature of the illness and the risks of not being admitted — including worsening of the condition, complications and possible danger to life — have been explained to me in a language I understand, and I have had the opportunity to ask questions.'),
      el('p', null, 'Against this medical advice I refuse admission at this time. I accept full responsibility for this decision and its consequences, and I release the hospital and its staff from any responsibility arising from it.')));
  nodes.push(body);

  const sig = (title, ...lines) => el('div', { class: 'rf-sig' }, el('strong', null, title), ...lines.map(l => el('div', null, l)));
  nodes.push(el('div', { class: 'rf-sigs' },
    sig('Signature of the patient', 'Name:'),
    sig('Signature of the relative (if the patient cannot sign)', 'Name:', 'Relationship to the patient:'),
    sig('Witness', 'Name:'),
    sig('Hospital staff', `Name: ${a.recorded_by || ''}`, 'Date / time:')));

  nodes.push(el('div', { class: 'copy-foot' }, isDup
    ? `${copyText}. The original was first printed ${fmtDateTime(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`
    : copyText));
  nodes.push(el('div', { class: 'mc-powered' }, 'Powered by AyurXpert HMS · ayurxpert.com'));
  card.replaceChildren(...nodes);
}

window.printRefusalNow = () => window.print();

load().catch(err => showMessage(safeErrorMessage(err, 'Could not load the form.')));
