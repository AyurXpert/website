// Medical / fitness / sick-leave certificate -- printMedicalCertificate.html?certId=<id> (Session 338b).
// The certificate is ISSUED in doctor.html (issue_medical_certificate: number MC/<fy>/<n> + the doctor's verified identity,
// both stored); this page only prints what was stored. The SERVER decides ORIGINAL vs DUPLICATE COPY No. N
// (record_document_print('medical_certificate', id)) and the page fails closed if that cannot be recorded.
// Organisation + demo flag come from the certificate's own organisation. Shared helpers: signInGate, paperSize (A4 / A5),
// demoBanner, printPageSize, signerIdentity. Built with DOM nodes / textContent only.
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
import { identityLines } from '../utils/signerIdentity.js';

const SIZES = ['a4', 'a5'];
applyPaperSize(getPaperSizeFrom(SIZES));
wireDelegatedEvents();

const card     = document.getElementById('mc-card');
const printBtn = document.getElementById('print-btn');
const certId   = new URLSearchParams(window.location.search).get('certId');

const TITLE = { medical: 'Medical Certificate', fitness: 'Certificate of Fitness', sick_leave: 'Sick Leave Certificate' };
const SEX = { f: 'Female', female: 'Female', m: 'Male', male: 'Male', o: 'Other', other: 'Other' };

function showMessage(msg) {
  card.replaceChildren(el('div', { class: 'state-msg', role: 'alert' }, msg));
  if (printBtn) printBtn.disabled = true;
}
const fmtDate = d => d ? new Date(String(d).length === 10 ? d + 'T12:00:00+05:30' : d)
  .toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'long', year: 'numeric' }) : '';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

// "this hospital" / "this clinic" / "this centre", by the organisation's type
export function placeWord(type) {
  if (['hospital', 'teaching_hospital', 'college'].includes(type)) return 'this hospital';
  if (['clinic', 'dispensary'].includes(type)) return 'this clinic';
  return 'this centre';
}

// ONE advice sentence (the old print said "Complete rest is advised." and then "Rest is advised from ..." again)
export function adviceSentence(c) {
  const from = fmtDate(c.rest_from), to = fmtDate(c.rest_to);
  const span = from && to ? ` from ${from} to ${to}` : from ? ` from ${from}` : '';
  switch (c.advice) {
    case 'rest':       return `Complete rest is advised${span}.`;
    case 'light_duty': return `Light duty only — no strenuous physical work${span}.`;
    case 'fit':        return `The patient is fit to resume normal duties / work / school${from ? ` from ${from}` : ''}.`;
    case 'unfit':      return `The patient is unfit for duties / work / school${span}.`;
    case 'custom':     return `${c.remarks || ''}${span ? ` (${span.trim()})` : ''}`;
    default:           return '';
  }
}

async function load() {
  if (!certId) { showMessage('No certificate ID provided.'); return; }
  if (!(await ensureSignedIn(supabase))) return;
  await requireAuth([ROLES.DOCTOR, ROLES.TRAINEE_DOCTOR, ROLES.RECEPTIONIST, ROLES.PHARMACIST, ROLES.NURSE, ROLES.MRD_STAFF]);

  // Print audit first: never shown without its Original / Duplicate marking (fail closed)
  const rec = await supabase.rpc('record_document_print', { p_doc_type: 'medical_certificate', p_doc_id: certId });
  if (rec.error) { showMessage(safeErrorMessage(rec.error, 'Could not record this print. Please try again.')); return; }
  const { data, error } = await supabase.rpc('get_medical_certificate_print', { p_cert: certId });
  if (error || !data) { showMessage(safeErrorMessage(error, 'Could not load the certificate.')); return; }

  const draw = () => render(data, rec.data);
  draw();
  mountPaperSizeSelect(document.getElementById('paper-slot'), draw, { sizes: SIZES });
  watchPrintPageSize(() => card);
  printBtn.disabled = false;
}

function render(d, copy) {
  const c = d.certificate || {}, pt = d.patient || {}, org = d.organisation || {};
  const signer = c.doctor_identity || {};
  const isDup  = copy.copy !== 'ORIGINAL';
  const copyNo = (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0);
  const issued = fmtDate(c.issued_at);
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
    el('div', { class: 'mc-title' }, TITLE[c.cert_type] || 'Medical Certificate'),
    el('div', { class: 'mc-no' }, el('div', { class: 'mc-no-label' }, 'Certificate No.'), el('div', { class: 'mc-no-value' }, c.certificate_no || '—'))));
  nodes.push(el('div', { class: 'copy-strip' + (isDup ? ' dup' : '') }, isDup ? `DUPLICATE COPY · No. ${copyNo}` : 'Original'));

  const who = [`UHID: ${uhidOf(pt)}`, pt.age != null && pt.age !== '' ? `Age: ${pt.age}` : null,
               SEX[String(pt.gender || '').toLowerCase()] || null].filter(Boolean).join(', ');
  const body = el('div', { class: 'mc-body' },
    el('p', null, 'This is to certify that ', el('strong', null, pt.name || '—'), ` (${who}) attended ${placeWord(org.type)} on `,
      el('strong', null, issued), c.diagnosis ? [' and was examined for ', el('strong', null, c.diagnosis)] : null, '.'),
    el('p', null, adviceSentence(c)));
  if (c.remarks && c.advice !== 'custom') body.append(el('p', { class: 'mc-remarks' }, c.remarks));
  nodes.push(body);

  nodes.push(el('div', { class: 'mc-foot' },
    el('div', { class: 'mc-meta' }, el('div', null, `Date: ${issued}`), el('div', null, `Certificate No.: ${c.certificate_no || '—'}`)),
    el('div', { class: 'sig-line' },
      el('div', { class: 'sig-name' }, signer.name || '—'),
      ...identityLines(signer).map(l => el('div', { class: 'sig-cred' }, l)),
      el('div', { class: 'sig-caption' }, 'Signature & Stamp'))));

  if (isDup) {
    nodes.push(el('div', { class: 'copy-foot' }, `${c.certificate_no} · Duplicate copy no. ${copyNo}. ` + (copy.legacy
      ? 'Issued before print tracking began; the original was printed at issue.'
      : `The original was first printed ${fmtDateTime(copy.first_printed_at)}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}.`)));
  }
  nodes.push(el('div', { class: 'mc-powered' }, 'Powered by AyurXpert HMS · ayurxpert.com'));
  card.replaceChildren(...nodes);
}

window.printCertificateNow = () => window.print();

load().catch(err => showMessage(safeErrorMessage(err, 'Could not load the certificate.')));
