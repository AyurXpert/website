// Signer identity under a signature line (Session 338, TODO §132 follow-up).
// A signed document carries the signer's VERIFIED identity as it was when the document was created / signed
// (a jsonb stamp: name, registration_number, registration_council, qualification, hpr_id -- see
// sql/session338_identity_stamps_hpr_rx_reprint.sql). A document made before that stamp existed falls back to the
// signer's CURRENT verified values (profiles holds verified values only since Session 337). Nothing new is labelled.

const fmtHpr = v => {
  const d = String(v || '').replace(/\D/g, '')
  return d.length === 14 ? d.replace(/^(\d{2})(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3-$4') : String(v || '')
}

// The lines printed under the signer's name: qualification, Reg. No. (council), HPR ID -- only those present.
export function identityLines(id) {
  if (!id) return []
  const lines = []
  if (id.qualification) lines.push(String(id.qualification))
  if (id.registration_number) {
    lines.push(`Reg. No. ${id.registration_number}${id.registration_council ? ` (${id.registration_council})` : ''}`)
  }
  if (id.hpr_id) lines.push(`HPR ID: ${fmtHpr(id.hpr_id)}`)
  return lines
}

// Legacy fallback: the signer's current verified values, in the same shape as a stamp.
export async function liveIdentity(supabase, profileId) {
  if (!profileId) return null
  const { data } = await supabase.from('profiles')
    .select('id, full_name, registration_number, registration_council, qualification, hpr_id')
    .eq('id', profileId).maybeSingle()
  if (!data) return null
  return { profile_id: data.id, name: data.full_name, registration_number: data.registration_number,
           registration_council: data.registration_council, qualification: data.qualification, hpr_id: data.hpr_id }
}

// The stamp when present, else the current verified values.
export async function identityOrLive(supabase, stamp, profileId) {
  return stamp || await liveIdentity(supabase, profileId)
}

// DOM: a signature block -- the line, the name, then the identity lines (textContent only).
export function signatureBlock(id, { nameFallback = '—', caption = 'Signature & Stamp', className = 'sig-identity' } = {}) {
  const box = document.createElement('div')
  box.className = className
  const name = document.createElement('div')
  name.className = 'sig-name'
  name.textContent = id?.name || nameFallback
  box.appendChild(name)
  for (const line of identityLines(id)) {
    const d = document.createElement('div')
    d.className = 'sig-cred'
    d.textContent = line
    box.appendChild(d)
  }
  if (caption) {
    const c = document.createElement('div')
    c.className = 'sig-caption'
    c.textContent = caption
    box.appendChild(c)
  }
  return box
}
