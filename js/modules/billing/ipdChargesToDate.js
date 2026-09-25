import { computeRoomTariff } from './roomTariff.js';

// Pre-bill estimate of IPD charges "as of now" — room tariff (bed-type rate × days so
// far) + confirmed, not-yet-billed stay charges. Deliberately excludes GST: a GST
// admission's real tax is only known once a payer type is chosen and preview_ipd_bill
// runs (the Generate Bill drawer) — this is a plain, same-number-everywhere running
// total for the Account drawer and the printed interim bill, not the bill itself.
export async function computeIpdChargesToDate({ supabase, tenantId, admission }) {
  const bed        = admission.beds || {};
  const admittedAt = new Date(admission.admitted_at);
  const throughAt  = admission.charges_locked_at ? new Date(admission.charges_locked_at) : new Date();
  const tariff = await computeRoomTariff({ supabase, tenantId, bed, admissionDate: admittedAt, throughDate: throughAt });

  const { data: charges } = await supabase.from('ipd_stay_charges')
    .select('description, quantity, unit_price, amount')
    .eq('ipd_admission_id', admission.id)
    .not('status', 'in', '(voided,billed)')
    .order('added_at');

  const tariffTotal  = tariff.error ? 0 : Number(tariff.total) || 0;
  const chargesTotal = (charges || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);

  return {
    tariff, charges: charges || [],
    tariffTotal, chargesTotal,
    total: tariffTotal + chargesTotal,
  };
}
