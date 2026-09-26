// Session 306 — statutory registers are written only by the staff who do the work
// (sql/session306_statutory_registers_lockdown.sql). Pages stay open to their other roles
// read-only; this hides the write buttons for those roles so they never hit a database refusal.
// Keep each page's role list identical to its table's INSERT policy in that SQL file.

export function canWriteRegister(profile, roles) {
  if (!profile || profile.is_active === false) return false;
  return roles.includes(profile.role) || (!!profile.secondary_role && roles.includes(profile.secondary_role));
}

// handlers: data-onclick names of the buttons that open or save an entry.
// Hidden with a stylesheet rule, so buttons rendered later (table rows, modals) are covered too.
export function hideRegisterWrites(handlers) {
  if (!handlers.length) return;
  const s = document.createElement('style');
  s.textContent = handlers.map(h => `[data-onclick="${h}"]`).join(',') + '{display:none!important}';
  document.head.appendChild(s);
}

// Small "view only" note under the page header. Text only, no HTML from data.
export function showViewOnlyNote(text, selector = '.page-header') {
  const host = document.querySelector(selector);
  if (!host) return;
  const n = document.createElement('div');
  n.setAttribute('role', 'note');
  n.style.cssText = 'margin:0 0 14px;padding:10px 14px;border-radius:8px;background:#f5faf7;' +
    'border:1.5px solid var(--border,#d8e4dc);color:var(--text-mid,#3d5a47);font-size:13px';
  n.textContent = '👁 ' + text;
  host.after(n);
}
