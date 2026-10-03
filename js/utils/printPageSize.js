// The printed page size for the Session 336 paper sizes (A4 · A5 · thermal 80 / 58 mm).
//
// Why script and not plain CSS: Chrome / Edge drop `@page { size: 80mm auto }` (auto height is not valid), so the
// page silently stayed A4. A thermal roll has no fixed height, so the document is MEASURED at the printed width and
// the page becomes e.g. 80mm × 143mm -- one continuous page, no page breaks. A5 is a fixed 148mm × 210mm. A4 sets
// nothing (the pages' own A4 @page rules apply unchanged).
//
// The rule goes in a constructed stylesheet in document.adoptedStyleSheets: adopted sheets come after every <link>ed
// sheet in the cascade, so this @page wins over the A4 rules in css/print.css / css/print-final-bill.css, and it is
// CSP-safe on pages whose style-src has no 'unsafe-inline' (no <style> element is injected).
// Nothing here talks to the server -- changing the size never records a print.

const PAGES = {
  a5:  { w: 148, h: 210, margin: '8mm 8mm 10mm' },
  t80: { w: 80, side: 3, top: 2, bottom: 2 },
  t58: { w: 58, side: 2, top: 1.5, bottom: 1.5 },
};
const PX_TO_MM = 25.4 / 96;
const SLACK_MM = 4;      // rounding / font-metric slack so the roll never spills onto a second page
const MIN_ROLL_MM = 40;

let _sheet = null;
function sheet() {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];
  }
  return _sheet;
}

// Height of `el` laid out at `widthMm` with no padding / margin / border -- the way it prints. Works on an element
// that is hidden on screen (printDocument's copy) by showing it off-screen for the measurement only.
function measureMm(el, widthMm) {
  const s = el.style;
  const prev = s.cssText;
  s.setProperty('display', 'block', 'important');
  s.setProperty('position', 'absolute', 'important');
  s.setProperty('left', '-10000px', 'important');
  s.setProperty('top', '0', 'important');
  s.setProperty('width', `${widthMm}mm`, 'important');
  s.setProperty('max-width', 'none', 'important');
  s.setProperty('min-height', '0', 'important');
  s.setProperty('margin', '0', 'important');
  s.setProperty('padding', '0', 'important');
  s.setProperty('border-width', '0', 'important');
  const px = el.getBoundingClientRect().height;
  s.cssText = prev;
  return px * PX_TO_MM;
}

// size: 'a4' | 'a5' | 't80' | 't58'; el: the element that prints (needed for thermal)
export function setPrintPageSize(size, el) {
  const p = PAGES[size];
  if (!p) { if (_sheet) _sheet.replaceSync(''); return; }
  if (p.h) {
    sheet().replaceSync(`@page { size: ${p.w}mm ${p.h}mm; margin: ${p.margin}; }`);
    return;
  }
  const content = el ? measureMm(el, p.w - 2 * p.side) : 0;
  const h = Math.max(MIN_ROLL_MM, Math.ceil(content + p.top + p.bottom + SLACK_MM));
  sheet().replaceSync(
    `@page { size: ${p.w}mm ${h}mm; margin: ${p.top}mm ${p.side}mm ${p.bottom}mm; ` +
    '@top-left { content: none; } @top-center { content: none; } @top-right { content: none; } ' +
    '@bottom-left { content: none; } @bottom-center { content: none; } @bottom-right { content: none; } }');
}

export function clearPrintPageSize() {
  if (_sheet) _sheet.replaceSync('');
}
