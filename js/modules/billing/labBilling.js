// labBilling.js -- Session 295 (follow-up layout phase 4).
//
// Lab-test pricing, moved out of doctor.js unchanged so reception.js can price a
// "before next visit" order at the moment the patient actually pays (a new
// 'investigation' bill dated that day) with exactly the same rules doctor.js uses for
// a today order (panel bundling, label overrides, promo-aware effective price).
import { getEffectivePrice } from './effectivePrice.js';
import { addOpdBillItem } from './opdBillItems.js';

export const LAB_PANELS = [
  { label:'CBC',        tests:['Haemoglobin (Hb)','Total Leucocyte Count (TLC)','Differential Leucocyte Count (DLC)','Platelet Count','PCV / Haematocrit'] },
  { label:'LFT',        tests:['SGOT (AST)','SGPT (ALT)','Serum Bilirubin Total','Serum Bilirubin Direct','Alkaline Phosphatase (ALP)','Serum Albumin','Total Protein'] },
  { label:'KFT / RFT',  tests:['Serum Creatinine','Blood Urea','Serum Uric Acid','Serum Sodium','Serum Potassium'] },
  { label:'Lipid Profile', tests:['Total Cholesterol','Triglycerides (TG)','HDL Cholesterol','LDL Cholesterol','VLDL Cholesterol'] },
  { label:'TFT',        tests:['TSH','T3 (Triiodothyronine)','T4 (Thyroxine)'] },
  { label:'Blood Sugar', tests:['Fasting Blood Sugar (FBS)','Post-Prandial Blood Sugar (PPBS)','HbA1c'] },
  { label:'Urine R/M',  tests:['Urine — Albumin (Protein)','Urine — Sugar (Glucose)','Urine — Pus Cells (WBCs)','Urine — RBCs','Urine — pH','Urine — Specific Gravity'] },
];

// Session 124 Step 4 -- explicit panel -> fee_structures label mapping.
// Deliberately NOT automatic string-matching -- verified by hand against the
// real fee-admin.js catalog (Step 1) rather than guessed, since a silent
// mismatch here means a patient gets billed wrong. 'Blood Sugar' is
// deliberately absent: unlike the other 6 panels, no single bundle fee
// exists for it (real labs don't bundle HbA1c with same-day sugar tests) --
// it always decomposes to its 3 individual tests instead.
export const PANEL_FEE_MAP = {
  'CBC':            'Blood — CBC',
  'LFT':            'Blood — LFT',
  'KFT / RFT':      'Blood — RFT',   // KFT (Kidney) and RFT (Renal) are the same test, regional naming only
  'Lipid Profile':  'Blood — Lipid Profile',
  'TFT':            'Blood — Thyroid (T3/T4/TSH)',
  'Urine R/M':      'Urine — Routine',
};

// Known near-miss label variants between doctor.js's exact order test names
// and fee-admin.js's catalog labels (found during Step 1's cross-check) --
// e.g. "Urine Culture & Sensitivity" (ordered) vs "Culture & Sensitivity"
// (priced) are the same real-world charge, just phrased differently.
// X-Ray/USG variants resolve to the RADIOLOGY category, not lab, since
// that's genuinely where their pricing lives.
export const TEST_LABEL_OVERRIDES = {
  'Urine Culture & Sensitivity': 'Culture & Sensitivity',
  'Blood Culture & Sensitivity': 'Culture & Sensitivity',
  'Stool Routine & Microscopy':  'Stool — Routine',
  'Biopsy (specify site)':       'Biopsy',
  'X-Ray Chest (PA view)':       'X-Ray',
  'X-Ray (specify area)':        'X-Ray',
  'USG Abdomen & Pelvis':        'Ultrasound (USG)',
  'USG Pelvis (Obstetric)':      'Ultrasound (USG)',
  'ECG (12-lead)':               'ECG',
  'ECHO (Echocardiography)':     'Echo (2D Echo)',
  // The 'Blood Sugar' panel (unlike the other 6) has no bundle fee and
  // always decomposes to individual pricing -- caught by testing that these
  // 2 exact-match a completely different fee label convention (found live,
  // would otherwise have always shown "unmatched" even with a real fee).
  'Fasting Blood Sugar (FBS)':      'Blood Sugar — Fasting',
  'Post-Prandial Blood Sugar (PPBS)': 'Blood Sugar — PP',
};

// Turns this order's Map<testName, panelLabel> into priced billing lines.
// A tagged panel only bundles if EVERY one of its real tests (per LAB_PANELS,
// never trusted from the tag alone) is actually present -- a partial panel
// (one test unchecked after the panel button was clicked) decomposes to
// individual pricing for whatever remains, same as a never-tagged test.
export function computeLabBillingLines(labSelected, feeRows) {
  const byLabel = {};
  feeRows.forEach(f => { byLabel[f.label] = f; });

  const byPanel = {};
  const individual = [];
  for (const [testName, panelLabel] of labSelected.entries()) {
    if (panelLabel) (byPanel[panelLabel] = byPanel[panelLabel] || []).push(testName);
    else individual.push(testName);
  }

  const lines = [];
  const unmatched = [];

  for (const [panelLabel, taggedTests] of Object.entries(byPanel)) {
    const panelDef = LAB_PANELS.find(p => p.label === panelLabel);
    const isComplete = panelDef && panelDef.tests.length === taggedTests.length
      && panelDef.tests.every(t => taggedTests.includes(t));
    const bundleFeeLabel = PANEL_FEE_MAP[panelLabel];
    const bundleFee = bundleFeeLabel ? byLabel[bundleFeeLabel] : null;
    if (isComplete && bundleFee) {
      lines.push({ description: bundleFee.label, price: getEffectivePrice(bundleFee), gst_percent: Number(bundleFee.gst_percent) || 0 });
    } else {
      // Not a complete/priceable bundle -- fall back to individual pricing
      // for every test in this group, same path as never-tagged tests.
      individual.push(...taggedTests);
    }
  }

  for (const testName of individual) {
    const feeLabel = TEST_LABEL_OVERRIDES[testName] || testName;
    const fee = byLabel[feeLabel];
    if (fee) lines.push({ description: fee.label, price: getEffectivePrice(fee), gst_percent: Number(fee.gst_percent) || 0 });
    else unmatched.push(testName);
  }

  return { lines, unmatched };
}

// Rebuilds the Map<testName, panelLabel> computeLabBillingLines() expects from saved
// lab_order_items rows (panel_label is stored per item since Session 124).
export function labItemsToSelection(items) {
  return new Map((items || []).map(i => [i.test_name, i.panel_label || null]));
}

// Session 297 -- an IPD-origin lab order (doctor.html's IPD Orders panel) has no OPD
// bill to attach to; it's staged to ipd_stay_charges instead, same 'pending' staging
// PK sessions/room tariff already use -- reconciled at discharge like everything else
// there (nursing.js's Discharge Reconciliation). Called from lab.js's saveResults()
// once results are actually finalized (status='completed'), not at order time -- an
// order that's cancelled or never processed shouldn't get charged. Idempotent: skips
// if this order was already staged (a report can be re-released after edits).
export async function stageIpdLabCharges({ supabase, tenantId, ipdAdmissionId, labOrderId, items, userId }) {
  const { data: already } = await supabase.from('ipd_stay_charges')
    .select('id').eq('ipd_admission_id', ipdAdmissionId).eq('source', 'lab').eq('source_ref_id', labOrderId).limit(1);
  if (already?.length) return { skipped: true };

  const { data: feeRows, error: feeErr } = await supabase.from('fee_structures')
    .select('label,amount,gst_percent,promo_price,promo_valid_until')
    .eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab', 'radiology']);
  if (feeErr) return { error: feeErr };
  const { lines, unmatched } = computeLabBillingLines(labItemsToSelection(items), feeRows || []);
  if (!lines.length) return { unmatched };

  const rows = lines.map(l => ({
    tenant_id: tenantId, ipd_admission_id: ipdAdmissionId, source: 'lab', source_ref_id: labOrderId,
    description: l.description, quantity: 1, unit_price: l.price, gst_percent: l.gst_percent,
    amount: l.price, status: 'pending', added_by: userId,
  }));
  const { error } = await supabase.from('ipd_stay_charges').insert(rows);
  if (error) return { error };
  return { staged: rows.length, unmatched };
}

// "Before next visit" order, collected at reception: price it, create a new
// 'investigation' bill for the patient dated today (status paid, the mode just
// collected), and attach one bill_items row per priced line (lab_order_id-linked, same
// as a today order). Returns { billId, total, unmatched } or { error }.
export async function billDeferredLabOrder({ supabase, tenantId, patientId, labOrderId, items, paymentMode }) {
  const { data: feeRows, error: feeErr } = await supabase.from('fee_structures')
    .select('label,amount,gst_percent,promo_price,promo_valid_until')
    .eq('tenant_id', tenantId).eq('is_active', true).in('category', ['lab', 'radiology']);
  if (feeErr) return { error: feeErr };
  const { lines, unmatched } = computeLabBillingLines(labItemsToSelection(items), feeRows || []);

  const { data: bill, error: billErr } = await supabase.from('bills').insert({
    tenant_id: tenantId, patient_id: patientId, visit_id: null,
    registration_fee: 0, consultation_fee: 0, on_request_surcharge: 0,
    total_amount: 0, final_amount: 0,
    payment_mode: paymentMode, status: 'paid', bill_type: 'investigation',
    payer_type: 'self_pay', insurance_claim_status: 'not_applicable',
  }).select('id').single();
  if (billErr) return { error: billErr };

  let total = 0;
  for (const line of lines) {
    const r = await addOpdBillItem({
      supabase, tenantId, billId: bill.id, itemType: 'lab',
      description: line.description, quantity: 1, price: line.price, gstPercent: line.gst_percent, labOrderId,
    });
    if (r.error) unmatched.push(line.description + ' (billing failed)');
    else total = r.total;
  }
  return { billId: bill.id, total, unmatched };
}
