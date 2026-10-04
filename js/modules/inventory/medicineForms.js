// Dosage forms of a pharmacy's own medicine list (Session 340) -- the same fixed list the server accepts
// (medicines.dosage_form check + _pharmacy_item_validate in sql/session340_tenant_isolated_pharmacy_catalogue.sql).
export const MEDICINE_FORMS = [
  ['vati_gutika', 'Vati / Gutika'], ['tablet', 'Tablet'], ['capsule', 'Capsule'], ['churna', 'Churna'], ['kashaya', 'Kashaya'],
  ['kwatha_churna', 'Kwatha churna'], ['arishta', 'Arishta'], ['asava', 'Asava'], ['ghrita', 'Ghrita'], ['taila', 'Taila'],
  ['avaleha', 'Avaleha / Lehya'], ['bhasma', 'Bhasma'], ['pishti', 'Pishti'], ['rasaushadhi', 'Rasaushadhi'], ['guggulu', 'Guggulu'],
  ['arka', 'Arka'], ['lepa', 'Lepa'], ['anjana', 'Anjana'], ['syrup', 'Syrup'], ['drops', 'Drops'], ['ointment', 'Ointment'],
  ['granules', 'Granules'], ['other', 'Other'],
];

// fills a <select> with "— Choose —" + the forms (DOM only)
export function fillFormSelect(sel, selected = '') {
  if (!sel) return;
  const opts = [['', '— Choose —'], ...MEDICINE_FORMS].map(([v, l]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    return o;
  });
  sel.replaceChildren(...opts);
  sel.value = selected || '';
}

// The roles that may add / change medicines in the item master (the server re-checks, incl. the pharmacy module)
export const ITEM_MASTER_ROLES = ['super_admin', 'dept_admin'];
