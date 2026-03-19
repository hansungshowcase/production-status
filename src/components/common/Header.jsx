import React, { useEffect, useState, useCallback } from 'react';
import ConnectionStatus from './ConnectionStatus';

export default function Header({ subtitle, profileEmoji, wsConnected, onBack, workerName, onChangeWorker }) {
  const [scrolled, setScrolled] = useState(false);

  const handleScroll = useCallback(() => {
    const content = document.querySelector('.app-content');
    if (content) {
      setScrolled(content.scrollTop > 10);
    }
  }, []);

  useEffect(() => {
    const content = document.querySelector('.app-content');
    if (content) {
      content.addEventListener('scroll', handleScroll, { passive: true });
      return () => content.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  return (
    <div className={`app-header ${scrolled ? 'scrolled' : ''}`}>
      <div className="app-header-row">
        <div className="app-logo">
          {onBack && (
            <button className="header-back-btn" onClick={onBack} aria-label="뒤로가기">
              &larr;
            </button>
          )}
          <div className="logo-icon">HS</div>
          <div>
            <div className="app-title">한성쇼케이스</div>
            <div className="app-subtitle">{subtitle}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexShrink: 1 }}>
          {wsConnected !== undefined && <ConnectionStatus connected={wsConnected} />}
          {workerName && (
            <button
              onClick={onChangeWorker}
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                color: 'var(--text-mid)',
                padding: '6px 10px',
                minHeight: '36px',
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
                whiteSpace: 'nowrap',
                fontFamily: 'inherit',
                fontWeight: 600,
                transition: 'all 0.15s ease',
              }}
              title="작업자 변경"
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '80px' }}>{workerName}</span>
              <span style={{ fontSize: '10px', opacity: 0.6 }}>변경</span>
            </button>
          )}
          <div className="profile-icon">{profileEmoji}</div>
        </div>
      </div>
    </div>
  );
}
