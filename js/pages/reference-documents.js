// Session 377a: the read-only Reference shelf. The server decides who sees a row and its file (reference_documents +
// the private bucket reference-documents, sql/session377a_reference_shelf_sop_register.sql); this page only shows them.
// A row without its label is never shown: the label says what the document is.
import { requireAuth } from '../core/auth.js';
import { initNavbar } from '../components/navbar.js';
import { supabase } from '../core/db/supabaseClient.js';
import { wireDelegatedEvents } from '../utils/domEvents.js';
import { safeErrorMessage } from '../utils/errors.js';

const BUCKET = 'reference-documents';
const LINK_SECONDS = 600;
const LINK_RENEW_MS = 8 * 60 * 1000;

await requireAuth([], 'index.html');
initNavbar();
wireDelegatedEvents();

let _docs = [];
let _linksAt = 0;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function showError(text) {
  const box = document.getElementById('ref-error');
  box.textContent = text;
  box.hidden = !text;
  document.getElementById('ref-retry').hidden = !text;
}

function renderCard(d) {
  const card = el('article', 'ref-card');
  card.append(el('div', 'ref-cat', d.category), el('h2', 'ref-title', d.title), el('div', 'ref-label', d.label));
  card.append(el('div', 'ref-meta', `Source: ${d.source}`));
  if (d.notification_no) {
    card.append(el('div', 'ref-meta', `Notification: ${d.notification_no}${d.notification_date ? `, dated ${d.notification_date}` : ''}`));
  }
  const actions = el('div', 'ref-actions');
  const link = el('a', 'btn btn-primary', 'Preparing the file…');
  link.id = `ref-open-${d.id}`;
  link.rel = 'noopener';
  link.target = '_blank';
  link.setAttribute('aria-disabled', 'true');
  const note = el('div', 'ref-file-err');
  note.id = `ref-file-err-${d.id}`;
  note.hidden = true;
  actions.append(link, note);
  card.append(actions);
  return card;
}

// The link is prepared at page load, not on the click, so opening it is a plain link and is never blocked as a pop-up
async function prepareLinks() {
  _linksAt = Date.now();
  await Promise.all(_docs.map(async d => {
    const link = document.getElementById(`ref-open-${d.id}`);
    const note = document.getElementById(`ref-file-err-${d.id}`);
    if (!link || !note) return;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(d.file_path, LINK_SECONDS);
    if (error || !data?.signedUrl) {
      link.hidden = true;
      link.removeAttribute('href');
      note.textContent = 'This file could not be opened just now. Please reload the page.';
      note.hidden = false;
      return;
    }
    link.href = data.signedUrl;
    link.textContent = 'Open PDF';
    link.hidden = false;
    link.removeAttribute('aria-disabled');
    note.hidden = true;
  }));
}

window.loadReferences = async function() {
  showError('');
  const list = document.getElementById('ref-list');
  list.replaceChildren();
  const { data, error } = await supabase.from('reference_documents')
    .select('id,title,category,label,source,notification_no,notification_date,file_path')
    .order('category').order('title');
  if (error) {
    showError(safeErrorMessage(error, 'The reference documents could not be loaded.'));
    return;
  }
  _docs = (data || []).filter(d => String(d.label || '').trim());
  if (!_docs.length) {
    list.append(el('div', 'ref-msg', 'There are no reference documents for your organisation.'));
    return;
  }
  list.append(..._docs.map(renderCard));
  await prepareLinks();
};

function renewLinks() {
  if (_docs.length && Date.now() - _linksAt >= LINK_RENEW_MS) prepareLinks();
}
setInterval(renewLinks, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) renewLinks(); });

await window.loadReferences();
