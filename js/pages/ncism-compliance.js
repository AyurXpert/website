import { requireAuth, getCurrentTenantId, getCurrentRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { isNCISMType } from '../config/ncism.js';

await requireAuth(['super_admin','dept_admin','accountant']);
initNavbar();
wireDelegatedEvents();
const tenantId = getCurrentTenantId();
const role     = getCurrentRole();

window._print = () => window.print();

// ── State ─────────────────────────────────────────────────────────────────────
let _period      = 'monthly';
let _refDate     = new Date().toISOString().slice(0,10);
let _cfg         = { ugIntake: 60, students: 0, opdTarget: 120, workdays: 6 };
let _showNonPg   = false;
let _tenantType  = '';

// NCISM Table-8 UG bed distribution ratios (by ncism_code)
const UG_BED_RATIOS = { KAY:.20, PK:.25, SHAL:.20, SHAK:.10, KAU:.10, AGD:.05, PST:.10 };

// NCISM Schedule I academic classification (pre-clinical / para-clinical / clinical),
// keyed by ncism_code — departments.category holds an unrelated ops/facility taxonomy
// (IPD_PARENT, HOUSEKEEPING, FINANCE, etc.) for synthetic HR-org sections, so it can't
// be used blindly here, but for a REAL NCISM-coded teaching department the correct source
// of truth is js/config/ncism.js's NCISM_DEPTS — matched exactly below (was previously
// out of sync: Agada Tantra mis-classified para-clinical instead of clinical, Dravyaguna/
// Rasashastra & Bhaishajya Kalpana mis-classified para-clinical instead of pre-clinical,
// Kriya Sharira missing entirely). Codes not in this map default to 'clinical' (the
// conservative, higher-requirement bucket). GENERAL and SCREENING_OPD are excluded
// entirely — not real NCISM-regulated teaching departments.
const DEPT_ACADEMIC_TYPE = {
  // Pre-clinical
  SS:'pre_clinical', RS:'pre_clinical', KS:'pre_clinical',
  DG:'pre_clinical', DRAVYAGUNA:'pre_clinical',
  RASASHASTRA_BK:'pre_clinical', RBK:'pre_clinical',
  // Para-clinical
  RNV:'para_clinical', ROGANIDANA:'para_clinical',
  SW:'para_clinical', SWASTHAVRITTA_YOGA:'para_clinical',
  // Clinical
  KAY:'clinical', KAYACHIKITSA:'clinical',
  PK:'clinical', PANCHAKARMA:'clinical',
  SHAL:'clinical', SHALYA_TANTRA:'clinical',
  SHAK:'clinical', SHALAKYA_KNM:'clinical', SHALAKYA_NETRA:'clinical',
  PST:'clinical', STRI_ROGA_PRASUTI:'clinical',
  KAU:'clinical', KAUMARABHRITYA:'clinical',
  AGD:'clinical', AGADA_TANTRA:'clinical',
  RASAYANA_VAJIKARANA:'clinical', MANASAROGA:'clinical',
  // Not real academic teaching departments — excluded from Faculty Strength
  GENERAL: null, SCREENING_OPD: null,
};
function _academicType(ncismCode) {
  // No ncism_code at all → not a real NCISM-regulated teaching department (facility/ops
  // departments like Security, Laundry, Finance, Housekeeping never get one — confirmed
  // empirically against the live schema, see memory: ncism_compliance_html_csp_hardening.md).
  if (!ncismCode) return null;
  const key = String(ncismCode).toUpperCase();
  if (key in DEPT_ACADEMIC_TYPE) return DEPT_ACADEMIC_TYPE[key];
  return 'clinical';
}

// ── Date range for period ─────────────────────────────────────────────────────
function _dateRange() {
  const ref = new Date(_refDate + 'T00:00:00');
  const day = ref.getDay();
  const mon = new Date(ref); mon.setDate(ref.getDate() - ((day + 6) % 7));

  let from, to;
  if (_period === 'daily') {
    from = to = _refDate;
  } else if (_period === 'weekly') {
    from = mon.toISOString().slice(0,10);
    to   = new Date(mon.getTime() + 6*86400000).toISOString().slice(0,10);
  } else if (_period === 'monthly') {
    from = _refDate.slice(0,8) + '01';
    to   = new Date(ref.getFullYear(), ref.getMonth()+1, 0).toISOString().slice(0,10);
  } else {
    const q = Math.floor(ref.getMonth() / 3);
    from = new Date(ref.getFullYear(), q*3, 1).toISOString().slice(0,10);
    to   = new Date(ref.getFullYear(), q*3+3, 0).toISOString().slice(0,10);
  }
  return { from, to };
}

function _workingDays(from, to) {
  const start = new Date(from); const end = new Date(to);
  let days = 0; const d = new Date(start);
  while (d <= end) { if (d.getDay() !== 0) days++; d.setDate(d.getDate()+1); }
  return days;
}

function _fmtRange(from, to) {
  const f = d => new Date(d+'T00:00:00').toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  return from === to ? f(from) : f(from) + ' – ' + f(to);
}

// ── Load config ───────────────────────────────────────────────────────────────
async function loadConfig() {
  const { data } = await supabase
    .from('tenants')
    .select('ug_intake,pg_student_strength,opd_daily_target,working_days_per_week,type')
    .eq('id', tenantId)
    .single();
  if (data) {
    _cfg.ugIntake  = data.ug_intake             || 60;
    _cfg.students  = data.pg_student_strength   || 0;
    _cfg.opdTarget = data.opd_daily_target      || (_cfg.ugIntake * 2);
    _cfg.workdays  = data.working_days_per_week || 6;
    _tenantType    = data.type || '';
  }
  document.getElementById('cfg-ug-intake').value  = _cfg.ugIntake;
  document.getElementById('cfg-opd-target').value = _cfg.opdTarget;
  document.getElementById('cfg-workdays').value   = _cfg.workdays;
}

// ── Save config ───────────────────────────────────────────────────────────────
window.saveConfig = async function() {
  const ugIntake = parseInt(document.getElementById('cfg-ug-intake').value) || 60;
  _cfg.ugIntake  = ugIntake;
  _cfg.opdTarget = ugIntake * 2;
  _cfg.workdays  = parseInt(document.getElementById('cfg-workdays').value) || 6;
  document.getElementById('cfg-opd-target').value = _cfg.opdTarget;

  if (role !== 'super_admin') { _alert('error','Only super_admin can change settings.'); return; }

  const { error } = await supabase.from('tenants').update({
    ug_intake:             _cfg.ugIntake,
    opd_daily_target:      _cfg.opdTarget,
    working_days_per_week: _cfg.workdays,
  }).eq('id', tenantId);

  if (error) { _alert('error', safeErrorMessage(error, 'Failed to save settings.')); return; }
  _alert('success','Settings saved.');
  loadAll();
};

// ── Period ────────────────────────────────────────────────────────────────────
window.setPeriod = function(p) {
  _period = p;
  document.querySelectorAll('.period-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.period === p));
  loadAll();
};

// ── Main load ─────────────────────────────────────────────────────────────────
async function loadAll() {
  // Session 96: this whole page's metrics (OPD target from UG intake, Table-8 bed
  // ratios, Table-9 occupancy thresholds) only mean something for a teaching
  // institution — a plain hospital/pk_center/clinic tenant has no real UG intake
  // to size any of it against (found showing false "critical violations" on
  // WASA1631, a hospital-type test tenant, after only the Faculty/Staff sections
  // had been gated). Skip the compute entirely rather than patch each section.
  const naMsg = document.getElementById('ncism-not-applicable');
  const metrics = document.getElementById('ncism-metrics');
  if (!isNCISMType(_tenantType)) {
    if (naMsg) naMsg.style.display = '';
    if (metrics) metrics.style.display = 'none';
    return;
  }
  if (naMsg) naMsg.style.display = 'none';
  if (metrics) metrics.style.display = '';

  _refDate = document.getElementById('cfg-date').value || new Date().toISOString().slice(0,10);
  const { from, to } = _dateRange();
  const wdays = _workingDays(from, to);

  document.getElementById('period-range').textContent = _fmtRange(from, to);
  document.getElementById('period-label').textContent =
    { daily:'Daily', weekly:'Weekly', monthly:'Monthly', quarterly:'Quarterly' }[_period]
    + ' compliance report · ' + _fmtRange(from, to);

  const [deptRes, visitsRes, bedsRes, admRes, specOpdsRes] = await Promise.all([
    supabase.from('departments')
      .select('id,name,ncism_code,is_pg_dept,pg_seats_sanctioned,opd_id,is_active')
      .eq('tenant_id', tenantId)
      .order('is_pg_dept', { ascending: false })
      .order('name'),
    supabase.from('visits')
      .select('id,opd_id,created_at,is_teleconsultation,visit_category')
      .eq('tenant_id', tenantId)
      .gte('created_at', from + 'T00:00:00')
      .lte('created_at', to + 'T23:59:59'),
    supabase.from('beds')
      .select('id,department_id,status,is_pg_allocated,bed_type')
      .eq('tenant_id', tenantId)
      .neq('bed_type', 'observation'),   // NCISM: observation beds excluded from IPD census
    // Fetch all admissions overlapping the period for Table-9 bed day formula
    supabase.from('ipd_admissions')
      .select('id,department_id,admitted_at,discharged_at')
      .eq('tenant_id', tenantId)
      .lte('admitted_at', to + 'T23:59:59')
      .or(`discharged_at.is.null,discharged_at.gte.${from}T00:00:00`),
    // §18ak — specialty clinic OPDs (visits attributed to parent dept)
    supabase.from('opds')
      .select('id,parent_department_id')
      .eq('tenant_id', tenantId)
      .eq('is_specialty_clinic', true),
  ]);

  if (deptRes.error) { _alert('error',safeErrorMessage(deptRes.error, 'Failed to load departments.')); return; }

  const depts      = deptRes.data || [];
  const visits     = visitsRes.data || [];
  const beds       = bedsRes.data || [];

  // Build specialty OPD remap: specialty_opd_id → parent dept's opd_id
  const specialtyRemap = {};
  if (!specOpdsRes.error) {
    (specOpdsRes.data || []).forEach(s => {
      const pd = depts.find(d => d.id === s.parent_department_id);
      if (pd?.opd_id) specialtyRemap[s.id] = pd.opd_id;
    });
  }

  // Build maps — specialty OPD visits attributed to parent department's OPD
  const visitsByOpd = {};
  visits.forEach(v => {
    const effId = specialtyRemap[v.opd_id] || v.opd_id;
    visitsByOpd[effId] = (visitsByOpd[effId]||0) + 1;
  });

  // §21f — ICU beds tracked separately; excluded from general ward occupancy
  const icuBeds = beds.filter(b => b.bed_type === 'icu');
  window._icuBeds = icuBeds; // expose for renderStats
  const icuOccupied = icuBeds.filter(b => b.status === 'occupied').length;
  const regularBeds = beds.filter(b => b.bed_type !== 'icu');

  const bedsByDept = {};
  regularBeds.forEach(b => {
    if (!bedsByDept[b.department_id]) bedsByDept[b.department_id] = { total:0, pg:0, occupied:0, vacant:0 };
    const d = bedsByDept[b.department_id];
    d.total++;
    if (b.is_pg_allocated) d.pg++;
    if (b.status==='occupied') d.occupied++;
    if (b.status==='vacant')   d.vacant++;
  });

  // Table-9 bed day occupancy formula: (bed_days_occupied / (beds × days)) × 100
  // Midnight rule: same-day admission+discharge = 0.5 bed day
  const periodDays = Math.round((new Date(to+'T00:00:00') - new Date(from+'T00:00:00')) / 86400000) + 1;
  const bedDaysByDept = {};
  (admRes.data || []).forEach(a => {
    const pStart = new Date(from + 'T00:00:00');
    const pEnd   = new Date(to   + 'T23:59:59');
    const aStart = new Date(a.admitted_at);
    const aEnd   = a.discharged_at ? new Date(a.discharged_at) : pEnd;
    const start  = aStart > pStart ? aStart : pStart;
    const end    = aEnd   < pEnd   ? aEnd   : pEnd;
    if (end <= start) return;
    const admDate = a.admitted_at.slice(0,10);
    const disDate = a.discharged_at?.slice(0,10);
    const days    = (admDate === disDate && disDate) ? 0.5 : (end - start) / 86400000;
    bedDaysByDept[a.department_id] = (bedDaysByDept[a.department_id] || 0) + days;
  });

  // §21d + §21i — Institution-level OPD: exclude teleconsultation + preventive (Swasthya Rakshana) visits
  // NCISM Regulation 42 footnote: tele visits NOT counted in mandatory OPD minimum
  // NCISM Regulation 40(7): Swasthya Rakshana (preventive) visits NOT counted in OPD minimum
  const clinicalVisits = visits.filter(v =>
    !v.is_teleconsultation &&
    (v.visit_category || 'clinical') === 'clinical'
  );
  const teleVisits      = visits.filter(v => v.is_teleconsultation);
  const preventiveVisits= visits.filter(v => (v.visit_category || 'clinical') === 'preventive');
  const totalActualOpd  = clinicalVisits.length;
  // §21d — 300-day denominator: use period days but note annualized target
  const instOpdTarget  = _cfg.opdTarget * wdays;
  const instOpdPct     = instOpdTarget > 0 ? Math.round(totalActualOpd / instOpdTarget * 100) : 0;
  // Annualized projection for 300-day NCISM assessment
  const annualisedOpd  = periodDays > 0 ? Math.round(totalActualOpd / periodDays * 300) : 0;

  const rows = depts.filter(d => d.is_active).map(dept => {
    const actualOpd    = visitsByOpd[dept.opd_id] || 0;
    const deptOpdShare = totalActualOpd > 0 ? Math.round(actualOpd / totalActualOpd * 100) : 0;
    const bedInfo      = bedsByDept[dept.id] || { total:0, pg:0, occupied:0, vacant:0 };

    // NCISM Table-8 UG beds + PG beds (4 per sanctioned seat)
    const ugRequiredBeds = Math.floor(_cfg.ugIntake * (UG_BED_RATIOS[dept.ncism_code] || 0));
    const pgRequiredBeds = dept.is_pg_dept ? (dept.pg_seats_sanctioned || 0) * 4 : 0;
    const requiredBeds   = ugRequiredBeds + pgRequiredBeds;

    // NCISM Table-9 bed day occupancy (60% non-PG, 80% PG)
    const occThreshold = dept.is_pg_dept ? 80 : 60;
    const bedDays      = bedDaysByDept[dept.id] || 0;
    const occupancyPct = bedInfo.total > 0 && periodDays > 0
      ? Math.round(bedDays / (bedInfo.total * periodDays) * 100)
      : null;

    return {
      dept,
      actualOpd, deptOpdShare,
      bedInfo, bedDays, periodDays, ugRequiredBeds, pgRequiredBeds, requiredBeds,
      occThreshold, occupancyPct,
      wdays,
    };
  });

  renderStats(rows, totalActualOpd, instOpdTarget, instOpdPct, annualisedOpd, teleVisits.length, preventiveVisits.length);
  renderViolations(rows, totalActualOpd, instOpdTarget, instOpdPct);
  renderTable(rows);
  await renderFaculty(depts);
  await renderStaffCompliance();
  await renderNurseRatio(regularBeds);
}
window.loadAll = loadAll;

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(rows, totalActualOpd, instOpdTarget, instOpdPct, annualisedOpd, teleCount, preventiveCount) {
  // OPD: institution-level (NCISM checks total, not per-dept)
  // §21d: excludes tele + preventive; shows 300-day annualised projection
  const exclusionNote = (teleCount + preventiveCount) > 0
    ? ` · ${teleCount} tele + ${preventiveCount} preventive excluded`
    : '';
  _setStatCard('sc-opd', instOpdPct + '%',
    `${totalActualOpd} clinical / ${instOpdTarget} required${exclusionNote} · 300-day est: ${annualisedOpd}`,
    instOpdPct >= 90 ? 'ok' : instOpdPct >= 70 ? 'warn' : 'danger');

  // IPD occupancy: average across all depts that have beds
  const occRows = rows.filter(r => r.occupancyPct !== null);
  const avgOcc  = occRows.length
    ? Math.round(occRows.reduce((s,r) => s + r.occupancyPct, 0) / occRows.length) : 0;
  _setStatCard('sc-ipd', avgOcc + '%', `avg occupancy (min 60% non-PG, 80% PG)`,
    avgOcc >= 70 ? 'ok' : avgOcc >= 50 ? 'warn' : 'danger');

  // Beds: depts meeting total requirement
  const bedsMetRows = rows.filter(r => r.requiredBeds > 0 && r.bedInfo.total >= r.requiredBeds);
  const bedsReqRows = rows.filter(r => r.requiredBeds > 0);
  const bedsPct = bedsReqRows.length > 0
    ? Math.round(bedsMetRows.length / bedsReqRows.length * 100) : 100;
  _setStatCard('sc-beds', bedsPct + '%', `${bedsMetRows.length}/${bedsReqRows.length} depts have required beds`,
    bedsPct >= 100 ? 'ok' : bedsPct >= 75 ? 'warn' : 'danger');

  // §21f — ICU stat card (separate census per NCISM)
  // icuBeds and icuOccupied are in outer scope from the analysis
  if (document.getElementById('sc-icu')) {
    const icuTotal = (window._icuBeds || []).length;
    const icuOcc   = (window._icuBeds || []).filter(b => b.status === 'occupied').length;
    _setStatCard('sc-icu', icuTotal,
      `${icuOcc} occupied · separate from ward census`,
      icuTotal >= 5 ? 'ok' : icuTotal > 0 ? 'warn' : 'danger');
  }

  // Violations count
  const violations = _buildViolations(rows, totalActualOpd, instOpdTarget, instOpdPct);
  _setStatCard('sc-alerts', violations.length, violations.length === 0 ? 'No violations' : 'need attention',
    violations.length === 0 ? 'ok' : violations.filter(v => v.severity === 'critical').length > 0 ? 'danger' : 'warn');
}

function _setStatCard(id, val, sub, cls) {
  const card = document.getElementById(id);
  card.className = `stat-card ${cls}`;
  document.getElementById(id+'-val').textContent = val;
  document.getElementById(id+'-sub').textContent = sub;
}

// ── Violations ────────────────────────────────────────────────────────────────
function _buildViolations(rows, totalActualOpd, instOpdTarget, instOpdPct) {
  const v = [];

  // Institution OPD (NCISM 1:2 ratio)
  if (instOpdPct < 70)
    v.push({ dept:'Institution (OPD)', severity:'critical',
      msg:`OPD critically low: ${totalActualOpd} actual / ${instOpdTarget} required for period (${instOpdPct}%)` });
  else if (instOpdPct < 100)
    v.push({ dept:'Institution (OPD)', severity:'warning',
      msg:`OPD below target: ${totalActualOpd} actual / ${instOpdTarget} required for period (${instOpdPct}%)` });

  // Department-level bed and occupancy
  rows.forEach(r => {
    const name = r.dept.name;
    if (r.requiredBeds > 0 && r.bedInfo.total === 0) {
      v.push({ dept:name, severity:'critical',
        msg:`No beds configured. ${r.requiredBeds} required (UG: ${r.ugRequiredBeds}, PG: ${r.pgRequiredBeds}). Go to IPD Setup.` });
    } else if (r.requiredBeds > 0 && r.bedInfo.total < r.requiredBeds) {
      v.push({ dept:name, severity:'critical',
        msg:`Beds insufficient: ${r.bedInfo.total} allocated / ${r.requiredBeds} required (UG: ${r.ugRequiredBeds} + PG: ${r.pgRequiredBeds})` });
    }
    if (r.occupancyPct !== null && r.occupancyPct < r.occThreshold) {
      v.push({ dept:name, severity: r.occupancyPct < Math.round(r.occThreshold * 0.75) ? 'critical' : 'warning',
        msg:`IPD occupancy ${r.occupancyPct}% — below NCISM ${r.occThreshold}% threshold (${r.bedDays.toFixed(1)} bed-days / ${r.bedInfo.total} beds × ${r.periodDays} days)` });
    }
  });
  return v;
}

function renderViolations(rows, totalActualOpd, instOpdTarget, instOpdPct) {
  const violations = _buildViolations(rows, totalActualOpd, instOpdTarget, instOpdPct);
  const grid = document.getElementById('violations-grid');

  if (!violations.length) {
    grid.innerHTML = '<div class="no-violations">&#10003; All NCISM compliance thresholds are met for this period.</div>';
    return;
  }

  grid.innerHTML = violations.map(v => `
    <div class="violation-card ${v.severity}">
      <div class="violation-icon">${v.severity === 'critical' ? '&#9940;' : '&#9888;'}</div>
      <div class="violation-body">
        <div class="violation-dept">${_esc(v.dept)}</div>
        <div class="violation-msg">${_esc(v.msg)}</div>
      </div>
      <div style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;flex-shrink:0;
        background:${v.severity==='critical'?'var(--red)':'var(--gold)'};color:#fff">
        ${v.severity.toUpperCase()}
      </div>
    </div>
  `).join('');
}

// ── Table ─────────────────────────────────────────────────────────────────────
function renderTable(rows) {
  const tbody     = document.getElementById('ct-body');
  const pgRows    = rows.filter(r => r.dept.is_pg_dept);
  const nonPgRows = rows.filter(r => !r.dept.is_pg_dept);

  let html = '';

  if (pgRows.length) {
    html += `<tr class="section-head"><td colspan="10">PG Departments (${pgRows.length}) — NCISM Compliance Tracked</td></tr>`;
    pgRows.forEach(r => { html += _row(r); });
  }

  if (_showNonPg && nonPgRows.length) {
    html += `<tr class="section-head"><td colspan="10">Non-PG Departments (${nonPgRows.length}) — Patient volume only</td></tr>`;
    nonPgRows.forEach(r => { html += _row(r); });
  } else if (!_showNonPg && nonPgRows.length) {
    html += `<tr><td colspan="10" style="text-align:center;padding:12px;font-size:12px;color:var(--text-muted)">
      + ${nonPgRows.length} non-PG department(s) hidden.
      <span class="toggle-non-pg no-print" data-onclick="toggleNonPg">Show</span>
    </td></tr>`;
  }

  tbody.innerHTML = html || '<tr><td colspan="10" style="text-align:center;padding:40px;color:var(--text-muted)">No departments configured. Go to IPD Setup.</td></tr>';
}

function _row(r) {
  const { dept, actualOpd, deptOpdShare, bedInfo, ugRequiredBeds, pgRequiredBeds, requiredBeds, occupancyPct, occThreshold } = r;

  // OPD
  const opdShareCell = `<span style="font-size:11px;color:var(--text-muted)">${deptOpdShare}%</span>`;

  // Beds
  const bedsReqCell = requiredBeds > 0
    ? `<span title="UG: ${ugRequiredBeds} + PG: ${pgRequiredBeds}">${requiredBeds}</span>`
    : '<span style="color:var(--text-muted)">—</span>';
  const bedsChip = requiredBeds > 0
    ? (bedInfo.total >= requiredBeds
        ? _chip('ok', `${bedInfo.total}/${requiredBeds} ✓`)
        : _chip('danger', `${bedInfo.total}/${requiredBeds}`))
    : '<span class="chip na">—</span>';

  // Occupancy with correct threshold per dept type
  const occCell = occupancyPct !== null
    ? _prog(occupancyPct, occThreshold)
    : '<span class="chip na">No beds</span>';

  // Overall
  let overallCls = 'ok';
  if (requiredBeds > 0 && bedInfo.total < requiredBeds) {
    overallCls = 'danger';
  } else if (occupancyPct !== null && occupancyPct < occThreshold) {
    overallCls = occupancyPct < Math.round(occThreshold * 0.75) ? 'danger' : 'warn';
  }

  return `<tr>
    <td>
      <div class="dept-name">${_esc(dept.name)}</div>
      ${dept.ncism_code ? `<span class="ncism-tag">${dept.ncism_code}</span>` : ''}
    </td>
    <td class="num">${dept.pg_seats_sanctioned || '<span style="color:var(--text-muted)">—</span>'}</td>
    <td class="num" style="border-left:2px solid var(--border)">${actualOpd}</td>
    <td class="muted">${opdShareCell}</td>
    <td class="num" style="border-left:2px solid var(--border)">${bedsReqCell}</td>
    <td class="num">${bedInfo.total || '<span style="color:var(--text-muted)">0</span>'}</td>
    <td class="num">${bedInfo.pg || '<span style="color:var(--text-muted)">0</span>'}</td>
    <td class="num">${bedsChip}</td>
    <td style="min-width:120px">${occCell}</td>
    <td class="num">${_chip(overallCls, overallCls==='ok'?'✓ Compliant':overallCls==='warn'?'⚠ Review':'✗ Violation')}</td>
  </tr>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _prog(pct, threshold = 100) {
  const capped = Math.min(pct, 100);
  const cls = pct >= threshold ? 'ok' : pct >= threshold * .7 ? 'warn' : 'danger';
  return `<div class="prog-wrap">
    <div class="prog-bar"><div class="prog-fill ${cls}" style="width:${capped}%"></div></div>
    <div class="prog-pct ${cls}">${pct}%</div>
  </div>`;
}

function _chip(cls, label) {
  return `<span class="chip ${cls}">${label}</span>`;
}

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _alert(type, msg) {
  const el = document.getElementById('alert');
  el.className = `alert show ${type}`;
  el.textContent = msg;
  if (type === 'success') setTimeout(() => el.classList.remove('show'), 3000);
}

// ── Faculty compliance — NCISM Schedule IV (Regulation 34) ───────────────────
// Real per-department minimum teaching staff, transcribed from the official NCISM
// Approval Process Handbook, Schedule IV (p.56) and cross-checked column-by-column
// against the schedule's own Sub-total/Grand-total rows (60:36, 100:51, 150:70,
// 200:90 — every column of all 4 tiers reconciles exactly) — Session 96.
// The previous implementation collapsed all 14 departments into 3 uniform buckets
// (clinical/para-clinical/pre-clinical) with one number per bucket, which does not
// match the regulation: e.g. at 100 intake Agad Tantra needs only 3 total (the old
// code said 5, having bucketed it as "clinical"), while Samhita Siddhanta & Sanskrit
// needs 5 despite being pre-clinical. Found live on SDM Ayurveda Hospital (real
// teaching_hospital tenant) showing 68 minimum required against a real total of 51.
// 60-intake note: Schedule IV's own column layout differs here — a single flexible
// "Professor or Associate Professor" senior post (represented below as prof:1,
// assoc:0) plus a separate Assistant Professor count, NOT 3 distinct columns like
// the other tiers — EXCEPT Kayachikitsa, confirmed by Dr. Venkatesh and by the
// column checksum (15 across 14 depts only resolves if one dept counts twice) to
// require a Professor AND an Associate Professor both mandatorily.
const SCHEDULE_IV = {
  SS:   { 60:{prof:1,assoc:0,asst:3}, 100:{prof:1,assoc:1,asst:3}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  RS:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  KS:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  DG:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  RBK:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  RNV:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  AGD:  { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:1,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  SW:   { 60:{prof:1,assoc:0,asst:1}, 100:{prof:1,assoc:1,asst:1}, 150:{prof:1,assoc:2,asst:2}, 200:{prof:2,assoc:2,asst:2} },
  KAY:  { 60:{prof:1,assoc:1,asst:1}, 100:{prof:1,assoc:2,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  PK:   { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:2}, 200:{prof:2,assoc:2,asst:3} },
  SHAL: { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  SHAK: { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  PST:  { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:3} },
  KAU:  { 60:{prof:1,assoc:0,asst:2}, 100:{prof:1,assoc:1,asst:2}, 150:{prof:1,assoc:2,asst:3}, 200:{prof:2,assoc:2,asst:2} },
};

function _closestIntake(ug) {
  const keys = [60, 100, 150, 200];
  return keys.reduce((a, b) => Math.abs(b - ug) < Math.abs(a - ug) ? b : a);
}

async function renderFaculty(depts) {
  const section = document.getElementById('faculty-section');
  if (!section) return;

  if (!isNCISMType(_tenantType)) { section.style.display = 'none'; return; }
  section.style.display = '';

  const intake    = _cfg.ugIntake || 60;
  const intakeKey = _closestIntake(intake);
  document.getElementById('faculty-intake-label').textContent = `UG Intake: ${intake}`;

  // Query current faculty count — total doctors in tenant (no dept breakdown yet)
  const { data: staffRows } = await supabase
    .from('profiles')
    .select('id,role')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .in('role', ['doctor','dept_admin']);

  const totalActual = (staffRows || []).length;

  // Calculate required totals across all depts — only real Schedule IV teaching
  // departments have an entry (excludes GENERAL/SCREENING_OPD and any facility/ops
  // department that never gets a real academic ncism_code).
  let totalReq = 0;
  const deptRows = depts
    .map(d => ({ d, code: String(d.ncism_code || '').toUpperCase(), typeKey: _academicType(d.ncism_code) }))
    .filter(({ code }) => SCHEDULE_IV[code])
    .map(({ d, code, typeKey }) => {
      const req = SCHEDULE_IV[code][intakeKey] || { prof:0, assoc:0, asst:0 };
      const minTotal = req.prof + req.assoc + req.asst;
      totalReq += minTotal;
      return { d, typeKey, req, minTotal };
    });

  // Summary stat cards
  const diff   = totalActual - totalReq;
  const pct    = totalReq > 0 ? Math.round(totalActual / totalReq * 100) : 100;
  const sCls   = pct >= 100 ? 'ok' : pct >= 80 ? 'warn' : 'danger';
  document.getElementById('faculty-stats').innerHTML = `
    <div class="fstat ${sCls}">
      <div class="fstat-val">${totalActual}</div>
      <div class="fstat-lbl">Faculty on Record</div>
    </div>
    <div class="fstat ${sCls}">
      <div class="fstat-val">${totalReq}</div>
      <div class="fstat-lbl">NCISM Minimum Required</div>
    </div>
    <div class="fstat ${diff >= 0 ? 'ok' : 'danger'}">
      <div class="fstat-val">${diff >= 0 ? '+'+diff : diff}</div>
      <div class="fstat-lbl">${diff >= 0 ? 'Surplus' : 'Shortfall'}</div>
    </div>
    <div class="fstat ${sCls}">
      <div class="fstat-val">${pct}%</div>
      <div class="fstat-lbl">Faculty Strength %</div>
    </div>`;

  // Per-department table
  const TYPE_LABEL = { clinical:'Clinical', para_clinical:'Para-clinical', pre_clinical:'Pre-clinical' };
  document.getElementById('faculty-tbody').innerHTML = deptRows.map(({ d, typeKey, req, minTotal }) => {
    const cls = pct >= 100 ? 'ok' : pct >= 80 ? 'warn' : 'danger';
    const statusLabel = pct >= 100 ? '✓' : '✗';
    return `<tr>
      <td><strong>${_esc(d.name)}</strong><br>
        <span style="font-size:10px;color:var(--text-muted)">${_esc(d.ncism_code||'')}</span></td>
      <td class="center"><span style="font-size:10px;background:#f0f0f0;padding:2px 6px;border-radius:4px">${_esc(TYPE_LABEL[typeKey]||'—')}</span></td>
      <td class="center">${req.prof}</td>
      <td class="center">${req.assoc}</td>
      <td class="center">${req.asst}</td>
      <td class="center"><strong>${minTotal}</strong></td>
      <td class="center" style="color:var(--text-muted);font-style:italic">—<br><span style="font-size:9px">Run SQL</span></td>
      <td class="center"><span class="${cls}">${statusLabel} Est.</span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">No departments configured</td></tr>`;
}

// ── Staff compliance — NCISM Schedule XX ─────────────────────────────────────
// Source: NCISM Schedule XX (image verified 29 May 2026)
const SCHEDULE_XX = [
  // ── Administrative Zone ──────────────────────────────────────────────────
  {zone:'Administrative', designation:'Medical Director / Principal / Dean',           role:'super_admin',  ncism:'Sch XX / 1',  req:{60:1,100:1,150:1,200:1}},
  {zone:'Administrative', designation:'Medical Superintendent',                        role:'dept_admin',   ncism:'Sch XX / 2',  req:{60:1,100:1,150:1,200:1}},
  {zone:'Administrative', designation:'Deputy Medical Superintendent',                 role:'dept_admin',   ncism:'Sch XX / 3',  req:{60:1,100:1,150:2,200:2}},
  {zone:'Administrative', designation:'Administrator',                                 role:'dept_admin',   ncism:'Sch XX / 4',  req:{60:1,100:1,150:2,200:2}},
  {zone:'Administrative', designation:'RMO / Emergency Medical Officer (24×7)',        role:'doctor',       ncism:'Sch XX / 6',  req:{60:2,100:3,150:4,200:5}},
  {zone:'Administrative', designation:'Matron / Nursing Superintendent',               role:'nurse',        ncism:'Sch XX / 7',  req:{60:1,100:1,150:1,200:1}},
  {zone:'Administrative', designation:'Assistant Matron (day + night shifts)',         role:'nurse',        ncism:'Sch XX / 8',  req:{60:2,100:3,150:4,200:5}},
  {zone:'Administrative', designation:'Office Superintendent',                         role:'dept_admin',   ncism:'Sch XX / 9',  req:{60:1,100:1,150:1,200:1}},
  {zone:'Administrative', designation:'Clerks and Accountants',                        role:'accountant',   ncism:'Sch XX / 10', req:{60:1,100:2,150:3,200:4}},
  {zone:'Administrative', designation:'Store Keeper',                                  role:'accountant',   ncism:'Sch XX / 11', req:{60:1,100:1,150:1,200:1}},
  {zone:'Administrative', designation:'Multi-tasking Staff (Admin)',                   role:'receptionist', ncism:'Sch XX / 12', req:{60:3,100:3,150:4,200:4}},
  // ── Reception and Registration ───────────────────────────────────────────
  {zone:'Reception',      designation:'Receptionist cum telephone operator (all shifts; min 1/shift)', role:'receptionist', ncism:'Sch XX / 16', req:{60:3,100:4,150:4,200:4}},
  {zone:'Reception',      designation:'Registration and Billing Clerks',               role:'receptionist', ncism:'Sch XX / 17', req:{60:1,100:2,150:3,200:4}},
  {zone:'Reception',      designation:'Medical Record Technician (qualified/trained)', role:'receptionist', ncism:'Sch XX / 18', req:{60:1,100:1,150:1,200:1}},
  // ── OPD Zone ────────────────────────────────────────────────────────────
  {zone:'OPD',            designation:'Nursing Staff OPD (Atyayika + Shalya + Prasuti)', role:'nurse',     ncism:'Sch XX / 20', req:{60:3,100:3,150:3,200:5}, note:'1 each for Atyayika, Shalya, Prasuti/Streeroga'},
  {zone:'OPD',            designation:'Ayah — OPD',                                   role:'nurse',        ncism:'Sch XX / 21', req:{60:3,100:3,150:3,200:5}},
  // ── Dispensary ──────────────────────────────────────────────────────────
  {zone:'Dispensary',     designation:'Pharmacist (qualified Ayurveda / trained)',     role:'pharmacist',   ncism:'Sch XX / 22', req:{60:2,100:2,150:3,200:4}},
  {zone:'Dispensary',     designation:'Dispensary In-charge (BAMS / BPharma / MPharma)', role:'pharmacist', ncism:'Sch XX / 23', req:{60:1,100:1,150:1,200:1}},
  // ── Diagnostic Zone ─────────────────────────────────────────────────────
  {zone:'Diagnostic',     designation:'Lab Technician (DMLT)',                         role:'lab_tech',     ncism:'Sch XX / 24', req:{60:2,100:2,150:3,200:4}},
  {zone:'Diagnostic',     designation:'Lab Attendant (min 10th std)',                  role:'lab_tech',     ncism:'Sch XX / 25', req:{60:1,100:1,150:2,200:3}},
  {zone:'Diagnostic',     designation:'X-ray Technician (qualified)',                  role:'lab_tech',     ncism:'Sch XX / 26', req:{60:1,100:1,150:1,200:1}},
  {zone:'Diagnostic',     designation:'Dark Room Assistant (non-digital x-ray)',       role:'lab_tech',     ncism:'Sch XX / 27', req:{60:1,100:1,150:1,200:1}},
  {zone:'Diagnostic',     designation:'ECG Technician',                                role:'lab_tech',     ncism:'Sch XX / 28', req:{60:1,100:1,150:2,200:2}},
  {zone:'Diagnostic',     designation:'Nursing Staff for USG / ECG',                  role:'nurse',        ncism:'Sch XX / 29', req:{60:1,100:1,150:1,200:1}},
  {zone:'Diagnostic',     designation:'Microbiologist (MSc Microbiology)',             role:'lab_tech',     ncism:'Sch XX / 30', req:{60:1,100:1,150:1,200:1}},
  {zone:'Diagnostic',     designation:'Lab Assistant for Microbiology',               role:'lab_tech',     ncism:'Sch XX / 31', req:{60:1,100:1,150:2,200:2}},
  // ── Medical IPD ─────────────────────────────────────────────────────────
  {zone:'Medical IPD',    designation:'Nursing Staff — Medical IPD (1 per 10 beds)',   role:'nurse',        ncism:'Sch XX / 32', req:{60:4,100:6,150:9,200:12}},
  {zone:'Medical IPD',    designation:'Ayah — Medical IPD (1 per 20 beds)',            role:'nurse',        ncism:'Sch XX / 33', req:{60:2,100:3,150:5,200:6}},
  {zone:'Medical IPD',    designation:'Resident MO Medical (1/30 beds, day+night)',    role:'doctor',       ncism:'Sch XX / 34', req:{60:2,100:2,150:2,200:2}},
  // ── Surgical IPD ────────────────────────────────────────────────────────
  {zone:'Surgical IPD',   designation:'Nursing Staff — Surgical IPD (1 per 10 beds)', role:'nurse',        ncism:'Sch XX / 35', req:{60:3,100:4,150:6,200:8}},
  {zone:'Surgical IPD',   designation:'Ayah — Surgical IPD (1 per 20 beds)',           role:'nurse',        ncism:'Sch XX / 36', req:{60:2,100:2,150:3,200:4}},
  {zone:'Surgical IPD',   designation:'Resident Surgical Officer (1/30 beds, day+night)', role:'doctor',   ncism:'Sch XX / 37', req:{60:2,100:2,150:2,200:2}},
  // ── Panchakarma ─────────────────────────────────────────────────────────
  {zone:'Panchakarma',    designation:'PK Nursing Staff',                              role:'nurse',        ncism:'Sch XX / 38', req:{60:1,100:1,150:2,200:2}},
  {zone:'Panchakarma',    designation:'PK Cook (preparation room)',                    role:'nurse',        ncism:'Sch XX / 39', req:{60:1,100:1,150:2,200:2}},
  {zone:'Panchakarma',    designation:'PK Therapists — Male + Female (equal)',         role:'therapist',    ncism:'Sch XX / 40', req:{60:4,100:8,150:12,200:16}},
  {zone:'Panchakarma',    designation:'House Officer / Clinical Registrar (BAMS)',     role:'doctor',       ncism:'Sch XX / 41', req:{60:1,100:1,150:1,200:1}},
  {zone:'Panchakarma',    designation:'Clerk cum Receptionist',                        role:'receptionist', ncism:'Sch XX / 42', req:{60:1,100:1,150:1,200:1}},
  // ── Operation Theatre ───────────────────────────────────────────────────
  {zone:'Operation Theatre', designation:'OT Nursing Staff',                           role:'nurse',        ncism:'Sch XX / 43', req:{60:1,100:2,150:3,200:4}},
  {zone:'Operation Theatre', designation:'OT Attendants',                              role:'nurse',        ncism:'Sch XX / 44', req:{60:2,100:3,150:4,200:5}},
  {zone:'Operation Theatre', designation:'Anushastra Karma Technician (12th + Biology)', role:'nurse',     ncism:'Sch XX / 45', req:{60:1,100:1,150:2,200:2}},
  // ── Labour Room ─────────────────────────────────────────────────────────
  {zone:'Labour Room',    designation:'Nursing Staff — Labour Room (3 shifts)',        role:'nurse',        ncism:'Sch XX / 46', req:{60:1,100:3,150:6,200:6}},
  {zone:'Labour Room',    designation:'Ayah — Labour Room (1 per shift)',              role:'nurse',        ncism:'Sch XX / 47', req:{60:3,100:3,150:3,200:3}},
  // ── Kriyakalpa ──────────────────────────────────────────────────────────
  {zone:'Kriyakalpa',     designation:'Kriyakalpa Therapists',                         role:'therapist',    ncism:'Sch XX / 48', req:{60:2,100:2,150:4,200:4}},
  // ── Physiotherapy ───────────────────────────────────────────────────────
  {zone:'Physiotherapy',  designation:'Physiotherapist',                               role:'therapist',    ncism:'Sch XX / 49', req:{60:1,100:1,150:1,200:1}},
  {zone:'Physiotherapy',  designation:'Attendant / Ayah',                              role:'nurse',        ncism:'Sch XX / 50', req:{60:1,100:1,150:1,200:1}},
  // ── Yoga ────────────────────────────────────────────────────────────────
  {zone:'Yoga',           designation:'Yoga Demonstrator',                             role:'therapist',    ncism:'Sch XX / 51', req:{60:1,100:1,150:1,200:1}},
  // ── Services — Diet Section ─────────────────────────────────────────────
  {zone:'Diet / Pathya',  designation:'In-charge (BAMS / MSc Ayurveda Dietetics)',     role:'doctor',       ncism:'Sch XX / 52', req:{60:1,100:1,150:1,200:1}},
  {zone:'Diet / Pathya',  designation:'Pathya Cooks',                                  role:'nurse',        ncism:'Sch XX / 53', req:{60:2,100:2,150:3,200:4}},
  {zone:'Diet / Pathya',  designation:'Multi-tasking Staff (Diet)',                    role:'nurse',        ncism:'Sch XX / 54', req:{60:2,100:2,150:3,200:4}},
  // ── Central Sterilization ───────────────────────────────────────────────
  {zone:'Central Sterilization', designation:'Nursing Staff',                          role:'nurse',        ncism:'Sch XX / CS1', req:{60:1,100:1,150:1,200:1}},
  {zone:'Central Sterilization', designation:'Ayah',                                   role:'nurse',        ncism:'Sch XX / CS2', req:{60:1,100:1,150:1,200:1}},
];

// §21g — Nurse-to-Bed Ratio Compliance (NCISM Schedule XX)
async function renderNurseRatio(regularBeds) {
  const panel = document.getElementById('nurse-ratio-panel');
  const body  = document.getElementById('nurse-ratio-body');
  if (!panel || !body) return;

  const totalBeds = regularBeds.length;
  if (totalBeds === 0) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  // Count active nurses
  const { data: nurses } = await supabase
    .from('profiles')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('role', 'nurse')
    .eq('is_active', true);
  const activeNurses = nurses?.length || 0;

  const requiredNurses = Math.ceil(totalBeds / 10);  // 1:10 ratio
  const shortfall = Math.max(0, requiredNurses - activeNurses);
  const status = shortfall === 0 ? 'ok' : shortfall <= 2 ? 'warn' : 'deficit';
  const statusColor = status === 'ok' ? '#2d7a4f' : status === 'warn' ? '#c9902a' : '#dc2626';

  body.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap">
      <div><span style="font-weight:600;font-size:18px;color:${statusColor}">${activeNurses}</span>
        <span style="font-size:12px;color:var(--text-muted)"> active nurses</span></div>
      <div><span style="font-weight:600;font-size:18px;color:var(--green-deep)">${requiredNurses}</span>
        <span style="font-size:12px;color:var(--text-muted)"> required (1:10 for ${totalBeds} beds)</span></div>
      ${shortfall > 0
        ? `<div style="padding:4px 12px;background:#fdecea;border-radius:6px;color:#8b1a1a;font-weight:600;font-size:12px">⚠ ${shortfall} nurse shortfall</div>`
        : `<div style="padding:4px 12px;background:#e8f5ee;border-radius:6px;color:#1a4a2e;font-weight:600;font-size:12px">✓ Compliant</div>`}
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Note: ICU beds (${(window._icuBeds||[]).length}) excluded — ICU nursing ratio is 1:3 (NCISM Sch XX row 36), assessed separately.</div>`;
}

async function renderStaffCompliance() {
  const section = document.getElementById('staff-section');
  if (!section) return;
  if (!isNCISMType(_tenantType)) { section.style.display = 'none'; return; }
  section.style.display = '';

  const intake    = _cfg.ugIntake || 60;
  const intakeKey = _closestIntake(intake);
  document.getElementById('staff-intake-label').textContent = `UG Intake: ${intake}`;

  // Fetch actual staff counts by role
  const { data: profiles } = await supabase
    .from('profiles')
    .select('role')
    .eq('tenant_id', tenantId)
    .eq('is_active', true);

  const roleCounts = {};
  (profiles || []).forEach(p => { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; });

  // Build rows
  let totalReq = 0, totalMet = 0;
  const rows = SCHEDULE_XX.map(item => {
    const req    = item.req[intakeKey] || 0;
    const actual = roleCounts[item.role] || 0;
    const met    = actual >= req;
    if (req > 0) { totalReq++; if (met) totalMet++; }
    return { ...item, req, actual, met };
  });

  // Summary stat cards
  const pct = totalReq > 0 ? Math.round(totalMet / totalReq * 100) : 100;
  const sCls = pct >= 100 ? 'ok' : pct >= 75 ? 'warn' : 'danger';
  const totalRequired = rows.reduce((s,r) => s + r.req, 0);
  const totalActual   = Object.values(roleCounts).reduce((s,v) => s + v, 0);
  document.getElementById('staff-stats').innerHTML = `
    <div class="fstat ${sCls}">
      <div class="fstat-val">${totalActual}</div>
      <div class="fstat-lbl">Total Staff on Record</div>
    </div>
    <div class="fstat">
      <div class="fstat-val">${totalRequired}</div>
      <div class="fstat-lbl">Total Required (Sch XX)</div>
    </div>
    <div class="fstat ${pct >= 100 ? 'ok' : 'danger'}">
      <div class="fstat-val">${totalMet}/${totalReq}</div>
      <div class="fstat-lbl">Role Categories Met</div>
    </div>
    <div class="fstat ${sCls}">
      <div class="fstat-val">${pct}%</div>
      <div class="fstat-lbl">Staffing Compliance</div>
    </div>`;

  // Zone group rows
  let lastZone = '';
  document.getElementById('staff-tbody').innerHTML = rows.map(r => {
    const zoneHeader = r.zone !== lastZone
      ? `<tr style="background:#f0fdf4"><td colspan="6" style="font-weight:700;font-size:11px;color:#166534;padding:6px 10px;text-transform:uppercase;letter-spacing:.5px">${_esc(r.zone)}</td></tr>`
      : '';
    lastZone = r.zone;
    const cls    = r.met ? 'ok' : r.actual > 0 ? 'warn' : 'danger';
    const status = r.met ? '✓ Met'
                 : r.actual > 0 ? `⚠ ${r.req - r.actual} short`
                 : '✗ None';
    const noteCell = r.note ? `<br><span style="font-size:10px;color:var(--text-muted)">${_esc(r.note)}</span>` : '';
    return zoneHeader + `<tr>
      <td></td>
      <td>${_esc(r.designation)}${noteCell}</td>
      <td class="center"><strong>${r.req}</strong></td>
      <td class="center"><span style="font-size:10px;background:#f0f0f0;padding:2px 6px;border-radius:4px">${_esc(r.role)}</span></td>
      <td class="center">${r.actual}</td>
      <td class="center"><span class="${cls}">${status}</span></td>
    </tr>`;
  }).join('');
}

// ── Toggle non-PG ─────────────────────────────────────────────────────────────
window.toggleNonPg = function() {
  _showNonPg = !_showNonPg;
  document.getElementById('toggle-non-pg').textContent =
    _showNonPg ? 'Hide non-PG departments' : 'Show non-PG departments';
  loadAll();
};

// ── CSV Export ────────────────────────────────────────────────────────────────
window.exportCSV = function() {
  const rows = document.querySelectorAll('#ct tbody tr:not(.section-head)');
  const headers = ['Department','NCISM Code','PG Seats','OPD Actual','OPD % of Inst','Beds Required','Total Beds','PG Beds','Occupancy %','Status'];
  const lines = [headers.join(',')];
  rows.forEach(r => {
    const cells = r.querySelectorAll('td');
    if (cells.length < 10) return;
    const deptName = cells[0].querySelector('.dept-name')?.textContent.trim() || '';
    const ncism    = cells[0].querySelector('.ncism-tag')?.textContent.trim() || '';
    const rest = [1,2,3,4,5,6,7,8,9].map(i => cells[i]?.textContent.trim() || '');
    lines.push([deptName, ncism, ...rest].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ncism-compliance-${_period}-${_refDate}.csv`;
  a.click();
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.getElementById('cfg-ug-intake').addEventListener('input', function() {
  document.getElementById('cfg-opd-target').value = (parseInt(this.value) || 60) * 2;
});
document.getElementById('cfg-date').value = _refDate;
await loadConfig();
await loadAll();
