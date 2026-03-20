import React, { useState } from 'react';
import { PROCESS_STEPS } from '../../constants';
import { formatDueStatus } from '../../utils/dateUtils';
import './SalesOrderCard.css';

export default function SalesOrderCard({ order, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const processes = order.processes || [];
  const stepStatusMap = {};
  const stepWorkerMap = {};
  processes.forEach(p => {
    stepStatusMap[p.step_name] = p.status;
    if (p.completed_by) stepWorkerMap[p.step_name] = p.completed_by;
    else if (p.started_by) stepWorkerMap[p.step_name] = p.started_by;
  });
  const completedSteps = processes.filter(p => p.status === 'completed').length;
  const totalSteps = PROCESS_STEPS.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

  // Find current step (first non-completed)
  let currentStepName = null;
  let currentStepStatus = null;
  let currentWorker = null;
  for (const step of PROCESS_STEPS) {
    const st = stepStatusMap[step];
    if (st === 'in_progress') {
      currentStepName = step;
      currentStepStatus = '진행중';
      currentWorker = stepWorkerMap[step] || null;
      break;
    }
    if (!st || st === 'waiting') {
      currentStepName = step;
      currentStepStatus = '대기';
      break;
    }
  }
  if (completedSteps === totalSteps) {
    currentStepName = '전체 완료';
    currentStepStatus = null;
  }

  const dueStatus = formatDueStatus(order.due_date, order.status);
  const isOverdue = dueStatus.isOverdue;
  const isShipped = order.status === 'shipped' || order.status === '출고완료' || !!order.ship_date;

  const clientDisplay = `${order.client_name || ''}${order.client_store ? ' ' + order.client_store : ''}`.trim() || '-';
  const specParts = [order.product_type, order.door_type].filter(Boolean).join(' / ');
  const sizeParts = [order.width, order.depth, order.height].filter(Boolean).join(' x ');
  const dueDisplay = order.due_date
    ? new Date(order.due_date).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
    : '-';

  return (
    <div
      className={`sales-order-card${isOverdue ? ' sales-order-card--overdue' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header: 거래처명 + 뱃지 */}
      <div className="sales-order-card__header">
        <div className="sales-order-card__header-left">
          <span className="sales-order-card__client">{clientDisplay}</span>
        </div>
        <div className="sales-order-card__badge-row">
          {isShipped && (
            <span className="sales-order-card__shipped-badge">출고완료</span>
          )}
          {isOverdue && dueStatus.label && (
            <span className="sales-order-card__due-badge">{dueStatus.label}</span>
          )}
        </div>
      </div>

      {/* Progress bar + 현재 공정 */}
      <div className="sales-order-card__progress">
        <div className="sales-order-card__progress-header">
          <span className={`sales-order-card__current-step sales-order-card__current-step--${currentStepStatus === '진행중' ? 'active' : currentStepStatus === '대기' ? 'waiting' : 'done'}`}>
            {currentStepName}
            {currentStepStatus && <span className="sales-order-card__current-status"> {currentStepStatus}</span>}
          </span>
          {currentWorker && (
            <span className="sales-order-card__current-worker">👷 {currentWorker}</span>
          )}
          <span className="sales-order-card__progress-text">{completedSteps}/{totalSteps}</span>
        </div>
        <div className="sales-order-card__progress-bar">
          <div
            className={`sales-order-card__progress-fill${progressPct === 100 ? ' sales-order-card__progress-fill--done' : ''}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* 기본 정보 — 핵심만 */}
      <div className="sales-order-card__info">
        {specParts && (
          <div className="sales-order-card__info-item">
            <span className="sales-order-card__info-label">사양</span>
            <span className="sales-order-card__info-value">{specParts}</span>
          </div>
        )}
        {sizeParts && (
          <div className="sales-order-card__info-item">
            <span className="sales-order-card__info-label">규격</span>
            <span className="sales-order-card__info-value">{sizeParts}</span>
          </div>
        )}
        <div className="sales-order-card__info-item">
          <span className="sales-order-card__info-label">납기</span>
          <span className="sales-order-card__info-value">{dueDisplay}</span>
        </div>
        {order.quantity > 1 && (
          <div className="sales-order-card__info-item">
            <span className="sales-order-card__info-label">수량</span>
            <span className="sales-order-card__info-value">{order.quantity}대</span>
          </div>
        )}
      </div>

      {/* 상세보기 클릭 힌트 */}
      <div className="sales-order-card__expand-hint">
        {expanded ? '접기 ▲' : '상세보기 ▼'}
      </div>

      {/* 상세 정보 (클릭 시 펼침) */}
      {expanded && (
        <div className="sales-order-card__detail">
          {/* 추가 주문 정보 */}
          <div className="sales-order-card__detail-grid">
            {order.order_date && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">발주일</span>
                <span className="sales-order-card__detail-value">{order.order_date}</span>
              </div>
            )}
            {order.due_date && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">납기일</span>
                <span className="sales-order-card__detail-value">{order.due_date}</span>
              </div>
            )}
            {order.sales_person && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">담당</span>
                <span className="sales-order-card__detail-value">{order.sales_person}</span>
              </div>
            )}
            {order.phone && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">연락처</span>
                <span className="sales-order-card__detail-value">{order.phone}</span>
              </div>
            )}
            {order.color && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">색상</span>
                <span className="sales-order-card__detail-value">{order.color}</span>
              </div>
            )}
            {order.design && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">디자인</span>
                <span className="sales-order-card__detail-value">{order.design}</span>
              </div>
            )}
            {order.notes && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">비고</span>
                <span className="sales-order-card__detail-value">{order.notes}</span>
              </div>
            )}
            {order.remarks && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">특이사항</span>
                <span className="sales-order-card__detail-value">{order.remarks}</span>
              </div>
            )}
          </div>

          {/* 공정 상세 */}
          <div className="sales-order-card__detail-title" style={{ marginTop: 10 }}>공정 현황</div>
          <div className="sales-order-card__process-list">
            {PROCESS_STEPS.map((step, idx) => {
              const st = stepStatusMap[step] || 'waiting';
              const isDone = st === 'completed';
              const isActive = st === 'in_progress';
              let dotCls = 'sales-order-card__process-dot sales-order-card__process-dot--pending';
              let statusCls = 'sales-order-card__process-status';
              let statusText = '대기';

              if (isDone) {
                dotCls = 'sales-order-card__process-dot sales-order-card__process-dot--done';
                statusCls += ' sales-order-card__process-status--done';
                statusText = '완료';
              } else if (isActive) {
                dotCls = 'sales-order-card__process-dot sales-order-card__process-dot--current';
                statusCls += ' sales-order-card__process-status--current';
                statusText = '진행중';
              }

              const worker = stepWorkerMap[step];
              return (
                <div key={idx} className="sales-order-card__process-item">
                  <span className={dotCls} />
                  <span className="sales-order-card__process-name">{step}</span>
                  {worker && <span className="sales-order-card__process-worker">{worker}</span>}
                  <span className={statusCls}>{statusText}</span>
                </div>
              );
            })}
          </div>

          {/* 삭제 버튼 */}
          {onDelete && (
            <div className="sales-order-card__delete-section">
              {!confirmDelete ? (
                <button
                  className="sales-order-card__delete-btn"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                >
                  삭제
                </button>
              ) : (
                <div className="sales-order-card__delete-confirm">
                  <span className="sales-order-card__delete-warn">정말 삭제하시겠습니까?</span>
                  <button
                    className="sales-order-card__delete-btn sales-order-card__delete-btn--yes"
                    onClick={(e) => { e.stopPropagation(); onDelete(order); }}
                  >
                    삭제
                  </button>
                  <button
                    className="sales-order-card__delete-btn sales-order-card__delete-btn--no"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                  >
                    취소
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
