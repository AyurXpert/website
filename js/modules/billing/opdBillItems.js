// opdBillItems.js — Session 124 (OPD Lab Billing rebuild, Step 3); rewritten Session 325.
//
// reception creates an OPD bill at registration with only 3 fixed columns
// (registration_fee/consultation_fee/on_request_surcharge). A charge discovered AFTER the bill
// exists (e.g. a lab test ordered mid-consultation) attaches to that same bill and its total is
// recomputed server-side.
//
// Session 325 (TODO_LATER.md §95): the browser no longer sends a description, price or GST %.
// It sends fee_structures ids (and the lab order each belongs to); add_opd_bill_fee_items()
// (sql/session325_legacy_server_pricing.sql) takes the label, the promo-aware price and the GST %
// from the fee row. The old add_opd_bill_item() (typed price) is retired for every role.
//
// Only for a visit bill that is NOT on the GST path -- a GST-live organisation's lab charge is its
// own invoice, created by create_investigation_bill() when reception collects it.
export async function addOpdBillFeeItems({ supabase, billId, lines }) {
  const { data, error } = await supabase.rpc('add_opd_bill_fee_items', {
    p_bill_id: billId,
    p_lines: lines.map(l => ({ fee_structure_id: l.feeStructureId, lab_order_id: l.labOrderId || null })),
  });
  if (error) return { error };
  return { total: Number(data?.total), added: Number(data?.added) };
}
