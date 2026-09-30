// The UHID this platform prints ("AYX-2026-B26838") is NOT stored anywhere -- it is derived
// in the browser from the patient's UUID. This is a byte-for-byte copy of doctor.js's and
// dispensaryPOS.js's _uhid() so a printed bill shows exactly what the prescription shows.
//
// Known limitations, reported Session 320, deliberately NOT fixed here (a stored UHID is a
// separate decision): the year is the CURRENT calendar year, not the registration year, so
// the same patient's UHID changes every 1 January; the 6 hex chars are not guaranteed
// unique; dispensaryPOS.js's medicine label (line ~849) uses a different formula again.
export function uhidFor(uuid) {
  return `AYX-${new Date().getFullYear()}-${(uuid||'').replace(/-/g,'').slice(-6).toUpperCase()}`;
}
