// js/modules/proforma/proformaEngine.js
// §18al / §18am — NCISM Specialty OPD Case Proforma Engine
// Supports: text, number, date, select, radio, checkbox_group, textarea,
//           hint (property), note, heading, ayurveda_divider, score_calculator

const _cache = {};

/** Load and render proforma into containerEl. Returns true if a proforma exists. */
export async function renderProforma(ncismCode, containerEl) {
  containerEl.innerHTML = '';
  if (!ncismCode) return false;

  let proforma = _cache[ncismCode];
  if (proforma === undefined) {
    try {
      const r = await fetch(`assets/caseProformas/${ncismCode}.json`);
      if (!r.ok) { _cache[ncismCode] = null; return false; }
      proforma = await r.json();
      _cache[ncismCode] = proforma;
    } catch { _cache[ncismCode] = null; return false; }
  }
  if (!proforma || proforma.disabled || !proforma.sections?.length) return false;

  containerEl.innerHTML = _buildHTML(proforma);
  _attachCalcListeners(containerEl);
  return true;
}

/** Return exam_guide data for a specialty, or null if none. */
export async function getExamGuide(code) {
  if (!code) return null;
  let proforma = _cache[code];
  if (proforma === undefined) {
    try {
      const r = await fetch(`assets/caseProformas/${code}.json`);
      if (!r.ok) { _cache[code] = null; return null; }
      proforma = await r.json();
      _cache[code] = proforma;
    } catch { _cache[code] = null; return null; }
  }
  if (!proforma) return null;
  return proforma.exam_guide || null;
}

/** Collect all field values from the rendered proforma container. */
export function collectProforma(containerEl) {
  const data = {};
  if (!containerEl) return data;

  const checkMap = {};
  containerEl.querySelectorAll('input[type="checkbox"][data-pf-id]').forEach(el => {
    if (!checkMap[el.dataset.pfId]) checkMap[el.dataset.pfId] = [];
    if (el.checked) checkMap[el.dataset.pfId].push(el.value);
  });
  Object.assign(data, checkMap);

  containerEl.querySelectorAll('input[type="radio"][data-pf-id]:checked').forEach(el => {
    data[el.dataset.pfId] = el.value;
  });

  containerEl.querySelectorAll(
    'select[data-pf-id],input[type="text"][data-pf-id],input[type="number"][data-pf-id],input[type="date"][data-pf-id],textarea[data-pf-id]'
  ).forEach(el => {
    const v = el.value.trim();
    if (v) data[el.dataset.pfId] = v;
  });

  return data;
}

/** Reset all proforma fields to blank. */
export function resetProforma(containerEl) {
  if (!containerEl) return;
  containerEl.querySelectorAll('[data-pf-id]').forEach(el => {
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
    else el.value = '';
  });
  containerEl.querySelectorAll('[data-calc-id]').forEach(el => {
    el.value = '';
  });
  containerEl.querySelectorAll('.pf-calc-result').forEach(el => {
    el.className = 'pf-calc-result';
  });
  containerEl.querySelectorAll('.pf-calc-score').forEach(el => {
    el.textContent = '—';
  });
  containerEl.querySelectorAll('.pf-calc-interp,.pf-calc-guide').forEach(el => {
    el.textContent = '';
  });
}

// ── HTML builders ─────────────────────────────────

function _buildHTML(p) {
  return `<div class="pf-hdr">
    <div class="pf-title">${p.title}</div>
    <div class="pf-subtitle">${p.subtitle || 'NCISM Specialty Case Proforma'}</div>
  </div>
  ${p.sections.map(_section).join('')}`;
}

function _section(s) {
  return `<div class="pf-section">
    <div class="pf-sec-title" onclick="this.parentElement.classList.toggle('pf-collapsed')">
      ${s.title}<span class="pf-chev">▾</span>
    </div>
    <div class="pf-sec-body">
      <div class="pf-grid">${s.fields.map(_field).join('')}</div>
    </div>
  </div>`;
}

function _field(f) {
  // Layout type: full-width vs half
  const cls = f.half ? 'pf-field pf-half' : 'pf-field';

  // Special layout-only types (no input)
  if (f.type === 'note') {
    return `<div class="pf-note ${f.tone || 'info'}">${f.content}</div>`;
  }
  if (f.type === 'heading') {
    return `<div class="pf-heading ${f.tone || ''}">${f.label}</div>`;
  }
  if (f.type === 'ayurveda_divider') {
    return `<div class="pf-ayurveda-divider"><span>🌿 ${f.label || 'Ayurveda Assessment'}</span></div>`;
  }
  if (f.type === 'score_calculator') {
    return _scoreCalculator(f);
  }

  let inp;
  switch (f.type) {
    case 'select':
      inp = `<select data-pf-id="${f.id}" class="pf-inp">
        <option value="">—</option>
        ${(f.options || []).map(o => `<option>${o}</option>`).join('')}
      </select>`;
      break;
    case 'radio':
      inp = `<div class="pf-radios">${(f.options || []).map(o =>
        `<label class="pf-rl"><input type="radio" data-pf-id="${f.id}" name="pf_${f.id}" value="${o}"> ${o}</label>`
      ).join('')}</div>`;
      break;
    case 'checkbox_group':
      inp = `<div class="pf-checks">${(f.options || []).map(o =>
        `<label class="pf-rl"><input type="checkbox" data-pf-id="${f.id}" value="${o}"> ${o}</label>`
      ).join('')}</div>`;
      break;
    case 'textarea':
      inp = `<textarea data-pf-id="${f.id}" class="pf-inp pf-ta" placeholder="${f.placeholder || ''}" rows="${f.rows || 2}"></textarea>`;
      break;
    case 'number':
      inp = f.unit
        ? `<div class="pf-unit-wrap"><input type="number" data-pf-id="${f.id}" class="pf-inp" placeholder="${f.placeholder || ''}"><span class="pf-unit">${f.unit}</span></div>`
        : `<input type="number" data-pf-id="${f.id}" class="pf-inp" placeholder="${f.placeholder || ''}">`;
      break;
    case 'date':
      inp = `<input type="date" data-pf-id="${f.id}" class="pf-inp">`;
      break;
    default: // text
      inp = `<input type="text" data-pf-id="${f.id}" class="pf-inp" placeholder="${f.placeholder || ''}">`;
  }

  const hint = f.hint ? `<div class="pf-hint">ℹ ${f.hint}</div>` : '';

  return `<div class="${cls}">
    <label class="pf-lbl">${f.label}${f.required ? ' <span class="pf-req">*</span>' : ''}</label>
    ${inp}${hint}
  </div>`;
}

// ── Score Calculators ─────────────────────────────

function _scoreCalculator(f) {
  if (f.calculator_id === 'pasi') return _pasiCalculator(f);
  if (f.calculator_id === 'iief5') return _iief5Calculator(f);
  return '';
}

function _pasiCalculator(f) {
  const regions = f.regions || [
    { id:'head',  label:'Head & Neck', weight:0.1 },
    { id:'trunk', label:'Trunk',       weight:0.3 },
    { id:'upper', label:'Upper Limbs', weight:0.2 },
    { id:'lower', label:'Lower Limbs', weight:0.4 },
  ];
  const areaOpts = f.area_scores  || ['0 — None','1 — <10%','2 — 10–29%','3 — 30–49%','4 — 50–69%','5 — 70–89%','6 — 90–100%'];
  const sevOpts  = f.severity_scores || ['0 — None','1 — Mild','2 — Moderate','3 — Marked','4 — Very marked'];

  const regionRows = regions.map(r => `
    <div class="pf-calc-region-label">${r.label} <span style="font-weight:400;font-size:10px;color:var(--text-muted)">(weight ×${r.weight})</span></div>
    <div class="pf-calc-field">
      <label>Area %</label>
      <select data-calc-id="pasi_${r.id}_area" onchange="_pfPasiCalc(this)">
        <option value="0">0</option>
        ${areaOpts.map((o,i) => `<option value="${i}">${o}</option>`).join('')}
      </select>
    </div>
    <div class="pf-calc-field">
      <label>Erythema (E)</label>
      <select data-calc-id="pasi_${r.id}_e" onchange="_pfPasiCalc(this)">
        ${sevOpts.map((o,i) => `<option value="${i}">${o}</option>`).join('')}
      </select>
    </div>
    <div class="pf-calc-field">
      <label>Induration (I)</label>
      <select data-calc-id="pasi_${r.id}_i" onchange="_pfPasiCalc(this)">
        ${sevOpts.map((o,i) => `<option value="${i}">${o}</option>`).join('')}
      </select>
    </div>
    <div class="pf-calc-field">
      <label>Scaling (S)</label>
      <select data-calc-id="pasi_${r.id}_s" onchange="_pfPasiCalc(this)">
        ${sevOpts.map((o,i) => `<option value="${i}">${o}</option>`).join('')}
      </select>
    </div>
    <div class="pf-calc-field">
      <label>Sub-score</label>
      <input type="text" data-calc-id="pasi_${r.id}_sub" readonly placeholder="auto" style="background:var(--cream);font-weight:600"/>
    </div>`).join('');

  return `<div class="pf-calc-box" data-calc-type="pasi">
    <div class="pf-calc-hdr">
      <span class="pf-calc-hdr-title">PASI Score Calculator</span>
      <span class="pf-calc-hdr-sub">Psoriasis Area & Severity Index (0–72)</span>
    </div>
    <div class="pf-calc-body">
      <div class="pf-calc-grid pasi-grid">${regionRows}</div>
      <div class="pf-calc-result" id="pasi_result">
        <div class="pf-calc-score" id="pasi_total">—</div>
        <div>
          <div class="pf-calc-interp" id="pasi_interp"></div>
          <div class="pf-calc-guide" id="pasi_guide">Enter values above to calculate</div>
        </div>
      </div>
      <input type="hidden" data-pf-id="${f.id}" id="pasi_hidden"/>
    </div>
  </div>`;
}

function _iief5Calculator(f) {
  const questions = f.questions || [
    { id:'q1', label:'Q1 — How do you rate your confidence in getting and maintaining an erection?',
      opts:['0 — No sexual activity','1 — Very low','2 — Low','3 — Moderate','4 — High','5 — Very high'] },
    { id:'q2', label:'Q2 — When you had erections with sexual stimulation, how often were they firm enough for penetration?',
      opts:['0 — No sexual activity','1 — Almost never/never','2 — A few times (<50%)','3 — Sometimes (~50%)','4 — Most times (>50%)','5 — Almost always/always'] },
    { id:'q3', label:'Q3 — During sexual intercourse, how often were you able to maintain your erection after penetration?',
      opts:['0 — Did not attempt intercourse','1 — Almost never/never','2 — A few times (<50%)','3 — Sometimes (~50%)','4 — Most times (>50%)','5 — Almost always/always'] },
    { id:'q4', label:'Q4 — During sexual intercourse, how difficult was it to maintain your erection to completion?',
      opts:['0 — Did not attempt intercourse','1 — Extremely difficult','2 — Very difficult','3 — Difficult','4 — Slightly difficult','5 — Not difficult'] },
    { id:'q5', label:'Q5 — When you attempted sexual intercourse, how often was it satisfactory for you?',
      opts:['0 — Did not attempt intercourse','1 — Almost never/never','2 — A few times (<50%)','3 — Sometimes (~50%)','4 — Most times (>50%)','5 — Almost always/always'] },
  ];

  const qRows = questions.map(q => `
    <div class="pf-iief-q">
      <label>${q.label}</label>
      <div class="pf-iief-opts">
        ${q.opts.map((o,i) => `<label class="pf-iief-opts"><input type="radio" name="iief_${q.id}" data-calc-id="iief_${q.id}" value="${i}" onchange="_pfIief5Calc(this)"> ${o}</label>`).join('')}
      </div>
    </div>`).join('');

  return `<div class="pf-calc-box" data-calc-type="iief5">
    <div class="pf-calc-hdr">
      <span class="pf-calc-hdr-title">IIEF-5 Score Calculator</span>
      <span class="pf-calc-hdr-sub">International Index of Erectile Function (5–25)</span>
    </div>
    <div class="pf-calc-body">
      <div class="pf-calc-grid" style="grid-template-columns:1fr">${qRows}</div>
      <div class="pf-calc-result" id="iief5_result" style="margin-top:12px">
        <div class="pf-calc-score" id="iief5_total">—</div>
        <div>
          <div class="pf-calc-interp" id="iief5_interp"></div>
          <div class="pf-calc-guide" id="iief5_guide">Answer all 5 questions to calculate</div>
        </div>
      </div>
      <input type="hidden" data-pf-id="${f.id}" id="iief5_hidden"/>
    </div>
  </div>`;
}

// ── Calculation logic (attached to window for inline handlers) ──

function _attachCalcListeners(containerEl) {
  // Expose calculators globally for inline onchange handlers
  window._pfPasiCalc = function(changed) {
    const box = changed.closest('[data-calc-type="pasi"]');
    if (!box) return;
    const regions = [
      { id:'head', weight:0.1 }, { id:'trunk', weight:0.3 },
      { id:'upper', weight:0.2 }, { id:'lower', weight:0.4 },
    ];
    let total = 0;
    let allFilled = true;
    regions.forEach(r => {
      const area = parseFloat(box.querySelector(`[data-calc-id="pasi_${r.id}_area"]`)?.value || 0);
      const e    = parseFloat(box.querySelector(`[data-calc-id="pasi_${r.id}_e"]`)?.value || 0);
      const i    = parseFloat(box.querySelector(`[data-calc-id="pasi_${r.id}_i"]`)?.value || 0);
      const s    = parseFloat(box.querySelector(`[data-calc-id="pasi_${r.id}_s"]`)?.value || 0);
      const sub  = r.weight * area * (e + i + s);
      total += sub;
      const subEl = box.querySelector(`[data-calc-id="pasi_${r.id}_sub"]`);
      if (subEl) subEl.value = sub.toFixed(1);
      if (area === 0 && e === 0 && i === 0 && s === 0) allFilled = false;
    });
    const score = parseFloat(total.toFixed(1));
    const scoreEl = document.getElementById('pasi_total');
    const interpEl = document.getElementById('pasi_interp');
    const guideEl  = document.getElementById('pasi_guide');
    const resultEl = document.getElementById('pasi_result');
    const hiddenEl = document.getElementById('pasi_hidden');
    if (scoreEl) scoreEl.textContent = score;
    if (hiddenEl) hiddenEl.value = score;
    let cls = 'green', interp = 'Clear / Minimal', guide = 'Score 0: Clear skin. No active treatment required.';
    if (score > 20)  { cls='red';   interp='Severe Psoriasis';   guide='Score >20: Systemic treatment / biologics / intensive Shodhana + Lepas.' }
    else if (score > 10) { cls='amber'; interp='Moderate Psoriasis'; guide='Score 10–20: Moderate — consider Virechana / phototherapy / potent topicals.' }
    else if (score > 0)  { cls='green'; interp='Mild Psoriasis';     guide='Score 1–10: Mild — topical therapy + Ayurveda Lepas / Gandusha + diet.' }
    if (resultEl) resultEl.className = `pf-calc-result ${cls}`;
    if (interpEl) { interpEl.textContent = interp; interpEl.style.color = cls === 'red' ? 'var(--red)' : cls === 'amber' ? '#7a5a00' : 'var(--green-deep)'; }
    if (guideEl)  guideEl.textContent = guide;
  };

  window._pfIief5Calc = function(changed) {
    const box = changed.closest('[data-calc-type="iief5"]');
    if (!box) return;
    let total = 0, answered = 0;
    ['q1','q2','q3','q4','q5'].forEach(q => {
      const checked = box.querySelector(`input[name="iief_${q}"]:checked`);
      if (checked) { total += parseInt(checked.value); answered++; }
    });
    const scoreEl  = document.getElementById('iief5_total');
    const interpEl = document.getElementById('iief5_interp');
    const guideEl  = document.getElementById('iief5_guide');
    const resultEl = document.getElementById('iief5_result');
    const hiddenEl = document.getElementById('iief5_hidden');
    if (answered < 5) {
      if (scoreEl) scoreEl.textContent = `${answered}/5`;
      if (guideEl) guideEl.textContent = `${5-answered} question(s) remaining`;
      return;
    }
    if (scoreEl)  scoreEl.textContent = total;
    if (hiddenEl) hiddenEl.value = total;
    let cls = 'green', interp = '', guide = '';
    if      (total <= 7)  { cls='red';   interp='Severe ED';            guide='Score 5–7: Severe dysfunction — investigation + Vajikarana Shodhana + hormone workup.' }
    else if (total <= 11) { cls='red';   interp='Moderate ED';          guide='Score 8–11: Moderate — vascular / hormonal screen + Ashwagandha / Kapikacchu.' }
    else if (total <= 16) { cls='amber'; interp='Mild–Moderate ED';     guide='Score 12–16: Likely psychogenic + mild vascular — Rasayana + Manasika Chikitsa.' }
    else if (total <= 21) { cls='amber'; interp='Mild ED';              guide='Score 17–21: Mild — lifestyle modification + Vajikarana Rasayana.' }
    else                  { cls='green'; interp='No Erectile Dysfunction'; guide='Score 22–25: Normal erectile function.' }
    if (resultEl) resultEl.className = `pf-calc-result ${cls}`;
    if (interpEl) { interpEl.textContent = interp; interpEl.style.color = cls === 'red' ? 'var(--red)' : cls === 'amber' ? '#7a5a00' : 'var(--green-deep)'; }
    if (guideEl)  guideEl.textContent = guide;
  };
}
