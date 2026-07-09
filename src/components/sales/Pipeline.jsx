import React from 'react';
import { PROCESS_STEPS as STEPS } from '../../constants';
import './Pipeline.css';

export default function Pipeline({ completedSteps, currentStep, processes }) {
  // processes 배열이 있으면 정확한 상태로 표시
  const processMap = {};
  const priority = { in_progress: 3, waiting: 2, completed: 1 };
  if (processes && processes.length > 0) {
    processes.forEach((p) => {
      const current = processMap[p.step_name];
      if (!current || (priority[p.status] || 0) > (priority[current.status] || 0)) {
        processMap[p.step_name] = p;
      }
    });
  }

  return (
    <div className="pipeline">
      {STEPS.map((step, idx) => {
        const proc = processMap[step];
        let status = 'waiting';

        if (proc) {
          status = proc.status; // 'completed', 'in_progress', 'waiting'
        } else if (Object.keys(processMap).length === 0 && idx < completedSteps) {
          status = 'completed';
        } else if (Object.keys(processMap).length === 0 && idx === currentStep) {
          status = 'in_progress';
        }

        let barClass = 'pipe-bar';
        let labelClass = 'pipe-label';

        if (status === 'completed') {
          barClass += ' done';
          labelClass += ' completed';
        } else if (status === 'in_progress') {
          barClass += ' current';
          labelClass += ' active';
        }

        return (
          <div key={idx} className="pipe-step">
            <div className={barClass}>
              <div className="pipe-fill" />
            </div>
            <div className={labelClass}>{step}</div>
          </div>
        );
      })}
    </div>
  );
}
