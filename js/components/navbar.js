// js/components/navbar.js
// White-label engine — runs on every protected page.
// Injects: tenant branding navbar, role-based nav links,
//          mobile hamburger menu, "Powered by AyurXpert" watermark + popup.

import { getCurrentProfile, getCurrentTenant, getCurrentRole, logout } from '../core/auth.js';

export function initNavbar() {
  const profile = getCurrentProfile();
  const tenant  = getCurrentTenant();
  const role    = getCurrentRole();

  if (!profile || !tenant) return;

  _injectStyles();
  _injectNavbar(profile, tenant, role);
  _injectWatermark();
  _injectPopup();
}

// ── Nav links per role ───────────────────────────────────────────────────────
function _getLinks(role) {
  const all = [
    { href: 'admin.html',        label: 'Dashboard',  roles: ['super_admin','dept_admin','doctor','receptionist','pharmacist','nurse','lab_tech','accountant'] },
    { href: 'reception.html',    label: 'Reception',  roles: ['super_admin','dept_admin','receptionist','nurse'] },
    { href: 'doctor.html',       label: 'Queue',      roles: ['super_admin','dept_admin','doctor','nurse'] },
    { href: 'dispensaryPOS.html',  label: 'Dispensary', roles: ['super_admin','dept_admin','pharmacist'] },
    { href: 'inventory.html',    label: 'Inventory',  roles: ['super_admin','dept_admin','pharmacist'] },
    { href: 'purchase.html',     label: 'Purchase',   roles: ['super_admin','dept_admin','pharmacist','accountant'] },
    { href: 'reports.html',      label: 'Reports',    roles: ['super_admin','dept_admin','accountant'] },
  ];
  return all.filter(l => l.roles.includes(role));
}

// ── Navbar ───────────────────────────────────────────────────────────────────
function _injectNavbar(profile, tenant, role) {
  const links       = _getLinks(role);
  const currentPage = window.location.pathname.split('/').pop() || 'admin.html';

  const logoHTML = tenant.logo_url
    ? `<img src="${tenant.logo_url}" alt="${tenant.name}" class="ax-logo"/>`
    : `<div class="ax-logo-fallback">${tenant.name.charAt(0).toUpperCase()}</div>`;

  const linksHTML = links.map(l =>
    `<a href="${l.href}" class="ax-link${currentPage === l.href ? ' active' : ''}">${l.label}</a>`
  ).join('');

  const nav = document.createElement('nav');
  nav.id = 'ax-navbar';
  nav.innerHTML = `
    <div class="ax-inner">
      <div class="ax-brand">
        ${logoHTML}
        <div class="ax-brand-text">
          <span class="ax-name">${tenant.name}</span>
          <span class="ax-tagline">${_tenantTypeLabel(tenant.type)}${tenant.tenant_code ? ' · ' + tenant.tenant_code : ''}</span>
        </div>
      </div>

      <div class="ax-links" id="ax-links">${linksHTML}</div>

      <div class="ax-right">
        <div class="ax-user-info">
          <span class="ax-user-name">${profile.full_name || 'User'}</span>
          <span class="ax-user-role">${_roleLabel(role)}</span>
        </div>
        <button class="ax-logout-btn" id="ax-logout-btn">Logout</button>
        <button class="ax-hamburger" id="ax-hamburger" aria-label="Open menu">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>

    <div class="ax-mobile-menu" id="ax-mobile-menu">
      <div class="ax-mobile-links">${linksHTML}</div>
      <div class="ax-mobile-footer">
        <span>${profile.full_name || ''} &nbsp;·&nbsp; ${_roleLabel(role)}</span>
        <button class="ax-mobile-logout" id="ax-mobile-logout">Logout</button>
      </div>
    </div>
  `;

  document.body.insertBefore(nav, document.body.firstChild);
  document.body.style.paddingTop = '60px';

  document.getElementById('ax-logout-btn').addEventListener('click', _handleLogout);
  document.getElementById('ax-mobile-logout').addEventListener('click', _handleLogout);
  document.getElementById('ax-hamburger').addEventListener('click', _toggleMenu);
}

// ── Watermark ────────────────────────────────────────────────────────────────
function _injectWatermark() {
  const wm = document.createElement('div');
  wm.id = 'ax-watermark';
  wm.innerHTML = `Powered by <strong>AyurXpert</strong>`;
  wm.addEventListener('click', _showPopup);
  document.body.appendChild(wm);
}

// ── Popup ────────────────────────────────────────────────────────────────────
function _injectPopup() {
  const overlay = document.createElement('div');
  overlay.id = 'ax-popup-overlay';
  overlay.innerHTML = `
    <div id="ax-popup" role="dialog" aria-modal="true">
      <div class="ax-popup-icon">&#127807;</div>
      <div class="ax-popup-title">AyurXpert powers this portal</div>
      <div class="ax-popup-body">
        A complete digital ecosystem for Ayurveda — clinics, hospitals,
        pharmacies, colleges, pharma companies, and more. All in one platform.
      </div>
      <div class="ax-popup-btns">
        <button class="ax-popup-learn" id="ax-popup-learn">Learn More</button>
        <button class="ax-popup-close" id="ax-popup-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) _hidePopup(); });
  document.getElementById('ax-popup-learn').addEventListener('click', () => {
    window.open('https://ayurxpert.in', '_blank', 'noopener');
  });
  document.getElementById('ax-popup-close').addEventListener('click', _hidePopup);

  // Close on Escape key
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') _hidePopup();
  });
}

function _showPopup() {
  document.getElementById('ax-popup-overlay').classList.add('show');
}
function _hidePopup() {
  document.getElementById('ax-popup-overlay').classList.remove('show');
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function _handleLogout() {
  await logout();
}

function _toggleMenu() {
  const menu = document.getElementById('ax-mobile-menu');
  const btn  = document.getElementById('ax-hamburger');
  menu.classList.toggle('open');
  btn.classList.toggle('open');
}

function _roleLabel(role) {
  const map = {
    super_admin:  'Super Admin',
    dept_admin:   'Dept. Admin',
    doctor:       'Doctor',
    receptionist: 'Receptionist',
    pharmacist:   'Pharmacist',
    nurse:        'Nurse',
    lab_tech:     'Lab Technician',
    accountant:   'Accountant',
    student:      'Student',
  };
  return map[role] || role;
}

function _tenantTypeLabel(type) {
  const map = {
    clinic:      'Clinic',
    hospital:    'Hospital',
    pk_center:   'Panchakarma Center',
    dispensary:  'Dispensary',
    college:     'Ayurveda College',
    pharma:      'Pharmaceutical Co.',
    supplier:    'Supplier',
    dealer:      'Dealer',
    journal:     'Journal',
  };
  return map[type] || type || 'Healthcare';
}

// ── Styles ───────────────────────────────────────────────────────────────────
function _injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
  /* ── NAVBAR ── */
  #ax-navbar {
    position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
    background: #1a4a2e;
    box-shadow: 0 2px 12px rgba(0,0,0,0.2);
    font-family: 'DM Sans', sans-serif;
  }
  .ax-inner {
    max-width: 1280px; margin: 0 auto;
    display: flex; align-items: center; justify-content: space-between;
    height: 60px; padding: 0 20px; gap: 12px;
  }

  /* Brand */
  .ax-brand { display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-width: 0; }
  .ax-logo  { width: 36px; height: 36px; object-fit: contain; border-radius: 8px; flex-shrink: 0; }
  .ax-logo-fallback {
    width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0;
    background: #c9902a; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 16px;
  }
  .ax-brand-text { display: flex; flex-direction: column; min-width: 0; }
  .ax-name    { color: #fff; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; line-height: 1.2; }
  .ax-tagline { color: rgba(255,255,255,0.45); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 180px; }

  /* Nav links */
  .ax-links { display: flex; align-items: center; gap: 2px; flex: 1; justify-content: center; }
  .ax-link  { color: rgba(255,255,255,0.65); text-decoration: none; font-size: 14px; font-weight: 500; padding: 7px 13px; border-radius: 8px; transition: background .2s, color .2s; white-space: nowrap; }
  .ax-link:hover  { background: rgba(255,255,255,0.1); color: #fff; }
  .ax-link.active { background: rgba(201,144,42,0.18); color: #c9902a; }

  /* Right section */
  .ax-right { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
  .ax-user-info { display: flex; flex-direction: column; align-items: flex-end; }
  .ax-user-name { color: rgba(255,255,255,0.85); font-size: 13px; font-weight: 500; white-space: nowrap; max-width: 130px; overflow: hidden; text-overflow: ellipsis; }
  .ax-user-role { color: rgba(255,255,255,0.4); font-size: 11px; white-space: nowrap; }
  .ax-logout-btn {
    background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.75);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
    padding: 6px 14px; font-family: 'DM Sans', sans-serif; font-size: 13px;
    cursor: pointer; transition: background .2s, color .2s; white-space: nowrap;
  }
  .ax-logout-btn:hover { background: rgba(255,255,255,0.18); color: #fff; }

  /* Hamburger */
  .ax-hamburger { display: none; flex-direction: column; gap: 5px; background: none; border: none; cursor: pointer; padding: 8px; border-radius: 8px; }
  .ax-hamburger span { display: block; width: 22px; height: 2px; background: rgba(255,255,255,0.8); border-radius: 2px; transition: all .3s; }
  .ax-hamburger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
  .ax-hamburger.open span:nth-child(2) { opacity: 0; }
  .ax-hamburger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

  /* Mobile menu */
  .ax-mobile-menu { display: none; flex-direction: column; background: #143d24; border-top: 1px solid rgba(255,255,255,0.08); }
  .ax-mobile-menu.open { display: flex; }
  .ax-mobile-links { display: flex; flex-direction: column; padding: 10px 12px 8px; gap: 2px; }
  .ax-mobile-links .ax-link { padding: 12px 16px; font-size: 15px; }
  .ax-mobile-footer { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px 14px; border-top: 1px solid rgba(255,255,255,0.06); }
  .ax-mobile-footer span { color: rgba(255,255,255,0.4); font-size: 12px; }
  .ax-mobile-logout { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.7); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px 14px; font-family: 'DM Sans', sans-serif; font-size: 13px; cursor: pointer; }
  .ax-mobile-logout:hover { background: rgba(255,255,255,0.18); color: #fff; }

  /* ── WATERMARK ── */
  #ax-watermark {
    position: fixed; bottom: 14px; right: 14px; z-index: 990;
    font-family: 'DM Sans', sans-serif; font-size: 11px; font-weight: 400;
    color: rgba(0,0,0,0.28); cursor: pointer;
    background: rgba(255,255,255,0.82);
    padding: 5px 11px; border-radius: 20px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid rgba(0,0,0,0.06);
    transition: color .2s, background .2s, box-shadow .2s;
    user-select: none;
    line-height: 1.4;
  }
  #ax-watermark:hover {
    color: #1a4a2e; background: #fff;
    box-shadow: 0 4px 16px rgba(0,0,0,0.1);
  }
  #ax-watermark strong { font-weight: 600; color: #2d7a4f; }

  /* ── POPUP ── */
  #ax-popup-overlay {
    display: none; position: fixed; inset: 0; z-index: 2000;
    background: rgba(0,0,0,0.45);
    backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
    align-items: center; justify-content: center;
    padding: 16px;
  }
  #ax-popup-overlay.show { display: flex; }
  #ax-popup {
    background: #fff; border-radius: 20px; padding: 32px 28px;
    max-width: 380px; width: 100%; text-align: center;
    box-shadow: 0 24px 64px rgba(0,0,0,0.18);
    animation: axPopIn .25s cubic-bezier(.34,1.56,.64,1) both;
  }
  .ax-popup-icon  { font-size: 44px; margin-bottom: 14px; }
  .ax-popup-title { font-family: 'Cormorant Garamond', serif; font-size: 22px; font-weight: 600; color: #1a4a2e; margin-bottom: 10px; line-height: 1.3; }
  .ax-popup-body  { font-size: 14px; color: #6b7280; line-height: 1.75; margin-bottom: 24px; }
  .ax-popup-btns  { display: flex; gap: 10px; }
  .ax-popup-learn {
    flex: 1; height: 46px; background: #1a4a2e; color: #fff;
    border: none; border-radius: 10px;
    font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: background .2s;
  }
  .ax-popup-learn:hover { background: #1f5c37; }
  .ax-popup-close {
    height: 46px; padding: 0 20px; background: #f3f4f6; color: #374151;
    border: none; border-radius: 10px;
    font-family: 'DM Sans', sans-serif; font-size: 14px; cursor: pointer;
    transition: background .2s;
  }
  .ax-popup-close:hover { background: #e5e7eb; }

  @keyframes axPopIn {
    from { opacity: 0; transform: scale(.92) translateY(10px); }
    to   { opacity: 1; transform: scale(1)   translateY(0);    }
  }

  /* ── RESPONSIVE BREAKPOINTS ── */
  @media (max-width: 900px) {
    .ax-links    { display: none; }
    .ax-user-info { display: none; }
    .ax-logout-btn { display: none; }
    .ax-hamburger  { display: flex; }
    .ax-tagline    { display: none; }
  }
  @media (max-width: 480px) {
    .ax-inner  { padding: 0 14px; height: 56px; }
    .ax-name   { max-width: 140px; font-size: 14px; }
    .ax-logo, .ax-logo-fallback { width: 30px; height: 30px; }
    body       { padding-top: 56px !important; }
    #ax-watermark { bottom: 10px; right: 10px; font-size: 10px; padding: 4px 9px; }
    #ax-popup  { padding: 24px 20px; border-radius: 16px; }
    .ax-popup-title { font-size: 20px; }
    .ax-popup-btns { flex-direction: column; }
    .ax-popup-close { height: 42px; }
  }
  `;
  document.head.appendChild(s);
}
