// Session 386e (owner Q7, 18 Nov 2026): teleconsultation is one PLATFORM switch (platform_switches 'teleconsultation'), OFF for the
// pilot, changed only by the active platform admin (set_platform_switch, a reason, audited). While it is off the SERVER refuses every
// teleconsultation write (a tele visit, a meeting link, the Teleconsultation fee, a tele schedule); pages only hide what cannot be used.
// Any doubt (no answer, an error) = OFF.
let _answer = null;

export function teleconsultOn(supabase) {
  if (!_answer) {
    _answer = Promise.resolve()
      .then(() => supabase.from('platform_switches').select('is_on').eq('key', 'teleconsultation').maybeSingle())
      .then(({ data, error }) => !error && data?.is_on === true)
      .catch(() => false);
  }
  return _answer;
}

export const TELE_OFF_TEXT = 'Teleconsultation is switched off for the pilot.';
