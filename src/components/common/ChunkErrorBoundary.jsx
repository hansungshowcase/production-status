import { Component } from 'react';

const RELOAD_KEY = 'chunk-reload-attempted-at';
const MAX_RELOAD_AGE_MS = 30000;

export function isChunkLoadError(error) {
  const message = String(error?.message || error || '');
  return (
    error?.name === 'ChunkLoadError' ||
    message.includes('Loading chunk') ||
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes('error loading dynamically imported module')
  );
}

export function recoverFromChunkLoadError() {
  const lastAttempt = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  const now = Date.now();
  if (!lastAttempt || now - lastAttempt > MAX_RELOAD_AGE_MS) {
    sessionStorage.setItem(RELOAD_KEY, String(now));
    clearCachesAndReload();
    return true;
  }
  return false;
}

export function clearChunkReloadAttempt() {
  sessionStorage.removeItem(RELOAD_KEY);
}

export async function clearAppCaches() {
  const cleanupTasks = [];

  if ('serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    cleanupTasks.push(...registrations.map((registration) => registration.unregister()));
  }

  if ('caches' in window) {
    const cacheNames = await caches.keys();
    cleanupTasks.push(...cacheNames.map((cacheName) => caches.delete(cacheName)));
  }

  await Promise.all(cleanupTasks);
}

export async function clearCachesAndReload() {
  try {
    await clearAppCaches();
  } catch (error) {
    console.warn('App cache cleanup failed before reload:', error);
  } finally {
    window.location.reload();
  }
}

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error) && recoverFromChunkLoadError()) {
      return;
    }
  }

  handleReload = () => {
    clearChunkReloadAttempt();
    clearCachesAndReload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '60vh', padding: '2rem',
          fontFamily: '"Noto Sans KR", sans-serif', textAlign: 'center',
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>!</div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', color: '#1e293b' }}>
            페이지를 불러오지 못했습니다
          </h2>
          <p style={{ color: '#64748b', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            새 버전 반영 중입니다. 새로고침 후 다시 시도해주세요.
          </p>
          <button
            onClick={this.handleReload}
            style={{
              padding: '0.75rem 2rem', fontSize: '1rem', fontWeight: 600,
              color: '#fff', background: '#2563eb', border: 'none',
              borderRadius: '0.75rem', cursor: 'pointer',
            }}
          >
            새로고침
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
