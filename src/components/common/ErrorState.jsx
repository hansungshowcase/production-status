import React from 'react';
import './ErrorState.css';

export default function ErrorState({ message = '오류가 발생했습니다.', onRetry }) {
  return (
    <div className="error-state-container">
      <div className="error-state-icon">!</div>
      <p className="error-state-message">{message}</p>
      {onRetry && (
        <button className="error-state-retry" onClick={onRetry}>
          다시 시도
        </button>
      )}
    </div>
  );
}
