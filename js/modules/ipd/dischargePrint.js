// Discharge Summary print layout -- shared by ipd.html (ipd.js) and doctor.html's ward
// round view (dischargeSummary.js), so the two can never print different documents.
// Moved out of ipd.js unchanged in Session 298 (doctor IPD part 4), plus four new
// sections (course in hospital, treatment given, investigations, discharge advice)
// written by sign_ipd_discharge_summary().

// Session 262 -- Samsarjana Krama home-care chart, for a patient advised to do their
// post-Virechana graded diet at home (location_mode='home', Session 257) rather than the
// hospital kitchen handling it via palha_diet_indents (Session 261). A dish NAME means
// nothing to a family without dietetics training -- this pulls the day-by-day schedule
// AND the recipe for whichever stages actually fall on a home day, straight from the
// same classical reference table the kitchen queue already uses.
export async function fetchSamsarjanaHomeChart(supabase, admId) {
  const { data: plans } = await supabase
    .from('pk_care_plans')
    .select(`
      id,
      pk_care_plan_protocols(
        id,
        pk_care_plan_days(id, day_number, planned_date, activity_label, location_mode),
        pk_virechana_assessment(confirmed_shuddhi_level)
      )
    `)
    .eq('ipd_admission_id', admId);

  for (const plan of (plans || [])) {
    for (const pr of (plan.pk_care_plan_protocols || [])) {
      // pk_virechana_assessment has no unique constraint on protocol_instance_id alone,
      // so PostgREST embeds it as an array here.
      const grade = pr.pk_virechana_assessment?.[0]?.confirmed_shuddhi_level;
      if (!grade || !['pravara', 'madhyama', 'avara'].includes(grade)) continue;

      const allDays = (pr.pk_care_plan_days || [])
        .filter(d => d.activity_label === 'Samsarjana Krama (graded diet)')
        .sort((a, b) => a.day_number - b.day_number)
        .map((d, i) => ({ ...d, day_offset: i + 1 }));
      const homeDays = allDays.filter(d => d.location_mode === 'home');
      if (!homeDays.length) continue;

      const { data: stages } = await supabase
        .from('samsarjana_krama_stages')
        .select('day_offset, meal_slot, stage_key, stage_label, preparation_name, preparation_method, requires_kitchen_indent')
        .eq('grade', grade);

      const stageAt = (offset, slot) => (stages || []).find(s => s.day_offset === offset && s.meal_slot === slot && s.requires_kitchen_indent);
      const chartDays = homeDays.map(d => ({
        day_offset: d.day_offset, planned_date: d.planned_date,
        morning: stageAt(d.day_offset, 'morning') || null,
        evening: stageAt(d.day_offset, 'evening') || null,
      }));

      const recipes = new Map();
      chartDays.forEach(d => { [d.morning, d.evening].forEach(s => { if (s) recipes.set(s.stage_key, s); }); });

      return { grade, days: chartDays, recipes: [...recipes.values()] };
    }
  }
  return null;
}

const _daysSince = ts => ts ? Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)) : 0;

const _block = (esc, label, text) => text ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">${label}</div>
    <div style="font-size:12px;white-space:pre-wrap">${esc(text)}</div>
  </div>` : '';

// adm: ipd_admissions row with patients/beds/departments/profiles embeds (profiles = the
// admitting doctor). tenant: sessionStorage ayurxpert_tenant. esc: HTML escaper.
export function buildDischargeSummaryHtml({ adm, admId, tenant, homeChart, esc, signerName }) {
  const pt   = adm.patients || {};
  const bed  = adm.beds || {};
  const dept = adm.departments || {};
  const doc  = adm.profiles || {};

  const admDate = adm.admission_date
    ? new Date(adm.admission_date + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : '—';
  const disDate = adm.discharged_at
    ? new Date(adm.discharged_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
  const los = _daysSince(adm.admitted_at) || '—';
  const statusLabel = { discharged: 'Discharged', lama: 'LAMA (Left Against Medical Advice)', transferred: 'Transferred', deceased: 'Deceased' }[adm.status]
    || { discharged: 'Discharged', lama: 'LAMA (Left Against Medical Advice)', transferred: 'Transferred', deceased: 'Deceased' }[adm.disposition]
    || adm.status;

  return `
<div style="font-family:'DM Sans',sans-serif;max-width:680px;margin:0 auto;color:#1c2b1f">
  <div style="text-align:center;padding:14px 0 10px;border-bottom:3px double #1a4a2e">
    <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;color:#1a4a2e">${esc(tenant.name || 'Ayurveda Hospital')}</div>
    <div style="font-size:11px;color:#6a8070;margin-top:2px">${esc(tenant.city || '')} ${esc(tenant.state || '')}</div>
  </div>
  <div style="text-align:center;padding:10px;background:#f5fbf8;border-bottom:1px solid #c8ddd0">
    <div style="font-size:16px;font-weight:700;letter-spacing:2px;color:#1a4a2e;text-transform:uppercase">DISCHARGE SUMMARY</div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #c8ddd0;border-top:none">
    <div style="padding:12px 16px;border-right:1px solid #c8ddd0">
      <div style="font-size:18px;font-weight:600;color:#1a4a2e">${esc(pt.name || '—')}</div>
      <div style="font-size:12px;color:#4a6352;margin-top:3px;display:flex;flex-wrap:wrap;gap:10px">
        ${pt.age || pt.gender ? `<span>${esc([pt.age ? pt.age + 'y' : '', pt.gender].filter(Boolean).join(' · '))}</span>` : ''}
        ${pt.phone ? `<span>Ph: ${esc(pt.phone)}</span>` : ''}
        ${pt.abha_number ? `<span>ABHA: ${esc(pt.abha_number)}</span>` : ''}
      </div>
    </div>
    <div style="padding:12px 16px;font-size:12px;color:#4a6352">
      <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px">
        <span style="font-weight:600">IPD No:</span><span>${esc(String(admId).slice(0, 8).toUpperCase())}</span>
        <span style="font-weight:600">Ward / Bed:</span><span>${esc(bed.ward_name || dept.name || '—')} / Bed ${esc(bed.bed_number || '—')}</span>
        <span style="font-weight:600">Doctor:</span><span>${esc(doc.full_name || '—')}</span>
        <span style="font-weight:600">Department:</span><span>${esc(dept.name || '—')}</span>
      </div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #c8ddd0;border-top:none;font-size:12px">
    <div style="padding:8px 14px;border-right:1px solid #c8ddd0"><span style="font-weight:600">Admitted:</span> ${admDate}</div>
    <div style="padding:8px 14px;border-right:1px solid #c8ddd0"><span style="font-weight:600">Discharged:</span> ${disDate}</div>
    <div style="padding:8px 14px"><span style="font-weight:600">LOS:</span> ${los} day(s) · <strong>${esc(statusLabel || '')}</strong></div>
  </div>
  ${adm.diagnosis_primary ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:10px 16px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#4a6352;margin-bottom:4px">Diagnosis at Admission</div>
    <div style="font-size:13px;font-weight:600">${esc(adm.diagnosis_primary)}</div>
  </div>` : ''}
  ${adm.discharge_diagnosis_ayurveda || adm.discharge_diagnosis_icd10 ? `
  <div style="display:grid;grid-template-columns:1fr 1fr;border:1px solid #c8ddd0;border-top:none;font-size:12px">
    ${adm.discharge_diagnosis_ayurveda ? `<div style="padding:8px 14px;border-right:1px solid #c8ddd0"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:2px">Final Ayurvedic Diagnosis</div><div style="font-weight:600">${esc(adm.discharge_diagnosis_ayurveda)}</div></div>` : '<div></div>'}
    ${adm.discharge_diagnosis_icd10 ? `<div style="padding:8px 14px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:2px">ICD-10 Code</div><div>${esc(adm.discharge_diagnosis_icd10)}</div></div>` : '<div></div>'}
  </div>` : ''}
  ${_block(esc, 'Course in Hospital', adm.discharge_course)}
  ${_block(esc, 'Treatment Given', adm.discharge_treatment_given)}
  ${_block(esc, 'Panchakarma / Procedures Performed', adm.discharge_pk_procedures)}
  ${_block(esc, 'Investigations', adm.discharge_investigations)}
  ${_block(esc, 'Condition at Discharge', adm.discharge_condition ? adm.discharge_condition.charAt(0).toUpperCase() + adm.discharge_condition.slice(1) : '')}
  ${_block(esc, 'Medications on Discharge (with Anupana)', adm.discharge_medications)}
  ${_block(esc, "Pathya (Do's) &amp; Apathya (Don'ts)", adm.discharge_pathya_apathya)}
  ${homeChart ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">🏠 Samsarjana Krama — Home Diet Chart (${esc(homeChart.grade.charAt(0).toUpperCase() + homeChart.grade.slice(1))} Shuddhi)</div>
    <div style="font-size:11px;color:#4a6352;margin-bottom:6px">Your Panchakarma course includes a graded return-to-normal diet. The days below are to be prepared and served at home — please follow the schedule and recipes exactly, in order.</div>
    <table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:8px">
      <thead><tr style="background:#f5fbf8">
        <th style="text-align:left;padding:3px 6px;border-bottom:1px solid #c8ddd0">Day</th>
        <th style="text-align:left;padding:3px 6px;border-bottom:1px solid #c8ddd0">Date</th>
        <th style="text-align:left;padding:3px 6px;border-bottom:1px solid #c8ddd0">Morning</th>
        <th style="text-align:left;padding:3px 6px;border-bottom:1px solid #c8ddd0">Evening</th>
      </tr></thead>
      <tbody>${homeChart.days.map(d => `<tr>
        <td style="padding:3px 6px;border-bottom:1px solid #eef3ee">${d.day_offset}</td>
        <td style="padding:3px 6px;border-bottom:1px solid #eef3ee">${d.planned_date ? new Date(d.planned_date + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—'}</td>
        <td style="padding:3px 6px;border-bottom:1px solid #eef3ee">${d.morning ? esc(d.morning.preparation_name) : '—'}</td>
        <td style="padding:3px 6px;border-bottom:1px solid #eef3ee">${d.evening ? esc(d.evening.preparation_name) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#4a6352;margin-bottom:3px">How to Prepare</div>
    ${homeChart.recipes.map(r => `<div style="font-size:11px;margin-bottom:5px"><strong>${esc(r.preparation_name)}</strong> (${esc(r.stage_label)})<br>${esc(r.preparation_method || '')}</div>`).join('')}
  </div>` : ''}
  <div style="border:1px solid #c8ddd0;border-top:none;padding:10px 16px;min-height:60px">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#4a6352;margin-bottom:6px">Discharge Advice</div>
    <div style="font-size:12px;line-height:1.8;white-space:pre-wrap">${esc(adm.discharge_advice || adm.notes || '—')}</div>
  </div>
  ${adm.discharge_followup_date ? `
  <div style="border:1px solid #c8ddd0;border-top:none;padding:8px 14px;background:#f5fbf8">
    <span style="font-size:12px;font-weight:600;color:#1a4a2e">📅 Follow-up OPD: </span>
    <span style="font-size:12px">${new Date(adm.discharge_followup_date + 'T00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</span>
  </div>` : ''}
  <div style="display:flex;justify-content:space-between;align-items:flex-end;border:1px solid #c8ddd0;border-top:none;padding:12px 16px;background:#fafbf9">
    <div style="font-size:11px;color:#6a8070">Printed: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</div>
    <div style="text-align:center">
      <div style="width:160px;border-top:1px solid #aaa;padding-top:5px;font-size:11px;color:#6a8070">
        ${esc(signerName || doc.full_name || '—')}<br>
        <span style="font-size:10px">${esc(dept.name || '')}</span>
      </div>
    </div>
  </div>
  <div style="text-align:center;margin-top:8px;font-size:10px;color:#aaa">Powered by AyurXpert Technologies™</div>
</div>`;
}

// Renders into #ds-print and prints; the page supplies the #ds-print element and the
// body.ds-print @media print rule that hides everything else.
export function printDischargeHtml(html) {
  const el = document.getElementById('ds-print');
  el.innerHTML = html;
  document.body.classList.add('ds-print');
  window.addEventListener('afterprint', () => {
    document.body.classList.remove('ds-print');
    el.style.display = 'none';
  }, { once: true });
  el.style.display = 'block';
  window.print();
}
