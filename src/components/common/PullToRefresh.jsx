import React from 'react';

export default function PullToRefresh({ pulling, refreshing, pullDistance }) {
  if (!pulling && !refreshing) return null;

  const progress = Math.min(pullDistance / 80, 1);
  const rotation = progress * 360;

  return (
    <div
      className={`pull-to-refresh ${pulling ? 'pulling' : ''} ${refreshing ? 'refreshing' : ''}`}
      style={{ '--pull-height': `${pullDistance}px` }}
    >
      <div
        className={`pull-spinner ${refreshing ? 'refreshing' : ''}`}
        style={{
          transform: refreshing ? undefined : `rotate(${rotation}deg)`,
          opacity: progress,
        }}
      />
    </div>
  );
}
