// localStorage 안전 wrapper — 카카오톡/인앱 브라우저/시크릿 모드에서 storage 차단 시 메모리 fallback
const memStore = {};

export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
  }
}

export function safeSet(key, value) {
  memStore[key] = value;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 메모리에는 이미 저장됨
  }
}

export function safeRemove(key) {
  delete memStore[key];
  try {
    localStorage.removeItem(key);
  } catch {
    // 메모리에서 이미 삭제됨
  }
}
