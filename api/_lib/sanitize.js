import xss from 'xss';

export function sanitizeInput(obj) {
  if (typeof obj === 'string') return xss(obj);
  if (Array.isArray(obj)) return obj.map(sanitizeInput);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = sanitizeInput(val);
    }
    return result;
  }
  return obj;
}
