// Copy marking for the bill prints (Session 345c2b, GST Stage 5) -- printOpdBill.js, printFinalBill.js, printPharmacyBill.js.
// The SERVER decides every marking (record_document_print): this file only turns its answer into the page's header text,
// watermark and footer line, so the header and the footer always show the same words and the same number.
//   * a Tax Invoice:        "ORIGINAL FOR RECIPIENT", then "REPRINT · ORIGINAL FOR RECIPIENT · No. N" (watermark "REPRINT")
//   * its supplier copy:    "DUPLICATE FOR SUPPLIER" (services only) / "TRIPLICATE FOR SUPPLIER" (any goods line), then
//                           "REPRINT · <that label> · No. N" -- its own print series, never a watermark
//   * every other document: "Original", then "DUPLICATE COPY · No. N" (watermark "DUPLICATE COPY") -- unchanged
// No transporter copy exists.

// ?copy=supplier on a bill print page = the supplier copy of that bill
export function isSupplierCopy(search = window.location.search) {
  return new URLSearchParams(search).get('copy') === 'supplier'
}

// The supplier copy exists only for an issued (finalised, not cancelled) Tax Invoice -- the server refuses anything else
export function canPrintSupplierCopy(bill) {
  return !!bill && bill.tax_regime === 'gst_v1' && bill.document_type === 'TAX_INVOICE' && bill.document_status === 'finalized'
}

// The same page with ?copy=supplier (relative, so it works on localhost and live)
export function supplierCopyUrl(href = window.location.href) {
  const u = new URL(href)
  u.searchParams.set('copy', 'supplier')
  return `${u.pathname.split('/').pop()}${u.search}`
}

// Opens the supplier copy straight from the user's click (window.open before any await, so it is never blocked as a
// pop-up). The new page records its own print (fail closed) -- nothing is recorded here.
export function openSupplierCopy() {
  window.open(supplierCopyUrl(), '_blank', 'noopener')
}

/**
 * @param {object} copy  record_document_print's answer: { copy, print_no, legacy, first_printed_at, first_printed_by, label? }
 * @param {{ supplier?: boolean, fmtDT: (iso: string) => string }} opts
 * @returns {{ isDup: boolean, copyNo: number, mark: string, watermark: string|null, footer: string|null }}
 *   mark = the words for the header; footer = the matching footer line (null on a first print of the recipient copy)
 */
export function copyMarking(copy, { supplier = false, fmtDT }) {
  const isDup  = copy.copy !== 'ORIGINAL'
  // ONE copy number for header and footer: a pre-tracking document's assumed original is copy 1
  const copyNo = (Number(copy.print_no) || 1) + (copy.legacy ? 1 : 0)
  const first  = `${fmtDT(copy.first_printed_at) || '—'}${copy.first_printed_by ? ' by ' + copy.first_printed_by : ''}`
  if (copy.label) {
    return {
      isDup, copyNo, mark: copy.label,
      watermark: !supplier && isDup ? 'REPRINT' : null,
      footer: isDup ? `${copy.label}. The ${supplier ? 'supplier copy' : 'original'} was first printed ${first}.`
                    : supplier ? `${copy.label}.` : null,
    }
  }
  return {
    isDup, copyNo, mark: isDup ? `DUPLICATE COPY · No. ${copyNo}` : 'Original',
    watermark: isDup ? 'DUPLICATE COPY' : null,
    footer: isDup ? `Duplicate copy no. ${copyNo}. ${copy.legacy
      ? 'Issued before print tracking began — an original may already have been given to the patient.'
      : `The original was first printed ${first}.`}` : null,
  }
}
