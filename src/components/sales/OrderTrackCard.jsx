import React from 'react';
import Pipeline from './Pipeline';
import PipelineDetail from './PipelineDetail';
import './OrderTrackCard.css';

export default function OrderTrackCard({ order, expanded, onToggle, onEdit, onDelete }) {
  const {
    orderNumber,
    product,
    productType,
    doorType,
    width,
    depth,
    height,
    color,
    quantity,
    client,
    phone,
    saleAmount,
    notes,
    dueDate,
    shipDate,
    isUrgent,
    dueStatus,
    completedSteps,
    currentStep,
    photoCount,
    lastUpdatedBy,
    lastUpdatedTime,
    alert,
  } = order;

  const displayProduct = productType
    ? `${productType}${doorType ? ' / ' + doorType : ''}`
    : product;
  const dimensions = width && depth && height ? `${width}x${depth}x${height}` : null;

  const handleEdit = (e) => {
    e.stopPropagation();
    if (onEdit) onEdit(order);
  };

  const handleDelete = (e) => {
    e.stopPropagation();
    if (onDelete) onDelete(order);
  };

  return (
    <div className={`order-track-card ${expanded ? 'otc-expanded' : ''} ${dueStatus?.isOverdue ? 'overdue' : ''} ${dueStatus?.color === 'orange' ? 'due-soon' : ''}`} onClick={onToggle} style={{ cursor: 'pointer' }}>
      {dueStatus?.label && (
        <div className={`due-badge ${dueStatus.isOverdue ? 'due-badge-red' : 'due-badge-orange'}`}>
          {dueStatus.label}
        </div>
      )}
      <div className="otc-header">
        <div>
          <div className="otc-order">{orderNumber}</div>
          <div className="otc-product">{displayProduct}</div>
          <div className="otc-client">{client}</div>
          {(dimensions || color || quantity) && (
            <div className="otc-specs">
              {dimensions && <span className="otc-spec">규격: {dimensions}</span>}
              {color && <span className="otc-spec">색상: {color}</span>}
              {quantity && <span className="otc-spec">수량: {quantity}</span>}
            </div>
          )}
        </div>
        <div className="otc-right">
          <div className="otc-due">
            {shipDate ? (
              <>
                <div className="otc-due-label">출고완료일</div>
                <div className="otc-due-date normal">{shipDate}</div>
              </>
            ) : (
              <>
                <div className="otc-due-label">납기일</div>
                <div className={`otc-due-date ${isUrgent ? 'urgent' : 'normal'}`}>
                  {dueDate} {isUrgent && '\u26A0\uFE0F'}
                </div>
              </>
            )}
          </div>
          {(onEdit || onDelete) && (
            <div className="otc-actions">
              {onEdit && (
                <button className="otc-action-btn otc-edit-btn" onClick={handleEdit} title="수정">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </svg>
                </button>
              )}
              {onDelete && (
                <button className="otc-action-btn otc-delete-btn" onClick={handleDelete} title="삭제">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <Pipeline completedSteps={completedSteps} currentStep={currentStep} processes={order.processes} />

      {(() => {
        const procs = order.processes || [];
        const inProgress = procs.find(p => p.status === 'in_progress');
        const completedCount = procs.filter(p => p.status === 'completed').length;
        const total = procs.length || 8;
        if (order.status === 'shipped' || completedCount === total) {
          return <div className="otc-current-step otc-step-done">전 공정 완료 ({total}/{total})</div>;
        }
        if (inProgress) {
          return <div className="otc-current-step otc-step-progress">현재: <strong>{inProgress.step_name}</strong> 진행중 ({completedCount}/{total})</div>;
        }
        const nextWaiting = procs.find(p => p.status === 'waiting');
        if (nextWaiting) {
          return <div className="otc-current-step otc-step-waiting">다음: <strong>{nextWaiting.step_name}</strong> 대기 ({completedCount}/{total})</div>;
        }
        return null;
      })()}

      {expanded && (phone || saleAmount || notes) && (
        <div className="otc-details">
          {phone && (
            <div className="otc-detail-row">
              <span className="otc-detail-label">전화번호</span>
              <span className="otc-detail-value">{phone}</span>
            </div>
          )}
          {saleAmount && (
            <div className="otc-detail-row">
              <span className="otc-detail-label">판매금액</span>
              <span className="otc-detail-value">{saleAmount}</span>
            </div>
          )}
          {notes && (
            <div className="otc-detail-row">
              <span className="otc-detail-label">비고</span>
              <span className="otc-detail-value">{notes}</span>
            </div>
          )}
        </div>
      )}

      {photoCount > 0 && (
        <div className="photo-attached">작업사진 {photoCount}장</div>
      )}

      {alert && (
        <div className="order-alert">
          {alert}
        </div>
      )}

      <PipelineDetail processes={order.processes} expanded={expanded} />

      <div className="last-updated">
        <span>최근 업데이트</span>
        <span className="updated-by">{lastUpdatedBy}</span>
        <span>{lastUpdatedTime}</span>
        <span className={`otc-expand-icon ${expanded ? 'otc-expanded' : ''}`}>
          &#9662;
        </span>
      </div>
    </div>
  );
}
