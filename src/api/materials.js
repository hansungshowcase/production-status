import request from './client.js';

export function getMaterials({ refresh = false } = {}) {
  return request(`/materials${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
}
