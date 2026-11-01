// Session 371B (plan session 370 B3): a patient's gender is stored as M / F / O. Older rows (and pages still open in an old tab)
// may hold 'male' / 'female' / 'other' -- the server's normalising trigger turns any spelling into M / F / O; these helpers let
// every page READ both spellings and WRITE only M / F / O. Staff gender (profiles.gender) is a separate column, not changed here.

const CODE = { m: 'M', male: 'M', f: 'F', female: 'F', o: 'O', other: 'O' };
const LABEL = { M: 'Male', F: 'Female', O: 'Other' };

// 'male' / 'M' / ' f ' -> 'M' / 'F'; anything unknown or empty -> null (never guessed)
export function genderCode(v) {
  if (v === null || v === undefined) return null;
  return CODE[String(v).trim().toLowerCase()] || null;
}

// 'male' / 'M' -> 'Male'; empty -> fallback
export function genderLabel(v, fallback = '—') {
  return LABEL[genderCode(v)] || fallback;
}

// one letter for compact rows ("52 M")
export function genderLetter(v, fallback = '') {
  return genderCode(v) || fallback;
}
