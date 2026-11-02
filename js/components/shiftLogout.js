// Logout with an open shift (owner, 31 Oct 2026 rehearsal, item 22).
// Before signing out, a person who can collect money at a counter is asked the SERVER for their shift (shift_preview -- the same
// call as shift-close.html → 💵 My shift). Receipts not yet handed over → an in-page panel:
//   "You haven't closed your shift — ₹X cash to hand over (₹Y received − ₹Z refunded) — not yet handed over."   [Close shift now]  [Log out anyway]
//   (owner, 1 Nov 2026: the NET cash, the same figure as the handover's system cash; the refund part only when there is one)
//   + a second line only when UPI / card / … were received: "UPI ₹X · Card ₹Y received — close the shift to reconcile them."
//   (owner, 2 Nov 2026; only the non-zero modes, net of refunds, as the server's non_cash)
// Never blocks the sign-out: no receipts, a refusal, an error or a slow answer (> 2.5 s) → sign out as before (logout() also ends the
// duty). No native confirm(). DOM nodes + textContent only.
import { supabase } from '../core/db/supabaseClient.js';
import { logout } from '../core/auth.js';

// the roles shift-close.html admits (the server decides who actually has receipts)
const SHIFT_ROLES = ['receptionist', 'nurse', 'cashier', 'accountant', 'finance_manager', 'dept_admin', 'super_admin',
  'lab_tech', 'pharmacist', 'doctor', 'trainee_doctor', 'nurse_manager', 'therapist'];

const inr = v => '₹' + Number(v || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// the cash to hand over in the open shift = cash received − cash refunded (the server's system_cash, as on the handover;
// voided receipts are already left out)
export function cashToHandOver(p) {
  if (!p) return 0;
  const v = p.system_cash != null ? Number(p.system_cash) : Number(p.cash_received || 0) - Number(p.cash_refunded || 0);
  return Math.round(v * 100) / 100;
}

// the same mode names as the shift handover (js/modules/billing/shiftHandover.js MODE_LABEL)
const MODE_LABEL = { upi: 'UPI', card: 'Card', cheque: 'Cheque', neft: 'NEFT' };

// the non-cash line ('' when none) -- exported for the checks
export function shiftLogoutNonCashText(p) {
  const modes = Object.entries(p?.non_cash || {}).filter(([, v]) => Math.round(Number(v || 0) * 100) !== 0);
  if (!modes.length) return '';
  return modes.map(([k, v]) => `${MODE_LABEL[k] || k} ${inr(v)}`).join(' · ') + ' received — close the shift to reconcile them.';
}

// the dialog sentence (exported for the checks)
export function shiftLogoutText(p) {
  const refunded = Number(p?.cash_refunded || 0);
  const parts = refunded > 0 ? ` (${inr(p.cash_received)} received − ${inr(refunded)} refunded)` : '';
  const earlier = p?.from_earlier_days ? ' This includes earlier days since your last handover.' : '';
  return `${inr(cashToHandOver(p))} cash to hand over${parts} — not yet handed over.${earlier}`;
}

function _myRoles() {
  return [sessionStorage.getItem('ayurxpert_role'), sessionStorage.getItem('ayurxpert_secondary_role')].filter(Boolean);
}

export async function logoutChecked() {
  let preview = null;
  if (_myRoles().some(r => SHIFT_ROLES.includes(r))) {
    try {
      const r = await Promise.race([supabase.rpc('shift_preview'), new Promise(res => setTimeout(() => res({ timeout: true }), 2500))]);
      if (!r.timeout && !r.error) preview = r.data;
    } catch { /* never blocks the sign-out */ }
  }
  const open = preview && Number(preview.receipt_count || (preview.receipts || []).length) > 0;
  if (!open) { await logout(); return; }
  _showDialog(preview);
}

function _showDialog(p) {
  document.getElementById('ax-shift-logout')?.remove();
  const prevFocus = document.activeElement;
  const ov = document.createElement('div');
  ov.id = 'ax-shift-logout';
  ov.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px';
  const box = document.createElement('div');
  box.setAttribute('role', 'alertdialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'ax-sl-t');
  box.setAttribute('aria-describedby', 'ax-sl-d');
  box.style.cssText = "background:#fff;border-radius:14px;max-width:440px;width:100%;padding:22px 24px;font-family:'DM Sans',sans-serif;color:#1c2b1f";
  const t = document.createElement('h2');
  t.id = 'ax-sl-t';
  t.style.cssText = "margin:0 0 8px;font-family:'Cormorant Garamond',serif;font-size:22px;color:#1a4a2e";
  t.textContent = "You haven't closed your shift";
  const d = document.createElement('p');
  d.id = 'ax-sl-d';
  d.style.cssText = 'margin:0 0 16px;font-size:15px;line-height:1.5';
  d.textContent = shiftLogoutText(p);
  const ncText = shiftLogoutNonCashText(p);
  const nc = ncText ? document.createElement('p') : null;
  if (nc) {
    nc.id = 'ax-sl-nc';
    nc.style.cssText = 'margin:-8px 0 16px;font-size:15px;line-height:1.5';
    nc.textContent = ncText;
    box.setAttribute('aria-describedby', 'ax-sl-d ax-sl-nc');
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end';
  const btn = (txt, primary, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = txt;
    b.style.cssText = 'min-height:44px;padding:0 16px;border-radius:8px;font:inherit;font-size:14px;font-weight:700;cursor:pointer;'
      + (primary ? 'background:#1a4a2e;color:#fff;border:0' : 'background:#fff;color:#1a4a2e;border:1.5px solid #1a4a2e');
    b.addEventListener('click', fn);
    return b;
  };
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const goClose = btn('Close shift now', true, () => { window.location.href = 'shift-close.html'; });
  const anyway = btn('Log out anyway', false, async () => { anyway.disabled = true; await logout(); });
  row.append(anyway, goClose);
  box.append(t, d, ...(nc ? [nc] : []), row);
  ov.append(box);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(ov);
  goClose.focus();
}
