// Session 353B (D8): a doctor gives the PK fitness clearance -- ONE call for therapist.html and doctor.html's "🌸 PK" tab (B17).
// Only doctor_clearance is sent; clearance_by / clearance_at are set by the server. A refused update raises (the 353B policy), and an
// update that comes back with no row was not saved either (no false "recorded" -- 353A).
import { safeErrorMessage } from '../../utils/errors.js';

export async function givePkClearance(supabase, sessionId) {
  const { data, error } = await supabase.from('pk_therapy_sessions').update({ doctor_clearance: true }).eq('id', sessionId).select('id');
  if (error) return { ok: false, message: safeErrorMessage(error, 'Could not record the clearance.') };
  if (!data?.length) return { ok: false, message: 'The clearance was not recorded -- the session was not found. Refresh and try again.' };
  return { ok: true, message: 'PK fitness clearance recorded.' };
}
