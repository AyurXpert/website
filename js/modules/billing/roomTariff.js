// Session 114 -- IPD room tariff computation, shared by the billing clerk's
// Generate IPD Bill action (ipd.js). Deliberately a strict, single-source
// lookup with no bed_category_multipliers fallback (confirmed decision):
// every one of the 12 beds.bed_type values must have its own room_<type>
// row in fee_structures (category='ipd') before a bill can be generated for
// that bed type -- simpler, more predictable code, at the cost of a one-time
// admin setup task (see fee-admin.html -> Administration -> IPD Room Tariff).
import { getEffectivePrice } from './effectivePrice.js';

export async function computeRoomTariff({ supabase, tenantId, bed, admissionDate, throughDate }) {
  const days = Math.max(1, Math.ceil((throughDate - admissionDate) / 86400000));
  const { data: rateRow, error } = await supabase
    .from('fee_structures')
    .select('amount, gst_percent, promo_price, promo_valid_until')
    .eq('tenant_id', tenantId)
    .eq('category', 'ipd')
    .eq('fee_type', 'room_' + bed.bed_type)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !rateRow) {
    return { error: `No room rate configured for bed type "${bed.bed_type}" — add it in fee-admin.html (Administration → IPD Room Tariff) before generating this bill.` };
  }

  const dailyRate = getEffectivePrice(rateRow);
  return {
    days,
    dailyRate,
    total: days * dailyRate,
    gstPercent: rateRow.gst_percent ?? null,
  };
}
