import React from 'react';
import './StatsCards.css';

export default function StatsCards({ stats }) {
  return (
    <div className="today-stats">
      <div className="stat-card">
        <div className="stat-num" style={{ color: 'var(--orange)' }}>{stats.waiting}</div>
        <div className="stat-label">대기 중</div>
      </div>
      <div className="stat-card">
        <div className="stat-num" style={{ color: 'var(--blue)' }}>{stats.inProgress}</div>
        <div className="stat-label">진행 중</div>
      </div>
      <div className="stat-card">
        <div className="stat-num" style={{ color: 'var(--green)' }}>{stats.completed}</div>
        <div className="stat-label">오늘 완료</div>
      </div>
    </div>
  );
}
