// js/components/navbar.js
// White-label grouped-dropdown navbar — runs on every protected page.

import { getCurrentProfile, getCurrentTenant, getCurrentRole, logout, hasModule } from '../core/auth.js';

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

// ── Type sets ────────────────────────────────────────────────────────────────
const HOSP  = ['hospital','teaching_hospital','college'];
const NCISM = ['teaching_hospital','college'];
const PK    = ['pk_center','hospital','teaching_hospital','college'];

// ── Group + item definitions ─────────────────────────────────────────────────
// types: null = all org types | array = restricted types
// A group is hidden if all its items are filtered out.
function _buildGroups(role, type) {
  const ALL_ROLES = ['super_admin','dept_admin','doctor','receptionist','pharmacist','nurse','lab_tech','accountant','therapist'];
  const ADMIN_ROLES = ['super_admin','dept_admin'];
  const CLINICAL    = ['super_admin','dept_admin','doctor','nurse'];
  const RX_ROLES    = ['super_admin','dept_admin','pharmacist'];
  const FRONT_DESK  = ['super_admin','dept_admin','receptionist','nurse'];

  const raw = [
    {
      label: 'OPD', icon: '🩺',
      items: [
        { href:'reception.html',     label:'Reception',     roles:FRONT_DESK,                    types:null, module:'opd'        },
        { href:'doctor.html',        label:'Doctor Queue',  roles:CLINICAL,                      types:null, module:'opd'        },
        { href:'screening.html',     label:'Screening OPD', roles:CLINICAL,                      types:HOSP, module:'opd'        },
        { href:'opd-admin.html',     label:'OPD Setup',     roles:ADMIN_ROLES,                   types:null, module:'opd'        },
        { href:'dept-hub.html',      label:'Departments',   roles:CLINICAL.concat(ADMIN_ROLES),  types:HOSP, module:'opd'        },
        { href:'teaching-opd.html',  label:'Teaching OPD',  roles:CLINICAL.concat(ADMIN_ROLES),  types:NCISM,module:'ncism'      },
        { href:'tele-schedule.html', label:'Tele Schedule', roles:CLINICAL.concat(ADMIN_ROLES),  types:null, module:'teleconsult'},
        { href:'prophylaxis.html',   label:'Prophylaxis',  roles:CLINICAL.concat(ADMIN_ROLES),  types:null, module:'opd'        },
      ]
    },
    {
      label: 'IPD', icon: '🏥',
      items: [
        { href:'ipd.html',           label:'Admissions',      roles:CLINICAL.concat(['receptionist']),        types:HOSP, module:'ipd'        },
        { href:'nursing.html',       label:'Nursing',         roles:CLINICAL.concat(['nurse','therapist']),   types:HOSP, module:'nursing'    },
        { href:'icu-flowsheet.html', label:'ICU Flowsheet',   roles:CLINICAL.concat(['nurse']),               types:HOSP, module:'ipd'        },
        { href:'blood-bank.html',    label:'Blood Bank',      roles:CLINICAL.concat(['nurse']),               types:HOSP, module:'ipd'        },
        { href:'bed-admin.html',     label:'Bed Setup',       roles:ADMIN_ROLES,                             types:HOSP, module:'ipd'        },
        { href:'major-ot.html',      label:'Major OT',        roles:CLINICAL.concat(ADMIN_ROLES),            types:HOSP, module:'ipd'        },
        { href:'minor-ot.html',      label:'Minor OT',        roles:CLINICAL.concat(ADMIN_ROLES),            types:HOSP, module:'ipd'        },
        { href:'ksharasutra.html',   label:'Kshara Sutra',    roles:CLINICAL.concat(ADMIN_ROLES),            types:HOSP, module:'ipd'        },
        { href:'anc.html',           label:'ANC Register',    roles:CLINICAL.concat(['receptionist']),       types:HOSP, module:'ipd'        },
        { href:'kriyakalpa.html',    label:'Kriya Kalpa',     roles:CLINICAL.concat(['therapist']),          types:HOSP, module:'ipd'        },
        { href:'therapist.html',     label:'Therapy Sessions',roles:CLINICAL.concat(['therapist']),          types:PK,   module:'panchakarma'},
        { href:'palha-diet.html',    label:'Palha Diet',      roles:CLINICAL.concat(ADMIN_ROLES),            types:PK,   module:'panchakarma'},
        { href:'roster.html',        label:'Duty Roster',     roles:ADMIN_ROLES,                             types:HOSP, module:'hr'         },
        { href:'emergency.html',     label:'Emergency OPD',   roles:CLINICAL.concat(['receptionist']),       types:HOSP, module:'emergency'  },
        { href:'labour-room.html',   label:'Labour Room',     roles:CLINICAL,                                types:HOSP, module:'ipd'        },
        { href:'anushastra.html',    label:'Anushastra Karma',roles:CLINICAL,                                types:HOSP, module:'ipd'        },
      ]
    },
    {
      label: 'Dispensary', icon: '💊',
      items: [
        { href:'dispensaryPOS.html',  label:'Dispensary POS',  roles:RX_ROLES,                          types:null, module:'pharmacy'},
        { href:'inventory.html',      label:'Inventory',       roles:RX_ROLES,                          types:null, module:'pharmacy'},
        { href:'aushadha-nirman.html',label:'Aushadha Nirman', roles:RX_ROLES.concat(ADMIN_ROLES),      types:null, module:'pharmacy'},
        { href:'purchase.html',       label:'Purchase / GRN',  roles:RX_ROLES.concat(['accountant']),   types:null, module:'pharmacy'},
        { href:'purchase-order.html', label:'Purchase Orders', roles:RX_ROLES.concat(['accountant']),   types:null, module:'pharmacy'},
        { href:'formulary-admin.html',label:'Formulary',       roles:RX_ROLES.concat(ADMIN_ROLES),      types:HOSP, module:'pharmacy'},
        { href:'dpc.html',            label:'Procurement Cmte',roles:ADMIN_ROLES.concat(['accountant']),types:HOSP, module:'pharmacy'},
        { href:'disposal-register.html',label:'Disposal Register',roles:RX_ROLES.concat(ADMIN_ROLES),  types:null, module:'pharmacy'},
        { href:'suppliers.html',      label:'Supplier Register',roles:RX_ROLES.concat(ADMIN_ROLES),    types:null, module:'pharmacy'},
      ]
    },
    {
      label: 'Admin', icon: '⚙',
      items: [
        { href:'admin.html',             label:'Dashboard',        roles:ALL_ROLES,                                            types:null  },
        { href:'finance.html',           label:'Finance',          roles:['super_admin','dept_admin','accountant','receptionist'], types:null, module:'finance'  },
        { href:'insurance-claims.html',  label:'Insurance Claims', roles:['super_admin','dept_admin','accountant'],             types:null, module:'finance'  },
        { href:'hr.html',                label:'HR',               roles:['super_admin','dept_admin'],                         types:null, module:'hr'       },
        { href:'recruitment.html',       label:'Recruitment',      roles:['super_admin','dept_admin'],                         types:null, module:'hr'       },
        { href:'mrd.html',               label:'Medical Records',  roles:['super_admin','dept_admin'],                         types:null, module:'mrd'      },
        { href:'opd-register.html',      label:'OPD Register',     roles:['super_admin','dept_admin','doctor','receptionist'],    types:null, module:'opd'      },
        { href:'ipd-register.html',      label:'IPD Register',     roles:['super_admin','dept_admin','doctor','nurse'],            types:HOSP, module:'ipd'      },
        { href:'reports.html',           label:'Reports',          roles:['super_admin','dept_admin','accountant','lab_tech'],  types:null, module:'finance'  },
        { href:'fee-admin.html',         label:'Fee Management',   roles:['super_admin','dept_admin'],                         types:null, module:'finance'  },
        { href:'lab.html',               label:'Clinical Lab',     roles:ALL_ROLES,                                            types:null, module:'lab'      },
        { href:'lab-nabl.html',          label:'NABL Quality',     roles:['super_admin','dept_admin','lab_tech','doctor'],       types:null, module:'lab'      },
        { href:'ncism-compliance.html',  label:'NCISM Compliance', roles:ADMIN_ROLES,                                          types:NCISM,module:'ncism'    },
        { href:'quality.html',           label:'Quality',          roles:ADMIN_ROLES,                                          types:null, module:'quality'  },
        { href:'pharmacovigilance.html', label:'Pharmacovigilance',roles:ADMIN_ROLES,                                          types:NCISM,module:'quality'  },
        { href:'iqac.html',              label:'IQAC',             roles:ADMIN_ROLES,                                          types:NCISM,module:'quality'  },
        { href:'bmw.html',               label:'BMW Waste',        roles:ADMIN_ROLES.concat(['nurse']),                        types:HOSP, module:'quality'  },
        { href:'sterilisation.html',     label:'CSSD / Steril.',   roles:ADMIN_ROLES.concat(['nurse']),                        types:HOSP, module:'quality'  },
        { href:'sop-library.html',       label:'SOP Library',      roles:ADMIN_ROLES,                                          types:null, module:'quality'  },
        { href:'hai-surveillance.html',  label:'HAI Surveillance', roles:ADMIN_ROLES.concat(['nurse','doctor']),                types:HOSP, module:'quality'  },
        { href:'fms.html',               label:'Facility Mgmt',        roles:ADMIN_ROLES,                   types:null, module:'quality'  },
        { href:'nabh-self-assessment.html',label:'NABH Self-Assessment',roles:ADMIN_ROLES,                 types:null, module:'quality'  },
        { href:'subscription.html',      label:'Subscriptions',        roles:ADMIN_ROLES,                 types:null, platformOnly:true },
      ]
    },
  ];

  const isPlatformAdmin = getCurrentProfile()?.is_platform_admin || false;

  // Filter items by role + type + platformOnly + module flag
  return raw.map(g => ({
    ...g,
    items: g.items.filter(item =>
      item.roles.includes(role) &&
      (item.types === null || item.types.includes(type)) &&
      (!item.platformOnly || isPlatformAdmin) &&
      (!item.module || hasModule(item.module))
    )
  })).filter(g => g.items.length > 0);
}

// ── Inject navbar ─────────────────────────────────────────────────────────────
function _injectNavbar(profile, tenant, role) {
  const groups      = _buildGroups(role, tenant.type);
  const currentPage = window.location.pathname.split('/').pop() || 'admin.html';

  const logoHTML = tenant.logo_url
    ? `<img src="${tenant.logo_url}" alt="${tenant.name}" class="ax-logo"/>`
    : `<div class="ax-logo-fallback">${tenant.name.charAt(0).toUpperCase()}</div>`;

  // Desktop dropdown groups
  const groupsHTML = groups.map(g => {
    const hasActive = g.items.some(i => i.href === currentPage);
    const itemsHTML = g.items.map(i =>
      `<a href="${i.href}" class="ax-dd-item${i.href === currentPage ? ' active' : ''}">
        <span class="ax-dd-item-label">${i.label}</span>
      </a>`
    ).join('');
    return `<div class="ax-group${hasActive ? ' has-active' : ''}">
      <button class="ax-group-btn">${g.icon} ${g.label} <span class="ax-caret">▾</span></button>
      <div class="ax-dropdown">${itemsHTML}</div>
    </div>`;
  }).join('');

  // Mobile flat list (all items)
  const mobileHTML = groups.map(g =>
    `<div class="ax-mob-group">
      <div class="ax-mob-group-label">${g.icon} ${g.label}</div>
      ${g.items.map(i => `<a href="${i.href}" class="ax-link${i.href===currentPage?' active':''}">${i.label}</a>`).join('')}
    </div>`
  ).join('');

  const nav = document.createElement('nav');
  nav.id = 'ax-navbar';
  nav.innerHTML = `
    <div class="ax-inner">
      <div class="ax-brand">
        ${logoHTML}
        <div class="ax-brand-text">
          <span class="ax-name">${tenant.name}</span>
          <span class="ax-tagline">${_tenantTypeLabel(tenant.type)}${tenant.tenant_code ? ' · ' + tenant.tenant_code : ''}${NCISM.includes(tenant.type) && tenant.ug_intake ? ' · UG ' + tenant.ug_intake : ''}</span>
        </div>
      </div>
      <div class="ax-groups" id="ax-groups">${groupsHTML}</div>
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
      <div class="ax-mobile-links">${mobileHTML}</div>
      <div class="ax-mobile-footer">
        <span>${profile.full_name || ''} &nbsp;·&nbsp; ${_roleLabel(role)}</span>
        <button class="ax-mobile-logout" id="ax-mobile-logout">Logout</button>
      </div>
    </div>`;

  document.body.insertBefore(nav, document.body.firstChild);
  document.body.style.paddingTop = '60px';

  document.getElementById('ax-logout-btn').addEventListener('click', _handleLogout);
  document.getElementById('ax-mobile-logout').addEventListener('click', _handleLogout);
  document.getElementById('ax-hamburger').addEventListener('click', _toggleMenu);

  // Inject slide-over admin sidebar on all super/dept admin pages except admin.html
  if ((role === 'super_admin' || role === 'dept_admin') && !_isAdminHtml()) {
    _injectAdminSidebarOverlay(tenant, profile, role);
  }
}

function _isAdminHtml() {
  return (window.location.pathname.split('/').pop() || '') === 'admin.html';
}

function _injectAdminSidebarOverlay(tenant, profile, role) {
  const currentPage = window.location.pathname.split('/').pop() || '';

  // Styles
  const s = document.createElement('style');
  s.textContent = `
  #axsb-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.38);z-index:499;
    opacity:0;pointer-events:none;transition:opacity .2s}
  #axsb-backdrop.open{opacity:1;pointer-events:all}
  #axsb-panel{
    position:fixed;top:60px;left:0;bottom:0;width:256px;
    background:#fff;border-right:1px solid #e5e7eb;
    z-index:500;transform:translateX(-100%);
    transition:transform .22s cubic-bezier(.4,0,.2,1);
    display:flex;flex-direction:column;overflow-y:auto;
    box-shadow:4px 0 24px rgba(0,0,0,.13);
    font-family:'DM Sans',sans-serif;
  }
  #axsb-panel.open{transform:translateX(0)}
  .axsb-head{padding:14px 16px;border-bottom:1px solid #e5e7eb;background:#f9fafb;flex-shrink:0}
  .axsb-org{font-size:13px;font-weight:700;color:#1a2e22;line-height:1.3}
  .axsb-meta{font-size:11px;color:#9ca3af;margin-top:2px}
  .axsb-nav-inner{flex:1;overflow-y:auto;padding:4px 0 16px}
  .axsb-group{font-size:10px;font-weight:700;color:#9ca3af;text-transform:uppercase;
    letter-spacing:.8px;padding:12px 16px 4px}
  .axsb-lnk{
    display:flex;align-items:center;gap:10px;
    padding:9px 16px;color:#374151;font-size:13.5px;font-weight:500;
    text-decoration:none;transition:background .12s,color .12s;
    position:relative;
  }
  .axsb-lnk:hover{background:#f0faf5;color:#1a4a2e}
  .axsb-lnk.active{background:#e8f5ee;color:#1a4a2e;font-weight:600}
  .axsb-lnk.active::before{content:'';position:absolute;left:0;top:0;bottom:0;
    width:3px;background:#2d7a4f;border-radius:0 2px 2px 0}
  .axsb-ico{font-size:15px;width:20px;text-align:center;flex-shrink:0}
  .axsb-hint{font-size:10px;color:#c9902a;background:#fff8e1;padding:8px 14px;
    border-top:1px solid #e5e7eb;text-align:center;flex-shrink:0;line-height:1.5}
  @media(max-width:480px){#axsb-panel{width:78vw;top:56px}}
  `;
  document.head.appendChild(s);

  // Sidebar items
  const ITEMS = [
    { group:'Operations' },
    { ico:'📊', label:'Statistics',       href:'admin.html#stats' },
    { ico:'💰', label:'Accounts',         href:'admin.html#accounts' },
    { group:'Organisation' },
    { ico:'👥', label:'Human Resources',  href:'admin.html#hr' },
    { ico:'🏥', label:'Departments',      href:'admin.html#departments' },
    { ico:'🏗️', label:'Infrastructure',   href:'admin.html#infrastructure' },
    { group:'Account' },
    { ico:'💳', label:'Subscription',     href:'admin.html#subscription' },
    { ico:'🔧', label:'Feature Modules',  href:'admin.html#modules' },
    { ico:'🏛️', label:'ABDM Bridge',      href:'admin.html#abdm-bridge' },
    { group:'Quick Links' },
    { ico:'⚙️', label:'OPD Setup',        href:'opd-admin.html' },
    { ico:'🛏️', label:'Dept & Beds',      href:'bed-admin.html' },
    { ico:'📋', label:'NCISM Compliance', href:'ncism-compliance.html' },
    { ico:'💵', label:'Finance',          href:'finance.html' },
    { ico:'📊', label:'Insurance Claims', href:'insurance-claims.html' },
    { ico:'🏥', label:'Reception',        href:'reception.html' },
    { ico:'📐', label:'Fee Management',   href:'fee-admin.html' },
    { ico:'🏠', label:'Dashboard',        href:'admin.html' },
  ];

  const navHTML = ITEMS.map(it => {
    if (it.group) return `<div class="axsb-group">${it.group}</div>`;
    const isActive = it.href === currentPage || (it.href.includes('#') && it.href.split('#')[0] === currentPage);
    return `<a class="axsb-lnk${isActive ? ' active' : ''}" href="${it.href}">
      <span class="axsb-ico">${it.ico}</span>${it.label}
    </a>`;
  }).join('');

  const roleLabel = role === 'super_admin' ? 'Super Admin' : 'Dept. Admin';

  // Create elements
  const backdrop = document.createElement('div');
  backdrop.id = 'axsb-backdrop';
  document.body.appendChild(backdrop);

  const panel = document.createElement('div');
  panel.id = 'axsb-panel';
  panel.innerHTML = `
    <div class="axsb-head">
      <div class="axsb-org">${tenant.name}</div>
      <div class="axsb-meta">${roleLabel}</div>
    </div>
    <div class="axsb-nav-inner">${navHTML}</div>
    <div class="axsb-hint">Hover over logo to open · Click outside to close</div>`;
  document.body.appendChild(panel);

  // Open / close helpers
  function _open()  { panel.classList.add('open');  backdrop.classList.add('open');  }
  function _close() { panel.classList.remove('open'); backdrop.classList.remove('open'); }

  backdrop.addEventListener('click', _close);
  panel.querySelectorAll('.axsb-lnk').forEach(a => a.addEventListener('click', () => setTimeout(_close, 150)));

  // Trigger on brand hover or click
  const brand = document.querySelector('.ax-brand');
  if (brand) {
    brand.addEventListener('mouseenter', _open);
    brand.addEventListener('click', _open);
    brand.style.cursor = 'pointer';
  }
}

// ── Watermark ─────────────────────────────────────────────────────────────────
function _injectWatermark() {
  const wm = document.createElement('div');
  wm.id = 'ax-watermark';
  wm.innerHTML = `Powered by <strong>AyurXpert</strong>`;
  wm.addEventListener('click', _showPopup);
  document.body.appendChild(wm);
}

// ── Popup ─────────────────────────────────────────────────────────────────────
function _injectPopup() {
  const overlay = document.createElement('div');
  overlay.id = 'ax-popup-overlay';
  overlay.innerHTML = `
    <div id="ax-popup" role="dialog" aria-modal="true">
      <div class="ax-popup-icon">&#127807;</div>
      <div class="ax-popup-title">AyurXpert powers this portal</div>
      <div class="ax-popup-body">A complete digital ecosystem for Ayurveda — clinics, hospitals, pharmacies, colleges, pharma companies, and more.</div>
      <div class="ax-popup-btns">
        <button class="ax-popup-learn" id="ax-popup-learn">Learn More</button>
        <button class="ax-popup-close" id="ax-popup-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) _hidePopup(); });
  document.getElementById('ax-popup-learn').addEventListener('click', () => window.open('https://ayurxpert.in','_blank','noopener'));
  document.getElementById('ax-popup-close').addEventListener('click', _hidePopup);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') _hidePopup(); });
}
function _showPopup() { document.getElementById('ax-popup-overlay').classList.add('show'); }
function _hidePopup() { document.getElementById('ax-popup-overlay').classList.remove('show'); }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _handleLogout() { await logout(); }
function _toggleMenu() {
  document.getElementById('ax-mobile-menu').classList.toggle('open');
  document.getElementById('ax-hamburger').classList.toggle('open');
}

function _roleLabel(role) {
  return { super_admin:'Super Admin', dept_admin:'Dept. Admin', doctor:'Doctor', receptionist:'Receptionist',
    pharmacist:'Pharmacist', nurse:'Nurse', lab_tech:'Lab Technician', accountant:'Accountant',
    student:'Student', therapist:'Therapist' }[role] || role;
}
function _tenantTypeLabel(type) {
  return { clinic:'Clinic', hospital:'Hospital', pk_center:'Panchakarma Center', dispensary:'Dispensary',
    college:'Ayurveda College', teaching_hospital:'Teaching Hospital',
    pharma:'Pharmaceutical Co.', supplier:'Supplier', dealer:'Dealer', journal:'Journal' }[type] || 'Healthcare';
}

// ── Styles ────────────────────────────────────────────────────────────────────
function _injectStyles() {
  const s = document.createElement('style');
  s.textContent = `
  #ax-navbar {
    position:fixed;top:0;left:0;right:0;z-index:1000;
    background:#1a4a2e;
    box-shadow:0 2px 12px rgba(0,0,0,.2);
    font-family:'DM Sans',sans-serif;
  }
  .ax-inner {
    max-width:1400px;margin:0 auto;
    display:flex;align-items:center;justify-content:space-between;
    height:60px;padding:0 20px;gap:8px;
  }

  /* Brand */
  .ax-brand{display:flex;align-items:center;gap:10px;flex-shrink:0;min-width:0}
  .ax-logo{width:34px;height:34px;object-fit:contain;border-radius:8px;flex-shrink:0}
  .ax-logo-fallback{width:34px;height:34px;border-radius:8px;flex-shrink:0;background:#c9902a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px}
  .ax-brand-text{display:flex;flex-direction:column;min-width:0}
  .ax-name{color:#fff;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;line-height:1.2}
  .ax-tagline{color:rgba(255,255,255,.4);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}

  /* Groups row */
  .ax-groups{display:flex;align-items:center;gap:2px;flex:1;justify-content:center}

  /* Group dropdown */
  .ax-group{position:relative}
  .ax-group-btn{
    height:38px;padding:0 14px;background:none;border:none;cursor:pointer;
    color:rgba(255,255,255,.75);font-family:'DM Sans',sans-serif;font-size:13.5px;font-weight:500;
    border-radius:8px;display:flex;align-items:center;gap:5px;white-space:nowrap;
    transition:background .15s,color .15s;
  }
  .ax-group-btn:hover,.ax-group.has-active .ax-group-btn{background:rgba(255,255,255,.1);color:#fff}
  .ax-group.has-active .ax-group-btn{background:rgba(201,144,42,.2);color:#c9902a}
  .ax-caret{font-size:10px;opacity:.6;transition:transform .2s}
  .ax-group:hover .ax-caret{transform:rotate(180deg)}

  /* Dropdown panel */
  .ax-dropdown{
    position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);
    background:#fff;border-radius:10px;
    box-shadow:0 8px 32px rgba(0,0,0,.15);
    min-width:190px;padding:6px;
    opacity:0;pointer-events:none;
    transform:translateX(-50%) translateY(-6px);
    transition:opacity .18s,transform .18s;
    z-index:200;
  }
  .ax-group:hover .ax-dropdown,.ax-group:focus-within .ax-dropdown{
    opacity:1;pointer-events:all;
    transform:translateX(-50%) translateY(0);
  }
  .ax-dd-item{
    display:block;padding:9px 14px;border-radius:7px;
    text-decoration:none;color:#1a2e22;font-size:13px;font-weight:500;
    transition:background .12s;white-space:nowrap;
  }
  .ax-dd-item:hover{background:#e8f5ee;color:#1a4a2e}
  .ax-dd-item.active{background:rgba(201,144,42,.12);color:#7a5c00;font-weight:600}

  /* Right section */
  .ax-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
  .ax-user-info{display:flex;flex-direction:column;align-items:flex-end}
  .ax-user-name{color:rgba(255,255,255,.85);font-size:12px;font-weight:500;white-space:nowrap;max-width:120px;overflow:hidden;text-overflow:ellipsis}
  .ax-user-role{color:rgba(255,255,255,.4);font-size:10px;white-space:nowrap}
  .ax-logout-btn{background:rgba(255,255,255,.08);color:rgba(255,255,255,.75);border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:6px 12px;font-family:'DM Sans',sans-serif;font-size:12px;cursor:pointer;white-space:nowrap;transition:background .15s}
  .ax-logout-btn:hover{background:rgba(255,255,255,.18);color:#fff}

  /* Hamburger */
  .ax-hamburger{display:none;flex-direction:column;gap:5px;background:none;border:none;cursor:pointer;padding:8px;border-radius:8px}
  .ax-hamburger span{display:block;width:22px;height:2px;background:rgba(255,255,255,.8);border-radius:2px;transition:all .3s}
  .ax-hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg)}
  .ax-hamburger.open span:nth-child(2){opacity:0}
  .ax-hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}

  /* Mobile menu */
  .ax-mobile-menu{display:none;flex-direction:column;background:#143d24;border-top:1px solid rgba(255,255,255,.08);max-height:80vh;overflow-y:auto}
  .ax-mobile-menu.open{display:flex}
  .ax-mobile-links{padding:10px 12px 8px;display:flex;flex-direction:column;gap:2px}
  .ax-mob-group{margin-bottom:8px}
  .ax-mob-group-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:rgba(255,255,255,.35);padding:6px 8px 4px}
  .ax-link{display:block;padding:10px 14px;border-radius:7px;color:rgba(255,255,255,.75);font-size:14px;font-weight:500;text-decoration:none;transition:background .15s}
  .ax-link:hover{background:rgba(255,255,255,.08);color:#fff}
  .ax-link.active{background:rgba(201,144,42,.15);color:#c9902a}
  .ax-mobile-footer{display:flex;align-items:center;justify-content:space-between;padding:10px 16px 14px;border-top:1px solid rgba(255,255,255,.06)}
  .ax-mobile-footer span{color:rgba(255,255,255,.4);font-size:12px}
  .ax-mobile-logout{background:rgba(255,255,255,.08);color:rgba(255,255,255,.7);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:6px 14px;font-family:'DM Sans',sans-serif;font-size:13px;cursor:pointer}

  /* Responsive */
  @media(max-width:1024px){
    .ax-groups{display:none}
    .ax-user-info{display:none}
    .ax-logout-btn{display:none}
    .ax-hamburger{display:flex}
  }
  @media(max-width:480px){
    .ax-inner{padding:0 14px;height:56px}
    .ax-name{max-width:120px;font-size:13px}
    body{padding-top:56px!important}
    #ax-watermark{bottom:10px;right:10px;font-size:10px;padding:4px 9px}
  }

  /* Watermark */
  #ax-watermark{position:fixed;bottom:14px;right:14px;z-index:990;font-family:'DM Sans',sans-serif;font-size:11px;color:rgba(0,0,0,.28);cursor:pointer;background:rgba(255,255,255,.82);padding:5px 11px;border-radius:20px;backdrop-filter:blur(6px);border:1px solid rgba(0,0,0,.06);transition:color .2s,background .2s;user-select:none;line-height:1.4}
  #ax-watermark:hover{color:#1a4a2e;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.1)}
  #ax-watermark strong{font-weight:600;color:#2d7a4f}

  /* Popup */
  #ax-popup-overlay{display:none;position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);align-items:center;justify-content:center;padding:16px}
  #ax-popup-overlay.show{display:flex}
  #ax-popup{background:#fff;border-radius:20px;padding:32px 28px;max-width:380px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.18);animation:axPopIn .25s cubic-bezier(.34,1.56,.64,1) both}
  .ax-popup-icon{font-size:44px;margin-bottom:14px}
  .ax-popup-title{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;color:#1a4a2e;margin-bottom:10px}
  .ax-popup-body{font-size:14px;color:#6b7280;line-height:1.75;margin-bottom:24px}
  .ax-popup-btns{display:flex;gap:10px}
  .ax-popup-learn{flex:1;height:46px;background:#1a4a2e;color:#fff;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:500;cursor:pointer}
  .ax-popup-learn:hover{background:#1f5c37}
  .ax-popup-close{height:46px;padding:0 20px;background:#f3f4f6;color:#374151;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:14px;cursor:pointer}
  @keyframes axPopIn{from{opacity:0;transform:scale(.92) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
  `;
  document.head.appendChild(s);
}
