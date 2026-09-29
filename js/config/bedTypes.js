// Single source of truth for the platform's fixed 12 bed types + their display labels,
// matching bed-admin.js's own Quick Setup Table 1 defaults (BED_TYPE_OPTIONS) verbatim so
// this can never independently drift from what an admin actually sees when creating beds.
// Shared by ipd.js (admit bed picker, bill drawers) and fee-admin.js (IPD Room Tariff).
//
// A bed_type NOT in this map is a tenant-created custom type (bed-admin.js's own
// "+ Add Bed Type", Quick Setup Table 1) -- its friendly label lives only in that admin's
// browser localStorage (a pre-existing Quick Setup gap, see TODO_LATER.md), so there is no
// reliable label to look up here. Callers pick their own fallback via bedTypeLabel()'s
// second argument: the raw bed_type string on admin/staff screens, a neutral generic label
// on anything patient-facing (printed bills/receipts).
export const BED_TYPE_LABELS = {
  male_general:   'Male General Ward',
  female_general: 'Female General Ward',
  general:        'General Ward (mixed)',
  twin_sharing:   'Twin Sharing',
  semi_private:   'Shared Private',
  private:        'Private Room',
  deluxe:         'Deluxe Private',
  dormitory:      'Dormitory',
  icu:            'ICU',
  day_care:       'Day Care',
  pk_treatment:   'PK Treatment',
  observation:    'Observation',
};

export function bedTypeLabel(bedType, fallback) {
  if (!bedType) return fallback ?? '—';
  return BED_TYPE_LABELS[bedType] || fallback || bedType;
}
