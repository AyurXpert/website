// Indian-numbering (crore/lakh) amount-in-words, for receipts and the GST print layouts (Stage 4 of docs/handoff/gst_launch_plan.md).
// Session 345l (TODO §176, owner 14 Oct 2026): the paise are kept -- "Four Hundred Ninety Eight Rupees and Sixty Paise Only";
// a whole amount stays "… Rupees Only"; less than a rupee is "Sixty Paise Only". The amount is rounded to the paisa first.

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
// a whole number in Indian words (crore / lakh / thousand); a crore count above 999 is itself put in words ("… Thousand … Crore")
function _intWords(n) {
  if (n === 0) return '';
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh  = Math.floor(n / 100000);   n %= 100000;
  const thou  = Math.floor(n / 1000);     n %= 1000;
  const parts = [];
  if (crore) parts.push(_intWords(crore) + ' Crore');
  if (lakh)  parts.push(_twoDigits(lakh) + ' Lakh');
  if (thou)  parts.push(_twoDigits(thou) + ' Thousand');
  if (n)     parts.push(_threeDigits(n));
  return parts.join(' ');
}

// amountInWords(1875)    -> "One Thousand Eight Hundred Seventy Five Rupees Only"
// amountInWords(498.6)   -> "Four Hundred Ninety Eight Rupees and Sixty Paise Only"
// amountInWords(0.05)    -> "Five Paise Only"
// amountInWords(0)       -> "Zero Rupees Only"
export function amountInWords(amount) {
  const paisaTotal = Math.round(Math.abs(Number(amount) || 0) * 100);
  const rupees = Math.floor(paisaTotal / 100), paise = paisaTotal % 100;
  if (rupees === 0 && paise === 0) return 'Zero Rupees Only';
  if (rupees === 0) return _twoDigits(paise) + ' Paise Only';
  return _intWords(rupees) + ' Rupees' + (paise ? ' and ' + _twoDigits(paise) + ' Paise' : '') + ' Only';
}
