// clinicalWriters.js -- Session 385a (TODO §497, owner Q4, 10 Nov 2026): who may RECORD the five clinical record types. The browser's
// DISPLAY copy of the server's _clinical_writer_ok() (sql/session385a_security_audit_part2.sql): it only decides which add-forms a viewer
// sees -- the server decides every save. Everyone else reads per the existing rules.
//
//   consent / MHA consent / mental-health flag:  consultant, PG scholar (an intern only signs as the witness)
//   allergy / clinical photo or video:           consultant, PG scholar, intern, nurse
//   resolve an allergy:                          consultant, PG scholar
// consultant = doctor as primary or second role, not a trainee; nurse = nurse as primary or second role, not a trainee. An ACTIVE account.

const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern'];
const TRAINEE_ROLES = ['trainee_doctor', 'student'];
const norm = v => String(v ?? '').trim().toLowerCase();

function _isTrainee(p) {
  return TRAINEE_DESIGS.includes(norm(p?.designation)) || TRAINEE_ROLES.includes(norm(p?.role)) || TRAINEE_ROLES.includes(norm(p?.secondary_role));
}
function _active(p) {
  return !!p && norm(p.status) === 'active' && p.is_active !== false && !p.terminated_at && !p.is_platform_admin;
}
function _hasRole(p, r) { return norm(p?.role) === r || norm(p?.secondary_role) === r; }

/** @param {object} profile the signed-in profile; @param {'consent'|'mh_flag'|'allergy'|'media'|'allergy_resolve'} kind */
export function canRecordClinical(profile, kind) {
  if (!_active(profile)) return false;
  const consultant = _hasRole(profile, 'doctor') && !_isTrainee(profile);
  const pg = norm(profile.designation) === 'pg_scholar';
  if (consultant || pg) return ['consent', 'mh_flag', 'allergy', 'media', 'allergy_resolve'].includes(kind);
  if (kind === 'allergy' || kind === 'media') {
    return norm(profile.designation) === 'intern' || (_hasRole(profile, 'nurse') && !_isTrainee(profile));
  }
  return false;
}
