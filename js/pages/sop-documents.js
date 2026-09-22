// sop-documents.js — Tenant SOP Document Generator (Session 249).
//
// Section 6 of PANCHAKARMA_SOP_EXPANSION_CHECKLIST.md. A department head (or, for
// Panchakarma specifically, the resolved pk_incharge) drafts their tenant's own version of
// a protocol's SOP starting from the platform default (sop_content_templates), edits it,
// submits it for review, and their Medical Director/Principal/Medical Superintendent
// approves or sends it back. Once finalized, it prints under the tenant's own letterhead
// (same branding element IDs as printInvoice.js, reused verbatim) for registration via the
// existing sop-library.html upload flow -- this page never writes to sop_documents itself,
// that stays the tenant's own manual step (locked decision, see checklist §6).
//
// Client-side _canAuthor()/_canFinalize() mirror the server-side _sop_doc_author_ok()/
// _sop_doc_finalize_ok() functions for UI purposes only -- RLS is the real enforcement
// boundary, these just decide what buttons to show.

import { requireAuth, getCurrentTenantId, getCurrentTenant, getCurrentProfile, getCurrentRole, getCurrentSecondaryRole } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';
import { escapeHtml as _esc } from '../utils/validators.js';

await requireAuth([]);
initNavbar();
wireDelegatedEvents();

const tenantId = getCurrentTenantId();
const tenant   = getCurrentTenant();
const profile  = getCurrentProfile();
const role     = getCurrentRole();
const secondaryRole = getCurrentSecondaryRole();

let _department  = 'panchakarma';
let _templates    = [];  // sop_content_templates rows for _department (platform defaults)
let _docs         = {};  // procedure_key -> sop_tenant_documents row (this tenant, this department)
let _selectedKey  = null;

const STATUS_LABEL = { draft: 'Draft', pending_review: 'Pending Review', finalized: 'Finalized' };

function _toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { el.className = 'toast'; }, 2200);
}

function _canAuthor(department) {
  if (role === 'super_admin' || role === 'dept_admin' || secondaryRole === 'dept_admin') return true;
  if (department === 'panchakarma' && profile?.designation === 'pk_incharge') return true;
  return false;
}
function _canFinalize() {
  return role === 'super_admin' || ['medical_director', 'principal', 'medical_superintendent'].includes(profile?.designation);
}

async function _loadDepartments() {
  // Session 285 -- age_band='pediatric' rows (Basti pediatric narrative) share a
  // department+procedure_key with their adult counterpart; filtered out here so this
  // page's department list/lookup keeps its pre-existing one-row-per-procedure-key
  // assumption exactly as before -- the pediatric content is consumed by doctor.html's
  // Care Plan wizard directly, not (yet) by this tenant-letterhead SOP generator.
  const { data } = await supabase.from('sop_content_templates').select('department').eq('age_band', 'adult').order('department');
  const depts = [...new Set((data || []).map(d => d.department))];
  const sel = document.getElementById('dept-select');
  sel.innerHTML = depts.map(d => `<option value="${_esc(d)}">${_esc(d.charAt(0).toUpperCase() + d.slice(1))}</option>`).join('')
    || '<option value="">— No departments have SOP content yet —</option>';
  if (depts.length) _department = depts.includes(_department) ? _department : depts[0];
  sel.value = _department;
}

window.onDeptChange = function(sel) {
  _department = sel.value;
  document.getElementById('detail-card').style.display = 'none';
  _selectedKey = null;
  loadProtocols();
};

async function loadProtocols() {
  if (!_department) { document.getElementById('proto-list').innerHTML = '<div class="empty">No content yet.</div>'; return; }

  const [{ data: templates }, { data: docs }] = await Promise.all([
    supabase.from('sop_content_templates').select('*').eq('department', _department).eq('age_band', 'adult').order('display_name'),
    supabase.from('sop_tenant_documents').select('*').eq('tenant_id', tenantId).eq('department', _department),
  ]);
  _templates = templates || [];
  _docs = {};
  (docs || []).forEach(d => { _docs[d.procedure_key] = d; });

  _renderProtoList();
}

function _renderProtoList() {
  const el = document.getElementById('proto-list');
  if (!_templates.length) { el.innerHTML = '<div class="empty">No SOP content for this department yet.</div>'; return; }

  el.innerHTML = _templates.map(t => {
    const doc = _docs[t.procedure_key];
    const status = doc?.status || 'none';
    return `<div class="proto-row">
      <span class="proto-name" data-onclick="selectProtocol" data-onclick-a0="${_esc(t.procedure_key)}">${_esc(t.display_name)}</span>
      <span class="status-tag status-${status}">${status === 'none' ? 'Not started' : STATUS_LABEL[status]}</span>
    </div>`;
  }).join('');
}

window.selectProtocol = function(procedureKey) {
  _selectedKey = procedureKey;
  _renderDetail();
};

function _renderDetail() {
  const card = document.getElementById('detail-card');
  const tpl = _templates.find(t => t.procedure_key === _selectedKey);
  if (!tpl) { card.style.display = 'none'; return; }
  const doc = _docs[_selectedKey];
  card.style.display = '';

  if (!doc) { _renderNotStarted(card, tpl); return; }
  if (doc.status === 'finalized') { _renderFinalized(card, doc); return; }
  if (doc.status === 'pending_review') { _renderPendingReview(card, doc); return; }
  _renderDraft(card, doc);
}

function _renderNotStarted(card, tpl) {
  const canStart = _canAuthor(_department);
  card.innerHTML = `
    <div class="card-title">${_esc(tpl.display_name)} — not started</div>
    <div class="note">Platform default shown below for reference. Starting a draft copies this content into your own editable version — nothing here is printed until you draft, edit, and get it finalized.</div>
    ${_renderReadonlyContent(tpl)}
    ${canStart
      ? `<button class="btn btn-primary" data-onclick="startDraft" data-onclick-a0="${_esc(tpl.procedure_key)}">Start Draft from Platform Default</button>`
      : `<div class="empty">Only your department head or admin can start a draft for this protocol.</div>`}
  `;
}

window.startDraft = async function(procedureKey) {
  const tpl = _templates.find(t => t.procedure_key === procedureKey);
  if (!tpl) return;
  const { error } = await supabase.from('sop_tenant_documents').insert({
    tenant_id: tenantId, department: _department, procedure_key: procedureKey,
    source_template_id: tpl.id, display_name: tpl.display_name,
    purva_karma_text: tpl.purva_karma_text, pradhana_karma_text: tpl.pradhana_karma_text, paschat_karma_text: tpl.paschat_karma_text,
    indications: tpl.indications, contraindications: tpl.contraindications, precautions: tpl.precautions,
    complications_management: tpl.complications_management,
    typical_duration_minutes: tpl.typical_duration_minutes, man_power_staff: tpl.man_power_staff,
    drafted_by: profile.id, status: 'draft',
  });
  if (error) { _toast(safeErrorMessage(error, 'Could not start a draft.'), true); return; }
  _toast('Draft started.');
  await loadProtocols();
  _renderDetail();
};

function _renderDraft(card, doc) {
  const canEdit = doc.status === 'draft' && _canAuthor(_department);
  const f = (label, key, isTextarea = true) => `
    <div class="field"><label>${_esc(label)}</label>
      ${isTextarea
        ? `<textarea id="f-${key}" ${canEdit ? '' : 'readonly'}>${_esc(doc[key] || '')}</textarea>`
        : `<input id="f-${key}" type="number" min="0" value="${doc[key] ?? ''}" ${canEdit ? '' : 'readonly'}/>`}
    </div>`;

  card.innerHTML = `
    <div class="card-title">${_esc(doc.display_name)} — <span class="status-tag status-draft">Draft</span></div>
    ${canEdit ? '' : '<div class="note">Read-only — you are not this document\'s author, or it has left draft status.</div>'}
    ${f('Purva Karma (pre-procedure)', 'purva_karma_text')}
    ${f('Pradhana Karma (main procedure)', 'pradhana_karma_text')}
    ${f('Paschat Karma (post-procedure)', 'paschat_karma_text')}
    ${f('Indications', 'indications')}
    ${f('Contraindications', 'contraindications')}
    ${f('Precautions', 'precautions')}
    ${f('Complications & Management', 'complications_management')}
    <div class="field-row">
      ${f('Typical Duration (minutes)', 'typical_duration_minutes', false)}
      ${f('Staff Required', 'man_power_staff', false)}
    </div>
    ${canEdit ? `
      <button class="btn btn-secondary" data-onclick="saveDraft" data-onclick-a0="${_esc(doc.id)}" style="margin-right:8px">Save</button>
      <button class="btn btn-primary" data-onclick="submitForReview" data-onclick-a0="${_esc(doc.id)}">Submit for Review</button>
    ` : ''}
  `;
}

window.saveDraft = async function(docId) {
  const payload = {
    purva_karma_text: document.getElementById('f-purva_karma_text').value.trim() || null,
    pradhana_karma_text: document.getElementById('f-pradhana_karma_text').value.trim() || null,
    paschat_karma_text: document.getElementById('f-paschat_karma_text').value.trim() || null,
    indications: document.getElementById('f-indications').value.trim() || null,
    contraindications: document.getElementById('f-contraindications').value.trim() || null,
    precautions: document.getElementById('f-precautions').value.trim() || null,
    complications_management: document.getElementById('f-complications_management').value.trim() || null,
    typical_duration_minutes: document.getElementById('f-typical_duration_minutes').value ? Number(document.getElementById('f-typical_duration_minutes').value) : null,
    man_power_staff: document.getElementById('f-man_power_staff').value ? Number(document.getElementById('f-man_power_staff').value) : null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('sop_tenant_documents').update(payload).eq('id', docId);
  if (error) { _toast(safeErrorMessage(error, 'Could not save.'), true); return; }
  _toast('Saved.');
  await loadProtocols();
  _renderDetail();
};

window.submitForReview = async function(docId) {
  await window.saveDraft(docId); // save latest edits first
  const { error } = await supabase.rpc('submit_sop_document_for_review', { p_doc_id: docId });
  if (error) { _toast(safeErrorMessage(error, 'Could not submit for review.'), true); return; }
  _toast('Submitted for review.');
  await loadProtocols();
  _renderDetail();
};

function _renderPendingReview(card, doc) {
  const canDecide = _canFinalize();
  card.innerHTML = `
    <div class="card-title">${_esc(doc.display_name)} — <span class="status-tag status-pending_review">Pending Review</span></div>
    ${_renderReadonlyContent(doc)}
    ${canDecide ? `
      <div class="field"><label>Review Notes (optional)</label><textarea id="review-notes" placeholder="Notes for the drafting author, especially if sending back"></textarea></div>
      <button class="btn btn-primary" data-onclick="decideDoc" data-onclick-a0="${_esc(doc.id)}" data-onclick-a1="@true" style="margin-right:8px">Approve &amp; Finalize</button>
      <button class="btn btn-danger" data-onclick="decideDoc" data-onclick-a0="${_esc(doc.id)}" data-onclick-a1="@false">Send Back to Draft</button>
    ` : `<div class="empty">Awaiting review by your Medical Director/Principal/Medical Superintendent.</div>`}
  `;
}

window.decideDoc = async function(docId, approve) {
  const notes = document.getElementById('review-notes')?.value.trim() || null;
  const { error } = await supabase.rpc('decide_sop_document', { p_doc_id: docId, p_approve: approve, p_notes: notes });
  if (error) { _toast(safeErrorMessage(error, 'Could not record the decision.'), true); return; }
  _toast(approve ? 'Finalized.' : 'Sent back to draft.');
  await loadProtocols();
  _renderDetail();
};

function _renderFinalized(card, doc) {
  card.innerHTML = `
    <div class="card-title">${_esc(doc.display_name)} — <span class="status-tag status-finalized">Finalized</span></div>
    ${_renderReadonlyContent(doc)}
    <button class="btn btn-primary" data-onclick="printDoc" data-onclick-a0="${_esc(doc.id)}">🖨️ Print for Letterhead</button>
  `;
}

function _renderReadonlyContent(d) {
  const row = (label, val) => val ? `<div class="field"><label>${_esc(label)}</label><div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${_esc(val)}</div></div>` : '';
  return `
    ${row('Purva Karma (pre-procedure)', d.purva_karma_text)}
    ${row('Pradhana Karma (main procedure)', d.pradhana_karma_text)}
    ${row('Paschat Karma (post-procedure)', d.paschat_karma_text)}
    ${row('Indications', d.indications)}
    ${row('Contraindications', d.contraindications)}
    ${row('Precautions', d.precautions)}
    ${row('Complications & Management', d.complications_management)}
    ${(d.typical_duration_minutes || d.man_power_staff) ? `<div class="field"><label>Duration / Staff</label><div style="font-size:13px">${d.typical_duration_minutes ? d.typical_duration_minutes + ' min' : ''}${d.typical_duration_minutes && d.man_power_staff ? ' · ' : ''}${d.man_power_staff ? d.man_power_staff + ' staff' : ''}</div></div>` : ''}
  `;
}

window.printDoc = function(docId) {
  const doc = Object.values(_docs).find(d => d.id === docId);
  if (!doc) return;

  document.getElementById('clinicName').innerText = tenant?.name || 'AyurXpert HMS';
  if (tenant?.tagline) { const el = document.getElementById('clinicTagline'); el.textContent = tenant.tagline; el.style.display = ''; }
  const addr = tenant?.full_address || tenant?.address;
  if (addr) { const el = document.getElementById('clinicAddress'); el.textContent = addr; el.style.display = ''; }
  if (tenant?.gstin) { const el = document.getElementById('clinicGstin'); el.textContent = `GSTIN: ${tenant.gstin}`; el.style.display = ''; }
  if (tenant?.logo_url) { const img = document.getElementById('clinic-logo'); img.src = tenant.logo_url; img.style.display = ''; }

  document.getElementById('print-doc-title').textContent = doc.display_name;
  document.getElementById('print-doc-meta').textContent = `Department: ${_department.charAt(0).toUpperCase() + _department.slice(1)} · Finalized ${doc.reviewed_at ? new Date(doc.reviewed_at).toLocaleDateString('en-IN') : ''}`;
  document.getElementById('print-doc-footer-date').textContent = `Printed ${new Date().toLocaleDateString('en-IN')}`;

  const section = (label, val) => val ? `<div class="print-section"><div class="print-section-label">${_esc(label)}</div><div class="print-section-body">${_esc(val)}</div></div>` : '';
  document.getElementById('print-doc-body').innerHTML = [
    section('Purva Karma (Pre-Procedure)', doc.purva_karma_text),
    section('Pradhana Karma (Main Procedure)', doc.pradhana_karma_text),
    section('Paschat Karma (Post-Procedure)', doc.paschat_karma_text),
    section('Indications', doc.indications),
    section('Contraindications', doc.contraindications),
    section('Precautions', doc.precautions),
    section('Complications & Management', doc.complications_management),
    (doc.typical_duration_minutes || doc.man_power_staff) ? section('Duration / Staff Required', `${doc.typical_duration_minutes ? doc.typical_duration_minutes + ' minutes' : ''}${doc.typical_duration_minutes && doc.man_power_staff ? ' · ' : ''}${doc.man_power_staff ? doc.man_power_staff + ' staff' : ''}`) : '',
  ].join('');

  // #print-doc is display:none on screen and display:block!important only inside
  // @media print (see sop-documents.html) -- no manual style toggling needed here, and
  // toggling it from JS previously left the element visible in normal layout flow with
  // visibility:hidden siblings still reserving their full height, which is what caused
  // the extra blank pages found live-testing this.
  window.print();
};

await _loadDepartments();
await loadProtocols();
