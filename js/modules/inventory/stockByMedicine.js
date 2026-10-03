// Real batches (Session 331): a medicine can have several inventory rows -- one per batch (opening stock,
// or a batch received through receive_stock()). Screens that list or sell MEDICINES use this to see one
// entry per medicine: total sellable stock and the price of the batch that sells first.
//
// Sellable = not a student (teaching-pharmacy) batch and not expired (expiry before today, IST -- Session 332,
// same rule as create_pharmacy_sale()). Sells first = earliest expiry, then earliest inward date, then id.

const _byFirstOut = (a, b) =>
  (a.expiry_date || '9999-12-31').localeCompare(b.expiry_date || '9999-12-31')
  || (a.inward_date || '9999-12-31').localeCompare(b.inward_date || '9999-12-31')
  || String(a.id).localeCompare(String(b.id));

const _todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });   // YYYY-MM-DD

// rows: inventory rows (must include id, medicine_id, stock_quantity, expiry_date, is_student_batch when selected).
// Returns one object per medicine: the first-out sellable batch's columns, with stock_quantity = total sellable
// stock, expired_quantity = stock held in expired batches (never sold), batch_count, batch_ids (sell order).
export function aggregateByMedicine(rows, today = _todayIST()) {
  const groups = new Map();
  for (const r of rows || []) {
    if (r.is_student_batch) continue;
    const k = r.medicine_id || r.medicine?.id;
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, { sellable: [], expired: [] });
    (r.expiry_date && r.expiry_date < today ? groups.get(k).expired : groups.get(k).sellable).push(r);
  }
  const out = [];
  for (const { sellable, expired } of groups.values()) {
    const list = sellable.length ? sellable.sort(_byFirstOut) : expired.sort(_byFirstOut);
    const lead = sellable.find(r => (r.stock_quantity || 0) > 0) || list[0];
    out.push({
      ...lead,
      stock_quantity: sellable.reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0),
      expired_quantity: expired.reduce((s, r) => s + (Number(r.stock_quantity) || 0), 0),
      batch_count: sellable.length,
      batch_ids: sellable.map(r => r.id),
    });
  }
  return out;
}
