// hodAccess.js -- Session 350 (TODO §231): who reaches the HOD page ("My Department",
// dept-admin.html). The same test as the server's rule D, _hod_dept_ok() (sql/session348):
// an ACTIVE account (status active, is_active, not terminated) with a department scope that is
// a super_admin, a dept_admin (primary or second role), or a doctor who is not a trainee
// (designation known and not pg_scholar / intern / nursing_intern; second role not
// trainee_doctor / student). The menu uses this; dept-admin.html also asks the server
// (my_hod_department_ok()), which has the final say.
const TRAINEE_DESIGS = ['pg_scholar', 'intern', 'nursing_intern'];
const TRAINEE_SECOND_ROLES = ['trainee_doctor', 'student'];

export function isRuleDHod(p) {
  if (!p || !p.scope_department_id) return false;
  if (p.status !== 'active' || p.is_active !== true || p.terminated_at) return false;
  if (p.role === 'super_admin') return true;
  if (p.role === 'dept_admin' || p.secondary_role === 'dept_admin') return true;
  return p.role === 'doctor' && p.designation != null && !TRAINEE_DESIGS.includes(p.designation)
    && !TRAINEE_SECOND_ROLES.includes(p.secondary_role || '');
}
