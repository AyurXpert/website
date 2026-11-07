// comingSoon.js -- Session 379a (owner, 7 Nov 2026): ABDM works only for the organisations the platform has opened (WASA until production). Every other organisation sees
// "ABDM — coming soon" wherever ABDM would be. The server refuses them whatever a page does (abdm_org_enabled, update_tenant_abdm_facility, set_abdm_share_records): this file only
// keeps the screens honest. One check, abdmOn(), for every page: it reads the map the server gave (get_my_modules, loaded by requireAuth). DOM nodes + textContent only.
import { SESSION_KEYS } from '../../config/constants.js';

export const ABDM_SOON = 'ABDM — coming soon';

export function abdmOn() {
  if (typeof sessionStorage === 'undefined') return true;   // the node unit checks have no browser
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEYS.MODULES) || '{}').abdm === true; } catch { return false; }
}

export function soonBox() {
  const d = document.createElement('div');
  d.className = 'abdm-soon';
  d.setAttribute('role', 'status');
  d.style.cssText = "margin:12px 0;padding:14px 16px;border:1.5px dashed var(--border,#d8d2c4);border-radius:8px;background:var(--cream,#faf8f3);color:var(--text-mid,#4a4a4a);font:600 14px 'DM Sans',sans-serif;text-align:center";
  d.textContent = ABDM_SOON;
  return d;
}

// Hides what is inside a panel and shows the line instead. The elements stay in the page: the page's own code holds them by id.
export function closeAbdmPanel(panel, { keep = null } = {}) {
  if (!panel || panel.querySelector(':scope > .abdm-soon')) return;
  for (const c of panel.children) {
    if (!keep || !c.matches(keep)) c.style.setProperty('display', 'none', 'important');
  }
  panel.append(soonBox());
}
