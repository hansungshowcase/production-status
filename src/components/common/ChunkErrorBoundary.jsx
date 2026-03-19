import { Component } from 'react';

export default class ChunkErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error) {
    // Chunk loading failure: auto-reload once
    const isChunkError =
      error?.name === 'ChunkLoadError' ||
      error?.message?.includes('Loading chunk') ||
      error?.message?.includes('Failed to fetch dynamically imported module') ||
      error?.message?.includes('Importing a module script failed');

    if (isChunkError) {
      const reloadKey = 'chunk-reload-attempted';
      if (!sessionStorage.getItem(reloadKey)) {
        sessionStorage.setItem(reloadKey, '1');
        window.location.reload();
        return;
      }
      // Already tried reload once — show error UI
      sessionStorage.removeItem(reloadKey);
    }
  }

  handleReload = () => {
    sessionStorage.removeItem('chunk-reload-attempted');
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', minHeight: '60vh', padding: '2rem',
          fontFamily: '"Noto Sans KR", sans-serif', textAlign: 'center',
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', color: '#1e293b' }}>
            페이지를 불러올 수 없습니다
          </h2>
          <p style={{ color: '#64748b', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
            네트워크 연결을 확인하고 다시 시도해주세요.
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
