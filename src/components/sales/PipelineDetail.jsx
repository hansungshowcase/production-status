import React from 'react';
import { PROCESS_STEPS as STEPS } from '../../constants';
import './PipelineDetail.css';

const STATUS_CONFIG = {
  completed: { label: '완료', className: 'pd-status-completed', icon: '✅' },
  in_progress: { label: '진행중', className: 'pd-status-progress', icon: '▶️' },
  waiting: { label: '대기', className: 'pd-status-waiting', icon: '⏳' },
};

function formatTimestamp(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}/${day} ${hours}:${minutes}`;
}

export default function PipelineDetail({ processes, expanded }) {
  if (!expanded) return null;

  // Build a map from step_name to process data
  const processMap = {};
  (processes || []).forEach((p) => {
    processMap[p.step_name] = p;
  });

  return (
    <div className="pipeline-detail">
      <div className="pd-title">공정 상세 타임라인</div>
      <div className="pd-timeline">
        {STEPS.map((step, idx) => {
          const proc = processMap[step];
          const status = proc?.status || 'waiting';
          const config = STATUS_CONFIG[status];
          const worker = proc?.assigned_worker || '-';
          const startedAt = proc?.started_at;
          const completedAt = proc?.completed_at;
          const isLast = idx === STEPS.length - 1;

          return (
            <div key={step} className={`pd-step ${config.className}`}>
              <div className="pd-step-line-area">
                <div className={`pd-dot ${config.className}`}>
                  <span className="pd-dot-icon">{config.icon}</span>
                </div>
                {!isLast && <div className="pd-connector" />}
              </div>

              <div className="pd-step-content">
                <div className="pd-step-header">
                  <span className="pd-step-name">{step}</span>
                  <span className={`pd-badge ${config.className}`}>{config.label}</span>
                </div>
                <div className="pd-step-meta">
                  <span className="pd-worker">{worker}</span>
                  {startedAt && (
                    <span className="pd-time">
                      시작 {formatTimestamp(startedAt)}
                    </span>
                  )}
                  {completedAt && (
                    <span className="pd-time">
                      완료 {formatTimestamp(completedAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
