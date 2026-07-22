// effectivePrice.js — Session 125, time-bounded promotional pricing.
//
// The auto-revert guarantee lives entirely here: no stored "reverted" flag,
// no scheduled job that could fail silently. A promo's effect is computed
// fresh on every call, so the instant promo_valid_until passes, this
// function starts returning the base amount again automatically.
//
// Every real billing consumer (reception.js, roomTariff.js, nursing.js,
// doctor.js's lab billing) must call this instead of reading
// fee_structures.amount directly, or a promo silently won't apply there.
export function getEffectivePrice(feeRow) {
  if (feeRow?.promo_valid_until && feeRow?.promo_price != null) {
    if (new Date() < new Date(feeRow.promo_valid_until)) {
      return Number(feeRow.promo_price) || 0;
    }
  }
  return Number(feeRow?.amount) || 0;
}
