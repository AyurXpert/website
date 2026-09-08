// ── Material-style analog clock time picker ──────────────────────────────
// Visual parity with the ABDM PHR app's "SELECT TIME" dialog (Angular Material
// clock), rendered in the AyurXpert palette. Vanilla, no deps, CSP-safe
// (styles injected via <style>, no inline handlers).
//
// Usage:
//   import { openTimePicker } from '../components/timePicker.js';
//   openTimePicker({ value: '23:59', onConfirm: (v) => { /* v = "HH:MM" 24h */ } });
//
// formatTime12('23:59') -> "11:59 PM"  (for the trigger field label)

const STYLE_ID = 'axtp-styles';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.axtp-overlay{position:fixed;inset:0;background:rgba(26,44,30,.45);display:flex;
  align-items:center;justify-content:center;z-index:10000;font-family:'DM Sans',system-ui,sans-serif}
.axtp-card{background:#fff;border-radius:16px;padding:20px 20px 12px;width:328px;max-width:94vw;
  box-shadow:0 12px 40px rgba(0,0,0,.28)}
.axtp-title{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6b7d70;font-weight:600;margin-bottom:14px}
.axtp-head{display:flex;align-items:center;gap:6px;margin-bottom:18px}
.axtp-seg{font:600 44px/1 'Cormorant Garamond',Georgia,serif;color:#1a4a2e;background:#f0f4ef;
  border:none;border-radius:8px;padding:6px 10px;min-width:66px;text-align:center;cursor:pointer;transition:background .12s}
.axtp-seg.active{background:#e7dcc0;color:#8a6a1e}
.axtp-colon{font:600 40px/1 'Cormorant Garamond',Georgia,serif;color:#1a4a2e;padding:0 2px}
.axtp-ampm{display:flex;flex-direction:column;margin-left:10px;border:1px solid #d8d2c4;border-radius:8px;overflow:hidden}
.axtp-ampm button{border:none;background:#fff;color:#5a6b5e;font:600 12px/1 'DM Sans',sans-serif;
  padding:9px 12px;cursor:pointer}
.axtp-ampm button.on{background:#e7dcc0;color:#8a6a1e}
.axtp-ampm button+button{border-top:1px solid #d8d2c4}
.axtp-clock{position:relative;width:240px;height:240px;margin:4px auto 6px;border-radius:50%;
  background:#faf8f3;touch-action:none}
.axtp-num{position:absolute;width:30px;height:30px;margin:-15px 0 0 -15px;display:flex;align-items:center;
  justify-content:center;font:500 14px/1 'DM Sans',sans-serif;color:#2f4636;border-radius:50%;
  cursor:pointer;user-select:none;z-index:2}
.axtp-num.sel{background:#c9902a;color:#fff}
.axtp-hand{position:absolute;left:50%;bottom:50%;width:2px;background:#c9902a;transform-origin:bottom center;z-index:1}
.axtp-hub{position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:#c9902a;z-index:3}
.axtp-knob{position:absolute;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
  background:#c9902a;opacity:.22;z-index:1}
.axtp-foot{display:flex;align-items:center;justify-content:space-between;margin-top:8px}
.axtp-kbd{border:none;background:none;cursor:pointer;font-size:18px;color:#6b7d70;padding:6px;border-radius:6px}
.axtp-kbd:hover{background:#f0f4ef}
.axtp-actions button{border:none;background:none;font:600 13px/1 'DM Sans',sans-serif;color:#1a4a2e;
  padding:9px 14px;cursor:pointer;border-radius:6px}
.axtp-actions button:hover{background:#f0f4ef}
.axtp-kbdrow{display:flex;align-items:center;gap:8px;justify-content:center;margin:20px 0 24px}
.axtp-kbdrow input{width:74px;font:600 32px/1 'Cormorant Garamond',Georgia,serif;color:#1a4a2e;
  text-align:center;border:1px solid #d8d2c4;border-radius:8px;padding:8px 4px}
`;
  document.head.appendChild(s);
}

export function formatTime12(hhmm) {
  const [hStr, mStr] = String(hhmm || '00:00').split(':');
  let h = parseInt(hStr, 10); const m = parseInt(mStr, 10) || 0;
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

export function openTimePicker({ value = '23:59', onConfirm } = {}) {
  injectStyles();

  let [h24] = String(value).split(':').map(n => parseInt(n, 10));
  let m = parseInt(String(value).split(':')[1], 10) || 0;
  if (isNaN(h24)) h24 = 23;
  let ampm = h24 >= 12 ? 'PM' : 'AM';
  let hour12 = h24 % 12; if (hour12 === 0) hour12 = 12;
  let mode = 'hour';           // 'hour' | 'minute'
  let kbd = false;

  const overlay = document.createElement('div');
  overlay.className = 'axtp-overlay';
  overlay.innerHTML = `
    <div class="axtp-card" role="dialog" aria-modal="true" aria-label="Select time">
      <div class="axtp-title">Select time</div>
      <div class="axtp-head">
        <button type="button" class="axtp-seg" data-seg="hour"></button>
        <span class="axtp-colon">:</span>
        <button type="button" class="axtp-seg" data-seg="minute"></button>
        <div class="axtp-ampm">
          <button type="button" data-ap="AM">AM</button>
          <button type="button" data-ap="PM">PM</button>
        </div>
      </div>
      <div class="axtp-body"></div>
      <div class="axtp-foot">
        <button type="button" class="axtp-kbd" aria-label="Toggle keyboard entry">⌨</button>
        <div class="axtp-actions">
          <button type="button" data-act="cancel">CANCEL</button>
          <button type="button" data-act="ok">OK</button>
        </div>
      </div>
    </div>`;

  const body   = overlay.querySelector('.axtp-body');
  const segH   = overlay.querySelector('[data-seg="hour"]');
  const segM   = overlay.querySelector('[data-seg="minute"]');
  const apBtns = [...overlay.querySelectorAll('[data-ap]')];

  function renderHead() {
    segH.textContent = String(hour12);
    segM.textContent = String(m).padStart(2, '0');
    segH.classList.toggle('active', mode === 'hour' && !kbd);
    segM.classList.toggle('active', mode === 'minute' && !kbd);
    apBtns.forEach(b => b.classList.toggle('on', b.dataset.ap === ampm));
  }

  function renderClock() {
    const R = 120, ring = 92;                     // clock radius / number ring radius
    const isHour = mode === 'hour';
    const values = isHour
      ? Array.from({ length: 12 }, (_, i) => i + 1)   // 1..12
      : Array.from({ length: 12 }, (_, i) => i * 5);  // 0,5,..,55
    const selVal  = isHour ? hour12 : (Math.round(m / 5) * 5) % 60;
    // degrees clockwise from 12 o'clock (straight up)
    const handDeg = isHour ? (selVal % 12) * 30 : (selVal / 60) * 360;

    let nums = '';
    values.forEach((val) => {
      const posDeg = isHour ? (val % 12) * 30 : (val / 60) * 360;
      const rad = (posDeg - 90) * Math.PI / 180;      // -90 → 0deg points up
      const x = R + ring * Math.cos(rad);
      const y = R + ring * Math.sin(rad);
      const sel = val === selVal ? ' sel' : '';
      const label = isHour ? val : String(val).padStart(2, '0');
      nums += `<div class="axtp-num${sel}" style="left:${x}px;top:${y}px" data-val="${val}">${label}</div>`;
    });
    const knobRad = (handDeg - 90) * Math.PI / 180;
    const kx = R + ring * Math.cos(knobRad);
    const ky = R + ring * Math.sin(knobRad);
    body.innerHTML = `
      <div class="axtp-clock">
        <div class="axtp-hand" style="height:${ring}px;transform:rotate(${handDeg}deg)"></div>
        <div class="axtp-knob" style="left:${kx}px;top:${ky}px"></div>
        <div class="axtp-hub"></div>
        ${nums}
      </div>`;

    body.querySelectorAll('.axtp-num').forEach(el => {
      el.addEventListener('click', () => {
        const v = parseInt(el.dataset.val, 10);
        if (isHour) { hour12 = v; mode = 'minute'; renderAll(); }
        else        { m = v; renderAll(); }
      });
    });
  }

  function renderKbd() {
    body.innerHTML = `
      <div class="axtp-kbdrow">
        <input type="number" min="1" max="12" data-k="h" value="${hour12}">
        <span class="axtp-colon">:</span>
        <input type="number" min="0" max="59" data-k="m" value="${String(m).padStart(2, '0')}">
      </div>`;
    const hi = body.querySelector('[data-k="h"]');
    const mi = body.querySelector('[data-k="m"]');
    hi.addEventListener('input', () => {
      let v = parseInt(hi.value, 10); if (isNaN(v)) return;
      v = Math.min(12, Math.max(1, v)); hour12 = v; renderHead();
    });
    mi.addEventListener('input', () => {
      let v = parseInt(mi.value, 10); if (isNaN(v)) return;
      v = Math.min(59, Math.max(0, v)); m = v; renderHead();
    });
  }

  function renderAll() {
    renderHead();
    if (kbd) renderKbd(); else renderClock();
  }

  segH.addEventListener('click', () => { mode = 'hour'; renderAll(); });
  segM.addEventListener('click', () => { mode = 'minute'; renderAll(); });
  apBtns.forEach(b => b.addEventListener('click', () => { ampm = b.dataset.ap; renderHead(); }));
  overlay.querySelector('.axtp-kbd').addEventListener('click', () => { kbd = !kbd; renderAll(); });

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);
  overlay.querySelector('[data-act="ok"]').addEventListener('click', () => {
    let h = hour12 % 12;
    if (ampm === 'PM') h += 12;
    const out = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    close();
    if (typeof onConfirm === 'function') onConfirm(out);
  });
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);
  renderAll();
}
