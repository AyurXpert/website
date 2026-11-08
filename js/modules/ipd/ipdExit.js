// Session 381 (TODO §471, owner decisions 8 Nov 2026): the LAMA / transfer / death exit.
// DISPLAY COPY only: the server (record_ipd_exit, sql/session381_ipd_exit.sql) decides. Keep the two equal.
//   Deceased            = an active, non-trainee doctor (primary or second role), or the RMO / the Medical Superintendent by designation.
//   LAMA / Transferred  = such a doctor, or a nurse in-charge (Ward Sister, Nursing Superintendent, Deputy) ON DUTY today (the server checks the roster).
//   Statuses            = admitted, discharge advised, charges locked, bill generated, paid / cleared; never after MRD's release.
//   Time                = entered by the user: default now, at most 48 hours back, never in the future, never before the admission.

export const EXIT_TYPES = ['lama', 'transferred', 'deceased'];
export const EXIT_STATUSES = ['admitted', 'clinically_discharged', 'charges_locked', 'bill_generated', 'paid_cleared'];
const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern'];
const TRAINEE_ROLES = ['trainee_doctor', 'student'];
const DOCTOR_DESIGS = ['resident_medical_officer', 'medical_superintendent'];
const NURSE_IC_DESIGS = ['ward_sister', 'nursing_superintendent', 'deputy_nursing_superintendent'];
const NURSE_ROLES = ['nurse', 'nurse_manager'];
export const EXIT_BACK_HOURS = 48;

// what this account may record (before the duty check, which only the server can make)
export function exitPowers(profile, secondaryRole) {
  const role = profile?.role || '';
  const sec = secondaryRole ?? profile?.secondary_role ?? '';
  const desig = profile?.designation || '';
  const trainee = TRAINEE_DESIGS.includes(desig) || TRAINEE_ROLES.includes(role) || TRAINEE_ROLES.includes(sec);
  if (trainee) return { deceased: false, lamaTransfer: false, nurseInCharge: false };
  const doctor = role === 'doctor' || sec === 'doctor' || DOCTOR_DESIGS.includes(desig);
  const nurseInCharge = (NURSE_ROLES.includes(role) || NURSE_ROLES.includes(sec)) && NURSE_IC_DESIGS.includes(desig);
  return { deceased: doctor, lamaTransfer: doctor || nurseInCharge, nurseInCharge: nurseInCharge && !doctor };
}

// may an exit still be recorded on this admission row?
export function exitOpen(adm) {
  return EXIT_STATUSES.includes(adm?.status) && !EXIT_TYPES.includes(adm?.disposition);
}

// <input type="datetime-local"> value for a Date, in the browser's local time
export function toLocalInput(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// the allowed window for the time box: [max(admission, now - 48 h), now]
export function exitTimeBounds(admittedAt, now = new Date()) {
  const back = new Date(now.getTime() - EXIT_BACK_HOURS * 3600000);
  const adm = admittedAt ? new Date(admittedAt) : null;
  const min = adm && adm > back ? adm : back;
  return { min: toLocalInput(min), max: toLocalInput(now) };
}

// the page's own check before calling the server (same words as the server); '' = fine
export function exitTimeProblem(value, admittedAt, now = new Date()) {
  if (!value) return 'Enter the exit date and time.';
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return 'Enter the exit date and time.';
  if (t.getTime() > now.getTime() + 2 * 60000) return 'The exit time cannot be in the future.';
  if (t.getTime() < now.getTime() - EXIT_BACK_HOURS * 3600000) return 'The exit time can be at most 48 hours back. For an older exit, enter the earliest time allowed and write the actual date and time in the note.';
  if (admittedAt && t.getTime() < new Date(admittedAt).getTime()) return 'The exit time cannot be before the admission.';
  return '';
}

// the moment the patient left: the exit record's entered time, else the charges-locked time (normal discharge)
export function exitMoment(row) {
  const x = Array.isArray(row?.ipd_exit_records) ? row.ipd_exit_records[0] : row?.ipd_exit_records;
  return x?.exit_at || row?.charges_locked_at || null;
}

// that moment as an India-time date 'YYYY-MM-DD' (registers), or ''
export function exitDateIST(row) {
  const m = exitMoment(row);
  if (!m) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(m));
}
