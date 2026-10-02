// Shared bill / invoice print layout (Session 320). Renders a plain, document-agnostic
// model into the page -- the IPD Final Bill (printFinalBill.js) is the first user; OPD and
// pharmacy invoices can reuse it by writing their own small adapter that fills the same
// model. It never computes money: every figure arrives already formatted by the adapter
// from stored values. Built with createElement/textContent only (no innerHTML), so any
// patient-entered text is inert. Styling lives in css/print-final-bill.css.
//
// model = {
//   org:        { name, lines: [text], logoUrl, monogram },
//   title, subtitle, watermark,                       // watermark: null | 'DRAFT' | 'CANCELLED' ...
//   meta:       [{ label, value, sub, wide, gap }],   // header strip (Bill No / Date / Bill To / Payer ...)
//   party:      { title, fields: [{ label, value, wide, full, gap }] },
//   gst:        boolean,                              // show Disc/Taxable/GST/CGST/SGST columns
//   descLabel:  text (default 'Description'), noCode: boolean -- OPD / lab bills: "Service / Test", no SAC column (Session 327c)
//   sections:   [{ title, rows: [{ no, description, sub, code, qty, rate, disc, taxable, gstLabel, cgst, sgst, amount }], subtotal }],
//   emptyNote:  text | null,
//   taxSummary: [{ label, value, cgst, sgst, tax }] | null,
//   payments:   { title?, rows: [{ receiptNo, date, type, mode, by?, amount, voided, voidReason }], totalLabel, total } | null,   // `by` adds a "Received by" column
//   summary:    { rows: [{ label, value, grand }], balance: { label, value } },
//   words:      { label, lines: [text] },
//   signatures: { left: [text], right: [text] },
//   footer:     [text],
// }

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return el;
}

function field(f) {
  const cls = [f.wide ? 'wide' : '', f.full ? 'full' : ''].filter(Boolean).join(' ') || null;
  return h('div', { class: cls },
    h('span', { class: 'lbl' }, f.label),
    h('span', { class: 'val' + (f.gap ? ' gap' : '') }, f.value ?? '—'),
    f.sub ? h('span', { class: 'val-sub' }, f.sub) : null);
}

function headerBlock(m) {
  const logo = m.org.logoUrl
    ? h('img', { class: 'logo-img', src: m.org.logoUrl, alt: `${m.org.name} logo` })
    : h('div', { class: 'logo-box', 'aria-hidden': 'true' }, m.org.monogram || '');
  return h('header', { class: 'hdr' },
    logo,
    h('div', null,
      h('h1', { class: 'org-name' }, m.org.name),
      h('div', { class: 'org-lines' }, (m.org.lines || []).map(l => h('div', null, l)))),
    h('div', { class: 'doc-title-box' },
      h('p', { class: 'doc-title' }, m.title),
      m.subtitle ? h('div', { class: 'doc-sub' }, m.subtitle) : null));
}

function itemsTable(m) {
  const dl = m.descLabel || 'Description';
  const head = m.gst
    ? ['#', dl, 'SAC/HSN', 'Qty', 'Rate', 'Disc.', 'Taxable', 'GST', 'CGST', 'SGST', 'Amount']
    : m.noCode ? ['#', dl, 'Qty', 'Rate (₹)', 'Amount (₹)'] : ['#', dl, 'SAC / HSN', 'Qty', 'Rate (₹)', 'Amount (₹)'];
  const numFrom = m.noCode && !m.gst ? 2 : 3;
  const cols = head.length;
  const tbody = h('tbody');
  for (const s of m.sections) {
    tbody.appendChild(h('tr', { class: 'cat-row' }, h('td', { colspan: cols }, s.title)));
    for (const r of s.rows) {
      const desc = h('td', null, r.description, r.sub ? [h('br'), h('span', { class: 'muted' }, r.sub)] : null);
      const cells = m.gst
        ? [r.qty, r.rate, r.disc, r.taxable, r.gstLabel, r.cgst, r.sgst, r.amount]
        : [r.qty, r.rate, r.amount];
      tbody.appendChild(h('tr', null,
        h('td', null, r.no), desc, m.noCode && !m.gst ? null : h('td', { class: 'code' }, r.code || '—'),
        cells.map(c => h('td', { class: 'num' }, c ?? '—'))));
    }
    tbody.appendChild(h('tr', { class: 'sub-row' },
      h('td', { colspan: cols - 1, class: 'num' }, `${s.title} subtotal`), h('td', { class: 'num' }, s.subtotal)));
  }
  return h('table', { class: m.gst ? 'items gst' : 'items' },
    h('thead', null, h('tr', null, head.map((t, i) => h('th', { scope: 'col', class: i >= numFrom ? 'num' : null }, t)))),
    tbody);
}

function taxSummaryTable(rows) {
  return h('table', { class: 'tax-summary' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, 'Rate'), h('th', { scope: 'col', class: 'num' }, 'Taxable / Value'),
      h('th', { scope: 'col', class: 'num' }, 'CGST'), h('th', { scope: 'col', class: 'num' }, 'SGST'),
      h('th', { scope: 'col', class: 'num' }, 'Total Tax'))),
    h('tbody', null, rows.map(r => h('tr', null,
      h('td', null, r.label), h('td', { class: 'num' }, r.value), h('td', { class: 'num' }, r.cgst),
      h('td', { class: 'num' }, r.sgst), h('td', { class: 'num' }, r.tax)))));
}

function paymentsTable(p) {
  const withBy = p.rows.some(r => r.by !== undefined);
  const cols = withBy ? 6 : 5;
  const tbody = h('tbody');
  for (const r of p.rows) {
    tbody.appendChild(h('tr', { class: r.voided ? 'void-row' : null },
      h('td', { class: 'code' }, r.receiptNo), h('td', null, r.date), h('td', null, r.type),
      h('td', null, r.mode), withBy ? h('td', null, r.by || '—') : null, h('td', { class: 'num' }, r.amount)));
    if (r.voided) {
      tbody.appendChild(h('tr', { class: 'void-row void-note' },
        h('td', { colspan: cols }, `VOID — ${r.voidReason || 'no reason recorded'} (not counted)`)));
    }
  }
  tbody.appendChild(h('tr', { class: 'sub-row' },
    h('td', { colspan: cols - 1, class: 'num' }, p.totalLabel), h('td', { class: 'num' }, p.total)));
  return h('table', { class: 'pay' },
    h('thead', null, h('tr', null,
      (withBy ? ['Receipt No.', 'Date', 'Type', 'Mode / Reference', 'Received by'] : ['Receipt No.', 'Date', 'Type', 'Mode']).map(t => h('th', { scope: 'col' }, t)),
      h('th', { scope: 'col', class: 'num' }, 'Amount (₹)'))),
    tbody);
}

export function renderInvoice(sheet, m) {
  sheet.replaceChildren();
  if (m.watermark) sheet.appendChild(h('div', { class: 'watermark', 'aria-hidden': 'true' }, m.watermark));

  sheet.appendChild(headerBlock(m));
  sheet.appendChild(h('section', { class: 'meta', 'aria-label': 'Bill details' }, m.meta.map(f =>
    h('div', { class: f.wide ? 'wide' : null },
      h('span', { class: 'lbl' }, f.label),
      h('span', { class: 'val' + (f.gap ? ' gap' : '') }, f.value ?? '—'),
      f.sub ? h('span', { class: 'val-sub' }, f.sub) : null))));

  sheet.appendChild(h('h2', { class: 'sec-title' }, m.party.title));
  sheet.appendChild(h('section', { class: 'pt-grid' }, m.party.fields.map(field)));

  sheet.appendChild(h('h2', { class: 'sec-title' }, 'Charges'));
  if (m.sections.length) sheet.appendChild(itemsTable(m));
  else sheet.appendChild(h('p', { class: 'muted' }, 'No charges on this bill.'));
  if (m.emptyNote) sheet.appendChild(h('p', { class: 'muted' }, m.emptyNote));

  if (m.taxSummary && m.taxSummary.length) {
    sheet.appendChild(h('h2', { class: 'sec-title' }, 'Tax Summary'));
    sheet.appendChild(taxSummaryTable(m.taxSummary));
  }

  if (m.payments) {
    sheet.appendChild(h('h2', { class: 'sec-title' }, m.payments.title || 'Payments & Adjustments'));
    sheet.appendChild(paymentsTable(m.payments));
  }

  sheet.appendChild(h('div', { class: 'totals-wrap' },
    h('div', { class: 'words-col' },
      h('span', { class: 'lbl' }, m.words.label),
      m.words.lines.map(l => h('div', { class: 'words' }, l))),
    h('div', null,
      h('h2', { class: 'sec-title' }, 'Summary'),
      h('table', { class: 'totals' }, h('tbody', null, m.summary.rows.map(r =>
        h('tr', { class: r.grand ? 'grand' : null }, h('td', null, r.label), h('td', { class: 'num' }, r.value))))),
      h('div', { class: 'balance-box' }, h('span', null, m.summary.balance.label), h('span', null, m.summary.balance.value)))));

  sheet.appendChild(h('div', { class: 'sign-row' },
    h('div', null, m.signatures.left.map((l, i) => i ? [h('br'), h('span', { class: 'muted' }, l)] : l)),
    h('div', { class: 'r' }, m.signatures.right.map((l, i) => i ? [h('br'), h('span', { class: 'muted' }, l)] : l))));

  sheet.appendChild(h('footer', { class: 'foot' }, m.footer.map(l => h('p', null, l))));
}

export { h as el };
