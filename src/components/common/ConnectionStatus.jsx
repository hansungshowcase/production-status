import React from 'react';
import './ConnectionStatus.css';

export default function ConnectionStatus({ connected }) {
  return (
    <div
      className={`connection-status ${connected ? 'connected' : 'disconnected'}`}
      title={connected ? '실시간 연결됨' : '연결 끊김'}
    >
      <span className="connection-dot" />
      <span className="connection-label">{connected ? 'LIVE' : 'OFF'}</span>
    </div>
  );
}
