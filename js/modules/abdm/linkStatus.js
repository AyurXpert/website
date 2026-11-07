// Session 375 (TODO §410 + §411): the patient's ABHA line + "ABDM linking failed — Retry", shared by reception.html and doctor.html.
// The link outcome is written ONLY by the abdm-hip Edge Function (care_contexts.link_status / link_error / link_attempted_at); the
// browser only reads it (since 375 the browser has SELECT only on care_contexts). Retry sends the same generate_link_token call with
// retry: true -- abdm-hip refuses a retry of the same care contexts within 60 s.
// DOM nodes + textContent only (no HTML strings).

import { abdmOn, ABDM_SOON } from './comingSoon.js';   // Session 379a

export const ABDM_HIP_FN = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-hip';
const PENDING_STALE_MS = 15 * 60 * 1000;   // "sent" with no answer for 15 minutes = not confirmed -> offer Retry

// "91-1234-5678-9012" from the stored digits (any separators kept out); null when there is no number
export function formatAbhaNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  if (d.length !== 14) return n ? String(n) : null;
  return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}`;
}

// "ABHA: 91-1234-5678-9012 · name@sbx" / "ABHA: name@sbx" / "No ABHA"
export function abhaText(patient) {
  if (!abdmOn()) return ABDM_SOON;   // Session 379a
  const num = formatAbhaNumber(patient?.abha_number);
  const addr = patient?.abha_address || null;
  if (!num && !addr) return 'No ABHA';
  return 'ABHA: ' + [num, addr].filter(Boolean).join(' · ');
}

// the patient's care contexts whose last link attempt failed (or was sent and never confirmed), not linked
export async function loadLinkProblems(supabase, tenantId, patientId) {
  if (!patientId || !abdmOn()) return [];   // Session 379a: abdmOn
  const { data, error } = await supabase.from('care_contexts')
    .select('care_context_ref, display, hi_types, link_status, link_error, link_attempted_at, linked')
    .eq('tenant_id', tenantId).eq('patient_id', patientId).eq('linked', false).not('link_status', 'is', null);
  if (error) return [];
  const now = Date.now();
  return (data || []).filter(c => c.link_status === 'failed'
    || (c.link_status === 'pending' && c.link_attempted_at && now - new Date(c.link_attempted_at).getTime() > PENDING_STALE_MS));
}

// Retry: one generate_link_token for the given care contexts. -> { ok, text }
export async function retryLink(supabase, patient, problems) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return { ok: false, text: 'You are signed out — sign in again, then retry.' };
  const res = await fetch(ABDM_HIP_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({
      action: 'generate_link_token', patient_id: patient.id, retry: true,
      abha_number: patient.abha_number || undefined, abha_address: patient.abha_address || undefined,
      care_contexts: problems.map(c => ({ referenceNumber: c.care_context_ref, display: c.display || 'Health record',
                                          hiType: (c.hi_types || [])[0] || 'OPConsultation' })),
    }),
  }).catch(() => null);
  if (!res) return { ok: false, text: 'ABDM could not be reached — check the connection and retry.' };
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) return { ok: false, text: body?.error || 'Tried less than a minute ago — wait a minute, then retry.' };
  if (body?.link === 'linked') return { ok: true, text: 'Linked with ABDM — the patient gets a notification in their ABHA app.' };
  if (body?.link === 'pending') return { ok: true, text: 'Sent to ABDM again — the patient confirms in their ABHA app.' };
  return { ok: false, text: 'ABDM refused the link again' + (typeof body?.error === 'string' ? ` (${body.error})` : '') + ' — try again later.' };
}

// fills `el` with the ABDM line: nothing when all is fine; "⚠ ABDM linking failed — <code> [Retry]" otherwise
export function renderLinkProblems(el, { supabase, patient, problems, onDone }) {
  if (!el) return;
  el.replaceChildren();
  el.hidden = !problems.length;
  if (!problems.length) return;
  const failed = problems.filter(p => p.link_status === 'failed');
  const code = failed.map(p => p.link_error).find(Boolean);
  const msg = document.createElement('span');
  msg.textContent = failed.length
    ? `⚠ ABDM linking failed${code ? ' (' + code + ')' : ''} — ${problems.length} record${problems.length === 1 ? '' : 's'} not linked.`
    : `⚠ ABDM linking not confirmed — ${problems.length} record${problems.length === 1 ? '' : 's'} not linked yet.`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'abdm-retry-btn';
  btn.textContent = '↻ Retry';
  const note = document.createElement('span');
  note.className = 'abdm-retry-note';
  note.setAttribute('role', 'status');
  btn.addEventListener('click', async () => {
    btn.disabled = true; note.textContent = 'Sending…';
    const r = await retryLink(supabase, patient, problems);
    note.textContent = r.text;
    btn.disabled = false;
    if (r.ok && onDone) onDone();
  });
  el.append(msg, ' ', btn, ' ', note);
}
