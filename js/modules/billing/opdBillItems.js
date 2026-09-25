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
// Recomputes the bill's total from scratch on every call (sums the 3 fixed
// columns + every bill_items row for that bill) rather than incrementing --
// safer against drift from a missed/duplicate call, at the cost of one
// extra read. Matches ipd.js's convention that a bill's grand total is
// sum(item.total) + sum(item.gst_amount) on top of any flat fee columns
// (item.total itself is the pre-GST amount).
//
// Launch plan 0a (Session 304): browsers can no longer write bills.total_amount/
// final_amount directly (trg_bill_client_write_guard), so this now calls the
// add_opd_bill_item() RPC, which does the same insert + recompute server-side.
// The direct path below is kept ONLY as a fallback while that RPC does not exist
// yet (PGRST202), so this file can deploy before the SQL — remove the fallback
// once sql/session304_bills_write_lockdown.sql is live.
export async function addOpdBillItem({ supabase, tenantId, billId, itemType, description, quantity, price, gstPercent = 0, labOrderId = null }) {
  const { data, error } = await supabase.rpc('add_opd_bill_item', {
    p_bill_id: billId, p_item_type: itemType, p_description: description,
    p_quantity: Number(quantity) || 1, p_price: Number(price) || 0,
    p_gst_percent: Number(gstPercent) || 0, p_lab_order_id: labOrderId,
  });
  if (!error) return { total: Number(data?.total) };
  if (error.code !== 'PGRST202') return { error };

  const total = Math.round((Number(quantity) || 1) * (Number(price) || 0) * 100) / 100;
  const gstAmount = Math.round(total * (Number(gstPercent) || 0) / 100 * 100) / 100;

  const { error: insertErr } = await supabase.from('bill_items').insert({
    bill_id: billId, tenant_id: tenantId, item_type: itemType, description,
    quantity: Math.round(Number(quantity) || 1), price: Number(price) || 0,
    total, gst_percent: gstPercent || 0, gst_amount: gstAmount,
    lab_order_id: labOrderId,
  });
  if (insertErr) return { error: insertErr };

  return recomputeOpdBillTotal({ supabase, billId });
}

export async function recomputeOpdBillTotal({ supabase, billId }) {
  const [{ data: bill, error: billErr }, { data: items, error: itemsErr }] = await Promise.all([
    supabase.from('bills').select('registration_fee,consultation_fee,on_request_surcharge').eq('id', billId).single(),
    supabase.from('bill_items').select('total,gst_amount').eq('bill_id', billId),
  ]);
  if (billErr) return { error: billErr };
  if (itemsErr) return { error: itemsErr };

  const fixedFees = (Number(bill?.registration_fee) || 0) + (Number(bill?.consultation_fee) || 0) + (Number(bill?.on_request_surcharge) || 0);
  const itemsTotal = (items || []).reduce((s, r) => s + (Number(r.total) || 0) + (Number(r.gst_amount) || 0), 0);
  const newTotal = Math.round((fixedFees + itemsTotal) * 100) / 100;

  const { error: updateErr } = await supabase.from('bills')
    .update({ total_amount: newTotal, final_amount: newTotal }).eq('id', billId);
  if (updateErr) return { error: updateErr };

  return { total: newTotal };
}
