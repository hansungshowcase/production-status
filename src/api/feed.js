import request from './client';

export function getFeed(params = {}) {
  const query = new URLSearchParams(params).toString();
  const endpoint = query ? `/feed?${query}` : '/feed';
  return request(endpoint);
}
