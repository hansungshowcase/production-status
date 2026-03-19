import React from 'react';
import { PROCESS_STEPS } from '../../constants';
import './ProcessUpdatePanel.css';

export default function ProcessUpdatePanel({
  processes,
  currentStep,
  isActive,
  isCompleted,
  onStart,
  onComplete,
}) {
  const getStepStatus = (idx) => {
    const proc = processes.find((p) => p.step_name === PROCESS_STEPS[idx]);
    if (!proc) return 'waiting';
    return proc.status; // 'completed', 'in_progress', 'waiting'
  };

  return (
    <div className="process-update-panel">
      <div className="pup-label">공정 현황</div>
      <div className="pup-pipeline">
        {PROCESS_STEPS.map((step, idx) => {
          const status = getStepStatus(idx);
          const isCurrent = idx === currentStep && !isCompleted;
          return (
            <div key={idx} className={`pup-step ${status} ${isCurrent ? 'pup-current' : ''}`}>
              <div className="pup-dot">
                {status === 'completed' ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <span className="pup-dot-num">{idx + 1}</span>
                )}
              </div>
              <span className="pup-step-name">{step}</span>
              <span className="pup-step-status">
                {status === 'completed' ? '완료' : status === 'in_progress' ? '진행중' : '대기'}
              </span>
            </div>
          );
        })}
      </div>

      {!isCompleted && (
        <div className="pup-actions">
          {isActive ? (
            <button className="pup-btn pup-btn-complete" onClick={onComplete}>
              {PROCESS_STEPS[currentStep]} 완료
            </button>
          ) : (
            <button className="pup-btn pup-btn-start" onClick={onStart}>
              {PROCESS_STEPS[currentStep] || '다음 공정'} 시작
            </button>
          )}
        </div>
      )}

      {isCompleted && (
        <div className="pup-done-msg">모든 공정이 완료되었습니다</div>
      )}
    </div>
  );
}
