// Session 357 (TODO §276): the 🔔 alert list. The bell OPENS a list of the signed-in person's own alerts (newest first, the
// last 30 days, unread highlighted: patient + message + time); an alert is marked read when it is opened (clicked / Enter),
// "Mark all read" is a separate button. The server shows each person only their OWN alerts and lets them change only is_read
// (sql/session357 -- doctor_alerts policies). Built from DOM nodes + textContent only (alert text is free text).
//
//   initAlertBell({ supabase, userId, button, badge })  -- an existing bell button + badge (doctor.html)
//   mountAlertBell({ supabase, userId })               -- adds a bell to the shared navbar (admin.html, reception.html)
import { notify } from './notify.js';

const DAYS = 30;
const LIMIT = 100;

function _fmt(ts) {
  try {
    return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function _el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

export function initAlertBell({ supabase, userId, button, badge, onChange }) {
  if (!button || !userId) return null;
  let panel = null;
  let open = false;

  async function refreshBadge() {
    const { count, error } = await supabase.from('doctor_alerts').select('id', { count: 'exact', head: true })
      .eq('doctor_id', userId).eq('is_read', false);
    if (error || !badge) return;
    badge.textContent = count > 99 ? '99+' : String(count || 0);
    badge.classList.toggle('show', (count || 0) > 0);
    badge.style.display = badge.classList.contains('ax-bell-dot') ? ((count || 0) > 0 ? 'flex' : 'none') : '';
    if (typeof onChange === 'function') onChange(count || 0);
  }

  function close() {
    open = false;
    panel?.remove();
    button.setAttribute('aria-expanded', 'false');
  }

  async function markRead(ids) {
    if (!ids.length) return true;
    const { data, error } = await supabase.from('doctor_alerts').update({ is_read: true }).in('id', ids).eq('doctor_id', userId).select('id');
    if (error || (data || []).length !== ids.length) {   // no false "read" (353A): the server must confirm every row
      notify('Could not mark the alert read — please try again.', 'error');
      return false;
    }
    await refreshBadge();
    return true;
  }

  function build(rows) {
    const p = _el('div', 'position:fixed;z-index:3000;width:min(420px,calc(100vw - 32px));max-height:min(70vh,560px);overflow:auto;'
      + 'background:var(--white,#fff);border:1px solid var(--border,#ddd);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.18);'
      + "font-family:'DM Sans',sans-serif");
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', 'Your alerts');
    const head = _el('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;'
      + 'border-bottom:1px solid var(--border,#ddd);position:sticky;top:0;background:var(--cream,#faf8f3)');
    const h = _el('div', "font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:700;color:var(--green-deep,#1a4a2e)",
      `Your alerts — last ${DAYS} days`);
    const btns = _el('div', 'display:flex;gap:6px');
    const all = _el('button', 'min-height:44px;padding:0 12px;border:1px solid var(--border,#ddd);border-radius:8px;background:#fff;cursor:pointer;font-size:12px',
      'Mark all read');
    all.type = 'button';
    all.disabled = !rows.some(r => !r.is_read);
    const x = _el('button', 'min-width:44px;min-height:44px;border:none;background:none;cursor:pointer;font-size:18px', '✕');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close the alert list');
    btns.append(all, x);
    head.append(h, btns);
    p.append(head);
    const list = _el('div');
    if (!rows.length) list.append(_el('div', 'padding:18px 14px;color:var(--text-muted,#777);font-size:13px', 'No alerts in the last 30 days.'));
    for (const r of rows) {
      const item = _el('div', 'padding:10px 12px;border-bottom:1px solid var(--border,#eee);cursor:pointer;font-size:13px;line-height:1.4;'
        + (r.is_read ? 'background:#fff;color:var(--text-mid,#555)' : 'background:#fff8e1;color:var(--text-dark,#222);border-left:4px solid var(--gold,#c9902a)'));
      item.tabIndex = 0;
      item.setAttribute('role', 'button');
      item.setAttribute('aria-label', (r.is_read ? '' : 'Unread. ') + (r.patient_name ? r.patient_name + ': ' : '') + (r.message || ''));
      const top = _el('div', 'display:flex;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--text-muted,#777);margin-bottom:2px');
      top.append(_el('span', 'font-weight:600', (r.is_read ? '' : '● New · ') + (r.patient_name || '')), _el('span', null, _fmt(r.created_at)));
      item.append(top, _el('div', null, r.message || ''));
      const act = async () => {
        if (r.is_read) return;
        if (await markRead([r.id])) {
          r.is_read = true;
          item.style.cssText = 'padding:10px 12px;border-bottom:1px solid var(--border,#eee);cursor:pointer;font-size:13px;line-height:1.4;background:#fff;color:var(--text-mid,#555)';
          top.firstChild.textContent = r.patient_name || '';
          all.disabled = !rows.some(z => !z.is_read);
        }
      };
      item.addEventListener('click', act);
      item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
      list.append(item);
    }
    p.append(list);
    all.addEventListener('click', async () => {
      const ids = rows.filter(r => !r.is_read).map(r => r.id);
      if (await markRead(ids)) { close(); show(); }
    });
    x.addEventListener('click', close);
    p.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); button.focus(); } });
    return p;
  }

  async function show() {
    const since = new Date(Date.now() - DAYS * 86400000).toISOString();
    const { data, error } = await supabase.from('doctor_alerts').select('id, patient_name, message, is_read, created_at')
      .eq('doctor_id', userId).gte('created_at', since).order('created_at', { ascending: false }).limit(LIMIT);
    if (error) { notify('Could not load your alerts.', 'error'); return; }
    panel?.remove();
    panel = build(data || []);
    const r = button.getBoundingClientRect();
    panel.style.top = `${Math.round(r.bottom + 6)}px`;
    panel.style.right = `${Math.max(16, Math.round(window.innerWidth - r.right))}px`;
    document.body.append(panel);
    open = true;
    button.setAttribute('aria-expanded', 'true');
    panel.querySelector('button')?.focus();
  }

  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', e => { e.stopPropagation(); open ? close() : show(); });
  document.addEventListener('click', e => { if (open && panel && !panel.contains(e.target) && !button.contains(e.target)) close(); });

  supabase.channel(`alert-bell-${userId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'doctor_alerts', filter: `doctor_id=eq.${userId}` }, () => {
      refreshBadge();
      if (open) show();
    })
    .subscribe();
  refreshBadge();
  return { refreshBadge, show, close };
}

// a bell in the shared navbar (pages without their own bell). The navbar renders asynchronously: wait for it (up to 10 s).
export function mountAlertBell({ supabase, userId }) {
  return new Promise(resolve => {
    let tries = 0;
    const tick = () => {
      const right = document.querySelector('#ax-navbar .ax-right');
      if (!right) { if (++tries < 40) setTimeout(tick, 250); else resolve(null); return; }
      if (right.querySelector('.ax-bell')) { resolve(null); return; }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ax-bell';
      btn.title = 'Your alerts';
      btn.setAttribute('aria-label', 'Your alerts');
      btn.style.cssText = 'position:relative;min-width:44px;min-height:44px;border:none;background:none;cursor:pointer;font-size:18px;color:inherit';
      btn.textContent = '🔔';
      const dot = document.createElement('span');
      dot.className = 'ax-bell-dot';
      dot.style.cssText = 'position:absolute;top:4px;right:2px;min-width:18px;height:18px;padding:0 4px;border-radius:9px;'
        + 'background:#a01a1a;color:#fff;font-size:10.5px;font-weight:700;display:none;align-items:center;justify-content:center';
      btn.append(dot);
      right.prepend(btn);
      resolve(initAlertBell({ supabase, userId, button: btn, badge: dot }));
    };
    tick();
  });
}
