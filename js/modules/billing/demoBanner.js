// Demo-organisation marking for printed bills / invoices / receipts (GST Stage 2 fix).
// A demo tenant's (tenants.is_demo) documents are test documents and must say so, on screen and on paper.
// The flag is read from the DOCUMENT's own tenant row, never from the login-time sessionStorage copy: a
// session that began before is_demo existed carries no such key, and window.open() copies that stale
// copy into the print tab -- which is why the banner never appeared on SDM's first Bills of Supply.
// The banner must be placed INSIDE the page's print root (.sheet / .ax-print-root): print CSS hides
// every other direct child of <body>.
export const DEMO_TEXT = 'DEMO ORGANISATION — TEST DOCUMENT, NOT A VALID TAX INVOICE'

export async function isDemoTenant(supabase, tenantId) {
  if (tenantId) {
    const { data, error } = await supabase.from('tenants').select('is_demo').eq('id', tenantId).maybeSingle()
    if (!error && data) return data.is_demo === true
  }
  // lookup failed: fall back to the login-time copy rather than silently dropping the marking
  try { return JSON.parse(sessionStorage.getItem('ayurxpert_tenant') || '{}').is_demo === true } catch { return false }
}

export function demoBannerEl() {
  const d = document.createElement('div')
  d.className = 'demo-banner'
  d.setAttribute('role', 'note')
  d.textContent = DEMO_TEXT
  return d
}
