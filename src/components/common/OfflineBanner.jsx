import React from 'react';
import './OfflineBanner.css';

export default function OfflineBanner({ show }) {
  if (!show) return null;

  return (
    <div className="offline-banner" role="alert">
      <span className="offline-banner__icon">⚠</span>
      <span className="offline-banner__text">오프라인 상태입니다</span>
    </div>
  );
}
