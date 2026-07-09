export const SALES_SHIPPING_MANAGER = '이준형';

function normalizeActorName(value) {
  return String(value || '').replace(/\s+/g, '');
}

export function canShipFromSales(actor) {
  return normalizeActorName(actor) === normalizeActorName(SALES_SHIPPING_MANAGER);
}

