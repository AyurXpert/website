// Session 321: the UHID is a stored, permanent, per-tenant identifier (patients.uhid), issued by
// the database when the patient is registered. Never compute one in the browser -- a page that
// hasn't loaded the column shows '—', not a guessed value. Load it by adding `uhid` to the
// patients select / embed, e.g. `patients(id, uhid, name, ...)`.
export function uhidOf(patient) {
  const u = patient && patient.uhid;
  return u ? String(u) : '—';
}
