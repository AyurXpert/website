// Session 363 (TODO §266): the organisation's lab test catalogue (lab_tests + lab_test_ranges) -- ONE loader for every page
// (lab.html entry / print / the catalogue tab, doctor.html's order list, reception's Lab only). The catalogue is written only through
// the server functions save_lab_test / import_lab_tests / verify_lab_test_ranges.

export const SECTION_LABELS = {
  haematology: 'Haematology', biochemistry: 'Biochemistry', lipid: 'Lipid Profile', thyroid: 'Thyroid Function',
  urine: 'Urine Examination', stool: 'Stool Examination', serology: 'Serology / Immunology', imaging_ecg: 'Imaging / ECG', other: 'Other',
};
export const SECTION_ORDER = ['haematology', 'biochemistry', 'lipid', 'thyroid', 'urine', 'stool', 'serology', 'imaging_ecg', 'other'];

export async function loadLabCatalogue(supabase, tenantId, { activeOnly = false } = {}) {
  let q = supabase.from('lab_tests').select('*').eq('tenant_id', tenantId).order('sort_order').order('name');
  if (activeOnly) q = q.eq('is_active', true);
  const [{ data: tests, error }, { data: ranges, error: rErr }] = await Promise.all([
    q, supabase.from('lab_test_ranges').select('*').eq('tenant_id', tenantId).order('sort_order')]);
  if (error || rErr) return { tests: [], byName: new Map(), error: error || rErr };
  const byTest = new Map();
  (ranges || []).forEach(r => { if (!byTest.has(r.lab_test_id)) byTest.set(r.lab_test_id, []); byTest.get(r.lab_test_id).push(r); });
  const list = (tests || []).map(t => ({ ...t, ranges: byTest.get(t.id) || [] }));
  const byName = new Map();
  list.forEach(t => {
    byName.set(t.name.toLowerCase(), t);
    (t.aliases || []).forEach(a => { const k = String(a).toLowerCase(); if (!byName.has(k)) byName.set(k, t); });
  });
  return { tests: list, byName, error: null };
}

export function findTest(cat, name) {
  return cat?.byName?.get(String(name || '').trim().toLowerCase()) || null;
}

// { section: [test names] } in the catalogue's order -- the shape doctor.html's order list uses
export function namesBySection(cat) {
  const out = {};
  (cat?.tests || []).filter(t => t.is_active).forEach(t => { (out[t.section] ||= []).push(t.name); });
  return out;
}

export const rangesVerified = t => (t.ranges || []).length > 0 && t.ranges.every(r => !!r.verified_at);
