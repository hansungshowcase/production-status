const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function shouldRetryRequest({ method = 'GET', status = 0, retryCount = 0 }) {
  if (retryCount >= 1) return false;
  const normalizedMethod = String(method || 'GET').toUpperCase();
  if (MUTATING_METHODS.has(normalizedMethod)) return false;
  return status === 0;
}

export async function parseResponseBody(response) {
  if (response.status === 204 || response.status === 205) return null;

  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers?.get?.('content-type') || '';
  if (contentType.includes('application/json')) {
    return JSON.parse(text);
  }

  return text;
}
