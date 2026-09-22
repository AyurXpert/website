// pk-protocol-admin.js — Tenant-scoped Custom Panchakarma Protocols (Session 292).
//
// Lets a hospital's PK In-charge/dept_admin (or MD/Principal/MS/Deputy MS, per Dr.
// Venkatesh's explicit design call) author a brand-new PK treatment protocol -- schedule
// shape, SOP narrative, materials, and price -- submit it for approval, and have it appear
// in doctor.html's Care Plan wizard for THIS TENANT ONLY once approved. Tenant-scoped, not
// added to the shared platform-wide pk_sop_templates catalog every other hospital reads
// from (confirmed via AskUserQuestion before building).
//
// Client-side _canAuthor() mirrors the server-side _pk_custom_protocol_author_ok() for UI
// purposes only -- RLS is the real enforcement boundary (same pattern as sop-documents.js's
// own _canAuthor()/_canFinalize()).
//
// Reuses the existing generic maker-checker (request_approval()/pending_approvals/
// decide_approval()) for the approval decision itself -- decide_approval() already handles
// "who approves a given requester designation's request" generically, so this feature adds
// only ONE new action_type branch there, not new approval-chain logic. See
// sql/session292_tenant_custom_pk_protocols.sql for full detail.

import { requireAuth, getCurrentTenantId, getCurrentProfile, getCurrentRole, getCurrentSecondaryRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { escapeHtml as _esc } from '../utils/validators.js';

await requireAuth([]);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const profile  = getCurrentProfile();
const role     = getCurrentRole();
const secondaryRole = getCurrentSecondaryRole();

const STATUS_LABEL = { draft: 'Draft', pending_approval: 'Pending Approval', approved: 'Approved', rejected: 'Rejected' };
const AUTHOR_DESIGNATIONS = ['pk_incharge', 'medical_director', 'principal', 'medical_superintendent', 'deputy_medical_superintendent'];

let _protocols = [];   // pk_custom_sop_templates rows for this tenant
let _editingId = null; // protocol id currently loaded into the form, or null for "new"
let _days = [];        // working array of {day_start,day_end,phase,activity_label,sequence_order}
let _materials = [];   // working array of {item_name,quantity,unit,sequence_order}

function _canAuthor() {
  return role === 'super_admin' || role === 'dept_admin' || secondaryRole === 'dept_admin'
    || AUTHOR_DESIGNATIONS.includes(profile?.designation);
}

function _toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { el.className = 'toast'; }, 2600);
}

function _slugify(s) {
  return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'custom_protocol';
}

window._onDisplayNameChange = function(inputEl) {
  const keyInp = document.getElementById('f-procedure-key');
  // Only auto-derive while the key field hasn't been hand-edited away from what the name
  // would produce -- once a doctor edits the key directly, typing more of the name
  // shouldn't silently overwrite their choice.
  if (!keyInp.dataset.touched) keyInp.value = _slugify(inputEl.value);
};
document.addEventListener('DOMContentLoaded', () => {
  const keyInp = document.getElementById('f-procedure-key');
  if (keyInp) keyInp.addEventListener('input', () => { keyInp.dataset.touched = '1'; });
});

async function loadProtocolList() {
  if (!_canAuthor()) {
    document.getElementById('no-access-banner').style.display = 'block';
    document.getElementById('list-card').style.display = 'none';
    document.getElementById('btn-new-protocol').disabled = true;
    return;
  }
  const { data, error } = await supabase.from('pk_custom_sop_templates')
    .select('id,display_name,procedure_key,status,price_amount,updated_at,submitted_at,approved_at')
    .eq('tenant_id', tenantId).order('updated_at', { ascending: false });
  const body = document.getElementById('protocol-list-body');
  if (error) { body.innerHTML = `<tr><td colspan="5" style="padding:24px;text-align:center;color:var(--error-text)">${_esc(safeErrorMessage(error, 'Could not load protocols.'))}</td></tr>`; return; }
  _protocols = data || [];
  if (!_protocols.length) {
    body.innerHTML = `<tr><td colspan="5"><div class="empty"><div class="empty-icon">🌿</div><div class="empty-text">No custom protocols yet — add your hospital's first one.</div></div></td></tr>`;
    return;
  }
  body.innerHTML = _protocols.map(p => {
    const canEdit = ['draft', 'rejected'].includes(p.status);
    return `<tr>
      <td><strong>${_esc(p.display_name)}</strong><div style="font-size:11px;color:var(--text-muted)">${_esc(p.procedure_key)}</div></td>
      <td><span class="status-badge status-${_esc(p.status)}">${_esc(STATUS_LABEL[p.status] || p.status)}</span></td>
      <td>${p.price_amount != null ? '₹' + _esc(String(p.price_amount)) : '—'}</td>
      <td style="font-size:12px;color:var(--text-muted)">${new Date(p.updated_at).toLocaleDateString('en-IN')}</td>
      <td>
        ${canEdit ? `<button class="act-btn act-edit" data-onclick="editProtocol" data-onclick-a0="${_esc(p.id)}">✏️ Edit</button>` : ''}
        ${canEdit ? `<button class="act-btn act-delete" data-onclick="deleteProtocol" data-onclick-a0="${_esc(p.id)}">🗑 Delete</button>` : ''}
        ${!canEdit ? '<span style="font-size:11px;color:var(--text-muted)">—</span>' : ''}
      </td>
    </tr>`;
  }).join('');
}

window.openNewProtocolForm = function() {
  if (!_canAuthor()) { _toast('You are not authorized to add a protocol.', true); return; }
  _editingId = null;
  _days = [];
  _materials = [];
  ['f-display-name','f-procedure-key','f-default-notes','f-indications','f-contraindications',
   'f-precautions','f-complications','f-purva','f-pradhana','f-paschat','f-price','f-price-label','f-submit-reason']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('f-procedure-key').dataset.touched = '';
  document.getElementById('form-title').textContent = 'New PK Treatment Protocol';
  document.getElementById('form-status-hint').textContent = '';
  _renderDaysList();
  _renderMaterialsList();
  document.getElementById('protocol-form').classList.add('open');
  document.getElementById('protocol-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.closeProtocolForm = function() {
  document.getElementById('protocol-form').classList.remove('open');
  _editingId = null;
};

window.editProtocol = async function(id) {
  const { data: proto, error } = await supabase.from('pk_custom_sop_templates').select('*').eq('id', id).single();
  if (error || !proto) { _toast('Could not load this protocol.', true); return; }
  const { data: days } = await supabase.from('pk_custom_sop_template_days').select('*').eq('protocol_id', id).order('sequence_order');
  const { data: materials } = await supabase.from('pk_custom_sop_template_materials').select('*').eq('protocol_id', id).order('sequence_order');

  _editingId = id;
  _days = (days || []).map(d => ({ day_start: d.day_start, day_end: d.day_end, phase: d.phase, activity_label: d.activity_label, sequence_order: d.sequence_order }));
  _materials = (materials || []).map(m => ({ item_name: m.item_name, quantity: m.quantity, unit: m.unit, sequence_order: m.sequence_order }));

  document.getElementById('f-display-name').value = proto.display_name || '';
  const keyInp = document.getElementById('f-procedure-key');
  keyInp.value = proto.procedure_key || '';
  keyInp.dataset.touched = '1';
  document.getElementById('f-default-notes').value = proto.default_notes || '';
  document.getElementById('f-indications').value = proto.indications || '';
  document.getElementById('f-contraindications').value = proto.contraindications || '';
  document.getElementById('f-precautions').value = proto.precautions || '';
  document.getElementById('f-complications').value = proto.complications_management || '';
  document.getElementById('f-purva').value = proto.purva_karma_text || '';
  document.getElementById('f-pradhana').value = proto.pradhana_karma_text || '';
  document.getElementById('f-paschat').value = proto.paschat_karma_text || '';
  document.getElementById('f-price').value = proto.price_amount != null ? proto.price_amount : '';
  document.getElementById('f-price-label').value = proto.price_label || '';
  document.getElementById('f-submit-reason').value = '';

  document.getElementById('form-title').textContent = `Editing: ${proto.display_name}`;
  document.getElementById('form-status-hint').textContent = proto.status === 'rejected'
    ? '⚠ This protocol was rejected — revise it below, then submit again.' : '';
  _renderDaysList();
  _renderMaterialsList();
  document.getElementById('protocol-form').classList.add('open');
  document.getElementById('protocol-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.deleteProtocol = async function(id) {
  if (!confirm('Delete this draft protocol? This cannot be undone.')) return;
  const { error } = await supabase.from('pk_custom_sop_templates').delete().eq('id', id);
  if (error) { _toast(safeErrorMessage(error, 'Could not delete.'), true); return; }
  _toast('Deleted.');
  if (_editingId === id) window.closeProtocolForm();
  loadProtocolList();
};

// ── Day / Material row builders ─────────────────────────────────────────────
// Values match pk_care_plan_days.phase's own CHECK constraint exactly (no underscore) --
// the save path passes this straight through unchanged.
const PHASE_LABEL = { purvakarma: 'Purvakarma', pradhanakarma: 'Pradhanakarma', paschatkarma: 'Paschatkarma' };

function _renderDaysList() {
  const wrap = document.getElementById('days-list');
  if (!_days.length) { wrap.innerHTML = '<div class="hint">No schedule days added yet.</div>'; return; }
  wrap.innerHTML = _days.map((d, i) => `
    <div class="row-list-item">
      <span>Day ${_esc(String(d.day_start))}${d.day_end !== d.day_start ? '–' + _esc(String(d.day_end)) : ''} · ${_esc(PHASE_LABEL[d.phase] || d.phase)} · ${_esc(d.activity_label)}</span>
      <button type="button" class="row-remove" data-onclick="_removeDayRow" data-onclick-a0="${i}">✕</button>
    </div>`).join('');
}
function _renderMaterialsList() {
  const wrap = document.getElementById('materials-list');
  if (!_materials.length) { wrap.innerHTML = '<div class="hint">No materials added yet.</div>'; return; }
  wrap.innerHTML = _materials.map((m, i) => `
    <div class="row-list-item">
      <span>${_esc(m.item_name)}${m.quantity != null ? ` (${m.quantity}${_esc(m.unit || '')})` : ''}</span>
      <button type="button" class="row-remove" data-onclick="_removeMaterialRow" data-onclick-a0="${i}">✕</button>
    </div>`).join('');
}

window._addDayRow = function() {
  const start = Number(document.getElementById('d-start').value);
  const end = Number(document.getElementById('d-end').value) || start;
  const phase = document.getElementById('d-phase').value;
  const activity = document.getElementById('d-activity').value.trim();
  if (!start || !activity) { _toast('Enter a day start and an activity label.', true); return; }
  _days.push({ day_start: start, day_end: end, phase, activity_label: activity, sequence_order: _days.length });
  document.getElementById('d-start').value = '';
  document.getElementById('d-end').value = '';
  document.getElementById('d-activity').value = '';
  _renderDaysList();
};
window._removeDayRow = function(i) { _days.splice(Number(i), 1); _days.forEach((d, idx) => d.sequence_order = idx); _renderDaysList(); };

window._addMaterialRow = function() {
  const item = document.getElementById('m-item').value.trim();
  const qty = document.getElementById('m-qty').value;
  const unit = document.getElementById('m-unit').value;
  if (!item) { _toast('Enter a material/item name.', true); return; }
  _materials.push({ item_name: item, quantity: qty ? Number(qty) : null, unit, sequence_order: _materials.length });
  document.getElementById('m-item').value = '';
  document.getElementById('m-qty').value = '';
  _renderMaterialsList();
};
window._removeMaterialRow = function(i) { _materials.splice(Number(i), 1); _materials.forEach((m, idx) => m.sequence_order = idx); _renderMaterialsList(); };

// ── Save / Submit ────────────────────────────────────────────────────────────
function _collectHeaderFields() {
  return {
    display_name: document.getElementById('f-display-name').value.trim(),
    procedure_key: _slugify(document.getElementById('f-procedure-key').value),
    default_notes: document.getElementById('f-default-notes').value.trim() || null,
    indications: document.getElementById('f-indications').value.trim() || null,
    contraindications: document.getElementById('f-contraindications').value.trim() || null,
    precautions: document.getElementById('f-precautions').value.trim() || null,
    complications_management: document.getElementById('f-complications').value.trim() || null,
    purva_karma_text: document.getElementById('f-purva').value.trim() || null,
    pradhana_karma_text: document.getElementById('f-pradhana').value.trim() || null,
    paschat_karma_text: document.getElementById('f-paschat').value.trim() || null,
  };
}

// Returns the saved protocol id, or null on failure (already toasted).
async function _persistDraft() {
  const fields = _collectHeaderFields();
  if (!fields.display_name) { _toast('Enter a display name.', true); return null; }
  if (!_days.length) { _toast('Add at least one schedule day.', true); return null; }

  let protocolId = _editingId;
  if (protocolId) {
    const { error } = await supabase.from('pk_custom_sop_templates').update(fields).eq('id', protocolId);
    if (error) { _toast(safeErrorMessage(error, 'Could not save.'), true); return null; }
  } else {
    const { data, error } = await supabase.from('pk_custom_sop_templates')
      .insert({ tenant_id: tenantId, created_by: profile.id, ...fields }).select('id').single();
    if (error) { _toast(safeErrorMessage(error, 'Could not save — is the protocol key already used?'), true); return null; }
    protocolId = data.id;
    _editingId = protocolId;
  }

  // Replace-all-children sync (same pattern used elsewhere in this codebase for a
  // freely-re-orderable child list) -- simpler and safer than diffing row-by-row.
  await supabase.from('pk_custom_sop_template_days').delete().eq('protocol_id', protocolId);
  if (_days.length) {
    const { error: dErr } = await supabase.from('pk_custom_sop_template_days')
      .insert(_days.map(d => ({ ...d, protocol_id: protocolId })));
    if (dErr) { _toast(safeErrorMessage(dErr, 'Could not save the schedule.'), true); return null; }
  }
  await supabase.from('pk_custom_sop_template_materials').delete().eq('protocol_id', protocolId);
  if (_materials.length) {
    const { error: mErr } = await supabase.from('pk_custom_sop_template_materials')
      .insert(_materials.map(m => ({ ...m, protocol_id: protocolId })));
    if (mErr) { _toast(safeErrorMessage(mErr, 'Could not save the materials.'), true); return null; }
  }

  const priceVal = document.getElementById('f-price').value;
  if (priceVal !== '') {
    const { error: fErr } = await supabase.rpc('create_pk_custom_protocol_fee', {
      p_protocol_id: protocolId, p_amount: Number(priceVal), p_label: document.getElementById('f-price-label').value.trim() || null,
    });
    if (fErr) { _toast(safeErrorMessage(fErr, 'Saved, but could not save the price.'), true); }
  }

  return protocolId;
}

window.saveProtocolDraft = async function() {
  const btn = document.getElementById('btn-save-draft');
  btn.disabled = true;
  const id = await _persistDraft();
  btn.disabled = false;
  if (!id) return;
  _toast('Draft saved.');
  window.closeProtocolForm();
  await loadProtocolList();
};

window.submitProtocolForApproval = async function() {
  const btn = document.getElementById('btn-submit-approval');
  btn.disabled = true;
  const id = await _persistDraft();
  if (!id) { btn.disabled = false; return; }

  const reason = document.getElementById('f-submit-reason').value.trim() || null;
  const { error } = await supabase.rpc('request_pk_custom_protocol_approval', { p_protocol_id: id, p_reason: reason });
  btn.disabled = false;
  if (error) { _toast(safeErrorMessage(error, 'Could not submit for approval.'), true); return; }
  _toast('Submitted for approval — visible in HR → Approvals for your decider.');
  window.closeProtocolForm();
  await loadProtocolList();
};

loadProtocolList();
