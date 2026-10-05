// The organisation type's display label (navbar tagline, Admin → Feature Modules note).
// TODO_LATER.md §140: this used to be a private function inside navbar.js, which admin.js also called -- ES modules do
// not share top-level scope, so admin.js's loadModules() threw "ReferenceError: _tenantTypeLabel is not defined" and
// the Feature Modules grid stayed on "Loading…". One shared copy, imported by both.
export function tenantTypeLabel(type) {
  return { clinic:'Clinic', hospital:'Hospital', pk_center:'Panchakarma Center', dispensary:'Dispensary',
    college:'Ayurveda College', teaching_hospital:'Teaching Hospital',
    pharma:'Pharmaceutical Co.', supplier:'Supplier', dealer:'Dealer', journal:'Journal' }[type] || 'Healthcare';
}
