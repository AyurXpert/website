// staffContacts.js -- Session 366 (TODO §350 / §351, plan §0.1). Shared by admin.js (HR → All Staff, Login Access, Bulk invite) and
// hr.js (View Profile):
//   • invite links + the WhatsApp message (wa.me, opened from the user's click -- no API, nothing stored);
//   • the Edge Function calls (send-staff-invites, staff-email-change) with the signed-in user's token -- the database decides;
//   • the login emails (staff_login_emails(): Super Admin / MD / MS = the organisation, a scoped Dept Admin = own department);
//   • the Super Admin's in-row editors: ✏️ Phone (set_staff_phone, a reason) and ✉️ Change login email (a reason; the confirmation link
//     goes to the NEW address only and nothing changes until it is opened).
// DOM nodes + textContent only; no confirm() / alert().
import { SUPABASE_URL } from '../../config/constants.js';
import { safeErrorMessage } from '../../utils/errors.js';

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
export const BTN = "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)";
export const BTN_OUT = "min-height:44px;padding:0 14px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;background:#fff;color:var(--green-deep);border:1.5px solid var(--green-deep)";
const FIELD = "min-height:44px;border:1.5px solid var(--border);border-radius:8px;padding:0 10px;font:14px 'DM Sans',sans-serif";

export function inviteLink(token) { return `${window.location.origin}/signup.html?pinv=${encodeURIComponent(token)}`; }

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// 10 digits (optional +91 / 0 in front) -> "91XXXXXXXXXX" for wa.me; null when it is not an Indian mobile number
export function waNumber(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const ten = /^[6-9]\d{9}$/.test(d) ? d : /^91[6-9]\d{9}$/.test(d) ? d.slice(2) : /^0[6-9]\d{9}$/.test(d) ? d.slice(1) : null;
  return ten ? '91' + ten : null;
}
export function inviteMessage({ orgName, name, position, link, expiresAt }) {
  return `${name ? 'Dear ' + name + ', ' : ''}${orgName || 'Our hospital'} invites you to join its staff on AyurXpert`
    + `${position ? ' as ' + position : ''}. Create your account here: ${link}`
    + `${expiresAt ? ' (the link works until ' + fmtDate(expiresAt) + ' and can be used once)' : ''}.`;
}
// a WhatsApp button (an <a>, opened by the user's own click); null when there is no usable phone number
export function whatsAppButton(phone, message) {
  const n = waNumber(phone);
  if (!n) return null;
  const a = mk('a', BTN_OUT + ';display:inline-flex;align-items:center;text-decoration:none;color:#1a6b3a;border-color:#1a6b3a', '💬 WhatsApp');
  a.href = `https://wa.me/${n}?text=${encodeURIComponent(message)}`;
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

export async function callStaffFunction(supabase, name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { error: 'Not signed in.' };
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: 'Could not reach the server. Check the connection and try again.' };
  }
  let result = {};
  try { result = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) return { error: result.error || 'The request could not be completed. Please try again.', data: result };
  return { data: result };
}

// e-mail invites (the database re-checks every id) -> a one-line summary for a toast
export async function emailInvites(supabase, ids) {
  const r = await callStaffFunction(supabase, 'send-staff-invites', { inviteIds: ids });
  if (r.error) return { ok: false, text: r.error };
  const d = r.data || {};
  const parts = [`${d.sent || 0} email(s) sent`];
  if (d.failed?.length) parts.push(`${d.failed.length} could not be sent`);
  if (d.skipped?.length) parts.push(`${d.skipped.length} skipped (no email, expired, or not yours)`);
  return { ok: !d.failed?.length, text: parts.join(' · '), data: d };
}

// login emails visible to this viewer: Map profileId -> { email, pending }
export async function loadLoginEmails(supabase) {
  const { data, error } = await supabase.rpc('staff_login_emails');
  const m = new Map();
  if (error) return { map: m, error };
  (data || []).forEach(r => m.set(r.profile_id, { email: r.email || '', pending: r.pending_email || '' }));
  return { map: m, error: null };
}
export function loginEmailCell(entry) {
  const td = mk('span');
  if (!entry) { td.textContent = '—'; return td; }
  td.append(mk('span', 'word-break:break-all', entry.email || '—'));
  if (entry.pending) td.append(mk('div', 'font-size:11px;color:#7a5a10;margin-top:2px', `change waiting for confirmation: ${entry.pending}`));
  return td;
}

function panel(title) {
  const box = mk('div', 'padding:10px 12px;border:1.5px solid var(--green-mid,#2d7a4f);border-radius:8px;background:#f7fbf8;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end');
  box.append(mk('div', 'flex-basis:100%;font-weight:600;font-size:13px;color:var(--green-deep)', title));
  return box;
}
function labelled(id, text, el) {
  const w = mk('label', 'display:flex;flex-direction:column;font-size:12px;font-weight:600;color:var(--text-mid);gap:3px', text);
  w.htmlFor = id; el.id = id; w.append(el); return w;
}

/** The Super Admin's phone editor: mountPhoneEditor(cell, { supabase, staff, toast, onDone }) */
export function mountPhoneEditor(cell, { supabase, staff, toast, onDone }) {
  const box = panel(`✏️ Phone of ${staff.full_name || 'this staff member'}`);
  const phone = mk('input', FIELD + ';width:170px'); phone.type = 'tel'; phone.value = staff.phone || ''; phone.placeholder = '10-digit mobile';
  const reason = mk('input', FIELD + ';width:260px'); reason.type = 'text'; reason.placeholder = 'Reason (required)'; reason.maxLength = 300;
  const save = mk('button', BTN, 'Save phone'); save.type = 'button';
  const msg = mk('div', 'flex-basis:100%;font-size:12.5px;min-height:1em'); msg.setAttribute('role', 'status');
  save.addEventListener('click', async () => {
    if (reason.value.trim().length < 3) { msg.style.color = 'var(--red,#c0392b)'; msg.textContent = 'Give the reason for the change.'; reason.focus(); return; }
    save.disabled = true;
    const { data, error } = await supabase.rpc('set_staff_phone', { p_staff_id: staff.id, p_phone: phone.value.trim(), p_reason: reason.value.trim() });
    save.disabled = false;
    if (error) { msg.style.color = 'var(--red,#c0392b)'; msg.textContent = safeErrorMessage(error, 'Could not save the phone.'); return; }
    toast?.('Phone saved ✓');
    onDone?.(data ?? null);
  });
  box.append(labelled(`ph-${staff.id}`, 'New phone (empty = remove)', phone), labelled(`phr-${staff.id}`, 'Reason', reason), save, msg);
  cell.replaceChildren(box);
  phone.focus();
}

/** The Super Admin's login-email change: mountEmailChanger(cell, { supabase, staff, currentEmail, toast, onDone }) */
export function mountEmailChanger(cell, { supabase, staff, currentEmail, toast, onDone }) {
  const box = panel(`✉️ Login email of ${staff.full_name || 'this staff member'}`);
  box.append(mk('div', 'flex-basis:100%;font-size:12.5px;color:var(--text-mid)',
    `Now: ${currentEmail || '—'}. A confirmation link is emailed to the NEW address only; the login email changes only when that link is opened. `
    + 'Use this when the staff member has lost the old mailbox — otherwise they change it themselves (Account → Security).'));
  const email = mk('input', FIELD + ';width:260px'); email.type = 'email'; email.placeholder = 'new@example.com'; email.autocomplete = 'off';
  const reason = mk('input', FIELD + ';width:260px'); reason.type = 'text'; reason.placeholder = 'Reason (required)'; reason.maxLength = 300;
  const send = mk('button', BTN, 'Send confirmation link'); send.type = 'button';
  const msg = mk('div', 'flex-basis:100%;font-size:12.5px;min-height:1em'); msg.setAttribute('role', 'status');
  send.addEventListener('click', async () => {
    if (!email.value.trim()) { msg.style.color = 'var(--red,#c0392b)'; msg.textContent = 'Enter the new email address.'; email.focus(); return; }
    if (reason.value.trim().length < 3) { msg.style.color = 'var(--red,#c0392b)'; msg.textContent = 'Give the reason for the change.'; reason.focus(); return; }
    send.disabled = true;
    const r = await callStaffFunction(supabase, 'staff-email-change', { staffId: staff.id, newEmail: email.value.trim(), reason: reason.value.trim() });
    send.disabled = false;
    if (r.error) { msg.style.color = 'var(--red,#c0392b)'; msg.textContent = r.error; return; }
    msg.style.color = 'var(--green-deep)';
    msg.textContent = 'Confirmation link sent to the new address. The login email changes only when that link is opened.';
    toast?.('Confirmation link sent ✓');
    onDone?.();
  });
  box.append(labelled(`em-${staff.id}`, 'New login email', email), labelled(`emr-${staff.id}`, 'Reason', reason), send, msg);
  cell.replaceChildren(box);
  email.focus();
}
