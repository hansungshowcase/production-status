export const SALES_SHIPPING_MANAGERS = ['신은철', '이준형'];

function normalizeActorName(value) {
  return String(value || '').replace(/\s+/g, '');
}

export function canShipFromSales(actor) {
  const normalizedActor = normalizeActorName(actor);
  return SALES_SHIPPING_MANAGERS.some((manager) => normalizeActorName(manager) === normalizedActor);
}
