// src/utils/ids.js
export function orderNo() {
  return 'ORD-' + Date.now();
}
export function subscriberNo(seasonCode, n) {
  return `BTS-${seasonCode}-${String(n).padStart(6,'0')}`;
}
export default { orderNo, subscriberNo };

