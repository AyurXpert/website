// shift-close.html -- Shift Close & Cash Handover (Session 329, TODO_LATER.md §104). The screens live in
// js/modules/billing/shiftHandover.js; this file only authenticates, mounts and switches tabs.
import { requireAuth, getCurrentProfile } from '../core/auth.js'
import { initNavbar } from '../components/navbar.js'
import { supabase } from '../core/db/supabaseClient.js'
import { mountMyShift, mountHandoverReview } from '../modules/billing/shiftHandover.js'
import { mountPaperSizeSelect } from '../modules/billing/paperSize.js'

// Anyone who can be handed money at a counter; the server decides who actually has receipts to close.
await requireAuth(['receptionist', 'nurse', 'cashier', 'accountant', 'finance_manager', 'dept_admin', 'super_admin',
  'lab_tech', 'pharmacist', 'doctor', 'trainee_doctor', 'nurse_manager', 'therapist'])
initNavbar()
// Session 336: paper size for printed handover slips (A4 / A5 / thermal 80 / 58 mm), remembered per device --
// choosing it never prints or records anything; it is used at the next Print.
mountPaperSizeSelect(document.getElementById('paper-slot'))

const me = getCurrentProfile() || {}
const roles = [me.role, me.secondary_role]
const isChecker = roles.some(r => ['accountant', 'cashier', 'finance_manager', 'dept_admin', 'super_admin'].includes(r))
const isAdmin = roles.some(r => ['dept_admin', 'super_admin'].includes(r))

const tabs = { mine: document.getElementById('tab-mine'), review: document.getElementById('tab-review') }
const panels = { mine: document.getElementById('panel-mine'), review: document.getElementById('panel-review') }
let reviewMounted = false

function show(name) {
  for (const k of Object.keys(tabs)) {
    tabs[k].classList.toggle('active', k === name)
    tabs[k].setAttribute('aria-selected', String(k === name))
    panels[k].classList.toggle('active', k === name)
  }
  if (name === 'review' && !reviewMounted) { reviewMounted = true; mountHandoverReview(panels.review, { supabase, canActOnBehalf: isAdmin }) }
}
tabs.mine.addEventListener('click', () => show('mine'))
tabs.review.addEventListener('click', () => show('review'))
if (isChecker) tabs.review.style.display = ''

mountMyShift(panels.mine, { supabase })
if (new URLSearchParams(location.search).get('tab') === 'review' && isChecker) show('review')
