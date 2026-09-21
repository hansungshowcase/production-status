import request from './client.js';

export function getDeliveryAdherence() {
  return request('/delivery-adherence', {
    cache: 'no-store',
  });
}
