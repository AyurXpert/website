// Doctor IPD part 2 (Session 295) -- ward rounds inside doctor.html.
//
// Clicking an admitted patient in the IPD queue opens this view instead of a new ipd.html
// tab: header (bed, day of stay, diagnosis, flags) + a date-wise rail of previous rounds
// (newest first, like OPD Visit History) + today's round form. Previous rounds open in the
// shared #vh-panel side panel. Data: ward_round_notes (same table as ipd.html's SOAP
// drawer; extended by sql/session295e_ward_round_notes_v2.sql).
//
// Dr. Venkatesh's choices: SOAP + Ayurvedic daily assessment + the latest nursing vitals
// (snapshotted onto the note) + improvement % since the last round; several labelled
// rounds a day; PG / intern notes are saved "awaiting countersign" until a doctor
// countersigns (enforced server-side by trg_ward_round_guard + RLS).

let _c = null;        // { supabase, esc, tenantId, userId, isTrainee, toast, fmtDate }
let _adm = null;      // the open admission (row from doctor.js's IPD list)
let _notes = [];
let _vitals = null;   // latest nursing_vitals row
let _token = 0;

const ROUND_LABEL = { morning: 'Morning', evening: 'Evening', night: 'Night', emergency: 'Emergency', other: 'Other' };
// Day of stay in LOCAL dates (admission day = Day 1). admitted_at is a UTC timestamp, so
// its first 10 chars can be the previous day for an evening admission in IST -- use the
// admission_date column, else the timestamp converted to a local date.
const _localDate = d => (String(d).length === 10 ? String(d) : new Date(d).toLocaleDateString('en-CA'));
const _day = (a, d) => {
  const start = new Date(_localDate(a.admission_date || a.admitted_at) + 'T00:00:00');
  const end = new Date(_localDate(d) + 'T00:00:00');
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
};
const _fmtD = d => new Date(String(d).length === 10 ? d + 'T00:00:00' : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const _defaultLabel = () => { const h = new Date().getHours(); return h < 12 ? 'morning' : h < 20 ? 'evening' : 'night'; };
const _pctText = v => v > 0 ? `${v}% better` : v < 0 ? `${Math.abs(v)}% worse` : 'No change';

export function isIpdRoundOpen() { return !!_adm; }

export async function openIpdRound(adm, ctx) {
  _c = ctx; _adm = adm;
  const token = ++_token;
  const e = _c.esc;
  document.getElementById('welcome').style.display = 'none';
  document.getElementById('c-history').style.display = 'none';
  document.getElementById('c-ipd').style.display = '';
  window.closeVhPanel?.();

  const today = new Date();
  document.getElementById('ipdws-name').textContent = adm.patients?.name || '—';
  document.getElementById('ipdws-meta').textContent = [
    adm.beds?.ward_name, adm.beds?.bed_number ? 'Bed ' + adm.beds.bed_number : null, adm.departments?.name,
    `Day ${_day(adm, today)}${adm.advice?.expected_duration_days ? ' / ' + adm.advice.expected_duration_days : ''}`,
    adm.diagnosis_primary,
  ].filter(Boolean).join(' · ');
  document.getElementById('ipdws-flags').innerHTML = adm._flagsHtml || '';
  document.getElementById('ipdws-open').href = `ipd.html?admission_id=${encodeURIComponent(adm.id)}`;
  document.getElementById('ipdws-trainee-note').hidden = !_c.isTrainee;
  _resetForm();

  const [nR, vR] = await Promise.all([
    _c.supabase.from('ward_round_notes')
      .select('id, note_date, round_label, subjective, objective, assessment, plan, nadi, agni, mala, mutra, nidra, koshtha, improvement_pct, vitals_snapshot, author_is_trainee, countersigned_by, countersigned_at, created_at, doctor_id, profiles(full_name)')
      .eq('admission_id', adm.id).order('created_at', { ascending: false }),
    _c.supabase.from('nursing_vitals')
      .select('recorded_at, shift, temperature, pulse, respiratory_rate, spo2, bp_systolic, bp_diastolic, blood_sugar, pain_score, weight')
      .eq('admission_id', adm.id).order('recorded_at', { ascending: false }).limit(1),
  ]);
  if (token !== _token) return;
  if (nR.error) _c.toast?.('Could not load ward rounds: ' + nR.error.message, 'error');
  _notes = nR.data || [];
  _vitals = (vR.data || [])[0] || null;
  _renderVitals();
  _renderRail();
  void e;
}

export function closeIpdRound() {
  _token++; _adm = null; _notes = []; _vitals = null;
  window.closeVhPanel?.();
  const el = document.getElementById('c-ipd');
  if (el) el.style.display = 'none';
}
window.closeIpdRound = function() {
  closeIpdRound();
  document.getElementById('welcome').style.display = '';
};

function _resetForm() {
  ['ipdws-s', 'ipdws-o', 'ipdws-a', 'ipdws-p', 'ipdws-nadi', 'ipdws-mala', 'ipdws-mutra'].forEach(id => { document.getElementById(id).value = ''; });
  ['ipdws-agni', 'ipdws-nidra', 'ipdws-koshtha'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('ipdws-label').value = _defaultLabel();
  const imp = document.getElementById('ipdws-imp');
  window.progClear?.(imp);   // back to "Not recorded" (shared slider helper, visitTimeline.js)
  document.getElementById('ipdws-err').textContent = '';
}

function _vitalsLine(v) {
  if (!v) return '';
  const parts = [
    v.temperature != null ? `T ${v.temperature}°F` : null, v.pulse != null ? `P ${v.pulse}/min` : null,
    v.respiratory_rate != null ? `RR ${v.respiratory_rate}` : null, v.spo2 != null ? `SpO₂ ${v.spo2}%` : null,
    v.bp_systolic != null ? `BP ${v.bp_systolic}/${v.bp_diastolic ?? '—'}` : null,
    v.blood_sugar != null ? `Sugar ${v.blood_sugar}` : null, v.pain_score != null ? `Pain ${v.pain_score}/10` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
function _renderVitals() {
  const box = document.getElementById('ipdws-vitals');
  const e = _c.esc;
  box.innerHTML = _vitals
    ? `<strong>Latest nursing vitals</strong> <span class="ipdws-muted">(${e(new Date(_vitals.recorded_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))}${_vitals.shift ? ' · ' + e(_vitals.shift) : ''})</span><div>${e(_vitalsLine(_vitals)) || '—'}</div>`
    : '<span class="ipdws-muted">No nursing vitals recorded yet for this admission.</span>';
}

function _renderRail() {
  const e = _c.esc;
  document.getElementById('ipdws-count').textContent = `${_notes.length} round${_notes.length === 1 ? '' : 's'}`;
  document.getElementById('ipdws-list').innerHTML =
    `<div class="vh-item vh-today" aria-current="true"><span class="vh-date">Today — new round</span><span class="vh-sub">Day ${_day(_adm, new Date())}</span></div>` +
    (_notes.length ? _notes.map(n => {
      const tags = [
        n.author_is_trainee && !n.countersigned_at ? '<span class="vh-tag vh-tag-warn">PG/Intern · awaiting countersign</span>' : '',
        n.author_is_trainee && n.countersigned_at ? '<span class="vh-tag">✓ Countersigned</span>' : '',
        n.improvement_pct !== null && n.improvement_pct !== undefined ? `<span class="vh-tag vh-tag-prog">${n.improvement_pct > 0 ? '📈' : n.improvement_pct < 0 ? '📉' : '➖'} ${e(_pctText(n.improvement_pct))}</span>` : '',
      ].join('');
      return `<button type="button" class="vh-item" data-ipd-note="${n.id}" data-onclick="openIpdRoundNote" data-onclick-a0="${n.id}">
        <span class="vh-date">Day ${_day(_adm, n.note_date)} · ${e(_fmtD(n.note_date))}</span>
        <span class="vh-sub">${e(ROUND_LABEL[n.round_label] || 'Round')}${n.profiles?.full_name ? ' · ' + e(n.profiles.full_name) : ''}</span>
        ${n.assessment || n.subjective ? `<span class="vh-dx">${e(n.assessment || n.subjective)}</span>` : ''}
        ${tags ? `<span class="vh-tags">${tags}</span>` : ''}
      </button>`;
    }).join('') : '<div class="ipdws-muted" style="padding:10px">No rounds recorded yet.</div>');
}

const _row = (k, v) => v === null || v === undefined || String(v).trim() === '' ? '' :
  `<div class="vh-row"><span class="vh-k">${k}</span><span class="vh-v">${_c.esc(v)}</span></div>`;
const _sec = (t, b) => b ? `<section class="vh-sec"><h4>${t}</h4>${b}</section>` : '';

window.openIpdRoundNote = function(id) {
  const n = _notes.find(x => x.id === id);
  if (!n) return;
  document.querySelectorAll('#ipdws-list .vh-item.active').forEach(el => el.classList.remove('active'));
  document.querySelector(`#ipdws-list [data-ipd-note="${id}"]`)?.classList.add('active');
  document.getElementById('vh-panel-title').textContent = `Day ${_day(_adm, n.note_date)} · ${_fmtD(n.note_date)} · ${ROUND_LABEL[n.round_label] || 'Round'}`;
  document.getElementById('vh-panel-sub').textContent = [n.profiles?.full_name, n.author_is_trainee ? 'PG / Intern' : null,
    new Date(n.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ');
  const canSign = !_c.isTrainee && n.author_is_trainee && !n.countersigned_at;
  document.getElementById('vh-panel-body').innerHTML = [
    n.author_is_trainee ? `<div class="ipdws-sign ${n.countersigned_at ? 'ok' : 'wait'}">${n.countersigned_at
      ? '✓ Countersigned ' + _c.esc(new Date(n.countersigned_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }))
      : '⏳ PG / Intern note — awaiting a doctor’s countersign'}${canSign ? ` <button type="button" class="vh-btn vh-btn-primary" data-onclick="countersignIpdRound" data-onclick-a0="${n.id}">✓ Countersign</button>` : ''}</div>` : '',
    _sec('🌡 Vitals at the time', n.vitals_snapshot ? `<div class="vh-v">${_c.esc(_vitalsLine(n.vitals_snapshot))}</div>` : ''),
    _sec('📝 Subjective', _row('Complaints', n.subjective)),
    _sec('🩺 Objective', _row('Examination', n.objective)),
    _sec('🌿 Ayurvedic assessment', _row('Nadi', n.nadi) + _row('Agni', n.agni) + _row('Mala', n.mala) + _row('Mutra', n.mutra) + _row('Nidra', n.nidra) + _row('Koshtha', n.koshtha)),
    _sec('📈 Progress', n.improvement_pct === null || n.improvement_pct === undefined ? '' : _row('Since last round', _pctText(n.improvement_pct))),
    _sec('📋 Assessment', _row('Assessment', n.assessment)),
    _sec('➡ Plan', _row('Plan', n.plan)),
  ].join('') || '<div class="vh-empty">Empty note.</div>';
  const p = document.getElementById('vh-panel');
  p.classList.add('open');
  p.setAttribute('aria-hidden', 'false');
  window._vhRelayout?.();
  document.getElementById('vh-panel-close').focus();
};

window.countersignIpdRound = async function(id) {
  const { error } = await _c.supabase.from('ward_round_notes').update({ countersigned_by: _c.userId }).eq('id', id);
  if (error) { _c.toast?.('Could not countersign: ' + error.message, 'error'); return; }
  const n = _notes.find(x => x.id === id);
  if (n) n.countersigned_at = new Date().toISOString();
  _c.toast?.('Round note countersigned.', 'info');
  _renderRail();
  window.openIpdRoundNote(id);
};

window.saveIpdRound = async function() {
  if (!_adm || !_c) return;
  const v = id => document.getElementById(id).value.trim();
  const imp = document.getElementById('ipdws-imp');
  const note = {
    tenant_id: _c.tenantId, admission_id: _adm.id, doctor_id: _c.userId,
    note_date: new Date().toLocaleDateString('en-CA'), round_label: document.getElementById('ipdws-label').value,
    subjective: v('ipdws-s') || null, objective: v('ipdws-o') || null,
    assessment: v('ipdws-a') || null, plan: v('ipdws-p') || null,
    nadi: v('ipdws-nadi') || null, agni: v('ipdws-agni') || null, mala: v('ipdws-mala') || null,
    mutra: v('ipdws-mutra') || null, nidra: v('ipdws-nidra') || null, koshtha: v('ipdws-koshtha') || null,
    improvement_pct: imp.dataset.set === '1' ? Number(imp.value) : null,
    vitals_snapshot: _vitals,
  };
  const err = document.getElementById('ipdws-err');
  if (!note.subjective && !note.objective && !note.assessment && !note.plan) {
    err.textContent = 'Write at least one of Subjective, Objective, Assessment or Plan.';
    return;
  }
  const btn = document.getElementById('ipdws-save');
  btn.disabled = true; btn.textContent = 'Saving…'; err.textContent = '';
  const { data, error } = await _c.supabase.from('ward_round_notes').insert(note)
    .select('id, note_date, round_label, subjective, objective, assessment, plan, nadi, agni, mala, mutra, nidra, koshtha, improvement_pct, vitals_snapshot, author_is_trainee, countersigned_by, countersigned_at, created_at, doctor_id, profiles(full_name)').single();
  btn.disabled = false; btn.textContent = '✓ Save round note';
  if (error) { err.textContent = 'Could not save: ' + error.message; return; }
  _notes.unshift(data);
  _renderRail();
  _resetForm();
  _c.toast?.(data.author_is_trainee ? 'Round note saved — awaiting a doctor’s countersign.' : 'Round note saved.', 'info');
};
