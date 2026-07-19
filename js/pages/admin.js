import { requireAuth, getCurrentProfile, getCurrentTenant, getCurrentTenantId,
         getCurrentRole, getPendingApprovals } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase }   from '../core/db/supabaseClient.js';
import { logAudit }   from '../core/auditLogger.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType, NCISM_DEPTS, CLINICAL_CODES, UG_BED_RATIOS, SCHEDULE_IV, NCISM_OPDS } from '../config/ncism.js';

await requireAuth(['super_admin','dept_admin'], 'index.html');
initNavbar();
wireDelegatedEvents();

const profile  = getCurrentProfile();
const tenant   = getCurrentTenant();
const tenantId = getCurrentTenantId();
const role     = getCurrentRole();
if (!profile) { window.location.href = 'login.html'; }
document.title = 'Master Control — ' + (tenant?.name || 'AyurXpert');

const todayStr   = new Date().toISOString().split('T')[0];
const todayStart = todayStr + 'T00:00:00';
const todayEnd   = todayStr + 'T23:59:59';

// Non-admin roles are already redirected by requireAuth() above before this line
// ever runs — no local redirect logic needed here (removed a stale duplicate
// ROLE_HOME map that had drifted out of sync with js/config/constants.js).
_bootMasterControl();

// ════════════════════════════════════════════════
// MASTER CONTROL BOOT
// ════════════════════════════════════════════════
function _bootMasterControl() {
  document.getElementById('admin-shell').style.display = 'flex';
  document.getElementById('sb-org-name').textContent  = tenant?.name || '—';
  document.getElementById('sb-org-code').textContent  = tenant?.tenant_code || '—';
  document.getElementById('sb-org-type').textContent  = _tenantLabel(tenant?.type) + ' ·';
  document.getElementById('stats-date').textContent   =
    new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

  document.getElementById('sidebar-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(tenant?.tenant_code||'')
      .then(()=>_toast('Organisation code copied!'))
      .catch(()=>_toast('Code: '+(tenant?.tenant_code||'')));
  });

  // ── Sidebar navigation (section switching) ──────────────────────────────────
  document.querySelectorAll('.sb-item[data-target],.sb-sub[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.target, sub = btn.dataset.sub;
      // Update active state
      document.querySelectorAll('.sb-item[data-target],.sb-sub[data-target]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.classList.contains('sb-sub')) {
        document.querySelector(`.sb-item[data-target="${t}"]`)?.classList.add('active');
      }
      _showSection(t, sub);
    });
  });

  // ── Hash routing — honour admin.html#stats links from other pages ────────────
  // #target:sub (e.g. #hr:dept) also drives HR's own sub-tabs (.hr-tab, data-sub), which
  // aren't otherwise reachable via a direct link — Session 104: the NCISM Setup Compliance
  // checklist's "All departments configured" needs to land specifically on HR's
  // "Dept. Staff" sub-tab (the one unfiltered department list matching its own "29 active
  // departments" count), not just the HR section's default Staff-list sub-tab.
  function _handleHash() {
    const hash = location.hash.slice(1);
    if (!hash) return;
    const [target, sub] = hash.split(':');
    const btn = document.querySelector(`.sb-item[data-target="${target}"],.sb-sub[data-target="${target}"]`);
    if (btn) btn.click();
    if (sub) setTimeout(() => document.querySelector(`.hr-tab[data-sub="${sub}"]`)?.click(), 50);
  }
  setTimeout(_handleHash, 300);
  window.addEventListener('hashchange', _handleHash);

  // Fresh Teaching Hospital/College registration — land on Subscription so the
  // admin can set up NCISM intake/PG capacity right away. Isolated to this one
  // flag/page rather than a login.js redirect param, since login.js's redirect
  // flow is shared by every role and tenant type.
  if (localStorage.getItem('ax_post_reg_open_subscription') === '1') {
    localStorage.removeItem('ax_post_reg_open_subscription');
    setTimeout(() => document.querySelector('.sb-item[data-target="subscription"]')?.click(), 300);
  }

  // HR sub-tabs
  document.querySelectorAll('.hr-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.hr-tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const sub = btn.dataset.sub;
      if (sub === 'hierarchy') {
        _hrSub('hierarchy');
        if (window._staffAll) renderHierarchy(window._staffAll);
        else window.loadHR('hierarchy');
      } else {
        _hrSub(sub);
      }
    });
  });

  setTimeout(() => { window.loadStats(); window.renderSubBanner(); window.renderMigrationBanner(); }, 0);
}

function _showSection(target, sub) {
  document.querySelectorAll('.content-section').forEach(s=>s.classList.remove('active'));
  document.getElementById('section-'+target)?.classList.add('active');
  if (target==='hr')             window.loadHR(sub||'staff');
  if (target==='departments')    window.loadDepts();
  if (target==='infrastructure') window.loadInfraSetup();
  if (target==='monthly')        window.initMonthlyReport();
  if (target==='subscription')   window.loadSubscription();
  if (target==='packages')       window.loadPackages();
  if (target==='modules')        window.loadModules();
  if (target==='accounts')           window.loadAccounts();
  if (target==='abdm-bridge')        window.loadAbdmCallbacks();
  if (target==='compliance-reports') {
    const today = new Date().toISOString().slice(0,7);
    document.getElementById('sdf-month').value    = today;
    document.getElementById('stat-month').value   = today;
    document.getElementById('namste-month').value = today;
    // Check if 10th-of-month alert needed
    const day = new Date().getDate();
    const alertEl = document.getElementById('sdf-alert');
    if (alertEl && day >= 8 && day <= 10) {
      alertEl.textContent = '⚠ Monthly SDF upload is due by the 10th. Generate and upload to the NCISM portal now.';
      alertEl.style.display = '';
    }
  }
}

// ────────────────────────────────────────────────
// SECTION 1 — STATISTICS
// ────────────────────────────────────────────────
window.loadStats = async function() {
  const [patients, revenue, beds, pending, staff, depts, tenantRow] = await Promise.all([
    _countToday('visits'),
    _sumToday('bills','final_amount'),
    _count('beds',[['tenant_id',tenantId],['status','occupied']]),
    _count('profiles',[['tenant_id',tenantId],['status','pending_approval']]),
    _count('profiles',[['tenant_id',tenantId],['is_active',true]]),
    _count('departments',[['tenant_id',tenantId],['is_active',true]]),
    supabase.from('tenants').select('ug_intake,opd_daily_target,type').eq('id',tenantId).single(),
  ]);

  const tenant    = tenantRow?.data;
  const ugIntake  = tenant?.ug_intake  || 0;
  const dailyTgt  = tenant?.opd_daily_target || (ugIntake * 2) || 0;
  const isCollege = isNCISMType(tenant?.type);

  document.getElementById('stats6').innerHTML = [
    {ico:'🏥',cls:'g',   num:patients,       lbl:'Patients Today',    sub:'OPD visits'},
    {ico:'₹', cls:'gold',num:_fmt(revenue),  lbl:'Revenue Today',     sub:'collected'},
    {ico:'🛏️',cls:'b',   num:beds,           lbl:'Beds Occupied',     sub:'currently'},
    {ico:'⏳',cls:'r',   num:pending,        lbl:'Pending Approvals', sub:'staff awaiting'},
    {ico:'👥',cls:'p',   num:staff,          lbl:'Active Staff',      sub:'total onboarded'},
    {ico:'🏛️',cls:'t',  num:depts,          lbl:'Active Depts',      sub:'configured'},
  ].map(c=>`<div class="sc">
    <div class="sc-ico ${c.cls}">${c.ico}</div>
    <div class="sc-num">${c.num??'—'}</div>
    <div class="sc-lbl">${c.lbl}</div>
    <div class="sc-sub">${c.sub}</div>
  </div>`).join('');

  // ── NCISM OPD attendance compliance banner ──────────────────────────────────
  const banner = document.getElementById('opd-compliance-banner');
  if (isCollege && dailyTgt > 0) {
    const pct     = Math.min(Math.round((patients / dailyTgt) * 100), 100);
    const cls     = pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'red';
    const icon    = pct >= 80 ? '✅' : pct >= 50 ? '⚠️' : '🚨';
    const msg     = pct >= 100
      ? `NCISM target achieved — ${patients} patients (target: ${dailyTgt})`
      : pct >= 80
      ? `On track — ${patients} / ${dailyTgt} patients today (${pct}% of NCISM target)`
      : pct >= 50
      ? `Below target — ${patients} / ${dailyTgt} patients today. Need ${dailyTgt - patients} more to meet NCISM minimum.`
      : `Critical — only ${patients} / ${dailyTgt} patients today (${pct}%). Immediate action needed to meet NCISM OPD attendance norm.`;
    const barColour = pct >= 80 ? 'var(--green-mid)' : pct >= 50 ? '#e0a800' : 'var(--red)';
    banner.innerHTML = `<div class="opd-alert ${cls}">
      <div class="opd-alert-icon">${icon}</div>
      <div class="opd-alert-body">
        <div class="opd-alert-title">NCISM OPD Attendance — Today (UG Intake: ${ugIntake} | Required: ${dailyTgt}/day)</div>
        <div>${msg}</div>
        <div class="opd-alert-prog"><div class="opd-alert-prog-bar" style="width:${pct}%;background:${barColour}"></div></div>
      </div>
    </div>`;
  } else {
    banner.innerHTML = '';
  }

  // ── NCISM IPD bed compliance alert ──────────────────────────────────────────
  const ipdBanner = document.getElementById('ipd-compliance-banner');
  if (isCollege && ugIntake > 0) {
    const UG_BED_RATIOS = {KAY:.20,PK:.25,SHAL:.20,SHAK:.10,KAU:.10,AGD:.05,PST:.10};
    const [deptRes, bedRes] = await Promise.all([
      supabase.from('departments').select('id,name,ncism_code,is_pg_dept,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_active',true),
      supabase.from('beds').select('department_id,status').eq('tenant_id',tenantId),
    ]);
    const allDepts = deptRes.data || [];
    const allBeds  = bedRes.data  || [];

    const bedCountByDept = {};
    const occCountByDept = {};
    allBeds.forEach(b => {
      bedCountByDept[b.department_id] = (bedCountByDept[b.department_id] || 0) + 1;
      if (b.status === 'occupied') occCountByDept[b.department_id] = (occCountByDept[b.department_id] || 0) + 1;
    });

    const violations = [];
    allDepts.forEach(d => {
      const ratio = UG_BED_RATIOS[d.ncism_code];
      if (!ratio) return;
      const required = Math.floor(ugIntake * ratio) + (d.is_pg_dept ? (d.pg_seats_sanctioned||0)*4 : 0);
      const actual   = bedCountByDept[d.id] || 0;
      const occupied = occCountByDept[d.id] || 0;
      const occPct   = actual > 0 ? Math.round(occupied / actual * 100) : null;
      const threshold= d.is_pg_dept ? 80 : 60;

      if (actual < required) {
        violations.push({severity:'critical', dept:d.name, msg:`Only ${actual} beds allocated — NCISM requires ${required}`});
      } else if (occPct !== null && occPct < threshold) {
        const sev = occPct < Math.round(threshold * 0.75) ? 'critical' : 'warning';
        violations.push({severity:sev, dept:d.name, msg:`Occupancy ${occPct}% — below NCISM minimum of ${threshold}%`});
      }
    });

    if (violations.length) {
      const hasCritical = violations.some(v => v.severity === 'critical');
      const cls  = hasCritical ? 'red' : 'amber';
      const icon = hasCritical ? '🚨' : '⚠️';
      ipdBanner.innerHTML = `<div class="opd-alert ${cls}" style="margin-top:8px">
        <div class="opd-alert-icon">${icon}</div>
        <div class="opd-alert-body">
          <div class="opd-alert-title">NCISM IPD Bed Compliance — ${violations.length} issue${violations.length>1?'s':''} detected</div>
          ${violations.map(v=>`<div style="margin-top:4px"><strong>${_esc(v.dept)}:</strong> ${_esc(v.msg)}</div>`).join('')}
          <div style="margin-top:6px;font-size:11px"><a href="ncism-compliance.html" style="color:inherit;text-decoration:underline">→ Open full compliance report</a></div>
        </div>
      </div>`;
    } else {
      ipdBanner.innerHTML = `<div class="opd-alert green" style="margin-top:8px">
        <div class="opd-alert-icon">🛏️</div>
        <div class="opd-alert-body">
          <div class="opd-alert-title">NCISM IPD Beds — All departments meeting minimum bed requirements</div>
        </div>
      </div>`;
    }
  } else {
    ipdBanner.innerHTML = '';
  }

  // ── NCISM Setup Compliance Checklist ────────────────────────────────────────
  if (isCollege) {
    await _renderNcismChecklist(ugIntake || 0, tenant?.type);
  }

  // §21x — NABH status (always shown for hospital/college types)
  window.loadNabhStatus && window.loadNabhStatus();

  const _sb=document.getElementById('badge-pending');
  if(_sb){if(pending>0){_sb.textContent=pending;_sb.style.display='';}else{_sb.style.display='none';}}
};

// ────────────────────────────────────────────────
// SECTION 1b — ACCOUNTS (Financial)
// ────────────────────────────────────────────────
window.loadAccounts = async function() {
  const monthStart   = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString();

  const [paidToday, paidMonth, allPending] = await Promise.all([
    supabase.from('bills').select('final_amount,payer_type,bill_type')
      .eq('tenant_id',tenantId).eq('status','paid')
      .gte('created_at',todayStart).lte('created_at',todayEnd),
    supabase.from('bills').select('final_amount,payer_type,bill_type')
      .eq('tenant_id',tenantId).eq('status','paid')
      .gte('created_at',monthStart),
    supabase.from('bills')
      .select('id,final_amount,patient_due,created_at,bill_type,payer_type,tpa_name,insurance_provider,insurance_approved_amount,insurance_claim_status,pre_auth_status,status,patients(name)')
      .eq('tenant_id',tenantId)
      .in('status',['pending','partial'])
      .order('created_at',{ascending:false})
      .limit(100),
  ]);

  const todayList = paidToday.data  || [];
  const monthList = paidMonth.data  || [];
  const pendList  = allPending.data || [];

  const sumAmt = (arr, key='final_amount') => arr.reduce((s,b)=>s+(Number(b[key])||0), 0);

  const revenueToday   = sumAmt(todayList);
  const revenueMonth   = sumAmt(monthList);
  const selfPay        = pendList.filter(b=>b.payer_type==='self_pay');
  const insClaims      = pendList.filter(b=>b.payer_type!=='self_pay');
  const overdue30      = pendList.filter(b=>new Date(b.created_at)<new Date(thirtyDaysAgo));

  // ── KPI Cards ──
  const acGrid = document.getElementById('accounts-stats');
  if(acGrid) acGrid.innerHTML=[
    {ico:'₹',  cls:'gold', num:_fmt(revenueToday),    lbl:'Revenue Today',     sub:'cash & digital in'},
    {ico:'📅', cls:'g',    num:_fmt(revenueMonth),     lbl:'This Month',         sub:'total revenue collected'},
    {ico:'👤', cls:'b',    num:_fmt(sumAmt(selfPay)),  lbl:'Self-Pay Pending',   sub:selfPay.length+' bills awaiting'},
    {ico:'🏥', cls:'p',    num:insClaims.length,        lbl:'Insurance Claims',   sub:'pending with TPA / PMJAY'},
    {ico:'⚠️', cls:'r',    num:overdue30.length,        lbl:'Outstanding >30d',   sub:_fmt(sumAmt(overdue30))+' at risk'},
  ].map(c=>`<div class="sc"><div class="sc-ico ${c.cls}">${c.ico}</div><div class="sc-num">${c.num??'—'}</div><div class="sc-lbl">${c.lbl}</div><div class="sc-sub">${c.sub}</div></div>`).join('');

  // ── Revenue Breakdown table ──
  const opdT  = sumAmt(todayList.filter(b=>b.bill_type==='OPD'));
  const ipdT  = sumAmt(todayList.filter(b=>b.bill_type==='IPD'));
  const opdM  = sumAmt(monthList.filter(b=>b.bill_type==='OPD'));
  const ipdM  = sumAmt(monthList.filter(b=>b.bill_type==='IPD'));
  const spT   = sumAmt(todayList.filter(b=>b.payer_type==='self_pay'));
  const insT  = sumAmt(todayList.filter(b=>b.payer_type!=='self_pay'));
  const spM   = sumAmt(monthList.filter(b=>b.payer_type==='self_pay'));
  const insM  = sumAmt(monthList.filter(b=>b.payer_type!=='self_pay'));

  const bkDiv = document.getElementById('accounts-breakdown');
  if(bkDiv) bkDiv.innerHTML=`<div class="tw"><table>
    <thead><tr><th>Category</th><th>Today</th><th>This Month</th></tr></thead>
    <tbody>
      <tr><td><span class="chip b">OPD</span> Outpatient</td><td>${_fmt(opdT)}</td><td>${_fmt(opdM)}</td></tr>
      <tr><td><span class="chip p">IPD</span> Inpatient</td><td>${_fmt(ipdT)}</td><td>${_fmt(ipdM)}</td></tr>
      <tr style="border-top:2px solid var(--border);font-weight:600">
        <td>Total Collected</td><td>${_fmt(revenueToday)}</td><td>${_fmt(revenueMonth)}</td>
      </tr>
      <tr><td><span class="chip b">Self-Pay</span></td><td>${_fmt(spT)}</td><td>${_fmt(spM)}</td></tr>
      <tr><td><span class="chip g">Insurance / Govt</span></td><td>${_fmt(insT)}</td><td>${_fmt(insM)}</td></tr>
    </tbody>
  </table></div>`;

  // ── Pending Bills badge ──
  const badge = document.getElementById('pending-bills-badge');
  if(badge){
    if(pendList.length>0){badge.textContent=pendList.length;badge.style.display='';}
    else{badge.style.display='none';}
  }

  // ── Pending Bills table ──
  const wrap = document.getElementById('pending-bills-body');
  if(!pendList.length){
    wrap.innerHTML=`<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">No pending bills — all collected</div></div>`;
    return;
  }

  const _payerChip = b => {
    if(b.payer_type==='self_pay')  return `<span class="chip b">Self-Pay</span>`;
    if(b.payer_type==='pmjay')     return `<span class="chip g">PMJAY</span>`;
    if(b.payer_type==='cghs')      return `<span class="chip g">CGHS</span>`;
    if(b.payer_type==='echs')      return `<span class="chip g">ECHS</span>`;
    if(b.payer_type==='esi')       return `<span class="chip g">ESIC</span>`;
    if(b.payer_type==='corporate') return `<span class="chip p">${_esc(b.tpa_name||'Corporate')}</span>`;
    return `<span class="chip p">${_esc(b.tpa_name||b.insurance_provider||'Insurance')}</span>`;
  };

  const _claimBadge = b => {
    if(b.payer_type==='self_pay') return '—';
    return ({
      pre_auth_pending:  `<span class="chip r">Pre-Auth ⏳</span>`,
      pre_auth_approved: `<span class="chip g">Auth ✅</span>`,
      submitted:         `<span class="chip b">Submitted</span>`,
      settled:           `<span class="chip g">Settled</span>`,
      partial_settled:   `<span class="chip gold">Partial</span>`,
      rejected:          `<span class="chip r">Rejected ✗</span>`,
    })[b.insurance_claim_status] || '—';
  };

  const _days = iso => {
    const d = Math.floor((Date.now()-new Date(iso))/86400000);
    return d===0?'Today':d+'d';
  };
  const _daysStyle = iso => {
    const d = Math.floor((Date.now()-new Date(iso))/86400000);
    return d>30?'color:var(--red);font-weight:600':d>7?'color:var(--gold)':'';
  };

  wrap.innerHTML=`<div class="tw" style="overflow-x:auto"><table>
    <thead><tr>
      <th>Patient</th><th>Type</th><th>Payer</th>
      <th style="text-align:right">Bill ₹</th>
      <th style="text-align:right">Approved ₹</th>
      <th style="text-align:right">Patient Due</th>
      <th>Days</th><th>Claim Status</th>
    </tr></thead>
    <tbody>${pendList.map(b=>`<tr>
      <td><strong>${_esc(b.patients?.name||'—')}</strong></td>
      <td><span class="chip ${b.bill_type==='IPD'?'p':'b'}">${b.bill_type||'OPD'}</span></td>
      <td>${_payerChip(b)}</td>
      <td style="text-align:right">${_fmt(b.final_amount)}</td>
      <td style="text-align:right">${b.payer_type!=='self_pay'&&b.insurance_approved_amount?_fmt(b.insurance_approved_amount):'—'}</td>
      <td style="text-align:right;font-weight:600;color:var(--red)">${_fmt(b.patient_due??b.final_amount)}</td>
      <td style="${_daysStyle(b.created_at)}">${_days(b.created_at)}</td>
      <td>${_claimBadge(b)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
};

// ────────────────────────────────────────────────
// SECTION HR — LOGIN ACCESS (Staff Account Management)
// ────────────────────────────────────────────────
window.loadStaffAccess = async function() {
  const [total, active, pending, suspended] = await Promise.all([
    _count('profiles',[['tenant_id',tenantId]]),
    _count('profiles',[['tenant_id',tenantId],['is_active',true]]),
    _count('profiles',[['tenant_id',tenantId],['status','pending_approval']]),
    _count('profiles',[['tenant_id',tenantId],['status','suspended']]),
  ]);

  // Sidebar badge
  const sb=document.getElementById('badge-pending');
  if(sb){if(pending>0){sb.textContent=pending;sb.style.display='';}else{sb.style.display='none';}}

  // Summary cards
  const acGrid=document.getElementById('access-stats');
  if(acGrid) acGrid.innerHTML=[
    {ico:'👥',cls:'b',   num:total,    lbl:'Total Accounts',   sub:'all staff'},
    {ico:'✅',cls:'g',   num:active,   lbl:'Active',            sub:'can log in'},
    {ico:'⏳',cls:'r',   num:pending,  lbl:'Pending Approval',  sub:'awaiting review'},
    {ico:'🚫',cls:'p',   num:suspended,lbl:'Suspended',         sub:'access revoked'},
  ].map(c=>`<div class="sc"><div class="sc-ico ${c.cls}">${c.ico}</div><div class="sc-num">${c.num??'—'}</div><div class="sc-lbl">${c.lbl}</div><div class="sc-sub">${c.sub}</div></div>`).join('');

  // Pending approvals table
  const approvals = await getPendingApprovals();
  const wrap  = document.getElementById('approvals-body');
  const badge = document.getElementById('approval-badge');
  if(badge){if(approvals.length){badge.textContent=approvals.length;badge.style.display='';}else{badge.style.display='none';}}

  if(!approvals.length){
    wrap.innerHTML=`<div class="empty"><div class="empty-ico">✅</div><div class="empty-ttl">All clear — no pending approvals</div></div>`;
    return;
  }
  wrap.innerHTML=`<div class="tw"><table>
    <thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Applied</th><th>Actions</th></tr></thead>
    <tbody>${approvals.map(r=>`<tr id="arow-${r.id}"${r.role==='dept_admin'?' style="background:#fff0f0"':''}>
      <td><strong>${_esc(r.full_name||'—')}</strong></td>
      <td>${r.role==='dept_admin'
        ?'<span class="chip" style="background:#fdecea;color:#8b1a1a;border:1px solid #f5c6c6;font-weight:700">⚠️ Dept. Admin — Full Access Requested</span>'
        :`<span class="chip g">${_roleLabel(r.role)}</span>`}</td>
      <td>${_esc(r.phone||'—')}</td>
      <td>${_relDate(r.created_at)}</td>
      <td>
        <button class="btn-approve" data-id="${r.id}">Approve</button>
        <button class="btn-reject"  data-id="${r.id}">Reject</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;

  document.querySelectorAll('.btn-approve[data-id]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const id=btn.dataset.id; btn.disabled=true;
      const{error}=await supabase.from('profiles').update({status:'active',is_active:true,approved_by:profile.id,approved_at:new Date().toISOString()}).eq('id',id).eq('tenant_id',tenantId);
      if(error){_toast(safeErrorMessage(error,'Failed to approve staff.'),true);btn.disabled=false;}
      else{document.getElementById('arow-'+id)?.remove();_toast('Staff approved.');window.loadStaffAccess();loadStats();}
    });
  });
  document.querySelectorAll('.btn-reject[data-id]').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const id=btn.dataset.id; btn.disabled=true;
      const{error}=await supabase.from('profiles').update({status:'rejected',approved_by:profile.id,approved_at:new Date().toISOString()}).eq('id',id).eq('tenant_id',tenantId);
      if(error){_toast(safeErrorMessage(error,'Failed to reject request.'),true);btn.disabled=false;}
      else{document.getElementById('arow-'+id)?.remove();_toast('Request rejected.');window.loadStaffAccess();loadStats();}
    });
  });
};

// ────────────────────────────────────────────────
// SECTION 2 — HUMAN RESOURCES
// ────────────────────────────────────────────────
const DESIGS = [
  {v:'principal',                   l:'Principal',                       cat:'Administration', lv:1, d:'Academic + administrative head of the college — overall NCISM compliance, faculty recruitment, exam liaison.'},
  {v:'vice_principal',              l:'Vice Principal',                  cat:'Administration', lv:2, d:'Deputises for the Principal; coordinates academic schedules and discipline.'},
  {v:'cmo',                         l:'Chief Medical Officer',           cat:'Administration', lv:1, d:'Senior-most clinical authority — owns treatment protocols and clinical governance hospital-wide.'},
  {v:'medical_director',            l:'Medical Director (Dean/Principal/Director)', cat:'Administration', lv:0, d:'Apex administrative + clinical head of the institution (Sch XX/1) — final authority on hospital operations.'},
  {v:'medical_superintendent',      l:'Medical Superintendent',          cat:'Administration', lv:2, d:'Runs day-to-day hospital operations — duty rosters, bed management, discipline (Sch XX/2).'},
  {v:'deputy_medical_superintendent',l:'Deputy Medical Superintendent',  cat:'Administration', lv:3, d:'Assists the Medical Superintendent; covers IPD/OPD operational oversight (Sch XX/3).'},
  {v:'administrative_officer',      l:'Administrative Officer',          cat:'Administration', lv:4, d:'Non-clinical administration — HR records, procurement paperwork, statutory filings (Sch XX/4).'},
  {v:'opd_incharge',                l:'OPD In-charge',                   cat:'Administration', lv:3, d:'Office Superintendent — coordinates OPD registration desks and daily patient flow (Sch XX/9).'},
  {v:'hod',                         l:'Head of Department (HOD)',        cat:'Faculty',        lv:1, d:'Senior-most faculty in a clinical department — teaching, patient care and NCISM compliance for that dept (Sch I).'},
  {v:'professor',                   l:'Professor',                       cat:'Faculty',        lv:2, d:'Senior teaching faculty — UG/PG teaching, OPD/IPD supervision, PG guide eligibility (Sch I).'},
  {v:'associate_professor',         l:'Associate Professor',             cat:'Faculty',        lv:3, d:'Mid-senior teaching faculty supporting the Professor/HOD in teaching and clinical duties (Sch I).'},
  {v:'assistant_professor',         l:'Assistant Professor',             cat:'Faculty',        lv:4, d:'Junior teaching faculty — UG teaching + OPD/IPD clinical duties (Sch I).'},
  {v:'senior_resident',             l:'Senior Resident',                 cat:'Faculty',        lv:5, d:'PG-qualified resident supervising junior residents/interns and running OPD/IPD care (Sch I, PG depts only).'},
  {v:'junior_resident',             l:'Junior Resident',                 cat:'Faculty',        lv:6, d:'House Officer / Clinical Registrar — first point of clinical contact under faculty supervision (Sch XX/41).'},
  {v:'medical_officer',             l:'Medical Officer',                 cat:'Clinical',       lv:5, d:'BAMS-qualified doctor providing direct patient care across OPD/IPD.'},
  {v:'resident_medical_officer',    l:'Resident Medical Officer (RMO)',  cat:'Clinical',       lv:6, d:'24×7 in-house duty doctor — first responder for IPD emergencies (Sch XX/6).'},
  {v:'emergency_medical_officer',   l:'Emergency Medical Officer (EMO)', cat:'Clinical',       lv:6, d:'Staffs the Emergency/Casualty desk round the clock (Sch XX/6, XX/34).'},
  {v:'general_duty_medical_officer',l:'General Duty Medical Officer (GDMO)',cat:'Clinical',    lv:7, d:'Ward-duty doctor for Medical/Surgical IPD rounds (Sch XX/34, XX/37).'},
  {v:'pg_scholar',                  l:'PG Scholar',                      cat:'Academic',       lv:7, d:'Postgraduate student under a recognised PG guide — thesis + clinical training rotation.'},
  {v:'intern',                      l:'Intern',                          cat:'Academic',       lv:8, d:'Compulsory rotatory internship — supervised patient care across all clinical departments.'},
  {v:'nursing_superintendent',      l:'Nursing Superintendent',          cat:'Nursing',        lv:1, d:'Matron — heads the entire nursing service, duty rosters, nursing standards (Sch XX/7).'},
  {v:'deputy_nursing_superintendent',l:'Deputy Nursing Superintendent',  cat:'Nursing',        lv:2, d:'Assistant Matron — supports the Nursing Superintendent across shifts/wards (Sch XX/8).'},
  {v:'ward_sister',                 l:'Ward Sister / Sr. Staff Nurse',   cat:'Nursing',        lv:3, d:'Senior nurse in charge of a ward/shift — supervises staff nurses and patient care.'},
  {v:'staff_nurse',                 l:'Staff Nurse',                     cat:'Nursing',        lv:4, d:'Bedside nursing care across OPD/IPD/PK/OT/Labour Room (Sch XX/20 and others).'},
  {v:'nursing_intern',              l:'Nursing Intern',                  cat:'Nursing',        lv:5, d:'Nursing student under supervised clinical rotation.'},
  {v:'chief_pharmacist',            l:'Chief Pharmacist',                cat:'Pharmacy',       lv:1, d:'Dispensary In-charge — owns stock, dispensing accuracy and pharmacy compliance (Sch XX/23).'},
  {v:'pharmacist',                  l:'Pharmacist',                      cat:'Pharmacy',       lv:2, d:'Ayurveda-qualified pharmacist dispensing prescriptions (Sch XX/22).'},
  {v:'pharmacy_assistant',          l:'Pharmacy Assistant',              cat:'Pharmacy',       lv:3, d:'Assists the pharmacist with stock handling, billing and dispensing.'},
  {v:'pk_incharge',                 l:'Panchakarma In-charge',           cat:'Therapy',        lv:1, d:'Heads the Panchakarma therapy section — protocol adherence and therapist rostering (Sch XX/40).'},
  {v:'panchakarma_cook',            l:'Panchakarma Preparation-Room Cook', cat:'Therapy',      lv:4, d:'Prepares medicated oils, ghees and decoctions used in Panchakarma therapy (Sch XX/39, optional) — distinct from the Pathya-Diet kitchen.'},
  {v:'senior_therapist',            l:'Senior Therapist',                cat:'Therapy',        lv:2, d:'Experienced therapist leading complex Panchakarma/Kriyakalpa procedures (Sch XX/40, XX/48).'},
  {v:'therapist',                   l:'Therapist',                       cat:'Therapy',        lv:3, d:'Delivers Panchakarma, Kriyakalpa or Physiotherapy procedures under supervision (Sch XX/40, 48, 49).'},
  {v:'therapy_assistant',           l:'Therapy Assistant / Attender',    cat:'Therapy',        lv:4, d:'Supports therapists with procedure setup, patient positioning and cleanup.'},
  {v:'receptionist',                l:'Receptionist',                    cat:'Admin Staff',    lv:1, d:'Front-desk registration and telephone enquiries (Sch XX/16).'},
  {v:'registration_clerk',          l:'Registration Clerk',              cat:'Admin Staff',    lv:2, d:'Patient registration and record entry at the OPD desk (Sch XX/17).'},
  {v:'billing_clerk',               l:'Billing Clerk',                   cat:'Admin Staff',    lv:2, d:'Generates and collects OPD/IPD/pharmacy bills (Sch XX/17).'},
  {v:'medical_record_officer',      l:'Medical Record Officer',          cat:'Admin Staff',    lv:2, d:'Owns the Medical Records Department — filing, retrieval, MLC register upkeep (Sch XX/18).'},
  {v:'medical_record_technician',   l:'Medical Record Technician',       cat:'Admin Staff',    lv:3, d:'Maintains and retrieves patient case records (Sch XX/18).'},
  {v:'public_relations_officer',    l:'Public Relations Officer',        cat:'Admin Staff',    lv:3, d:'Handles patient grievances, feedback and external communications.'},
  {v:'accountant',                  l:'Accountant',                      cat:'Admin Staff',    lv:2, d:'Books, reconciles and reports hospital finances — billing, payroll, insurance claims (Sch XX/10, XX/11).'},
  {v:'lab_incharge',                l:'Lab In-charge',                   cat:'Diagnostics',    lv:1, d:'Heads the pathology lab — quality control, staffing, report sign-off.'},
  {v:'roganidana_pg',               l:'PG Roganidana (Report Signatory)', cat:'Diagnostics',   lv:1, d:'PG-qualified Roganidana faculty who signs off Ayurvedic diagnostic interpretations.'},
  {v:'pathologist',                 l:'Pathologist (Part-time)',          cat:'Diagnostics',    lv:1, d:'Part-time specialist validating pathology reports.'},
  {v:'radiologist',                 l:'Radiologist (Part-time)',          cat:'Diagnostics',    lv:1, d:'Part-time specialist reporting X-ray/USG/imaging studies.'},
  {v:'sonologist',                  l:'Sonologist (Part-time)',           cat:'Diagnostics',    lv:1, d:'Part-time specialist performing/reporting ultrasound studies (PCPNDT registered).'},
  {v:'microbiologist',              l:'Microbiologist (Part-time)',       cat:'Diagnostics',    lv:1, d:'Part-time specialist overseeing culture/sensitivity and infection-control testing (Sch XX/30).'},
  {v:'lab_technician',              l:'Lab Technician',                   cat:'Diagnostics',    lv:2, d:'DMLT-qualified — sample collection, processing and routine test performance (Sch XX/24).'},
  {v:'radiographer',                l:'Radiographer / X-ray Technician',  cat:'Diagnostics',    lv:2, d:'Operates X-ray/imaging equipment and AERB safety logs (Sch XX/26).'},
  {v:'lab_attendant',               l:'Lab Attendant',                    cat:'Diagnostics',    lv:3, d:'Assists lab technicians — specimen handling and housekeeping of the lab (Sch XX/25).'},
  {v:'dark_room_assistant',         l:'Dark Room Assistant',              cat:'Diagnostics',    lv:3, d:'Develops X-ray film in the dark room — only needed if using non-digital X-ray equipment (Sch XX/27, optional).'},
  {v:'ot_technician',               l:'OT Technician / Surgical Tech',   cat:'Clinical',       lv:7, d:'Assists surgeons — instrument prep, sterile technique, OT equipment upkeep (Sch XX/43).'},
  {v:'ophthalmic_technician',       l:'Ophthalmic Technician',           cat:'Clinical',       lv:7, d:'Assists Shalakya-Netra faculty with eye examinations and minor procedures.'},
  {v:'ent_technician',              l:'ENT Technician / Audiologist',    cat:'Clinical',       lv:7, d:'Assists Shalakya-KNM faculty with ENT examinations, audiometry and minor procedures.'},
  {v:'anm',                         l:'Auxiliary Nurse Midwife (ANM)',    cat:'Nursing',        lv:4, d:'Assists nursing staff in wards and the Labour Room, ayah-level duties (Sch XX/33, XX/36).'},
  {v:'yoga_instructor',             l:'Yoga Instructor',                 cat:'Wellness',       lv:2, d:'Conducts yoga therapy sessions under the Swasthavritta department (Sch XX/51).'},
  {v:'dietitian',                   l:'Dietitian / Nutritionist',        cat:'Wellness',       lv:2, d:'Plans Pathya-Apathya diet charts for OPD/IPD patients (Sch XX/52).'},
  {v:'wellness_counsellor',         l:'Wellness Counsellor',             cat:'Wellness',       lv:3, d:'Provides lifestyle and preventive-health counselling under Swasthavritta.'},
  {v:'clinical_psychologist',       l:'Clinical Psychologist / Counsellor', cat:'Wellness',    lv:2, d:'Provides psychological assessment and counselling support (Manasaroga referrals).'},
  {v:'cssd_incharge',               l:'CSSD In-charge / Sterilisation Supervisor', cat:'Clinical',   lv:6, d:'Owns central sterilisation protocols and instrument-tracking logs (Sch XX/CS1).'},
  {v:'cssd_technician',             l:'CSSD Technician / Sterilisation Tech',     cat:'Clinical',    lv:7, d:'Operates autoclaves and sterilisation equipment; also covers Anushastra Karma technician duties (Sch XX/45, CS1).'},
  {v:'maintenance_engineer',        l:'Maintenance Engineer',            cat:'Support',        lv:1, d:'Maintains biomedical equipment, electrical and civil infrastructure.'},
  {v:'maintenance_supervisor',      l:'Maintenance Supervisor',          cat:'Support',        lv:2, d:'Supervises day-to-day maintenance staff and complaint resolution.'},
  {v:'bmw_officer',                 l:'Biomedical Waste Officer',        cat:'Support',        lv:1, d:'Owns BMW segregation, CBWTF pickup logs and SPCB compliance reporting.'},
  {v:'palha_diet_incharge',         l:'Palha-diet In-charge',            cat:'Wellness',       lv:1, d:'Heads the Pathya-Diet kitchen — Ayurvedic diet planning and indent fulfilment (Sch XX/52).'},
  {v:'diet_cook',                   l:'Ayurvedic Diet Cook',             cat:'Wellness',       lv:3, d:'Prepares Pathya-Apathya meals per the diet chart (Sch XX/53).'},
  {v:'security_supervisor',         l:'Security Supervisor',             cat:'Support',        lv:1, d:'Oversees hospital security staff, access control and incident logs.'},
  {v:'security_guard',              l:'Security Guard',                  cat:'Support',        lv:2, d:'Staffs entry points and wards for round-the-clock physical security.'},
  {v:'sanitation_supervisor',       l:'Sanitation Supervisor',           cat:'Support',        lv:1, d:'Oversees housekeeping staff and hospital cleanliness/infection-control rounds.'},
  {v:'sanitation_worker',           l:'Sanitation Worker',               cat:'Support',        lv:2, d:'Performs ward, OPD and common-area housekeeping.'},
  {v:'laundry_supervisor',          l:'Laundry Supervisor',              cat:'Support',        lv:1, d:'Oversees linen collection, washing cycles and BMW-compliant handling of soiled linen.'},
  {v:'laundry_worker',              l:'Laundry Worker',                  cat:'Support',        lv:2, d:'Washes, dries and distributes hospital linen across wards and OT.'},
  {v:'driver',                      l:'Driver / Ambulance Driver',       cat:'Support',        lv:2, d:'Drives the ambulance/hospital vehicles, on-call for patient transport.'},
  {v:'attender',                    l:'Attender / Helper',               cat:'Support',        lv:3, d:'General ward/OT/admin helper duties — patient shifting, errands (Sch XX/12, 33, 36, 44).'},
];
const DESIG_MAP = Object.fromEntries(DESIGS.map(d=>[d.v,d]));
const DESIG_CATS = [...new Set(DESIGS.map(d=>d.cat))];

// Sensible default HMS role per designation, used only to pre-select the Invite
// modal's role dropdown (admin can still override it). Roles drive page access
// (ROLE_HOME) — designation is the free-text title shown in the ladder/HR views.
// medical_record_officer/technician -> mrd_staff (dedicated role+page already exist);
// ot_technician/cssd_* -> nurse per the documented workaround (TODO_LATER.md §38,
// no dedicated OT/CSSD role built yet).
const DESIG_ROLE_DEFAULT = {
  professor:'doctor', hod:'doctor', associate_professor:'doctor', assistant_professor:'doctor',
  senior_resident:'doctor', junior_resident:'doctor', medical_director:'doctor',
  medical_superintendent:'doctor', deputy_medical_superintendent:'doctor',
  resident_medical_officer:'doctor', emergency_medical_officer:'doctor', general_duty_medical_officer:'doctor',
  administrative_officer:'dept_admin', opd_incharge:'dept_admin',
  nursing_superintendent:'nurse', deputy_nursing_superintendent:'nurse',
  staff_nurse:'nurse', ward_sister:'nurse', anm:'nurse',
  accountant:'accountant',
  receptionist:'receptionist', registration_clerk:'receptionist', billing_clerk:'receptionist',
  medical_record_officer:'mrd_staff', medical_record_technician:'mrd_staff',
  pharmacist:'pharmacist', chief_pharmacist:'pharmacist', pharmacy_assistant:'pharmacist',
  lab_technician:'lab_tech', lab_attendant:'lab_tech', radiographer:'lab_tech', microbiologist:'lab_tech',
  dark_room_assistant:'lab_tech',
  ot_technician:'nurse', cssd_technician:'nurse', cssd_incharge:'nurse',
  pk_incharge:'therapist', senior_therapist:'therapist', therapist:'therapist', yoga_instructor:'therapist',
  panchakarma_cook:'therapist',
  palha_diet_incharge:'diet_staff', dietitian:'diet_staff', diet_cook:'diet_staff',
  attender:'nurse',
};

// Medical Director is conventionally held concurrently by an existing senior faculty member
// (typically the Dean/Principal) rather than a dedicated additional recruit — Schedule XX's own
// table gives it no quantified headcount at all (blank cells across every intake tier, the only
// row besides "Consultants", which is explicitly annotated "Teachers of clinical departments").
// Medical Superintendent and Deputy MS are deliberately NOT included here even though they might
// seem similar — §51(2)(b)/(3)(b) of the regulation (see the human_resources_admin self-
// assessment checklist below) explicitly states both "shall NOT be concurrently teaching staff
// of any department", so they must remain real, separately-required additional doctor posts.
// Still tracked as an individual ladder row (so a tenant can record who holds the title and
// Invite if genuinely vacant) but excluded from every AGGREGATE minimum-headcount total —
// deptRequirement()'s required sum, the department-tree grand compliance %, the Hospital-Wide
// Total summary table, and the Statistics page's _ncismRoleMinimums() — so a Professor already
// counted in the Schedule I faculty ladder isn't double-counted as a second, separate person.
const FACULTY_CONCURRENT_POSTS = new Set(['medical_director']);

// Populate designation filter
const dfilter = document.getElementById('hr-desig-filter');
DESIG_CATS.forEach(cat=>{
  const grp=document.createElement('optgroup'); grp.label=cat;
  DESIGS.filter(d=>d.cat===cat).forEach(d=>{const o=document.createElement('option');o.value=d.v;o.textContent=d.l;grp.appendChild(o);});
  dfilter.appendChild(grp);
});

// Build designation select HTML once
const DESIG_SEL_HTML = '<option value="">— Not Set —</option>' +
  DESIG_CATS.map(cat=>`<optgroup label="${cat}">${DESIGS.filter(d=>d.cat===cat).map(d=>`<option value="${d.v}">${d.l}</option>`).join('')}</optgroup>`).join('');

window.loadHR = async function(sub='staff') {
  _hrSub(sub);
  const [{data:staff},{data:depts}] = await Promise.all([
    supabase.from('profiles').select('id,full_name,role,designation,phone,status,is_active,created_at,department_id').eq('tenant_id',tenantId).order('full_name'),
    supabase.from('departments').select('id,name').eq('tenant_id',tenantId),
  ]);
  const dm={}; (depts||[]).forEach(d=>{dm[d.id]=d.name;});
  window._staffAll=(staff||[]).map(s=>({...s,dept_name:dm[s.department_id]||'—'}));
  if(sub==='staff') renderStaffTable(window._staffAll);
  if(sub==='hierarchy') renderHierarchy(window._staffAll);
};

function _hrSub(sub){
  document.getElementById('hr-staff-panel').style.display     = sub==='staff'     ? '' : 'none';
  document.getElementById('hr-hierarchy-panel').style.display  = sub==='hierarchy' ? '' : 'none';
  document.getElementById('hr-ncism-panel').style.display      = sub==='ncism'     ? '' : 'none';
  document.getElementById('hr-plan-panel').style.display       = sub==='plan'      ? '' : 'none';
  document.getElementById('hr-access-panel').style.display     = sub==='access'    ? '' : 'none';
  document.getElementById('hr-dept-panel').style.display       = sub==='dept'      ? '' : 'none';
  document.getElementById('hr-seed-bar').style.display         = (sub==='ncism'||sub==='dept') ? 'flex' : 'none';
  if (sub === 'ncism')   _renderNcismStaffing();
  if (sub === 'plan')    _renderStaffingPlan();
  if (sub === 'access')  window.loadStaffAccess();
  if (sub === 'dept')    _renderDeptStaff();
}

// ── NCISM Schedule XX — Hospital Staff Requirements ──────────────────
// [zone, label, desig_keys[], {60,100,150,200}, ncism_ref]
const NCISM_XX_ROWS = [
  // Administration
  ['Administration','Medical Director / Principal / Dean',['medical_director'],{60:1,100:1,150:1,200:1},'Sch XX/1'],
  ['Administration','Medical Superintendent',['medical_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/2'],
  ['Administration','Deputy Medical Superintendent',['deputy_medical_superintendent'],{60:1,100:1,150:2,200:2},'Sch XX/3'],
  ['Administration','Administrator (Non-clinical)',['administrative_officer'],{60:1,100:1,150:2,200:2},'Sch XX/4'],
  ['Administration','RMO / Emergency Medical Officer (24×7)',['resident_medical_officer','emergency_medical_officer'],{60:2,100:3,150:4,200:5},'Sch XX/6'],
  ['Administration','Matron / Nursing Superintendent',['nursing_superintendent'],{60:1,100:1,150:1,200:1},'Sch XX/7'],
  ['Administration','Assistant Matron',['deputy_nursing_superintendent'],{60:2,100:3,150:4,200:5},'Sch XX/8'],
  ['Administration','Office Superintendent',['opd_incharge'],{60:1,100:1,150:1,200:1},'Sch XX/9'],
  ['Administration','Multi-tasking Support Staff',['attender'],{60:3,100:3,150:4,200:4},'Sch XX/12'],
  // Finance & Accounts (separate zone from Administration)
  ['Finance & Accounts','Finance Manager / Accounts Officer',['accountant'],{60:1,100:1,150:1,200:1},'NCISM §Admin'],
  ['Finance & Accounts','Clerks & Accounts Staff',['accountant'],{60:1,100:2,150:3,200:4},'Sch XX/10'],
  ['Finance & Accounts','Store Keeper (Main / Pharmacy Store)',['accountant'],{60:1,100:1,150:1,200:1},'Sch XX/11'],
  // Reception & MRD
  ['Reception & MRD','Receptionist cum Telephone Operator',['receptionist'],{60:3,100:4,150:4,200:4},'Sch XX/16'],
  ['Reception & MRD','Registration & Billing Clerks',['registration_clerk','billing_clerk'],{60:1,100:2,150:3,200:4},'Sch XX/17'],
  ['Reception & MRD','Medical Record Technician',['medical_record_officer','medical_record_technician'],{60:1,100:1,150:1,200:1},'Sch XX/18'],
  // OPD Nursing
  ['OPD Nursing','Nursing Staff — All OPDs',['staff_nurse','ward_sister'],{60:3,100:3,150:3,200:5},'Sch XX/20'],
  ['OPD Nursing','Aya — All OPDs',['attender','anm'],{60:3,100:3,150:3,200:5},'Sch XX/21'],
  // Pharmacy
  ['Pharmacy','Pharmacist (Ayurveda-qualified)',['pharmacist'],{60:2,100:2,150:3,200:4},'Sch XX/22'],
  ['Pharmacy','Dispensary In-charge',['chief_pharmacist'],{60:1,100:1,150:1,200:1},'Sch XX/23'],
  // Diagnostics
  ['Diagnostics','Lab Technician (DMLT)',['lab_technician'],{60:2,100:2,150:3,200:4},'Sch XX/24'],
  ['Diagnostics','Lab Attendant',['lab_attendant'],{60:1,100:1,150:2,200:3},'Sch XX/25'],
  ['Diagnostics','X-ray Technician / Radiographer',['radiographer'],{60:1,100:1,150:1,200:1},'Sch XX/26'],
  ['Diagnostics','ECG Technician',['lab_technician'],{60:1,100:1,150:2,200:2},'Sch XX/28'],
  ['Diagnostics','Nursing Staff — USG & ECG',['staff_nurse'],{60:1,100:1,150:1,200:1},'Sch XX/29'],
  ['Diagnostics','Microbiologist (MSc)',['microbiologist'],{60:1,100:1,150:1,200:1},'Sch XX/30'],
  ['Diagnostics','Lab Assistant — Microbiology',['lab_attendant'],{60:1,100:1,150:2,200:2},'Sch XX/31'],
  // Medical IPD
  ['Medical IPD','Nursing Staff (1 per 10 beds)',['staff_nurse','ward_sister'],{60:4,100:6,150:9,200:12},'Sch XX/32'],
  ['Medical IPD','Ayah (1 per 20 beds)',['attender','anm'],{60:2,100:3,150:5,200:6},'Sch XX/33'],
  ['Medical IPD','Resident Medical Officer — Medical',['emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/34'],
  // Surgical IPD
  ['Surgical IPD','Nursing Staff (1 per 10 beds)',['staff_nurse','ward_sister'],{60:3,100:4,150:6,200:8},'Sch XX/35'],
  ['Surgical IPD','Ayah (1 per 20 beds)',['attender','anm'],{60:2,100:2,150:3,200:4},'Sch XX/36'],
  ['Surgical IPD','Resident Surgical Officer',['emergency_medical_officer','general_duty_medical_officer'],{60:2,100:2,150:2,200:2},'Sch XX/37'],
  // Panchakarma
  ['Panchakarma','PK Nursing Staff',['staff_nurse'],{60:1,100:1,150:2,200:2},'Sch XX/38'],
  ['Panchakarma','PK Therapists (Male + Female equal)',['pk_incharge','senior_therapist','therapist'],{60:4,100:8,150:12,200:16},'Sch XX/40'],
  ['Panchakarma','House Officer / Clinical Registrar (BAMS)',['junior_resident'],{60:1,100:1,150:1,200:1},'Sch XX/41'],
  ['Panchakarma','Clerk cum Receptionist',['receptionist'],{60:1,100:1,150:1,200:1},'Sch XX/42'],
  // Operation Theatre
  ['Operation Theatre','OT Nursing Staff',['ot_technician','staff_nurse'],{60:1,100:2,150:3,200:4},'Sch XX/43'],
  ['Operation Theatre','OT Attendants',['attender'],{60:2,100:3,150:4,200:5},'Sch XX/44'],
  ['Operation Theatre','Anushastra Karma Technician',['cssd_technician'],{60:1,100:1,150:2,200:2},'Sch XX/45'],
  // Labour Room
  ['Labour Room','Nursing Staff — Labour Room (3 shifts)',['staff_nurse','ward_sister'],{60:3,100:3,150:6,200:6},'Sch XX/46'],
  ['Labour Room','Aya (1 per shift)',['attender','anm'],{60:3,100:3,150:3,200:3},'Sch XX/47'],
  // Therapy
  ['Kriyakalpa','Kriyakalpa Therapists',['therapist','senior_therapist'],{60:2,100:2,150:4,200:4},'Sch XX/48'],
  ['Physiotherapy','Physiotherapist',['therapist'],{60:1,100:1,150:1,200:1},'Sch XX/49'],
  ['Physiotherapy','Attendant / Aya',['attender'],{60:1,100:1,150:1,200:1},'Sch XX/50'],
  // Yoga & Wellness
  ['Yoga & Wellness','Yoga Demonstrator',['yoga_instructor'],{60:1,100:1,150:1,200:1},'Sch XX/51'],
  // Diet / Pathya
  ['Diet / Pathya','Diet In-charge (BAMS / MSc Dietetics)',['palha_diet_incharge','dietitian'],{60:1,100:1,150:1,200:1},'Sch XX/52'],
  ['Diet / Pathya','Pathya Cooks',['diet_cook'],{60:2,100:2,150:3,200:4},'Sch XX/53'],
  ['Diet / Pathya','Multi-tasking Staff',['attender'],{60:2,100:2,150:3,200:4},'Sch XX/54'],
  // CSSD (Central Sterilization — source document's own serial numbers repeat 52/53
  // from the Diet section above; kept as CS1/CS2 here to avoid a duplicate ref key)
  ['CSSD','CSSD / Sterilisation Staff',['cssd_incharge','cssd_technician'],{60:1,100:1,150:1,200:1},'Sch XX/CS1'],
  ['CSSD','CSSD / Sterilisation Aya',['attender','anm'],{60:1,100:1,150:1,200:1},'Sch XX/CS2'],
  // Screening OPD (Session 94 — Screening OPD didn't have a departments row at all until
  // now; citation already existed in this file's self-assessment checklist, see 'screening_opd')
  ['Screening OPD','Screening OPD Nursing Staff',['staff_nurse'],{60:1,100:1,150:1,200:1},'Sch XVI §40(m)'],
];

// Optional Schedule XX rows — real per the source table, but conditional (dark room
// assistant only applies to non-digital X-ray, which nothing in the schema tracks) or
// newly-added designations (Panchakarma prep-room cook). Never counted toward the
// mandatory ladder, required total or compliance % — shown as an "add if needed" note
// with its own Invite button so a tenant that genuinely needs one isn't blocked.
const NCISM_XX_OPTIONAL_ROWS = [
  ['Diagnostics','Dark Room Assistant (non-digital X-ray only)',['dark_room_assistant'],{60:1,100:1,150:1,200:1},'Sch XX/27'],
  ['Panchakarma','Cook — Preparation Room',['panchakarma_cook'],{60:1,100:1,150:2,200:2},'Sch XX/39'],
];

// Summary groups — each desig key appears in EXACTLY ONE group to avoid double-counting
const NCISM_SUM_GRPS = [
  {s:'Faculty (Schedule I)',rows:[
    {l:'Professor / HOD',                             k:['professor','hod'],                                                                    fac:'p'},
    {l:'Associate Professor',                         k:['associate_professor'],                                                                fac:'a'},
    {l:'Assistant Professor',                         k:['assistant_professor'],                                                                fac:'b'},
    {l:'Senior Resident (PG scholars only)',          k:['senior_resident'],                                                                    pgOnly:true},
  ]},
  {s:'Clinical — Doctors & Management',rows:[
    {l:'Medical Director / Principal / Dean',         k:['medical_director']},
    {l:'Medical Superintendent',                      k:['medical_superintendent']},
    {l:'Deputy Medical Superintendent',               k:['deputy_medical_superintendent']},
    {l:'Administrator (Non-clinical)',                k:['administrative_officer']},
    {l:'RMO / EMO / Resident MO (Admin + IPD × 3)',  k:['resident_medical_officer','emergency_medical_officer','general_duty_medical_officer']},
    {l:'House Officer / Clinical Registrar (BAMS)',   k:['junior_resident']},
  ]},
  {s:'Nursing',rows:[
    {l:'Matron / Nursing Superintendent',             k:['nursing_superintendent']},
    {l:'Assistant Matron',                            k:['deputy_nursing_superintendent']},
    {l:'Staff Nurse — all zones (OPD+IPD+PK+OT+LR)', k:['staff_nurse','ward_sister']},
    {l:'Ayah / Attendant — all zones (IPD+Admin+OT)', k:['attender','anm']},
  ]},
  {s:'Pharmacy',rows:[
    {l:'Pharmacist',                                  k:['pharmacist','pharmacy_assistant']},
    {l:'Dispensary In-charge',                        k:['chief_pharmacist']},
  ]},
  {s:'Diagnostics',rows:[
    {l:'Lab Technician',                              k:['lab_technician']},
    {l:'Lab Attendant',                               k:['lab_attendant']},
    {l:'X-ray Technician / Radiographer',             k:['radiographer']},
    {l:'Microbiologist',                              k:['microbiologist']},
  ]},
  {s:'Reception & MRD',rows:[
    {l:'Receptionist',                                k:['receptionist']},
    {l:'Registration & Billing Clerks',               k:['registration_clerk','billing_clerk']},
    {l:'Medical Record Technician',                   k:['medical_record_officer','medical_record_technician']},
    {l:'Office Superintendent',                       k:['opd_incharge']},
  ]},
  {s:'Finance & Accounts',rows:[
    {l:'Finance Mgr + Accountants + Store Keeper',    k:['accountant']},
  ]},
  {s:'OT / CSSD',rows:[
    {l:'OT Nurse / CSSD / Anushastra Technician',    k:['ot_technician','cssd_incharge','cssd_technician']},
  ]},
  {s:'Therapy & Wellness',rows:[
    {l:'PK / Kriyakalpa / Physiotherapy Therapist',  k:['pk_incharge','senior_therapist','therapist']},
    {l:'Yoga Demonstrator',                           k:['yoga_instructor']},
    {l:'Diet In-charge',                              k:['palha_diet_incharge','dietitian']},
    {l:'Pathya Cook',                                 k:['diet_cook']},
  ]},
];

// ── HR Org Tree — shared department hierarchy for NCISM Requirements + Dept. Staff ──
// 12 top-level sections in Dr. Venkatesh's fixed order. `key` resolves to a department row
// via department.category (synthetic zones) or department.ncism_code (real NCISM depts).
const ORG_TREE_DEF = [
  {key:'ADMIN',              label:'Administration',   icon:'🏛️'},
  {key:'FINANCE',            label:'Finance & Accounts',icon:'💰'},
  {key:'OPD_PARENT',         label:'OPD',               icon:'🚪'},
  {key:'IPD_PARENT',         label:'IPD',               icon:'🛏️'},
  {key:'PK',                 label:'Panchakarma',       icon:'🌿'},
  {key:'LABOUR_ROOM',        label:'Labour Room',       icon:'🤱'},
  {key:'KRIYAKALPA',         label:'Kriyakalpa',        icon:'👁️'},
  {key:'SW',                 label:'Yoga & Wellness',   icon:'🧘'},
  {key:'DIET_PATHYA',        label:'Diet / Pathya',     icon:'🍲'},
  {key:'PHYSIOTHERAPY',      label:'Physiotherapy',     icon:'🦵'},
  {key:'DIAGNOSTICS',        label:'Diagnostics',       icon:'🔬'},
  {key:'PHARMACY',           label:'Pharmacy',          icon:'💊'},
  {key:'HOUSEKEEPING',       label:'House Keeping',     icon:'🧹'},
  {key:'LAUNDRY',            label:'Laundry',           icon:'👕'},
  {key:'SECURITY',           label:'Security',          icon:'🛡️'},
];
// Keys that are already real NCISM department rows (matched by ncism_code) — never created by the seeder
const ORG_EXISTING_NCISM = {PK:1, SW:1};
// New child department rows the seeder creates, nested one level under a top-level key.
// Labour Room/Kriyakalpa/Diet-Pathya are deliberately top-level (ORG_TREE_DEF above), not
// nested under Panchakarma/Yoga — kept separate per Dr. Venkatesh's spec.
const ORG_CHILD_DEFS = [
  {key:'OT', label:'Operation Theatre (Major + Minor + CSSD)', parent:'IPD_PARENT'},
];
// Existing clinical/OPD department ncism_codes to nest under the new OPD umbrella.
// Panchakarma + Swasthavritta-Yoga are excluded — they stay top-level per Dr. Venkatesh's spec.
// Real short-form codes (js/config/ncism.js NCISM_DEPTS) — these are what the seeding RPCs
// actually write to departments.ncism_code, not the long-form names used elsewhere historically.
// Session 96: 'RNV' (Rog Nidana & Vikruti Vigyana) removed per Dr. Venkatesh — it has no real
// HMS operational footprint of its own (no OPD, no ward), same "this is HMS, not CMS" call
// already applied to the 5 pre-clinical teaching departments; it was also never one of the
// real 10 Schedule XVIII OPDs (see js/config/ncism.js NCISM_OPDS), so it doesn't belong nested
// under "OPD" as an 11th sub-section either. Dropping it from this list also drops it out of
// SCHEDULE_I_CODES below, which is correct — no Schedule I faculty tracking for it in HMS.
const OPD_CHILD_NCISM_CODES = ['KAY','SHAL','SHAK','KAU','PST','AGD'];
// Screening OPD nests under OPD like the above, but is NOT one of NCISM_DEPTS' 14 academic
// departments — it has no Schedule I faculty cadre, so it's kept out of OPD_CHILD_NCISM_CODES
// (whose other job is deriving SCHEDULE_I_CODES below) and re-parented separately.
const OPD_SCREENING_CODE = 'SCREEN';

// ncism_code takes priority — it's the specific identifier for real NCISM depts (e.g. Panchakarma,
// Swasthavritta-Yoga) and some pre-existing rows carry an unrelated legacy `category` value (e.g.
// "clinical" from the Infrastructure Setup feature) that would otherwise shadow the real match.
function _deptKey(d){ return (d && (d.ncism_code || d.category)) || null; }

// Session 96: the "OPD" section's children are built from the real `opds` table (OPD Setup,
// opd-admin.html) rather than `departments.parent_department_id` — so it always reflects
// whatever OPDs are actually configured (a newly-added OPD shows up here with no code change),
// and so Shalakya shows as its real 2-way split (Shalakya – Netra / SHNT, Shalakya – Karna Nasa
// Mukha / SHAK) instead of one merged department row. Only 'SHNT' needs remapping to its owning
// department's code ('SHAK', the combined Shalakya Tantra department, per Table-8/Note 2 — one
// combined faculty pool, ~50% each speciality) — every other OPD code already equals its owning
// department's ncism_code. Panchakarma OPD and Swasthavritta OPD are 2 of the real 10 Schedule
// XVIII OPDs, so they naturally show up here too (previously only injected on this one tab) —
// deptRequirement()'s existing _facultyOnlyView flag (see below) already knows to show only
// their Schedule I ladder here, since their Schedule XX operational ladder shows separately
// under their own real top-level section.
function _buildOpdChildren(opds, byKey){
  const order = NCISM_OPDS.map(o=>o.ncism_code);
  const sorted = [...(opds||[])].sort((a,b)=>{
    const ia=order.indexOf(a.ncism_code), ib=order.indexOf(b.ncism_code);
    if(ia===-1 && ib===-1) return (a.name||'').localeCompare(b.name||'');
    if(ia===-1) return 1;
    if(ib===-1) return -1;
    return ia-ib;
  });
  const shak = sorted.find(o=>o.ncism_code==='SHAK'), shnt = sorted.find(o=>o.ncism_code==='SHNT');
  return sorted.map(opd=>{
    const deptCode = opd.ncism_code==='SHNT' ? 'SHAK' : opd.ncism_code;
    const owner = deptCode ? byKey[deptCode] : null;
    if(!owner) return {id:opd.id, name:opd.name, ncism_code:opd.ncism_code||null};
    return {...owner, name:opd.name, ncism_code:opd.ncism_code,
      _facultyOnlyView: deptCode==='PK' || deptCode==='SW',
      _sharedWith: deptCode==='SHAK' ? (opd.ncism_code==='SHAK' ? shnt?.name : shak?.name) : null};
  });
}

// Builds the 12-section tree from a flat departments list + the tenant's real OPDs.
// Sections not yet seeded come back with dept:null so callers can render a "seed structure"
// prompt. deptRequirement() reads a child's _facultyOnlyView tag (set by _buildOpdChildren
// above) to show only its Schedule I faculty ladder under "OPD" for Panchakarma/Swasthavritta,
// since their own top-level section (real, untagged object) already shows Schedule XX
// operational staff — never both in the same place.
function buildDeptTree(depts, opds){
  const byKey = {};
  (depts||[]).forEach(d=>{ const k=_deptKey(d); if(k && !byKey[k]) byKey[k]=d; });
  return ORG_TREE_DEF.map(def=>{
    const dept = byKey[def.key] || null;
    if(def.key==='OPD_PARENT'){
      return {def, dept, children: dept ? _buildOpdChildren(opds, byKey) : []};
    }
    const children = dept
      ? (depts||[]).filter(d=>d.parent_department_id===dept.id).sort((a,b)=>(a.name||'').localeCompare(b.name||''))
      : [];
    return {def, dept, children};
  });
}

// Dedupes rows by id before summing requirement/actual totals — needed because the OPD
// section's Shalakya children (see _buildOpdChildren) intentionally share one real department
// id (2 display cards, 1 real department/faculty pool), which would otherwise double-count in
// any aggregate loop. Display loops that render individual cards must NOT use this — both
// Shalakya cards need to render.
function _dedupById(rows){
  const seen = new Set();
  return rows.filter(d=>{ if(!d || seen.has(d.id)) return false; seen.add(d.id); return true; });
}

// Departments that carry the Schedule I faculty ladder (8-10 clinical teaching depts + optional PG depts)
const SCHEDULE_I_CODES = [...OPD_CHILD_NCISM_CODES, 'PK', 'SW'];
// Session 96: real per-department Schedule IV requirement (js/config/ncism.js SCHEDULE_IV),
// replacing the old FAC_BY_UG uniform bucket ({60:{p:1,a:1,b:2}, 100:{p:1,a:1,b:3}, ...})
// that applied ONE number to every department regardless of which one it actually was —
// found live on SDM (real teaching_hospital) showing Professor:1/Associate:1/Assistant:3 for
// every single teaching department, which doesn't match the regulation (e.g. real Agad Tantra
// at 100 intake needs only 3 total, not 5). Sums each actually-configured Schedule-I
// department's own requirement; falls back to the full SCHEDULE_I_CODES list (still per-
// department, not a flat multiply) when no real departments exist yet, e.g. before first seed.
function _scheduleIFacultyTotal(depts, ug) {
  const real = (depts||[]).filter(d => d.ncism_code && SCHEDULE_I_CODES.includes(d.ncism_code));
  const codes = real.length ? real.map(d => d.ncism_code) : SCHEDULE_I_CODES;
  const tot = {p:0, a:0, b:0};
  codes.forEach(code => {
    const req = SCHEDULE_IV[code]?.[ug];
    if (req) { tot.p += req.prof; tot.a += req.assoc; tot.b += req.asst; }
  });
  return { ...tot, count: real.length || codes.length };
}
// Maps each NCISM_XX_ROWS zone label onto the department key (category or ncism_code) it now lives under
const ORG_ZONE_MAP = {
  'Administration':'ADMIN', 'Finance & Accounts':'FINANCE', 'Reception & MRD':'ADMIN',
  'OPD Nursing':'OPD_PARENT', 'Pharmacy':'PHARMACY', 'Diagnostics':'DIAGNOSTICS',
  'Medical IPD':'IPD_PARENT', 'Surgical IPD':'IPD_PARENT', 'Panchakarma':'PK',
  'Operation Theatre':'OT', 'Labour Room':'LABOUR_ROOM', 'Kriyakalpa':'KRIYAKALPA',
  'Physiotherapy':'PHYSIOTHERAPY', 'Yoga & Wellness':'SW', 'Diet / Pathya':'DIET_PATHYA',
  'CSSD':'OT', 'Screening OPD':'SCREEN',
};
// Friendlier sub-section heading for a zone, shown inside a department's ladder table
// whenever it merges rows from more than one NCISM_XX_ROWS zone (e.g. IPD_PARENT holds
// both 'Medical IPD' and 'Surgical IPD') — falls back to the raw zone label otherwise.
const ZONE_SECTION_LABEL = {
  'Medical IPD':'Medical In-Patients Section', 'Surgical IPD':'Surgical In-Patients Section',
};

// Minimum headcount per HMS role (doctor/nurse/pharmacist/receptionist/lab_tech/therapist/...),
// summing Schedule I faculty (across all SCHEDULE_I_CODES teaching depts) + every Schedule XX
// operational row, bucketed via DESIG_ROLE_DEFAULT. This is the SAME source of truth as the
// NCISM Staffing Compliance panel's department-wise ladder (deptRequirement/NCISM_XX_ROWS/
// _scheduleIFacultyTotal) — used by the Statistics page's "NCISM Setup Compliance" checklist so its
// role-level minimums can never independently drift from the real ladder again (they
// previously did: hardcoded placeholder constants that didn't scale with UG intake at all).
function _ncismRoleMinimums(ug){
  const byRole = {};
  const add = (role, n) => { if (role) byRole[role] = (byRole[role]||0) + n; };

  const fac = _scheduleIFacultyTotal(null, ug);
  add('doctor', fac.p + fac.a + fac.b);

  NCISM_XX_ROWS.forEach(([,,keys,req]) => {
    const c = req[ug] || 0;
    if (c && !FACULTY_CONCURRENT_POSTS.has(keys[0])) add(DESIG_ROLE_DEFAULT[keys[0]], c);
  });

  return byRole;
}

// Required-staff ladder for a single department row. mandated=false means NCISM
// prescribes no headcount for this function (Housekeeping/Laundry/Security) — never
// fabricate a number in that case, just track actual staff.
function deptRequirement(dept, ug){
  if(!dept || !ug) return {mandated:false, ladder:[], required:0, optional:[]};
  const ladder=[];
  let mandated=false;

  // Panchakarma/Swasthavritta&Yoga are real teaching depts (Schedule I) AND real Schedule XX
  // operational zones. Shown in exactly one place each, never both: their Schedule I faculty
  // ladder appears nested under "OPD" (dept._facultyOnlyView — a synthetic clone built by
  // _buildOpdChildren from the real opds table, not a real re-parenting), while their own
  // top-level Panchakarma/Yoga & Wellness section shows only Schedule XX operational staff.
  // Every other department only ever matches one branch below regardless, so this split
  // doesn't affect them.
  const facultyOnly = !!dept._facultyOnlyView;
  const operationalOnly = !facultyOnly && (dept.ncism_code==='PK' || dept.ncism_code==='SW');

  if(!operationalOnly && dept.ncism_code && SCHEDULE_I_CODES.includes(dept.ncism_code)){
    mandated=true;
    const fac=SCHEDULE_IV[dept.ncism_code]?.[ug] || {prof:0,assoc:0,asst:0};
    const z='Teaching Faculty (Schedule I)';
    if(fac.prof) ladder.push({zone:z, label:'Professor / HOD',        count:fac.prof, ref:'Sch I', keys:['professor','hod']});
    if(fac.assoc) ladder.push({zone:z, label:'Associate Professor',     count:fac.assoc, ref:'Sch I', keys:['associate_professor']});
    if(fac.asst) ladder.push({zone:z, label:'Assistant Professor',     count:fac.asst, ref:'Sch I', keys:['assistant_professor']});
    if(dept.is_pg_dept){
      const seats=dept.pg_seats_sanctioned||3, pgBeds=seats*4;
      ladder.push({zone:z, label:'Senior Resident (PG)',            count:Math.ceil(seats/3),      ref:'PG 1 per 3 seats',  keys:['senior_resident']});
      ladder.push({zone:z, label:'Staff Nurse (+PG beds)',           count:Math.ceil(pgBeds/10),     ref:'PG 1 per 10 beds', keys:['staff_nurse','ward_sister']});
      ladder.push({zone:z, label:'Ayah / Attendant (+PG beds)',      count:Math.ceil(pgBeds/20),     ref:'PG 1 per 20 beds', keys:['attender','anm']});
      if(dept.ncism_code==='PK') ladder.push({zone:z, label:'PK Therapist (+PG)', count:Math.ceil(seats/3)*2, ref:'PG PK', keys:['pk_incharge','senior_therapist','therapist']});
      if(seats>3) ladder.push({zone:z, label:'Assistant Professor (+PG)',  count:Math.ceil((seats-3)/3), ref:'PG', keys:['assistant_professor']});
      if(seats>6) ladder.push({zone:z, label:'Associate Professor (+PG)',  count:Math.ceil((seats-6)/3), ref:'PG', keys:['associate_professor']});
    }
  }

  const key=_deptKey(dept);
  if(!facultyOnly){
    const rows=NCISM_XX_ROWS.filter(r=>ORG_ZONE_MAP[r[0]]===key);
    if(rows.length){
      mandated=true;
      rows.forEach(([zone,label,keys,req,ref])=>{
        const c=req[ug]||0;
        if(c){ ladder.push({zone,label,count:c,ref,keys,facultyHeld:FACULTY_CONCURRENT_POSTS.has(keys[0])}); }
      });
    }
  }

  const optional=facultyOnly ? [] : NCISM_XX_OPTIONAL_ROWS.filter(r=>ORG_ZONE_MAP[r[0]]===key)
    .map(([,label,keys,req,ref])=>({label,count:req[ug]||0,ref,keys}));

  if(!mandated) return {mandated:false, ladder:[], required:0, optional};
  // facultyHeld rows (Medical Director/MS/Deputy MS) still appear in the ladder for per-position
  // tracking/Invite, but never contribute to the aggregate required total — see FACULTY_CONCURRENT_POSTS.
  return {mandated:true, ladder, required:ladder.reduce((s,r)=>s+(r.facultyHeld?0:r.count),0), optional};
}

// Required/actual/gap rollup for a top-level section — sums the section's own row + all its children
function sectionRollup(node, ug, staffByDept){
  const rows=_dedupById([node.dept, ...node.children].filter(Boolean));
  let required=0, actual=0, mandated=false;
  rows.forEach(d=>{
    const r=deptRequirement(d,ug);
    if(r.mandated){ mandated=true; required+=r.required; }
    actual += (staffByDept[d.id]||[]).length;
  });
  return {required, actual, mandated, gap:Math.max(0,required-actual)};
}

window.seedHrOrgStructure = async function(){
  if(!confirm('This creates the missing HR department rows (Administration, Finance, OPD, IPD, Labour Room, Kriyakalpa, Diet / Pathya, Physiotherapy, Diagnostics, Pharmacy, House Keeping, Laundry, Security) and re-parents existing OPD departments under the new "OPD" umbrella + Operation Theatre under "IPD". Safe to run more than once. Continue?')) return;

  const {data:rawDepts, error:fetchErr} = await supabase.from('departments')
    .select('id,name,ncism_code,category,parent_department_id').eq('tenant_id',tenantId);
  if(fetchErr){ _toast('Could not load departments: '+fetchErr.message,true); return; }
  const existing = rawDepts||[];
  const byKey = {}; existing.forEach(d=>{ const k=_deptKey(d); if(k) byKey[k]=d; });

  // 1) Top-level rows that don't exist yet (Panchakarma/Yoga & Wellness already exist as real NCISM depts)
  const topToCreate = ORG_TREE_DEF.filter(def=>!byKey[def.key] && !ORG_EXISTING_NCISM[def.key]);
  if(topToCreate.length){
    const rows = topToCreate.map(def=>({tenant_id:tenantId, name:def.label, category:def.key, is_active:true}));
    const {data:inserted, error} = await supabase.from('departments').insert(rows)
      .select('id,name,ncism_code,category,parent_department_id');
    if(error){ _toast(safeErrorMessage(error,'Seed failed.'),true); return; }
    (inserted||[]).forEach(d=>{ byKey[d.category]=d; existing.push(d); });
  }

  // 2) Child rows, now that their parents exist
  const childToCreate = ORG_CHILD_DEFS.filter(def=>!byKey[def.key]);
  if(childToCreate.length){
    const rows = childToCreate.map(def=>({
      tenant_id:tenantId, name:def.label, category:def.key,
      parent_department_id: byKey[def.parent]?.id || null, is_active:true,
    }));
    const {data:inserted, error} = await supabase.from('departments').insert(rows)
      .select('id,name,ncism_code,category,parent_department_id');
    if(error){ _toast(safeErrorMessage(error,'Seed failed.'),true); return; }
    (inserted||[]).forEach(d=>{ byKey[d.category]=d; existing.push(d); });
  }

  // 2b) Re-parent any child rows that already existed with the wrong parent (e.g. created
  // before their real parent could be resolved — self-heals on re-run rather than staying orphaned)
  for(const def of ORG_CHILD_DEFS){
    const child=byKey[def.key], parent=byKey[def.parent];
    if(child && parent && child.parent_department_id!==parent.id){
      await supabase.from('departments').update({parent_department_id:parent.id}).eq('id',child.id);
      child.parent_department_id=parent.id;
    }
  }

  // 3) Re-parent existing OPD-clinical departments under the new OPD umbrella
  const opdParent = byKey['OPD_PARENT'];
  if(opdParent){
    const nestCodes = [...OPD_CHILD_NCISM_CODES, OPD_SCREENING_CODE];
    const toReparent = existing.filter(d=>d.ncism_code && nestCodes.includes(d.ncism_code) && !d.parent_department_id);
    for(const d of toReparent){
      await supabase.from('departments').update({parent_department_id:opdParent.id}).eq('id',d.id);
    }
  }

  _toast('HR org structure seeded.');
  if(document.getElementById('hr-ncism-panel').style.display!=='none') _renderNcismStaffing();
  if(document.getElementById('hr-dept-panel').style.display!=='none') _renderDeptStaff();
};

// Ladder rows are re-registered on every _renderNcismStaffing() call so the
// Invite button's data-onclick index always resolves against the latest render
// (whole-row objects can't safely round-trip through a data-* attribute).
let _ladderRowRegistry = [];

async function _renderNcismStaffing() {
  const wrap = document.getElementById('ncism-staff-table-wrap');
  wrap.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';
  _ladderRowRegistry = [];

  const [{ data:tRow }, { data:rawStaff }, { data:depts }, { data:pgDepts }, { data:invites }, { data:opds }] = await Promise.all([
    supabase.from('tenants').select('ug_intake,type,pg_student_strength').eq('id',tenantId).single(),
    supabase.from('profiles').select('designation,department_id').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('departments').select('id,name,ncism_code,category,parent_department_id,is_pg_dept,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('departments').select('id,name,ncism_code,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_pg_dept',true),
    supabase.from('position_invites').select('id,department_id,designation,phone,candidate_name,token').eq('tenant_id',tenantId).eq('status','pending'),
    supabase.from('opds').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true),
  ]);

  // Pending invites grouped by "deptId|designation" for the ladder's per-row chip
  const invitesByRow = {};
  (invites||[]).forEach(inv => {
    const k = (inv.department_id||'__none__')+'|'+inv.designation;
    (invitesByRow[k] = invitesByRow[k]||[]).push(inv);
  });

  // Schedule I faculty ladder is a teaching-institution obligation — it never applies to a
  // pk_center/hospital, regardless of whether ug_intake happens to be set on the tenant row
  // (found live on Srishti Ayurveda: a real pk_center with ug_intake=60 left over from early
  // testing, which was rendering this whole panel incorrectly before this gate was added).
  if (!isNCISMType(tRow?.type)) {
    wrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">NCISM Staffing Compliance only applies to Teaching Hospital / College tenants — this organisation is registered as "'+_esc(tRow?.type||'unknown')+'".</div></div>';
    return;
  }
  const ugRaw = tRow?.ug_intake || 0;
  const ug = [60,100,150,200].includes(ugRaw) ? ugRaw : (ugRaw>=150?150:ugRaw>=100?100:ugRaw>0?60:0);
  if (!ug) {
    wrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">NCISM staffing requirements apply to Teaching Hospitals and Colleges with UG intake configured.</div></div>';
    return;
  }

  const byDesig = {};
  (rawStaff||[]).forEach(s => { if(s.designation) byDesig[s.designation]=(byDesig[s.designation]||0)+1; });
  const cntD = keys => keys.reduce((s,k)=>s+(byDesig[k]||0),0);
  const pgList = pgDepts || [];

  // Per-department staff pool, for the new department-wise ladder view below
  const byDept={};
  (rawStaff||[]).forEach(s=>{ if(!s.department_id) return; (byDept[s.department_id]=byDept[s.department_id]||[]).push(s); });
  const cntDeptD=(deptId,keys)=>(byDept[deptId]||[]).filter(s=>(keys||[]).includes(s.designation)).length;

  // Faculty (Schedule I) — clinDepts = however many Schedule-I teaching depts are actually configured
  const facTotal=_scheduleIFacultyTotal(depts, ug);
  const clinDepts=facTotal.count;
  const FAC_UG={p:facTotal.p, a:facTotal.a, b:facTotal.b};
  const facReq=FAC_UG.p+FAC_UG.a+FAC_UG.b;
  const facAct=cntD(['professor','hod','associate_professor','assistant_professor']);
  const facGap=Math.max(0,facReq-facAct);

  // PG additions per desig key
  const keyTotPG={};
  pgList.forEach(d=>{
    const seats=d.pg_seats_sanctioned||3, pgB=seats*4;
    keyTotPG['senior_resident']=(keyTotPG['senior_resident']||0)+Math.ceil(seats/3);
    keyTotPG['staff_nurse']=(keyTotPG['staff_nurse']||0)+Math.ceil(pgB/10);
    keyTotPG['attender']=(keyTotPG['attender']||0)+Math.ceil(pgB/20);
    if(d.ncism_code==='PK')keyTotPG['therapist']=(keyTotPG['therapist']||0)+Math.ceil(seats/3)*2;
    if(seats>3)keyTotPG['assistant_professor']=(keyTotPG['assistant_professor']||0)+Math.ceil((seats-3)/3);
    if(seats>6)keyTotPG['associate_professor']=(keyTotPG['associate_professor']||0)+Math.ceil((seats-6)/3);
  });

  // Zone abbreviations for “Where Required” column
  const ZA={'Administration':'Admin','Finance & Accounts':'Finance','Reception & MRD':'Reception',
    'OPD Nursing':'OPD Nsg','Pharmacy':'Pharmacy','Diagnostics':'Diagnostics',
    'Medical IPD':'Med IPD','Surgical IPD':'Surg IPD','Panchakarma':'PK',
    'Operation Theatre':'OT','Labour Room':'LR','Kriyakalpa':'Kriyakalpa',
    'Physiotherapy':'Physio','Yoga & Wellness':'Yoga','Diet / Pathya':'Diet','CSSD':'CSSD'};
  // Compute which zones each desig key appears in (for display only)
  const keyZones={};
  NCISM_XX_ROWS.forEach(([zone,,keys,req])=>{
    const r=req[ug]||0;
    if(!r)return;
    keys.forEach(k=>{if(!keyZones[k])keyZones[k]=[];const ab=ZA[zone]||zone;if(!keyZones[k].includes(ab))keyZones[k].push(ab);});
  });

  // ugReqForGroup: sum requirements for all XX rows that contain ANY key from gKeys (no double-count)
  const ugReqForGroup=gKeys=>NCISM_XX_ROWS.reduce((s,[,,keys,req])=>s+(keys.some(k=>gKeys.includes(k))?(req[ug]||0):0),0);

  // Department tree — shared with 🏥 Dept. Staff and Departments (same order, same OPD rows,
  // sourced from the real opds table — see buildDeptTree/_buildOpdChildren).
  const tree=buildDeptTree(depts||[], opds||[]);

  // Grand compliance — per-position min-capped, summed across the actual configured department
  // tree. Deduped by id — the OPD section's Shalakya children intentionally share one real
  // department id (see _buildOpdChildren) and must not be counted twice here.
  let grandReq=0, grandMet=0;
  tree.forEach(node=>{
    if(!node.dept) return;
    _dedupById([node.dept, ...node.children]).forEach(d=>{
      const r=deptRequirement(d,ug);
      if(!r.mandated) return;
      r.ladder.forEach(row=>{ if(row.facultyHeld) return; grandReq+=row.count; grandMet+=Math.min(cntDeptD(d.id,row.keys),row.count); });
    });
  });
  const grandPct=grandReq>0?Math.round(grandMet/grandReq*100):100;
  const hc=grandPct>=80?'#2d7a4f':grandPct>=50?'#c9902a':'#c0392b';

  // ── Summary table (designation-wise totals across ALL zones) ─────────
  let sumRows='';
  NCISM_SUM_GRPS.forEach(({s,rows})=>{
    sumRows+='<tr style="background:#f0faf5"><td colspan="7" style="padding:6px 14px;font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px">'+s+'</td></tr>';
    rows.forEach(({l,k,fac:fk,pgOnly})=>{
      if(k.some(key=>FACULTY_CONCURRENT_POSTS.has(key))){
        sumRows+='<tr><td style="padding:5px 12px 5px 20px;font-size:12.5px;border-bottom:1px solid #f0f4f2">'+l+'</td>'
          +'<td colspan="6" style="padding:5px 12px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">Typically held concurrently by an existing faculty member — not counted separately in totals</td></tr>';
        return;
      }
      let ugR;
      if(fk) ugR=FAC_UG[fk]||0;
      else if(pgOnly) ugR=0;
      else ugR=ugReqForGroup(k);
      const pgA=k.reduce((s,key)=>s+(keyTotPG[key]||0),0);
      const total=ugR+pgA;
      if(pgOnly&&pgList.length===0){
        sumRows+='<tr><td style="padding:5px 12px 5px 20px;font-size:12.5px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">'+l+'</td>'
          +'<td colspan="6" style="padding:5px 12px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">Not applicable — no PG departments configured</td></tr>';
        return;
      }
      const rec=cntD(k), gap=Math.max(0,total-rec);
      const rc=rec>=total&&total>0?'#2d7a4f':rec>0?'#c9902a':'#c0392b';
      const si=rec>=total&&total>0?'✅':rec>0?'⚠️':'❌';
      let zs;
      if(fk) zs='Schedule I ('+clinDepts+' clinical depts)';
      else if(pgOnly) zs='PG depts only';
      else zs=[...new Set(k.flatMap(key=>keyZones[key]||[]))].join(' + ')||'—';
      sumRows+='<tr>'
        +'<td style="padding:5px 12px 5px 20px;font-size:12.5px;border-bottom:1px solid #f0f4f2">'+l+'</td>'
        +'<td style="padding:5px 10px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">'+zs+'</td>'
        +'<td style="padding:5px 10px;text-align:center;font-weight:600;border-bottom:1px solid #f0f4f2">'+(total>0?ugR:'—')+'</td>'
        +'<td style="padding:5px 10px;text-align:center;color:#c9902a;border-bottom:1px solid #f0f4f2">'+(pgA>0?'+'+pgA:'—')+'</td>'
        +'<td style="padding:5px 10px;text-align:center;font-weight:700;border-bottom:1px solid #f0f4f2">'+(total||'—')+'</td>'
        +'<td style="padding:5px 10px;text-align:center;color:'+rc+';font-weight:700;border-bottom:1px solid #f0f4f2">'+rec+'</td>'
        +'<td style="padding:5px 10px;text-align:center;border-bottom:1px solid #f0f4f2">'+si+(gap>0?' <span style="font-size:11px;color:#c0392b">−'+gap+'</span>':'')+'</td>'
        +'</tr>';
    });
  });
  // Grand total row
  let gtUG=0,gtPG=0,gtTotal=0,gtRec=0;
  NCISM_SUM_GRPS.forEach(({rows})=>{
    rows.forEach(({k,fac:fk,pgOnly})=>{
      if(k.some(key=>FACULTY_CONCURRENT_POSTS.has(key)))return;
      const ugR=fk?FAC_UG[fk]||0:pgOnly?0:ugReqForGroup(k);
      const pgA=k.reduce((s,key)=>s+(keyTotPG[key]||0),0);
      if(pgOnly&&pgList.length===0)return;
      gtUG+=ugR; gtPG+=pgA; gtTotal+=ugR+pgA; gtRec+=cntD(k);
    });
  });
  const gtGap=Math.max(0,gtTotal-gtRec);
  const gtPct=gtTotal>0?Math.round(Math.min(gtRec,gtTotal)/gtTotal*100):100;
  const gtC=gtPct>=80?'#2d7a4f':gtPct>=50?'#c9902a':'#c0392b';
  const gtRow='<tr style="background:#1a4a2e;color:#fff">'
    +'<td style="padding:8px 12px 8px 14px;font-weight:700;font-size:13px" colspan="2">GRAND TOTAL — All NCISM-Mandated Positions</td>'
    +'<td style="padding:8px 10px;text-align:center;font-weight:700">'+gtUG+'</td>'
    +'<td style="padding:8px 10px;text-align:center;font-weight:700">'+(gtPG>0?'+'+gtPG:'—')+'</td>'
    +'<td style="padding:8px 10px;text-align:center;font-weight:700;font-size:15px">'+gtTotal+'</td>'
    +'<td style="padding:8px 10px;text-align:center;font-weight:700;font-size:15px">'+gtRec+'</td>'
    +'<td style="padding:8px 10px;text-align:center;font-weight:700"><span style="background:'+gtC+'44;color:#fff;border:1px solid '+gtC+'88;padding:2px 10px;border-radius:10px">'+gtPct+'%</span>'+(gtGap>0?' <span style="font-size:12px;color:#fca5a5">−'+gtGap+'</span>':'')+'</td>'
    +'</tr>';
  const sumTH='<th style="padding:7px 10px;text-align:center;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">';
  const sumTableHtml='<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">'
    +'<thead><tr style="background:#f5faf7">'
    +'<th style="padding:7px 12px 7px 20px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Staff Designation</th>'
    +'<th style="padding:7px 10px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Where Required</th>'
    +sumTH+'UG Reqd</th>'+sumTH+'PG Add-on</th>'+sumTH+'Total Needed</th>'+sumTH+'Recruited</th>'+sumTH+'Status</th>'
    +'</tr></thead><tbody>'+sumRows+'</tbody>'
    +'<tfoot>'+gtRow+'</tfoot></table></div>';

  // ── Department-wise requirement ladder — same 12-section tree as 🏥 Dept. Staff ──
  // Optional Schedule XX rows (dark room assistant, Panchakarma prep-room cook) — real
  // per the source table but conditional/situational, so never counted as a compliance
  // gap. Rendered as a muted "add if your hospital needs this" note with its own Invite
  // button, reusing the same registry/handler as the mandatory ladder rows above it.
  function optionalRowsHtml(dept, optional){
    if(!optional.length) return '';
    const items=optional.map(row=>{
      const a=cntDeptD(dept.id,row.keys);
      const rowIdx=_ladderRowRegistry.push({deptId:dept.id, deptName:dept.name, keys:row.keys, label:row.label})-1;
      const invKey=dept.id+'|'+row.keys[0];
      const pending=invitesByRow[invKey]||[];
      const inviteBtn='<button data-onclick="openPositionInvite" data-onclick-a0="'+rowIdx+'" style="height:22px;padding:0 9px;font-size:10.5px;background:transparent;color:var(--green-deep);border:1px solid var(--green-deep);border-radius:6px;cursor:pointer;white-space:nowrap">+ Add if needed</button>'
        +(pending.length?' <span style="font-size:10.5px;color:#7a5a10">🔗 '+pending.length+' pending</span>':'');
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 16px;font-size:12px;color:var(--text-muted)">'
        +'<span>'+_esc(row.label)+' <span style="font-size:10.5px;color:var(--text-muted)">('+_esc(row.ref)+', suggested '+row.count+')</span>'
        +(a?' — <strong style="color:var(--green-deep)">'+a+'</strong> currently assigned':'')+'</span>'
        +inviteBtn+'</div>';
    }).join('');
    return '<div style="background:#fafafa;border-top:1px dashed var(--border);margin-top:2px">'
      +'<div style="padding:6px 16px 2px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted)">Optional — not NCISM-mandated, add only if your hospital needs it</div>'
      +items+'</div>';
  }

  function ladderTableHtml(dept){
    const req=deptRequirement(dept,ug);
    if(!req.mandated){
      const actual=(byDept[dept.id]||[]).length;
      return '<div style="padding:6px 16px 10px;font-size:12px;color:var(--text-muted)">Not NCISM-mandated — tracked for operational completeness. <strong>'+actual+'</strong> active staff currently assigned.</div>'
        +optionalRowsHtml(dept, req.optional);
    }
    // Sub-section headers — only shown when a department's ladder actually merges rows from
    // more than one NCISM_XX_ROWS zone (e.g. IPD_PARENT holds both Medical + Surgical rows,
    // which otherwise look like duplicate "Nursing Staff"/"Ayah" lines with no indication
    // of which section each belongs to).
    const distinctZones=new Set(req.ladder.map(r=>r.zone));
    let prevZone=null;
    const trs=req.ladder.map(row=>{
      const a=cntDeptD(dept.id,row.keys), gap=Math.max(0,row.count-a);
      const rc=a>=row.count?'#2d7a4f':a>0?'#c9902a':'#c0392b';
      const si=a>=row.count?'✅':a>0?'⚠️':'❌';
      const rowIdx=_ladderRowRegistry.push({deptId:dept.id, deptName:dept.name, keys:row.keys, label:row.label})-1;
      const invKey=dept.id+'|'+row.keys[0];
      const pending=invitesByRow[invKey]||[];
      const inviteCell = gap>0
        ? '<button data-onclick="openPositionInvite" data-onclick-a0="'+rowIdx+'" style="height:24px;padding:0 10px;font-size:11px;background:var(--green-deep);color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">+ Invite</button>'
          +(pending.length?' <span style="font-size:10.5px;color:#7a5a10">🔗 '+pending.length+' pending</span>':'')
        : '';
      let sectionHeader='';
      if(distinctZones.size>1 && row.zone!==prevZone){
        prevZone=row.zone;
        sectionHeader='<tr><td colspan="6" style="padding:7px 12px 5px 16px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--green-deep);background:#f0faf5;border-bottom:1px solid #f0f4f2">'+_esc(ZONE_SECTION_LABEL[row.zone]||row.zone)+'</td></tr>';
      }
      return sectionHeader+'<tr>'
        +'<td style="padding:6px 12px 6px 16px;font-size:12.5px;border-bottom:1px solid #f0f4f2">'+_esc(row.label)
          +(row.facultyHeld?'<br><span style="font-size:10px;font-weight:400;color:var(--text-muted)">Typically held concurrently by an existing faculty member — not counted in section/hospital totals</span>':'')+'</td>'
        +'<td style="padding:6px 10px;text-align:center;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">'+_esc(row.ref)+'</td>'
        +'<td style="padding:6px 10px;text-align:center;font-weight:600;border-bottom:1px solid #f0f4f2">'+row.count+'</td>'
        +'<td style="padding:6px 10px;text-align:center;color:'+rc+';font-weight:600;border-bottom:1px solid #f0f4f2">'+a+'</td>'
        +'<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f0f4f2">'+si+(gap>0?' <span style="font-size:11px;color:#c0392b">−'+gap+'</span>':'')+'</td>'
        +'<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f0f4f2">'+inviteCell+'</td>'
        +'</tr>';
    }).join('');
    return '<table style="width:100%;border-collapse:collapse">'
      +'<thead><tr style="background:#f5faf7">'
      +'<th style="padding:5px 12px 5px 16px;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Position</th>'
      +'<th style="padding:5px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Ref</th>'
      +'<th style="padding:5px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Required</th>'
      +'<th style="padding:5px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Actual</th>'
      +'<th style="padding:5px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Status</th>'
      +'<th style="padding:5px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Fill Gap</th>'
      +'</tr></thead><tbody>'+trs+'</tbody></table>'
      +optionalRowsHtml(dept, req.optional);
  }

  const deptTreeHtml=tree.map(node=>{
    const {def,dept,children}=node;
    if(!dept){
      return '<div class="ncism-zs" style="opacity:.6">'
        +'<div class="ncism-zh" style="cursor:default">'
        +'<span style="font-weight:600;font-size:13px">'+def.icon+' '+_esc(def.label)+'</span>'
        +'<span style="font-size:11px;color:var(--text-muted)">Not yet configured</span></div></div>';
    }
    const roll=sectionRollup(node,ug,byDept);
    const pillColor=!roll.mandated?'#6b7280':roll.gap>0?'#c0392b':'#2d7a4f';
    const pillText=!roll.mandated?roll.actual+' staff (not NCISM-mandated)':'Req '+roll.required+' · Actual '+roll.actual+(roll.gap>0?' · Gap −'+roll.gap:' · ✅ met');

    let body='<div style="padding:8px 0 6px"><div style="font-size:11px;font-weight:700;color:var(--text-muted);margin:0 0 4px 16px">'+_esc(dept.name)+'</div>'+ladderTableHtml(dept)+'</div>';
    children.forEach(c=>{
      const sharedNote=c._sharedWith?'<span style="font-size:10px;font-weight:400;color:var(--text-muted)"> — shared teaching faculty pool with '+_esc(c._sharedWith)+' (NCISM Note 2: ~50% each speciality)</span>':'';
      body+='<div style="margin:6px 0 0 16px;border-left:2px solid var(--border);padding-left:10px">'
        +'<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:4px">'+_esc(c.name)+sharedNote+'</div>'
        +ladderTableHtml(c)
        +'</div>';
    });

    return '<div class="ncism-zs">'
      +'<div class="ncism-zh ncism-toggle">'
      +'<span style="font-weight:600;font-size:13px">'+def.icon+' '+_esc(def.label)
        +(children.length?' <span style="font-size:11px;font-weight:400;color:var(--text-muted)">('+children.length+' sub-section'+(children.length>1?'s':'')+')</span>':'')
      +'</span>'
      +'<span style="display:flex;align-items:center;gap:8px">'
      +'<span style="background:'+pillColor+'18;color:'+pillColor+';border:1px solid '+pillColor+'55;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">'+pillText+'</span>'
      +'<span class="ncism-arr">▼</span>'
      +'</span></div>'
      +'<div class="ncism-zb">'+body+'</div></div>';
  }).join('');

  // ── Assemble ──────────────────────────────────────────────────────────
  wrap.innerHTML =
    '<div style="background:var(--green-deep);color:#fff;border-radius:var(--radius) var(--radius) 0 0;padding:12px 18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">'
      +'<div><div style="font-weight:600;font-size:14px">NCISM Staffing Compliance — Schedule I + XX</div>'
        +'<div style="font-size:11px;opacity:.75;margin-top:2px">UG Intake: '+ug+' · Department-wise · Active profiles with designation + department assigned</div>'
      +'</div>'
      +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        +'<div style="background:'+hc+'44;border:1px solid '+hc+'88;padding:3px 14px;border-radius:12px;font-size:13px;font-weight:700">'+grandPct+'% Compliant</div>'
        +'<a href="signup.html" style="background:#ffffff22;color:#fff;padding:3px 12px;border-radius:8px;font-size:12px;text-decoration:none;border:1px solid #ffffff44">+ Add Staff</a>'
      +'</div>'
    +'</div>'
    +'<div style="padding:10px 16px;background:#f0faf5;border-bottom:1px solid var(--border)">'
      +'<div style="font-size:12px;font-weight:700;color:var(--green-deep);margin-bottom:6px">📋 Faculty Required — Schedule I ('+clinDepts+' teaching depts configured, per Regulation 34 — varies by department, see table below)</div>'
      +'<div style="display:flex;flex-wrap:wrap;gap:20px;font-size:13px;align-items:center">'
        +'<span>Hospital-wide total: <strong>'+facReq+'</strong></span>'
        +'<span>Recruited: <strong style="color:'+(facAct>=facReq?'#2d7a4f':'#c0392b')+'">'+facAct+'</strong> '+(facAct>=facReq?'✅':'⚠️ −'+facGap+' needed')+'</span>'
      +'</div>'
    +'</div>'
    +'<div style="padding:10px 14px;border-bottom:1px solid var(--border)">'
      +'<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🏛️ Department-wise Requirement — click a section to expand (Administration → Security)</div>'
      +deptTreeHtml
    +'</div>'
    +'<div style="padding:10px 14px;border-bottom:1px solid var(--border)">'
      +'<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">📊 Hospital-wide Total — Designation-wise (UG + PG combined, legacy rollup)</div>'
      +sumTableHtml
    +'</div>'
    +'<div style="padding:9px 16px;font-size:11px;color:var(--text-muted);background:#fafcfb;display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px">'
      +'<span>* Required/Actual/Gap above is computed per real department (same tree as 🏥 Dept. Staff). Housekeeping/Laundry/Security carry no NCISM-prescribed headcount — actual staff shown for completeness only.</span>'
      +'<a href="ncism-compliance.html" style="color:var(--green-mid);white-space:nowrap">Full NCISM Report →</a>'
    +'</div>';

  // Delegated click handler for section accordions — guard prevents duplicate stacking
  if (!wrap._ncismClickBound) {
    wrap._ncismClickBound = true;
    wrap.addEventListener('click', e => {
      const hdr = e.target.closest('.ncism-toggle');
      if (hdr) hdr.closest('.ncism-zs').classList.toggle('z-open');
    });
  }

  // Auto-open first 3 sections
  [...wrap.querySelectorAll('.ncism-zs')].slice(0,3).forEach(el=>el.classList.add('z-open'));
}

// ── Position Invite modal — turn a ladder gap into a shareable join link ──
window.openPositionInvite = function(idxStr){
  const row = _ladderRowRegistry[Number(idxStr)];
  if(!row) return;
  const dlabel = k => DESIG_MAP[k]?.l || k || '—';
  const desig = row.keys[0];
  document.getElementById('pinv-dept-id').value   = row.deptId;
  document.getElementById('pinv-dept-name').textContent = row.deptName;
  document.getElementById('pinv-desig-label').textContent = dlabel(desig);
  const keySel = document.getElementById('pinv-desig-select');
  keySel.innerHTML = row.keys.map(k=>'<option value="'+_esc(k)+'">'+_esc(dlabel(k))+'</option>').join('');
  keySel.value = desig;
  const roleSel = document.getElementById('pinv-role-select');
  roleSel.value = DESIG_ROLE_DEFAULT[desig] || 'doctor';
  document.getElementById('pinv-name').value  = '';
  document.getElementById('pinv-phone').value = '';
  document.getElementById('pinv-email').value = '';
  document.getElementById('pinv-link-box').style.display = 'none';
  document.getElementById('pinv-form-fields').style.display = '';
  document.getElementById('pinv-submit-btn').style.display = '';
  document.getElementById('pinv-copy-btn').style.display = 'none';
  document.getElementById('position-invite-modal').style.display = 'flex';
};

window.closePositionInviteModal = function(){
  document.getElementById('position-invite-modal').style.display = 'none';
};

window.submitPositionInvite = async function(){
  const deptId = document.getElementById('pinv-dept-id').value || null;
  const designation = document.getElementById('pinv-desig-select').value;
  const roleVal = document.getElementById('pinv-role-select').value;
  const name  = document.getElementById('pinv-name').value.trim();
  const phone = document.getElementById('pinv-phone').value.trim();
  const email = document.getElementById('pinv-email').value.trim();
  if(!phone && !email){ _toast('Enter a phone number or email to invite.', true); return; }

  const { data, error } = await supabase.from('position_invites').insert({
    tenant_id: tenantId, department_id: deptId, designation, role: roleVal,
    candidate_name: name || null, phone: phone || null, email: email || null,
    created_by: profile.id,
  }).select('token').single();

  if(error){ _toast(safeErrorMessage(error,'Could not create invite.'), true); return; }

  const link = window.location.origin + '/signup.html?pinv=' + data.token;
  document.getElementById('pinv-link-text').textContent = link;
  document.getElementById('pinv-form-fields').style.display = 'none';
  document.getElementById('pinv-link-box').style.display = '';
  document.getElementById('pinv-submit-btn').style.display = 'none';
  document.getElementById('pinv-copy-btn').style.display = '';
  _toast('Invite created — copy the link below.');
  if(document.getElementById('hr-ncism-panel').style.display!=='none') _renderNcismStaffing();
};

window.copyPositionInviteLink = function(){
  const link = document.getElementById('pinv-link-text').textContent || '';
  navigator.clipboard.writeText(link)
    .then(()=>_toast('Link copied!'))
    .catch(()=>_toast('Could not copy — select the link text manually.', true));
};

// ── Staffing Plan — required staff by designation, grouped by HMS role ────────
// Attributes each NCISM_XX_ROWS row to exactly ONE canonical designation (its first key —
// the same rule _ncismRoleMinimums() uses for the Statistics page checklist), then groups by
// HMS role. Deliberately does NOT reuse NCISM_SUM_GRPS's hand-written groupings — those can
// double-count: e.g. "OT Nursing Staff" has keys ['ot_technician','staff_nurse'] (either
// designation can fill the post), and NCISM_SUM_GRPS's separate "OT/CSSD" and "Staff Nurse —
// all zones" rows each independently pick it up via a different one of those two keys, so a
// naive per-group sum inflates the nurse total by double-counting that one row. This function
// and _ncismRoleMinimums() are the two places in the app that state an aggregate headcount
// total, so they use the identical keys[0]-only attribution rule to guarantee they can't
// silently disagree with each other again.
const STAFFING_PLAN_ROLE_ORDER = [
  {role:'doctor',       icon:'👨‍⚕️', label:'Doctors'},
  {role:'nurse',        icon:'👩‍⚕️', label:'Nurses'},
  {role:'pharmacist',   icon:'💊', label:'Pharmacists'},
  {role:'lab_tech',     icon:'🔬', label:'Lab Technicians'},
  {role:'receptionist', icon:'🏥', label:'Receptionists'},
  {role:'therapist',    icon:'🌸', label:'Therapists'},
  {role:'dept_admin',   icon:'🏛️', label:'Administrative Officers'},
  {role:'accountant',   icon:'💰', label:'Finance & Accounts'},
  {role:'mrd_staff',    icon:'📋', label:'Medical Records'},
  {role:'diet_staff',   icon:'🍲', label:'Diet / Pathya'},
];

async function _renderStaffingPlan() {
  const wrap = document.getElementById('staffing-plan-wrap');
  wrap.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';

  const [{ data:tRow }, { data:rawStaff }, { data:depts }, { data:pgDepts }, { data:liveDuty }] = await Promise.all([
    supabase.from('tenants').select('ug_intake,type,pg_student_strength').eq('id',tenantId).single(),
    supabase.from('profiles').select('designation').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('departments').select('id,ncism_code').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('departments').select('id,ncism_code,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_pg_dept',true),
    // Session 111 -- who's actually covering which front-office duty right now (not just
    // the required-vs-recruited headcount below), for the Reception & MRD live coverage
    // card. ended_at is null = currently active session.
    supabase.from('staff_duty_sessions').select('active_duty').eq('tenant_id',tenantId).is('ended_at',null),
  ]);

  if (!isNCISMType(tRow?.type)) {
    wrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">Staffing Plan only applies to Teaching Hospital / College tenants — this organisation is registered as "'+_esc(tRow?.type||'unknown')+'".</div></div>';
    return;
  }
  const ugRaw = tRow?.ug_intake || 0;
  const ug = [60,100,150,200].includes(ugRaw) ? ugRaw : (ugRaw>=150?150:ugRaw>=100?100:ugRaw>0?60:0);
  if (!ug) {
    wrap.innerHTML = '<div class="empty"><div class="empty-ico">ℹ</div><div class="empty-ttl">Staffing Plan applies to Teaching Hospitals and Colleges with UG intake configured.</div></div>';
    return;
  }

  const byDesig = {};
  (rawStaff||[]).forEach(s => { if(s.designation) byDesig[s.designation]=(byDesig[s.designation]||0)+1; });
  const cntD = keys => keys.reduce((s,k)=>s+(byDesig[k]||0),0);
  const pgList = pgDepts || [];

  const facTotal=_scheduleIFacultyTotal(depts, ug);
  const clinDepts=facTotal.count;
  const FAC_UG={p:facTotal.p, a:facTotal.a, b:facTotal.b};

  const keyTotPG={};
  pgList.forEach(d=>{
    const seats=d.pg_seats_sanctioned||3, pgB=seats*4;
    keyTotPG['senior_resident']=(keyTotPG['senior_resident']||0)+Math.ceil(seats/3);
    keyTotPG['staff_nurse']=(keyTotPG['staff_nurse']||0)+Math.ceil(pgB/10);
    keyTotPG['attender']=(keyTotPG['attender']||0)+Math.ceil(pgB/20);
    if(d.ncism_code==='PK')keyTotPG['therapist']=(keyTotPG['therapist']||0)+Math.ceil(seats/3)*2;
    if(seats>3)keyTotPG['assistant_professor']=(keyTotPG['assistant_professor']||0)+Math.ceil((seats-3)/3);
    if(seats>6)keyTotPG['associate_professor']=(keyTotPG['associate_professor']||0)+Math.ceil((seats-6)/3);
  });

  const ZA={'Administration':'Admin','Finance & Accounts':'Finance','Reception & MRD':'Reception',
    'OPD Nursing':'OPD Nsg','Pharmacy':'Pharmacy','Diagnostics':'Diagnostics',
    'Medical IPD':'Med IPD','Surgical IPD':'Surg IPD','Panchakarma':'PK',
    'Operation Theatre':'OT','Labour Room':'LR','Kriyakalpa':'Kriyakalpa',
    'Physiotherapy':'Physio','Yoga & Wellness':'Yoga','Diet / Pathya':'Diet','CSSD':'CSSD'};

  // Canonical per-designation totals — one entry per distinct keys[0] (never counted under a
  // second designation via an alternate-eligible key), matching _ncismRoleMinimums()'s rule.
  // altKeys collects every acceptable designation for that post (e.g. staff_nurse OR
  // ward_sister can both fill a "Staff Nurse" post) — used only for counting real recruited
  // staff, where unioning is safe since a real person is never double-counted by being
  // eligible under two names.
  const byKey = {};
  const bump = (ck, add, keysForAlt) => {
    if(!byKey[ck]) byKey[ck] = {ugTotal:0, zones:new Set(), altKeys:new Set(), pgOnly:false};
    byKey[ck].ugTotal += add;
    (keysForAlt||[ck]).forEach(k=>byKey[ck].altKeys.add(k));
  };
  bump('professor', FAC_UG.p, ['professor','hod']);
  bump('associate_professor', FAC_UG.a);
  bump('assistant_professor', FAC_UG.b);
  bump('senior_resident', 0);
  byKey['senior_resident'].pgOnly = true;
  NCISM_XX_ROWS.forEach(([zone,,keys,req])=>{
    const c=req[ug]||0;
    if(!c) return;
    bump(keys[0], c, keys);
    byKey[keys[0]].zones.add(ZA[zone]||zone);
  });

  const byRole = {};
  Object.keys(byKey).forEach(ck=>{
    const role = DESIG_ROLE_DEFAULT[ck] || 'other';
    (byRole[role] = byRole[role] || []).push(ck);
  });

  let grandTotal=0, grandRec=0;
  const sectionsHtml = STAFFING_PLAN_ROLE_ORDER.filter(r=>byRole[r.role]?.length).map(({role,icon,label})=>{
    let roleTotal=0, roleRec=0;
    const rowsHtml = byRole[role].map(ck=>{
      const info = byKey[ck];
      const dLabel = DESIG_MAP[ck]?.l || ck;
      if(FACULTY_CONCURRENT_POSTS.has(ck)){
        return '<tr><td style="padding:6px 12px 6px 20px;font-size:12.5px;border-bottom:1px solid #f0f4f2">'+_esc(dLabel)+'</td>'
          +'<td colspan="5" style="padding:6px 12px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">Typically held concurrently by an existing faculty member — not counted separately</td></tr>';
      }
      const pgA=keyTotPG[ck]||0;
      const total=info.ugTotal+pgA;
      if(info.pgOnly&&pgList.length===0){
        return '<tr><td style="padding:6px 12px 6px 20px;font-size:12.5px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">'+_esc(dLabel)+'</td>'
          +'<td colspan="5" style="padding:6px 12px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">Not applicable — no PG departments configured</td></tr>';
      }
      const rec=cntD([...info.altKeys]), gap=Math.max(0,total-rec);
      roleTotal+=total; roleRec+=Math.min(rec,total);
      const rc=rec>=total&&total>0?'#2d7a4f':rec>0?'#c9902a':'#c0392b';
      const si=rec>=total&&total>0?'✅':rec>0?'⚠️':'❌';
      const zs=info.pgOnly?'PG depts only':(['professor','associate_professor','assistant_professor'].includes(ck)?'Schedule I ('+clinDepts+' clinical depts)':[...info.zones].join(' + ')||'—');
      return '<tr>'
        +'<td style="padding:6px 12px 6px 20px;font-size:12.5px;border-bottom:1px solid #f0f4f2">'+_esc(dLabel)+'</td>'
        +'<td style="padding:6px 10px;font-size:11px;color:var(--text-muted);border-bottom:1px solid #f0f4f2">'+_esc(zs)+'</td>'
        +'<td style="padding:6px 10px;text-align:center;font-weight:600;border-bottom:1px solid #f0f4f2">'+(total>0?info.ugTotal:'—')+'</td>'
        +'<td style="padding:6px 10px;text-align:center;color:#c9902a;border-bottom:1px solid #f0f4f2">'+(pgA>0?'+'+pgA:'—')+'</td>'
        +'<td style="padding:6px 10px;text-align:center;font-weight:700;border-bottom:1px solid #f0f4f2">'+(total||'—')+'</td>'
        +'<td style="padding:6px 10px;text-align:center;color:'+rc+';font-weight:700;border-bottom:1px solid #f0f4f2">'+rec+'</td>'
        +'<td style="padding:6px 10px;text-align:center;border-bottom:1px solid #f0f4f2">'+si+(gap>0?' <span style="font-size:11px;color:#c0392b">−'+gap+'</span>':'')+'</td>'
        +'</tr>';
    }).join('');

    grandTotal+=roleTotal; grandRec+=roleRec;
    const pct = roleTotal>0 ? Math.round(Math.min(roleRec,roleTotal)/roleTotal*100) : 100;
    const pc = pct>=80?'#2d7a4f':pct>=50?'#c9902a':'#c0392b';

    return '<div class="cc" style="margin-bottom:14px;padding:0">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border)">'
        +'<span style="font-weight:700;font-size:15px">'+icon+' '+_esc(label)+'</span>'
        +'<span style="background:'+pc+'18;color:'+pc+';border:1px solid '+pc+'55;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600">Need '+roleTotal+' · Have '+roleRec+' · '+pct+'%</span>'
      +'</div>'
      +'<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">'
        +'<thead><tr style="background:#f5faf7">'
        +'<th style="padding:6px 12px 6px 20px;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Designation</th>'
        +'<th style="padding:6px 10px;text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Where Required</th>'
        +'<th style="padding:6px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">UG Reqd</th>'
        +'<th style="padding:6px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">PG Add-on</th>'
        +'<th style="padding:6px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Total Needed</th>'
        +'<th style="padding:6px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Recruited</th>'
        +'<th style="padding:6px 10px;text-align:center;font-size:10.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-muted);font-weight:700;border-bottom:1.5px solid var(--border)">Status</th>'
        +'</tr></thead><tbody>'+rowsHtml+'</tbody></table></div>'
      +'</div>';
  }).join('');

  const grandPct = grandTotal>0 ? Math.round(Math.min(grandRec,grandTotal)/grandTotal*100) : 100;
  const gc = grandPct>=80?'#2d7a4f':grandPct>=50?'#c9902a':'#c0392b';

  // Session 111 -- live front-office duty coverage. This is a DIFFERENT question from the
  // required-vs-recruited headcount table above (that's "how many Registration & Billing
  // Clerks are employed"; this is "who is actually covering Registration/Billing/etc right
  // now"), fed by duty-select.html's shared-pool duty picker.
  const DUTY_LABELS_ADMIN = {
    registration:'Registration', admission:'Admission', discharge:'Discharge',
    insurance:'Insurance', billing:'Billing', all_duties:'All Duties',
  };
  const dutyCounts = {};
  (liveDuty||[]).forEach(d => { dutyCounts[d.active_duty] = (dutyCounts[d.active_duty]||0)+1; });
  const dutyKeys = Object.keys(dutyCounts);
  const liveCoverageHtml = '<div class="cc" style="margin-bottom:14px;padding:12px 16px">'
    +'<div style="font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">🔴 Live Front-Office Duty Coverage</div>'
    + (dutyKeys.length
        ? '<div style="display:flex;gap:8px;flex-wrap:wrap">' + dutyKeys.map(k =>
            '<span style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:8px;padding:4px 10px;font-size:12.5px">'
            +_esc(DUTY_LABELS_ADMIN[k]||k)+': <strong>'+dutyCounts[k]+'</strong></span>'
          ).join('') + '</div>'
        : '<div style="font-size:12px;color:var(--text-muted)">No shared-pool clerk is currently signed into an active duty (via the duty selector at login).</div>')
    +'</div>';

  wrap.innerHTML = '<div class="cc" style="margin-bottom:14px;text-align:center;background:'+gc+'">'
    +'<div style="padding:14px 16px;color:#fff">'
      +'<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.85">Staffing Plan — UG Intake '+ug+(pgList.length?' · '+pgList.length+' PG dept(s)':'')+'</div>'
      +'<div style="font-weight:700;font-size:20px;margin-top:2px">'+grandTotal+' total staff needed · '+grandRec+' recruited ('+grandPct+'%)</div>'
    +'</div></div>'
    + liveCoverageHtml
    + sectionsHtml
    + '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Numbers scale with UG intake and PG seats sanctioned — same source as HR → NCISM Requirements\' department-wise ladder. Medical Director is excluded from the Doctors total (typically held concurrently by an existing faculty member).</div>';
}

// ── Departmental Staff Distribution ──────────────────────────────────
async function _renderDeptStaff() {
  const wrap = document.getElementById('dept-staff-wrap');
  wrap.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';

  const today = new Date().toISOString().slice(0,10);
  const [{ data:tRow },{ data:depts },{ data:allStaff },{ data:rosterRows },{ data:opds }] = await Promise.all([
    supabase.from('tenants').select('ug_intake').eq('id',tenantId).single(),
    supabase.from('departments').select('id,name,ncism_code,category,parent_department_id,is_active,is_pg_dept,pg_seats_sanctioned').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('profiles').select('id,full_name,role,designation,department_id,is_active,status').eq('tenant_id',tenantId),
    supabase.from('duty_roster').select('department_id,profile_id,shift_type,is_confirmed').eq('tenant_id',tenantId).eq('shift_date',today),
    supabase.from('opds').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true),
  ]);

  const ugRaw=tRow?.ug_intake||0;
  const ug=[60,100,150,200].includes(ugRaw)?ugRaw:(ugRaw>=150?150:ugRaw>=100?100:ugRaw>0?60:0);
  const activeStaff=(allStaff||[]).filter(s=>s.is_active);

  // Group staff by department_id
  const byDept={};
  activeStaff.forEach(s=>{
    const did=s.department_id||'__none__';
    if(!byDept[did])byDept[did]=[];
    byDept[did].push(s);
  });

  // Today's OPD rotational duty, keyed by "departmentId|profileId"
  const SHIFT_LABELS={morning:'Morning',afternoon:'Afternoon',night:'Night',on_call:'On-Call'};
  const dutyMap={};
  (rosterRows||[]).forEach(r=>{
    const k=r.department_id+'|'+r.profile_id;
    (dutyMap[k]=dutyMap[k]||[]).push(r);
  });
  const dutyChip=(deptId,profileId)=>{
    const rows=dutyMap[deptId+'|'+profileId];
    if(!rows||!rows.length) return '<span style="font-size:10px;color:#b91c1c;margin-left:4px">· not rostered today</span>';
    return rows.map(r=>'<span style="font-size:10px;background:#e8f0ff;color:#1a308b;border-radius:6px;padding:1px 6px;margin-left:4px">'+(SHIFT_LABELS[r.shift_type]||r.shift_type)+(r.is_confirmed?'':' (tentative)')+'</span>').join('');
  };

  // Designation order from DESIGS.lv (lower = senior)
  const _lv=d=>DESIG_MAP[d]?.lv??99;
  const _dl=d=>DESIG_MAP[d]?.l||d||'—';
  const _dd=d=>DESIG_MAP[d]?.d||'';

  // Intern expected count = UG intake (all rotating through depts)
  const expectedInterns=ug||0;

  // Build a card per department
  const INTERN_DESIGS=['intern','pg_scholar','nursing_intern'];
  const FACULTY_DESIGS=['hod','professor','associate_professor','assistant_professor'];
  const SENIOR_RES=['senior_resident','junior_resident'];

  function _deptCard(dept,staff,opts={}){
    const sorted=[...staff].sort((a,b)=>_lv(a.designation)-_lv(b.designation));
    const hod=sorted.find(s=>['hod','professor'].includes(s.designation)||s.role==='dept_admin');
    const actingHod=!hod?(opts.actingHod||null):null;
    const faculty=sorted.filter(s=>FACULTY_DESIGS.includes(s.designation));
    const residents=sorted.filter(s=>SENIOR_RES.includes(s.designation));
    const interns=sorted.filter(s=>INTERN_DESIGS.includes(s.designation));
    const others=sorted.filter(s=>!FACULTY_DESIGS.includes(s.designation)&&!SENIOR_RES.includes(s.designation)&&!INTERN_DESIGS.includes(s.designation));
    const admin=staff.find(s=>s.role==='dept_admin');
    const deptCode=dept?.ncism_code?('NCISM: '+dept.ncism_code):(dept?.category?('Section: '+dept.category):'Non-NCISM');
    const isPG=dept?.is_pg_dept;
    const pgSeats=dept?.pg_seats_sanctioned||0;
    const showDuty=!!(opts.showDuty&&dept);
    const badge=s=>'<span title="'+_esc(_dd(s.designation))+'" style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#f0faf5;border:1px solid #b7dfc8;color:#1a4a2e;margin:2px">'+_esc(s.full_name||'?')+'<span style="color:var(--text-muted);margin-left:4px">'+_dl(s.designation)+'</span>'+(showDuty?dutyChip(dept.id,s.id):'')+'</span>';
    const emptyChip=label=>'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fff0f0;border:1px solid #fca5a5;color:#b91c1c;margin:2px">'+label+' — not assigned</span>';

    let rows='';
    // Admin row
    rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
      +'<div style="min-width:120px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding-top:3px">Dept Admin</div>'
      +'<div style="flex:1">'+(admin?badge(admin):emptyChip('Dept Admin'))+'</div></div>';
    // HOD row (falls back to an acting HOD borrowed from another dept, e.g. IPD → Shalya HOD)
    const hodCell=hod?badge(hod)
      :actingHod?(badge(actingHod)+'<span style="font-size:11px;color:var(--text-muted);margin-left:4px">('+_esc(opts.actingHodNote||'acting')+')</span>')
      :emptyChip('HOD/Professor');
    rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
      +'<div style="min-width:120px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding-top:3px">Head of Dept</div>'
      +'<div style="flex:1">'+hodCell+'</div></div>';
    // Faculty row
    if(faculty.length||isPG){
      rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
        +'<div style="min-width:120px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding-top:3px">Faculty</div>'
        +'<div style="flex:1">'+(faculty.length?faculty.map(badge).join(''):emptyChip('Faculty'))+'</div></div>';
    }
    // Senior/Junior Residents
    if(residents.length||isPG){
      rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
        +'<div style="min-width:120px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding-top:3px">'+(isPG?'Residents (PG)':'Residents')+'</div>'
        +'<div style="flex:1">'+(residents.length?residents.map(badge).join(''):(isPG?emptyChip('Senior Resident'):'<span style="font-size:12px;color:var(--text-muted)">None assigned</span>'))+'</div></div>';
    }
    // Interns — show for all depts (clinical determined by ncism_code)
    const isClinical=!!(dept?.ncism_code);
    if(interns.length||isClinical){
      const internChip=interns.length
        ?interns.map(s=>'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fef9ec;border:1px solid #f5c842;color:#854d0e;margin:2px">'+_esc(s.full_name||'?')+'<span style="color:var(--text-muted);margin-left:4px">'+_dl(s.designation)+'</span></span>').join('')
        :'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#fff0f0;border:1px solid #fca5a5;color:#b91c1c;margin:2px">No interns assigned ⚠️</span>';
      rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
        +'<div style="min-width:120px;font-size:11px;font-weight:700;color:#854d0e;text-transform:uppercase;padding-top:3px">Interns</div>'
        +'<div style="flex:1">'+internChip+'</div></div>';
    }
    // Others (clinical staff, nursing, etc.)
    if(others.length){
      const groups={};
      others.forEach(s=>{const c=DESIG_MAP[s.designation]?.cat||'Other';if(!groups[c])groups[c]=[];groups[c].push(s);});
      Object.entries(groups).sort(([a],[b])=>a.localeCompare(b)).forEach(([cat,members])=>{
        rows+='<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 0;border-bottom:1px solid #f0f4f2">'
          +'<div style="min-width:120px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;padding-top:3px">'+_esc(cat)+'</div>'
          +'<div style="flex:1">'+members.map(badge).join('')+'</div></div>';
      });
    }
    if(!staff.length){rows='<div style="padding:12px 0;color:var(--text-muted);font-size:13px">No active staff assigned to this department. Assign staff via <strong>All Staff</strong> tab or <a href="signup.html" style="color:var(--green-mid)">invite new members</a>.</div>';}

    const pgBadge=isPG?('<span style="background:#fef9ec;border:1px solid #f5c842;color:#854d0e;padding:1px 8px;border-radius:8px;font-size:11px;margin-left:6px">PG — '+pgSeats+' seats</span>'):'';

    return '<div class="cc" style="margin-bottom:12px">'
      +'<div class="cc-hd" style="border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:4px">'
        +'<div>'
          +'<div style="font-weight:700;font-size:14px">'+_esc(dept?dept.name:'—')+pgBadge+'</div>'
          +'<div style="font-size:11px;color:var(--text-muted);margin-top:2px">'+deptCode+' · <strong>'+staff.length+'</strong> active staff</div>'
        +'</div>'
        +'<div style="display:flex;align-items:center;gap:6px">'
          +(interns.length===0&&isClinical?'<span style="background:#fff0f0;border:1px solid #fca5a5;color:#b91c1c;padding:2px 8px;border-radius:8px;font-size:11px">⚠️ No interns</span>':'')
          +(hod?'<span style="background:#f0faf5;border:1px solid #b7dfc8;color:#1a4a2e;padding:2px 8px;border-radius:8px;font-size:11px">HoD ✅</span>':'<span style="background:#fff0f0;border:1px solid #fca5a5;color:#b91c1c;padding:2px 8px;border-radius:8px;font-size:11px">No HoD</span>')
        +'</div>'
      +'</div>'
      +'<div style="padding:0 4px">'+rows+'</div>'
      +'</div>';
  }

  // Stat chips at top
  const totalActive=activeStaff.length;
  const totalAssigned=activeStaff.filter(s=>s.department_id).length;
  const totalInterns=activeStaff.filter(s=>INTERN_DESIGS.includes(s.designation)).length;
  const totalFaculty=activeStaff.filter(s=>FACULTY_DESIGS.includes(s.designation)).length;
  const unassigned=(byDept['__none__']||[]);
  const deptsWithNoHoD=(depts||[]).filter(d=>{
    const ds=byDept[d.id]||[];
    return !ds.find(s=>['hod','professor'].includes(s.designation)||s.role==='dept_admin');
  });
  // Clinical = any dept with an NCISM code
  const clinicalDepts=(depts||[]).filter(d=>!!d.ncism_code);
  const deptsNoInterns=clinicalDepts.filter(d=>!(byDept[d.id]||[]).some(s=>INTERN_DESIGS.includes(s.designation)));

  const statChips='<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">'
    +'<div style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:10px;padding:8px 16px;min-width:110px">'
      +'<div style="font-size:20px;font-weight:700;color:var(--green-deep)">'+totalActive+'</div>'
      +'<div style="font-size:11px;color:var(--text-muted)">Active Staff</div></div>'
    +'<div style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:10px;padding:8px 16px;min-width:110px">'
      +'<div style="font-size:20px;font-weight:700;color:var(--green-deep)">'+totalAssigned+'</div>'
      +'<div style="font-size:11px;color:var(--text-muted)">Dept Assigned</div></div>'
    +'<div style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:10px;padding:8px 16px;min-width:110px">'
      +'<div style="font-size:20px;font-weight:700;color:var(--green-deep)">'+totalFaculty+'</div>'
      +'<div style="font-size:11px;color:var(--text-muted)">Faculty</div></div>'
    +'<div style="background:'+(totalInterns>0?'#fef9ec':'#fff0f0')+';border:1px solid '+(totalInterns>0?'#f5c842':'#fca5a5')+';border-radius:10px;padding:8px 16px;min-width:110px">'
      +'<div style="font-size:20px;font-weight:700;color:'+(totalInterns>0?'#854d0e':'#b91c1c')+'">'+totalInterns+'</div>'
      +'<div style="font-size:11px;color:var(--text-muted)">Interns in System</div>'
      +(expectedInterns>0?'<div style="font-size:10px;color:var(--text-muted)">Expected: ~'+expectedInterns+'</div>':'')
    +'</div>'
    +(deptsWithNoHoD.length?'<div style="background:#fff0f0;border:1px solid #fca5a5;border-radius:10px;padding:8px 16px;min-width:110px"><div style="font-size:20px;font-weight:700;color:#b91c1c">'+deptsWithNoHoD.length+'</div><div style="font-size:11px;color:var(--text-muted)">Depts without HoD</div></div>':'')
    +(deptsNoInterns.length?'<div style="background:#fff0f0;border:1px solid #fca5a5;border-radius:10px;padding:8px 16px;min-width:110px"><div style="font-size:20px;font-weight:700;color:#b91c1c">'+deptsNoInterns.length+'</div><div style="font-size:11px;color:var(--text-muted)">Clinical Depts — No Interns</div></div>':'')
    +'</div>';

  // Intern note banner
  const internBanner=expectedInterns>0&&totalInterns<expectedInterns
    ?'<div style="background:#fef9ec;border:1px solid #f5c842;border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:13px">'
      +'⚠️ <strong>Interns:</strong> Your college has a UG intake of '+ug+'. Approximately <strong>'+expectedInterns+' interns</strong> should be rotating through clinical departments at any time. Currently <strong>'+totalInterns+' interns</strong> are recorded in the system. '
      +'Add intern profiles via <a href="signup.html" style="color:var(--green-mid)">Staff Signup</a> with designation set to <em>Intern</em> and assign them to their current rotation department.'
    +'</div>'
    :(totalInterns>0?'<div style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:13px">✅ Intern rotation tracking active — '+totalInterns+' interns in system.</div>':'');

  // Org chart — Super Admin at top, then the 12 fixed sections (Administration → Security)
  const shalyaDept=(depts||[]).find(d=>d.ncism_code==='SHAL');
  const shalyaHod=shalyaDept?(byDept[shalyaDept.id]||[]).find(s=>['hod','professor'].includes(s.designation)||s.role==='dept_admin'):null;

  const tree=buildDeptTree(depts||[], opds||[]);
  const superAdmin=activeStaff.find(s=>s.role==='super_admin');
  let cardsHtml='<div class="cc" style="margin-bottom:14px;text-align:center;background:#1a4a2e;color:#fff">'
    +'<div style="padding:14px 16px">'
      +'<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;opacity:.75">Organisation Head</div>'
      +'<div style="font-weight:700;font-size:16px;margin-top:2px">👑 '+_esc(superAdmin?.full_name||'Super Admin')+'</div>'
    +'</div></div>';

  tree.forEach(node=>{
    const {def,dept,children}=node;
    if(!dept){
      cardsHtml+='<div class="cc" style="margin-bottom:12px;opacity:.65">'
        +'<div class="cc-hd"><span class="cc-title">'+def.icon+' '+_esc(def.label)+'</span>'
        +'<span style="font-size:11px;color:var(--text-muted)">Not yet configured — click <strong>Seed HR Org Structure</strong> above</span></div></div>';
      return;
    }
    const roll=sectionRollup(node,ug,byDept);
    const pillColor=!roll.mandated?'#6b7280':roll.gap>0?'#c0392b':'#2d7a4f';
    const pillText=!roll.mandated
      ?roll.actual+' staff (not NCISM-mandated)'
      :'Req '+roll.required+' · Actual '+roll.actual+(roll.gap>0?' · Gap −'+roll.gap:' · ✅ met');

    const cardOpts=(def.key==='IPD_PARENT'&&!(byDept[dept.id]||[]).find(s=>['hod','professor'].includes(s.designation)||s.role==='dept_admin'))
      ?{actingHod:shalyaHod, actingHodNote:'via Shalya HOD'}
      :{};
    let bodyHtml=_deptCard(dept,byDept[dept.id]||[],cardOpts);
    children.forEach(c=>{
      const sharedNote=c._sharedWith?'<div style="font-size:10px;color:var(--text-muted);margin:-4px 0 6px">Shared teaching faculty pool with '+_esc(c._sharedWith)+' (NCISM Note 2: ~50% each speciality)</div>':'';
      bodyHtml+='<div style="margin-left:20px;border-left:2px solid var(--border);padding-left:12px;margin-top:8px">'
        +sharedNote
        +_deptCard(c,byDept[c.id]||[],def.key==='OPD_PARENT'?{showDuty:true}:{})
        +'</div>';
    });

    cardsHtml+='<details class="cc" style="margin-bottom:14px;padding:0" open>'
      +'<summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border)">'
        +'<span style="font-weight:700;font-size:15px">'+def.icon+' '+_esc(def.label)
          +(children.length?' <span style="font-size:11px;font-weight:400;color:var(--text-muted)">('+children.length+' sub-section'+(children.length>1?'s':'')+')</span>':'')
        +'</span>'
        +'<span style="background:'+pillColor+'18;color:'+pillColor+';border:1px solid '+pillColor+'55;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600">'+pillText+'</span>'
      +'</summary>'
      +'<div style="padding:12px 16px">'+bodyHtml+'</div>'
      +'</details>';
  });

  // Unassigned staff section
  let unassignedHtml='';
  if(unassigned.length){
    const ugBadges=unassigned.sort((a,b)=>_lv(a.designation)-_lv(b.designation)).map(s=>'<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;background:#f8f8f0;border:1px solid #e0dfc0;color:#555;margin:2px">'+_esc(s.full_name||'?')+' <span style="color:var(--text-muted)">'+_dl(s.designation)+' / '+s.role+'</span></span>').join('');
    unassignedHtml='<div class="cc" style="margin-bottom:12px">'
      +'<div class="cc-hd"><span class="cc-title">⚠️ Staff Without Department Assignment ('+unassigned.length+')</span></div>'
      +'<div style="padding:10px 4px;font-size:12px;color:var(--text-muted);margin-bottom:8px">These active profiles have no department set. Assign them via <strong>All Staff</strong> tab.</div>'
      +'<div>'+ugBadges+'</div></div>';
  }

  wrap.innerHTML = '<div style="padding:16px">'
    +'<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">Organisation Chart — Super Admin → 12 Sections → Staff Hierarchy</div>'
    +statChips+internBanner+cardsHtml+unassignedHtml
    +'<div style="font-size:11px;color:var(--text-muted);margin-top:8px">* Assign departments via <strong>All Staff</strong> tab → designation dropdown. Intern rotation: profiles with designation <em>Intern / PG Scholar</em> assigned to their current dept. Hover a staff name for its job description. OPD sub-sections show today\'s duty-roster shift (set in <a href="roster.html" style="color:var(--green-mid)">roster.html</a>). Click a section header to collapse/expand.</div>'
    +'</div>';
}

window.filterStaff = function(){
  const q=(document.getElementById('hr-search').value||'').toLowerCase();
  const r=document.getElementById('hr-role-filter').value;
  const d=document.getElementById('hr-desig-filter').value;
  renderStaffTable((window._staffAll||[]).filter(s=>
    (!q||(s.full_name||'').toLowerCase().includes(q)||(s.phone||'').includes(q)) &&
    (!r||s.role===r) && (!d||s.designation===d)
  ));
};

function renderStaffTable(staff){
  const tbody=document.getElementById('staff-tbody');
  if(!staff.length){tbody.innerHTML=`<tr><td colspan="8"><div class="empty"><div class="empty-ico">👥</div><div class="empty-ttl">No staff found</div></div></td></tr>`;return;}
  const canPromote = role === 'super_admin';
  tbody.innerHTML=staff.map(s=>{
    const showPromote = canPromote && s.is_active && !['super_admin','dept_admin'].includes(s.role);
    return `<tr>
    <td><strong>${_esc(s.full_name||'—')}</strong></td>
    <td><span class="chip g">${_roleLabel(s.role)}</span></td>
    <td><select class="desig-sel" data-id="${s.id}" data-onchange="saveDesig" data-onchange-a0="@this">${DESIG_SEL_HTML}</select></td>
    <td>${_esc(s.dept_name)}</td>
    <td>${_esc(s.phone||'—')}</td>
    <td><span class="chip ${s.is_active?'g':'grey'}">${s.is_active?'Active':s.status}</span></td>
    <td style="font-size:12px;color:var(--text-muted)">${_relDate(s.created_at)}</td>
    <td>${showPromote?`<button class="btn-outline" style="font-size:11px;padding:4px 10px" data-onclick="promoteToDeptAdmin" data-onclick-a0="${_esc(s.id)}" data-onclick-a1="${_esc(s.full_name||'this staff member')}" data-onclick-a2="${_esc(s.role)}">⬆ Promote to Admin</button>`:'—'}</td>
  </tr>`;
  }).join('');
  staff.forEach(s=>{const sel=tbody.querySelector(`select[data-id="${s.id}"]`);if(sel&&s.designation)sel.value=s.designation;});
}

window.promoteToDeptAdmin = async function(staffId, staffName, previousRole){
  if(!confirm(`Promote ${staffName} to Dept. Admin? This grants full HR, Finance, Settings and Subscription access for your organisation. This cannot be undone from this screen.`)) return;
  const {error} = await supabase.rpc('promote_to_dept_admin', {p_staff_id: staffId});
  if(error){ _toast(safeErrorMessage(error,'Could not promote staff.'), true); return; }
  await logAudit('promote_to_dept_admin', 'profiles', staffId, {staff_name: staffName, previous_role: previousRole}, {tenantId, userId: profile.id, userName: profile.full_name});
  _toast(staffName+' promoted to Dept. Admin.');
  window.loadHR && window.loadHR('staff');
};

window.saveDesig = async function(sel){
  const id=sel.dataset.id, val=sel.value;
  const{error}=await supabase.from('profiles').update({designation:val||null}).eq('id',id).eq('tenant_id',tenantId);
  if(error)_toast(safeErrorMessage(error,'Could not save designation.'),true);
  else{_toast('Designation updated.');const s=(window._staffAll||[]).find(x=>x.id===id);if(s)s.designation=val||null;}
};

function renderHierarchy(staff){
  const wrap=document.getElementById('hierarchy-body');
  const sections=DESIG_CATS.map(cat=>{
    const cvs=DESIGS.filter(d=>d.cat===cat).map(d=>d.v);
    const members=staff.filter(s=>cvs.includes(s.designation)).sort((a,b)=>(DESIG_MAP[a.designation]?.lv||99)-(DESIG_MAP[b.designation]?.lv||99));
    if(!members.length)return '';
    return `<div class="hcat">
      <div class="hcat-hd"><span class="hcat-title">${cat}</span><span class="hcat-count">${members.length}</span></div>
      <div>${members.map(s=>`<div class="hrow">
        <div class="havatar">${_esc((s.full_name||'?')[0].toUpperCase())}</div>
        <div style="flex:1">
          <div class="hname">${_esc(s.full_name||'—')}</div>
          <div class="hdesig">${DESIG_MAP[s.designation]?.l||s.designation} · ${_esc(s.dept_name)}</div>
        </div>
        <span class="chip g">${_roleLabel(s.role)}</span>
      </div>`).join('')}</div>
    </div>`;
  }).filter(Boolean).join('');

  const unassigned=staff.filter(s=>!s.designation||!DESIG_MAP[s.designation]);
  const unSection=unassigned.length?`<div class="hcat">
    <div class="hcat-hd" style="background:var(--text-muted)"><span class="hcat-title">Designation Not Set</span><span class="hcat-count">${unassigned.length}</span></div>
    <div>${unassigned.map(s=>`<div class="hrow">
      <div class="havatar">${(s.full_name||'?')[0].toUpperCase()}</div>
      <div style="flex:1"><div class="hname">${_esc(s.full_name||'—')}</div><div class="hdesig">${_roleLabel(s.role)} · ${_esc(s.dept_name)}</div></div>
    </div>`).join('')}</div>
  </div>`:'';

  wrap.innerHTML=sections+unSection||`<div class="empty"><div class="empty-ico">👥</div><div class="empty-ttl">No designations assigned yet</div><div class="empty-bod">Assign designations in the All Staff view to see the hierarchy here.</div></div>`;
}

// ────────────────────────────────────────────────
// SECTION 3 — DEPARTMENTS
// ────────────────────────────────────────────────
window.loadDepts = async function(){
  const [{data:rawDepts},{data:staffRows},{data:tRow},{data:rawOpds}] = await Promise.all([
    supabase.from('departments').select('*').eq('tenant_id',tenantId).order('name'),
    supabase.from('profiles').select('department_id').eq('tenant_id',tenantId).eq('is_active',true),
    supabase.from('tenants').select('type').eq('id',tenantId).single(),
    supabase.from('opds').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true),
  ]);
  // This is an HMS Departments directory — the 5 pure pre-clinical teaching departments
  // (Dravyaguna, Kriya Sharira, Rachana Sharira, Rasashastra & Bhaishajya Kalpana, Sanskrit
  // & Samhita) have no hospital operations of their own (no OPD, no beds, no support staff —
  // only Schedule I teaching faculty, tracked separately under NCISM Requirements) and belong
  // to the future CMS, not here. Structurally redundant now that buildDeptTree() drives this
  // page too (those 5 never match an ORG_TREE_DEF key so they'd never surface anyway), kept
  // as a defensive no-op.
  const depts = (rawDepts||[]).filter(d => d.category !== 'pre_clinical');
  const opds = rawOpds||[];
  const sc={}; (staffRows||[]).forEach(s=>{if(s.department_id)sc[s.department_id]=(sc[s.department_id]||0)+1;});
  // NCISM's clinical/pre-clinical/para-clinical classification is a BAMS teaching-curriculum
  // concept — only meaningful for teaching_hospital/college tenants (see Srishti Ayurveda,
  // a real pk_center that had every department mislabeled "Clinical" for this exact reason).
  const showAcademicBadge = isNCISMType(tRow?.type);

  const wrap=document.getElementById('dept-body');
  if(!depts?.length){
    wrap.innerHTML=`<div class="empty"><div class="empty-ico">🏥</div><div class="empty-ttl">No departments configured</div><div class="empty-bod">Go to <a href="bed-admin.html" style="color:var(--green-mid)">Dept &amp; Bed Setup</a> to add departments.</div></div>`;
    return;
  }

  // Session 96: same shared tree as NCISM Requirements / 🏥 Dept. Staff — "OPD" children now
  // come from the real opds table (OPD Setup), so a newly-added OPD shows up here too and
  // Shalakya shows its real 2-way split instead of one merged department.
  const tree = buildDeptTree(depts, opds);

  function _deptCard(d,isChild=false){
    const cat=d.category||'clinical';
    const catLabels={clinical:'Clinical',pre_clinical:'Pre-clinical',para_clinical:'Para-clinical',administrative:'Admin',diagnostic:'Diagnostic',support:'Support'};
    const sharedNote=isChild&&d._sharedWith?`<div class="dept-code" style="margin-top:2px">Shared faculty pool with ${_esc(d._sharedWith)}</div>`:'';
    return `<div class="dept-card${isChild?' dept-child':''}" style="cursor:pointer" data-onclick="openDeptDetail" data-onclick-a0="${d.id}">
      ${isChild?'<div class="dept-child-marker">↳ Sub-unit</div>':''}
      <div class="dept-top">
        ${showAcademicBadge?`<span class="cat-badge ${cat}">${catLabels[cat]||cat}</span>`:''}
        <div class="dept-name">${_esc(d.name)}</div>
        <div class="dept-code">${d.ncism_code?'NCISM: '+_esc(d.ncism_code):'No NCISM code'}</div>
        ${sharedNote}
      </div>
      <div class="dept-stats">
        <div class="dstat"><div class="dstat-num">${sc[d.id]||0}</div><div class="dstat-lbl">Staff</div></div>
        <div class="dstat"><div class="dstat-num" style="font-size:14px">${d.is_active===false?'✗ Off':'✓ Active'}</div><div class="dstat-lbl">Status</div></div>
        <div class="dstat"><div class="dstat-num">${d.pg_seats_sanctioned||'—'}</div><div class="dstat-lbl">PG Seats</div></div>
      </div>
    </div>`;
  }

  wrap.innerHTML=tree.map(({def,dept,children})=>{
    if(!dept){
      return `<div style="margin-bottom:18px;opacity:.6">
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:6px">${def.icon} ${_esc(def.label)}</div>
        <div class="empty" style="padding:14px"><div class="empty-bod">Not yet configured — click <strong>Seed HR Org Structure</strong> under Human Resources.</div></div>
      </div>`;
    }
    return `
    <div style="margin-bottom:18px">
      <div class="dept-grid">${_deptCard(dept,false)}</div>
      ${children.length?`
        <div class="dept-grid dept-children-grid" style="margin-top:6px;padding-left:24px">
          ${children.map(c=>_deptCard(c,true)).join('')}
        </div>`:''}
    </div>`;
  }).join('');
};

// ── Department Detail drill-down ─────────────────────────────────────
// Phase 1: click a Departments-tab card -> today's snapshot: staff &
// stakeholders, who's on duty (duty_roster), who's on leave today + who's
// covering for them (staff_leaves.covering_profile_id), and — for OPD-
// bearing depts — today's queue/completed counts against a prorated NCISM
// target (UG_BED_RATIOS, same source already relied on for bed seeding).
// Phase 2: a date-range picker below the snapshot showing curated activity
// for that range (OPD visits, IPD admissions/discharges, leave taken) —
// deliberately NOT a raw audit-log dump, and deliberately does not attempt
// staff join/transfer history (no clean queryable source for that yet).
const SHIFT_LABELS_DD = {morning:'Morning',afternoon:'Afternoon',night:'Night',on_call:'On-Call'};
const LEAVE_TYPE_LABELS_DD = {casual:'Casual',medical:'Medical/Sick',earned:'Earned/Annual',maternity:'Maternity',paternity:'Paternity',duty:'Duty/Official',other:'Other'};
let _ddCurrentDeptId = null;

window.openDeptDetail = async function(deptId){
  _ddCurrentDeptId = deptId;
  const modal = document.getElementById('dept-detail-modal');
  const body = document.getElementById('dd-body');
  document.getElementById('dd-title').textContent = 'Loading…';
  document.getElementById('dd-subtitle').textContent = '';
  document.getElementById('dd-live-badge').style.display = 'none';
  document.getElementById('dd-range-body').innerHTML = '';
  const todayStr = new Date().toISOString().slice(0,10);
  const weekAgoStr = new Date(Date.now()-6*86400000).toISOString().slice(0,10);
  document.getElementById('dd-range-from').value = weekAgoStr;
  document.getElementById('dd-range-to').value = todayStr;
  body.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';
  modal.style.display = 'flex';

  const opdIds = await _renderDeptSnapshot(deptId);
  _ddSubscribeRealtime(deptId, opdIds);
};

// Phase 3 — live updates. Subscribes to postgres_changes on the 3 tables that feed the
// snapshot (visits for OPD queue, duty_roster, staff_leaves) and re-runs the same snapshot
// render on any matching change, so the modal updates itself while open instead of needing
// a manual re-open. Same channel/removeChannel pattern already used by reception.js's Scan
// & Share flow — one modal open = one set of channels, torn down on close.
let _ddChannels = [];
function _ddSubscribeRealtime(deptId, opdIds){
  _ddChannels.forEach(ch=>supabase.removeChannel(ch));
  _ddChannels = [];
  const refresh = () => { if(_ddCurrentDeptId===deptId) _renderDeptSnapshot(deptId); };

  // One channel per opd_id (e.g. Shalakya has 2 — Netra + KNM) — postgres_changes filters
  // are simple eq comparisons, not IN lists, so each queue gets its own subscription.
  (opdIds||[]).forEach(opdId => {
    _ddChannels.push(
      supabase.channel('dept-detail-visits-'+deptId+'-'+opdId)
        .on('postgres_changes',{event:'*',schema:'public',table:'visits',filter:'opd_id=eq.'+opdId}, refresh)
        .subscribe()
    );
  });
  _ddChannels.push(
    supabase.channel('dept-detail-roster-'+deptId)
      .on('postgres_changes',{event:'*',schema:'public',table:'duty_roster',filter:'department_id=eq.'+deptId}, refresh)
      .subscribe()
  );
  // staff_leaves has no department_id column — filter by tenant, the callback just re-runs
  // the same department-scoped snapshot query so an unrelated tenant-wide leave is a harmless
  // no-op refresh rather than a missed update.
  _ddChannels.push(
    supabase.channel('dept-detail-leaves-'+deptId)
      .on('postgres_changes',{event:'*',schema:'public',table:'staff_leaves',filter:'tenant_id=eq.'+tenantId}, refresh)
      .subscribe()
  );
  document.getElementById('dd-live-badge').style.display = '';
}

// Renders the "today" snapshot into #dd-body — called once on open and again on every
// live update. Returns the department's opd_id (or null) so the caller can decide whether
// to open a visits subscription, without a second department fetch.
async function _renderDeptSnapshot(deptId){
  const body = document.getElementById('dd-body');
  const today = new Date().toISOString().slice(0,10);
  const todayStart = today + 'T00:00:00.000Z';
  const tomorrowStart = new Date(new Date(today+'T00:00:00Z').getTime() + 86400000).toISOString();

  const [{ data:dept }, { data:staff }, { data:roster }, { data:tRow }] = await Promise.all([
    supabase.from('departments').select('id,name,category,ncism_code,opd_id,pg_seats_sanctioned,is_active').eq('id',deptId).single(),
    supabase.from('profiles').select('id,full_name,role,designation').eq('tenant_id',tenantId).eq('department_id',deptId).eq('is_active',true).order('full_name'),
    supabase.from('duty_roster').select('profile_id,shift_type,is_confirmed').eq('tenant_id',tenantId).eq('department_id',deptId).eq('shift_date',today),
    supabase.from('tenants').select('opd_daily_target,type').eq('id',tenantId).single(),
  ]);

  if(!dept){ body.innerHTML = '<div class="empty"><div class="empty-ttl">Department not found.</div></div>'; return null; }

  const staffList = staff||[];
  const staffIds = staffList.map(s=>s.id);
  const rosterByProfile = {}; (roster||[]).forEach(r=>{ rosterByProfile[r.profile_id] = r; });

  const { data:leaves } = staffIds.length
    ? await supabase.from('staff_leaves')
        .select('profile_id,leave_type,covering:profiles!covering_profile_id(full_name,role)')
        .eq('tenant_id',tenantId).eq('status','approved')
        .lte('from_date',today).gte('to_date',today)
        .in('profile_id',staffIds)
    : { data: [] };
  const leavesByProfile = {}; (leaves||[]).forEach(l=>{ leavesByProfile[l.profile_id]=l; });

  // A department can run more than one physical OPD queue (e.g. Shalakya Tantra: one
  // combined department/bed-ward per Table-8, but two real Schedule XVIII OPD service
  // points — Netra + Karna-Nasa-Mukha). dept.opd_id is the "primary" queue; any other
  // opds rows nested via parent_department_id (the same column used for specialty-clinic
  // nesting) are additional queues that should count toward this department's totals.
  const { data:childOpds } = await supabase.from('opds').select('id').eq('parent_department_id',deptId);
  const opdIds = [dept.opd_id, ...(childOpds||[]).map(o=>o.id)].filter(Boolean);

  let queueHtml = '';
  if(opdIds.length){
    const { data:visits } = await supabase.from('visits')
      .select('status').eq('tenant_id',tenantId).in('opd_id',opdIds).eq('is_deleted',false)
      .gte('created_at',todayStart).lt('created_at',tomorrowStart);
    const counts = {waiting:0,in_progress:0,completed:0,incomplete:0};
    (visits||[]).forEach(v=>{ if(counts[v.status]!==undefined) counts[v.status]++; });
    const totalToday = (visits||[]).length;
    const ratio = dept.ncism_code ? UG_BED_RATIOS[dept.ncism_code] : null;
    const target = ratio ? Math.round((tRow?.opd_daily_target||0)*ratio) : null;
    const gap = target!=null ? Math.max(0,target-totalToday) : null;
    queueHtml = `<div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">🚪 OPD Queue Today</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px">
        <span style="background:#fef9ec;border:1px solid #f5c842;border-radius:8px;padding:4px 10px">⏳ Waiting: <strong>${counts.waiting}</strong></span>
        <span style="background:#e8f0ff;border:1px solid #b7cbf0;border-radius:8px;padding:4px 10px">🩺 In Progress: <strong>${counts.in_progress}</strong></span>
        <span style="background:#f0faf5;border:1px solid #b7dfc8;border-radius:8px;padding:4px 10px">✅ Completed: <strong>${counts.completed}</strong></span>
      </div>
      ${target!=null
        ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">Today's target (prorated from hospital-wide NCISM norm): <strong>${target}</strong> patients — ${gap>0?`<span style="color:#c0392b">${gap} more needed</span>`:`<span style="color:#2d7a4f">✅ target met</span>`}</div>`
        : `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">No per-department NCISM target ratio defined for this OPD — showing raw counts only.</div>`}
    </div>`;
  }

  const catLabels={clinical:'Clinical',pre_clinical:'Pre-clinical',para_clinical:'Para-clinical'};
  const showAcademicBadge = isNCISMType(tRow?.type);
  document.getElementById('dd-title').textContent = dept.name;
  document.getElementById('dd-subtitle').innerHTML =
    (dept.ncism_code?`${showAcademicBadge?`<span style="background:#f0f0f0;padding:2px 8px;border-radius:6px;margin-right:6px">${_esc(catLabels[dept.category]||dept.category||'—')}</span>`:''}NCISM: ${_esc(dept.ncism_code)} · `:'')
    + (dept.is_active?'✅ Active':'⛔ Inactive');

  const staffHtml = staffList.length ? staffList.map(s=>{
    const onLeave = leavesByProfile[s.id];
    const onDuty = rosterByProfile[s.id];
    let statusTag = '';
    if(onLeave){
      statusTag = `<span style="font-size:10.5px;color:#c0392b">🏖️ On leave (${_esc(LEAVE_TYPE_LABELS_DD[onLeave.leave_type]||onLeave.leave_type)})`
        + (onLeave.covering ? ` — charge: <strong>${_esc(onLeave.covering.full_name)}</strong>` : ' — <em>no handover specified</em>') + '</span>';
    } else if(onDuty){
      statusTag = `<span style="font-size:10.5px;color:#2d7a4f">🕐 On duty — ${_esc(SHIFT_LABELS_DD[onDuty.shift_type]||onDuty.shift_type)}${onDuty.is_confirmed?'':' (tentative)'}</span>`;
    } else {
      statusTag = `<span style="font-size:10.5px;color:var(--text-muted)">Not rostered today</span>`;
    }
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f0f4f2;font-size:13px">
      <span>${_esc(s.full_name)} <span style="color:var(--text-muted);font-size:11px">(${_esc(DESIG_MAP[s.designation]?.l||s.designation||s.role)})</span></span>
      ${statusTag}
    </div>`;
  }).join('') : '<div style="font-size:12px;color:var(--text-muted);padding:6px 0">No staff currently assigned to this department.</div>';

  const onLeaveCount = staffList.filter(s=>leavesByProfile[s.id]).length;
  const onDutyCount = staffList.filter(s=>rosterByProfile[s.id]).length;

  body.innerHTML = `
    ${queueHtml}
    <div>
      <div style="font-size:11px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px">👥 Staff &amp; Stakeholders (${staffList.length})</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${onDutyCount} on duty today · ${onLeaveCount} on leave today</div>
      ${staffHtml}
    </div>`;
  return opdIds;
}

window.closeDeptDetailModal = function(){
  _ddChannels.forEach(ch=>supabase.removeChannel(ch));
  _ddChannels = [];
  _ddCurrentDeptId = null;
  document.getElementById('dept-detail-modal').style.display = 'none';
};

// Phase 2 — curated activity for an admin-picked date range. Re-fetches the department/staff
// context fresh rather than reusing openDeptDetail()'s closure, so this can be called
// repeatedly (different ranges) without re-opening the modal.
window.applyDeptDateRange = async function(){
  const deptId = _ddCurrentDeptId;
  if(!deptId) return;
  const from = document.getElementById('dd-range-from').value;
  const to   = document.getElementById('dd-range-to').value;
  const rangeBody = document.getElementById('dd-range-body');
  if(!from || !to || to < from){ rangeBody.innerHTML = '<div style="font-size:12px;color:#c0392b">Select a valid range (From must not be after To).</div>'; return; }
  rangeBody.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">Loading…</div>';

  const fromStart = from+'T00:00:00.000Z';
  const toEnd = new Date(new Date(to+'T00:00:00Z').getTime()+86400000).toISOString();
  const dayCount = Math.round((new Date(to+'T00:00:00Z')-new Date(from+'T00:00:00Z'))/86400000)+1;

  const [{ data:dept }, { data:tRow }, { data:staff }] = await Promise.all([
    supabase.from('departments').select('opd_id,ncism_code').eq('id',deptId).single(),
    supabase.from('tenants').select('opd_daily_target').eq('id',tenantId).single(),
    supabase.from('profiles').select('id').eq('tenant_id',tenantId).eq('department_id',deptId),
  ]);
  const staffIds = (staff||[]).map(s=>s.id);

  let opdHtml = '';
  if(dept?.opd_id){
    const { data:visits } = await supabase.from('visits')
      .select('status').eq('tenant_id',tenantId).eq('opd_id',dept.opd_id).eq('is_deleted',false)
      .gte('created_at',fromStart).lt('created_at',toEnd);
    const counts = {waiting:0,in_progress:0,completed:0,incomplete:0};
    (visits||[]).forEach(v=>{ if(counts[v.status]!==undefined) counts[v.status]++; });
    const total = (visits||[]).length;
    const ratio = dept.ncism_code ? UG_BED_RATIOS[dept.ncism_code] : null;
    const target = ratio ? Math.round((tRow?.opd_daily_target||0)*ratio*dayCount) : null;
    opdHtml = `<div style="margin-bottom:10px">
      <div style="font-size:11px;font-weight:700;color:var(--green-deep);margin-bottom:4px">🚪 OPD Visits</div>
      <div style="font-size:12.5px">Registered: <strong>${total}</strong> · Completed: <strong>${counts.completed}</strong> · Incomplete: <strong>${counts.incomplete}</strong> · Still waiting/in-progress: <strong>${counts.waiting+counts.in_progress}</strong></div>
      ${target!=null?`<div style="font-size:11px;color:var(--text-muted);margin-top:2px">Prorated NCISM target for ${dayCount} day${dayCount>1?'s':''}: <strong>${target}</strong> ${total>=target?'<span style="color:#2d7a4f">✅ met</span>':`<span style="color:#c0392b">${target-total} short</span>`}</div>`:''}
    </div>`;
  }

  const { data:admissions } = await supabase.from('ipd_admissions')
    .select('status,admitted_at,discharged_at').eq('tenant_id',tenantId).eq('department_id',deptId)
    .or(`and(admitted_at.gte.${fromStart},admitted_at.lt.${toEnd}),and(discharged_at.gte.${fromStart},discharged_at.lt.${toEnd})`);
  const admittedInRange = (admissions||[]).filter(a=>a.admitted_at>=fromStart && a.admitted_at<toEnd).length;
  const dischargedInRange = (admissions||[]).filter(a=>a.discharged_at && a.discharged_at>=fromStart && a.discharged_at<toEnd).length;
  const ipdHtml = (admissions||[]).length ? `<div style="margin-bottom:10px">
    <div style="font-size:11px;font-weight:700;color:var(--green-deep);margin-bottom:4px">🛏️ IPD Admissions</div>
    <div style="font-size:12.5px">Admitted: <strong>${admittedInRange}</strong> · Discharged: <strong>${dischargedInRange}</strong></div>
  </div>` : '';

  let leaveHtml = '';
  if(staffIds.length){
    const { data:leaves } = await supabase.from('staff_leaves')
      .select('leave_type,from_date,to_date,profiles!profile_id(full_name),covering:profiles!covering_profile_id(full_name)')
      .eq('tenant_id',tenantId).eq('status','approved').in('profile_id',staffIds)
      .lte('from_date',to).gte('to_date',from);
    if((leaves||[]).length){
      leaveHtml = `<div>
        <div style="font-size:11px;font-weight:700;color:var(--green-deep);margin-bottom:4px">🏖️ Leave Taken</div>
        ${leaves.map(l=>`<div style="font-size:12px;padding:3px 0">${_esc(l.profiles?.full_name||'—')} — ${_esc(LEAVE_TYPE_LABELS_DD[l.leave_type]||l.leave_type)}, ${_fmtDD(l.from_date)}–${_fmtDD(l.to_date)}${l.covering?` (charge: ${_esc(l.covering.full_name)})`:''}</div>`).join('')}
      </div>`;
    }
  }

  const nothing = !opdHtml && !ipdHtml && !leaveHtml;
  rangeBody.innerHTML = nothing
    ? '<div style="font-size:12px;color:var(--text-muted)">No OPD visits, IPD admissions or leave recorded for this department in the selected range.</div>'
    : opdHtml + ipdHtml + leaveHtml;
};
function _fmtDD(d){ return d ? new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short'}) : '—'; }

// ────────────────────────────────────────────────
// SECTION 4 — INFRASTRUCTURE
// ────────────────────────────────────────────────
const NCISM_INFRA = {
  reception:[
    {item_name:'Reception & Enquiry Counter at prominent entrance',         category:'space',      ncism_ref:'Sch XVI - Sec 2(a)'},
    {item_name:'Registration & Billing Counters (adequate number)',         category:'space',      ncism_ref:'Sch XVI - Sec 3'},
    {item_name:'Medical Record Room',                                       category:'space',      ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Entrance Lobby with adequate seating',                      category:'space',      ncism_ref:'Sch XVI - Sec 12(b)'},
    {item_name:'Adequate circulation area for free movement',               category:'space',      ncism_ref:'Sch XVI - Sec 12(a)'},
    {item_name:'Computer with updated hospital services database',          category:'equipment',  ncism_ref:'Sch XVI - Sec 2(d)'},
    {item_name:'Intercom / call transfer facility to all departments',      category:'equipment',  ncism_ref:'Sch XVI - Sec 2(d)'},
    {item_name:'Suggestion / Complaint / Feedback Box',                    category:'equipment',  ncism_ref:'Sch XVI - Sec 2(f)'},
    {item_name:'Wheelchairs at entrance (adequate number)',                 category:'equipment',  ncism_ref:'Sch XVI - Sec 12(c)'},
    {item_name:'Stretchers at entrance (adequate number)',                  category:'equipment',  ncism_ref:'Sch XVI - Sec 12(c)'},
    {item_name:'Computerised central registration system linked to NCISM', category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'ABHA-compatible HMIS (patient authentication via ABHA)',   category:'digital',    ncism_ref:'Sch XVI - Sec 5–6'},
    {item_name:'NAMASTE terminology alignment',                            category:'digital',    ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'Multi-lingual receptionist(s)',                            category:'compliance', ncism_ref:'Sch XVI - Sec 2(b)'},
    {item_name:'Telephonic enquiry facility',                              category:'compliance', ncism_ref:'Sch XVI - Sec 2(c)'},
    // Schedule XVI — Minimum constructed area for Reception & Registration zone (Reg 39)
    {item_name:'Reception zone TOTAL — min 130 sqm (60) / 180 (100) / 230 (150) / 280 (200) [Sch XVI]', category:'space', ncism_ref:'Sch XVI - Area'},
    {item_name:'Reception and enquiry counter — min 3 sqm (60–100) / 5 (150) / 3 (200) [Sch XVI (a)]', category:'space', ncism_ref:'Sch XVI - Area (a)'},
    {item_name:'Reception and enquiry counter with PRO seating (optional) — min 6 sqm (60) / 8 (100) / 10 (150) / 12 (200) [Sch XVI (b)]', category:'space', ncism_ref:'Sch XVI - Area (b)'},
    {item_name:'Registration and billing counter — min 10 sqm (60) / 15 (100) / 15 (150) / 20 (200) [Sch XVI]', category:'space', ncism_ref:'Sch XVI - Area'},
    {item_name:'Medical record room with HMIS — min 10 sqm (all intakes) [Sch XVI]', category:'space', ncism_ref:'Sch XVI - Area'},
    {item_name:'Medical record room WITHOUT HMIS (incl. record technician accommodation) — min 25 sqm (all intakes) [Sch XVI]', category:'space', ncism_ref:'Sch XVI - Area'},
    // Section 39 + Table-7 — Minimum OPD Patient Attendance (student:patient ratio 1:2)
    {item_name:'OPD patient attendance: student-to-patient ratio maintained at 1:2 (NCISM mandatory) [Sec 39 / Table-7]', category:'compliance', ncism_ref:'Sec 39 / Table-7'},
    {item_name:'OPD minimum average patients/day — 120 (60-intake) / 200 (100) / 300 (150) / 400 (200) [Table-7]', category:'compliance', ncism_ref:'Table-7'},
    {item_name:'OPD attendance counted for 300 working days (12 months) per NCISM [Table-7 Note]', category:'compliance', ncism_ref:'Table-7'},
  ],
  screening_opd:[
    // Space & Area
    {item_name:'Triage / Screening counter at OPD zone entry',             category:'space',      ncism_ref:'Sch XVI - Sec 40(a)'},
    {item_name:'Examination cubicle(s) with curtain for privacy',          category:'space',      ncism_ref:'Sch XVI - Sec 40(b)'},
    {item_name:'Adequate waiting area with seating for screened patients', category:'space',      ncism_ref:'Sch XVI - Sec 40(c)'},
    {item_name:'Separate area for Emergency / Urgent triage cases',        category:'space',      ncism_ref:'Sch XVI - Sec 40(d)'},
    {item_name:'Hand-washing station / basin with soap & sanitiser',       category:'space',      ncism_ref:'Sch XVI - Sec 40(e)'},
    // Equipment
    {item_name:'Examination table (one per cubicle)',                      category:'equipment',  ncism_ref:'Sch XVI - Sec 40(f)'},
    {item_name:'Calibrated weighing scale',                                category:'equipment',  ncism_ref:'Sch XVI - Sec 40(g)'},
    {item_name:'Height measuring scale (stadiometer)',                     category:'equipment',  ncism_ref:'Sch XVI - Sec 40(g)'},
    {item_name:'Aneroid / digital BP apparatus',                          category:'equipment',  ncism_ref:'Sch XVI - Sec 40(h)'},
    {item_name:'Digital thermometer',                                      category:'equipment',  ncism_ref:'Sch XVI - Sec 40(h)'},
    {item_name:'Pulse oximeter (SpO₂)',                                    category:'equipment',  ncism_ref:'Sch XVI - Sec 40(h)'},
    {item_name:'Stethoscope',                                              category:'equipment',  ncism_ref:'Sch XVI - Sec 40(h)'},
    {item_name:'Pen torch / clinical torch',                               category:'equipment',  ncism_ref:'Sch XVI - Sec 40(h)'},
    {item_name:'Wheelchair and stretcher readily accessible',              category:'equipment',  ncism_ref:'Sch XVI - Sec 40(i)'},
    {item_name:'Biomedical waste bins (colour-coded)',                     category:'equipment',  ncism_ref:'Sch XVI - Sec 40(j)'},
    // Schedule XVIII #1 — NCISM minimum equipment (1 per screening cubicle/unit)
    {item_name:'Height and weight measuring tool — 1 per cubicle [Sch XVIII #1]',        category:'equipment',  ncism_ref:'Sch XVIII #1'},
    {item_name:'Non-mercurial sphygmomanometer — 1 per cubicle [Sch XVIII #1]',          category:'equipment',  ncism_ref:'Sch XVIII #1'},
    {item_name:'Clinical thermometer (non-contact) — 1 per cubicle [Sch XVIII #1]',      category:'equipment',  ncism_ref:'Sch XVIII #1'},
    {item_name:'Stethoscope — 1 per cubicle [Sch XVIII #1]',                              category:'equipment',  ncism_ref:'Sch XVIII #1'},
    {item_name:'Naadi recording equipment — 1 per cubicle [Sch XVIII #1 — Ayurveda specific]', category:'equipment', ncism_ref:'Sch XVIII #1'},
    // Digital & HMIS
    {item_name:'HMIS terminal for screening entry and routing',            category:'digital',    ncism_ref:'Sch XVI - Sec 40(k)'},
    {item_name:'Token / queue display system for patient call',            category:'digital',    ncism_ref:'Sch XVI - Sec 40(k)'},
    {item_name:'ABHA verification / Scan & Share QR facility',            category:'digital',    ncism_ref:'Sch XVI - Sec 40(l)'},
    // Compliance & Staffing
    {item_name:'Junior Resident / Medical Officer on duty at all times',   category:'compliance', ncism_ref:'Sch XVI - Sec 40(m)'},
    {item_name:'Minimum 1 Staff Nurse posted in Screening OPD',           category:'compliance', ncism_ref:'Sch XVI - Sec 40(m)'},
    {item_name:'Interns posted on rotation basis',                         category:'compliance', ncism_ref:'Sch XVI - Sec 40(n)'},
    {item_name:'Triage protocol chart displayed',                          category:'compliance', ncism_ref:'Sch XVI - Sec 40(o)'},
    {item_name:'Emergency escalation protocol displayed',                  category:'compliance', ncism_ref:'Sch XVI - Sec 40(o)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Screening OPD area — min 15 sqm (60) / 20 (100) / 30 (150) / 40 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  emergency_opd:[
    // Space & Area
    {item_name:'Dedicated Emergency bay accessible directly from main entrance (24x7)', category:'space', ncism_ref:'NCISM Sec 6(a)'},
    {item_name:'Resuscitation / crash bay with clear access',                           category:'space', ncism_ref:'NCISM Sec 6(f)'},
    {item_name:'Observation ward with beds (not counted as IPD beds)',                  category:'space', ncism_ref:'NCISM Sec 6(f)(g)'},
    {item_name:'Doctors duty room (24x7 residential facility)',                         category:'space', ncism_ref:'NCISM Sec 6(d)'},
    {item_name:'Nurses station adjacent to observation beds',                           category:'space', ncism_ref:'NCISM Sec 6(d)'},
    {item_name:'Waiting area for patient relatives',                                    category:'space', ncism_ref:'NCISM Sec 6(e)'},
    {item_name:'Ramp / accessible route for non-ambulant, elderly, disabled patients',  category:'space', ncism_ref:'NCISM Sec 6(e)'},
    // Equipment
    {item_name:'Emergency drug trolley / crash cart with essential drugs',              category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Ambu bag with face masks (adult + paediatric)',                        category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Suction machine (electric)',                                            category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Oxygen supply (piped or cylinders with regulator & flow meter)',        category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'IV stands and infusion sets',                                           category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'ECG machine',                                                           category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Glucometer with strips',                                                category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'BP apparatus + stethoscope',                                            category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Pulse oximeter (SpO₂)',                                                 category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Stretcher (motorised / manual)',                                        category:'equipment', ncism_ref:'Sch XIX-XX'},
    {item_name:'Wheelchair at emergency bay',                                           category:'equipment', ncism_ref:'NCISM Sec 6(e)'},
    // Digital & HMIS
    {item_name:'HMIS terminal for emergency registration (24x7)',                       category:'digital', ncism_ref:'NCISM Sec 6(k)'},
    {item_name:'ABHA verification facility at emergency counter',                       category:'digital', ncism_ref:'NCISM Sec 6(l)'},
    {item_name:'Emergency case register (digital with paper backup)',                   category:'digital', ncism_ref:'NCISM Sec 6(k)'},
    // Compliance & Staffing
    {item_name:'RMO / EMO / GDMO posted round-the-clock without gap',                  category:'compliance', ncism_ref:'NCISM Sec 6(d)'},
    {item_name:'Specialty consultants on-call roster displayed',                        category:'compliance', ncism_ref:'NCISM Sec 6(d)'},
    {item_name:'MBBS doctor appointed for emergency cover if required (NCISM provision)',category:'compliance', ncism_ref:'NCISM Sec 6(b)'},
    {item_name:'24x7 operation — no holiday for emergency unit',                        category:'compliance', ncism_ref:'NCISM Sec 6(c)'},
    {item_name:'Observation bed register maintained separately from IPD census',        category:'compliance', ncism_ref:'NCISM Sec 6(g)'},
    {item_name:'Emergency escalation and inter-departmental referral protocol',         category:'compliance', ncism_ref:'NCISM Sec 6(a)'},
    {item_name:'Ambulance with driver on standby',                                      category:'compliance', ncism_ref:'NCISM Sec 6(e)'},
    // Schedule XIX — NCISM minimum for Atyayika OPD + Observation Beds (60-intake minimum)
    {item_name:'Motorized bed 4-section with mattress — min 2 (60-intake) / 4 (150–200) [Sch XIX]', category:'equipment', ncism_ref:'Sch XIX #1'},
    {item_name:'Wheel chair — min 1 (60–100) / 2 (150–200) [Sch XIX]',               category:'equipment',  ncism_ref:'Sch XIX #2'},
    {item_name:'Bedside locker — min 2 (60-intake) / 4 (150–200) [Sch XIX]',         category:'equipment',  ncism_ref:'Sch XIX #3'},
    {item_name:'Over bed table — min 2 (60-intake) / 4 (150–200) [Sch XIX]',         category:'equipment',  ncism_ref:'Sch XIX #4'},
    {item_name:'IV stand (SS rod + castor base) — min 2 (60-intake) / 4 (150–200) [Sch XIX]', category:'equipment', ncism_ref:'Sch XIX #5'},
    {item_name:'Multi para monitor — min 2 (60-intake) / 4 (150–200) [Sch XIX]',     category:'equipment',  ncism_ref:'Sch XIX #7'},
    {item_name:'ICU ventilator — min 2 (60-intake) / 4 (150–200) [Sch XIX]',         category:'equipment',  ncism_ref:'Sch XIX #8'},
    {item_name:'Portable monitor — min 1 (60–100) / 3 (150–200) [Sch XIX]',          category:'equipment',  ncism_ref:'Sch XIX #9'},
    {item_name:'Portable ventilator — min 1 (60–100) / 2 (150–200) [Sch XIX]',       category:'equipment',  ncism_ref:'Sch XIX #10'},
    {item_name:'Portable X-ray — min 1 [Sch XIX]',                                   category:'equipment',  ncism_ref:'Sch XIX #11'},
    {item_name:'Patient stretcher — min 1 (60–100) / 2 (150–200) [Sch XIX]',         category:'equipment',  ncism_ref:'Sch XIX #12'},
    {item_name:'Dressing trolley — min 1 (60–100) / 2 (150–200) [Sch XIX]',          category:'equipment',  ncism_ref:'Sch XIX #13'},
    {item_name:'Drug trolley / medicine cart — min 1 (60–100) / 2 (150–200) [Sch XIX]', category:'equipment', ncism_ref:'Sch XIX #14'},
    {item_name:'ECG machine trolley — min 1 (60–100) / 2 (150–200) [Sch XIX]',       category:'equipment',  ncism_ref:'Sch XIX #15'},
    {item_name:'X-Ray view box — min 1 [Sch XIX]',                                   category:'equipment',  ncism_ref:'Sch XIX #16'},
    // Schedule XIX #17–24 — Emergency OPD additional items (Ayurveda-specific)
    {item_name:'Suction machine — min 1 (60–100) / 2 (150–200) [Sch XIX #17]',       category:'equipment',  ncism_ref:'Sch XIX #17'},
    {item_name:'Suturing set — min 2 (60–100) / 3–5 (150–200) [Sch XIX #18]',        category:'equipment',  ncism_ref:'Sch XIX #18'},
    {item_name:'Agnikarma kit — min 1 [Sch XIX #19 — Ayurveda Emergency]',            category:'equipment',  ncism_ref:'Sch XIX #19'},
    {item_name:'Dhuma yantra (medicated fumigation device) — min 1 (60–100) / 2 (150–200) [Sch XIX #20 — Ayurveda Emergency]', category:'equipment', ncism_ref:'Sch XIX #20'},
    {item_name:'Naadi recording equipment — min 1 (60–100) / 2 (150–200) [Sch XIX #21 — Ayurveda Emergency]', category:'equipment', ncism_ref:'Sch XIX #21'},
    {item_name:'Sthanik swedana yantra (local fomentation device) — min 1 (60–100) / 2 (150–200) [Sch XIX #22 — Ayurveda Emergency]', category:'equipment', ncism_ref:'Sch XIX #22'},
    {item_name:'Common diagnostic tools: non-mercury BP, stethoscope, torch, thermometer (non-contact), tongue depressor, weight/height stand, measuring tape — as required [Sch XIX #23]', category:'equipment', ncism_ref:'Sch XIX #23'},
    {item_name:'Emergency medicines stocked — as required [Sch XIX #24]',             category:'equipment',  ncism_ref:'Sch XIX #24'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Atyayika Chikitsa (Emergency) OPD area incl. observation beds — min 30 sqm (60–100) / 40 (150–200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  atyayika_icu:[
    // Atyayika Ward Intensive Care Unit — Schedule XIX items 25–57
    // Quantities: col 3=60-intake, col 4=100, col 5=150, col 6=200
    {item_name:'Motorised bed 4-section with mattress — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #25]', category:'equipment', ncism_ref:'Sch XIX ICU #25'},
    {item_name:'Wheel chair — min 2 (60–100) / 6 (150–200) [Sch XIX ICU #26]',       category:'equipment',  ncism_ref:'Sch XIX ICU #26'},
    {item_name:'Bedside locker — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #27]',    category:'equipment',  ncism_ref:'Sch XIX ICU #27'},
    {item_name:'Over bed table — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #28]',    category:'equipment',  ncism_ref:'Sch XIX ICU #28'},
    {item_name:'IV stand (SS rod + castor base) — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #29]', category:'equipment', ncism_ref:'Sch XIX ICU #29'},
    {item_name:'Foot step double — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #30]',  category:'equipment',  ncism_ref:'Sch XIX ICU #30'},
    {item_name:'Multi para monitor — min 4 (60–100) / 6 (150–200) [Sch XIX ICU #31]',category:'equipment',  ncism_ref:'Sch XIX ICU #31'},
    {item_name:'ICU ventilator — min 3 (60–100) / 5 (150–200) [Sch XIX ICU #32]',    category:'equipment',  ncism_ref:'Sch XIX ICU #32'},
    {item_name:'Portable monitor — min 2 (60–100) / 3 (150–200) [Sch XIX ICU #33]',  category:'equipment',  ncism_ref:'Sch XIX ICU #33'},
    {item_name:'Portable ventilator — min 1 (60–100) / 2 (150–200) [Sch XIX ICU #34]',category:'equipment', ncism_ref:'Sch XIX ICU #34'},
    {item_name:'Portable X-ray — min 1 [Sch XIX ICU #35]',                            category:'equipment',  ncism_ref:'Sch XIX ICU #35'},
    {item_name:'Patient stretcher — min 1 (60–100) / 2 (150–200) [Sch XIX ICU #36]', category:'equipment',  ncism_ref:'Sch XIX ICU #36'},
    {item_name:'Dressing trolley — min 1 [Sch XIX ICU #37]',                          category:'equipment',  ncism_ref:'Sch XIX ICU #37'},
    {item_name:'Drug trolley / medicine cart — min 1 [Sch XIX ICU #38]',              category:'equipment',  ncism_ref:'Sch XIX ICU #38'},
    {item_name:'ECG machine trolley — min 1 [Sch XIX ICU #39]',                       category:'equipment',  ncism_ref:'Sch XIX ICU #39'},
    {item_name:'X-Ray view box — min 1 [Sch XIX ICU #40]',                            category:'equipment',  ncism_ref:'Sch XIX ICU #40'},
    {item_name:'Suction machine — min 1 [Sch XIX ICU #41]',                           category:'equipment',  ncism_ref:'Sch XIX ICU #41'},
    {item_name:'ICU bed ventilator resuscitation equipment — min 1 [Sch XIX ICU #42]',category:'equipment',  ncism_ref:'Sch XIX ICU #42'},
    {item_name:'Oropharyngeal and nasopharyngeal airways — as required [Sch XIX ICU #43]', category:'equipment', ncism_ref:'Sch XIX ICU #43'},
    {item_name:'Endotracheal tube — as required [Sch XIX ICU #44]',                   category:'equipment',  ncism_ref:'Sch XIX ICU #44'},
    {item_name:'Defibrillator — min 1 (mandatory all intake levels) [Sch XIX ICU #45]',category:'equipment', ncism_ref:'Sch XIX ICU #45'},
    {item_name:'Oxygen cylinder with flow meter / tubing / face mask / nasal prongs — as required [Sch XIX ICU #46]', category:'equipment', ncism_ref:'Sch XIX ICU #46'},
    {item_name:'Suction apparatus — min 2 [Sch XIX ICU #47]',                        category:'equipment',  ncism_ref:'Sch XIX ICU #47'},
    {item_name:'Multipara monitor — min 1 [Sch XIX ICU #48]',                        category:'equipment',  ncism_ref:'Sch XIX ICU #48'},
    {item_name:'Nebulizer — min 1 [Sch XIX ICU #49]',                                category:'equipment',  ncism_ref:'Sch XIX ICU #49'},
    {item_name:'ICU consumables: gloves, IV set, infusion set, syringes, needles, urinary catheter, collection bags — as required [Sch XIX ICU #50]', category:'equipment', ncism_ref:'Sch XIX ICU #50'},
    {item_name:'Suturing set — min 1 [Sch XIX ICU #51]',                              category:'equipment',  ncism_ref:'Sch XIX ICU #51'},
    // Ayurveda-specific ICU items (unique to Ayurveda hospitals)
    {item_name:'Agnikarma kit — min 1 [Sch XIX ICU #52 — Ayurveda ICU]',             category:'equipment',  ncism_ref:'Sch XIX ICU #52'},
    {item_name:'Dhuma yantra (medicated fumigation) — min 1 [Sch XIX ICU #53 — Ayurveda ICU]', category:'equipment', ncism_ref:'Sch XIX ICU #53'},
    {item_name:'Naadi recording equipment — min 1 (60–100) / 2 (150–200) [Sch XIX ICU #54 — Ayurveda ICU]', category:'equipment', ncism_ref:'Sch XIX ICU #54'},
    {item_name:'Sthanik sweda yantra — min 1 [Sch XIX ICU #55 — Ayurveda ICU]',      category:'equipment',  ncism_ref:'Sch XIX ICU #55'},
    {item_name:'Common diagnostic tools (non-mercury BP, stethoscope, torch, thermometer, tongue depressor, weight/height) — as required [Sch XIX ICU #56]', category:'equipment', ncism_ref:'Sch XIX ICU #56'},
    {item_name:'Emergency medicines stocked — as required [Sch XIX ICU #57]',         category:'equipment',  ncism_ref:'Sch XIX ICU #57'},
    // Space & Compliance
    {item_name:'ICU area separate from general ward — restricted access',             category:'space',      ncism_ref:'Sch XIX ICU'},
    {item_name:'Nurses station within or adjacent to ICU bay',                        category:'space',      ncism_ref:'Sch XIX ICU'},
    {item_name:'24×7 ICU nurse coverage',                                             category:'compliance', ncism_ref:'Sch XIX ICU'},
    {item_name:'ICU register maintained — admission, daily status, outcome',          category:'digital',    ncism_ref:'Sch XIX ICU'},
    {item_name:'ICU bed not counted in IPD regular bed census (NCISM)',               category:'compliance', ncism_ref:'§47(g) + Sch XIX'},
    // Section 42(a) — Atyayikachikitsa ICU specific requirements
    {item_name:'ICU fully air-conditioned — mandatory [Sec 42(a)(ii)]',              category:'compliance', ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: easy access for emergency patients from OPD and ambulance bay [Sec 42(a)(ii)]', category:'compliance', ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: oxygen outlets and suction points at every ICU bed [Sec 42(a)(ii)]', category:'equipment', ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: connectivity to Operation Theatre [Sec 42(a)(ii)]',             category:'space',      ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: sufficient lighting at every bed [Sec 42(a)(ii)]',              category:'space',      ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: sufficient electrical points at every bed with suitable capacity [Sec 42(a)(ii)]', category:'space', ncism_ref:'Sec 42(a)(ii)'},
    {item_name:'ICU: nursing counter with necessary facilities inside the unit [Sec 42(a)(iii)]', category:'space', ncism_ref:'Sec 42(a)(iii)'},
    {item_name:'Head of Kayachikitsa dept = administrative head of Kayachikitsa ward AND Atyayika ICU [Sec 42(a)(i)]', category:'compliance', ncism_ref:'Sec 42(a)(i)'},
  ],
  preventive_opd:[
    // Space & Area
    {item_name:'Minimum 2 counselling cubicles with privacy (curtain / partition)',     category:'space',      ncism_ref:'NCISM Sec - Sch XVI(g)'},
    {item_name:'Prakriti / Saara assessment consultation room',                        category:'space',      ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Yoga and exercise hall (adequate space for group sessions)',            category:'space',      ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Waiting area with health promotion display boards',                    category:'space',      ncism_ref:'NCISM Sec - Sch XVI(a)'},
    {item_name:'Dedicated area for seasonal prophylaxis administration',               category:'space',      ncism_ref:'NCISM Sec - Sch XVI(f)'},
    // Equipment
    {item_name:'Weighing scale and height measure (anthropometric assessment)',        category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Prakriti / Saara assessment charts and reference forms',              category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Yoga mats (adequate number for group sessions)',                       category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Diet and nutrition counselling aids / food models',                   category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Seasonal prophylaxis drugs / herbal preparations (Rasayana)',         category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(f)'},
    {item_name:'Health education material (posters, pamphlets, display charts)',      category:'equipment',  ncism_ref:'NCISM Sec - Sch XVI(a)'},
    // Digital & HMIS
    {item_name:'HMIS terminal for counselling session records',                        category:'digital',    ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Swasthya Card generation module in HMIS',                             category:'digital',    ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Prakriti assessment digital form linked to patient record',            category:'digital',    ncism_ref:'NCISM Sec - Sch XVI(b)'},
    {item_name:'Employee health check-up register / tracking module',                 category:'digital',    ncism_ref:'NCISM Sec - Sch XVI(h)'},
    // Compliance & Staffing
    {item_name:'Swasthavritta has NO separate in-patient beds — consultants administer ritucharya / rejuvenation / health promotional therapies in collaboration with Panchakarma dept [Sec 42(d)]', category:'compliance', ncism_ref:'Sec 42(d)'},
    {item_name:'No prescription / no medicine dispensing protocol strictly enforced', category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(c)'},
    {item_name:'Intra-OPD referral protocol (receiving referrals from all OPDs)',     category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(d)'},
    {item_name:'IPD lifestyle consultation protocol (ward rounds advisory)',           category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(e)'},
    {item_name:'Seasonal prophylaxis calendar / epidemic preparedness protocol',      category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(f)'},
    {item_name:'Employee health check-up conducted periodically (annual minimum)',    category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(h)'},
    {item_name:'Swasthya Card issued to all registered healthy individuals',          category:'compliance', ncism_ref:'NCISM Sec - Sch XVI(b)'},
    // Schedule XVIII #10 — Equipment as per Kayachikitsa (NCISM)
    {item_name:'Equipment as per Kayachikitsa list — Sch XVIII #10 applies to Swasthavritta OPD', category:'compliance', ncism_ref:'Sch XVIII #10'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Swasthya Rakshana OPD area incl. counselling cubicles — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  kayachikitsa_opd:[
    // Space & Area
    {item_name:'Waiting area with adequate seating for OPD patients',                  category:'space',      ncism_ref:'Sch XVI - KAY(a)'},
    {item_name:'Minimum 2 consultation cubicles (one per doctor on duty)',             category:'space',      ncism_ref:'Sch XVI - KAY(b)'},
    {item_name:'Examination area within or adjacent to each cubicle',                 category:'space',      ncism_ref:'Sch XVI - KAY(b)'},
    {item_name:'Teaching / case demonstration area (colleges and hospitals)',          category:'space',      ncism_ref:'Sch XVI - KAY(c)'},
    // Equipment
    {item_name:'Examination table (one per cubicle)',                                  category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'BP apparatus (aneroid or digital)',                                    category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Stethoscope',                                                          category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Digital thermometer',                                                  category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Pulse oximeter (SpO₂)',                                                category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Weighing scale and height measure',                                    category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Percussion / reflex hammer',                                           category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Tuning fork (128 Hz and 512 Hz)',                                      category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Pen torch / ophthalmoscope (basic)',                                   category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Naadi pareeksha bolster / cushion',                                    category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Tongue depressor (sterile / disposable)',                              category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    {item_name:'Measuring tape (for abdominal girth, limb measurements)',             category:'equipment',  ncism_ref:'Sch XIX - KAY'},
    // Schedule XVIII #2 — NCISM minimum equipment with quantities
    {item_name:'X-Ray view box — min 1 [Sch XVIII #2]',                              category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Non-mercurial sphygmomanometer — min 2 [Sch XVIII #2]',              category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Stethoscope — min 2 [Sch XVIII #2]',                                 category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #2]',          category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Tongue depressor — min 2 [Sch XVIII #2]',                            category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Weight and height measuring stand — min 1 [Sch XVIII #2]',           category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Knee hammer — min 2 [Sch XVIII #2]',                                 category:'equipment',  ncism_ref:'Sch XVIII #2'},
    {item_name:'Torch — min 1 [Sch XVIII #2]',                                       category:'equipment',  ncism_ref:'Sch XVIII #2'},
    // Digital & HMIS
    {item_name:'HMIS terminal with NAMASTE-coded consultation notes',                  category:'digital',    ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'NAMC + ICD-10 dual-coded diagnosis entry in HMIS',                    category:'digital',    ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'Electronic prescription generation linked to pharmacy',               category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Investigation ordering linked to laboratory module',                  category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    // Compliance & Staffing
    {item_name:'NAMASTE-coded documentation mandatory for all consultations',          category:'compliance', ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'Prakriti-based treatment documentation in case notes',                category:'compliance', ncism_ref:'Sch XVI - KAY'},
    {item_name:'Doctor duty register maintained',                                      category:'compliance', ncism_ref:'Sch XVI - KAY'},
    {item_name:'PG teaching / case presentation schedule maintained (colleges)',       category:'compliance', ncism_ref:'Sch XVI - KAY(c)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Kaya Chikitsa OPD area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  panchakarma_opd:[
    // Space & Area
    {item_name:'Consultation room for PK OPD (separate from therapy rooms)',           category:'space',      ncism_ref:'Sch XVI - PK(a)'},
    {item_name:'Male therapy rooms — minimum 2 (NCISM mandatory)',                    category:'space',      ncism_ref:'Sch XVI - PK(b)'},
    {item_name:'Female therapy rooms — minimum 2 (NCISM mandatory)',                  category:'space',      ncism_ref:'Sch XVI - PK(b)'},
    {item_name:'Separate changing/dressing rooms (male and female)',                  category:'space',      ncism_ref:'Sch XVI - PK(c)'},
    {item_name:'Waiting area for PK patients',                                        category:'space',      ncism_ref:'Sch XVI - PK(a)'},
    {item_name:'Oil and medicine storage room (labelled, temperature-controlled)',    category:'space',      ncism_ref:'Sch XVI - PK(d)'},
    {item_name:'Utility and linen cleaning area',                                     category:'space',      ncism_ref:'Sch XVI - PK(d)'},
    {item_name:'Steam / Sweda room',                                                  category:'space',      ncism_ref:'Sch XIX - PK'},
    // Equipment
    {item_name:'Dharapathi Droni — wooden treatment trough/table (one per room)',     category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Steam chamber / Sweda yantra (Bashpa Sweda)',                         category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Shirodhara stand and vessel',                                         category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Oil heating equipment (double boiler / warmer)',                      category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Kizhi preparation materials (linen bags, herbs, sand)',               category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Basti yantra (enema equipment — Anuvasana and Niruha)',               category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Nasya administration set',                                            category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Weighing balance for measuring oils and medicines',                   category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Adequate linens and towels (regular laundry protocol)',               category:'equipment',  ncism_ref:'Sch XIX - PK'},
    {item_name:'Biomedical waste bins (colour-coded)',                                category:'equipment',  ncism_ref:'Sch XIX - PK'},
    // Digital & HMIS
    {item_name:'HMIS terminal for PK consultation and therapy scheduling',            category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Therapy session tracker linked to therapist module',                  category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Referral receipt and inter-department coordination module',           category:'digital',    ncism_ref:'Sch XVI - PK(e)'},
    {item_name:'Oil and material usage linked to inventory / pharmacy',               category:'digital',    ncism_ref:'Sch XVI - PK(d)'},
    // Compliance & Staffing
    {item_name:'Minimum 2 male + 2 female therapists posted (NCISM mandate)',         category:'compliance', ncism_ref:'Sch XVI - PK(b)'},
    {item_name:'Patient consent form obtained before each PK procedure',              category:'compliance', ncism_ref:'Sch XVI - PK(f)'},
    {item_name:'Coordination protocol with referring OPD consultant',                 category:'compliance', ncism_ref:'Sch XVI - PK(e)'},
    {item_name:'Therapy completion report communicated back to referring doctor',     category:'compliance', ncism_ref:'Sch XVI - PK(e)'},
    {item_name:'Phase-wise therapy record: Purvakarma → Pradhana → Paschatkarma',   category:'compliance', ncism_ref:'Sch XVI - PK(g)'},
    {item_name:'Paschatkarma (post-therapy) diet and lifestyle advice given',        category:'compliance', ncism_ref:'Sch XVI - PK(g)'},
    // §47 Procedural Management Zone — Panchakarma Therapy Section
    {item_name:'Bheshajagara (medicine prep room) with refrigerator + cooking/heating facility', category:'space', ncism_ref:'§47(a)(viii)'},
    {item_name:'Issue counter for medications — prevents movement into prep room',   category:'space',      ncism_ref:'§47(a)(ix)'},
    {item_name:'Separate clean (Shuchi) area and dirty (Mala) area with hot water supply', category:'space', ncism_ref:'§47(a)(x)'},
    {item_name:'Designated biomedical waste management place and mechanism',         category:'compliance', ncism_ref:'§47(a)(xi)'},
    {item_name:'Each therapy room: fully equipped for ALL PK procedures (numbered, not named by therapy)', category:'compliance', ncism_ref:'§47(a)(xiii)'},
    {item_name:'At least ONE room equipped for Kaumara Panchakarma (under Kaumarabhritya consultant)', category:'equipment', ncism_ref:'§47(a)(xiii)'},
    {item_name:'Snehapana cubicles: patient + PK specialist seating, wash basin, sphygmomanometer, stethoscope, thermometer', category:'equipment', ncism_ref:'§47(a)(xiv)'},
    {item_name:'Raktamokshana conducted ONLY in Anushastra Karma unit under aseptic conditions', category:'compliance', ncism_ref:'§47(a)(xv)'},
    {item_name:'Therapist periodic health check-ups — record of last check for each therapist', category:'compliance', ncism_ref:'§47(a)(xvi)'},
    {item_name:'Separate room for male therapists + separate room for female therapists — with personal lockers or pigeon hole almirahs, adequate seating arrangement, and attached toilets [Sec 44(xi)]', category:'space', ncism_ref:'Sec 44(xi)'},
    {item_name:'PK medicine store with adequate refrigeration storage',              category:'space',      ncism_ref:'§47(a)(xvii)'},
    {item_name:'Emergency medicine kit — available at all times + periodic replacement check to avoid expiry', category:'compliance', ncism_ref:'§47(a)(xviii)'},
    {item_name:'Pre-PK fitness consultation documented for every patient (NCISM §47(vii))', category:'compliance', ncism_ref:'§47(a)(vii)'},
    {item_name:'Post-PK fitness review consultation scheduled after all Paschatkarma sessions complete', category:'compliance', ncism_ref:'§47(a)(vii)'},
    {item_name:'Consultation room equipped: X-ray view box, ECG machine, Electrocardiogram recording facility, BP (non-mercury), stethoscope, thermometer (non-contact), weighing scale, measuring tape, knee hammer, torch [Sec 44(iii)]', category:'equipment', ncism_ref:'Sec 44(iii)'},
    {item_name:'Reception counter computerised with HMIS — weekly therapy schedule + duty consultant displayed', category:'digital', ncism_ref:'§47(a)(v)'},
    // Schedule XVIII #8 — Equipment as per Kayachikitsa (NCISM)
    {item_name:'Equipment as per Kayachikitsa list — Sch XVIII #8 applies to Panchakarma OPD', category:'compliance', ncism_ref:'Sch XVIII #8'},
    // Schedule XXV — PK Section: Reception and waiting
    {item_name:'PK Reception: Computer with internet — min 1 [Sch XXV #1]',          category:'equipment',  ncism_ref:'Sch XXV #1'},
    {item_name:'PK Reception: Printer — min 1 [Sch XXV #2]',                         category:'equipment',  ncism_ref:'Sch XXV #2'},
    {item_name:'PK Reception: Furniture for seating — as required [Sch XXV #3]',     category:'equipment',  ncism_ref:'Sch XXV #3'},
    // Schedule XXV — PK Consultation room
    {item_name:'PK Consultation room: Examination table — min 1 [Sch XXV #4]',       category:'equipment',  ncism_ref:'Sch XXV #4'},
    {item_name:'PK Consultation room: Non-mercurial BP — min 2 (60–100) / 4 (150–200) [Sch XXV #5]', category:'equipment', ncism_ref:'Sch XXV #5'},
    {item_name:'PK Consultation room: Stethoscope — min 2 (60–100) / 4 (150–200) [Sch XXV #6]', category:'equipment', ncism_ref:'Sch XXV #6'},
    {item_name:'PK Consultation room: X-ray view box — min 1 [Sch XXV #7]',          category:'equipment',  ncism_ref:'Sch XXV #7'},
    {item_name:'PK Consultation room: Clinical thermometer (non-contact) — min 2 (60–100) / 4 (150–200) [Sch XXV #8]', category:'equipment', ncism_ref:'Sch XXV #8'},
    {item_name:'PK Consultation room: Height and weight measuring scale — min 1 [Sch XXV #9]', category:'equipment', ncism_ref:'Sch XXV #9'},
    {item_name:'PK Consultation room: Measuring tape — min 1 (60–100) / 2 (150–200) [Sch XXV #10]', category:'equipment', ncism_ref:'Sch XXV #10'},
    {item_name:'PK Consultation room: Torch — min 1 (60–100) / 2 (150–200) [Sch XXV #11]', category:'equipment', ncism_ref:'Sch XXV #11'},
    {item_name:'PK Consultation room: Knee hammer — min 2 (60–100) / 4 (150–200) [Sch XXV #12]', category:'equipment', ncism_ref:'Sch XXV #12'},
    {item_name:'PK Consultation room: Tongue depressor — min 2 (60–100) / 4 (150–200) [Sch XXV #13]', category:'equipment', ncism_ref:'Sch XXV #13'},
    {item_name:'PK Consultation room: ECG (Electrocardiogram) — min 1 [Sch XXV #14 — mandatory for PK fitness assessment]', category:'equipment', ncism_ref:'Sch XXV #14'},
    // Schedule XXV — Preparation room (store + waste management)
    {item_name:'PK Prep room: Cooking facility — as required [Sch XXV #15]',         category:'equipment',  ncism_ref:'Sch XXV #15'},
    {item_name:'PK Prep room: Cooking ware — as required [Sch XXV #16]',             category:'equipment',  ncism_ref:'Sch XXV #16'},
    {item_name:'PK Prep room: Storage — as required [Sch XXV #17]',                  category:'equipment',  ncism_ref:'Sch XXV #17'},
    {item_name:'PK Prep room: Refrigerator — min 1 each intake level [Sch XXV #18]', category:'equipment',  ncism_ref:'Sch XXV #18'},
    {item_name:'PK Prep room: Mixer grinder — min 1 [Sch XXV #18]',                  category:'equipment',  ncism_ref:'Sch XXV #18'},
    {item_name:'PK Prep room: Microwave oven — min 1 [Sch XXV #18]',                 category:'equipment',  ncism_ref:'Sch XXV #18'},
    {item_name:'PK Prep room: Water filter — min 1 [Sch XXV #19]',                   category:'equipment',  ncism_ref:'Sch XXV #19'},
    {item_name:'PK Prep room: Trays and utensils for transporting prepared medicines to therapy rooms [Sch XXV #20]', category:'equipment', ncism_ref:'Sch XXV #20'},
    {item_name:'PK Prep room: Biomedical waste management — as per specifications [Sch XXV #21]', category:'compliance', ncism_ref:'Sch XXV #21'},
    // Section 44(v)(vi)(vii)(viii) — Medushajagara / Preparation room additional requirements
    {item_name:'PK Prep room: Exhaust or electric chimney for cooking/heating area [Sec 44(v)]', category:'equipment', ncism_ref:'Sec 44(v)'},
    {item_name:'PK Prep room: Counter to issue medications to therapy rooms — avoids frequent movement of people into prep room [Sec 44(vi)]', category:'space', ncism_ref:'Sec 44(vi)'},
    {item_name:'PK Prep room: Designated clean and dirty utility area — separate washing area with hot water supply for cleaning used items [Sec 44(vii)]', category:'space', ncism_ref:'Sec 44(vii)'},
    {item_name:'PK Prep room: Designated place and mechanism for biomedical waste management [Sec 44(viii)]', category:'compliance', ncism_ref:'Sec 44(viii)'},
    // Schedule XXV — Snehapana cubicle
    {item_name:'Snehapana cubicle: Furniture — as required [Sch XXV #22]',           category:'equipment',  ncism_ref:'Sch XXV #22'},
    {item_name:'Snehapana cubicle: Seating arrangement specifically for Panchakarma specialist or junior doctor [Sec 44(ix)]', category:'equipment', ncism_ref:'Sec 44(ix)'},
    {item_name:'Snehapana cubicle: Non-mercurial BP — min 4 (60) / 6 (100) / 8 (150) / 10 (200) [Sch XXV #23]', category:'equipment', ncism_ref:'Sch XXV #23'},
    {item_name:'Snehapana cubicle: Clinical thermometer — min 4/6/8/10 [Sch XXV #24]',category:'equipment',  ncism_ref:'Sch XXV #24'},
    {item_name:'Snehapana cubicle: Wash basin with water tap — min 4/6/8/10 [Sch XXV #25]', category:'equipment', ncism_ref:'Sch XXV #25'},
    {item_name:'Snehapana cubicle: Stethoscope — min 4/6/8/10 [Sch XXV #26]',        category:'equipment',  ncism_ref:'Sch XXV #26'},
    // Schedule XXV — Therapy rooms (critical PK-specific items with exact counts)
    {item_name:'Therapy room: Droni (treatment trough) — min 6 (60) / 8 (100) / 12 (150) / 16 (200) [Sch XXV #27]', category:'equipment', ncism_ref:'Sch XXV #27'},
    {item_name:'Therapy room: Dhara stand — min 6 (60) / 8 (100) / 12 (150) / 16 (200) [Sch XXV #28]', category:'equipment', ncism_ref:'Sch XXV #28'},
    {item_name:'Therapy room: Heating source — as required [Sch XXV #29]',           category:'equipment',  ncism_ref:'Sch XXV #29'},
    {item_name:'Therapy room: Non-mercurial BP with stand — min 6/8/12/16 [Sch XXV #30]', category:'equipment', ncism_ref:'Sch XXV #30'},
    {item_name:'Therapy room: Stethoscope — min 6/8/12/16 [Sch XXV #31]',            category:'equipment',  ncism_ref:'Sch XXV #31'},
    {item_name:'Therapy room: Foot step stand — min 6/8/12/16 [Sch XXV #32]',        category:'equipment',  ncism_ref:'Sch XXV #32'},
    {item_name:'Therapy room: Swedana facility (sarvanga + sthanika) — each 6/8/12/16 [Sch XXV #33]', category:'equipment', ncism_ref:'Sch XXV #33'},
    {item_name:'Therapy room: Kati/Janu/Griva/Prista/Hridbasti rings — as required [Sch XXV #34]', category:'equipment', ncism_ref:'Sch XXV #34'},
    {item_name:'Therapy room: Dhara patra (vessel) — min 6/8/12/16 [Sch XXV #35]',  category:'equipment',  ncism_ref:'Sch XXV #35'},
    {item_name:'Therapy room: Consumables (trays, vessels, catheters, udvarthana churna, gloves, cotton) — as required [Sch XXV #36]', category:'equipment', ncism_ref:'Sch XXV #36'},
    // Schedule XXIV — Minimum constructed area (Reg 47)
    {item_name:'PK Reception and waiting — min 15 sqm (60) / 20 (100) / 25 (150) / 30 (200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #1'},
    {item_name:'PK Consultation room — min 25 sqm (60–100) / 50 sqm×2 (150–200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #2'},
    {item_name:'PK Preparation/store/waste — min 50 sqm (60–100) / 75 sqm (150–200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #3'},
    {item_name:'PK Therapy rooms Male — min 90 sqm (30×3, 60-intake) / 120 (30×4) / 180 (30×6) / 240 (30×8) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #4'},
    {item_name:'PK Therapy rooms Female — min 90 sqm (30×3, 60-intake) / 120 (30×4) / 180 (30×6) / 240 (30×8) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #5'},
    {item_name:'PK Cubicles — min 20 sqm (5×4, 60-intake) / 30 (5×6) / 40 (5×8) / 50 (5×10) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #6'},
    {item_name:'PK Therapists room (M+F separate) — min 40 sqm (20×2) for all intakes [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV #7'},
    {item_name:'Panchakarma therapy section TOTAL — min 330 sqm (60) / 405 (100) / 590 (150) / 725 (200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV - PK Total'},
    // Schedule XVII — OPD zone area for PK OPD room only (Sch XXIV covers therapy section separately)
    {item_name:'Panchakarma OPD consultation room area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  shalya_opd:[
    // Space & Area
    {item_name:'Consultation room for Shalya OPD',                                    category:'space',      ncism_ref:'Sch XVI - SHY(a)'},
    {item_name:'Attached minor procedural room (for examination + minor surgery)',    category:'space',      ncism_ref:'Sch XVI - SHY(b)'},
    {item_name:'Instrument sterilization / autoclave area',                           category:'space',      ncism_ref:'Sch XVI - SHY(c)'},
    {item_name:'Patient changing/dressing cubicle (attached to procedural room)',     category:'space',      ncism_ref:'Sch XVI - SHY(b)'},
    {item_name:'Instrument cleaning and wash area',                                   category:'space',      ncism_ref:'Sch XVI - SHY(c)'},
    {item_name:'Waiting area for Shalya OPD patients',                               category:'space',      ncism_ref:'Sch XVI - SHY(a)'},
    // Equipment
    {item_name:'Examination table (consultation room)',                               category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Procedure table with OT light (minor procedural room)',               category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Minor surgical instrument set (scalpel, scissors, forceps, retractors)', category:'equipment', ncism_ref:'Sch XIX - SHY'},
    {item_name:'Kshara Sutra materials (alkaline thread, buttoned probe, sitz bath basin)', category:'equipment', ncism_ref:'Sch XIX - SHY'},
    {item_name:'Agni Karma set (Shalaka — metal probes for heat cautery)',            category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Suture materials (absorbable and non-absorbable)',                    category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Dressing materials (gauze, bandages, antiseptic)',                    category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Autoclave / sterilization unit',                                      category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Small suction machine',                                               category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'BP apparatus, stethoscope, pulse oximeter (pre-procedure assessment)',category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    {item_name:'Biomedical waste bins (sharps container + colour-coded bins)',        category:'equipment',  ncism_ref:'Sch XIX - SHY'},
    // Schedule XVIII #3 — NCISM minimum equipment with quantities
    {item_name:'X-Ray viewing box — min 1 [Sch XVIII #3]',                           category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Instruments for ano-rectal examination — as required [Sch XVIII #3]',category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Cheatle forceps — as required [Sch XVIII #3]',                       category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Non-mercurial sphygmomanometer — min 2 [Sch XVIII #3]',              category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #3]',          category:'equipment',  ncism_ref:'Sch XVIII #3'},
    // Schedule XVIII #3 — OPD-attached Minor OT
    {item_name:'Minor OT: Spot light — min 1 [Sch XVIII #3 Minor OT]',               category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Minor OT: Sterilizer — min 1 [Sch XVIII #3 Minor OT]',               category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Minor OT: Trolley — min 1 [Sch XVIII #3 Minor OT]',                  category:'equipment',  ncism_ref:'Sch XVIII #3'},
    {item_name:'Minor OT: Basic surgical instrument set (toothed forceps, artery forceps, scissors, Bald Parker handle, blade, suturing kit, proctoscope, catheter, syringes, kidney tray) — 1 set [Sch XVIII #3]', category:'equipment', ncism_ref:'Sch XVIII #3'},
    {item_name:'Minor OT: Consumables and medicines for OPD surgical procedures — as required [Sch XVIII #3]', category:'equipment', ncism_ref:'Sch XVIII #3'},
    // Digital & HMIS
    {item_name:'HMIS terminal for OPD consultation and procedure records',            category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Kshara Sutra follow-up tracker (weekly thread change schedule)',      category:'digital',    ncism_ref:'Sch XVI - SHY(d)'},
    {item_name:'Minor OT procedure register (digital)',                               category:'digital',    ncism_ref:'Sch XVI - SHY(e)'},
    // Compliance & Staffing
    {item_name:'Informed consent obtained before every procedure',                    category:'compliance', ncism_ref:'Sch XVI - SHY(f)'},
    {item_name:'Sterilization log maintained (date, method, instruments)',            category:'compliance', ncism_ref:'Sch XVI - SHY(c)'},
    {item_name:'Kshara Sutra weekly change register with thread details',             category:'compliance', ncism_ref:'Sch XVI - SHY(d)'},
    {item_name:'OPD minor surgical register (case, procedure, outcome)',              category:'compliance', ncism_ref:'Sch XVI - SHY(e)'},
    {item_name:'OT Technician posted for minor procedural room',                      category:'compliance', ncism_ref:'Sch XVI - SHY(b)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Shalya Chikitsa OPD area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
    {item_name:'Procedural room / Minor OT for OPD — min 20 sqm (60–100) / 30 (150–200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  shalakya_netra_opd:[
    // Space & Area
    {item_name:'Consultation room with dark room examination area',                    category:'space',      ncism_ref:'Sch XVI - NET(a)'},
    {item_name:'Vision testing lane (minimum 6 metres for visual acuity chart)',      category:'space',      ncism_ref:'Sch XVI - NET(b)'},
    {item_name:'Netra Kriya Kalpa (ophthalmic procedure) room',                       category:'space',      ncism_ref:'Sch XVI - NET(c)'},
    {item_name:'Waiting area for ophthalmic patients',                                category:'space',      ncism_ref:'Sch XVI - NET(a)'},
    // Equipment
    {item_name:'Snellen chart / illuminated visual acuity chart',                     category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Trial lens box + trial frame',                                        category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Slit lamp (biomicroscope)',                                            category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Direct + indirect ophthalmoscope',                                    category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Tonometer (Schiotz or non-contact air puff)',                         category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Colour vision chart (Ishihara plates)',                               category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Pinhole occluder',                                                    category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Fluorescein strips + cobalt blue filter',                             category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Netra Tarpana vessel (medicated eye bath trough)',                    category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Anjana application set (collyrium rod/applicator)',                   category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Eye irrigation syringe + saline (eye wash)',                          category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Lacrimal syringing set',                                              category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Foreign body removal set (needle, slit lamp)',                        category:'equipment',  ncism_ref:'Sch XIX - NET'},
    {item_name:'Pen torch + magnifying loupe',                                        category:'equipment',  ncism_ref:'Sch XIX - NET'},
    // Schedule XVIII #4 — NCISM minimum equipment with quantities
    {item_name:'Auto refractometer — min 1 [Sch XVIII #4]',                          category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Ophthalmoscope — min 2 [Sch XVIII #4]',                              category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Applanation tonometer — min 1 [Sch XVIII #4]',                       category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Fundoscope — min 2 [Sch XVIII #4]',                                  category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Humphrey visual field analyser — min 1 [Sch XVIII #4]',              category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Slit lamp — min 1 [Sch XVIII #4]',                                   category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'X-Ray viewing box — min 1 [Sch XVIII #4]',                           category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Non-mercurial sphygmomanometer — min 2 [Sch XVIII #4]',              category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Stethoscope — min 2 [Sch XVIII #4]',                                 category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #4]',          category:'equipment',  ncism_ref:'Sch XVIII #4'},
    {item_name:'Torch — min 2 [Sch XVIII #4]',                                       category:'equipment',  ncism_ref:'Sch XVIII #4'},
    // Digital & HMIS
    {item_name:'HMIS terminal for ophthalmic consultation records',                   category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Visual acuity recording (OD / OS / OU) in consultation notes',       category:'digital',    ncism_ref:'Sch XVI - NET(d)'},
    {item_name:'Netra Kriya Kalpa session tracker linked to therapy module',         category:'digital',    ncism_ref:'Sch XVI - NET(c)'},
    // Compliance & Staffing
    {item_name:'Dark room protocol followed for all fundus examinations',             category:'compliance', ncism_ref:'Sch XVI - NET(a)'},
    {item_name:'Patient consent obtained before Kriya Kalpa procedures',             category:'compliance', ncism_ref:'Sch XVI - NET(c)'},
    {item_name:'Instrument sterilization protocol for ophthalmic instruments',       category:'compliance', ncism_ref:'Sch XVI - NET(e)'},
    {item_name:'Referral protocol for surgical cases (cataract, retinal, glaucoma)', category:'compliance', ncism_ref:'Sch XVI - NET(f)'},
    {item_name:'Ophthalmic Technician posted for vision testing',                    category:'compliance', ncism_ref:'Sch XVI - NET(b)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Shalakya Chikitsa (Netra) OPD area — min 25 sqm (60) / 30 (100) / 45 (150) / 30×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  shalakya_ent_opd:[
    // Space & Area
    {item_name:'Consultation room with ENT examination setup',                        category:'space',      ncism_ref:'Sch XVI - KNM(a)'},
    {item_name:'Kriya Kalpa procedure room (Karna Pooran, Nasya, Gandusha)',         category:'space',      ncism_ref:'Sch XVI - KNM(b)'},
    {item_name:'Minor procedure area (nasal packing, ear syringing, throat)',        category:'space',      ncism_ref:'Sch XVI - KNM(c)'},
    {item_name:'Waiting area for ENT patients',                                      category:'space',      ncism_ref:'Sch XVI - KNM(a)'},
    // Equipment
    {item_name:'ENT diagnostic set (otoscope, nasal speculum, tongue depressor)',    category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Headlight / forehead mirror',                                        category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Tuning forks — 256 Hz and 512 Hz (Rinne + Weber tests)',             category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Indirect laryngoscope (laryngeal mirror set)',                       category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Ear syringing set (wax removal)',                                    category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Karna Pooran set (ear oil instillation vessel + dropper)',           category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Nasya administration set (nasal drop applicator)',                   category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Gandusha / Kavala preparation vessels',                              category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Dhumapana set (medicated inhalation pipe)',                          category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Foreign body removal forceps (ear, nose, throat)',                   category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Suction machine + Yankauer tip',                                     category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Epistaxis management set (nasal packing + cautery)',                 category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'BP apparatus + pen torch',                                           category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    {item_name:'Biomedical waste bins (colour-coded)',                               category:'equipment',  ncism_ref:'Sch XIX - KNM'},
    // Schedule XVIII #5 — NCISM minimum equipment with quantities
    {item_name:'Tuning forks — min 5 [Sch XVIII #5]',                               category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Auroscope — min 5 [Sch XVIII #5]',                                  category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Puretone Audiometer — min 1 [Sch XVIII #5]',                        category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Tongue depressor, Nasal speculum, Nasal packing forceps — 5 each [Sch XVIII #5]', category:'equipment', ncism_ref:'Sch XVIII #5'},
    {item_name:'Ear, nose, throat kit — min 1 [Sch XVIII #5]',                      category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Head set for light focus — min 1 [Sch XVIII #5]',                   category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'X-Ray viewing box — min 1 [Sch XVIII #5]',                          category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Non-mercurial sphygmomanometer — min 2 [Sch XVIII #5]',             category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Stethoscope — min 2 [Sch XVIII #5]',                                category:'equipment',  ncism_ref:'Sch XVIII #5'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #5]',         category:'equipment',  ncism_ref:'Sch XVIII #5'},
    // Digital & HMIS
    {item_name:'HMIS terminal for ENT consultation and procedure records',           category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Hearing assessment records (OD/OS — tuning fork + whisper test)',    category:'digital',    ncism_ref:'Sch XVI - KNM(d)'},
    {item_name:'Kriya Kalpa session tracker for ENT procedures',                     category:'digital',    ncism_ref:'Sch XVI - KNM(b)'},
    // Compliance & Staffing
    {item_name:'Patient consent obtained before each Kriya Kalpa procedure',        category:'compliance', ncism_ref:'Sch XVI - KNM(e)'},
    {item_name:'Instrument sterilization protocol for ENT instruments',             category:'compliance', ncism_ref:'Sch XVI - KNM(f)'},
    {item_name:'Referral protocol for surgical cases (tonsil, septum, mastoid)',    category:'compliance', ncism_ref:'Sch XVI - KNM(g)'},
    {item_name:'ENT Technician posted for diagnostic and procedure support',        category:'compliance', ncism_ref:'Sch XVI - KNM(b)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Shalakya Chikitsa (Karna Naasa Mukha) OPD area — min 20 sqm (60) / 30 (100) / 45 (150) / 30×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  prasuti_streeroga_opd:[
    // Space & Area
    {item_name:'Consultation room for Obs/Gyn OPD',                                   category:'space',      ncism_ref:'Sch XVI - PSR(a)'},
    {item_name:'Attached examination room with privacy curtains (NCISM mandatory)',   category:'space',      ncism_ref:'Sch XVI - PSR(b)'},
    {item_name:'Dedicated toilet facility for patients (NCISM mandatory)',            category:'space',      ncism_ref:'Sch XVI - PSR(c)'},
    {item_name:'If two OPDs: separate examination rooms for Prasuti and Streeroga',  category:'space',      ncism_ref:'Sch XVI - PSR(d)'},
    {item_name:'Waiting area with adequate seating',                                  category:'space',      ncism_ref:'Sch XVI - PSR(a)'},
    // Equipment
    {item_name:'Obstetric examination table with stirrups + privacy screen',          category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Weighing scale (maternal weight tracking)',                           category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'BP apparatus + stethoscope',                                          category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Fetoscope / Doppler (for FHS auscultation)',                          category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Measuring tape (fundal height measurement)',                          category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Pelvimeter (clinical pelvimetry)',                                    category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Gynaecological set (Cusco speculum, Sim speculum, uterine sound)',   category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Urine dipstick test kit (proteinuria, glucose — ANC screening)',     category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Glucometer with strips (GDM screening)',                              category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Sterile gloves and dressing materials (adequate supply)',             category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Pelvic anatomical model (for patient education and teaching)',        category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    {item_name:'Biomedical waste bins (colour-coded)',                                category:'equipment',  ncism_ref:'Sch XIX - PSR'},
    // Digital & HMIS
    {item_name:'HMIS terminal for Obs/Gyn consultation records',                      category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Antenatal card (ANC) linked to patient ABHA record in HMIS',        category:'digital',    ncism_ref:'Sch XVI - PSR(e)'},
    {item_name:'Obstetric history fields: LMP, EDD, Gravida/Para/Abortion/Living',  category:'digital',    ncism_ref:'Sch XVI - PSR(e)'},
    // Compliance & Staffing
    {item_name:'Female doctor or female staff present during all examinations',      category:'compliance', ncism_ref:'Sch XVI - PSR(f)'},
    {item_name:'Patient privacy and confidentiality protocol strictly followed',     category:'compliance', ncism_ref:'Sch XVI - PSR(f)'},
    {item_name:'ANC card maintained and updated at every antenatal visit',           category:'compliance', ncism_ref:'Sch XVI - PSR(e)'},
    {item_name:'High-risk pregnancy referral protocol in place',                     category:'compliance', ncism_ref:'Sch XVI - PSR(g)'},
    {item_name:'If two OPDs: dedicated consultants — no rotation between Prasuti and Streeroga OPDs (NCISM)',category:'compliance',ncism_ref:'Sch XVI - PSR(d)'},
    {item_name:'ANM posted for antenatal and post-natal care support',               category:'compliance', ncism_ref:'Sch XVI - PSR(h)'},
    // §47(e) Prasuti & Streeroga Procedural Room
    {item_name:'Procedural room common for OPD and IPD (§47(e))',                    category:'space',      ncism_ref:'§47(e)(i)'},
    {item_name:'Head of Prasuti & Streeroga dept = administrative head of this unit',category:'compliance', ncism_ref:'§47(f)'},
    // §47(g) Yoni procedures
    {item_name:'Adequate space and equipment for Yoni Pichu (oil-soaked cotton placement)', category:'space', ncism_ref:'§47(g)'},
    {item_name:'Adequate space and equipment for Yoni Dhupana (medicated fumigation)', category:'space',    ncism_ref:'§47(g)'},
    {item_name:'Adequate space and equipment for Yoni Purana (vaginal packing with herbal formulations)', category:'space', ncism_ref:'§47(g)'},
    {item_name:'Yoni Prakshalan (medicated douche) facility',                        category:'space',      ncism_ref:'§47(g)'},
    {item_name:'Sterile disposables for Yoni procedures (gloves, applicators, cotton, herbal oils)', category:'equipment', ncism_ref:'§47(g)'},
    {item_name:'Privacy screens / curtains for all procedural areas',                category:'space',      ncism_ref:'§47(g)'},
    // Schedule XXIV — Minimum area
    {item_name:'Prasuti-Streeroga procedural room area — min 30 sqm (60–100) / 30×2 sqm (150–200) [Sch XXIV #12]', category:'space', ncism_ref:'Sch XXIV #12'},
    // Schedule XVIII #6 — NCISM minimum equipment with quantities
    {item_name:'Weighing machine — min 2 [Sch XVIII #6]',                            category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Sims\'s speculum — min 5 [Sch XVIII #6]',                            category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Cusco\'s speculum — min 5 [Sch XVIII #6]',                           category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #6]',          category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Measuring tape — min 2 [Sch XVIII #6]',                              category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'X-Ray view box — min 1 [Sch XVIII #6]',                              category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Non-mercurial sphygmomanometer — min 2 [Sch XVIII #6]',              category:'equipment',  ncism_ref:'Sch XVIII #6'},
    {item_name:'Stethoscope — min 2 [Sch XVIII #6]',                                 category:'equipment',  ncism_ref:'Sch XVIII #6'},
    // Schedule XXVII #7-13 — Prasuti Tantra and Stree Roga Procedural Room (Reg 47)
    {item_name:'Procedural room: Computer with internet and printer — min 1 [Sch XXVII #7]', category:'equipment', ncism_ref:'Sch XXVII #7'},
    {item_name:'Procedural room: Examination table — min 1 [Sch XXVII #8]',          category:'equipment',  ncism_ref:'Sch XXVII #8'},
    {item_name:'Procedural room: Spot light — min 1 [Sch XXVII #9]',                 category:'equipment',  ncism_ref:'Sch XXVII #9'},
    {item_name:'Procedural room: Sterilizer — min 1 [Sch XXVII #10]',                category:'equipment',  ncism_ref:'Sch XXVII #10'},
    {item_name:'Procedural room: Trolley — min 1 [Sch XXVII #11]',                   category:'equipment',  ncism_ref:'Sch XXVII #11'},
    {item_name:'Procedural room: Basic instruments set (Sim\'s speculum, Cusco\'s speculum, suturing kit, proctoscope, catheter, syringes, kidney trays) — min 1 set [Sch XXVII #12]', category:'equipment', ncism_ref:'Sch XXVII #12'},
    {item_name:'Procedural room: Consumables and medicines for Yoni procedures (Yogi Pichu, Yoni Dhoopana, Yoni Prakshalana) — as required [Sch XXVII #13]', category:'equipment', ncism_ref:'Sch XXVII #13'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Prasuti-Streeroga OPD area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
    {item_name:'Prasuti-Streeroga procedural rooms (02 rooms, one each for Prasuti and Streeroga) — min 20 sqm (60–100) / 30 (150) / 20×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  kaumarabhritya_opd:[
    // Space & Area
    {item_name:'Consultation room for Kaumarabhritya OPD',                            category:'space',      ncism_ref:'Sch XVI - KBR(a)'},
    {item_name:'Examination area adjacent to consultation room',                      category:'space',      ncism_ref:'Sch XVI - KBR(a)'},
    {item_name:'Child-friendly waiting area (play area or child-appropriate décor)',  category:'space',      ncism_ref:'Sch XVI - KBR(b)'},
    {item_name:'Breastfeeding / lactation room for mothers of infants',               category:'space',      ncism_ref:'Sch XVI - KBR(c)'},
    {item_name:'Child-accessible toilet facility',                                    category:'space',      ncism_ref:'Sch XVI - KBR(c)'},
    // Equipment
    {item_name:'Pediatric examination table',                                         category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Infant weighing scale (100g precision)',                              category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Infantometer (length measuring board for infants)',                   category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Standing height measure (stadiometer for toddlers+)',                 category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Head circumference tape (Lasso-o / flexible tape)',                   category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Pediatric BP cuff set (infant, child, adolescent sizes)',             category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Pediatric stethoscope',                                               category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Pulse oximeter with pediatric probe',                                 category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Digital thermometer (axillary / rectal for neonates)',                category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Growth chart (WHO / IAP — height, weight, HC, BMI for age)',         category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Pediatric reflex hammer + pen torch',                                 category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Otoscope + ophthalmoscope with pediatric speculum',                  category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    {item_name:'Tongue depressor (disposable)',                                       category:'equipment',  ncism_ref:'Sch XIX - KBR'},
    // Schedule XVIII #7 — NCISM minimum equipment with quantities (Kaumarabhritya)
    {item_name:'Non-mercurial sphygmomanometer WITH PEDIATRIC CUFF — min 2 [Sch XVIII #7]', category:'equipment', ncism_ref:'Sch XVIII #7'},
    {item_name:'Neonatal weighing scale — min 1 [Sch XVIII #7]',                     category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Pediatric weighing scale — min 1 [Sch XVIII #7]',                    category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Infantometer — as required [Sch XVIII #7]',                          category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Height measurement scale — min 1 [Sch XVIII #7]',                   category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Pediatric stethoscope — min 2 [Sch XVIII #7]',                       category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Oroscope (Otoscope) — min 5 [Sch XVIII #7]',                         category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Bilirubinometer — min 2 [Sch XVIII #7 — neonatal jaundice assessment]', category:'equipment', ncism_ref:'Sch XVIII #7'},
    {item_name:'Knee hammer — min 2 [Sch XVIII #7]',                                 category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Tongue depressors — min 5 [Sch XVIII #7]',                           category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'X-Ray view box — min 1 [Sch XVIII #7]',                              category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Clinical thermometer (non-contact) — min 2 [Sch XVIII #7]',          category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Measuring tapes — min 2 [Sch XVIII #7]',                             category:'equipment',  ncism_ref:'Sch XVIII #7'},
    {item_name:'Torch — min 1 [Sch XVIII #7]',                                       category:'equipment',  ncism_ref:'Sch XVIII #7'},
    // Digital & HMIS
    {item_name:'HMIS terminal with age-adjusted vital normal ranges displayed',       category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Immunization record linked to patient profile in HMIS',              category:'digital',    ncism_ref:'Sch XVI - KBR(d)'},
    {item_name:'Growth chart module (height/weight/HC plotted against age)',         category:'digital',    ncism_ref:'Sch XVI - KBR(e)'},
    {item_name:'Pediatric drug dosage calculator (weight-based) in HMIS',           category:'digital',    ncism_ref:'Sch XVI - KBR(f)'},
    // Compliance & Staffing
    {item_name:'Parent / Guardian consent obtained before all procedures',           category:'compliance', ncism_ref:'Sch XVI - KBR(g)'},
    {item_name:'Age verification at OPD registration (0–18 years only)',             category:'compliance', ncism_ref:'Sch XVI - KBR(a)'},
    {item_name:'Immunization record updated at every visit',                         category:'compliance', ncism_ref:'Sch XVI - KBR(d)'},
    {item_name:'Growth monitoring and developmental milestone assessment done',      category:'compliance', ncism_ref:'Sch XVI - KBR(e)'},
    {item_name:'Breastfeeding counselling provided for mothers of infants',          category:'compliance', ncism_ref:'Sch XVI - KBR(c)'},
    {item_name:'Child protection / safeguarding protocol in place',                  category:'compliance', ncism_ref:'Sch XVI - KBR(h)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Kaumarabhritya OPD area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  agadatantra_opd:[
    // Space & Area
    {item_name:'Consultation room for Visha Chikitsa OPD',                            category:'space',      ncism_ref:'Sch XVI - AGD(a)'},
    {item_name:'Observation area for bite/sting patients (post-treatment monitoring)',category:'space',      ncism_ref:'Sch XVI - AGD(b)'},
    {item_name:'Procedure area (antidote administration, Vamana/Virechana detox)',   category:'space',      ncism_ref:'Sch XVI - AGD(c)'},
    {item_name:'Antidote and medicine storage (temperature-controlled)',              category:'space',      ncism_ref:'Sch XVI - AGD(d)'},
    {item_name:'Waiting area',                                                        category:'space',      ncism_ref:'Sch XVI - AGD(a)'},
    // Equipment
    {item_name:'Examination table + BP apparatus, stethoscope, pulse oximeter',      category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Tourniquet and pressure immobilisation bandage (bite first aid)',     category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Emergency drug kit (atropine, antihistamine, adrenaline — anaphylaxis)',category:'equipment',ncism_ref:'Sch XIX - AGD'},
    {item_name:'Oxygen supply with mask + suction machine (respiratory emergency)',  category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'IV access kit (cannula, IV fluids, infusion set)',                   category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Glucometer (systemic toxicity monitoring)',                           category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Vamana set (therapeutic emesis equipment for Ayurveda detox)',       category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Antidote preparation area (Shirisha, Manashila, Haritaki preparations)', category:'equipment', ncism_ref:'Sch XIX - AGD'},
    {item_name:'Snake / insect / scorpion identification chart',                     category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Forensic specimen collection kit (for medico-legal poisoning cases)',category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    {item_name:'Biomedical waste bins (colour-coded)',                               category:'equipment',  ncism_ref:'Sch XIX - AGD'},
    // Schedule XVIII #9 — Equipment as per Kayachikitsa (NCISM)
    {item_name:'Equipment as per Kayachikitsa list — Sch XVIII #9 applies to Visha Chikitsa/Agada OPD', category:'compliance', ncism_ref:'Sch XVIII #9'},
    // Digital & HMIS
    {item_name:'HMIS terminal for consultation and poison case records',              category:'digital',    ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Poison case register (medico-legal statutory register — separate from OPD register)', category:'digital', ncism_ref:'Sch XVI - AGD(e)'},
    {item_name:'Visha classification fields: type (Sthavara/Jangama/Kritima), Dushivisha/Garavisha, route, severity', category:'digital', ncism_ref:'Sch XVI - AGD(f)'},
    {item_name:'Emergency escalation link to Atyayika Chikitsa for deteriorating cases', category:'digital', ncism_ref:'Sch XVI - AGD(g)'},
    // Compliance & Staffing
    {item_name:'Poison case register maintained — statutory medico-legal requirement',category:'compliance', ncism_ref:'Sch XVI - AGD(e)'},
    {item_name:'Mandatory reporting to police / authorities for suspicious poisoning', category:'compliance', ncism_ref:'Sch XVI - AGD(h)'},
    {item_name:'Emergency escalation protocol to Atyayika / higher centre',          category:'compliance', ncism_ref:'Sch XVI - AGD(g)'},
    {item_name:'Coordination protocol with Kayachikitsa for systemic complications', category:'compliance', ncism_ref:'Sch XVI - AGD(i)'},
    {item_name:'Antidote storage and expiry monitoring protocol',                    category:'compliance', ncism_ref:'Sch XVI - AGD(d)'},
    // Section 42(b) — Visha Chikitsa Ward authority
    {item_name:'Visha Chikitsa Ward under administrative control of Agadatantra dept head [Sec 42(b)(i)]', category:'compliance', ncism_ref:'Sec 42(b)(i)'},
    {item_name:'Consultants of Agadatantra + specialty clinic consultants (if any) = authorised to admit patients in this ward [Sec 42(b)(i)]', category:'compliance', ncism_ref:'Sec 42(b)(i)'},
    // Schedule XVII — Minimum constructed area (Reg 40, 41)
    {item_name:'Visha Chikitsa OPD area — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  manovaha_opd:[
    // Space & Area — same base as Kayachikitsa + privacy enhancements
    {item_name:'Consultation room with sound privacy (mental health confidentiality)', category:'space',    ncism_ref:'MHA 2017 / NCISM-MAN(a)'},
    {item_name:'Minimum 2 consultation cubicles (one per doctor on duty)',            category:'space',     ncism_ref:'Sch XVI - KAY(b)'},
    {item_name:'Dedicated counselling room (for Satvavajaya Chikitsa sessions)',     category:'space',     ncism_ref:'NCISM-MAN(b)'},
    {item_name:'Waiting area — calm environment, separated from general OPD noise',  category:'space',     ncism_ref:'NCISM-MAN(a)'},
    // Equipment — same as Kayachikitsa
    {item_name:'Examination table + BP apparatus, stethoscope, thermometer, SpO₂',  category:'equipment', ncism_ref:'Sch XIX - KAY'},
    {item_name:'Weighing scale + height measure',                                    category:'equipment', ncism_ref:'Sch XIX - KAY'},
    {item_name:'Naadi pareeksha bolster / cushion',                                  category:'equipment', ncism_ref:'Sch XIX - KAY'},
    {item_name:'Manasika Roga assessment tools / psychometric scales (adapted)',     category:'equipment', ncism_ref:'NCISM-MAN(c)'},
    {item_name:'Medhya Rasayana reference chart (Brahmi, Shankhapushpi, Mandukaparni, Yashtimadhu)', category:'equipment', ncism_ref:'NCISM-MAN(d)'},
    // Digital & HMIS
    {item_name:'HMIS terminal with NAMASTE-coded consultation notes',                 category:'digital',   ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'NAMC + ICD-10 dual-coded diagnosis (F-chapter ICD codes for mental disorders)', category:'digital', ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'Electronic prescription generation linked to pharmacy',              category:'digital',   ncism_ref:'Sch XVI - Sec 4'},
    {item_name:'Suicide / self-harm risk flag in patient record',                   category:'digital',   ncism_ref:'MHA 2017 / NCISM-MAN(e)'},
    // Compliance & Staffing
    {item_name:'Mental Healthcare Act 2017 compliance — informed consent per MHA rules', category:'compliance', ncism_ref:'MHA 2017 Sec 18-21'},
    {item_name:'Advance Directive documentation option for patients (MHA 2017)',     category:'compliance', ncism_ref:'MHA 2017 Sec 5'},
    {item_name:'Suicide / self-harm risk assessment protocol at every visit',        category:'compliance', ncism_ref:'NCISM-MAN(e)'},
    {item_name:'Satvavajaya Chikitsa (Ayurveda psychotherapy) sessions documented', category:'compliance', ncism_ref:'NCISM-MAN(b)'},
    {item_name:'Strict patient confidentiality — records not shared without consent',category:'compliance', ncism_ref:'MHA 2017 Sec 23'},
    {item_name:'Clinical Psychologist / Counsellor posted for counselling support',  category:'compliance', ncism_ref:'NCISM-MAN(f)'},
    {item_name:'Doctor duty register and case load tracking maintained',             category:'compliance', ncism_ref:'Sch XVI - KAY'},
    // Schedule XVII — Manovaha Srotas uses Kayachikitsa OPD area norms
    {item_name:'Manovaha Srotas OPD area (as per Kayachikitsa norms + privacy enhancements) — min 20 sqm (60) / 25 (100) / 35 (150) / 25×2 (200) [Sch XVII]', category:'space', ncism_ref:'Sch XVII'},
  ],
  specialty_clinic:[
    // Specialty clinics use parent department's space and equipment (NCISM: not counted in minimum area)
    // Infrastructure items here cover compliance and administrative requirements only
    {item_name:'Specialty OPD space carved out of parent department (NOT counted in min area requirement)', category:'space', ncism_ref:'NCISM Spec Clinic(e)'},
    {item_name:'Parent department HOD assigned as administrative head of this specialty OPD',               category:'space', ncism_ref:'NCISM Spec Clinic(d)'},
    // Equipment — inherited from parent dept; confirm these are shared/available
    {item_name:'Consultation room / cubicle (within parent department space)',        category:'equipment',  ncism_ref:'NCISM Spec Clinic(a)'},
    {item_name:'Specialty-specific diagnostic instruments (as per clinic type)',      category:'equipment',  ncism_ref:'NCISM Spec Clinic(a)'},
    // Digital & HMIS
    {item_name:'HMIS terminal — specialty OPD linked to parent department',           category:'digital',    ncism_ref:'NCISM Spec Clinic(b)'},
    {item_name:'Specialty-specific case proforma in HMIS (disease or procedure-based)',category:'digital',  ncism_ref:'NCISM Spec Clinic(b)'},
    {item_name:'Specialty OPD named after disease or therapeutic procedure in system', category:'digital',  ncism_ref:'NCISM Spec Clinic(c)'},
    // Compliance & Staffing
    {item_name:'Consultant has documented special training / expertise for this specialty', category:'compliance', ncism_ref:'NCISM Spec Clinic(a)'},
    {item_name:'Specialty OPD registered under one clinical department in HMIS',      category:'compliance', ncism_ref:'NCISM Spec Clinic(d)'},
    {item_name:'Consultant may also consult in parent departmental OPD (dual posting allowed)', category:'compliance', ncism_ref:'NCISM Spec Clinic(a)'},
    {item_name:'Faculty from basic science depts (Dravyaguna, RBK etc.) may run specialty OPD if trained', category:'compliance', ncism_ref:'NCISM Spec Clinic(a)'},
    {item_name:'Specialty clinic count not included in NCISM minimum OPD compliance',  category:'compliance', ncism_ref:'NCISM Spec Clinic(e)'},
  ],
  teleconsultation_opd:[
    // Space & Area
    {item_name:'Dedicated teleconsultation room/station per consultant (privacy, neutral background)', category:'space', ncism_ref:'NCISM Tele(a)'},
    {item_name:'Adequate lighting and soundproofing for video consultations',          category:'space',      ncism_ref:'NCISM Tele(a)'},
    // Equipment
    {item_name:'Computer / laptop with webcam (HD — minimum 720p)',                   category:'equipment',  ncism_ref:'NCISM Tele(b)'},
    {item_name:'Headset / microphone with noise cancellation',                        category:'equipment',  ncism_ref:'NCISM Tele(b)'},
    {item_name:'Stable high-speed internet connection (minimum 10 Mbps)',             category:'equipment',  ncism_ref:'NCISM Tele(b)'},
    {item_name:'Backup internet (mobile hotspot / secondary ISP)',                    category:'equipment',  ncism_ref:'NCISM Tele(b)'},
    {item_name:'UPS / power backup for uninterrupted teleconsultation sessions',      category:'equipment',  ncism_ref:'NCISM Tele(b)'},
    // Digital & HMIS
    {item_name:'Teleconsultation platform integrated with HMIS (visits, prescriptions)', category:'digital', ncism_ref:'NCISM Tele(c)'},
    {item_name:'Consultant availability and timings displayed on teleconsultation platform', category:'digital', ncism_ref:'NCISM Tele(d)'},
    {item_name:'Consultant availability and timings displayed on institutional website', category:'digital',  ncism_ref:'NCISM Tele(d)'},
    {item_name:'Digital prescription generation for teleconsultation visits',          category:'digital',   ncism_ref:'NCISM Tele(e)'},
    {item_name:'Patient consent for online consultation recorded in HMIS',             category:'digital',   ncism_ref:'NCISM Tele(f)'},
    {item_name:'Teleconsultation visits flagged separately in HMIS (not counted in physical OPD numbers)', category:'digital', ncism_ref:'NCISM Tele(g)'},
    // Compliance & Staffing
    {item_name:'OPD In-charge designated as administrative head of teleconsultation OPD', category:'compliance', ncism_ref:'NCISM Tele(h)'},
    {item_name:'Teleconsultation visits NOT counted in NCISM physical OPD attendance', category:'compliance', ncism_ref:'NCISM Tele(g)'},
    {item_name:'Telemedicine Practice Guidelines 2020 (MoHFW) compliance',            category:'compliance', ncism_ref:'GoI Tele Guidelines 2020'},
    {item_name:'Patient identity verification before each teleconsultation',           category:'compliance', ncism_ref:'GoI Tele Guidelines 2020'},
    {item_name:'Consultation records maintained for minimum 3 years',                  category:'compliance', ncism_ref:'GoI Tele Guidelines 2020'},
  ],
  pharmacy_dispensary:[
    // Space & Area
    {item_name:'Dispensing counter with adequate workspace (separate from storage)',  category:'space',      ncism_ref:'NCISM Sec - Sch XVII(1)'},
    {item_name:'Medicine storage racks — labelled by category (classical/patent/Rasa/liquids)', category:'space', ncism_ref:'NCISM Sec - Sch XVII(2)'},
    {item_name:'Cold storage / refrigerator (temperature-sensitive medicines)',       category:'space',      ncism_ref:'NCISM Sec - Sch XVII(3)'},
    {item_name:'Quarantine / expiry area (segregated from active stock)',             category:'space',      ncism_ref:'NCISM Sec - Sch XVII(4)'},
    {item_name:'Practical area with adequate seating for in-charge, interns, RBK students', category:'space', ncism_ref:'NCISM Sec 6(6)'},
    {item_name:'Drug store in-charge desk / office area',                            category:'space',      ncism_ref:'NCISM Sec 6(1)'},
    // Equipment
    {item_name:'Electronic weighing balance (for powder dispensing)',                 category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Mortar and pestle set (for powder mixing)',                           category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Measuring cylinders and beakers (for liquid preparations)',           category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Airtight containers for Churna / powder storage',                    category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Dispensing trays and spatulas',                                      category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Label printer / stamping equipment',                                 category:'equipment',  ncism_ref:'Sch XX - PHR'},
    {item_name:'Refrigerator with temperature log',                                  category:'equipment',  ncism_ref:'Sch XX - PHR'},
    // Digital & HMIS
    {item_name:'Computerised dispensary system integrated with HMIS (NCISM mandatory)', category:'digital', ncism_ref:'NCISM Sec 6(1)'},
    {item_name:'Hospital Formulary module — approved medicine list in HMIS',         category:'digital',    ncism_ref:'NCISM Sec 6(2)'},
    {item_name:'GMP supplier certification tracking in purchase / procurement module',category:'digital',   ncism_ref:'NCISM Sec 6(3)'},
    {item_name:'Expiry medicine removal / disposal register (digital)',               category:'digital',   ncism_ref:'NCISM Sec 6(5)'},
    {item_name:'Drug Procurement Committee meeting records in HMIS',                 category:'digital',    ncism_ref:'NCISM Sec 6(2)'},
    // Compliance & Staffing
    {item_name:'BAMS / B.Pharm(Ay) / M.Pharm(Ay) qualified in-charge posted',       category:'compliance', ncism_ref:'NCISM Sec 6(1)'},
    {item_name:'Hospital Formulary approved by Drug Procurement Committee',          category:'compliance', ncism_ref:'NCISM Sec 6(2)'},
    {item_name:'Drug Procurement Committee (all clinical HODs) meets ≥ once per quarter', category:'compliance', ncism_ref:'NCISM Sec 6(2)'},
    {item_name:'Medicines procured from GMP-certified pharmacies only',              category:'compliance', ncism_ref:'NCISM Sec 6(3)'},
    {item_name:'Student-prepared / demonstration medicines NOT dispensed to patients',category:'compliance', ncism_ref:'NCISM Sec 6(3)'},
    {item_name:'Only qualified pharmacist dispenses — not students or helpers',      category:'compliance', ncism_ref:'NCISM Sec 6(4)'},
    {item_name:'Expiry medicine removal record maintained — quantity, batch, disposal method', category:'compliance', ncism_ref:'NCISM Sec 6(5)'},
  ],
  diagnostic_zone:[
    // Space & Area (NCISM Sec 43(5))
    {item_name:'Patient waiting area with adequate seating',                          category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Sample collection and processing area',                               category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Report issue and payment counter',                                    category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Diagnostic zone in-charge office',                                    category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Store room for reagents, consumables, equipment',                     category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Separate male and female toilets for patients',                       category:'space',      ncism_ref:'NCISM Sec 43(5)'},
    {item_name:'Dressing/changing room for radiology (imaging section)',              category:'space',      ncism_ref:'NCISM Sec 43(9)'},
    {item_name:'Radiology staff seating area (imaging section)',                      category:'space',      ncism_ref:'NCISM Sec 43(9)'},
    // Clinical Laboratory (Sec 43(7))
    {item_name:'Pathology section with dedicated bench and equipment',                category:'equipment',  ncism_ref:'NCISM Sec 43(7)'},
    {item_name:'Haematology section (CBC, ESR, peripheral smear)',                   category:'equipment',  ncism_ref:'NCISM Sec 43(7)'},
    {item_name:'Biochemistry section (LFT, KFT, lipid, glucose, thyroid)',           category:'equipment',  ncism_ref:'NCISM Sec 43(7)'},
    {item_name:'Immunology section (RA factor, CRP, Widal, Dengue NS1)',             category:'equipment',  ncism_ref:'NCISM Sec 43(7)'},
    {item_name:'Microbiology section (urine culture, gram stain)',                   category:'equipment',  ncism_ref:'NCISM Sec 43(7)'},
    {item_name:'Centrifuge, microscope, autoclave (lab basics)',                      category:'equipment',  ncism_ref:'Sch XX-XXI'},
    {item_name:'Refrigerator for reagent and sample storage',                        category:'equipment',  ncism_ref:'Sch XX-XXI'},
    // Imaging Section (Sec 43(8))
    {item_name:'X-ray machine (preferably Digital Radiography — no dark room needed)',category:'equipment', ncism_ref:'NCISM Sec 43(8)'},
    {item_name:'Ultrasonography machine with Doppler',                               category:'equipment',  ncism_ref:'NCISM Sec 43(8)'},
    // Other Diagnostics (Sec 43(11))
    {item_name:'ECG machine (12-lead)',                                               category:'equipment',  ncism_ref:'NCISM Sec 43(11)'},
    {item_name:'Pulse oximeter, glucometer, spirometer (point-of-care)',             category:'equipment',  ncism_ref:'Sch XX-XXI'},
    // Digital & HMIS
    {item_name:'HMIS terminal for investigation ordering and result entry',           category:'digital',    ncism_ref:'NCISM Sec 43(2)'},
    {item_name:'Digital report generation with PG Roganidana authorised signatory',  category:'digital',    ncism_ref:'NCISM Sec 43(4)'},
    {item_name:'Investigation results linked back to ordering doctor in HMIS',       category:'digital',    ncism_ref:'NCISM Sec 43(2)'},
    // Compliance & Staffing
    {item_name:'HOD Roganidana or authorised faculty = administrative head',          category:'compliance', ncism_ref:'NCISM Sec 43(3)'},
    {item_name:'PG Roganidana posted as authorised signatory for all test reports',  category:'compliance', ncism_ref:'NCISM Sec 43(4)'},
    {item_name:'Part-time Pathologist / Radiologist / Sonologist / Microbiologist appointed as required', category:'compliance', ncism_ref:'NCISM Sec 43(4)'},
    {item_name:'Radiology section compliant with AERB (Atomic Energy Regulatory Board) standards', category:'compliance', ncism_ref:'NCISM Sec 43(8)'},
    {item_name:'PCPNDT Act 1994 mandatory notice displayed in imaging section',      category:'compliance', ncism_ref:'NCISM Sec 43(10)'},
    {item_name:'Biomedical waste management system per Government standards',        category:'compliance', ncism_ref:'NCISM Sec 43(6)'},
    {item_name:'Lab reports with Ayurvedic interpretation added by PG Roganidana',  category:'compliance', ncism_ref:'NCISM Sec 43(4)'},
    // Schedule XXI — Minimum constructed area for Diagnostic zone (Reg 43)
    {item_name:'Diagnostic zone TOTAL (clinical lab + imaging + other diagnostics + waiting + in-charge office + report counter) — min 150 sqm (60) / 175 (100) / 200 (150) / 225 (200) [Sch XXI]', category:'space', ncism_ref:'Sch XXI'},
  ],

  // ── IPD WARD ──────────────────────────────────────────────────────────────
  ipd_ward:[
    // Space & Area
    {item_name:'General ward with min 2.75m centre-to-centre bed spacing',           category:'space',      ncism_ref:'Sch XVI - Sec 7(a)'},
    {item_name:'Minimum 7.5 sq m floor area per bed (general ward)',                 category:'space',      ncism_ref:'Sch XVI - Sec 7(a)'},
    {item_name:'Private room minimum 10 sq m floor area',                            category:'space',      ncism_ref:'Sch XVI - Sec 7(b)'},
    {item_name:'Nursing station with clear sightlines to all beds',                  category:'space',      ncism_ref:'Sch XVI - Sec 7(c)'},
    {item_name:'Side room / isolation room (minimum 1 per 10 beds)',                 category:'space',      ncism_ref:'Sch XVI - Sec 7(d)'},
    {item_name:'Separate male and female ward sections',                             category:'space',      ncism_ref:'Sch XVI - Sec 7(e)'},
    {item_name:'Clean utility room for sterile supplies storage',                    category:'space',      ncism_ref:'Sch XVI - Sec 7(f)'},
    {item_name:'Soiled utility room for dirty linen and waste',                      category:'space',      ncism_ref:'Sch XVI - Sec 7(f)'},
    {item_name:'Linen room / linen storage area',                                    category:'space',      ncism_ref:'Sch XVI - Sec 7(g)'},
    {item_name:'Toilet and bathroom (1 per 6 patients), separate male/female',       category:'space',      ncism_ref:'Sch XVI - Sec 7(h)'},
    {item_name:'Panchakarma treatment room within or adjacent to ward',              category:'space',      ncism_ref:'Sch XVI - Sec 7(i)'},
    {item_name:'Diet / fluid kitchen adjacent to ward',                              category:'space',      ncism_ref:'Sch XVI - Sec 7(j)'},
    {item_name:'Visitor waiting area outside ward',                                  category:'space',      ncism_ref:'Sch XVI - Sec 7(k)'},
    {item_name:'Duty doctor residential room (24×7)',                                category:'space',      ncism_ref:'Sch XVI - Sec 7(l)'},
    // Equipment
    {item_name:'Medical gas supply: O₂ and suction points at each bedside',          category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Nurse call / intercom system at each bed',                           category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Bedside locker and overbed table per bed',                           category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'IV stand per bed',                                                   category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Emergency drug trolley / crash cart in ward',                        category:'equipment',  ncism_ref:'Sch XIX'},
    {item_name:'BP apparatus, thermometer, stethoscope set at nursing station',      category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Biomedical waste bins (colour-coded) in ward',                       category:'equipment',  ncism_ref:'Sch XXII'},
    // Digital & HMIS
    {item_name:'HMIS terminal at nursing station for bed status management',         category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Daily progress notes entered in HMIS per patient per shift',         category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Nursing notes documented digitally per shift',                       category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Discharge summary generated via HMIS',                              category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    // Compliance & Staffing
    {item_name:'Ward in-charge (Ward Sister / Senior Staff Nurse) posted',           category:'compliance', ncism_ref:'Sch XVI - Sec 11'},
    {item_name:'Staff nurse to bed ratio minimum 1:6 maintained',                    category:'compliance', ncism_ref:'Sch XVI - Sec 11'},
    {item_name:'Patient diet chart maintained and reviewed daily',                   category:'compliance', ncism_ref:'Sch XVI - Sec 40'},
    {item_name:'PK therapy schedule documented for each IPD patient',                category:'compliance', ncism_ref:'NCISM Sec 35'},
    {item_name:'IPD case sheet with daily Ayurvedic Ashtasthana assessment',         category:'compliance', ncism_ref:'NCISM Sec 35'},
    // New from NCISM IPD Zone Sec 7(1)–(12)
    // Space — Gender demarcation & sanitation
    {item_name:'Clear demarcation between male and female bed areas in general ward', category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Separate toilet block for male patients',                            category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Separate toilet block for female patients',                          category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Separate toilet block for male attendants',                          category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Separate toilet block for female attendants',                        category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Designated visitor area with suitable furniture',                    category:'space',      ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Laundry / cloth washing and drying facility for in-patients',        category:'space',      ncism_ref:'NCISM Sec 7(6)'},
    {item_name:'Procedural room attached to each ward',                              category:'space',      ncism_ref:'NCISM Sec 7(7)'},
    {item_name:'Preparation room attached to each ward',                             category:'space',      ncism_ref:'NCISM Sec 7(7)'},
    {item_name:'Night duty accommodation for nursing staff within/adjacent to ward', category:'space',      ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Night duty accommodation for interns within/adjacent to ward',       category:'space',      ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Night duty doctor room within/adjacent to ward',                     category:'space',      ncism_ref:'NCISM Sec 7(4)'},
    // Equipment — Water, nursing station, call bell
    {item_name:'Hot and cold water supply at drinking points in all wards',          category:'equipment',  ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Hot and cold water supply in all patient and attendant toilets',     category:'equipment',  ncism_ref:'NCISM Sec 7(1)'},
    {item_name:'Nursing station / counter for every 30 beds',                        category:'equipment',  ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Medicine storage cabinet at nursing station',                        category:'equipment',  ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Seating arrangement for interns at nursing station',                 category:'equipment',  ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Designated trolley parking area in ward',                            category:'equipment',  ncism_ref:'NCISM Sec 7(4)'},
    {item_name:'Emergency nurse call bell in general ward at appropriate places',    category:'equipment',  ncism_ref:'NCISM Sec 7(5)'},
    {item_name:'Emergency nurse call bell at every bed in special/deluxe wards',     category:'equipment',  ncism_ref:'NCISM Sec 7(5)'},
    // Compliance — Grouping and demarcation
    {item_name:'Medical IPD section grouped: Kayachikitsa + PK + Kaumarabhritya + Vishachikitsa', category:'compliance', ncism_ref:'NCISM Sec 7(11)'},
    {item_name:'Surgical IPD section grouped: Shalya + Shalakya + Prasuti & Streeroga',           category:'compliance', ncism_ref:'NCISM Sec 7(12)'},
    {item_name:'Clear demarcation between septic and aseptic beds in Shalya ward',   category:'compliance', ncism_ref:'NCISM Sec 7(12)'},
    {item_name:'Clear demarcation between obstetric and gynaecology beds in Prasuti ward', category:'compliance', ncism_ref:'NCISM Sec 7(12)'},
    // Table-8 — Department-wise minimum in-patient beds (Sec 41)
    // Medical in-patients section (60% of total beds)
    {item_name:'IPD beds: Kayachikitsa Ward (incl. Atyayikachikitsa) — 20% = min 12 beds (60) / 20 (100) / 30 (150) / 40 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'IPD beds: Panchakarma Ward — 25% = min 15 beds (60) / 25 (100) / 37 (150) / 50 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'IPD beds: Kaumarabhritya Ward — 10% = min 6 beds (60) / 10 (100) / 15 (150) / 20 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'IPD beds: Visha Chikitsa Ward — 5% = min 3 beds (60) / 5 (100) / 8 (150) / 10 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'Medical section sub-total — 60% = min 36 beds (60) / 60 (100) / 90 (150) / 120 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    // Surgical in-patients section (40% of total beds)
    {item_name:'IPD beds: Shalya Ward — 20% = min 12 beds (60) / 20 (100) / 30 (150) / 40 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'IPD beds: Shalakya Ward — 10% = min 6 beds (60) / 10 (100) / 15 (150) / 20 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'IPD beds: Prasuti and Streeroga Ward — 10% = min 6 beds (60) / 10 (100) / 15 (150) / 20 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'Surgical section sub-total — 40% = min 24 beds (60) / 40 (100) / 60 (150) / 80 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    {item_name:'Grand total IPD beds — 100% = min 60 beds (60) / 100 (100) / 150 (150) / 200 (200) [Table-8]', category:'compliance', ncism_ref:'Table-8'},
    // Table-9 — Bed occupancy requirements (Sec 41(6))
    {item_name:'Minimum beds required (1:1 student-to-bed ratio) — 60 beds (60-intake) / 100 (100) / 150 (150) / 200 (200) [Table-9]', category:'compliance', ncism_ref:'Table-9'},
    {item_name:'Minimum avg patients/day at 60% occupancy — 36 (60-intake) / 60 (100) / 90 (150) / 120 (200) [Table-9]', category:'compliance', ncism_ref:'Table-9'},
    {item_name:'Bed occupancy maintained at min 60% average per day over calendar year', category:'compliance', ncism_ref:'NCISM Table-9'},
    {item_name:'Student:bed ratio maintained at 1:1 (beds = UG intake)',             category:'compliance', ncism_ref:'NCISM Table-9'},
    {item_name:'Bed occupancy formula: (Bed days occupied ÷ (Beds × Days)) × 100 — must reach 60% [Table-9]', category:'compliance', ncism_ref:'Table-9'},
    {item_name:'Patient admitted before midnight = 1 bed day; admitted and discharged same day = 0.5 bed day [Table-9 Note]', category:'compliance', ncism_ref:'Table-9'},
    // Section 41 additional requirements
    {item_name:'Each ward: nursing counter/station per 30 beds + medicine storage + intern seating + trolley area + BMW + clean and dirty utility [Sec 41(4)]', category:'compliance', ncism_ref:'Sec 41(4)'},
    {item_name:'Each ward: night duty accommodation for nurses, interns, and night duty doctor/consultant [Sec 41(4)]', category:'compliance', ncism_ref:'Sec 41(4)'},
    {item_name:'Each ward: attached procedural room and preparation room [Sec 41(5)]', category:'compliance', ncism_ref:'Sec 41(5)'},
    {item_name:'Clinical classroom attached to each ward (NCISM Sec 46)',             category:'compliance', ncism_ref:'NCISM Sec 46(1)'},
    // Section 43 — Clinical Classroom specific requirements
    {item_name:'All clinical classrooms equipped with ICT (Information Communications Technology) [Sec 43(2)]', category:'equipment', ncism_ref:'Sec 43(2)'},
    {item_name:'At least ONE clinical classroom equipped with interactive CCTV connected to Operation Theatre for live surgical demonstration [Sec 43(3)]', category:'equipment', ncism_ref:'Sec 43(3)'},
    {item_name:'Clinical classroom capacity: accommodate clinical batch size OR minimum 30 students [Sec 43(4)]', category:'space', ncism_ref:'Sec 43(4)'},
    {item_name:'Each clinical classroom: examination table, X-ray view box, stethoscope, non-mercurial sphygmomanometer, non-contact thermometer, torch light, tongue depressor, measuring tape, skin marking pencil, knee hammer [Sec 43(5)]', category:'equipment', ncism_ref:'Sec 43(5)'},
    // Schedule XXIII — Minimum equipment per nursing station (Reg 45)
    {item_name:'Non-mercurial sphygmomanometer — min 2 per nursing station [Sch XXIII #1]', category:'equipment', ncism_ref:'Sch XXIII #1'},
    {item_name:'Clinical thermometer (non-contact) — min 2 per nursing station [Sch XXIII #2]', category:'equipment', ncism_ref:'Sch XXIII #2'},
    {item_name:'Vital monitor — min 1 per nursing station [Sch XXIII #3]',            category:'equipment',  ncism_ref:'Sch XXIII #3'},
    {item_name:'Stethoscope — min 2 per nursing station [Sch XXIII #4]',              category:'equipment',  ncism_ref:'Sch XXIII #4'},
    {item_name:'Basic examination tools (measuring tape, tongue depressor, knee hammer, torch, kidney tray) — as required [Sch XXIII #5]', category:'equipment', ncism_ref:'Sch XXIII #5'},
    {item_name:'Nadi reading equipment — min 2 per nursing station [Sch XXIII #6 — Ayurveda IPD]', category:'equipment', ncism_ref:'Sch XXIII #6'},
    {item_name:'Weighing scale — min 1 per nursing station [Sch XXIII #7]',           category:'equipment',  ncism_ref:'Sch XXIII #7'},
    {item_name:'Trolley — min 1 per nursing station [Sch XXIII #8]',                  category:'equipment',  ncism_ref:'Sch XXIII #8'},
    // Schedule XXIII — Medical procedural room (attached to medical IPD section)
    {item_name:'Medical procedural room: Droni (Ayurvedic treatment trough) — min 1 [Sch XXIII #9 — Ayurveda IPD]', category:'equipment', ncism_ref:'Sch XXIII #9'},
    {item_name:'Medical procedural room: Foot step stand — min 2 [Sch XXIII #10]',    category:'equipment',  ncism_ref:'Sch XXIII #10'},
    {item_name:'Medical procedural room: Heating source — min 2 [Sch XXIII #11]',     category:'equipment',  ncism_ref:'Sch XXIII #11'},
    {item_name:'Medical procedural room: Non-mercurial BP — min 2, thermometer — min 2 [Sch XXIII #12–13]', category:'equipment', ncism_ref:'Sch XXIII #12'},
    {item_name:'Medical procedural room: Consumables (vessels, trays) for ward procedures — as required [Sch XXIII #14]', category:'equipment', ncism_ref:'Sch XXIII #14'},
    // Schedule XXIII — Surgical procedural room (attached to surgical IPD section)
    {item_name:'Surgical procedural room: Examination table — min 1 [Sch XXIII #15]', category:'equipment',  ncism_ref:'Sch XXIII #15'},
    {item_name:'Surgical procedural room: Sterilizer — min 1 [Sch XXIII #16]',        category:'equipment',  ncism_ref:'Sch XXIII #16'},
    {item_name:'Surgical procedural room: Basic instrument set (toothed forceps, artery forceps, scissors, BP handle, blade, proctoscope, catheter, syringes) — 1 set [Sch XXIII #17]', category:'equipment', ncism_ref:'Sch XXIII #17'},
    {item_name:'Surgical procedural room: Non-mercurial BP — min 2, thermometer — min 2 [Sch XXIII #18–19]', category:'equipment', ncism_ref:'Sch XXIII #18'},
    {item_name:'Surgical procedural room: Consumables and medicines for ward surgical procedures — as required [Sch XXIII #20]', category:'equipment', ncism_ref:'Sch XXIII #20'},
  ],

  // ── CLINICAL CLASSROOM (NCISM Sec 46) ────────────────────────────────────
  clinical_classroom:[
    // Space & Area
    {item_name:'Minimum 1 clinical classroom attached to / adjacent to each IPD ward', category:'space',      ncism_ref:'NCISM Sec 46(1)'},
    {item_name:'Minimum floor area 40 sq m per classroom',                            category:'space',      ncism_ref:'NCISM Sec 46(2)'},
    {item_name:'Adequate natural light and cross-ventilation',                        category:'space',      ncism_ref:'NCISM Sec 46(2)'},
    {item_name:'Seating capacity adequate for one student batch (min 30 seats)',      category:'space',      ncism_ref:'NCISM Sec 46(2)'},
    {item_name:'Demonstration area with access to ward beds for bedside teaching',    category:'space',      ncism_ref:'NCISM Sec 46(3)'},
    {item_name:'Storage space for teaching aids and models',                          category:'space',      ncism_ref:'NCISM Sec 46(2)'},
    // Equipment & Teaching Aids
    {item_name:'Whiteboard or chalkboard of adequate size',                           category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    {item_name:'Projector / LCD screen for case presentation',                        category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    {item_name:'Demonstration examination bed',                                       category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    {item_name:'Anatomical / clinical teaching models and charts relevant to dept',   category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    {item_name:'Audio-visual teaching equipment (speaker, microphone if large batch)',category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    {item_name:'Ayurvedic Nadi Pariksha model / Ashtasthana Pariksha demo kit',      category:'equipment',  ncism_ref:'NCISM Sec 46(4)'},
    // Digital & HMIS
    {item_name:'HMIS terminal / laptop for case record display during rounds',        category:'digital',    ncism_ref:'NCISM Sec 46(5)'},
    {item_name:'Access to digital library / e-resources during teaching sessions',   category:'digital',    ncism_ref:'NCISM Sec 46(5)'},
    {item_name:'Teaching session records documented in HMIS or register',            category:'digital',    ncism_ref:'NCISM Sec 46(5)'},
    // Compliance & Staffing
    {item_name:'Minimum 1 bedside teaching session per ward per week conducted',      category:'compliance', ncism_ref:'NCISM Sec 46(6)'},
    {item_name:'Faculty:student ratio maintained for bedside teaching (1:10 max)',    category:'compliance', ncism_ref:'NCISM Sec 46(6)'},
    {item_name:'Case presentation schedule documented and reviewed by HOD',           category:'compliance', ncism_ref:'NCISM Sec 46(7)'},
    {item_name:'Clinical case records available for student reference (anonymised)',  category:'compliance', ncism_ref:'NCISM Sec 46(7)'},
    {item_name:'Student attendance for clinical rounds maintained',                   category:'compliance', ncism_ref:'NCISM Sec 46(8)'},
    {item_name:'Department-wise teaching case log maintained',                        category:'compliance', ncism_ref:'NCISM Sec 46(8)'},
    // Schedule XXII — Minimum constructed area for IPD wards (Reg 44, 45)
    // Medical IPD section
    {item_name:'Medical IPD: Bed area (6 sqm/bed) — min 220 sqm (60) / 360 (100) / 540 (150) / 720 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Emergency ward and ICU (02–06 beds) — min 50–200 sqm [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Nursing counter and store (1 per 30 beds) — min 20 sqm (60) / 40 (100) / 60 (150) / 80 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Seating for interns — min 10 sqm (60) / 15 (100) / 20 (150) / 30 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Room for night duty nurse (1 per 30 beds) — min 20 sqm (60) / 40 (100) / 60 (150) / 80 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Night duty intern rooms (M+F separately) — min 50 sqm (60) / 50 (100) / 60 (150) / 70 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Room for night duty doctor — min 25 sqm (all intakes) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Ward procedural room — min 20 sqm (60–100) / 30 (150) / 45 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Clinical classrooms — min 45 sqm (60) / 90 (100) / 120 (150) / 150 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Circulation and corridors — min 20 sqm (60) / 30 (100) / 40 (150) / 50 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD: Toilets + water facility + trolley area + BMW + housekeeping — min 300 sqm (60) / 400 (100) / 500 (150) / 650 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    {item_name:'Medical IPD TOTAL — min 780 sqm (60) / 1170 (100) / 1605 (150) / 2100 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Medical'},
    // Surgical IPD section
    {item_name:'Surgical IPD: Bed area (6 sqm/bed) — min 145 sqm (60) / 240 (100) / 360 (150) / 480 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Nursing counter and store (1 per 20 beds) — min 20 sqm (60) / 40 (100) / 60 (150) / 80 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Seating for interns — min 10 sqm (60) / 15 (100) / 20 (150) / 30 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Room for night duty nurse (1 per 20 beds) — min 20 sqm (60) / 40 (100) / 60 (150) / 80 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Night duty intern rooms (M+F separately) — min 25 sqm (60) / 50 (100) / 60 (150) / 70 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Room for night duty doctor — min 25 sqm (all intakes) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Ward procedural room — min 20 sqm (60–100) / 30 (150, 1 or 2 rooms) / 45 (200, 2 or 3 rooms) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Clinical classrooms — min 45 sqm (60) / 90 (100) / 120 (150) / 150 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Circulation area and corridors — min 20 sqm (60) / 30 (100) / 40 (150) / 50 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD: Toilets + water facility + trolley area + BMW + housekeeping — min 300 sqm (60) / 400 (100) / 500 (150) / 650 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'Surgical IPD TOTAL — min 630 sqm (60) / 950 (100) / 1275 (150) / 1660 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - Surgical'},
    {item_name:'IPD zone TOTAL (Medical + Surgical combined) — min 1410 sqm (60) / 2120 (100) / 2880 (150) / 3760 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - IPD Total'},
  ],

  // ── NURSING ZONE ──────────────────────────────────────────────────────────
  nursing_zone:[
    // Space
    {item_name:'Central nursing station with visibility across wards',               category:'space',      ncism_ref:'Sch XVI - Sec 11'},
    {item_name:'Nursing superintendent office',                                      category:'space',      ncism_ref:'NCISM Sec 23'},
    {item_name:'Deputy nursing superintendent room',                                 category:'space',      ncism_ref:'NCISM Sec 23'},
    {item_name:'Nursing procedures / skills demonstration room',                     category:'space',      ncism_ref:'NCISM Sec 23'},
    {item_name:'Staff nurse duty room',                                              category:'space',      ncism_ref:'Sch XVI - Sec 11'},
    {item_name:'Nursing record room / documentation area',                           category:'space',      ncism_ref:'Sch XVI - Sec 11'},
    // Equipment
    {item_name:'Procedure trolleys in each ward',                                    category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Dressing sets, injection trays, catheterization kits',               category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Nebuliser and portable suction machine',                             category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Glucometer, pulse oximeter, BP apparatus set',                       category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Biomedical waste disposal system',                                   category:'equipment',  ncism_ref:'Sch XXII'},
    // Digital & HMIS
    {item_name:'Nursing records accessible on HMIS',                                 category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Medication administration record (MAR) in HMIS',                     category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'Shift handover notes documented digitally',                          category:'digital',    ncism_ref:'NCISM Sec 35'},
    // Compliance & Staffing
    {item_name:'Nursing superintendent holding M.Sc. Nursing or equivalent',         category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'Minimum staff nurse to bed ratio 1:6 (general ward)',                category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'24×7 nursing coverage across all wards',                             category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'Nursing duty roster maintained and displayed',                       category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'Nursing training and CME records maintained annually',               category:'compliance', ncism_ref:'NCISM Sec 23'},
  ],

  // ── OPERATION THEATRE ─────────────────────────────────────────────────────
  operation_theatre:[
    // Space & Zone
    {item_name:'Clean (aseptic) OT zone with restricted entry',                      category:'space',      ncism_ref:'Sch XVI - Sec 42(a)'},
    {item_name:'Scrub station at OT entry',                                          category:'space',      ncism_ref:'Sch XVI - Sec 42(a)'},
    {item_name:'Pre-operative preparation room',                                     category:'space',      ncism_ref:'Sch XVI - Sec 42(b)'},
    {item_name:'Post-operative recovery room',                                       category:'space',      ncism_ref:'Sch XVI - Sec 42(c)'},
    {item_name:'Anaesthesia induction area',                                         category:'space',      ncism_ref:'Sch XVI - Sec 42(d)'},
    {item_name:'Instrument sterilization area / CSSD connection',                    category:'space',      ncism_ref:'Sch XVI - Sec 42(e)'},
    {item_name:'Changing rooms (separate male and female)',                           category:'space',      ncism_ref:'Sch XVI - Sec 42(f)'},
    {item_name:'OT stores / drug cupboard',                                          category:'space',      ncism_ref:'Sch XVI - Sec 42(g)'},
    {item_name:'OT in-charge surgeon room',                                          category:'space',      ncism_ref:'Sch XVI - Sec 42(h)'},
    {item_name:'Dirty utility / soiled instrument room',                             category:'space',      ncism_ref:'Sch XVI - Sec 42(i)'},
    // Equipment
    {item_name:'Shadowless OT light',                                                category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'OT table (hydraulic / motorised)',                                   category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Anaesthesia machine with ventilator',                                category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Pulse oximeter, ECG, NIBP monitor',                                 category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Suction apparatus',                                                  category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Electrosurgical unit (diathermy)',                                   category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Instrument trolleys and surgical trays',                             category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Emergency crash cart in OT',                                         category:'equipment',  ncism_ref:'Sch XIX'},
    {item_name:'Autoclave / steriliser',                                             category:'equipment',  ncism_ref:'Sch XX'},
    // Digital & HMIS
    {item_name:'OT booking and scheduling in HMIS',                                  category:'digital',    ncism_ref:'Sch XVI - Sec 9'},
    {item_name:'WHO/NCISM surgical safety checklist documented in HMIS',             category:'digital',    ncism_ref:'NCISM Sec 40'},
    {item_name:'Pre-operative and post-operative notes in HMIS',                     category:'digital',    ncism_ref:'NCISM Sec 35'},
    {item_name:'OT register: patient, surgeon, procedure, outcome',                  category:'digital',    ncism_ref:'NCISM Sec 40'},
    // Compliance & Staffing
    {item_name:'Qualified Shalya Tantra faculty as OT in-charge',                    category:'compliance', ncism_ref:'NCISM Sec 40'},
    {item_name:'Anaesthesiologist or trained Shalya PG on duty for all procedures',  category:'compliance', ncism_ref:'NCISM Sec 40'},
    {item_name:'Minimum 2 surgical nurses trained in OT technique',                  category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'Laminar airflow / HEPA filter maintaining OT class standard',        category:'compliance', ncism_ref:'Sch XVI - Sec 42'},
    {item_name:'CSSD sterilisation protocol followed',                               category:'compliance', ncism_ref:'NCISM Sec 40'},
    {item_name:'Informed surgical consent documented before each procedure',         category:'compliance', ncism_ref:'NABH/NCISM'},
    {item_name:'COGI (Quality Control of India) certified instruments preferred for all OT equipment procurement (§47(m))', category:'compliance', ncism_ref:'§47(m)'},
    // Schedule XXIV — Minimum constructed area
    {item_name:'Minor OT area — min 50 sqm (60-intake) / 100 (100) / 150 (150–200) [Sch XXIV #8]', category:'space', ncism_ref:'Sch XXIV #8'},
    {item_name:'Major General OT area — min 150 sqm (60-intake) / 200 (100) / 400 sqm×2 (150–200) [Sch XXIV #9]', category:'space', ncism_ref:'Sch XXIV #9'},
    // §47(b) Operation Theatre Section — specific requirements
    {item_name:'Minor OT for ano-rectal and other minor procedures',                  category:'space',      ncism_ref:'§47(b)(i)'},
    {item_name:'Major General OT for all major surgeries',                            category:'space',      ncism_ref:'§47(b)(i)'},
    {item_name:'OT usage mechanism for all user depts (Shalya + Shalakya + Prasuti–Streeroga)', category:'compliance', ncism_ref:'§47(b)(ii)(iii)'},
    {item_name:'Waiting room for OT patients',                                        category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Pre-anaesthetic / preparation room',                                  category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Post-operative recovery room',                                        category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Soiled linen room',                                                   category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Nurses room (OT)',                                                    category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Surgeon\'s room — separate for male and female',                     category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Anaesthetist\'s room — separate for male and female',               category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Assistant\'s room',                                                   category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Store room (OT)',                                                     category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Washing room for surgeons and assistants',                            category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Students\' washing and dressing up room',                             category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Scrub room',                                                          category:'space',      ncism_ref:'§47(b)(vi)'},
    {item_name:'Uttarabasti performed ONLY in OT under aseptic conditions (NOT in regular PK therapy room)', category:'compliance', ncism_ref:'§47(b)(vii)'},
    {item_name:'Ksharasutra preparation room — SEPARATE from OT (preparation in OT is strictly prohibited)', category:'compliance', ncism_ref:'§47(b)(viii)'},
    {item_name:'If 2 major OTs: OT-1 for Shalya+Prasuti-Streeroga; OT-2 for Shalakya Tantra', category:'compliance', ncism_ref:'§47(b)(v)'},
    // Schedule XXVI — OT instruments (Shalya/Shalakya/Prasuti-Streeroga) Reg 47
    {item_name:'OT: Computer with internet and printer — min 1 [Sch XXVI #1]',       category:'equipment',  ncism_ref:'Sch XXVI #1'},
    {item_name:'OT: Spot light (shadowless ceiling fitted) — min 1 [Sch XXVI #2]',   category:'equipment',  ncism_ref:'Sch XXVI #2'},
    {item_name:'OT: X-ray view box (double) — min 1 [Sch XXVI #6]',                  category:'equipment',  ncism_ref:'Sch XXVI #6'},
    {item_name:'OT: Needle holding forceps (big/medium/small) — as required [Sch XXVI #3]', category:'equipment', ncism_ref:'Sch XXVI #3'},
    {item_name:'OT: Mosquito forceps, Dissection forceps, Tissue forceps, Babcock\'s, Kocher\'s — as required [Sch XXVI #8–20]', category:'equipment', ncism_ref:'Sch XXVI #8'},
    {item_name:'OT: Scissors (straight/curved/pointed/stitch removal) — as required [Sch XXVI #9–15]', category:'equipment', ncism_ref:'Sch XXVI #9'},
    {item_name:'OT: Sinus forceps, Probes assorted — as required [Sch XXVI #13–14]', category:'equipment',  ncism_ref:'Sch XXVI #13'},
    {item_name:'OT: Gastric and intestinal clamps (occlusive + crushing) — as required [Sch XXVI #16]', category:'equipment', ncism_ref:'Sch XXVI #16'},
    {item_name:'OT: Abdominal retractors, Self-retaining retractor — as required / min 1 [Sch XXVI #17, #46]', category:'equipment', ncism_ref:'Sch XXVI #17'},
    {item_name:'OT: Pile holding forceps, Sponge holding forceps, Allies forceps (small/big) — as required [Sch XXVI #26–33]', category:'equipment', ncism_ref:'Sch XXVI #26'},
    {item_name:'OT: Artery forceps (small/medium/big) — as required [Sch XXVI #34–36]', category:'equipment', ncism_ref:'Sch XXVI #34'},
    {item_name:'OT: Urethral dilators, Rubber and metal catheters (assorted) — as required [Sch XXVI #21–23]', category:'equipment', ncism_ref:'Sch XXVI #21'},
    {item_name:'OT: Proctoscope (with/without illuminator), Bougies, Barron Pile\'s Gun — 1 [Sch XXVI #29, #38]', category:'equipment', ncism_ref:'Sch XXVI #29'},
    {item_name:'OT: Suturing needles (straight/curved, assorted) and surgical thread — as required [Sch XXVI #24–25]', category:'equipment', ncism_ref:'Sch XXVI #24'},
    {item_name:'OT: Right angle cholecystectomy forceps, Stone holding forceps — as required [Sch XXVI #27–28]', category:'equipment', ncism_ref:'Sch XXVI #27'},
    {item_name:'OT: Sigmoidoscope (rigid or flexible) — optional [Sch XXVI #37]',    category:'equipment',  ncism_ref:'Sch XXVI #37'},
    {item_name:'OT: Laryngoscope (Pediatric or Adult) — min 1 [Sch XXVI #39]',       category:'equipment',  ncism_ref:'Sch XXVI #39'},
    {item_name:'OT: Ambu bag — as required [Sch XXVI #40]',                          category:'equipment',  ncism_ref:'Sch XXVI #40'},
    {item_name:'OT: Suction machine (electrical or manual) — min 1 [Sch XXVI #41]',  category:'equipment',  ncism_ref:'Sch XXVI #41'},
    {item_name:'OT: Emergency light — min 1 [Sch XXVI #42]',                         category:'equipment',  ncism_ref:'Sch XXVI #42'},
    {item_name:'OT: Skin grafting knife with handle — min 1 [Sch XXVI #43]',         category:'equipment',  ncism_ref:'Sch XXVI #43'},
    {item_name:'OT: Surgical blades (different sizes), BP handle (different sizes) — as required [Sch XXVI #44–45]', category:'equipment', ncism_ref:'Sch XXVI #44'},
    {item_name:'OT: Cheatle\'s forceps — as required [Sch XXVI #7]',                 category:'equipment',  ncism_ref:'Sch XXVI #7'},
    {item_name:'OT: Dressing drums (assorted), IV stand, Intravenous stand — as required [Sch XXVI #4–5]', category:'equipment', ncism_ref:'Sch XXVI #4'},
    // Schedule XXVI #47–75 (continued)
    {item_name:'OT: Bone Drill Machine — min 1 [Sch XXVI #47]',                      category:'equipment',  ncism_ref:'Sch XXVI #47'},
    {item_name:'OT: Bone cutter — min 1 [Sch XXVI #48]',                             category:'equipment',  ncism_ref:'Sch XXVI #48'},
    {item_name:'OT: Giggly Saw — min 1 [Sch XXVI #49]',                              category:'equipment',  ncism_ref:'Sch XXVI #49'},
    {item_name:'OT: Periosteum elevator, Scoop, Maggler forceps — min 1 each [Sch XXVI #51–52]', category:'equipment', ncism_ref:'Sch XXVI #51'},
    {item_name:'OT: Endotracheal tubes (different sizes) — as required [Sch XXVI #53]', category:'equipment', ncism_ref:'Sch XXVI #53'},
    {item_name:'OT: High Pressure Autoclave — min 1 [Sch XXVI #54]',                 category:'equipment',  ncism_ref:'Sch XXVI #54'},
    {item_name:'OT: Fumigator — min 1 [Sch XXVI #55]',                               category:'equipment',  ncism_ref:'Sch XXVI #55'},
    {item_name:'OT: Refrigerator — min 1 [Sch XXVI #56]',                            category:'equipment',  ncism_ref:'Sch XXVI #56'},
    {item_name:'OT: Nitrous Oxide Cylinder — min 1 [Sch XXVI #57]',                  category:'equipment',  ncism_ref:'Sch XXVI #57'},
    {item_name:'OT: Hydraulic Operation Table — min 1 [Sch XXVI #58]',               category:'equipment',  ncism_ref:'Sch XXVI #58'},
    {item_name:'OT: Shadowless lamp (ceiling) — min 1 [Sch XXVI #59]',               category:'equipment',  ncism_ref:'Sch XXVI #59'},
    {item_name:'OT: Anaesthesia Trolley or Boyle\'s Apparatus — min 1 [Sch XXVI #60]',category:'equipment', ncism_ref:'Sch XXVI #60'},
    {item_name:'OT: Gabriel Syringe — min 1 [Sch XXVI #61]',                         category:'equipment',  ncism_ref:'Sch XXVI #61'},
    {item_name:'OT: Sterilizer — min 2 [Sch XXVI #66]',                              category:'equipment',  ncism_ref:'Sch XXVI #66'},
    {item_name:'OT: Sim\'s speculum — min 3, Cusco\'s speculum — min 3, Anterior vaginal wall retractor — min 3 [Sch XXVI #67–69]', category:'equipment', ncism_ref:'Sch XXVI #67'},
    {item_name:'OT: Uterine sound — min 1 [Sch XXVI #70]',                           category:'equipment',  ncism_ref:'Sch XXVI #70'},
    {item_name:'OT: Doyen\'s retractor, Green armitage forceps, Abdominal retractors, Uterus holding forceps — as required [Sch XXVI #64–74]', category:'equipment', ncism_ref:'Sch XXVI #64'},
    {item_name:'OT: Consumables (gowns, gloves, mask, cap, chemicals, medicines) — as required [Sch XXVI #75]', category:'equipment', ncism_ref:'Sch XXVI #75'},
  ],

  // ── ANUSHASTRA KARMA SECTION (§47(c)) ─────────────────────────────────────
  anushastra_karma:[
    // Space — common for OPD + IPD, under head of Shalya dept
    {item_name:'Anushastra Karma Section under administrative control of head of Shalya Tantra dept', category:'compliance', ncism_ref:'§47(c)'},
    {item_name:'Common facility for both OPD and IPD procedures',                     category:'compliance', ncism_ref:'§47(c)'},
    {item_name:'Pain Management Unit — separate area with bed + monitoring equipment',category:'space',      ncism_ref:'§47(c)'},
    {item_name:'Raktamokshana Unit — dedicated aseptic area with leech storage',      category:'space',      ncism_ref:'§47(c)'},
    {item_name:'Ksharakarma Unit — area for alkaline thread/paste procedures',        category:'space',      ncism_ref:'§47(c)'},
    {item_name:'Agnikarma Unit — area with Shalaka (metal probe) cautery equipment', category:'space',      ncism_ref:'§47(c)'},
    // Equipment (Schedule XXVII)
    {item_name:'Ksharasutra materials: alkaline thread, buttoned probe, sitz bath, guiding wire', category:'equipment', ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Agnikarma set: Shalaka (4 types — Jambvostha, Kanka, Ateendra, Gokarnaka)', category:'equipment', ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Raktamokshana set: lancets, leech trays, leech storage jar, antiseptic', category:'equipment', ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Pain Management: nerve block needles, local anaesthetic, nerve stimulator', category:'equipment', ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Sterilisation facilities for all Anushastra instruments',             category:'equipment',  ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Dressing materials + aseptic trolley',                                category:'equipment',  ncism_ref:'Sch XXVII - §47(c)'},
    {item_name:'Emergency drug tray (adrenaline, antihistamine, IV access)',          category:'equipment',  ncism_ref:'Sch XXVII - §47(c)'},
    // Digital & HMIS
    {item_name:'Anushastra Karma procedure register in HMIS',                         category:'digital',    ncism_ref:'§47(c)'},
    {item_name:'Ksharasutra follow-up schedule tracker (weekly thread change)',       category:'digital',    ncism_ref:'§47(c)'},
    // Compliance
    {item_name:'Informed consent for every Anushastra Karma procedure',               category:'compliance', ncism_ref:'§47(c)'},
    {item_name:'Raktamokshana conducted under strict aseptic conditions',             category:'compliance', ncism_ref:'§47(c) + §47(a)(xv)'},
    {item_name:'Ksharasutra preparation NOT done in Operation Theatre',               category:'compliance', ncism_ref:'§47(b)(viii)'},
    {item_name:'Shalya faculty or designated qualified doctor present for all procedures', category:'compliance', ncism_ref:'§47(c)'},
    {item_name:'COGI-certified instruments preferred for Anushastra Karma equipment (§47(m))', category:'compliance', ncism_ref:'§47(m)'},
    // Schedule XXVII #1-6 — Anushastra Karma Procedural Room Equipment (Reg 47)
    {item_name:'Computer with internet and printer — min 1 [Sch XXVII #1]',           category:'equipment',  ncism_ref:'Sch XXVII #1'},
    {item_name:'Agnikarma Kits with all accessories + clotting and bleeding time estimation kit — as required [Sch XXVII #2]', category:'equipment', ncism_ref:'Sch XXVII #2'},
    {item_name:'Jaloukacharna kits with all accessories + Jalouka (leeches) + clotting and bleeding time estimation kit — as required [Sch XXVII #3]', category:'equipment', ncism_ref:'Sch XXVII #3'},
    {item_name:'Siravyadha kits with all accessories + clotting and bleeding time estimation kit — as required [Sch XXVII #4]', category:'equipment', ncism_ref:'Sch XXVII #4'},
    {item_name:'Cupping therapy kits with all accessories + clotting and bleeding time estimation kit — as required [Sch XXVII #5]', category:'equipment', ncism_ref:'Sch XXVII #5'},
    {item_name:'Other therapy kits as applicable — as required [Sch XXVII #6]',       category:'equipment',  ncism_ref:'Sch XXVII #6'},
    // Schedule XXIV — Minimum area
    {item_name:'Anushastra Karma section area — min 30 sqm (60–100) / 80 (150) / 100 (200) [Sch XXIV #10]', category:'space', ncism_ref:'Sch XXIV #10'},
  ],

  // ── LABOUR ROOM ───────────────────────────────────────────────────────────
  labour_room:[
    // Space
    {item_name:'Dedicated labour room (Prasuti ward section)',                        category:'space',      ncism_ref:'Sch XVI - Sec 8'},
    {item_name:'Minimum 2 delivery beds / obstetric tables',                         category:'space',      ncism_ref:'Sch XVI - Sec 8(a)'},
    {item_name:'Ante-natal examination room',                                        category:'space',      ncism_ref:'Sch XVI - Sec 8(b)'},
    {item_name:'Neonatal resuscitation area',                                        category:'space',      ncism_ref:'Sch XVI - Sec 8(c)'},
    {item_name:'Post-delivery observation beds',                                     category:'space',      ncism_ref:'Sch XVI - Sec 8(d)'},
    {item_name:'Separate toilet for parturients',                                    category:'space',      ncism_ref:'Sch XVI - Sec 8(e)'},
    {item_name:'Changing room / locker for parturients',                             category:'space',      ncism_ref:'Sch XVI - Sec 8(f)'},
    {item_name:'Placenta disposal area',                                             category:'space',      ncism_ref:'Sch XVI - Sec 8(g)'},
    {item_name:'Instrument sterilization area in labour room',                       category:'space',      ncism_ref:'Sch XVI - Sec 8(h)'},
    // Equipment
    {item_name:'Delivery table (obstetric)',                                         category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Neonatal resuscitation table with radiant heat lamp',                category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Baby warmer / incubator',                                            category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Fetal Doppler / CTG machine',                                        category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Vacuum extractor / forceps delivery kit',                            category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Neonatal suction device',                                            category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Emergency drug tray (oxytocin, MgSO₄, IV fluids)',                  category:'equipment',  ncism_ref:'Sch XIX'},
    {item_name:'BP apparatus, pulse oximeter, IV stands',                           category:'equipment',  ncism_ref:'Sch XX'},
    // Digital & HMIS
    {item_name:'Partograph / labour progress documented in HMIS',                    category:'digital',    ncism_ref:'NCISM Sec 35'},
    {item_name:'Delivery register maintained (mother + baby outcome)',               category:'digital',    ncism_ref:'NCISM Sec 35'},
    {item_name:'Birth certificate and MLC documentation in HMIS',                   category:'digital',    ncism_ref:'NCISM Sec 35'},
    // Compliance & Staffing
    {item_name:'24×7 resident Prasuti faculty or trained MO on duty',               category:'compliance', ncism_ref:'NCISM Sec 40'},
    {item_name:'Staff nurse / ANM trained in obstetric care on duty',               category:'compliance', ncism_ref:'NCISM Sec 23'},
    {item_name:'Informed consent for all procedures (episiotomy, LSCS)',             category:'compliance', ncism_ref:'NABH/NCISM'},
    {item_name:'PCPNDT Act 1994 notice displayed',                                   category:'compliance', ncism_ref:'PCPNDT Act 1994'},
    {item_name:'Maternal and neonatal mortality review committee constituted',       category:'compliance', ncism_ref:'NCISM Sec 40'},
    // §47(d) Labour Room — specific room breakdown
    {item_name:'Waiting room for patients (labour room zone)',                        category:'space',      ncism_ref:'§47(d)(ii)'},
    {item_name:'Preparation room (pre-labour)',                                       category:'space',      ncism_ref:'§47(d)(ii)'},
    {item_name:'Labour room proper (delivery bay)',                                   category:'space',      ncism_ref:'§47(d)(ii)'},
    {item_name:'Post-partum recovery room',                                           category:'space',      ncism_ref:'§47(d)(ii)'},
    {item_name:'New-born care corner (adjacent to labour room)',                      category:'space',      ncism_ref:'§47(d)(ii)'},
    // Schedule XXVIII — Minimum equipment for Labour Room (Reg 47) — 40 items
    {item_name:'Labour room: Computer with internet and printer — min 1 [Sch XXVIII #1]', category:'equipment', ncism_ref:'Sch XXVIII #1'},
    {item_name:'Labour room: Shadowless Lamp — min 1 [Sch XXVIII #2]',               category:'equipment',  ncism_ref:'Sch XXVIII #2'},
    {item_name:'Labour room: Suction Machine (Neonatal) — min 1 [Sch XXVIII #3]',    category:'equipment',  ncism_ref:'Sch XXVIII #3'},
    {item_name:'Labour room: Oxygen Cylinder and Mask — min 1 [Sch XXVIII #4]',      category:'equipment',  ncism_ref:'Sch XXVIII #4'},
    {item_name:'Labour room: Foetal Toco Cardiograph or Foetal Doppler — min 1 [Sch XXVIII #5]', category:'equipment', ncism_ref:'Sch XXVIII #5'},
    {item_name:'Labour room: Weighing Machine (Paediatric) — min 1 [Sch XXVIII #6]', category:'equipment',  ncism_ref:'Sch XXVIII #6'},
    {item_name:'Labour room: Patient trolley — min 1 [Sch XXVIII #7]',               category:'equipment',  ncism_ref:'Sch XXVIII #7'},
    {item_name:'Labour room: Infantometer — min 1 [Sch XXVIII #8]',                  category:'equipment',  ncism_ref:'Sch XXVIII #8'},
    {item_name:'Labour room: Vacuum extractor — min 1 [Sch XXVIII #9]',              category:'equipment',  ncism_ref:'Sch XXVIII #9'},
    {item_name:'Labour room: Forceps obstetrics — as required [Sch XXVIII #10]',     category:'equipment',  ncism_ref:'Sch XXVIII #10'},
    {item_name:'Labour room: Steriliser — min 1 [Sch XXVIII #11]',                   category:'equipment',  ncism_ref:'Sch XXVIII #11'},
    {item_name:'Labour room: Instruments for labour and Episiotomy (scissors, forceps, needle holders) — as required [Sch XXVIII #12]', category:'equipment', ncism_ref:'Sch XXVIII #12'},
    {item_name:'Labour room: Baby tray — as required [Sch XXVIII #13]',              category:'equipment',  ncism_ref:'Sch XXVIII #13'},
    {item_name:'Labour room: Nebuliser — as required [Sch XXVIII #14]',              category:'equipment',  ncism_ref:'Sch XXVIII #14'},
    {item_name:'Labour room: Foetoscope — as required [Sch XXVIII #15]',             category:'equipment',  ncism_ref:'Sch XXVIII #15'},
    {item_name:'Labour room: Instrumental Trolley — min 2 [Sch XXVIII #16]',         category:'equipment',  ncism_ref:'Sch XXVIII #16'},
    {item_name:'Labour room: Labour table with Lithotomy bars — min 1 [Sch XXVIII #17]', category:'equipment', ncism_ref:'Sch XXVIII #17'},
    {item_name:'Labour room: Pulse Oximeter — as required [Sch XXVIII #18]',         category:'equipment',  ncism_ref:'Sch XXVIII #18'},
    {item_name:'Labour room: Resuscitation kit — as required [Sch XXVIII #19]',      category:'equipment',  ncism_ref:'Sch XXVIII #19'},
    {item_name:'Labour room: Electrocautery — min 1 [Sch XXVIII #20]',               category:'equipment',  ncism_ref:'Sch XXVIII #20'},
    {item_name:'Labour room: Medical Termination of Pregnancy Suction Machine with curette — min 1 [Sch XXVIII #21]', category:'equipment', ncism_ref:'Sch XXVIII #21'},
    {item_name:'Labour room: Blunt and Sharp Curettes — as required [Sch XXVIII #22]', category:'equipment', ncism_ref:'Sch XXVIII #22'},
    {item_name:'Labour room: Dilators set (Hegar\'s, Hawkins) — as required [Sch XXVIII #23]', category:'equipment', ncism_ref:'Sch XXVIII #23'},
    {item_name:'Labour room: Sims\'s Speculum — as required [Sch XXVIII #24]',       category:'equipment',  ncism_ref:'Sch XXVIII #24'},
    {item_name:'Labour room: Cusco\'s Speculum — as required [Sch XXVIII #25]',      category:'equipment',  ncism_ref:'Sch XXVIII #25'},
    {item_name:'Labour room: Uterine sound — as required [Sch XXVIII #26]',          category:'equipment',  ncism_ref:'Sch XXVIII #26'},
    {item_name:'Labour room: Valsellum — as required [Sch XXVIII #27]',              category:'equipment',  ncism_ref:'Sch XXVIII #27'},
    {item_name:'Labour room: Sponge holding forceps — as required [Sch XXVIII #28]', category:'equipment',  ncism_ref:'Sch XXVIII #28'},
    {item_name:'Labour room: Kocher\'s forceps — as required [Sch XXVIII #29]',      category:'equipment',  ncism_ref:'Sch XXVIII #29'},
    {item_name:'Labour room: Artery forceps — Long, Short, Mosquito (each as required) [Sch XXVIII #30]', category:'equipment', ncism_ref:'Sch XXVIII #30'},
    {item_name:'Labour room: Scissors (different sizes) and Episiotomy Scissors — as required [Sch XXVIII #31]', category:'equipment', ncism_ref:'Sch XXVIII #31'},
    {item_name:'Labour room: Endotracheal tubes — as required [Sch XXVIII #32]',     category:'equipment',  ncism_ref:'Sch XXVIII #32'},
    {item_name:'Labour room: Cord Cutting appliances — as required [Sch XXVIII #33]', category:'equipment', ncism_ref:'Sch XXVIII #33'},
    {item_name:'Labour room: Intrauterine Contraceptive Device removing hook — as required [Sch XXVIII #34]', category:'equipment', ncism_ref:'Sch XXVIII #34'},
    {item_name:'Labour room: Bladder Sound — as required [Sch XXVIII #35]',          category:'equipment',  ncism_ref:'Sch XXVIII #35'},
    {item_name:'Labour room: Blood Pressure Apparatus — as required [Sch XXVIII #36]', category:'equipment', ncism_ref:'Sch XXVIII #36'},
    // Schedule XXVIII — Miscellaneous (#37-40)
    {item_name:'Labour room: HIV, VDRL and Hepatitis-B rapid kits for emergency patients — as required [Sch XXVIII #37]', category:'equipment', ncism_ref:'Sch XXVIII #37'},
    {item_name:'Labour room: Plain and Hole towels — as required [Sch XXVIII #38]',  category:'equipment',  ncism_ref:'Sch XXVIII #38'},
    {item_name:'Labour room: Towel Clips — as required [Sch XXVIII #39]',            category:'equipment',  ncism_ref:'Sch XXVIII #39'},
    {item_name:'Labour room: Catguts and Thread — as required [Sch XXVIII #40]',     category:'equipment',  ncism_ref:'Sch XXVIII #40'},
    {item_name:'Labour room: Suturing Needles — as required [Sch XXVIII #41]',       category:'equipment',  ncism_ref:'Sch XXVIII #41'},
    {item_name:'Labour room: Needle holders — as required [Sch XXVIII #42]',         category:'equipment',  ncism_ref:'Sch XXVIII #42'},
    {item_name:'Labour room: Fumigator (Dhoopan Yantra) — min 1 [Sch XXVIII #43]',  category:'equipment',  ncism_ref:'Sch XXVIII #43'},
    {item_name:'Labour room: Mackintosh rubber sheet — as required [Sch XXVIII #44]',category:'equipment',  ncism_ref:'Sch XXVIII #44'},
    {item_name:'Labour room: Drums — as required [Sch XXVIII #45]',                  category:'equipment',  ncism_ref:'Sch XXVIII #45'},
    {item_name:'Labour room: Dressing materials and the like — as required [Sch XXVIII #46]', category:'equipment', ncism_ref:'Sch XXVIII #46'},
    // Schedule XXIV — Minimum area
    {item_name:'Labour room area — min 50 sqm (60–100) / 60 (150) / 75 (200) [Sch XXIV #11]', category:'space', ncism_ref:'Sch XXIV #11'},
  ],

  // ── GARBHASAMSKARA SECTION (§47(h)) ──────────────────────────────────────
  garbhasamskara:[
    {item_name:'Garbhasamskara facility under admin control of Prasuti & Streeroga dept head', category:'compliance', ncism_ref:'§47(h)(i)'},
    {item_name:'Room with cubicles — adequate for individual AV-assisted sessions',   category:'space',      ncism_ref:'§47(h)(i)'},
    {item_name:'Audio-visual equipment (projector/screen/sound system) for yoga, music, mantra sessions', category:'equipment', ncism_ref:'§47(h)(ii)'},
    {item_name:'Yoga component: mats, cushions, AV demonstrations',                   category:'equipment',  ncism_ref:'§47(h)(ii)'},
    {item_name:'Music therapy component: music system with appropriate antenatal music', category:'equipment', ncism_ref:'§47(h)(ii)'},
    {item_name:'Mantra / chanting facilitation materials (printed texts, audio)',     category:'equipment',  ncism_ref:'§47(h)(ii)'},
    {item_name:'Trained faculty for conducting Garbhasamskara sessions',              category:'compliance', ncism_ref:'§47(h)(i)'},
    {item_name:'Programme schedule for antenatal classes (nutrition, delivery prep, breastfeeding)', category:'compliance', ncism_ref:'§47(h)(ii)'},
    {item_name:'Garbhasamskara attendance recorded in HMIS',                          category:'digital',    ncism_ref:'§47(h)'},
    // Schedule XXIV — Minimum area
    {item_name:'Garbhasanskara facility area — min 30 sqm (60–100) / 50 sqm (150–200) [Sch XXIV #13]', category:'space', ncism_ref:'Sch XXIV #13'},
  ],

  // ── NICU (§47(i)) ─────────────────────────────────────────────────────────
  nicu:[
    {item_name:'Dedicated NICU area adjacent to labour room (NCISM mandatory)',       category:'space',      ncism_ref:'§47(i)'},
    // Schedule XXIX — Minimum requirements of NICU adjacent to labour room (Reg 47)
    {item_name:'NICU: Computer with internet and printer — min 1 [Sch XXIX #1]',     category:'equipment',  ncism_ref:'Sch XXIX #1'},
    {item_name:'NICU: Radiant warmer — min 1 [Sch XXIX #2]',                         category:'equipment',  ncism_ref:'Sch XXIX #2'},
    {item_name:'NICU: Phototherapy unit — min 1 [Sch XXIX #3]',                      category:'equipment',  ncism_ref:'Sch XXIX #3'},
    {item_name:'NICU: Resuscitation Kit — min 5 [Sch XXIX #4]',                      category:'equipment',  ncism_ref:'Sch XXIX #4'},
    {item_name:'NICU: Neonatal Suction Machine — min 1 [Sch XXIX #5]',               category:'equipment',  ncism_ref:'Sch XXIX #5'},
    {item_name:'NICU: Oxygen Unit — min 1 [Sch XXIX #6]',                            category:'equipment',  ncism_ref:'Sch XXIX #6'},
    {item_name:'NICU: Oxygen hood nasal prong set — min 2 [Sch XXIX #7]',            category:'equipment',  ncism_ref:'Sch XXIX #7'},
    {item_name:'NICU: Laryngoscope — min 3 [Sch XXIX #8]',                           category:'equipment',  ncism_ref:'Sch XXIX #8'},
    {item_name:'NICU: Endotracheal tube — as required [Sch XXIX #9]',                category:'equipment',  ncism_ref:'Sch XXIX #9'},
    {item_name:'NICU: Suction catheter — as required [Sch XXIX #10]',                category:'equipment',  ncism_ref:'Sch XXIX #10'},
    {item_name:'NICU: Neonatal Blood Pressure cuff — min 2 [Sch XXIX #11]',          category:'equipment',  ncism_ref:'Sch XXIX #11'},
    {item_name:'NICU: Neonatal intensive care unit clinical Thermometer — min 2 [Sch XXIX #12]', category:'equipment', ncism_ref:'Sch XXIX #12'},
    {item_name:'NICU: Multi-parameter Monitor — min 1 [Sch XXIX #13]',               category:'equipment',  ncism_ref:'Sch XXIX #13'},
    // Compliance
    {item_name:'24×7 trained neonatal nurse on duty',                                 category:'compliance', ncism_ref:'§47(i)'},
    {item_name:'Neonatologist / Kaumarabhritya consultant on call',                  category:'compliance', ncism_ref:'§47(i)'},
    {item_name:'Neonatal outcome register maintained in HMIS',                        category:'digital',    ncism_ref:'§47(i)'},
    {item_name:'COGI-certified equipment preferred for NICU instruments (§47(m))',    category:'compliance', ncism_ref:'§47(m)'},
  ],

  // ── KRIYAKALPA SECTION (§47(j)) ───────────────────────────────────────────
  kriyakalpa:[
    // Space — common for OPD and IPD, under Shalakya dept
    {item_name:'Kriyakalpa section under admin control of Shalakya dept / designated faculty', category:'compliance', ncism_ref:'§47(j)(iii)(iv)'},
    {item_name:'Common facility for both OPD and IPD procedures',                     category:'compliance', ncism_ref:'§47(j)(ii)'},
    {item_name:'Reception and waiting room',                                           category:'space',      ncism_ref:'§47(j)(i)'},
    {item_name:'Preparation room (for medicines and materials)',                       category:'space',      ncism_ref:'§47(j)(i)'},
    {item_name:'Store room (oils, medications, Shalakya instruments)',                category:'space',      ncism_ref:'§47(j)(i)'},
    {item_name:'Individual therapy rooms or cubicles (eye, ear, nose, throat)',       category:'space',      ncism_ref:'§47(j)(i)'},
    {item_name:'Therapists room (for Kriyakalpa therapists)',                         category:'space',      ncism_ref:'Sec 44(vii)(i)'},
    {item_name:'Biomedical waste management area',                                    category:'space',      ncism_ref:'§47(j)(vii)'},
    {item_name:'Pantry for medicine preparation — hygienic + cubicle compartments',  category:'space',      ncism_ref:'§47(j)(v)'},
    // Equipment (Schedule XX and XXIV)
    {item_name:'Netra Tarpana equipment (ghee trough, eye frame/mould, cotton)',     category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Karna Purana materials (warmed oils, cotton wicks, dropper)',        category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Nasya set (nasal oils, dropper, instillation kit)',                   category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Gandusha / Kavala Graha materials (medicated oils/decoctions)',      category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Akshi Seka / Aschotana equipment',                                    category:'equipment',  ncism_ref:'Sch XX'},
    {item_name:'Slit-lamp / magnifying loupe for pre-Kriyakalpa assessment',         category:'equipment',  ncism_ref:'Sch XXIV'},
    {item_name:'Visual acuity chart (Snellen) + torch for basic eye assessment',     category:'equipment',  ncism_ref:'Sch XXIV'},
    {item_name:'Minor Shalakya instruments (dilators, probes, forceps)',              category:'equipment',  ncism_ref:'Sch XXIV'},
    {item_name:'Sterilisation equipment for Shalakya instruments',                   category:'equipment',  ncism_ref:'Sch XX'},
    // Compliance
    {item_name:'Therapists trained in Kriyakalpa techniques',                         category:'compliance', ncism_ref:'§47(j)(vi)'},
    {item_name:'Therapists: periodic health check-ups + no contagious/eye/skin diseases', category:'compliance', ncism_ref:'§47(j)(vi)'},
    {item_name:'Specialised eye/ear/nose/throat procedures performed in Kriyakalpa section', category:'compliance', ncism_ref:'§47(j)(viii)'},
    {item_name:'Other common PK procedures may also be performed per §47(j)(viii)',   category:'compliance', ncism_ref:'§47(j)(viii)'},
    {item_name:'Norms per Schedule XX and XXIV satisfied',                            category:'compliance', ncism_ref:'Sch XX + XXIV'},
    {item_name:'COGI-certified instruments preferred for Shalakya/Kriyakalpa equipment procurement (§47(m))', category:'compliance', ncism_ref:'§47(m)'},
    // Schedule XXIV — Minimum area
    {item_name:'Kriyakalpa section area — min 30 sqm (60–100) / 50 sqm (150–200) [Sch XXIV #14]', category:'space', ncism_ref:'Sch XXIV #14'},
    // Digital
    {item_name:'Kriyakalpa procedure register in HMIS',                               category:'digital',    ncism_ref:'§47(j)'},
  ],

  // ── PHYSIOTHERAPY SECTION (§47(k)) ────────────────────────────────────────
  physiotherapy:[
    // Space
    {item_name:'Physiotherapy section common for OPD and IPD',                        category:'compliance', ncism_ref:'§47(k)(i)'},
    {item_name:'Qualified physiotherapist as administrative head of this unit',       category:'compliance', ncism_ref:'§47(k)(ii)'},
    {item_name:'Individual therapy cubicles or sections (NCISM recommendation)',      category:'space',      ncism_ref:'§47(k)(iii)'},
    {item_name:'Open exercise / rehabilitation area',                                 category:'space',      ncism_ref:'§47(k)(iii)'},
    {item_name:'Equipment storage room',                                              category:'space',      ncism_ref:'§47(k)(iii)'},
    // Schedule XXX — Minimum equipment for Physiotherapy section (Reg 47) — 23 items
    {item_name:'Physiotherapy: Computer with internet and printer — min 1 [Sch XXX #1]', category:'equipment', ncism_ref:'Sch XXX #1'},
    {item_name:'Physiotherapy: Interferential therapy with wires and electrodes — min 1 (60–100) / 2 (150–200) [Sch XXX #2]', category:'equipment', ncism_ref:'Sch XXX #2'},
    {item_name:'Physiotherapy: Transcutaneous electrical nerve stimulation (TENS) with wires and electrodes — min 1 (60–100) / 2 (150–200) [Sch XXX #3]', category:'equipment', ncism_ref:'Sch XXX #3'},
    {item_name:'Physiotherapy: Ultrasound therapy with probes — min 1 (60–100) / 2 (150–200) [Sch XXX #4]', category:'equipment', ncism_ref:'Sch XXX #4'},
    {item_name:'Physiotherapy: Infra-red radiation therapy — min 4 (60) / 6 (100) / 8 (150) / 10 (200) [Sch XXX #5]', category:'equipment', ncism_ref:'Sch XXX #5'},
    {item_name:'Physiotherapy: Hot moist packs unit with silica packs — min 1 (60–100) / 2 (150–200) [Sch XXX #6]', category:'equipment', ncism_ref:'Sch XXX #6'},
    {item_name:'Physiotherapy: Cryotherapy unit with cryo packs — min 1 (60–100) / 2 (150–200) [Sch XXX #7]', category:'equipment', ncism_ref:'Sch XXX #7'},
    {item_name:'Physiotherapy: LASER therapy — min 1 (60–100) / 2 (150–200) [Sch XXX #8]', category:'equipment', ncism_ref:'Sch XXX #8'},
    {item_name:'Physiotherapy: Traction unit with lumbar and cervical belts — min 2 (60) / 4 (100) / 6 (150) / 8 (200) [Sch XXX #9]', category:'equipment', ncism_ref:'Sch XXX #9'},
    {item_name:'Physiotherapy: Suspension therapy with slings — as required [Sch XXX #10]', category:'equipment', ncism_ref:'Sch XXX #10'},
    {item_name:'Physiotherapy: Parallel Bar — min 1 [Sch XXX #11]',                  category:'equipment',  ncism_ref:'Sch XXX #11'},
    {item_name:'Physiotherapy: Treadmill — min 1 (60–100) / 2 (150–200) [Sch XXX #12]', category:'equipment', ncism_ref:'Sch XXX #12'},
    {item_name:'Physiotherapy: Tilt Table — min 1 (60–100) / 2 (150–200) [Sch XXX #13]', category:'equipment', ncism_ref:'Sch XXX #13'},
    {item_name:'Physiotherapy: Electrical stimulation with wires and electrodes — min 1 (60–100) / 2 (150–200) [Sch XXX #14]', category:'equipment', ncism_ref:'Sch XXX #14'},
    {item_name:'Physiotherapy: Musculoskeletal exercise equipment (shoulder wheel, finger-grip stretcher, rebalanced finger-grip) — min 2 [Sch XXX #15]', category:'equipment', ncism_ref:'Sch XXX #15'},
    // Schedule XXX — Prasuti-related items
    {item_name:'Physiotherapy (Prasuti): Pelvic Floor 360 — assorted [Sch XXX #16]', category:'equipment',  ncism_ref:'Sch XXX #16'},
    {item_name:'Physiotherapy (Prasuti): Perineometer — assorted [Sch XXX #17]',     category:'equipment',  ncism_ref:'Sch XXX #17'},
    {item_name:'Physiotherapy (Prasuti): Kegel Cones — assorted [Sch XXX #18]',      category:'equipment',  ncism_ref:'Sch XXX #18'},
    // Schedule XXX — Paediatric-related items
    {item_name:'Physiotherapy (Paediatric): Bobath ball of different sizes — assorted [Sch XXX #19]', category:'equipment', ncism_ref:'Sch XXX #19'},
    {item_name:'Physiotherapy (Paediatric): Trampoline — assorted [Sch XXX #20]',    category:'equipment',  ncism_ref:'Sch XXX #20'},
    {item_name:'Physiotherapy (Paediatric): Bolster of different shapes — min 1 [Sch XXX #21]', category:'equipment', ncism_ref:'Sch XXX #21'},
    {item_name:'Physiotherapy (Paediatric): Sensory integration kit — assorted [Sch XXX #22]', category:'equipment', ncism_ref:'Sch XXX #22'},
    {item_name:'Physiotherapy (Paediatric): Small Walkers — assorted [Sch XXX #23]', category:'equipment',  ncism_ref:'Sch XXX #23'},
    // Digital & Compliance
    {item_name:'Physiotherapy referral and outcome register in HMIS',                 category:'digital',    ncism_ref:'§47(k)'},
    {item_name:'COGI-certified equipment preferred for physiotherapy instrument procurement (§47(m))', category:'compliance', ncism_ref:'§47(m)'},
    // Schedule XXIV — Minimum area
    {item_name:'Physiotherapy section area — min 100 sqm (60–100) / 125 sqm (150) / 150 sqm (200) [Sch XXIV #15]', category:'space', ncism_ref:'Sch XXIV #15'},
  ],

  // ── YOGA SECTION (§47(l)) — under Swasthavritta dept ─────────────────────
  yoga_section:[
    {item_name:'Yoga section under dept of Swasthavritta (Yoga demonstrator = in-charge)', category:'compliance', ncism_ref:'§47(l)(i)(ii)'},
    {item_name:'Adequate space for yoga demonstration and group practice',            category:'space',      ncism_ref:'§47(l)(iii)'},
    {item_name:'Proper ventilation + adequate natural light',                         category:'space',      ncism_ref:'§47(l)(iii)'},
    {item_name:'Audio-visual aids for yoga, pranayama, and kriya instruction',       category:'equipment',  ncism_ref:'§47(l)(iii)'},
    {item_name:'Sufficient yoga mats for all participants',                           category:'equipment',  ncism_ref:'§47(l)(iii)'},
    {item_name:'Open to healthy individuals as well as patients',                     category:'compliance', ncism_ref:'§47(l)(iii)'},
    {item_name:'Swasthavritta consultants prescribe therapeutic yogic procedures, pranayama, kriya', category:'compliance', ncism_ref:'§47(l)(iv)'},
    {item_name:'Yoga demonstrator demonstrates prescribed procedures to patients',    category:'compliance', ncism_ref:'§47(l)(iv)'},
    {item_name:'Yoga attendance and session register maintained',                     category:'digital',    ncism_ref:'§47(l)'},
    {item_name:'Norms per Schedule XX and XXIV satisfied',                            category:'compliance', ncism_ref:'Sch XX + XXIV'},
    // Schedule XXIV — Minimum area
    {item_name:'Yoga section area — min 50 sqm (60–100) / 75 sqm (150) / 100 sqm (200) [Sch XXIV #16]', category:'space', ncism_ref:'Sch XXIV #16'},
  ],

  // ── LIBRARY ───────────────────────────────────────────────────────────────
  library:[
    // Space
    {item_name:'Reading hall with seating capacity for 1/3 of total students',       category:'space',      ncism_ref:'NCISM Sec 21(a)'},
    {item_name:'Stack room with shelves for book storage',                           category:'space',      ncism_ref:'NCISM Sec 21(b)'},
    {item_name:'Reference section with standard textbooks',                          category:'space',      ncism_ref:'NCISM Sec 21(c)'},
    {item_name:'Computer room with internet (within or adjacent to library)',        category:'space',      ncism_ref:'NCISM Sec 21(d)'},
    {item_name:'Periodical / journal section',                                       category:'space',      ncism_ref:'NCISM Sec 21(e)'},
    {item_name:'Librarian room',                                                     category:'space',      ncism_ref:'NCISM Sec 21(f)'},
    {item_name:'Discussion room',                                                    category:'space',      ncism_ref:'NCISM Sec 21(g)'},
    // Holdings & Equipment
    {item_name:'Minimum 5000 books (for 60-intake college)',                         category:'equipment',  ncism_ref:'NCISM Sec 21(h)'},
    {item_name:'Minimum 10 copies of standard textbooks per subject',                category:'equipment',  ncism_ref:'NCISM Sec 21(h)'},
    {item_name:'Minimum 10 national medical / AYUSH journals subscribed',            category:'equipment',  ncism_ref:'NCISM Sec 21(i)'},
    {item_name:'Minimum 5 international medical journals subscribed',                category:'equipment',  ncism_ref:'NCISM Sec 21(i)'},
    {item_name:'Computers with internet for e-library (1 per 10 students)',          category:'equipment',  ncism_ref:'NCISM Sec 21(d)'},
    {item_name:'Photocopier / printer',                                              category:'equipment',  ncism_ref:'NCISM Sec 21(j)'},
    // Digital
    {item_name:'Library Management Software (LMS) in use',                          category:'digital',    ncism_ref:'NCISM Sec 21(k)'},
    {item_name:'NML / INDMED / Shodhganga e-library subscription active',            category:'digital',    ncism_ref:'NCISM Sec 21(l)'},
    {item_name:'AYUSH Digital Library subscription active',                          category:'digital',    ncism_ref:'NCISM Sec 21(l)'},
    {item_name:'Book catalogue fully digitised',                                     category:'digital',    ncism_ref:'NCISM Sec 21(k)'},
    // Compliance & Staffing
    {item_name:'Librarian holding MLIS / BLIS qualification',                        category:'compliance', ncism_ref:'NCISM Sec 21(m)'},
    {item_name:'Library open minimum 10 hours per working day',                      category:'compliance', ncism_ref:'NCISM Sec 21(n)'},
    {item_name:'Book accession register maintained',                                 category:'compliance', ncism_ref:'NCISM Sec 21(o)'},
    {item_name:'Student membership register maintained',                             category:'compliance', ncism_ref:'NCISM Sec 21(o)'},
    {item_name:'Annual book purchase budget allocated and spent',                    category:'compliance', ncism_ref:'NCISM Sec 21(p)'},
  ],

  // ── HOSTEL ────────────────────────────────────────────────────────────────
  hostel:[
    // Space
    {item_name:'Separate hostel buildings for male and female students',             category:'space',      ncism_ref:'NCISM Sec 24(a)'},
    {item_name:'Minimum room size 9.5 sq m per student',                             category:'space',      ncism_ref:'NCISM Sec 24(b)'},
    {item_name:'Common room / recreation area',                                      category:'space',      ncism_ref:'NCISM Sec 24(c)'},
    {item_name:'Mess / dining hall (capacity for all residents)',                    category:'space',      ncism_ref:'NCISM Sec 24(d)'},
    {item_name:'Laundry facility / washing area',                                    category:'space',      ncism_ref:'NCISM Sec 24(e)'},
    {item_name:'Toilet / bathroom ratio 1 per 6 students',                          category:'space',      ncism_ref:'NCISM Sec 24(f)'},
    {item_name:'Indoor sports / gymnasium',                                          category:'space',      ncism_ref:'NCISM Sec 24(g)'},
    {item_name:'Warden residential quarters on campus',                              category:'space',      ncism_ref:'NCISM Sec 24(h)'},
    {item_name:'Guest room for parents / visitors',                                  category:'space',      ncism_ref:'NCISM Sec 24(i)'},
    {item_name:'Health room / sick bay within hostel',                               category:'space',      ncism_ref:'NCISM Sec 24(j)'},
    // Equipment & Facilities
    {item_name:'Bed, study table, chair, wardrobe per student',                      category:'equipment',  ncism_ref:'NCISM Sec 24(b)'},
    {item_name:'Hot water supply (solar / geyser) in all bathrooms',                 category:'equipment',  ncism_ref:'NCISM Sec 24(k)'},
    {item_name:'CCTV surveillance at entry and common areas',                        category:'equipment',  ncism_ref:'NCISM Sec 24(l)'},
    {item_name:'Intercom / emergency bell system',                                   category:'equipment',  ncism_ref:'NCISM Sec 24(m)'},
    {item_name:'Fire safety equipment (extinguishers, marked escape routes)',        category:'equipment',  ncism_ref:'NCISM Sec 24(n)'},
    {item_name:'Wi-Fi internet access throughout hostel',                            category:'equipment',  ncism_ref:'NCISM Sec 24(o)'},
    // Digital
    {item_name:'Hostel occupancy register maintained',                               category:'digital',    ncism_ref:'NCISM Sec 24(p)'},
    {item_name:'Student in-out attendance register maintained',                      category:'digital',    ncism_ref:'NCISM Sec 24(p)'},
    {item_name:'Mess menu and diet register maintained',                             category:'digital',    ncism_ref:'NCISM Sec 24(q)'},
    // Compliance & Staffing
    {item_name:'Resident warden appointed (residing in hostel)',                     category:'compliance', ncism_ref:'NCISM Sec 24(r)'},
    {item_name:'Female warden for girls hostel (mandatory)',                         category:'compliance', ncism_ref:'NCISM Sec 24(r)'},
    {item_name:'Anti-ragging committee constituted (UGC / NCISM mandate)',           category:'compliance', ncism_ref:'UGC/NCISM'},
    {item_name:'External boundary wall and 24×7 security',                          category:'compliance', ncism_ref:'NCISM Sec 24(s)'},
    {item_name:'Mess committee with student representation',                         category:'compliance', ncism_ref:'NCISM Sec 24(t)'},
  ],

  // ── PHARMACOVIGILANCE CELL (§48) ──────────────────────────────────────────
  pharmacovigilance_cell:[
    {item_name:'Pharmacovigilance Cell constituted per NCISM/National PV Cell regulations', category:'compliance', ncism_ref:'§48(1)'},
    {item_name:'Co-ordinator: Faculty from Rasashastra & Bhaishajyakalpana dept',   category:'compliance', ncism_ref:'§48(2)'},
    {item_name:'Co-ordinator: Faculty from Dravyaguna dept',                        category:'compliance', ncism_ref:'§48(2)'},
    {item_name:'Cell member: Kayachikitsa faculty',                                  category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Shalya Tantra faculty',                                 category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Shalakya Tantra faculty',                               category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Prasuti & Streeroga faculty',                           category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Kaumarabhritya faculty',                                category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Panchakarma faculty',                                   category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Swasthavritta faculty',                                 category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell member: Agada Tantra faculty',                                  category:'compliance', ncism_ref:'§48(3)'},
    {item_name:'Cell meets at least ONCE IN TWO MONTHS (mandatory frequency)',       category:'compliance', ncism_ref:'§48(4)'},
    {item_name:'ADR (Adverse Drug Reaction) identification and analysis at each meeting', category:'compliance', ncism_ref:'§48(4)'},
    {item_name:'Reports submitted to Regional / National / Central Pharmacovigilance Cell', category:'compliance', ncism_ref:'§48(4)'},
    {item_name:'ADR reporting register maintained in HMIS',                          category:'digital',    ncism_ref:'§48(4)'},
    {item_name:'Meeting minutes of PV Cell documented',                              category:'digital',    ncism_ref:'§48(4)'},
    {item_name:'Dedicated space / room for Pharmacovigilance Cell activities',       category:'space',      ncism_ref:'§48'},
  ],

  // ── ADMINISTRATIVE ZONE (§49) ─────────────────────────────────────────────
  administrative_zone:[
    // Space — offices
    {item_name:'Office of Medical Director',                                          category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Office of Medical Superintendent',                                    category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Deputy Medical Superintendent office',                               category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Administrator office',                                                category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Matron / Assistant Matron office',                                   category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Resident Medical Officers area',                                      category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Office Superintendent + Accountant workstation',                     category:'space',      ncism_ref:'§49(1)'},
    // Facilities (§49(2))
    {item_name:'Persons lounge — adequate seating, resting furniture, attached toilets', category:'space',  ncism_ref:'§49(2)'},
    {item_name:'Lounge: TV, newspapers, magazines, refreshment facility',            category:'equipment',  ncism_ref:'§49(2)'},
    {item_name:'Privacy provision for female consultants in waiting lounge',         category:'compliance', ncism_ref:'§49(2)'},
    {item_name:'Attached toilets for heads of institute',                             category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Separate male/female toilets for other administrative staff',        category:'space',      ncism_ref:'§49(1)'},
    {item_name:'Adequate pantry for administrative zone',                             category:'space',      ncism_ref:'§49(1)'},
    // Intern & staff rooms
    {item_name:'Separate intern room — individual lockers, furniture, attached toilets, recreational facility', category:'space', ncism_ref:'§49(3)'},
    {item_name:'Staff room — adequate seating + individual lockers or pigeon almirahs, attached toilets', category:'space', ncism_ref:'§49(4)'},
    // Meeting hall (§49(5))
    {item_name:'Meeting hall with audio-visual facility + online/offline conferencing [Sec 46(2)]', category:'space', ncism_ref:'Sec 46(2)'},
    {item_name:'Meeting hall capacity: accommodate at least THIRTY members for hospital-related meetings and clinical meetings [Sec 46(2)]', category:'compliance', ncism_ref:'Sec 46(2)'},
    // Store (§49(6))
    {item_name:'Hospital store with adequate and appropriate storage facility',       category:'space',      ncism_ref:'§49(6)'},
    {item_name:'Store computerised and aligned with HMIS',                            category:'digital',    ncism_ref:'§49(6)'},
    // Biometric (§49(7))
    {item_name:'Biometric attendance system established for ALL staff',               category:'digital',    ncism_ref:'§49(7)'},
    {item_name:'All staff and interns mark daily attendance in biometric system',     category:'compliance', ncism_ref:'§49(7)'},
    {item_name:'Biometric attendance interfaced with NCISM central server/control system', category:'digital', ncism_ref:'§49(7)'},
    // Schedule XXXI — Minimum constructed area for Administrative Zone units (Reg 49)
    {item_name:'Admin zone: Medical Director office — min 35 sqm (all intakes) [Sch XXXI #1]', category:'space', ncism_ref:'Sch XXXI #1'},
    {item_name:'Admin zone: Medical Superintendent office — min 35 sqm (all intakes) [Sch XXXI #2]', category:'space', ncism_ref:'Sch XXXI #2'},
    {item_name:'Admin zone: Personal Assistant to Medical Superintendent — min 10 sqm [Sch XXXI #3]', category:'space', ncism_ref:'Sch XXXI #3'},
    {item_name:'Admin zone: Deputy Medical Superintendent — min 20 sqm (60–100) / 40 sqm×2 (150) / 60 sqm×3 (200) [Sch XXXI #4]', category:'space', ncism_ref:'Sch XXXI #4'},
    {item_name:'Admin zone: Administrator office — min 20 sqm (60–100) / 40 sqm×2 (150) / 60 sqm×3 (200) [Sch XXXI #5]', category:'space', ncism_ref:'Sch XXXI #5'},
    {item_name:'Admin zone: Matron office — min 20 sqm (all intakes) [Sch XXXI #6]', category:'space', ncism_ref:'Sch XXXI #6'},
    {item_name:'Admin zone: Assistant Matron office — min 15 sqm (60–100) / 30 sqm×2 (150) / 45 sqm×3 (200) [Sch XXXI #7]', category:'space', ncism_ref:'Sch XXXI #7'},
    {item_name:'Admin zone: Office Superintendent — min 15 sqm (all intakes) [Sch XXXI #8]', category:'space', ncism_ref:'Sch XXXI #8'},
    {item_name:'Admin zone: Accountant and other office staff — min 30 sqm (all intakes) [Sch XXXI #9]', category:'space', ncism_ref:'Sch XXXI #9'},
    {item_name:'Admin zone: Waiting lounge for visitors — min 15 sqm (all intakes) [Sch XXXI #10]', category:'space', ncism_ref:'Sch XXXI #10'},
    {item_name:'Admin zone: Residential Medical Officers room — min 30 sqm (60–100) / 45 sqm (150–200) [Sch XXXI #11]', category:'space', ncism_ref:'Sch XXXI #11'},
    {item_name:'Admin zone: Toilets — min 20 sqm (all intakes) [Sch XXXI #12]',      category:'space',      ncism_ref:'Sch XXXI #12'},
    {item_name:'Admin zone: Pantry — min 05 sqm (all intakes) [Sch XXXI #13]',       category:'space',      ncism_ref:'Sch XXXI #13'},
    {item_name:'Admin zone: Doctors lounge — min 30 sqm (60–100) / 40 sqm (150–200) [Sch XXXI #14]', category:'space', ncism_ref:'Sch XXXI #14'},
    {item_name:'Admin zone: Interns room — min 50 sqm (60–100) / 75 sqm (150) / 100 sqm (200) [Sch XXXI #15]', category:'space', ncism_ref:'Sch XXXI #15'},
    {item_name:'Admin zone: Staff Room — min 50 sqm (60–100) / 75 sqm (150) / 100 sqm (200) [Sch XXXI #16]', category:'space', ncism_ref:'Sch XXXI #16'},
    {item_name:'Admin zone: Meeting hall — min 50 sqm (60–100) / 75 sqm (150–200) [Sch XXXI #17]', category:'space', ncism_ref:'Sch XXXI #17'},
    {item_name:'Admin zone: Store — min 50 sqm (60) / 75 sqm (100) / 100 sqm (150) / 150 sqm (200) [Sch XXXI #18]', category:'space', ncism_ref:'Sch XXXI #18'},
  ],

  // ── PALHA-DIET CENTRE (§50(1)) ────────────────────────────────────────────
  palha_diet_centre:[
    // Staffing
    {item_name:'In-charge: BAMS with ≥3 years experience OR M.Sc. Ayurvedic Dietetics', category:'compliance', ncism_ref:'§50(1)(a)'},
    {item_name:'Trained cooks posted',                                                category:'compliance', ncism_ref:'§50(1)(b)'},
    {item_name:'Multi-tasking workers (MTW) posted',                                  category:'compliance', ncism_ref:'§50(1)(b)'},
    {item_name:'Periodic health check-ups for all kitchen/cooking staff',             category:'compliance', ncism_ref:'§50(1)(h)'},
    // Space
    {item_name:'Adequate storage with refrigeration (for perishable items)',          category:'space',      ncism_ref:'§50(1)(c)'},
    {item_name:'Cooking area and packing area',                                       category:'space',      ncism_ref:'§50(1)(c)'},
    {item_name:'Dining area (optional)',                                               category:'space',      ncism_ref:'§50(1)(c)'},
    {item_name:'Toilets for palha-diet in-charge, interns and other staff',          category:'space',      ncism_ref:'§50(1)(c)'},
    // Indent system (§50(1)(d–f)) — HMS feature
    {item_name:'Indent system for Palha-diet: wards issue indents to palha-diet section', category:'digital', ncism_ref:'§50(1)(d)'},
    {item_name:'Indent contains: diet/medicine name, quantity, time of supply, special instructions', category:'digital', ncism_ref:'§50(1)(e)'},
    {item_name:'Electronic directory / display of SOPs for available preparations',  category:'digital',    ncism_ref:'§50(1)(f)'},
    {item_name:'Instant medicine preparations: Swarasa, Kashaya, Ksheerapaka covered in indent system', category:'digital', ncism_ref:'§50(1)(d)'},
    // Raw materials (§50(1)(g))
    {item_name:'Fresh herb supply arrangement for Swarasa, Kalka, Kashaya preparation', category:'equipment', ncism_ref:'§50(1)(g)'},
    {item_name:'COGI-certified equipment preferred for diet centre procurement (§47(m))', category:'compliance', ncism_ref:'§47(m)'},
  ],

  // ── SERVICES ZONE (§50) ───────────────────────────────────────────────────
  services_zone:[
    // Canteen (§50(2))
    {item_name:'Common canteen (if hospital and college on same campus)',              category:'space',      ncism_ref:'§50(2)(a)'},
    {item_name:'Separate hospital canteen (if hospital on separate campus)',          category:'space',      ncism_ref:'§50(2)(a)'},
    {item_name:'Separate seating sections: consultants/faculty | interns/students | nurses | other staff', category:'space', ncism_ref:'§50(2)(b)'},
    {item_name:'Adequate total seating capacity in canteen',                          category:'space',      ncism_ref:'§50(2)(b)'},
    // Mortuary (§50(3))
    {item_name:'Mortuary with cold storage OR MOU with medical establishment having mortuary facility', category:'compliance', ncism_ref:'§50(3)'},
    // Ambulance (§50(4))
    {item_name:'Own ambulance service (24 hours/day) OR MOU with ambulance service',  category:'compliance', ncism_ref:'§50(4)'},
    {item_name:'Ambulance available 24×7 including holidays',                         category:'compliance', ncism_ref:'§50(4)'},
    // BMW (§50(5)) — Biomedical Waste Management Rule 2016
    {item_name:'BMW Management system compliant with Biomedical Waste Management Rules 2016', category:'compliance', ncism_ref:'§50(5)'},
    {item_name:'Own biomedical waste disposal system OR MOU with authorised BMW management agency', category:'compliance', ncism_ref:'§50(5)'},
    {item_name:'BMW segregation: colour-coded bins at all points of waste generation', category:'equipment',  ncism_ref:'§50(5)'},
    {item_name:'BMW treatment facility (autoclave / incinerator) or authorised collection', category:'equipment', ncism_ref:'§50(5)'},
    // Laundry (§50(6))
    {item_name:'Linen satisfies two basic standards: cleanliness and disinfection',   category:'compliance', ncism_ref:'§50(6)(a)'},
    {item_name:'Facilities for washing, drying, pressing, storage of soiled and cleaned linen', category:'space', ncism_ref:'§50(6)(b)'},
    {item_name:'Laundry equipment housed within campus',                              category:'space',      ncism_ref:'§50(6)(b)'},
    {item_name:'Laundry outsourcing (if any) under overall supervision of Hospital Administrator', category:'compliance', ncism_ref:'§50(6)(c)'},
    // Housekeeping (§50(7))
    {item_name:'Adequate housekeeping staff for college, hospital and campus units',  category:'compliance', ncism_ref:'§50(7)(a)'},
    {item_name:'Housekeeping on contract basis or through registered outsourcing agencies', category:'compliance', ncism_ref:'§50(7)(b)'},
    // Security (§50(9))
    {item_name:'Trained security personnel at main entrance of Institute',            category:'compliance', ncism_ref:'§50(9)(a)(b)'},
    {item_name:'Security posts: all entrances and exits of college and hospital',     category:'compliance', ncism_ref:'§50(9)(b)'},
    {item_name:'Security post: entrance of teaching pharmacy',                        category:'compliance', ncism_ref:'§50(9)(b)'},
    {item_name:'Security post: entrances of hostels',                                 category:'compliance', ncism_ref:'§50(9)(b)'},
    {item_name:'Security post: library entrance',                                     category:'compliance', ncism_ref:'§50(9)(b)'},
    {item_name:'Security services may be outsourced through registered security agencies', category:'compliance', ncism_ref:'§50(9)(c)'},
    // Gas Supply (§50(11))
    {item_name:'Fixed cylinders for pipe gas supply appropriately placed',            category:'equipment',  ncism_ref:'§50(11)(a)'},
    {item_name:'Portable cylinders available as backup',                              category:'equipment',  ncism_ref:'§50(11)(a)'},
    {item_name:'Gas pipelines periodically maintained — maintenance record maintained', category:'digital',  ncism_ref:'§50(11)(b)'},
    {item_name:'Proper refilling or replacement system for uninterrupted gas supply', category:'compliance', ncism_ref:'§50(11)(b)'},
  ],

  // ── CSSD — CENTRAL STERILISATION UNIT (§50(8)) ───────────────────────────
  cssd:[
    {item_name:'Independent central sterilisation unit (CSSD) covering: OT, casualty, labour room, labs, OPD procedure rooms, IPD ward procedure rooms', category:'space', ncism_ref:'§50(8)(a)'},
    {item_name:'Separate loading end (dirty) and unloading end (clean/sterile)',      category:'space',      ncism_ref:'§50(8)(b)'},
    {item_name:'Sterile racks for storing sterilised packs',                          category:'equipment',  ncism_ref:'§50(8)(b)'},
    {item_name:'Packaging machine for wrapping sterile items',                        category:'equipment',  ncism_ref:'§50(8)(b)'},
    {item_name:'Instruments cleaning machine (ultrasonic cleaner / washer-disinfector)', category:'equipment', ncism_ref:'§50(8)(b)'},
    {item_name:'Steriliser / Autoclave (gravity + vacuum cycle)',                     category:'equipment',  ncism_ref:'§50(8)(b)'},
    {item_name:'Pass box between clean and dirty zones',                              category:'equipment',  ncism_ref:'§50(8)(b)'},
    {item_name:'Trays and instrument containers for dispatch to OT/wards',            category:'equipment',  ncism_ref:'§50(8)(b)'},
    {item_name:'CSSD register / tracking system in HMIS for sterile pack issue and return', category:'digital', ncism_ref:'§50(8)'},
    {item_name:'CSSD in-charge and trained sterilisation technician posted',          category:'compliance', ncism_ref:'§50(8)'},
    {item_name:'Sterilisation cycle records maintained with Bowie-Dick / biological indicator tests', category:'compliance', ncism_ref:'§50(8)'},
  ],

  // ── MAINTENANCE CELL (§50(10)) ────────────────────────────────────────────
  maintenance_cell:[
    {item_name:'Maintenance cell established for college and hospital',               category:'compliance', ncism_ref:'§50(10)(a)'},
    {item_name:'Common maintenance cell (if same campus) OR separate hospital maintenance cell', category:'compliance', ncism_ref:'§50(10)(a)'},
    {item_name:'Civil maintenance: building repairs, walls, flooring, roofing',       category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Electrical maintenance: wiring, switchgear, power backup, lighting', category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Plumbing and sanitation maintenance',                                 category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Carpentry and furniture maintenance',                                 category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Mechanical maintenance: generators, lifts, pumps',                   category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Water supply and drainage maintenance',                               category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Waste management systems maintenance',                                category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Air-conditioning and refrigeration equipment maintenance',            category:'compliance', ncism_ref:'§50(10)(b)'},
    {item_name:'Fixed space for maintenance workshop and equipment storage',          category:'space',      ncism_ref:'§50(10)(c)'},
    {item_name:'Qualified maintenance engineer / supervisor — appointed or outsourced', category:'compliance', ncism_ref:'§50(10)(c)'},
    {item_name:'Preventive maintenance schedule documented and followed',             category:'digital',    ncism_ref:'§50(10)'},
  ],

  // ── PHOTOGRAPHY & VIDEOGRAPHY SECTION (§50(12)) ───────────────────────────
  photography_section:[
    {item_name:'Photography and videography section established',                     category:'space',      ncism_ref:'§50(12)(a)'},
    {item_name:'Facility for documenting typical and atypical clinical presentations', category:'compliance', ncism_ref:'§50(12)(a)'},
    {item_name:'Clinical success stories documentation for academic and research purpose', category:'compliance', ncism_ref:'§50(12)(a)'},
    {item_name:'Green backdrop (standard photography background)',                    category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Suitable lighting system for clinical photography',                   category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Camera (digital SLR / mirrorless)',                                   category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Video camera for clinical documentation',                             category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Audio recording system',                                              category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Audio-video editing facility (computer + editing software)',          category:'equipment',  ncism_ref:'§50(12)(b)'},
    {item_name:'Patient consent obtained before all clinical photography/videography', category:'compliance', ncism_ref:'§50(12)'},
    {item_name:'Clinical media archive maintained (with patient anonymisation for academic use)', category:'digital', ncism_ref:'§50(12)'},
  ],

  // ── HUMAN RESOURCES — §51 COMPLIANCE ─────────────────────────────────────
  human_resources_admin:[
    // §51(1) Medical Director
    {item_name:'Medical Director = Dean / Principal / Director (as designated) — order in writing', category:'compliance', ncism_ref:'§51(1)'},
    {item_name:'All attached teaching hospitals under academic, administrative and disciplinary control of Medical Director', category:'compliance', ncism_ref:'§51(1)'},
    // §51(2) Medical Superintendent
    {item_name:'MS qualification: PG in Kayachikitsa/PK/Shalya/Shalakya/Prasuti-Streeroga/Kaumarabhritya/Agada/Manasaroga-Rasayana-Vajikarana + 10 years experience (≥3 years as HOD/Deputy MS/Vice Principal)', category:'compliance', ncism_ref:'§51(2)(a)'},
    {item_name:'OR: MS qualification — BAMS + MBA (Hospital Administration) + 10 years as Deputy MS / Hospital Administrator in NABH-accredited multi-speciality hospital', category:'compliance', ncism_ref:'§51(2)(a)'},
    {item_name:'Medical Superintendent is full-time regular staff — NOT concurrently teaching staff of any department', category:'compliance', ncism_ref:'§51(2)(b)'},
    {item_name:'Medical Superintendent reports to and under supervision of Medical Director', category:'compliance', ncism_ref:'§51(2)(c)'},
    // §51(3) Deputy Medical Superintendent
    {item_name:'Deputy MS qualification: PG in Kayachikitsa/PK/Shalya/Shalakya/Prasuti-Streeroga/Kaumarabhritya/Agada/Manasaroga-Rasayana-Vajikarana; OR BAMS + MBA (Hospital Administration) as Deputy MS', category:'compliance', ncism_ref:'§51(3)(a)'},
    {item_name:'Deputy MS shall NOT be concurrently teaching staff of any department', category:'compliance', ncism_ref:'§51(3)(b)'},
    {item_name:'Deputy MS appointed/deputed from health services shall report to Medical Director', category:'compliance', ncism_ref:'§51(3)(c)'},
    // §51(4) Administrator
    {item_name:'Administrator qualification: MBA in Human Resource Management OR Operations Management OR Health Care Management', category:'compliance', ncism_ref:'§51(4)(a)'},
    {item_name:'Administrator works under supervision of Medical Superintendent', category:'compliance', ncism_ref:'§51(4)(a)'},
    {item_name:'Administrator is administrative head of: canteen, ambulance, BMW management, laundry, housekeeping, security, maintenance cell', category:'compliance', ncism_ref:'§51(4)(b)'},
    // §51(5) RMO / EMO / GDMO
    {item_name:'RMO/EMO/GDMO qualification: BAMS (Bachelor of Ayurvedic Medicine and Surgery) or MBBS', category:'compliance', ncism_ref:'§51(5)(a)'},
    {item_name:'RMO/EMO/GDMO attends Emergency OPD (Atyayika) duty ROUND THE CLOCK', category:'compliance', ncism_ref:'§51(5)(b)'},
    {item_name:'RMO/EMO/GDMO also attends emergencies in labour theatre and IPD wards', category:'compliance', ncism_ref:'§51(5)(b)'},
    {item_name:'RMO/EMO/GDMO executes emergency management in consultation with specialty consultants', category:'compliance', ncism_ref:'§51(5)(c)'},
    {item_name:'RMO/EMO/GDMO also performs night duties', category:'compliance', ncism_ref:'§51(5)(d)'},
    {item_name:'24×7 duty roster for RMO/EMO/GDMO — no gap in coverage', category:'digital', ncism_ref:'§51(5)'},
    // §51(6) Physiotherapist
    {item_name:'Physiotherapist qualification: Bachelor of Physiotherapy (BPT) or Master of Physiotherapy (MPT)', category:'compliance', ncism_ref:'§51(6)'},
    // §51(7) Matron
    {item_name:'Matron qualification: B.Sc. Nursing with 10 years experience OR GNM with 12 years experience registered with Nursing Council or Ayurveda Nursing (≥3 years) with 10 years Ayurveda hospital experience', category:'compliance', ncism_ref:'§51(7)'},
    // §51(8) Assistant Matron
    {item_name:'Assistant Matron qualification: B.Sc. Nursing with 5 years experience OR GNM with 8 years experience registered with Nursing Council or Ayurveda Nursing (≥3 years) with 5 years Ayurveda hospital experience', category:'compliance', ncism_ref:'§51(8)'},
    // General HR records
    {item_name:'All administrative and clinical appointments on record with qualification certificates', category:'digital', ncism_ref:'§51'},
    {item_name:'Staff appointment letters, joining reports, and service records maintained in HMIS', category:'digital', ncism_ref:'§51'},
    {item_name:'Staff qualifications verified and filed — NCISM inspection-ready', category:'compliance', ncism_ref:'§51'},
    // §51(9) Nursing staff
    {item_name:'Nursing staff qualification: B.Sc. Nursing OR GNM registered with Nursing Council OR Ayurveda Nursing Degree/Diploma (≥3 years, recognised University)', category:'compliance', ncism_ref:'§51(9)'},
    // §51(10) Lab Technician
    {item_name:'Laboratory Technician qualification: Diploma or Degree in Medical Laboratory Technology (DMLT/BMLT)', category:'compliance', ncism_ref:'§51(10)'},
    // §51(11) Pharmacist
    {item_name:'Pharmacist qualification: Diploma/Certificate in Ayurveda Pharmacy (recognised institution) OR 12th standard pass + training in Ayurveda Pharmacy/dispensary/drug store', category:'compliance', ncism_ref:'§51(11)'},
    // §51(12) Modern Medical Specialist Consultant
    {item_name:'Modern Medical Specialist Consultants engaged as required — PG/specialist qualification; full-time/part-time/contract basis permitted', category:'compliance', ncism_ref:'§51(12)'},
    {item_name:'Specialist consultant contracts/engagement letters on file for each consultant', category:'digital', ncism_ref:'§51(12)'},
    // §51(13) General staff
    {item_name:'All other hospital staff qualifications as per Schedule XX', category:'compliance', ncism_ref:'§51(13)'},
    {item_name:'Preference given to MSDE (Ministry of Skill Development and Entrepreneurship) trained skilled professionals in appointments', category:'compliance', ncism_ref:'§51(13)'},
  ],

  // ── HOSPITAL AREA SUMMARY (MESAR UG 2024) ────────────────────────────────
  hospital_area_summary:[
    // MESAR UG Ayurveda Regulations 2024 — Minimum Constructed Area for Hospital Section (zone-wise)
    {item_name:'Reception and registration zone (incl. entrance lobby + circulation) — min 130 sqm (60) / 180 (100) / 230 (150) / 280 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'OPD zone total — min 500 sqm (60) / 605 (100) / 810 (150) / 1035 (200) [MESAR 2024]',  category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'Diagnostic zone total — min 150 sqm (60) / 175 (100) / 200 (150) / 225 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'IPD Medical in-patients section total — min 780 sqm (60) / 1170 (100) / 1605 (150) / 2100 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'IPD Surgical in-patients section total — min 630 sqm (60) / 950 (100) / 1275 (150) / 1660 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'Panchakarma therapy section total — min 330 sqm (60) / 405 (100) / 590 (150) / 725 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'Surgical Therapy section total — min 520 sqm (60) / 640 (100) / 1050 (150) / 1185 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    {item_name:'Administrative zone (Hospital) total — min 500 sqm (60) / 525 (100) / 705 (150) / 860 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    // Schedule XXIV zone sub-totals
    {item_name:'Panchakarma therapy section TOTAL — min 330 sqm (60) / 405 (100) / 590 (150) / 725 (200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV - PK Total'},
    {item_name:'Surgical Therapy Section TOTAL (Minor OT + Major OT + Anushastra + Labour + Prasuti + Garbhasanskara + Kriyakalpa + Physio + Yoga) — min 520 sqm (60) / 640 (100) / 1050 (150) / 1185 (200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV - Surgical Therapy Total'},
    {item_name:'Procedural management zone TOTAL (PK + Surgical Therapy) — min 850 sqm (60) / 1045 (100) / 1640 (150) / 1910 (200) [Sch XXIV]', category:'space', ncism_ref:'Sch XXIV - Procedural Zone Total'},
    {item_name:'IPD zone TOTAL (Medical + Surgical) — min 1410 sqm (60) / 2120 (100) / 2880 (150) / 3760 (200) [Sch XXII]', category:'space', ncism_ref:'Sch XXII - IPD Total'},
    {item_name:'TOTAL Hospital Section — min 3540 sqm (60) / 4650 (100) / 6465 (150) / 8070 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024'},
    // Wi-fi Campus totals (College + Hospital combined)
    {item_name:'Wi-fi Campus TOTAL (College + Hospital) — min 10050 sqm (60) / 14815 (100) / 18800 (150) / 22520 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024 - Wi-fi Campus'},
    // Non Wi-fi Campus totals
    {item_name:'Non Wi-fi Campus TOTAL (College + Hospital) — min 10070 sqm (60) / 14835 (100) / 18820 (150) / 22540 (200) [MESAR 2024]', category:'space', ncism_ref:'MESAR 2024 - Non Wi-fi Campus'},
  ],
};

window.loadInfraSetup = async function(){
  const{data:depts}=await supabase.from('departments').select('id,name,category').eq('tenant_id',tenantId).order('name');
  const sel=document.getElementById('infra-dept-sel');
  sel.innerHTML='<option value="">— Select a Department —</option>'+
    (depts||[]).map(d=>`<option value="${d.id}" data-name="${(d.name||'').toLowerCase()}">${_esc(d.name)}</option>`).join('');
};

window.loadInfra = async function(){
  const sel=document.getElementById('infra-dept-sel');
  const deptId=sel.value;
  if(!deptId)return;
  const deptName=(sel.options[sel.selectedIndex]?.dataset.name||'');
  const wrap=document.getElementById('infra-body');
  const progWrap=document.getElementById('infra-prog-wrap');
  wrap.innerHTML=`<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading checklist…</div></div>`;

  const templateKey=_infraKey(deptName);
  let{data:items}=await supabase.from('infrastructure_items').select('*').eq('tenant_id',tenantId).eq('department_id',deptId).order('display_order');

  if((!items||!items.length)&&templateKey&&NCISM_INFRA[templateKey]){
    const ins=NCISM_INFRA[templateKey].map((x,i)=>({...x,tenant_id:tenantId,department_id:deptId,display_order:i,is_present:false}));
    await supabase.from('infrastructure_items').insert(ins);
    const{data:seeded}=await supabase.from('infrastructure_items').select('*').eq('tenant_id',tenantId).eq('department_id',deptId).order('display_order');
    items=seeded;
  }

  if(!items?.length){
    progWrap.style.display='none';
    wrap.innerHTML=`<div class="empty"><div class="empty-ico">🏗️</div><div class="empty-ttl">No checklist items yet</div><div class="empty-bod">NCISM items will appear here as you add each department's requirements.</div></div>`;
    return;
  }

  const total=items.length, present=items.filter(i=>i.is_present).length, pct=Math.round(present/total*100);
  progWrap.style.display='';
  document.getElementById('prog-lbl').textContent=`${present} / ${total} items present`;
  document.getElementById('prog-bar').style.width=pct+'%';
  document.getElementById('prog-pct').textContent=pct+'%';

  const catOrder=['space','equipment','digital','compliance'];
  const catLabels={space:'Space & Area',equipment:'Equipment & Facilities',digital:'Digital & HMIS',compliance:'Compliance & Staffing'};
  const grouped={};
  items.forEach(x=>{const c=x.category||'equipment';if(!grouped[c])grouped[c]=[];grouped[c].push(x);});

  wrap.innerHTML=catOrder.filter(c=>grouped[c]).map(cat=>`
    <div class="cc" style="margin-bottom:16px">
      <div class="infra-group-hd">${catLabels[cat]||cat}</div>
      ${grouped[cat].map(item=>`<div class="infra-item">
        <input type="checkbox" class="infra-cb" id="cb-${item.id}" ${item.is_present?'checked':''} data-onchange="toggleInfra" data-onchange-a0="${_esc(item.id)}" data-onchange-a1="@checked"/>
        <div class="infra-text">
          <div class="infra-name">${_esc(item.item_name)}</div>
          ${item.ncism_ref?`<div class="infra-ref">${_esc(item.ncism_ref)}</div>`:''}
        </div>
        <span class="infra-cat ${cat}">${(catLabels[cat]||cat).split(' ')[0]}</span>
      </div>`).join('')}
    </div>`).join('');
};

window.toggleInfra = async function(id, isPresent){
  const{error}=await supabase.from('infrastructure_items').update({is_present:isPresent,updated_by:profile.id,updated_at:new Date().toISOString()}).eq('id',id).eq('tenant_id',tenantId);
  if(error){_toast(safeErrorMessage(error,'Could not save infrastructure item.'),true);return;}
  const cbs=document.querySelectorAll('.infra-cb');
  const tot=cbs.length, pres=[...cbs].filter(c=>c.checked).length, pct=Math.round(pres/tot*100);
  document.getElementById('prog-lbl').textContent=`${pres} / ${tot} items present`;
  document.getElementById('prog-bar').style.width=pct+'%';
  document.getElementById('prog-pct').textContent=pct+'%';
  _toast(isPresent?'✓ Marked as present':'Marked absent');
};

function _infraKey(name){
  if(name.includes('reception')||name.includes('registration'))return 'reception';
  if(name.includes('screening'))return 'screening_opd';
  if(name.includes('emergency')||name.includes('atyayika'))return 'emergency_opd';
  if(name.includes('preventive')||name.includes('swasthya')||name.includes('lifestyle'))return 'preventive_opd';
  if(name.includes('kayachikitsa')||name.includes('internal medicine')||name.includes('general opd'))return 'kayachikitsa_opd';
  if(name.includes('panchakarma')||name.includes('pk opd')||name.includes('therapeutic'))return 'panchakarma_opd';
  if(name.includes('shalya')||name.includes('surgical'))return 'shalya_opd';
  if(name.includes('netra')||name.includes('ophthalmology')||name.includes('eye'))return 'shalakya_netra_opd';
  if(name.includes('karna')||name.includes('naasa')||name.includes('mukha')||name.includes('ent')||name.includes('oto'))return 'shalakya_ent_opd';
  if(name.includes('prasuti')||name.includes('streeroga')||name.includes('obstetric')||name.includes('gynaec'))return 'prasuti_streeroga_opd';
  if(name.includes('kaumar')||name.includes('paediatric')||name.includes('pediatric')||name.includes('child'))return 'kaumarabhritya_opd';
  if(name.includes('visha')||name.includes('agada')||name.includes('poison')||name.includes('toxicol'))return 'agadatantra_opd';
  if(name.includes('manovaha')||name.includes('manasa')||name.includes('psychiatry')||name.includes('mental'))return 'manovaha_opd';
  if(name.includes('clinic')||name.includes('specialty')||name.includes('special opd'))return 'specialty_clinic';
  if(name.includes('tele')||name.includes('online')||name.includes('virtual'))return 'teleconsultation_opd';
  if(name.includes('pharmacy')||name.includes('dispensary')||name.includes('drug store')||name.includes('aushadha'))return 'pharmacy_dispensary';
  if(name.includes('diagnostic')||name.includes('laboratory')||name.includes('lab')||name.includes('roganidana'))return 'diagnostic_zone';
  if(name.includes('ipd ward')||name.includes('general ward')||name.includes('male ward')||name.includes('female ward')||name.includes('inpatient ward'))return 'ipd_ward';
  if(name.includes('nursing zone')||name.includes('nursing station')||name.includes('nurses station'))return 'nursing_zone';
  if(name.includes('operation theatre')||name.includes('ot ')||name.includes('surgical suite')||name.includes('operating room'))return 'operation_theatre';
  if(name.includes('anushastra')||name.includes('ksharakarma')||name.includes('agnikarma')||name.includes('raktamokshana unit')||name.includes('pain management unit'))return 'anushastra_karma';
  if(name.includes('labour room')||name.includes('labor room')||name.includes('delivery room')||name.includes('birthing'))return 'labour_room';
  if(name.includes('atyayika icu')||name.includes('intensive care unit')||name.includes('icu ward')||name.includes('atyayika ward'))return 'atyayika_icu';
  if(name.includes('garbhasamskara')||name.includes('prenatal class')||name.includes('antenatal class')||name.includes('garbha'))return 'garbhasamskara';
  if(name.includes('nicu')||name.includes('neonatal intensive')||name.includes('newborn intensive'))return 'nicu';
  if(name.includes('kriyakalpa')||name.includes('netra kriya')||name.includes('karna kriya')||name.includes('shalakya therapy'))return 'kriyakalpa';
  if(name.includes('physio')||name.includes('rehabilitation')||name.includes('physiotherapy'))return 'physiotherapy';
  if(name.includes('yoga')||name.includes('pranayama')||name.includes('yoga section'))return 'yoga_section';
  if(name.includes('pharmacovigilance')||name.includes('pv cell')||name.includes('adr cell')||name.includes('drug safety'))return 'pharmacovigilance_cell';
  if(name.includes('administrative zone')||name.includes('admin zone')||name.includes('medical superintendent office')||name.includes('biometric'))return 'administrative_zone';
  if(name.includes('palha')||name.includes('diet centre')||name.includes('therapeutic diet')||name.includes('swarasa centre'))return 'palha_diet_centre';
  if(name.includes('services zone')||name.includes('canteen')||name.includes('mortuary')||name.includes('ambulance bay')||name.includes('housekeeping'))return 'services_zone';
  if(name.includes('cssd')||name.includes('central steril')||name.includes('sterilisation unit')||name.includes('sterilization unit'))return 'cssd';
  if(name.includes('maintenance cell')||name.includes('maintenance unit')||name.includes('engineering maintenance'))return 'maintenance_cell';
  if(name.includes('photography')||name.includes('videography')||name.includes('clinical media'))return 'photography_section';
  if(name.includes('human resources')||name.includes('hr compliance')||name.includes('medical director office'))return 'human_resources_admin';
  if(name.includes('library')||name.includes('academic resource'))return 'library';
  if(name.includes('hostel')||name.includes('dormitory')||name.includes('residential'))return 'hostel';
  if(name.includes('classroom')||name.includes('clinical class')||name.includes('seminar room')||name.includes('tutorial room'))return 'clinical_classroom';
  if(name.includes('hospital area')||name.includes('area summary')||name.includes('mesar')||name.includes('campus area'))return 'hospital_area_summary';
  return null;
}

// ════════════════════════════════════════════════
// SECTION 5 — MONTHLY REPORT
// ════════════════════════════════════════════════
window.initMonthlyReport = function() {
  const now = new Date();
  const ySel = document.getElementById('mr-year');
  if (!ySel.options.length) {
    for (let y = now.getFullYear(); y >= 2024; y--) {
      const o = document.createElement('option'); o.value = y; o.textContent = y; ySel.appendChild(o);
    }
  }
  // Default to previous month
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  document.getElementById('mr-month').value = prev.getMonth() + 1;
  ySel.value = prev.getFullYear();
};

let _mrData = null;

window.loadMonthlyReport = async function() {
  const m = parseInt(document.getElementById('mr-month').value);
  const y = parseInt(document.getElementById('mr-year').value);
  const start = new Date(y, m - 1, 1).toISOString();
  const end   = new Date(y, m, 0, 23, 59, 59).toISOString();
  const monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-IN', {month:'long', year:'numeric'});

  const body = document.getElementById('mr-body');
  body.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Generating report…</div></div>';
  document.getElementById('mr-csv-btn').style.display = 'none';

  const [visRes, ipdRes, bedRes, deptRes, billRes, pkRes, labRes, imgRes, tRow] = await Promise.all([
    supabase.from('visits').select('id,status,opd_id,created_at').eq('tenant_id',tenantId).gte('created_at',start).lte('created_at',end),
    supabase.from('ipd_admissions').select('id,department_id,status,admitted_at,discharged_at').eq('tenant_id',tenantId).gte('admitted_at',start).lte('admitted_at',end),
    supabase.from('beds').select('id,department_id,status').eq('tenant_id',tenantId),
    supabase.from('departments').select('id,name,ncism_code').eq('tenant_id',tenantId).eq('is_active',true).order('name'),
    supabase.from('bills').select('final_amount,amount_paid,status').eq('tenant_id',tenantId).gte('created_at',start).lte('created_at',end),
    supabase.from('pk_therapy_sessions').select('id,status,therapy_name').eq('tenant_id',tenantId).gte('created_at',start).lte('created_at',end).then(r=>r.error?{data:[]}:r),
    supabase.from('lab_orders').select('id,priority').eq('tenant_id',tenantId).gte('created_at',start).lte('created_at',end).then(r=>r.error?{data:[]}:r),
    supabase.from('imaging_orders').select('id,modality').eq('tenant_id',tenantId).gte('created_at',start).lte('created_at',end).then(r=>r.error?{data:[]}:r),
    supabase.from('tenants').select('ug_intake,opd_daily_target').eq('id',tenantId).single(),
  ]);

  const visits  = visRes.data  || [];
  const ipds    = ipdRes.data  || [];
  const beds    = bedRes.data  || [];
  const depts   = deptRes.data || [];
  const bills   = billRes.data || [];
  const pk      = pkRes.data   || [];
  const labs    = labRes.data  || [];
  const imgs    = imgRes.data  || [];
  const tenant  = tRow.data;
  const ugIntake = tenant?.ug_intake || 0;
  const dailyTgt = tenant?.opd_daily_target || (ugIntake * 2) || 0;

  // Working days in month
  const daysInMonth = new Date(y, m, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m-1, d).getDay();
    if (dow !== 0) workingDays++; // exclude Sundays
  }

  // OPD by department
  const opdByDept = {};
  depts.forEach(d => { opdByDept[d.id] = 0; });
  visits.forEach(v => { if (v.opd_id && opdByDept[v.opd_id] !== undefined) opdByDept[v.opd_id]++; });

  // IPD by department
  const ipdByDept = {};
  depts.forEach(d => { ipdByDept[d.id] = {admissions:0, discharges:0, totalLos:0}; });
  ipds.forEach(a => {
    if (a.department_id && ipdByDept[a.department_id]) {
      ipdByDept[a.department_id].admissions++;
      if (a.discharged_at) {
        ipdByDept[a.department_id].discharges++;
        const los = (new Date(a.discharged_at) - new Date(a.admitted_at)) / 86400000;
        ipdByDept[a.department_id].totalLos += los;
      }
    }
  });

  // Bed occupancy
  const totalBeds = beds.length;
  const occupiedBeds = beds.filter(b => b.status === 'occupied').length;
  const occPct = totalBeds > 0 ? Math.round(occupiedBeds / totalBeds * 100) : 0;

  // Finance
  const totalBilled = bills.reduce((s,b) => s + (Number(b.final_amount)||0), 0);
  const totalCollected = bills.reduce((s,b) => s + (Number(b.amount_paid)||0), 0);

  // Summary
  const totalOPD = visits.length;
  const avgOPD = workingDays > 0 ? (totalOPD / workingDays).toFixed(1) : 0;
  const pkCompleted = pk.filter(s => s.status === 'completed').length;
  const labUrgent = labs.filter(l => l.priority === 'urgent').length;
  const imgTotal = imgs.length;

  _mrData = { monthLabel, y, m, totalOPD, avgOPD, dailyTgt, workingDays, totalBeds, occPct,
    ipds, depts, opdByDept, ipdByDept, bills, pkCompleted, labs, imgs, labUrgent, imgTotal,
    totalBilled, totalCollected };

  const oppctCls = totalOPD/(dailyTgt*workingDays||1)*100 >= 80 ? '#2d7a4f' : totalOPD/(dailyTgt*workingDays||1)*100 >= 50 ? '#c9902a' : '#c0392b';
  const occ30Cls = occPct >= 60 ? '#2d7a4f' : occPct >= 30 ? '#c9902a' : '#c0392b';

  body.innerHTML = `
  <div style="background:var(--green-deep);color:#fff;border-radius:var(--radius);padding:16px 22px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px">
    <div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600">NCISM Monthly Report — ${monthLabel}</div>
      <div style="font-size:12px;opacity:.7;margin-top:2px">${workingDays} working days · ${daysInMonth}-day month · Tenant: ${_esc(tenant?.name||tenantId)}</div>
    </div>
    <div style="font-size:11px;opacity:.6">Generated ${new Date().toLocaleString('en-IN')}</div>
  </div>

  <!-- Summary cards -->
  <div class="stats6" style="margin-bottom:20px">
    <div class="sc"><div class="sc-ico g">🏥</div><div class="sc-num" style="color:${oppctCls}">${totalOPD}</div><div class="sc-lbl">OPD Visits</div><div class="sc-sub">Avg ${avgOPD}/day (target ${dailyTgt})</div></div>
    <div class="sc"><div class="sc-ico b">🛏️</div><div class="sc-num">${ipds.length}</div><div class="sc-lbl">IPD Admissions</div><div class="sc-sub">this month</div></div>
    <div class="sc"><div class="sc-ico p">📊</div><div class="sc-num" style="color:${occ30Cls}">${occPct}%</div><div class="sc-lbl">Bed Occupancy</div><div class="sc-sub">${occupiedBeds}/${totalBeds} beds (current)</div></div>
    <div class="sc"><div class="sc-ico gold">🌿</div><div class="sc-num">${pkCompleted}</div><div class="sc-lbl">PK Sessions Done</div><div class="sc-sub">therapy completed</div></div>
    <div class="sc"><div class="sc-ico b">🧪</div><div class="sc-num">${labs.length}</div><div class="sc-lbl">Lab Tests</div><div class="sc-sub">${labUrgent} urgent</div></div>
    <div class="sc"><div class="sc-ico g">₹</div><div class="sc-num">${_fmt(totalCollected)}</div><div class="sc-lbl">Revenue Collected</div><div class="sc-sub">Billed: ${_fmt(totalBilled)}</div></div>
  </div>

  <!-- OPD by Dept -->
  <div class="cc" style="margin-bottom:16px">
    <div class="cc-hd"><span class="cc-title">OPD Attendance by Department — ${monthLabel}</span>
      ${dailyTgt > 0 ? `<span style="font-size:12px;color:var(--text-muted)">NCISM daily target: ${dailyTgt} | Monthly target: ${dailyTgt * workingDays}</span>` : ''}
    </div>
    <div class="tw"><table>
      <thead><tr><th>Department</th><th>NCISM Code</th><th>Total Visits</th><th>Avg/Day</th><th>% Attendance</th></tr></thead>
      <tbody>
        ${depts.map(d => {
          const cnt = opdByDept[d.id] || 0;
          const avg = workingDays > 0 ? (cnt/workingDays).toFixed(1) : '—';
          const pct = dailyTgt > 0 ? Math.round(cnt/(dailyTgt*workingDays)*100) : null;
          const cls = pct === null ? '' : pct >= 80 ? 'color:#2d7a4f;font-weight:600' : pct >= 50 ? 'color:#c9902a;font-weight:600' : 'color:#c0392b;font-weight:600';
          return `<tr>
            <td><strong>${_esc(d.name)}</strong></td>
            <td><span class="chip grey">${_esc(d.ncism_code||'—')}</span></td>
            <td>${cnt}</td>
            <td>${avg}</td>
            <td style="${cls}">${pct !== null ? pct + '%' : '—'}</td>
          </tr>`;
        }).join('')}
        <tr style="background:#fafff8;font-weight:700">
          <td colspan="2">TOTAL</td>
          <td>${totalOPD}</td>
          <td>${avgOPD}</td>
          <td style="color:${oppctCls}">${dailyTgt > 0 ? Math.round(totalOPD/(dailyTgt*workingDays)*100) + '%' : '—'}</td>
        </tr>
      </tbody>
    </table></div>
  </div>

  <!-- IPD by Dept -->
  <div class="cc" style="margin-bottom:16px">
    <div class="cc-hd"><span class="cc-title">IPD Activity by Department — ${monthLabel}</span></div>
    <div class="tw"><table>
      <thead><tr><th>Department</th><th>Admissions</th><th>Discharges</th><th>Avg LOS (days)</th><th>Current Beds</th><th>Occupancy</th></tr></thead>
      <tbody>
        ${depts.filter(d => (ipdByDept[d.id]?.admissions || 0) > 0 || beds.some(b => b.department_id === d.id)).map(d => {
          const s = ipdByDept[d.id] || {admissions:0, discharges:0, totalLos:0};
          const avgLos = s.discharges > 0 ? (s.totalLos/s.discharges).toFixed(1) : '—';
          const dBeds = beds.filter(b => b.department_id === d.id);
          const dOcc = dBeds.filter(b => b.status === 'occupied').length;
          const dOccPct = dBeds.length > 0 ? Math.round(dOcc/dBeds.length*100) : 0;
          const occCls = dOccPct >= 60 ? 'color:#2d7a4f' : dOccPct >= 30 ? 'color:#c9902a' : 'color:#c0392b';
          return `<tr>
            <td><strong>${_esc(d.name)}</strong></td>
            <td>${s.admissions}</td>
            <td>${s.discharges}</td>
            <td>${avgLos}</td>
            <td>${dBeds.length}</td>
            <td style="${occCls}">${dOccPct}% (${dOcc}/${dBeds.length})</td>
          </tr>`;
        }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:20px">No IPD activity this month</td></tr>'}
        <tr style="background:#fafff8;font-weight:700">
          <td>TOTAL</td>
          <td>${ipds.length}</td>
          <td>${ipds.filter(a=>a.discharged_at).length}</td>
          <td>—</td>
          <td>${totalBeds}</td>
          <td style="color:${occ30Cls}">${occPct}%</td>
        </tr>
      </tbody>
    </table></div>
  </div>

  <!-- Clinical Procedures -->
  <div class="cc" style="margin-bottom:16px">
    <div class="cc-hd"><span class="cc-title">Clinical Procedures &amp; Diagnostics — ${monthLabel}</span></div>
    <div class="cc-pad">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
        <div style="background:#f5faf7;border-radius:8px;padding:12px 16px">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">PK Therapy Sessions</div>
          <div style="font-size:24px;font-weight:700;color:var(--green-deep);margin:4px 0">${pk.length}</div>
          <div style="font-size:11px;color:var(--text-mid)">${pkCompleted} completed · ${pk.filter(s=>s.status==='scheduled').length} scheduled</div>
        </div>
        <div style="background:#f0f4ff;border-radius:8px;padding:12px 16px">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">Laboratory Tests</div>
          <div style="font-size:24px;font-weight:700;color:var(--blue);margin:4px 0">${labs.length}</div>
          <div style="font-size:11px;color:var(--text-mid)">${labUrgent} urgent · ${labs.filter(l=>l.priority==='routine').length} routine</div>
        </div>
        <div style="background:#fdf6e3;border-radius:8px;padding:12px 16px">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">Imaging Orders</div>
          <div style="font-size:24px;font-weight:700;color:var(--gold);margin:4px 0">${imgs.length}</div>
          <div style="font-size:11px;color:var(--text-mid)">${imgs.filter(i=>i.modality==='X-ray').length} X-ray · ${imgs.filter(i=>i.modality==='USG').length} USG · ${imgs.filter(i=>i.modality==='ECG').length} ECG</div>
        </div>
        <div style="background:#fdf3f3;border-radius:8px;padding:12px 16px">
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px">Revenue</div>
          <div style="font-size:24px;font-weight:700;color:var(--red);margin:4px 0">${_fmt(totalCollected)}</div>
          <div style="font-size:11px;color:var(--text-mid)">Billed: ${_fmt(totalBilled)} · ${bills.length} invoices</div>
        </div>
      </div>
    </div>
  </div>
  `;

  document.getElementById('mr-csv-btn').style.display = '';
};

window.exportMonthlyCSV = function() {
  if (!_mrData) return;
  const { monthLabel, totalOPD, avgOPD, dailyTgt, workingDays, ipds, depts, opdByDept, ipdByDept,
    occPct, pkCompleted, labs, imgs, labUrgent, totalBilled, totalCollected } = _mrData;

  const rows = [
    ['NCISM Monthly Report — ' + monthLabel],
    ['Generated:', new Date().toLocaleString('en-IN')],
    [''],
    ['SUMMARY'],
    ['Total OPD Visits', totalOPD],
    ['Average OPD/Day', avgOPD],
    ['NCISM Daily Target', dailyTgt],
    ['Working Days', workingDays],
    ['IPD Admissions', ipds.length],
    ['Bed Occupancy %', occPct + '%'],
    ['PK Therapy Sessions Completed', pkCompleted],
    ['Lab Tests', labs.length],
    ['Imaging Orders', imgs.length],
    ['Revenue Collected', totalCollected],
    ['Revenue Billed', totalBilled],
    [''],
    ['OPD BY DEPARTMENT'],
    ['Department','NCISM Code','Total Visits','Avg/Day'],
    ...depts.map(d => [d.name, d.ncism_code||'—', opdByDept[d.id]||0,
      workingDays > 0 ? ((opdByDept[d.id]||0)/workingDays).toFixed(1) : '—']),
    [''],
    ['IPD BY DEPARTMENT'],
    ['Department','Admissions','Discharges','Avg LOS'],
    ...depts.filter(d => (ipdByDept[d.id]?.admissions||0) > 0).map(d => {
      const s = ipdByDept[d.id]||{};
      return [d.name, s.admissions||0, s.discharges||0,
        s.discharges > 0 ? (s.totalLos/s.discharges).toFixed(1) : '—'];
    }),
  ];

  const csv = rows.map(r => Array.isArray(r) ? r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',') : `"${r}"`).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = `NCISM_Monthly_${monthLabel.replace(' ','_')}.csv`;
  a.click();
};

// (non-admin dashboard removed — non-admin roles are redirected on load)

async function _bootDashboard_REMOVED(){
  // placeholder to avoid reference errors during transition — safe to delete
  const h=new Date().getHours();
  document.getElementById('time-of-day').textContent=h<12?'morning':h<17?'afternoon':'evening';
  document.getElementById('user-name').textContent=(profile.full_name||'there').split(' ')[0];
  document.getElementById('today-date').textContent=new Date().toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  document.getElementById('role-label').textContent=_roleLabel(role);
  if(role==='doctor') await _docDash();
  else if(['receptionist','nurse'].includes(role)) await _rxDash();
  else if(role==='pharmacist') await _pharmDash();
  else if(role==='accountant') await _accDash();
  else if(role==='lab_tech') await _labDash();
  else _defDash();
}

async function _docDash(){
  _bannerBtn('Open Queue','doctor.html');
  const[w,c,t]=await Promise.all([_count('visits',[['tenant_id',tenantId],['status','waiting']],true),_count('visits',[['tenant_id',tenantId],['status','completed']],true),_count('visits',[['tenant_id',tenantId]])]);
  _rStats([{icon:'⏳',iconClass:'red',number:w,label:'Waiting Now',sub:'in queue'},{icon:'✅',iconClass:'green',number:c,label:'Seen Today',sub:'done'},{icon:'📋',iconClass:'blue',number:t,label:'Total Visits',sub:'all time'},{icon:'📝',iconClass:'gold',number:'—',label:'Prescriptions',sub:'coming soon'}]);
  _rActions([{icon:'🩺',label:'Patient Queue',desc:'Start consultation',href:'doctor.html'},{icon:'📊',label:'Reports',desc:'Analytics',href:'reports.html'},{icon:'💊',label:'Inventory',desc:'Medicines',href:'inventory.html'},{icon:'🛏️',label:'IPD',desc:'In-patient',href:'ipd.html'}]);
  _rCard('🩺','Your patient queue is ready','Patients registered at reception will appear in your queue.','Open Queue','doctor.html');
}
async function _rxDash(){
  _bannerBtn('Register Patient','reception.html');
  const[r,w,p,c]=await Promise.all([_countToday('visits'),_count('visits',[['tenant_id',tenantId],['status','waiting']]),_count('bills',[['tenant_id',tenantId],['status','pending']]),_sumToday('bills','final_amount')]);
  _rStats([{icon:'🏥',iconClass:'green',number:r,label:'Registered Today',sub:'checked in'},{icon:'⏳',iconClass:'red',number:w,label:'Waiting Now',sub:'in queue'},{icon:'📄',iconClass:'gold',number:p,label:'Pending Bills',sub:'awaiting payment'},{icon:'₹',iconClass:'blue',number:_fmt(c),label:'Collected Today',sub:'total'}]);
  _rActions([{icon:'➕',label:'New Patient',desc:'Register & queue',href:'reception.html'},{icon:'👁',label:'View Queue',desc:'Waiting patients',href:'doctor.html'},{icon:'📄',label:'Billing',desc:'Bills & payments',href:'reception.html'},{icon:'📊',label:'Today\'s Log',desc:'All visits',href:'reports.html'}]);
  _rCard('🏥','Reception is ready','Register new patients, manage the OPD queue, and collect payments.','Register a Patient','reception.html');
}
async function _pharmDash(){
  _bannerBtn('Open POS','dispensaryPOS.html');
  const[l,s]=await Promise.all([_count('inventory',[['tenant_id',tenantId]],false,['stock_quantity','lte',10]),_sumToday('bills','final_amount')]);
  _rStats([{icon:'⚠️',iconClass:'red',number:l,label:'Low Stock',sub:'qty ≤ 10'},{icon:'₹',iconClass:'gold',number:_fmt(s),label:'Sales Today',sub:'revenue'},{icon:'💊',iconClass:'green',number:'—',label:'Dispensed',sub:'coming soon'},{icon:'🚚',iconClass:'blue',number:'—',label:'Purchases',sub:'today'}]);
  _rActions([{icon:'🛒',label:'POS',desc:'Dispense & bill',href:'dispensaryPOS.html'},{icon:'🚚',label:'Purchase',desc:'Receive stock',href:'purchase.html'},{icon:'📦',label:'Inventory',desc:'Stock levels',href:'inventory.html'},{icon:'📊',label:'Reports',desc:'Sales analytics',href:'reports.html'}]);
  _rCard('💊','Pharmacy is open','Dispense medicines, manage inventory, record purchases.','Open POS','dispensaryPOS.html');
}
async function _accDash(){
  _bannerBtn('View Reports','reports.html');
  const[r,p]=await Promise.all([_sumToday('bills','final_amount'),_count('bills',[['tenant_id',tenantId],['status','pending']])]);
  _rStats([{icon:'₹',iconClass:'gold',number:_fmt(r),label:'Revenue Today',sub:'collected'},{icon:'📄',iconClass:'red',number:p,label:'Pending Bills',sub:'awaiting'},{icon:'🚚',iconClass:'blue',number:'—',label:'Purchases',sub:'today'},{icon:'📊',iconClass:'green',number:'—',label:'Net Today',sub:'coming soon'}]);
  _rActions([{icon:'📊',label:'Reports',desc:'Full analytics',href:'reports.html'},{icon:'🚚',label:'Purchases',desc:'Ledger',href:'purchase.html'},{icon:'📄',label:'Billing',desc:'Invoices',href:'reception.html'},{icon:'💰',label:'Fee Admin',desc:'Fee structures',href:'fee-admin.html'}]);
  _rCard('📊','Accounts overview','Track daily revenue, manage purchase records, and generate financial reports.','Open Reports','reports.html');
}
async function _labDash(){
  _bannerBtn('View Reports','reports.html');
  _rStats([{icon:'🧪',iconClass:'blue',number:'—',label:'Tests Today',sub:'coming soon'},{icon:'✅',iconClass:'green',number:'—',label:'Completed',sub:''},{icon:'⏳',iconClass:'red',number:'—',label:'Pending',sub:''},{icon:'📊',iconClass:'gold',number:'—',label:'This Month',sub:''}]);
  _rActions([{icon:'📊',label:'Reports',desc:'Lab analytics',href:'reports.html'}]);
  _rCard('🧪','Lab module coming soon','Full lab management is under development.','Open Reports','reports.html');
}
function _defDash(){
  _rStats([{icon:'📚',iconClass:'blue',number:'—',label:'Modules',sub:''},{icon:'📝',iconClass:'green',number:'—',label:'Courses',sub:''},{icon:'✅',iconClass:'gold',number:'—',label:'Completed',sub:''},{icon:'🏆',iconClass:'red',number:'—',label:'Progress',sub:''}]);
  _rActions([{icon:'📚',label:'Study',desc:'Materials',href:'#'},{icon:'📝',label:'Practice',desc:'Case studies',href:'#'}]);
  _rCard('🌿','Welcome to AyurXpert','Your portal is being set up. Contact your administrator for access.',null,null);
}

function _bannerBtn(label,href){document.getElementById('banner-action').innerHTML=`<a href="${href}" class="btn-primary-action">${label} &rarr;</a>`;}
function _rStats(cards){document.getElementById('stats-grid').innerHTML=cards.map(c=>`<div class="stat-card"><div class="stat-header"><div class="stat-icon ${c.iconClass}">${c.icon}</div></div><div class="stat-number">${c.number??'—'}</div><div class="stat-label">${c.label}</div>${c.sub?`<div class="stat-sub">${c.sub}</div>`:''}</div>`).join('');}
function _rActions(a){document.getElementById('actions-grid').innerHTML=a.map(x=>`<a href="${x.href}" class="action-card"><div class="action-icon">${x.icon}</div><div class="action-label">${x.label}</div><div class="action-desc">${x.desc}</div></a>`).join('');}
function _rCard(icon,title,body,btnLabel,btnHref){document.getElementById('main-section').innerHTML=`<div class="content-card"><div class="empty" style="padding:48px 24px"><div class="empty-ico">${icon}</div><div class="empty-ttl" style="font-size:17px">${title}</div><div class="empty-bod" style="max-width:360px;margin:8px auto 0">${body}</div>${btnLabel?`<a href="${btnHref}" class="btn-approve" style="display:inline-block;margin-top:20px;text-decoration:none">${btnLabel}</a>`:''}</div></div>`;}

// ════════════════════════════════════════════════
// SHARED HELPERS
// ════════════════════════════════════════════════
async function _count(table,filters=[],dateFilter=false,extra=null){
  try{
    let q=supabase.from(table).select('*',{count:'exact',head:true});
    filters.forEach(([c,v])=>{q=q.eq(c,v);});
    if(dateFilter)q=q.gte('created_at',todayStart).lte('created_at',todayEnd);
    if(extra){const[c,op,v]=extra;if(op==='lte')q=q.lte(c,v);}
    const{count}=await q; return count??0;
  }catch{return 0;}
}
async function _countToday(table){return _count(table,[['tenant_id',tenantId]],true);}
async function _sumToday(table,col){
  try{
    const{data}=await supabase.from(table).select(col).eq('tenant_id',tenantId).gte('created_at',todayStart).lte('created_at',todayEnd);
    return(data||[]).reduce((s,r)=>s+(Number(r[col])||0),0);
  }catch{return 0;}
}
function _fmt(n){if(!n)return'₹0';if(n>=100000)return'₹'+(n/100000).toFixed(1)+'L';if(n>=1000)return'₹'+(n/1000).toFixed(1)+'K';return'₹'+Math.round(n);}
function _roleLabel(r){return{super_admin:'Super Admin',dept_admin:'Dept. Admin',doctor:'Doctor',receptionist:'Receptionist',pharmacist:'Pharmacist',nurse:'Nurse',lab_tech:'Lab Technician',accountant:'Accountant',therapist:'Therapist',student:'Student',diet_staff:'Diet / Pathya Staff',mrd_staff:'Medical Records Staff'}[r]||r;}
function _tenantLabel(t){return{clinic:'Clinic',hospital:'Hospital',teaching_hospital:'Teaching Hospital',pk_center:'PK Centre',dispensary:'Dispensary',college:'Ayurveda College',pharma:'Pharmaceutical Co.',supplier:'Supplier',dealer:'Dealer',journal:'Journal'}[t]||'Healthcare';}
function _relDate(iso){if(!iso)return'—';const d=Math.floor((Date.now()-new Date(iso))/60000);if(d<60)return d+'m ago';if(d<1440)return Math.floor(d/60)+'h ago';return Math.floor(d/1440)+'d ago';}
function _esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function _toast(msg,isError=false){const el=document.getElementById('toast');el.textContent=msg;el.style.background=isError?'#7f1d1d':'#1c2b1f';el.classList.add('show');setTimeout(()=>el.classList.remove('show'),3000);}

// ── NCISM Setup Compliance Checker ───────────────────────────────────────────
async function _renderNcismChecklist(ugIntake, orgType) {
  const el = document.getElementById('ncism-setup-checklist');
  if (!el) return;

  const isNcismType = ['teaching_hospital','college'].includes(orgType);

  // If ug_intake not set, show a setup prompt and use defaults
  const intakeWarning = (!ugIntake && isNcismType)
    ? `<div style="background:#fff8e1;border:1.5px solid #e0a800;border-radius:8px;padding:10px 16px;margin-bottom:12px;font-size:13px;color:#7a5c00">
        <strong>⚠ UG Intake not configured.</strong> Run this SQL in Supabase to set it:<br>
        <code style="font-size:11px;background:#fff3cd;padding:2px 6px;border-radius:3px">
          UPDATE tenants SET ug_intake = 60, opd_daily_target = 120 WHERE id = '${tenantId}';
        </code>
       </div>` : '';

  const intake      = ugIntake || 60; // fallback to 60 for display
  const minBeds     = intake;
  // Snap to the nearest defined tier — SCHEDULE_IV/NCISM_XX_ROWS are only keyed 60/100/150/200,
  // same normalization the NCISM Staffing Compliance panel uses (_renderNcismStaffing).
  const ugTier      = [60,100,150,200].includes(intake) ? intake : (intake>=150?150:intake>=100?100:60);
  const roleMin     = _ncismRoleMinimums(ugTier);
  const minDoctors  = roleMin.doctor      || 0;
  const minNurses   = roleMin.nurse       || 0;
  const minPharm    = roleMin.pharmacist  || 0;
  const minRecp     = roleMin.receptionist|| 0;
  const minLabTech  = roleMin.lab_tech    || 0;
  const minTherapist= roleMin.therapist   || 0;

  const [
    opdRes, deptRes, bedRes, staffRes,
    opdDoctorRes, feeRes, rosterRes
  ] = await Promise.all([
    supabase.from('opds').select('id,name,ncism_code,is_active').eq('tenant_id',tenantId),
    supabase.from('departments').select('id,name,is_active').eq('tenant_id',tenantId),
    supabase.from('beds').select('id').eq('tenant_id',tenantId),
    supabase.from('profiles').select('role').eq('tenant_id',tenantId).eq('is_active',true).neq('role','super_admin'),
    supabase.from('opd_doctors').select('opd_id,doctor_id').eq('tenant_id',tenantId),
    supabase.from('fee_structures').select('id').eq('tenant_id',tenantId).eq('approval_status','active').limit(1),
    supabase.from('duty_roster').select('id').eq('tenant_id',tenantId).limit(1).then(r => r.error ? {data:[]} : r),
  ]);

  const opds       = opdRes.data    || [];
  const depts      = deptRes.data   || [];
  const beds       = bedRes.data    || [];
  const staff      = staffRes.data  || [];
  const opdDoctors = opdDoctorRes.data || [];
  const fees       = feeRes.data    || [];
  const roster     = rosterRes.data || [];

  const activeOpds  = opds.filter(o => o.is_active).length;
  const totalOpds   = opds.length;
  const activeDepts = depts.filter(d => d.is_active).length;
  const totalBeds   = beds.length;

  const byRole = r => staff.filter(s => s.role === r).length;
  const doctors    = byRole('doctor');
  const nurses     = byRole('nurse');
  const pharmacists= byRole('pharmacist');
  const receptions = byRole('receptionist');
  const labTechs   = byRole('lab_tech');
  const therapists = byRole('therapist');

  // OPDs with at least 1 doctor assigned
  const opdsWithDoctors = new Set(opdDoctors.map(od => od.opd_id)).size;
  const opdsNeedingDoctors = totalOpds - opdsWithDoctors;

  // Build checklist items
  function item(icon, label, detail, pass, warn, actionLabel, actionHref) {
    const cls = pass ? 'cl-status-pass' : warn ? 'cl-status-warn' : 'cl-status-fail';
    const ico = pass ? '✅' : warn ? '⚠️' : '❌';
    return { icon:ico, label, detail, cls, pass, warn, actionLabel, actionHref };
  }

  const groups = [
    {
      title: `Infrastructure — UG Intake ${intake} | OPD Target ${intake*2}/day`,
      items: [
        item('🏥','10 Mandatory OPDs configured',
          `${totalOpds} created, ${activeOpds} active`,
          totalOpds >= 10, totalOpds >= 8,
          totalOpds < 10 ? 'Seed OPDs' : 'Manage', 'opd-admin.html'),
        item('🏛','All hospital departments configured',
          `${activeDepts} active departments — full org-tree (HR)`,
          activeDepts >= 10, activeDepts >= 7,
          'Manage', 'admin.html#hr:dept'),
        item('🛏','Minimum beds = UG intake',
          `${totalBeds} beds configured (minimum: ${minBeds}) — 7 clinical/IPD-bedded departments`,
          totalBeds >= minBeds, totalBeds >= Math.floor(minBeds * 0.8),
          totalBeds < minBeds ? 'Add Beds' : 'View',
          totalBeds < minBeds ? 'bed-admin.html?tab=quick' : 'bed-admin.html?tab=beds'),
        item('💊','Fee structures configured',
          fees.length ? 'At least one active fee structure found' : 'No active fee structures — patients cannot be billed',
          fees.length > 0, false,
          'Configure Fees', 'fee-admin.html'),
        item('🗓','Duty roster configured',
          roster.length ? 'Roster entries found' : 'No duty roster — 24×7 compliance gap',
          roster.length > 0, false,
          'Set Up Roster', 'roster.html'),
      ]
    },
    {
      title: 'Clinical Setup — OPD Doctor Assignments',
      items: [
        item('👨‍⚕️','Doctors assigned to all OPDs',
          opdsNeedingDoctors === 0
            ? `All ${totalOpds} OPDs have doctors assigned`
            : `${opdsNeedingDoctors} OPD(s) have no doctor assigned — patients cannot be routed`,
          opdsNeedingDoctors === 0, opdsNeedingDoctors <= 2,
          'Assign Doctors', 'opd-admin.html'),
      ]
    },
    {
      title: `Staffing — NCISM Minimum Requirements (${intake} intake)`,
      items: [
        item('👨‍⚕️',`Doctors — minimum ${minDoctors} (Schedule I faculty + Schedule XX combined)`,
          `${doctors} onboarded`,
          doctors >= minDoctors, doctors >= Math.ceil(minDoctors * 0.7),
          doctors < minDoctors ? `Add ${minDoctors - doctors} more` : 'View', 'signup.html'),
        item('👩‍⚕️',`Nurses — minimum ${minNurses} (Schedule XX combined)`,
          `${nurses} onboarded`,
          nurses >= minNurses, nurses >= Math.ceil(minNurses * 0.6),
          nurses < minNurses ? `Add ${minNurses - nurses} more` : 'View', 'signup.html'),
        item('💊',`Pharmacists — minimum ${minPharm}`,
          `${pharmacists} onboarded`,
          pharmacists >= minPharm, pharmacists >= 1,
          pharmacists < minPharm ? 'Add Pharmacist' : 'View', 'signup.html'),
        item('🏥',`Receptionists — minimum ${minRecp}`,
          `${receptions} onboarded`,
          receptions >= minRecp, false,
          receptions < minRecp ? 'Add Receptionist' : 'View', 'signup.html'),
        item('🔬',`Lab Technicians — minimum ${minLabTech}`,
          `${labTechs} onboarded`,
          labTechs >= minLabTech, labTechs >= 1,
          labTechs < minLabTech ? 'Add Lab Tech' : 'View', 'signup.html'),
        item('🌸',`Therapists — minimum ${minTherapist} (PK + Kriyakalpa + Physiotherapy + Yoga)`,
          `${therapists} onboarded`,
          therapists >= minTherapist, therapists >= Math.ceil(minTherapist * 0.6),
          therapists < minTherapist ? `Add ${minTherapist - therapists} more` : 'View', 'signup.html'),
      ]
    }
  ];

  const allItems  = groups.flatMap(g => g.items);
  const passCount = allItems.filter(i => i.pass).length;
  const total     = allItems.length;
  const pct       = Math.round((passCount / total) * 100);
  const scoreColour = pct >= 80 ? '#2d7a4f' : pct >= 50 ? '#c9902a' : '#c0392b';

  const groupsHTML = groups.map(g => `
    <div class="ncism-cl-group">
      <div class="ncism-cl-group-title">${g.title}</div>
      ${g.items.map(i => {
        const tag = i.actionHref ? `a href="${i.actionHref}"` : 'div';
        const end = i.actionHref ? 'a' : 'div';
        const badge = i.pass ? 'Manage' : i.actionLabel;
        return `
        <${tag} class="ncism-cl-item${i.actionHref ? ' cl-linked' : ''}">
          <span class="cl-icon">${i.icon}</span>
          <span class="cl-text">
            <span class="cl-label ${i.cls}">${i.label}</span>
            <span class="cl-detail">${i.detail}</span>
          </span>
          ${i.actionHref ? `<span class="cl-action">${badge} →</span>` : ''}
        </${end}>`;
      }).join('')}
    </div>`).join('');

  el.innerHTML = `${intakeWarning}
    <div class="ncism-checklist">
      <div class="ncism-cl-hdr">
        <div>
          <div class="ncism-cl-title">NCISM Setup Compliance — ${passCount}/${total} complete</div>
          <div style="font-size:11px;opacity:.7;margin-top:2px">UG Intake: ${ugIntake||'not set (showing 60 defaults)'} · OPD Target: ${intake*2}/day · Min Beds: ${minBeds}</div>
        </div>
        <div class="ncism-cl-score" style="background:${scoreColour}20;color:${scoreColour};border:1px solid ${scoreColour}40;font-weight:700">${pct}% Ready</div>
      </div>
      <div class="ncism-cl-body">${groupsHTML}</div>
    </div>`;
}

// ════════════════════════════════════════════════
// SECTION 6 — SUBSCRIPTION
// ════════════════════════════════════════════════
const PLAN_META = {
  trial:      { label:'Free Trial',  color:'#8a9e90', bg:'#f5f5f5'   },
  starter:    { label:'Starter',     color:'#2d7a4f', bg:'#e8f5ee'   },
  growth:     { label:'Growth',      color:'#2563eb', bg:'#dbeafe'   },
  enterprise: { label:'Enterprise',  color:'#c9902a', bg:'#fdf3e2'   },
};

const STATUS_META = {
  trial:     { label:'Trial Active',   color:'#2d7a4f' },
  active:    { label:'Active',         color:'#2d7a4f' },
  expiring:  { label:'Expiring Soon',  color:'#c9902a' },
  expired:   { label:'Expired',        color:'#dc2626' },
  suspended: { label:'Suspended',      color:'#dc2626' },
  grace:     { label:'Grace Period',   color:'#c9902a' },
};

window.loadSubscription = async function() {
  const body = document.getElementById('sub-body');
  body.innerHTML = '<div class="empty"><div class="empty-ico">⏳</div><div class="empty-ttl">Loading…</div></div>';

  const t = getCurrentTenant();
  if (!t) return;

  const planType   = t.plan_type          || 'trial';
  const status     = t.subscription_status || 'trial';
  const maxUsers   = t.max_users          || 5;
  const expiry     = t.subscription_expiry ? new Date(t.subscription_expiry) : null;
  const trialEnds  = t.trial_ends_at      ? new Date(t.trial_ends_at)        : null;
  const billingCycle = t.billing_cycle    || null;

  // User count + billing (billing only meaningful for a paid, non-trial plan)
  const [{ count: userCount }, { data: priceRow }, { data: gstRow }] = await Promise.all([
    supabase.from('profiles').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('is_active', true),
    (planType !== 'trial' && billingCycle)
      ? supabase.from('subscription_plan_pricing').select('fee').eq('plan_type', planType).eq('billing_cycle', billingCycle).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('platform_gst_config').select('gst_rate').eq('id', 1).single(),
  ]);
  const gstRate = Number(gstRow?.gst_rate ?? 0);
  const planFee = Number(priceRow?.fee ?? 0);
  const planFeeTotal = Math.round(planFee * (1 + gstRate / 100));

  const used     = userCount || 0;
  const pctUsed  = maxUsers > 0 ? Math.min(100, Math.round(used / maxUsers * 100)) : 0;
  const plan     = PLAN_META[planType]  || PLAN_META.trial;
  const stat     = STATUS_META[status]  || STATUS_META.trial;

  const today    = new Date();
  const endDate  = expiry || trialEnds;
  const daysLeft = endDate ? Math.ceil((endDate - today) / 86400000) : null;

  const usageColor = pctUsed >= 90 ? '#dc2626' : pctUsed >= 70 ? '#c9902a' : '#2d7a4f';

  body.innerHTML = `
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">

    <!-- Plan card -->
    <div class="cc" style="margin-bottom:0">
      <div class="cc-hd"><span class="cc-title">Current Plan</span></div>
      <div style="padding:20px 22px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <div style="background:${plan.bg};color:${plan.color};font-weight:700;font-size:20px;padding:6px 18px;border-radius:10px;letter-spacing:.3px">${plan.label}</div>
          <div style="background:${stat.color}18;color:${stat.color};font-size:12px;font-weight:600;padding:3px 12px;border-radius:20px;border:1px solid ${stat.color}40">${stat.label}</div>
        </div>
        ${endDate ? `<div style="font-size:13px;color:var(--text-mid);margin-bottom:6px">
          ${status === 'trial' ? 'Trial ends' : 'Subscription expires'}:
          <strong>${endDate.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</strong>
          ${daysLeft !== null ? `<span style="color:${daysLeft <= 7 ? '#dc2626' : daysLeft <= 30 ? '#c9902a' : 'var(--text-muted)'}"> · ${daysLeft > 0 ? daysLeft + ' days left' : 'Expired'}</span>` : ''}
        </div>` : '<div style="font-size:13px;color:var(--text-muted)">No expiry date set</div>'}
        ${planType !== 'trial' && billingCycle ? `<div style="font-size:13px;color:var(--text-mid);margin-bottom:6px">
          Billing: <strong>${billingCycle === 'annual' ? 'Annual' : 'Monthly'}</strong> —
          ₹${planFee.toLocaleString('en-IN')}${gstRate > 0 ? ` + ${gstRate}% GST = ₹${planFeeTotal.toLocaleString('en-IN')}` : ''}
        </div>` : ''}
        <div style="margin-top:14px;font-size:12px;color:var(--text-muted)">
          To upgrade or renew, contact
          <a href="mailto:support@ayurxpert.com" style="color:var(--green-mid)">support@ayurxpert.com</a>
        </div>
      </div>
    </div>

    <!-- Usage card -->
    <div class="cc" style="margin-bottom:0">
      <div class="cc-hd"><span class="cc-title">Staff Usage</span></div>
      <div style="padding:20px 22px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:36px;font-weight:600;color:${usageColor};line-height:1">${used} <span style="font-size:18px;color:var(--text-muted)">/ ${maxUsers === 999 ? '∞' : maxUsers}</span></div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px;margin-bottom:14px">Active staff members</div>
        ${maxUsers < 999 ? `
        <div style="background:#e8f5ee;border-radius:6px;height:10px;overflow:hidden">
          <div style="background:${usageColor};height:100%;width:${pctUsed}%;border-radius:6px;transition:width .4s"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:5px">${pctUsed}% of limit used${pctUsed >= 90 ? ' — <strong style="color:#dc2626">Near limit</strong>' : ''}</div>` : '<div style="font-size:12px;color:var(--text-muted)">Unlimited staff on Enterprise plan</div>'}
      </div>
    </div>
  </div>

  <!-- Plan features -->
  <div class="cc">
    <div class="cc-hd"><span class="cc-title">Plan Features</span></div>
    <div style="padding:16px 20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
      ${_subFeatures(planType).map(f => `<div style="display:flex;align-items:center;gap:8px;font-size:13px">
        <span style="color:${f.ok?'#2d7a4f':'#ccc'};font-size:16px">${f.ok?'✓':'✗'}</span>
        <span style="color:${f.ok?'var(--text-dark)':'var(--text-muted)'}">${f.label}</span>
      </div>`).join('')}
    </div>
  </div>

  <div id="ncism-sub-card"></div>`;

  if (isNCISMType(t.type)) await _renderNcismCapacityCard(t);
};

// ── NCISM Capacity Plan (Teaching Hospital / College only) ─────────────────
let _ncismTiers = [];
let _ncismPgFee = 0;
let _ncismGstRate = 0;
let _ncismSelectedTier = null;
let _ncismPgSeats = {}; // code -> seats

async function _renderNcismCapacityCard(t) {
  const card = document.getElementById('ncism-sub-card');
  if (!card) return;

  const [{ data: pending }, { data: tiers }, { data: pgFeeRow }, { data: gstRow }, { data: currentDepts }, { data: freshTenant }] = await Promise.all([
    supabase.from('ncism_subscription_requests').select('*').eq('tenant_id', tenantId).eq('status', 'pending').order('requested_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ncism_intake_tiers').select('*').eq('is_active', true).order('sort_order'),
    supabase.from('ncism_pg_seat_fee').select('fee').eq('id', 1).single(),
    supabase.from('platform_gst_config').select('gst_rate').eq('id', 1).single(),
    supabase.from('departments').select('ncism_code,pg_seats_sanctioned,is_pg_dept').eq('tenant_id', tenantId),
    supabase.from('tenants').select('ug_intake,pg_student_strength').eq('id', tenantId).single(),
  ]);

  _ncismTiers = tiers || [];
  _ncismPgFee = pgFeeRow?.fee || 0;
  _ncismGstRate = Number(gstRow?.gst_rate ?? 0);

  // Fresh read, not the session-cached tenant object — this card must reflect
  // an approval that just happened, not whatever was cached at login time.
  const currentUg = freshTenant?.ug_intake ?? t.ug_intake ?? 0;
  const currentPgTotal = freshTenant?.pg_student_strength ?? t.pg_student_strength ?? 0;
  const currentPg = {};
  (currentDepts || []).forEach(d => { if (d.is_pg_dept) currentPg[d.ncism_code] = d.pg_seats_sanctioned || 0; });

  const headerHtml = `
    <div style="background:linear-gradient(135deg,var(--green-deep),#256b41);border-radius:14px 14px 0 0;padding:18px 22px;display:flex;align-items:center;gap:12px">
      <div style="width:38px;height:38px;border-radius:10px;background:rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0">🎓</div>
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:600;color:#fff;line-height:1.2">NCISM Capacity Plan</div>
        <div style="font-size:12px;color:rgba(255,255,255,.65);margin-top:1px">UG intake &amp; PG seats — Teaching Hospital / College only</div>
      </div>
    </div>`;

  if (pending) {
    const pgLines = Object.entries(pending.requested_pg?.reduce?.((m,p)=>{m[p.code]=p.seats;return m;},{}) || {})
      .map(([code, seats]) => `${(NCISM_DEPTS.find(d=>d.ncism_code===code)?.name)||code} (+${seats})`).join(', ') || 'None';
    card.innerHTML = `
    <div class="cc" style="margin-top:20px;overflow:hidden">
      ${headerHtml}
      <div style="padding:22px">
        <div style="display:flex;gap:20px;font-size:13px;color:var(--text-mid);margin-bottom:16px">
          <span>Current UG intake <strong style="color:var(--text-dark)">${currentUg}</strong></span>
          <span>·</span>
          <span>PG seats <strong style="color:var(--text-dark)">${currentPgTotal}</strong></span>
        </div>
        <div style="background:var(--gold-light,#fdf3e2);border:1.5px solid var(--gold,#c9902a);border-radius:12px;padding:16px 18px;font-size:13px;color:var(--text-dark);line-height:1.8">
          <div style="display:flex;align-items:center;gap:8px;font-weight:700;color:#8a5c10;margin-bottom:4px">⏳ Request pending approval</div>
          Submitted ${new Date(pending.requested_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}<br>
          Requested UG intake: <strong>${pending.requested_ug_intake}</strong><br>
          PG additions: ${_esc(pgLines)}<br>
          Base fee: ₹${Number(pending.computed_fee).toLocaleString('en-IN')}${Number(pending.gst_amount) > 0 ? ` + ${pending.gst_rate}% GST (₹${Number(pending.gst_amount).toLocaleString('en-IN')})` : ''}<br>
          Total: <strong style="font-size:16px">₹${(Number(pending.computed_fee) + Number(pending.gst_amount || 0)).toLocaleString('en-IN')}</strong>
        </div>
        <button class="btn-outline" style="margin-top:14px;width:auto" data-onclick="cancelNcismRequest" data-onclick-a0="${pending.id}">✕ Cancel Request</button>
      </div>
    </div>`;
    return;
  }

  _ncismSelectedTier = _ncismTiers.length ? currentUg : null;
  _ncismPgSeats = { ...currentPg };

  const clinicalDepts    = NCISM_DEPTS.filter(d => CLINICAL_CODES.has(d.ncism_code));
  const nonClinicalDepts = NCISM_DEPTS.filter(d => !CLINICAL_CODES.has(d.ncism_code));

  const pgRow = d => {
    const seats = currentPg[d.ncism_code] || 0;
    return `<label for="ncism-pg-${d.ncism_code}" class="ncism-pg-row" style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--border);cursor:pointer">
      <input type="checkbox" id="ncism-pg-${d.ncism_code}" ${seats > 0 ? 'checked' : ''} data-onchange="toggleNcismPgDept" data-onchange-a0="@this" data-onchange-a1="${d.ncism_code}" style="width:16px;height:16px;accent-color:var(--green-mid);cursor:pointer"/>
      <span style="flex:1;font-size:13px;color:var(--text-dark)">${_esc(d.name)}</span>
      <input type="number" id="ncism-pgs-${d.ncism_code}" min="1" max="30" value="${seats || 1}" ${seats > 0 ? '' : 'disabled'}
        style="width:56px;height:30px;text-align:center;border:1.5px solid var(--border);border-radius:6px;font-family:'DM Sans',sans-serif" data-onchange="_ncismUpdateTotal" onclick="event.stopPropagation()"/>
      <span style="font-size:11px;color:var(--text-muted);width:60px">seats</span>
    </label>`;
  };

  card.innerHTML = `
  <div class="cc" style="margin-top:20px;overflow:hidden">
    ${headerHtml}
    <div style="padding:22px">
      <div style="display:flex;gap:20px;font-size:13px;color:var(--text-mid);margin-bottom:4px">
        <span>Current UG intake <strong style="color:var(--text-dark)">${currentUg}</strong></span>
        <span>·</span>
        <span>PG seats <strong style="color:var(--text-dark)">${currentPgTotal}</strong></span>
      </div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:18px">Select a new UG intake tier and/or PG department seats, then submit — a platform admin will review and activate it.</div>

      <div style="font-size:12px;font-weight:700;color:var(--text-mid);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">UG Intake Tier</div>
      <div id="ncism-tier-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:22px">
        ${_ncismTiers.length ? _ncismTiers.map(tier => {
          const isCurrent = tier.ug_intake === currentUg;
          return `<div class="ncism-tier-card" data-onclick="selectNcismTier" data-onclick-a0="${tier.ug_intake}"
               style="position:relative;border:2px solid ${isCurrent ? 'var(--green-deep)' : 'var(--border)'};border-radius:12px;padding:16px 12px;text-align:center;cursor:pointer;background:${isCurrent ? 'var(--green-light)' : 'var(--white)'};box-shadow:0 1px 4px rgba(26,74,46,.06);transition:transform .15s,box-shadow .15s">
            ${isCurrent ? '<div style="position:absolute;top:-9px;left:50%;transform:translateX(-50%);background:var(--green-deep);color:#fff;font-size:9px;font-weight:700;padding:2px 10px;border-radius:20px;letter-spacing:.4px;text-transform:uppercase">Current</div>' : ''}
            <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:600;color:var(--green-deep);line-height:1">${tier.ug_intake}</div>
            <div style="font-size:10px;color:var(--text-muted);margin:3px 0 8px">students / year</div>
            <div style="font-size:13px;font-weight:700;color:var(--gold)">₹${Number(tier.fee).toLocaleString('en-IN')}</div>
            ${_ncismGstRate > 0 ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px">incl. GST ₹${Math.round(Number(tier.fee) * (1 + _ncismGstRate / 100)).toLocaleString('en-IN')}</div>` : ''}
          </div>`;
        }).join('') : `<div style="grid-column:1/-1;text-align:center;padding:22px 16px;background:var(--cream);border:1.5px dashed var(--border);border-radius:12px;font-size:13px;color:var(--text-muted)">
            No intake tiers configured yet — ask a platform admin to add pricing, or contact <a href="mailto:support@ayurxpert.com" style="color:var(--green-mid)">support@ayurxpert.com</a>
          </div>`}
      </div>

      <div style="font-size:12px;font-weight:700;color:var(--text-mid);text-transform:uppercase;letter-spacing:.6px;margin-bottom:10px">PG Departments <span style="font-weight:500;text-transform:none;letter-spacing:0">— Per PG seat ₹${Number(_ncismPgFee).toLocaleString('en-IN')}${_ncismGstRate > 0 ? ` + ${_ncismGstRate}% GST` : ''}</span></div>
      <div id="ncism-pg-list" style="border:1.5px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--green-light)">
          <span style="flex:1;font-size:10.5px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px">Clinical — adds 4 IPD beds per seat</span>
          <span style="width:56px;text-align:center;font-size:10px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.4px;line-height:1.3">Number of PG students</span>
          <span style="width:60px"></span>
        </div>
        ${clinicalDepts.map(pgRow).join('')}
        <div style="padding:8px 16px;background:var(--green-light);font-size:10.5px;font-weight:700;color:var(--green-deep);text-transform:uppercase;letter-spacing:.5px;border-top:1px solid var(--border)">Non-Clinical — no additional beds</div>
        ${nonClinicalDepts.map(pgRow).join('')}
      </div>
      <style>.ncism-pg-row:hover{background:var(--cream)}.ncism-tier-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(26,74,46,.12)}</style>

      <div style="background:var(--green-light);border-radius:12px;padding:14px 18px;margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;font-weight:700;color:var(--green-deep)">💳 Total request fee</span>
          <span id="ncism-total-fee" style="font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:600;color:var(--green-deep)">₹0</span>
        </div>
        <div id="ncism-fee-breakdown" style="font-size:11.5px;color:var(--text-muted);text-align:right;margin-top:2px"></div>
      </div>

      <button class="btn-act" id="ncism-submit-btn" style="padding:11px 26px${_ncismTiers.length ? '' : ';opacity:.5;cursor:not-allowed'}" data-onclick="submitNcismRequest" ${_ncismTiers.length ? '' : 'disabled'}>✓ Submit Request</button>
    </div>
  </div>`;

  window._ncismUpdateTotal();
}

window.selectNcismTier = function(ugIntake) {
  _ncismSelectedTier = Number(ugIntake);
  document.querySelectorAll('.ncism-tier-card').forEach(c => {
    const isSel = Number(c.dataset.onclickA0) === _ncismSelectedTier;
    c.style.borderColor = isSel ? 'var(--green-deep)' : 'var(--border)';
    c.style.background  = isSel ? 'var(--green-light)' : 'var(--white)';
  });
  window._ncismUpdateTotal();
};

window.toggleNcismPgDept = function(cb, code) {
  const input = document.getElementById(`ncism-pgs-${code}`);
  input.disabled = !cb.checked;
  window._ncismUpdateTotal();
};

window._ncismUpdateTotal = function() {
  const tier = _ncismTiers.find(t => t.ug_intake === _ncismSelectedTier);
  let base = tier ? Number(tier.fee) : 0;
  _ncismPgSeats = {};
  NCISM_DEPTS.forEach(d => {
    const cb = document.getElementById(`ncism-pg-${d.ncism_code}`);
    if (cb?.checked) {
      const seats = parseInt(document.getElementById(`ncism-pgs-${d.ncism_code}`)?.value) || 0;
      if (seats > 0) { _ncismPgSeats[d.ncism_code] = seats; base += seats * Number(_ncismPgFee); }
    }
  });
  const gstAmount = Math.round(base * (_ncismGstRate / 100));
  const total = base + gstAmount;
  const el = document.getElementById('ncism-total-fee');
  if (el) el.textContent = `₹${total.toLocaleString('en-IN')}`;
  const bd = document.getElementById('ncism-fee-breakdown');
  if (bd) bd.textContent = _ncismGstRate > 0 ? `Base ₹${base.toLocaleString('en-IN')} + ${_ncismGstRate}% GST ₹${gstAmount.toLocaleString('en-IN')}` : '';
};

window.submitNcismRequest = async function() {
  if (!_ncismSelectedTier) { _toast('Select a UG intake tier first'); return; }
  const tier = _ncismTiers.find(t => t.ug_intake === _ncismSelectedTier);
  const requestedPg = Object.entries(_ncismPgSeats).map(([code, seats]) => ({ code, seats }));
  const pgFeeTotal = requestedPg.reduce((s, p) => s + p.seats * Number(_ncismPgFee), 0);
  const computedFee = (tier ? Number(tier.fee) : 0) + pgFeeTotal;
  const gstAmount = Math.round(computedFee * (_ncismGstRate / 100));

  const { error } = await supabase.from('ncism_subscription_requests').insert({
    tenant_id: tenantId,
    requested_by: profile.id,
    requested_ug_intake: _ncismSelectedTier,
    requested_pg: requestedPg,
    computed_fee: computedFee,
    gst_rate: _ncismGstRate,
    gst_amount: gstAmount,
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not submit request.')); return; }

  await logAudit('ncism_subscription_requested', 'tenants', tenantId, {
    requested_ug_intake: _ncismSelectedTier, requested_pg: requestedPg, computed_fee: computedFee, gst_amount: gstAmount,
  }, { tenantId, userId: profile.id, userName: profile.full_name });

  _toast('✅ Request submitted — awaiting platform approval');
  window.loadSubscription();
};

window.cancelNcismRequest = async function(requestId) {
  if (!confirm('Cancel this capacity request?')) return;
  const { error } = await supabase.from('ncism_subscription_requests').delete().eq('id', requestId);
  if (error) { _toast(safeErrorMessage(error, 'Could not cancel request.')); return; }
  _toast('Request cancelled');
  window.loadSubscription();
};

function _subFeatures(plan) {
  const all = [
    { label:'OPD Registration & Queue', plans:['trial','starter','growth','enterprise'] },
    { label:'Doctor Consultation Module', plans:['trial','starter','growth','enterprise'] },
    { label:'Pharmacy & Dispensary', plans:['trial','starter','growth','enterprise'] },
    { label:'Billing & Invoicing', plans:['trial','starter','growth','enterprise'] },
    { label:'IPD Admissions & Wards', plans:['growth','enterprise'] },
    { label:'Lab & Diagnostics Module', plans:['growth','enterprise'] },
    { label:'NCISM Compliance Monitor', plans:['growth','enterprise'] },
    { label:'Teleconsultation', plans:['growth','enterprise'] },
    { label:'Emergency OPD', plans:['growth','enterprise'] },
    { label:'Labour Room & ANC', plans:['enterprise'] },
    { label:'ABDM / ABHA Integration', plans:['enterprise'] },
    { label:'Unlimited Staff Users', plans:['enterprise'] },
  ];
  return all.map(f => ({ label: f.label, ok: f.plans.includes(plan) }));
}

// Subscription warning banner (shown on stats page)
window.renderSubBanner = function() {
  const t = getCurrentTenant();
  if (!t) return;
  const status  = t.subscription_status || 'trial';
  const expiry  = t.subscription_expiry ? new Date(t.subscription_expiry) : null;
  const trial   = t.trial_ends_at       ? new Date(t.trial_ends_at)       : null;
  const endDate = expiry || trial;
  const daysLeft = endDate ? Math.ceil((endDate - new Date()) / 86400000) : null;
  const el = document.getElementById('sub-banner');
  const dot = document.getElementById('sub-alert-dot');
  if (!el) return;

  let html = '';
  if (status === 'expired' || status === 'suspended') {
    html = `<div class="opd-alert red" style="margin-bottom:14px"><div class="opd-alert-icon">⛔</div><div class="opd-alert-body"><strong>Subscription ${status === 'suspended' ? 'Suspended' : 'Expired'}</strong> — Some features may be restricted. Contact <a href="mailto:support@ayurxpert.com" style="color:inherit;font-weight:700">support@ayurxpert.com</a> to renew.</div></div>`;
    if (dot) dot.style.display = '';
  } else if (daysLeft !== null && daysLeft <= 30 && daysLeft > 0) {
    const cls = daysLeft <= 7 ? 'red' : 'amber';
    html = `<div class="opd-alert ${cls}" style="margin-bottom:14px"><div class="opd-alert-icon">⏰</div><div class="opd-alert-body"><strong>${status === 'trial' ? 'Trial' : 'Subscription'} ending in ${daysLeft} days</strong> — Expires on ${endDate.toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'})}. <a href="mailto:support@ayurxpert.com" style="color:inherit;font-weight:700">Renew now →</a></div></div>`;
    if (daysLeft <= 7 && dot) dot.style.display = '';
  }
  el.innerHTML = html;
};

// Data-migration notices (Session 99) — surfaces staff-visible one-time data fixes
// (tenant_migrations registry) with a manual Apply Now button. Silent (non-visible)
// fixes apply automatically in the background via apply_silent_pending_migrations()
// before this renders, so they never show here at all.
window.renderMigrationBanner = async function() {
  const el = document.getElementById('migration-banner');
  if (!el) return;

  try { await supabase.rpc('apply_silent_pending_migrations'); } catch { /* non-fatal */ }

  const { data, error } = await supabase.rpc('get_pending_visible_migrations');
  if (error || !data?.length) { el.innerHTML = ''; return; }

  const pending = data.filter(m => !sessionStorage.getItem('ax_dismissed_migration_' + m.key));
  if (!pending.length) { el.innerHTML = ''; return; }

  el.innerHTML = pending.map(m => `
    <div class="opd-alert amber" style="margin-bottom:14px" data-migration-row="${_esc(m.key)}">
      <div class="opd-alert-icon">🆕</div>
      <div class="opd-alert-body">
        <div class="opd-alert-title">${_esc(m.title)}</div>
        <div>${_esc(m.description)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn-primary-action" data-onclick="applyTenantMigration" data-onclick-a0="${_esc(m.key)}">Apply Now</button>
        <button class="btn-outline" data-onclick="dismissMigrationBanner" data-onclick-a0="${_esc(m.key)}">Later</button>
      </div>
    </div>`).join('');
};

window.applyTenantMigration = async function(key) {
  const row = document.querySelector(`[data-migration-row="${CSS.escape(key)}"]`);
  const btn = row?.querySelector('[data-onclick="applyTenantMigration"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }

  const { error } = await supabase.rpc('apply_tenant_migration', { p_key: key });
  if (error) {
    _toast(safeErrorMessage(error, 'Failed to apply update.'), true);
    if (btn) { btn.disabled = false; btn.textContent = 'Apply Now'; }
    return;
  }
  _toast('Update applied.');
  row?.remove();
};

window.dismissMigrationBanner = function(key) {
  sessionStorage.setItem('ax_dismissed_migration_' + key, '1');
  document.querySelector(`[data-migration-row="${CSS.escape(key)}"]`)?.remove();
};

// ════════════════════════════════════════════════
// SECTION — PACKAGES
// ════════════════════════════════════════════════
const PKG_TYPES = {panchakarma:'Panchakarma',consultation:'Consultation',wellness:'Wellness',combined:'Combined'};
const PKG_COLORS = {panchakarma:'green',consultation:'blue',wellness:'gold',combined:'red'};
let _pkgTab = 'templates';
let _sellPatientId = null;

window.loadPackages = async function() {
  await _loadPkgTemplates();
};

window.showPkgTab = function(tab) {
  _pkgTab = tab;
  document.getElementById('ptab-templates').classList.toggle('active', tab==='templates');
  document.getElementById('ptab-sold').classList.toggle('active', tab==='sold');
  document.getElementById('pkg-templates-body').style.display = tab==='templates' ? '' : 'none';
  document.getElementById('pkg-sold-body').style.display = tab==='sold' ? '' : 'none';
  if (tab === 'sold') _loadSoldPkgs();
};

async function _loadPkgTemplates() {
  const { data } = await supabase.from('packages').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false });
  const wrap = document.getElementById('pkg-templates-body');
  if (!data?.length) {
    wrap.innerHTML = `<div class="empty"><div class="empty-ico">📦</div><div class="empty-ttl">No packages yet</div><div class="empty-bod">Create package templates to sell to patients.</div></div>`;
    return;
  }
  wrap.innerHTML = `<div style="overflow-x:auto"><table class="data-table">
    <thead><tr><th>Name</th><th>Type</th><th>Sessions</th><th>Validity</th><th>Price</th><th>Status</th><th></th></tr></thead>
    <tbody>${data.map(p => `<tr>
      <td><strong>${_esc(p.name)}</strong>${p.description ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px">${_esc(p.description)}</div>` : ''}</td>
      <td><span class="cat-badge ${PKG_COLORS[p.package_type]||'clinical'}">${PKG_TYPES[p.package_type]||p.package_type}</span></td>
      <td>${p.sessions_total} sessions</td>
      <td>${p.validity_days} days</td>
      <td style="font-weight:600">₹${parseFloat(p.price).toLocaleString('en-IN')}</td>
      <td><span style="font-size:11px;font-weight:600;color:${p.is_active?'var(--green-mid)':'var(--text-muted)'}">${p.is_active?'✓ Active':'✗ Off'}</span></td>
      <td style="white-space:nowrap">
        <button class="btn-outline" style="padding:4px 10px;font-size:12px;margin-right:4px" data-onclick="editPkg" data-onclick-a0="${_esc(p.id)}">Edit</button>
        <button class="btn-act" style="padding:4px 10px;font-size:12px" data-onclick="openSellPkg" data-onclick-a0="${_esc(p.id)}">Sell</button>
      </td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

async function _loadSoldPkgs() {
  const { data } = await supabase.from('patient_packages')
    .select('*, packages(name,package_type), patients(name,phone)')
    .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100);
  const wrap = document.getElementById('pkg-sold-body');
  if (!data?.length) { wrap.innerHTML = `<div class="empty"><div class="empty-ico">🧾</div><div class="empty-ttl">No packages sold yet</div></div>`; return; }
  wrap.innerHTML = `<div style="overflow-x:auto"><table class="data-table">
    <thead><tr><th>Patient</th><th>Package</th><th>Start</th><th>Expires</th><th>Sessions</th><th>Amount</th><th>Status</th></tr></thead>
    <tbody>${data.map(pp => {
      const used = pp.sessions_used, total = pp.sessions_total;
      const pct = Math.round(used/total*100);
      const statusCls = {active:'var(--green-mid)',completed:'var(--text-muted)',expired:'var(--red)',cancelled:'var(--red)'}[pp.status]||'var(--text-muted)';
      return `<tr>
        <td><strong>${_esc(pp.patients?.name||'—')}</strong><div style="font-size:11px;color:var(--text-muted)">${_esc(pp.patients?.phone||'')}</div></td>
        <td>${_esc(pp.packages?.name||'—')}</td>
        <td>${pp.start_date}</td>
        <td>${pp.end_date}</td>
        <td>
          <div style="font-size:13px">${used} / ${total}</div>
          <div style="height:4px;background:#eee;border-radius:4px;width:80px;margin-top:3px"><div style="height:4px;background:var(--green-mid);border-radius:4px;width:${pct}%"></div></div>
        </td>
        <td>₹${parseFloat(pp.amount_paid||0).toLocaleString('en-IN')}</td>
        <td><span style="font-size:11px;font-weight:600;color:${statusCls}">${pp.status}</span></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

window.openPkgForm = function(data) {
  document.getElementById('pkg-id').value = data?.id || '';
  document.getElementById('pkg-name').value = data?.name || '';
  document.getElementById('pkg-type').value = data?.package_type || 'panchakarma';
  document.getElementById('pkg-sessions').value = data?.sessions_total || '';
  document.getElementById('pkg-validity').value = data?.validity_days || '';
  document.getElementById('pkg-price').value = data?.price || '';
  document.getElementById('pkg-desc').value = data?.description || '';
  document.getElementById('pkg-form-title').textContent = data ? 'Edit Package' : 'New Package';
  document.getElementById('pkg-form-wrap').style.display = '';
  document.getElementById('pkg-alert').className = 'alert';
};

window.closePkgForm = function() { document.getElementById('pkg-form-wrap').style.display = 'none'; };

window.editPkg = async function(id) {
  const { data } = await supabase.from('packages').select('*').eq('id', id).single();
  if (data) openPkgForm(data);
};

window.savePkg = async function() {
  const id = document.getElementById('pkg-id').value;
  const name = document.getElementById('pkg-name').value.trim();
  const sessions = parseInt(document.getElementById('pkg-sessions').value);
  const validity = parseInt(document.getElementById('pkg-validity').value);
  const price = parseFloat(document.getElementById('pkg-price').value);
  if (!name) return _pkgAlert('error','Package name is required.');
  if (!sessions || sessions < 1) return _pkgAlert('error','Sessions must be at least 1.');
  if (!validity || validity < 1) return _pkgAlert('error','Validity days must be at least 1.');
  if (isNaN(price) || price < 0) return _pkgAlert('error','Enter a valid price.');
  const payload = { tenant_id: tenantId, name, package_type: document.getElementById('pkg-type').value,
    sessions_total: sessions, validity_days: validity, price,
    description: document.getElementById('pkg-desc').value.trim() || null, is_active: true };
  const { error } = id
    ? await supabase.from('packages').update(payload).eq('id', id)
    : await supabase.from('packages').insert(payload);
  if (error) return _pkgAlert('error', safeErrorMessage(error, 'Save failed.'));
  closePkgForm();
  await _loadPkgTemplates();
};

function _pkgAlert(type, msg) {
  const el = document.getElementById('pkg-alert');
  el.textContent = msg;
  el.className = `alert show ${type}`;
}

// Sell Package
let _sellTimer = null;
window.openSellPkg = async function(pkgId) {
  _sellPatientId = null;
  document.getElementById('sell-pt-search').value = '';
  document.getElementById('sell-pt-tag').style.display = 'none';
  document.getElementById('sell-pt-results').style.display = 'none';
  document.getElementById('sell-start').value = new Date().toISOString().slice(0,10);
  document.getElementById('sell-notes').value = '';
  document.getElementById('sell-alert').className = 'alert';
  // Populate package dropdown
  const { data: pkgs } = await supabase.from('packages').select('id,name,sessions_total,validity_days,price').eq('tenant_id',tenantId).eq('is_active',true).order('name');
  const sel = document.getElementById('sell-pkg-sel');
  sel.innerHTML = (pkgs||[]).map(p=>`<option value="${p.id}" data-sessions="${p.sessions_total}" data-validity="${p.validity_days}" data-price="${p.price}">${_esc(p.name)} — ₹${parseFloat(p.price).toLocaleString('en-IN')}</option>`).join('');
  if (pkgId) sel.value = pkgId;
  _updateSellAmount();
  sel.onchange = _updateSellAmount;
  document.getElementById('sell-pkg-overlay').style.display = 'flex';
};

function _updateSellAmount() {
  const sel = document.getElementById('sell-pkg-sel');
  const opt = sel.options[sel.selectedIndex];
  document.getElementById('sell-amount').value = opt?.dataset?.price || '';
}

window.searchSellPatient = function() {
  clearTimeout(_sellTimer);
  const q = document.getElementById('sell-pt-search').value.trim();
  if (q.length < 3) { document.getElementById('sell-pt-results').style.display = 'none'; return; }
  _sellTimer = setTimeout(async () => {
    const isPhone = /^\d{6,}$/.test(q);
    const query = supabase.from('patients').select('id,name,phone').eq('tenant_id',tenantId);
    const { data } = isPhone ? await query.eq('phone',q).limit(5) : await query.ilike('name',`%${q}%`).limit(5);
    const res = document.getElementById('sell-pt-results');
    if (!data?.length) { res.style.display = 'none'; return; }
    res.innerHTML = data.map(p=>`<div style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid var(--border)" data-onclick="selectSellPatient" data-onclick-a0="${_esc(p.id)}" data-onclick-a1="${_esc(p.name)}" data-onclick-a2="${_esc(p.phone||'')}" onmouseover="this.style.background='var(--green-light)'" onmouseout="this.style.background=''"><strong>${_esc(p.name)}</strong> <span style="color:var(--text-muted);font-size:11px">${p.phone||''}</span></div>`).join('');
    res.style.display = '';
  }, 300);
};

window.selectSellPatient = function(id, name, phone) {
  _sellPatientId = id;
  document.getElementById('sell-pt-results').style.display = 'none';
  document.getElementById('sell-pt-tag').textContent = `✓ ${name}${phone?' · '+phone:''}`;
  document.getElementById('sell-pt-tag').style.display = '';
};

window.closeSellPkg = function() { document.getElementById('sell-pkg-overlay').style.display = 'none'; };

window.confirmSellPkg = async function() {
  if (!_sellPatientId) return _sellAlert('error','Please select a patient.');
  const sel = document.getElementById('sell-pkg-sel');
  const opt = sel.options[sel.selectedIndex];
  const pkgId = sel.value;
  const sessions = parseInt(opt?.dataset?.sessions||'1');
  const validity = parseInt(opt?.dataset?.validity||'90');
  const startDate = document.getElementById('sell-start').value;
  if (!startDate) return _sellAlert('error','Select a start date.');
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + validity);
  const { error } = await supabase.from('patient_packages').insert({
    tenant_id: tenantId, patient_id: _sellPatientId, package_id: pkgId,
    sessions_total: sessions, sessions_used: 0,
    start_date: startDate, end_date: endDate.toISOString().slice(0,10),
    status: 'active',
    amount_paid: parseFloat(document.getElementById('sell-amount').value)||0,
    payment_mode: document.getElementById('sell-mode').value,
    notes: document.getElementById('sell-notes').value.trim()||null,
    sold_by: profile.id
  });
  if (error) return _sellAlert('error',safeErrorMessage(error,'Failed to sell package.'));
  closeSellPkg();
  if (_pkgTab==='sold') _loadSoldPkgs();
  _toast('✓ Package sold successfully');
};

function _sellAlert(type, msg) {
  const el = document.getElementById('sell-alert');
  el.textContent = msg;
  el.className = `alert show ${type}`;
}

// ════════════════════════════════════════════════
// §7h — FEATURE MODULES
// ════════════════════════════════════════════════
const _MODULE_META = [
  { key:'opd',         label:'OPD & Reception',         icon:'🩺', desc:'Patient registration, doctor queue, OPD setup, triage, teleconsult'  },
  { key:'ipd',         label:'IPD & Ward',               icon:'🏥', desc:'Admissions, discharge, bed management, OT, ANC, Kshara Sutra'       },
  { key:'pharmacy',    label:'Pharmacy & Dispensary',    icon:'💊', desc:'POS, inventory, purchase, formulary, suppliers, disposal register'    },
  { key:'lab',         label:'Diagnostics & Lab',        icon:'🔬', desc:'Pathology, radiology, AERB log, PCPNDT register'                     },
  { key:'panchakarma', label:'Panchakarma',              icon:'🌿', desc:'Therapy sessions, Palha Diet, PK scheduling'                         },
  { key:'emergency',   label:'Emergency OPD',            icon:'🚨', desc:'24×7 emergency case register, RMO log, observation beds, MLC'         },
  { key:'nursing',     label:'Nursing',                  icon:'👩‍⚕️', desc:'Vitals chart, MAR, intake-output, nursing notes, handovers'           },
  { key:'teleconsult', label:'Teleconsultation',         icon:'📹', desc:'Tele schedule, online consultation, video queue'                     },
  { key:'ncism',       label:'NCISM Compliance',         icon:'📋', desc:'Monthly reports, compliance monitor, teaching OPD, IQAC, PvPI'       },
  { key:'finance',     label:'Finance & Billing',        icon:'💰', desc:'Revenue dashboard, outstanding bills, GST reports, fee management'    },
  { key:'hr',          label:'Human Resources',          icon:'👥', desc:'Staff directory, duty roster, leave management, training records'     },
  { key:'mrd',         label:'Medical Records (MRD)',    icon:'🗂️', desc:'Patient file browser, statistics, diagnosis burden reports'           },
  { key:'quality',     label:'Quality Management',       icon:'⭐', desc:'Pharmacovigilance, IQAC, BMW waste, sterilisation, incident reports'  },
  { key:'abdm',        label:'ABDM / ABHA',              icon:'🏛️', desc:'ABHA enrolment, Scan & Share, health record linking'                 },
];

window.loadModules = async function() {
  const el = document.getElementById('modules-body');
  const { data: t, error } = await supabase
    .from('tenants').select('modules, type').eq('id', tenantId).single();
  if (error) { el.innerHTML = `<div class="alert show error">Error loading: ${_esc(safeErrorMessage(error, 'Could not load modules.'))}</div>`; return; }

  const defaults = _getDefaultModules(t.type);
  const saved    = t.modules || {};
  const effective = { ...defaults, ...saved };

  el.innerHTML = `
    <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:12.5px;color:#7a5200">
      <strong>Note:</strong> Defaults are set by your organisation type (<strong>${_tenantTypeLabel(t.type)}</strong>).
      Toggle individual modules below. Changes take effect on next login.
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px" id="mod-grid">
      ${_MODULE_META.map(m => {
        const on = effective[m.key] !== false;
        const isDefault = defaults[m.key] === true && saved[m.key] === undefined;
        return `<div style="background:${on?'#f0fff4':'#fafafa'};border:1.5px solid ${on?'#a5d6b8':'#e0e0e0'};border-radius:8px;padding:12px 14px;display:flex;align-items:flex-start;gap:12px">
          <div style="font-size:20px;flex-shrink:0">${m.icon}</div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:${on?'var(--green-deep)':'#888'}">${m.label}</div>
            <div style="font-size:11px;color:var(--text-muted);margin:2px 0 8px;line-height:1.4">${m.desc}</div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:500;color:${on?'var(--green-mid)':'#aaa'}">
              <input type="checkbox" data-mod="${m.key}" ${on?'checked':''} data-onchange="_refreshModCard" data-onchange-a0="@this"
                style="width:16px;height:16px;accent-color:var(--green-mid);cursor:pointer"/>
              ${on ? 'Enabled' : 'Disabled'}
              ${isDefault?'<span style="font-size:10px;color:var(--text-muted);font-weight:400">(default for your plan)</span>':''}
            </label>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  document.getElementById('btn-save-modules').onclick = _saveModules;
};

function _refreshModCard(chk) {
  const card = chk.closest('div[style*="border-radius:8px"]');
  const on = chk.checked;
  card.style.background = on ? '#f0fff4' : '#fafafa';
  card.style.border = `1.5px solid ${on ? '#a5d6b8' : '#e0e0e0'}`;
  const title = card.querySelector('div[style*="font-weight:600"]');
  title.style.color = on ? 'var(--green-deep)' : '#888';
  const lbl = chk.parentElement;
  lbl.style.color = on ? 'var(--green-mid)' : '#aaa';
  lbl.firstChild.textContent = '';
  lbl.childNodes[1].textContent = on ? 'Enabled' : 'Disabled';
}

async function _saveModules() {
  const checkboxes = document.querySelectorAll('#mod-grid input[data-mod]');
  const { data: t } = await supabase.from('tenants').select('type').eq('id', tenantId).single();
  const defaults = _getDefaultModules(t?.type);
  // Only save explicit overrides — skip keys where checkbox matches the default
  const overrides = {};
  checkboxes.forEach(c => {
    const key  = c.dataset.mod;
    const val  = c.checked;
    const def  = defaults[key] === true;
    if (val !== def) overrides[key] = val;   // only store when admin overrides the default
  });
  const { error } = await supabase.from('tenants').update({ modules: overrides }).eq('id', tenantId);
  if (error) { _toast(safeErrorMessage(error, 'Save error.')); return; }
  _toast('✓ Modules saved — changes take effect on next login');
}

function _getDefaultModules(type) {
  const D = {
    clinic:           { opd:true, pharmacy:true, teleconsult:true, quality:true, finance:true, abdm:true },
    hospital:         { opd:true, ipd:true, pharmacy:true, lab:true, emergency:true, nursing:true, panchakarma:true, teleconsult:true, finance:true, hr:true, mrd:true, quality:true, abdm:true },
    teaching_hospital:{ opd:true, ipd:true, pharmacy:true, lab:true, emergency:true, nursing:true, panchakarma:true, teleconsult:true, ncism:true, finance:true, hr:true, mrd:true, quality:true, abdm:true },
    college:          { opd:true, ipd:true, pharmacy:true, lab:true, emergency:true, nursing:true, panchakarma:true, teleconsult:true, ncism:true, finance:true, hr:true, mrd:true, quality:true, abdm:true },
    pk_center:        { opd:true, panchakarma:true, pharmacy:true, teleconsult:true, quality:true, finance:true, abdm:true },
    dispensary:       { pharmacy:true, finance:true },
    pharma:           { pharmacy:true, finance:true },
    supplier:         { finance:true },
    dealer:           { finance:true },
  };
  return D[type] || { opd:true };
}

// ── §21x NABH Accreditation ────────────────────────────────────────────────
window.loadNabhStatus = async function() {
  const el = document.getElementById('nabh-body');
  if (!el) return;
  const t = getCurrentTenant();
  if (!t) return;
  const level  = t.nabh_level || 'not_accredited';
  const expiry = t.nabh_expiry ? new Date(t.nabh_expiry) : null;
  const cert   = t.nabh_certificate_number || null;
  const today  = new Date();
  const daysLeft = expiry ? Math.ceil((expiry - today) / 86400000) : null;
  const levelMeta = {
    entry:           { label:'Entry Level', color:'#2d7a4f', bg:'#e8f5ee' },
    full:            { label:'Full Accreditation', color:'#1a4a2e', bg:'#b2d8bf' },
    not_accredited:  { label:'Not Accredited', color:'#8a9e90', bg:'#f5f5f5' },
  };
  const lm = levelMeta[level] || levelMeta.not_accredited;
  let expiryHtml = '';
  if (expiry) {
    const col = daysLeft !== null && daysLeft <= 60 ? '#dc2626' : '#4a6352';
    expiryHtml = `<div style="font-size:13px;color:${col}">Expiry: <strong>${expiry.toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})}</strong>${daysLeft !== null ? ` · ${daysLeft <= 0 ? '⚠ Expired' : daysLeft + ' days left'}` : ''}</div>`;
  }
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div style="background:${lm.bg};color:${lm.color};font-weight:700;font-size:15px;padding:6px 18px;border-radius:8px">${lm.label}</div>
      ${cert ? `<div style="font-size:12px;color:var(--text-mid)">Cert No: <strong>${cert}</strong></div>` : '<div style="font-size:12px;color:var(--text-muted);font-style:italic">Certificate number not entered</div>'}
    </div>
    ${expiryHtml}
    ${level === 'not_accredited' ? '<div style="font-size:12px;color:#8a5c00;margin-top:8px;padding:8px 12px;background:#fffbe6;border-radius:6px;border:1px solid #f4d03f">⚠ NABH Entry Level accreditation is required for new college applications to NCISM (Regulation §3.16)</div>' : ''}`;
};

window.openNabhModal = function() {
  const t = getCurrentTenant();
  if (!t) return;
  const m = document.getElementById('nabh-edit-modal');
  document.getElementById('nabh-cert-no').value   = t.nabh_certificate_number || '';
  document.getElementById('nabh-level-sel').value = t.nabh_level || 'not_accredited';
  document.getElementById('nabh-expiry-inp').value = t.nabh_expiry ? t.nabh_expiry.slice(0,10) : '';
  m.style.display = 'flex';
};
window.closeNabhModal = function() { document.getElementById('nabh-edit-modal').style.display = 'none'; };
window.saveNabhDetails = async function() {
  const cert   = document.getElementById('nabh-cert-no').value.trim() || null;
  const level  = document.getElementById('nabh-level-sel').value;
  const expiry = document.getElementById('nabh-expiry-inp').value || null;
  const { error } = await supabase.from('tenants').update({
    nabh_certificate_number: cert, nabh_level: level, nabh_expiry: expiry,
  }).eq('id', tenantId);
  if (error) { alert(safeErrorMessage(error, 'Could not save NABH details.')); return; }
  closeNabhModal();
  // Refresh tenant in sessionStorage
  const { data: fresh } = await supabase.from('tenants').select('*').eq('id', tenantId).single();
  if (fresh) sessionStorage.setItem('ayurxpert_tenant', JSON.stringify(fresh));
  loadNabhStatus();
};

// ── §21c Monthly SDF Export ───────────────────────────────────────────────────
window.generateSDF = async function() {
  const month = document.getElementById('sdf-month').value;
  if (!month) { alert('Select a month'); return; }
  const from = month + '-01', to = month + '-31';
  const el = document.getElementById('sdf-content');
  el.textContent = 'Generating…';
  const [visitsRes, admRes, staffRes] = await Promise.all([
    supabase.from('visits').select('id,is_teleconsultation,visit_category,opds(ncism_code)').eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59'),
    supabase.from('ipd_admissions').select('id,departments(ncism_code)').eq('tenant_id',tenantId).gte('admission_date',from).lte('admission_date',to),
    supabase.from('profiles').select('id,role').eq('tenant_id',tenantId).eq('is_active',true),
  ]);
  const visits = visitsRes.data || [];
  const adms   = admRes.data   || [];
  const staff  = staffRes.data || [];
  const clinicalVisits = visits.filter(v => !v.is_teleconsultation && (v.visit_category||'clinical')==='clinical');
  const teleVisits     = visits.filter(v => v.is_teleconsultation);
  const deptOPD = {}; clinicalVisits.forEach(v => { const c = v.opds?.ncism_code||'UNK'; deptOPD[c]=(deptOPD[c]||0)+1; });
  const deptIPD = {}; adms.forEach(a => { const c = a.departments?.ncism_code||'UNK'; deptIPD[c]=(deptIPD[c]||0)+1; });
  const roleCounts = {}; staff.forEach(s => { roleCounts[s.role]=(roleCounts[s.role]||0)+1; });
  el.innerHTML = `<div style="font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:10px">SDF Data — ${month}</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      <div style="padding:10px;background:var(--green-light);border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">OPD (clinical)</div><div style="font-size:24px;font-weight:700;color:var(--green-deep)">${clinicalVisits.length}</div></div>
      <div style="padding:10px;background:#e3f0ff;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Teleconsultations</div><div style="font-size:24px;font-weight:700;color:#1a4080">${teleVisits.length}</div></div>
      <div style="padding:10px;background:#fdf3e2;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">IPD Admissions</div><div style="font-size:24px;font-weight:700;color:var(--gold)">${adms.length}</div></div>
    </div>
    <div style="font-size:12px;margin-bottom:8px"><strong>OPD by Dept:</strong> ${Object.entries(deptOPD).map(([c,n])=>`${c}:${n}`).join(' · ')||'—'}</div>
    <div style="font-size:12px;margin-bottom:8px"><strong>IPD by Dept:</strong> ${Object.entries(deptIPD).map(([c,n])=>`${c}:${n}`).join(' · ')||'—'}</div>
    <div style="font-size:12px;margin-bottom:10px"><strong>Staff:</strong> ${Object.entries(roleCounts).map(([r,n])=>`${r}:${n}`).join(' · ')}</div>
    <div style="font-size:11px;color:var(--text-muted);padding:10px;background:#f5faf7;border-radius:6px">Upload this data to NCISM SDF portal by the 10th. Copy dept-wise OPD + IPD figures into the portal fields.</div>`;
};

// ── §21w Monthly Hospital Statistics ─────────────────────────────────────────
let _statsData = {};
window.generateMonthlyStats = async function() {
  const month = document.getElementById('stat-month').value;
  if (!month) { alert('Select a month'); return; }
  const from = month + '-01', to = month + '-31';
  const el = document.getElementById('stat-body');
  el.innerHTML = '<div style="color:var(--text-muted)">Generating…</div>';
  const [v, adm, bills, del, lab] = await Promise.all([
    supabase.from('visits').select('id,is_teleconsultation').eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59'),
    supabase.from('ipd_admissions').select('id').eq('tenant_id',tenantId).gte('admission_date',from).lte('admission_date',to),
    supabase.from('bills').select('id,final_amount').eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59').eq('status','paid'),
    supabase.from('deliveries').select('id').eq('tenant_id',tenantId).gte('delivery_date',from).lte('delivery_date',to),
    supabase.from('lab_orders').select('id').eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59'),
  ]);
  const opdCount  = (v.data||[]).filter(x=>!x.is_teleconsultation).length;
  const ipdCount  = (adm.data||[]).length;
  const revenue   = (bills.data||[]).reduce((s,b)=>s+(b.final_amount||0),0);
  const deliveries= (del.data||[]).length;
  const labCount  = (lab.data||[]).length;
  _statsData = { month, opdCount, ipdCount, revenue, deliveries, labCount };
  el.innerHTML = `<div style="font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:10px">Hospital Statistics — ${month}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:12px">
      <div style="padding:10px;background:var(--green-light);border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">OPD Patients</div><div style="font-size:26px;font-weight:700;color:var(--green-deep)">${opdCount}</div></div>
      <div style="padding:10px;background:#e3f0ff;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">IPD Admissions</div><div style="font-size:26px;font-weight:700;color:#1a4080">${ipdCount}</div></div>
      <div style="padding:10px;background:#fdf3e2;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Lab Tests</div><div style="font-size:26px;font-weight:700;color:var(--gold)">${labCount}</div></div>
      <div style="padding:10px;background:#f0e8ff;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Deliveries</div><div style="font-size:26px;font-weight:700;color:#5a1a8b">${deliveries}</div></div>
      <div style="padding:10px;background:#fff8e1;border-radius:8px;text-align:center"><div style="font-size:10px;color:var(--text-muted);text-transform:uppercase">Revenue</div><div style="font-size:20px;font-weight:700;color:#6b4c00">₹${Math.round(revenue/1000)}K</div></div>
    </div>
    <div style="font-size:11px;color:var(--text-muted);padding:10px;background:#f5faf7;border-radius:6px">Print PDF to publish on institutional website. NCISM Reg 11(6)(l) requires website publication by 10th of each month.</div>`;
};
window.exportStatsPDF = function() { if (!_statsData.month) { alert('Generate statistics first'); return; } window.print(); };

// ── §21b NAMSTE Morbidity Export ──────────────────────────────────────────────
let _namsteData = [];
window.generateNAMSTE = async function() {
  const month = document.getElementById('namste-month').value;
  if (!month) { alert('Select a month'); return; }
  const from = month + '-01', to = month + '-31';
  const el = document.getElementById('namste-body');
  el.innerHTML = '<div style="color:var(--text-muted)">Fetching diagnosis data…</div>';
  const { data, error } = await supabase.from('consultation_notes')
    .select('diagnosis_namc_code,diagnosis_namc_label')
    .eq('tenant_id',tenantId).gte('created_at',from+'T00:00:00').lte('created_at',to+'T23:59:59')
    .not('diagnosis_namc_code','is',null);
  if (error) { el.innerHTML = `<div style="color:#c0392b">${_esc(safeErrorMessage(error, 'Could not load data.'))}</div>`; return; }
  const counts = {};
  (data||[]).forEach(cn => { const k = cn.diagnosis_namc_code; if (!k) return; if (!counts[k]) counts[k]={code:k,label:cn.diagnosis_namc_label||k,count:0}; counts[k].count++; });
  _namsteData = Object.values(counts).sort((a,b)=>b.count-a.count);
  if (!_namsteData.length) { el.innerHTML = '<div style="color:var(--text-muted)">No NAMASTE-coded diagnoses found. Ensure doctors are using dual-coding in consultations.</div>'; return; }
  el.innerHTML = `<div style="font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:10px">NAMSTE Morbidity — ${month} (${_namsteData.length} conditions)</div>
    <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px">
      <thead><tr style="background:#f5faf7"><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">NAMC Code</th><th style="padding:6px 10px;text-align:left;border-bottom:1.5px solid var(--border)">Condition</th><th style="padding:6px 10px;text-align:right;border-bottom:1.5px solid var(--border)">Cases</th></tr></thead>
      <tbody>${_namsteData.slice(0,20).map(d=>`<tr><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;font-weight:600;color:var(--green-deep)">${d.code}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2">${d.label}</td><td style="padding:6px 10px;border-bottom:1px solid #f0f4f2;text-align:right;font-weight:600">${d.count}</td></tr>`).join('')}</tbody>
    </table>
    ${_namsteData.length>20?`<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">Showing top 20 of ${_namsteData.length}. Use CSV export for full list.</div>`:''}
    <div style="font-size:11px;color:var(--text-muted);padding:10px;background:#f5faf7;border-radius:6px">Export CSV and upload to CCRAS NAMSTE portal. NCISM Reg 39(8).</div>`;
};
window.exportNAMSTECSV = function() {
  if (!_namsteData.length) { alert('Generate NAMSTE data first'); return; }
  const rows = [['NAMC Code','Condition','Cases']].concat(_namsteData.map(d=>[d.code,d.label,d.count]));
  const csv = rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download = `NAMSTE-morbidity-${document.getElementById('namste-month').value}.csv`;
  a.click();
};

// ── ABDM Bridge ───────────────────────────────────────────────────
async function _abdmCall(action, extra = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/abdm-auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  return res.json();
}

window.checkBridgeUrl = async function() {
  const el = document.getElementById('bridge-url-status');
  el.textContent = 'Fetching from ABDM…';
  const data = await _abdmCall('get_bridge_services');
  const url = data?.bridge?.url ?? null;
  const expected = 'https://xvlvifiebafvgzlixdee.supabase.co/functions/v1/abdm-webhook';
  if (url) {
    const ok = url === expected;
    el.innerHTML = ok
      ? `<span style="color:#16a34a;font-weight:600">✅ Correct: ${_esc(url)}</span>`
      : `<span style="color:#dc2626;font-weight:600">⚠️ WRONG URL registered:</span> <code style="background:#fff0f0;padding:2px 5px;border-radius:3px">${_esc(url)}</code><br><span style="color:#dc2626;font-size:11px">This is why ABDM callbacks (Scan &amp; Share, consent) never reach AyurXpert. Update below.</span>`;
    document.getElementById('bridge-url-input').value = url;
  } else {
    el.innerHTML = `<span style="color:#dc2626">Error: ${_esc(JSON.stringify(data))}</span>`;
  }
};

window.updateBridgeUrl = async function() {
  const url = document.getElementById('bridge-url-input').value.trim();
  if (!url) { alert('Enter a URL first'); return; }
  const el = document.getElementById('bridge-url-status');
  el.textContent = 'Updating…';
  const data = await _abdmCall('update_bridge_url', { url });
  if (data?.status === 202 || data?.status === 200) {
    el.innerHTML = `<span style="color:#16a34a;font-weight:600">✅ Updated! ABDM will now send callbacks to: ${_esc(url)}</span>`;
  } else {
    el.innerHTML = `<span style="color:#dc2626">Error: ${_esc(JSON.stringify(data))}</span>`;
  }
};

window.checkBridgeServices = async function() {
  const el = document.getElementById('bridge-services-body');
  el.textContent = 'Loading…';
  const data = await _abdmCall('get_bridge_services');
  const services = data?.services ?? [];
  if (!services.length) { el.innerHTML = `<span style="color:var(--text-muted)">No services found. ${_esc(JSON.stringify(data))}</span>`; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7">
      <th style="padding:6px 10px;text-align:left">Service ID</th>
      <th style="padding:6px 10px;text-align:left">Name</th>
      <th style="padding:6px 10px;text-align:left">Types</th>
      <th style="padding:6px 10px;text-align:left">Active</th>
    </tr></thead>
    <tbody>${services.map(s=>`<tr style="border-top:1px solid #eee">
      <td style="padding:6px 10px;font-weight:600;color:var(--green-deep)">${_esc(s.id ?? '')}</td>
      <td style="padding:6px 10px">${_esc(s.name ?? '')}</td>
      <td style="padding:6px 10px">${_esc((s.types??[]).join(', '))}</td>
      <td style="padding:6px 10px">${s.active ? '✅' : '❌'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
};

window.loadAbdmCallbacks = async function() {
  const el = document.getElementById('abdm-callbacks-body');
  el.textContent = 'Loading…';
  const { data, error } = await supabase
    .from('abdm_callbacks')
    .select('id, callback_type, payload, created_at, processed')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { el.textContent = safeErrorMessage(error, 'Could not load callbacks.'); return; }
  if (!data?.length) {
    el.innerHTML = '<span style="color:#dc2626;font-weight:600">⚠️ No callbacks received. If you scanned a QR and nothing shows here, the bridge URL is wrong.</span>';
    return;
  }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="background:#f5faf7">
      <th style="padding:6px 10px;text-align:left">Time</th>
      <th style="padding:6px 10px;text-align:left">Type</th>
      <th style="padding:6px 10px;text-align:left">Processed</th>
    </tr></thead>
    <tbody>${data.map(c=>`<tr style="border-top:1px solid #eee">
      <td style="padding:6px 10px;color:var(--text-muted)">${new Date(c.created_at).toLocaleTimeString()}</td>
      <td style="padding:6px 10px;font-weight:600;color:var(--green-deep)">${_esc(c.callback_type)}</td>
      <td style="padding:6px 10px">${c.processed ? '✅' : '⏳'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
};
