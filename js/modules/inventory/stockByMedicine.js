// Real batches (Session 331): a medicine can have several inventory rows -- one per batch (opening stock,
// or a batch received through receive_stock()). Screens that list or sell MEDICINES use this to see one
// entry per medicine: total sellable stock and the price of the batch that sells first.
//
// Sellable = not a student (teaching-pharmacy) batch. Sells first = earliest expiry, then earliest inward
// date, then id -- the same order create_pharmacy_sale() uses on the server.

const _byFirstOut = (a, b) =>
  (a.expiry_date || '9999-12-31').localeCompare(b.expiry_date || '9999-12-31')
  || (a.inward_date || '9999-12-31').localeCompare(b.inward_date || '9999-12-31')
  || String(a.id).localeCompare(String(b.id));

// rows: inventory rows (any columns, must include id, medicine_id, stock_quantity, is_student_batch when selected).
// Returns one object per medicine: the first-out batch's columns, with stock_quantity = total sellable stock,
// batch_count, and batch_ids (sellable batches in the order they sell).
export function aggregateByMedicine(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (r.is_student_batch) continue;
    const k = r.medicine_id || r.medicine?.id;
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort(_byFirstOut);
    const lead = list.find(r => (r.stock_quantity || 0) > 0) || list[0];
    out.push({
      ...lead,
      stock_quantity: list.reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0),
      batch_count: list.length,
      batch_ids: list.map(r => r.id),
    });
  }
  return out;
}
