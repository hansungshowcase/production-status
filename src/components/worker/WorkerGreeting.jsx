import React from 'react';
import StatsCards from './StatsCards';
import './WorkerGreeting.css';

export default function WorkerGreeting({ workerName, stats }) {
  return (
    <div className="worker-greeting">
      <div className="greeting-text">
        안녕하세요, <span>{workerName}</span>님<br />
        오늘의 작업현황입니다
      </div>
      <StatsCards stats={stats} />
    </div>
  );
}
