import React from 'react';
import TaskCard from './TaskCard';

export default function TaskList({ tasks, onStart, onComplete, onPhoto, onIssue, teamName = '전체' }) {
  return (
    <div>
      <div className="section-header">
        <span className="section-title">내 작업 목록</span>
        <span className="section-badge" style={{ background: 'var(--blue-light)', color: 'var(--blue)' }}>
          {teamName}
        </span>
      </div>
      <div className="task-grid">
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            onStart={onStart}
            onComplete={onComplete}
            onPhoto={onPhoto}
            onIssue={onIssue}
          />
        ))}
      </div>
    </div>
  );
}
