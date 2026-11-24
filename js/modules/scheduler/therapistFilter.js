// Session 390 T1a-1 (owner D5; rehearsal R3 finding T1a-F5, 23 Nov 2026): which on-duty therapists may do a therapy.
// A Shalakya therapist (a therapist of the Shalakya Tantra department) does Kriya Kalpa sittings only; every other therapy is offered only
// to the other therapists. The server refuses the same (`_sched_therapist_refusal`: "... is a Shalakya therapist -- Kriya Kalpa sessions
// only."); this keeps the automatic choice and the drop-down from offering what the server will refuse.
// Department codes = the server's `_dept_family` (SHAK / SHALAKYA_TANTRA / SHNT).
export const SHALAKYA_DEPT_CODES = ['SHAK', 'SHALAKYA_TANTRA', 'SHNT'];

export function isShalakyaTherapist(therapist, depts) {
  const d = (depts || []).find(x => x.id === therapist?.department_id);
  return !!d && SHALAKYA_DEPT_CODES.includes(d.ncism_code);
}

// kind = the therapy's kind from the Panchakarma list ('panchakarma' | 'kriya_kalpa' | 'jaloukavacharana'); no therapy chosen = panchakarma
export function therapistsForKind(therapists, depts, kind) {
  const kk = kind === 'kriya_kalpa';
  return (therapists || []).filter(t => kk || !isShalakyaTherapist(t, depts));
}
