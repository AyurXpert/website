// Indian-numbering (crore/lakh) amount-in-words, for receipts and (later) GST invoice
// print layouts (Stage 4 of docs/handoff/gst_launch_plan.md). Whole rupees only — paise
// are dropped, matching how printed receipts round in practice.

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function _twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
}
function _threeDigits(n) {
  const h = Math.floor(n / 100), r = n % 100;
  return (h ? ONES[h] + ' Hundred' + (r ? ' ' : '') : '') + (r ? _twoDigits(r) : '');
}

// amountInWords(1875) -> "One Thousand Eight Hundred Seventy Five Rupees Only"
// amountInWords(0)    -> "Zero Rupees Only"
export function amountInWords(amount) {
  let n = Math.round(Math.abs(Number(amount) || 0));
  if (n === 0) return 'Zero Rupees Only';

  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh  = Math.floor(n / 100000);   n %= 100000;
  const thou  = Math.floor(n / 1000);     n %= 1000;
  const rest  = n;

  const parts = [];
  if (crore) parts.push(_threeDigits(crore) + ' Crore');
  if (lakh)  parts.push(_threeDigits(lakh) + ' Lakh');
  if (thou)  parts.push(_threeDigits(thou) + ' Thousand');
  if (rest)  parts.push(_threeDigits(rest));

  return parts.join(' ') + ' Rupees Only';
}
