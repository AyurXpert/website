// Session 357c (TODO §282, owner answer Q3, 24 Oct 2026): the doctor's room type preference (admission advice) and the bed types that
// fit it. DISPLAY COPY of the server's one mapping, public._bed_matches_room_pref() in sql/session357c_admission_followups.sql -- the
// server decides (create_ipd_admission refuses a mismatching bed without a reason). `node scripts/check-357c-room-map.mjs` compares
// the two; change both in the same session.
export const ROOM_TYPE_LABELS = {
  general:      'General Ward',
  semi_private: 'Semi-Private',
  private:      'Private',
  icu:          'ICU / HDU',
};

export const ROOM_TYPE_BEDS = {
  general:      ['general', 'male_general', 'female_general', 'dormitory'],
  semi_private: ['semi_private', 'twin_sharing'],
  private:      ['private', 'deluxe', 'suite'],
  icu:          ['icu', 'hdu'],
};

export function roomTypeLabel(pref) {
  return ROOM_TYPE_LABELS[pref] || pref || '—';
}

// no preference = nothing to check; an unknown preference never matches (the server: a reason is needed)
export function bedMatchesRoomPref(bedType, pref) {
  if (!pref || !String(pref).trim()) return true;
  return (ROOM_TYPE_BEDS[pref] || []).includes(bedType);
}
