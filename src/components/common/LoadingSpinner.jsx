import React from 'react';
import './LoadingSpinner.css';

export default function LoadingSpinner({ message = '로딩 중...' }) {
  return (
    <div className="loading-spinner-container" role="status" aria-live="polite">
      <div className="loading-spinner" />
      {message && <p className="loading-spinner-message">{message}</p>}
    </div>
  );
}
