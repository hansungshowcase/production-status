import request from './client';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

function getDeliveryAdherenceCacheSlot(now = Date.now()) {
  return Math.floor(now / HALF_DAY_MS);
}

export function getDeliveryAdherence() {
  const delivery_adherence_slot = getDeliveryAdherenceCacheSlot();
  return request(`/delivery-adherence?delivery_adherence_slot=${delivery_adherence_slot}`, {
    cache: 'no-store',
  });
}
