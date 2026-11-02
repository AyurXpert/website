// deptTargetsSetting.js -- Admin → 🔧 Feature Modules → "🎯 OPD department targets" (Session 374B, plan docs/handoff/session373_plan.md
// §A + B9, contract §10.2). NCISM sets NO department-wise OPD figure -- only the hospital's daily total (Reg. 42, Table-7). So each
// department's share is a HOSPITAL target, labelled "hospital target — not an NCISM rule". Not set = the bed shares (KAY 20, PK 25,
// SHAL 20, SHAK 10, KAU 10, PST 10, AGD 5, any other 0). Only the organisation's ACTIVE Super Admin saves (set_opd_dept_targets
// re-checks: every clinical department, each 0–100 % one decimal, total ≤ 100 %, a reason; audited). Everyone else reads.
// Shown only for NCISM organisation types (ncism_settings().ncism_type). DOM nodes + textContent only.
import { safeErrorMessage } from '../../utils/errors.js';

// rows = opd_dept_targets(); values = { department_id: '20' } (the boxes) -> { targets: {id: number}, total, error }
export function validateTargets(rows, values) {
  const targets = {};
  let total = 0;
  for (const r of rows || []) {
    const raw = String(values?.[r.department_id] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < 0 || n > 100 || Math.round(n * 10) !== n * 10) {
      return { targets: null, total: null, error: 'Each share must be 0 to 100 % (one decimal).', departmentId: r.department_id };
    }
    targets[r.department_id] = n;
    total += n;
  }
  total = Math.round(total * 10) / 10;
  if (total > 100) return { targets: null, total, error: `The shares add up to ${total} % — at most 100 %.` };
  return { targets, total, error: null };
}

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e; };
const BTN = "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;";

/** renderDeptTargetsSetting(box, { supabase, role, toast }) */
export async function renderDeptTargetsSetting(box, { supabase, role, toast }) {
  if (!box) return;
  const { data: settings } = await supabase.rpc('ncism_settings');
  if (!settings?.ncism_type) { box.hidden = true; return; }
  const { data: rows, error } = await supabase.rpc('opd_dept_targets');
  box.hidden = false;
  if (error) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the OPD department targets.')));
    return;
  }
  const list = rows || [];
  // G1 (owner 2 Nov 2026): the HOSPITAL's daily target (ncism_settings), never a department's own row target
  const daily = Number(settings.target_per_day ?? 0) || 0;
  const canChange = role === 'super_admin';
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid #8b1a6b;background:#f6ebf3');
  card.id = 'opd-dept-targets-card';
  card.append(mk('div', 'font-weight:600;font-size:14px;color:#8b1a6b;margin-bottom:4px', '🎯 OPD department targets'),
    mk('div', 'font-size:12.5px;color:#4a2c43;margin-bottom:10px',
      `Each department's share of the hospital's daily target (${daily || '—'} patients / day). These are hospital targets — not an NCISM rule: NCISM sets only the hospital total. Shown as the department bars on the Screening page. ${list.some(r => !r.is_default) ? 'Set by the Super Admin.' : 'Now: the default (each department\'s bed share).'}`));
  const tbl = mk('table', 'border-collapse:collapse;font-size:13px;width:100%;max-width:560px');
  const head = mk('tr');
  ['Department', 'Share (%)', 'Target / day'].forEach(t => { const th = mk('th', 'text-align:left;padding:4px 8px;border-bottom:1px solid #d9b8cf', t); th.scope = 'col'; head.append(th); });
  const thead = mk('thead'); thead.append(head);
  const tbody = mk('tbody');
  const inputs = {};
  for (const r of list) {
    const tr = mk('tr');
    const id = `odt-${r.department_id}`;
    const nameTd = mk('td', 'padding:4px 8px');
    const lab = mk('label', null, `${r.department_name}${r.ncism_code ? ' (' + r.ncism_code + ')' : ''}${r.is_default ? ' · default' : ''}`); lab.htmlFor = id;
    nameTd.append(lab);
    const inTd = mk('td', 'padding:4px 8px');
    const inp = mk('input', "width:96px;min-height:44px;padding:0 8px;border:1.5px solid #8f80c4;border-radius:8px;font:14px 'DM Sans',sans-serif");
    inp.type = 'number'; inp.min = '0'; inp.max = '100'; inp.step = '0.1'; inp.id = id; inp.value = String(r.share_pct ?? 0);
    inp.disabled = !canChange;
    inputs[r.department_id] = inp;
    inTd.append(inp);
    const tgt = mk('td', 'padding:4px 8px', daily ? String(Math.round(Number(r.share_pct || 0) * daily / 100)) : '—');
    inp.addEventListener('input', () => { const n = Number(inp.value); tgt.textContent = daily && Number.isFinite(n) ? String(Math.round(n * daily / 100)) : '—'; sum(); });
    tr.append(nameTd, inTd, tgt);
    tbody.append(tr);
  }
  tbl.append(thead, tbody);
  const total = mk('div', 'font-size:13px;font-weight:600;margin-top:6px');
  total.setAttribute('aria-live', 'polite');
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px'); status.setAttribute('role', 'status');
  const vals = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
  function sum() {
    const v = validateTargets(list, vals());
    total.textContent = v.error ? v.error : `Total ${v.total} % of the daily target`;
    total.style.color = v.error ? 'var(--red,#c0392b)' : '#3b0f2f';
  }
  sum();
  card.append(tbl, total);
  if (canChange) {
    const row = mk('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:10px');
    const lab = mk('label', 'flex:1;min-width:220px;font-size:12.5px;color:var(--text-mid)', 'Reason for the change (required)');
    const inp = mk('input', "display:block;width:100%;box-sizing:border-box;min-height:44px;margin-top:4px;padding:0 10px;border:1.5px solid var(--border,#d6d0c4);border-radius:8px;font:14px 'DM Sans',sans-serif");
    inp.type = 'text'; inp.maxLength = 300; inp.autocomplete = 'off'; inp.id = 'odt-reason';
    lab.append(inp);
    const save = mk('button', BTN + 'background:#8b1a6b;color:#fff;border:1.5px solid #8b1a6b', 'Save targets'); save.type = 'button'; save.id = 'odt-save';
    const reset = mk('button', BTN + 'background:#fff;color:#8b1a6b;border:1.5px solid #8b1a6b', 'Back to the bed-share defaults'); reset.type = 'button'; reset.id = 'odt-reset';
    const send = async targets => {
      const reason = inp.value.trim();
      if (reason.length < 5 || reason.length > 300) { status.style.color = 'var(--red,#c0392b)'; status.textContent = 'Give the reason for the change (5 to 300 characters).'; inp.focus(); return; }
      save.disabled = reset.disabled = true;
      const { data, error: e } = await supabase.rpc('set_opd_dept_targets', { p_targets: targets, p_reason: reason });
      if (e || !data?.saved) { save.disabled = reset.disabled = false; status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, 'The targets were not saved.'); return; }
      toast?.(targets ? `✓ OPD department targets saved (total ${data.total_pct} %)` : '✓ OPD department targets back to the bed-share defaults');
      renderDeptTargetsSetting(box, { supabase, role, toast });
    };
    save.addEventListener('click', () => {
      const v = validateTargets(list, vals());
      if (v.error) { status.style.color = 'var(--red,#c0392b)'; status.textContent = v.error; if (v.departmentId) inputs[v.departmentId]?.focus(); return; }
      send(v.targets);
    });
    reset.addEventListener('click', () => send(null));
    row.append(lab, save, reset);
    card.append(row);
  } else {
    card.append(mk('div', 'font-size:12px;color:var(--text-muted);margin-top:6px', "Only this organisation's Super Admin can change these."));
  }
  card.append(status);
  box.replaceChildren(card);
}
