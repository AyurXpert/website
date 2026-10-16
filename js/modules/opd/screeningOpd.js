// screeningOpd.js -- the organisation's OPD workflow (Session 347, TODO §198; plan docs/handoff/session347_opd_workflow_plan.md).
// One shared lookup for reception, screening and the doctor page: the SERVER says whether this organisation routes new patients
// through a Screening OPD ('screening_opd') and uses intern / PG verification ('trainee_verification') -- not set = ON for a
// teaching hospital / college, OFF for every other type -- and which OPD is its Screening OPD (the explicit opds.is_screening
// marker; never guessed from a code or a name).
let _cache = null;

/** getOpdWorkflow(supabase) -> { screening_opd, trainee_verification, screening_opd_id, screening_opd_name, screening_opd_active, ... }.
 *  On an error nothing is assumed: screening off, verification off, plus `error` (reception then refuses a visit without an OPD,
 *  so nothing is registered to the wrong place). */
export async function getOpdWorkflow(supabase) {
  if (_cache) return _cache;
  const { data, error } = await supabase.rpc('get_opd_workflow');
  if (error || !data) return { screening_opd: false, trainee_verification: false, screening_opd_id: null, error: error || new Error('no answer') };
  _cache = data;
  return data;
}

/** The marked Screening OPD id when screening is ON and that OPD is active, else null. */
export function screeningOpdId(wf) {
  return wf && wf.screening_opd && wf.screening_opd_active ? (wf.screening_opd_id || null) : null;
}
