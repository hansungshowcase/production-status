import React from 'react';
import PhotoCapture from './PhotoCapture';
import { PROCESS_STEPS } from '../../constants';
import './TaskCard.css';

export default function TaskCard({ task, onStart, onComplete, onPhoto, onIssue }) {
  const {
    id,
    orderNumber,
    status,
    statusLabel,
    product,
    productType,
    doorType,
    width,
    depth,
    height,
    color,
    quantity,
    client,
    salesRep,
    currentStep,
    completedSteps,
    isActive,
    isBlocked,
    isCompleted,
    dueStatus,
    workOrderImageUrl,
    processes,
  } = task;

  const displayProduct = productType
    ? `${productType}${doorType ? ' / ' + doorType : ''}`
    : product;
  const dimensions = width && depth && height ? `${width}x${depth}x${height}` : null;

  const getStatusClass = () => {
    if (isCompleted) return 'status-done';
    if (status === 'progress') return 'status-progress';
    return 'status-waiting';
  };

  const processByStep = new Map((processes || []).map((process) => [process.step_name, process]));

  const getStepClass = (idx) => {
    const process = processByStep.get(PROCESS_STEPS[idx]);
    if (process) {
      if (process.status === 'completed') return 'p-step done';
      if (process.status === 'in_progress') return 'p-step current';
      return 'p-step';
    }
    if (idx < completedSteps) return 'p-step done';
    if (idx === currentStep && !isCompleted) return 'p-step current';
    return 'p-step';
  };

  const renderProgressLabel = () => {
    return PROCESS_STEPS.map((step, idx) => {
      if (idx === currentStep && !isCompleted) {
        return (
          <React.Fragment key={idx}>
            {idx > 0 && '\u2192'}
            <strong style={{ color: 'var(--blue)' }}>{step}</strong>
          </React.Fragment>
        );
      }
      return (
        <React.Fragment key={idx}>
          {idx > 0 && '\u2192'}
          {step}
        </React.Fragment>
      );
    });
  };

  const canonicalCompletedSteps = processByStep.size > 0
    ? PROCESS_STEPS.filter(step => processByStep.get(step)?.status === 'completed').length
    : completedSteps;
  const progressText = `${Math.max(canonicalCompletedSteps, currentStep)}/${PROCESS_STEPS.length}`;

  return (
    <div className={`task-card ${isActive ? 'active-task' : ''} ${isCompleted ? 'completed-task' : ''} ${dueStatus?.isOverdue ? 'overdue' : ''} ${dueStatus?.color === 'orange' ? 'due-soon' : ''}`}>
      {dueStatus?.label && (
        <div className={`due-badge ${dueStatus.isOverdue ? 'due-badge-red' : 'due-badge-orange'}`}>
          {dueStatus.label}
        </div>
      )}
      <div className="task-top">
        <div className="task-order-row">
          <span className="order-number">{orderNumber}</span>
          <span className={`task-status ${getStatusClass()}`}>{statusLabel}</span>
        </div>
        <div className="task-product">{displayProduct}</div>
        <div className="task-client">거래처: {client} · 영업: {salesRep}</div>
        {(dimensions || color || quantity) && (
          <div className="task-specs">
            {dimensions && <span className="task-spec">규격: {dimensions}</span>}
            {color && <span className="task-spec">색상: {color}</span>}
            {quantity && <span className="task-spec">수량: {quantity}</span>}
          </div>
        )}
      </div>

      <div className="task-progress">
        <div className="progress-steps">
          {PROCESS_STEPS.map((_, idx) => (
            <div key={idx} className={getStepClass(idx)} />
          ))}
        </div>
        <div className="progress-label">
          <span>{renderProgressLabel()}</span>
          <span>{progressText}</span>
        </div>
      </div>

      <div className="task-actions">
        {workOrderImageUrl && (
          <a
            className="action-btn task-work-order-link"
            href={workOrderImageUrl}
            target="_blank"
            rel="noreferrer"
          >
            작업지시서 보기
          </a>
        )}
        {isCompleted ? (
          <button
            className="action-btn btn-disabled"
            style={{ background: 'var(--green-light)', color: 'var(--green)' }}
          >
            공정 완료 -- 다음 공정팀에 알림 전송됨
          </button>
        ) : isBlocked ? (
          <button className="action-btn btn-disabled">이전 공정 진행 중</button>
        ) : status === 'progress' ? (
          <>
            <button className="action-btn btn-complete" onClick={() => onComplete(id)}>
              공정완료
            </button>
            <PhotoCapture
              onCapture={() => onPhoto(id)}
            />
            <button className="action-btn btn-issue" onClick={() => onIssue(id)}>
              이슈
            </button>
          </>
        ) : (
          <>
            <button className="action-btn btn-start" onClick={() => onStart(id)}>
              공정시작
            </button>
            <button className="action-btn btn-issue" onClick={() => onIssue(id)}>
              이슈
            </button>
          </>
        )}
      </div>
    </div>
  );
}
