// Session 371B (plan session 370 B9 + Part C): reception's layout, remembered.
//   * the pane choice: 'both' (side by side) / 'form' (Registration full) / 'work' (Today's work full)
//   * the work-pane tabs: their order and which sit on the tab bar (the rest under "More ▾")
// Per receptionist = staff_ui_prefs (own row only; written through save_my_ui_prefs). Per hospital = tenants.modules.reception_tabs
// (written only by the active Super Admin through set_reception_tabs, with a reason). A receptionist's own order wins; "Reset to
// hospital default" drops it. Nothing here changes what anyone may SEE -- a tab the role cannot use is never shown, whatever the prefs.

export const PAGE = 'reception';
export const TAB_KEYS = ['patients', 'billing', 'admissions', 'reports', 'regqueue', 'pkplans', 'vbsearch'];
export const TAB_LABEL = {
  patients: 'Patients', billing: 'Billing', admissions: 'Admissions', reports: 'Lab Reports',
  regqueue: 'ABHA Req. Queue', pkplans: 'PK Care Plans', vbsearch: 'Visits & Bills',
};
export const DEFAULT_TABS = { order: TAB_KEYS.slice(), pinned: ['patients', 'billing', 'admissions', 'reports'] };
export const PANES = ['both', 'form', 'work'];

// Any stored value -> a complete, valid arrangement (unknown keys dropped, missing ones appended, at least one pinned)
export function normaliseTabs(x) {
  if (!x || typeof x !== 'object') return null;
  const order = Array.isArray(x.order) ? x.order.filter((k, i, a) => TAB_KEYS.includes(k) && a.indexOf(k) === i) : [];
  TAB_KEYS.forEach(k => { if (!order.includes(k)) order.push(k); });
  const pinned = Array.isArray(x.pinned) ? x.pinned.filter((k, i, a) => TAB_KEYS.includes(k) && a.indexOf(k) === i) : [];
  return { order, pinned: pinned.length ? pinned : DEFAULT_TABS.pinned.slice() };
}

// own = staff_ui_prefs.prefs.tabs, hospital = tenants.modules.reception_tabs  ->  the arrangement used + where it came from
export function effectiveTabs(own, hospital) {
  const o = normaliseTabs(own);
  if (o) return { ...o, source: 'own' };
  const h = normaliseTabs(hospital);
  if (h) return { ...h, source: 'hospital' };
  return { ...DEFAULT_TABS, order: DEFAULT_TABS.order.slice(), pinned: DEFAULT_TABS.pinned.slice(), source: 'default' };
}

// available = the tab keys this person may use. -> { bar: [...], more: [...] } in the chosen order
export function splitTabs(tabs, available) {
  const avail = tabs.order.filter(k => available.includes(k));
  let bar = avail.filter(k => tabs.pinned.includes(k));
  if (!bar.length && avail.length) bar = [avail[0]];
  return { bar, more: avail.filter(k => !bar.includes(k)) };
}

export function normalisePane(p) { return PANES.includes(p) ? p : 'both'; }

export async function loadPrefs({ supabase, tenantId }) {
  const [own, ten] = await Promise.all([
    supabase.from('staff_ui_prefs').select('page, prefs').eq('page', PAGE).maybeSingle(),
    supabase.from('tenants').select('modules').eq('id', tenantId).maybeSingle(),
  ]);
  return {
    own: own.error ? null : (own.data?.prefs || null),
    hospital: ten.error ? null : (ten.data?.modules?.reception_tabs || null),
    ownError: own.error || null,
  };
}

// Returns { error } -- the caller says "saved" only when error is null
export async function saveOwnPrefs(supabase, prefs) {
  const { error } = await supabase.rpc('save_my_ui_prefs', { p_page: PAGE, p_prefs: prefs });
  return { error: error || null };
}
export async function saveHospitalTabs(supabase, tabs, reason) {
  const { error } = await supabase.rpc('set_reception_tabs', { p_tabs: { order: tabs.order, pinned: tabs.pinned }, p_reason: reason });
  return { error: error || null };
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };

// ⚙ Arrange tabs. ctx = { supabase, current (tabs), available, hospital (raw), canSetHospital, ownPrefs, onApply(tabs, ownPrefs), notify, errorText }
export function openArrangeDialog(ctx) {
  document.getElementById('rx-arrange')?.remove();
  let work = { order: ctx.current.order.slice(), pinned: ctx.current.pinned.slice() };
  const ov = el('div', 'rx-modal-ov'); ov.id = 'rx-arrange';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'rx-arrange-t');
  const box = el('div', 'rx-modal');
  const h = el('h2', 'rx-modal-t', 'Arrange the tabs'); h.id = 'rx-arrange-t';
  const help = el('p', 'rx-modal-help', 'Move a tab up or down. Ticked tabs sit on the tab bar; the others are under "More ▾". This changes only how the tabs are arranged, never who may use them.');
  const list = el('ol', 'rx-arr-list');
  const msg = el('div', 'rx-modal-msg'); msg.setAttribute('role', 'status');

  function draw() {
    list.replaceChildren();
    const keys = work.order.filter(k => ctx.available.includes(k));
    keys.forEach((k, i) => {
      const li = el('li', 'rx-arr-row');
      const lab = el('label', 'rx-arr-lab');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = work.pinned.includes(k);
      cb.addEventListener('change', () => {
        work.pinned = cb.checked ? [...work.pinned, k] : work.pinned.filter(x => x !== k);
      });
      lab.append(cb, document.createTextNode(` ${TAB_LABEL[k]} — on the tab bar`));
      const up = el('button', 'rx-arr-btn', '↑'); up.type = 'button'; up.disabled = i === 0; up.setAttribute('aria-label', `Move ${TAB_LABEL[k]} up`);
      const dn = el('button', 'rx-arr-btn', '↓'); dn.type = 'button'; dn.disabled = i === keys.length - 1; dn.setAttribute('aria-label', `Move ${TAB_LABEL[k]} down`);
      const move = d => {
        const a = work.order.indexOf(k), b = work.order.indexOf(keys[i + d]);
        [work.order[a], work.order[b]] = [work.order[b], work.order[a]];
        draw();
        list.querySelectorAll('.rx-arr-row')[i + d]?.querySelector(d < 0 ? '.rx-arr-btn' : '.rx-arr-btn:last-child')?.focus();
      };
      up.addEventListener('click', () => move(-1));
      dn.addEventListener('click', () => move(1));
      li.append(lab, up, dn);
      list.append(li);
    });
  }
  draw();

  const acts = el('div', 'rx-modal-acts');
  const mine = el('button', 'rx-btn rx-btn-main', 'Save for me'); mine.type = 'button';
  const reset = el('button', 'rx-btn', 'Reset to hospital default'); reset.type = 'button';
  const cancel = el('button', 'rx-btn', 'Cancel'); cancel.type = 'button';
  acts.append(mine, reset, cancel);
  box.append(h, help, list, acts);

  let hospBox = null;
  if (ctx.canSetHospital) {
    hospBox = el('div', 'rx-arr-hosp');
    const l = el('label', null, 'Reason (for the hospital default)'); l.htmlFor = 'rx-arr-reason';
    const r = el('input'); r.id = 'rx-arr-reason'; r.type = 'text'; r.maxLength = 300; r.placeholder = 'e.g. ABHA Req. Queue on the bar for the ABDM counter';
    const b = el('button', 'rx-btn', 'Save as the hospital default'); b.type = 'button';
    b.addEventListener('click', async () => {
      if (r.value.trim().length < 5) { msg.textContent = 'Give a reason (at least 5 characters) for the hospital default.'; r.focus(); return; }
      b.disabled = true; msg.textContent = 'Saving…';
      const { error } = await saveHospitalTabs(ctx.supabase, normaliseTabs(work), r.value.trim());
      b.disabled = false;
      if (error) { msg.textContent = ctx.errorText(error, 'The hospital default was not saved.'); return; }
      msg.textContent = '';
      ctx.notify('Hospital default tab arrangement saved.', 'success');
    });
    hospBox.append(el('div', 'rx-arr-hosp-t', 'Super Admin: the default for every receptionist of this hospital'), l, r, b);
    box.append(hospBox);
  }
  box.append(msg);
  ov.append(box);
  document.body.append(ov);
  const shut = () => { ov.remove(); document.removeEventListener('keydown', onKey); ctx.returnFocus?.focus(); };
  const onKey = e => { if (e.key === 'Escape') shut(); };
  document.addEventListener('keydown', onKey);
  cancel.addEventListener('click', shut);
  ov.addEventListener('click', e => { if (e.target === ov) shut(); });

  mine.addEventListener('click', async () => {
    const tabs = normaliseTabs(work);
    const prefs = { ...(ctx.ownPrefs || {}), tabs };
    mine.disabled = true; msg.textContent = 'Saving…';
    const { error } = await saveOwnPrefs(ctx.supabase, prefs);
    mine.disabled = false;
    if (error) { msg.textContent = ctx.errorText(error, 'Your tab arrangement was not saved.'); return; }
    ctx.onApply({ ...tabs, source: 'own' }, prefs);
    ctx.notify('Your tab arrangement is saved.', 'success');
    shut();
  });
  reset.addEventListener('click', async () => {
    const prefs = { ...(ctx.ownPrefs || {}) };
    delete prefs.tabs;
    reset.disabled = true; msg.textContent = 'Saving…';
    const { error } = await saveOwnPrefs(ctx.supabase, prefs);
    reset.disabled = false;
    if (error) { msg.textContent = ctx.errorText(error, 'The reset was not saved.'); return; }
    ctx.onApply(effectiveTabs(null, ctx.hospital), prefs);
    ctx.notify('Back to the hospital default arrangement.', 'success');
    shut();
  });
  list.querySelector('input')?.focus();
}
