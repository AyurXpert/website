// opdWorkflowSettings.js -- Admin → 🔧 Feature Modules → "🩺 OPD workflow" (Session 347, TODO §198). The two per-organisation
// switches: Screening OPD and intern / PG verification. "Not set" = the organisation type's default (ON for a teaching hospital /
// college, OFF otherwise). Only this organisation's own active Super Admin changes them (set_opd_workflow re-checks and audits);
// everyone else reads. Saved at once, never by the Feature Modules grid. DOM nodes + textContent only; no confirm() / alert().
import { safeErrorMessage } from '../../utils/errors.js'

const mk = (tag, style, text) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; return e }
const btnCss = on => "min-height:44px;padding:0 16px;border-radius:8px;font:600 13px 'DM Sans',sans-serif;cursor:pointer;"
  + (on ? 'background:#fff;color:var(--red,#c0392b);border:1.5px solid var(--red,#c0392b)' : 'background:var(--green-deep);color:#fff;border:1.5px solid var(--green-deep)')

/** renderOpdWorkflowSettings(box, { supabase, role, toast }) */
export async function renderOpdWorkflowSettings(box, { supabase, role, toast }) {
  if (!box) return
  const { data: wf, error } = await supabase.rpc('get_opd_workflow')
  box.hidden = false
  if (error || !wf) {
    box.replaceChildren(mk('div', 'font-size:12.5px;color:var(--red,#c0392b);margin-bottom:18px', safeErrorMessage(error, 'Could not load the OPD workflow settings.')))
    return
  }
  const canChange = role === 'super_admin'
  const card = mk('div', 'border-radius:8px;padding:14px 16px;margin-bottom:18px;border:1.5px solid #a5d6b8;background:#f0fff4')
  card.append(mk('div', 'font-weight:600;font-size:14px;color:var(--green-deep);margin-bottom:8px', '🩺 OPD workflow'))
  const status = mk('div', 'font-size:12.5px;min-height:1em;margin-top:6px')
  status.setAttribute('role', 'status')
  const row = (key, title, onText, offText) => {
    const on = !!wf[key], set = !!wf[key + '_set']
    const r = mk('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 0;border-top:1px solid var(--border,#e0e0e0)')
    const t = mk('div', 'flex:1;min-width:220px')
    t.append(mk('div', 'font-weight:600;font-size:13px;color:var(--text-dark,#1a1a1a)', title),
      mk('div', 'font-size:12.5px;color:var(--text-mid);margin-top:2px', `${on ? 'ON' : 'OFF'}${set ? '' : ' (the default for this type of organisation)'} — ${on ? onText : offText}`))
    r.append(t)
    if (canChange) {
      const b = mk('button', btnCss(on), on ? 'Switch OFF' : 'Switch ON')
      b.type = 'button'
      b.addEventListener('click', async () => {
        b.disabled = true
        const { error: e } = await supabase.rpc('set_opd_workflow', { p_key: key, p_on: !on })
        if (e) { b.disabled = false; status.style.color = 'var(--red,#c0392b)'; status.textContent = safeErrorMessage(e, 'Could not save the setting.'); return }
        toast?.(`✓ ${title} switched ${on ? 'OFF' : 'ON'} — reload open pages to use it`)
        renderOpdWorkflowSettings(box, { supabase, role, toast })
      })
      r.append(b)
    }
    card.append(r)
  }
  row('screening_opd', 'Screening OPD',
    `new patients and new complaints go to the Screening OPD${wf.screening_opd_name ? ` (${wf.screening_opd_name})` : ''}, which sends them to the specialty OPD.`,
    'reception chooses the OPD / department and the doctor directly.')
  row('trainee_verification', 'Intern / PG verification',
    'interns and PG scholars record the case and send it to the consultant, who verifies and completes it.',
    'no "Submit for Review" — consultants complete every consultation.')
  if (!canChange) card.append(mk('div', 'font-size:12px;color:var(--text-muted);margin-top:6px', "Only this organisation's Super Admin can change these."))
  card.append(status)
  box.replaceChildren(card)
}
