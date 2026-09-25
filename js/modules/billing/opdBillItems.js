// opdBillItems.js — Session 124, OPD Lab Billing rebuild Step 3.
//
// reception.js creates an OPD bill at registration with only 3 fixed
// columns (registration_fee/consultation_fee/on_request_surcharge) and
// never touches bill_items at all -- the generic line-item table that
// ipd.js's discharge billing and dispensaryPOS.js's pharmacy dispense
// already use. This is the missing piece: a charge discovered AFTER the
// bill already exists (e.g. a lab test ordered mid-consultation, Step 4)
// needs a way to attach to that same bill and have its total reflect it.
//
// Launch plan 0a (Session 304): browsers can no longer write
// bills.total_amount/final_amount directly (trg_bill_client_write_guard), so
// the line insert + total recompute now happen server-side in the
// add_opd_bill_item() RPC (sql/session304_bills_write_lockdown.sql). It
// recomputes the bill's total from scratch on every call (the 3 fixed fee
// columns + sum(item.total + item.gst_amount) over every line), same as the
// client-side version it replaces.
export async function addOpdBillItem({ supabase, billId, itemType, description, quantity, price, gstPercent = 0, labOrderId = null }) {
  const { data, error } = await supabase.rpc('add_opd_bill_item', {
    p_bill_id: billId, p_item_type: itemType, p_description: description,
    p_quantity: Number(quantity) || 1, p_price: Number(price) || 0,
    p_gst_percent: Number(gstPercent) || 0, p_lab_order_id: labOrderId,
  });
  if (error) return { error };
  return { total: Number(data?.total) };
}
