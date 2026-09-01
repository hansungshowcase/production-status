import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PROCESS_STEPS } from '../../constants';
import { extractDueDateFromOrder, formatDueStatus, formatProcessCompletionTime } from '../../utils/dateUtils';
import { getVisibleOrderMemo } from '../../utils/orderText';
import { getOrder } from '../../api/orders';
import { buildShippingDocumentData, buildShippingDocumentPrintHtml } from './shippingDocuments';
import './SalesOrderCard.css';

function parseProcessSummary(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function getDisplayWorker(step, summary, salesPerson) {
  if (!summary || typeof summary !== 'object') return '';
  if (summary.completed_by) return summary.completed_by;
  if (summary.started_by && summary.started_by !== salesPerson) return summary.started_by;
  if (step === '도면설계') return '김보수 팀장';
  return '';
}

function getDeliveryAddress(order) {
  return order.delivery_address || order.address || order.client_address || order.deliveryAddress || order.clientAddress || '';
}

function getFreightPayment(order) {
  return order.freight_payment
    || order.freightPayment
    || order.shipping_fee_payer
    || order.shippingFeePayer
    || order.delivery_fee_payer
    || order.deliveryFeePayer
    || order.transport_payment
    || order.transportPayment
    || order.freight
    || order['운임여부']
    || '';
}

function formatMoney(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${Math.round(value).toLocaleString('ko-KR')}원`;
  }
  const raw = String(value).trim();
  if (!raw || raw === '-') return '';
  const number = Number(raw.replace(/,/g, '').replace(/[^\d.]/g, ''));
  if (Number.isFinite(number) && number > 0) {
    return `${Math.round(number).toLocaleString('ko-KR')}원`;
  }
  return raw;
}

function getWorkOrderImageUrl(order) {
  return order.work_order_image_url || order.workOrderImageUrl || '';
}

function getOrderPhotos(order) {
  return Array.isArray(order.photos) ? order.photos : [];
}

function getOpenIssues(order) {
  const issues = Array.isArray(order.issues) ? order.issues : [];
  return issues.filter(issue => !issue.resolved_at);
}

function getPhotoHref(photo) {
  if (photo?.id) return `/api/photos/${encodeURIComponent(photo.id)}?download=1`;
  return photo?.file_path || photo?.url || '#';
}

function renderDocumentMultiline(value, className) {
  const lines = String(value || '').split('\n');

  return (
    <div className={className}>
      {lines.map((line, index) => (
        <React.Fragment key={index}>
          {line || '\u00a0'}
          {index < lines.length - 1 && <br />}
        </React.Fragment>
      ))}
    </div>
  );
}

function renderDocumentGuide(guide) {
  if (!guide) return null;
  const className = guide.compact
    ? 'sales-order-card__document-guide sales-order-card__document-guide--shipping'
    : 'sales-order-card__document-guide';

  return (
    <div className={className}>
      {guide.intro && renderDocumentMultiline(guide.intro, 'sales-order-card__document-guide-intro')}
      <div className="sales-order-card__document-guide-title">{guide.title}</div>
      {(guide.steps || []).map((step, index) => (
        <React.Fragment key={index}>
          {renderDocumentMultiline(step, 'sales-order-card__document-guide-step')}
        </React.Fragment>
      ))}
      {guide.warning && guide.showWarning !== false && renderDocumentMultiline(guide.warning, 'sales-order-card__document-guide-warning')}
      {guide.driverInfo && renderDocumentMultiline(guide.driverInfo, 'sales-order-card__document-guide-driver')}
    </div>
  );
}

export default function SalesOrderCard({ order, onDelete, onShip, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmShip, setConfirmShip] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [packingPhotoOpen, setPackingPhotoOpen] = useState(false);
  const [documentPreview, setDocumentPreview] = useState(null);
  const [detailOrder, setDetailOrder] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    if (!expanded || detailOrder || detailLoading || !order.id) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError('');
    getOrder(order.id)
      .then((data) => {
        if (!cancelled) setDetailOrder(data);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err.message || '상세 정보를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [detailLoading, detailOrder, expanded, order.id]);

  // 상세 조회가 열린 뒤 목록의 주문 상태가 바뀌어도 최신 상태가 우선해야 한다.
  // 특히 출고 성공 직후 오래된 상세 응답이 shipped 상태를 다시 가리지 않게 한다.
  const displayOrder = detailOrder ? { ...detailOrder, ...order } : order;
  const displayDueDate = extractDueDateFromOrder(displayOrder);
  const visibleNotes = getVisibleOrderMemo(displayOrder.notes);
  const visibleRemarks = getVisibleOrderMemo(displayOrder.remarks);
  const deliveryAddress = getDeliveryAddress(displayOrder);
  const freightPayment = getFreightPayment(displayOrder);
  const balanceDisplay = formatMoney(displayOrder.balance);
  const workOrderImageUrl = getWorkOrderImageUrl(displayOrder);
  const orderPhotos = getOrderPhotos(displayOrder);
  const openIssues = getOpenIssues(displayOrder);

  const processes = displayOrder.processes || [];
  const fallbackCompletedSteps = Number(displayOrder.completed_steps || 0);
  const fallbackTotalSteps = Number(displayOrder.total_steps || PROCESS_STEPS.length) || PROCESS_STEPS.length;
  const stepStatusMap = {};
  const stepWorkerMap = {};
  const stepTimeMap = {};
  const processSummary = parseProcessSummary(displayOrder.process_summary);
  processes.forEach(p => {
    stepStatusMap[p.step_name] = p.status;
    const worker = getDisplayWorker(p.step_name, p, displayOrder.sales_person);
    if (worker) stepWorkerMap[p.step_name] = worker;
    if (p.completed_at) stepTimeMap[p.step_name] = p.completed_at;
  });
  Object.entries(processSummary).forEach(([step, summary]) => {
    if (!summary || typeof summary !== 'object') return;
    if (!stepStatusMap[step] && summary.status) {
      stepStatusMap[step] = summary.status;
    }
    const worker = getDisplayWorker(step, summary, displayOrder.sales_person);
    if (worker && !stepWorkerMap[step]) {
      stepWorkerMap[step] = worker;
    }
    if (summary.completed_at && !stepTimeMap[step]) {
      stepTimeMap[step] = summary.completed_at;
    }
  });
  if (processes.length === 0 && Object.keys(processSummary).length === 0 && fallbackTotalSteps > 0) {
    PROCESS_STEPS.forEach((step, idx) => {
      if (idx < fallbackCompletedSteps) {
        stepStatusMap[step] = 'completed';
      } else if (idx === fallbackCompletedSteps && fallbackCompletedSteps < fallbackTotalSteps) {
        stepStatusMap[step] = displayOrder.status === 'shipped' ? 'completed' : 'in_progress';
      } else {
        stepStatusMap[step] = 'waiting';
      }
    });
  }
  const completedSteps = processes.length > 0
    ? processes.filter(p => p.status === 'completed').length
    : Math.min(fallbackCompletedSteps, fallbackTotalSteps);
  const totalSteps = processes.length > 0 ? PROCESS_STEPS.length : fallbackTotalSteps;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

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

  const isShipped = displayOrder.status === 'shipped' || displayOrder.status === '출고완료' || !!displayOrder.ship_date;
  const dueStatus = formatDueStatus(displayDueDate, isShipped ? 'shipped' : displayOrder.status);
  const isOverdue = dueStatus.isOverdue;

  const clientDisplay = displayOrder.client_name || '-';
  const specParts = [displayOrder.product_type, displayOrder.door_type].filter(Boolean).join(' / ');
  const sizeParts = [displayOrder.width, displayOrder.depth, displayOrder.height].filter(Boolean).join(' x ');
  const dueDisplay = displayDueDate
    ? new Date(displayDueDate).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
    : '-';
  const dueClass = dueStatus.isOverdue
    ? 'overdue'
    : dueStatus.isUrgent
      ? 'soon'
      : 'normal';

  function openDocumentPreview(type, e) {
    e.stopPropagation();
    setDocumentPreview(buildShippingDocumentData(displayOrder, type));
  }

  function closeDocumentPreview(e) {
    if (e) e.stopPropagation();
    setDocumentPreview(null);
  }

  function printDocumentPreview(e) {
    e.stopPropagation();
    if (!documentPreview) return;
    const printWindow = window.open('', '_blank', 'width=820,height=900');
    if (!printWindow) return;
    printWindow.document.open();
    printWindow.document.write(buildShippingDocumentPrintHtml(documentPreview));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  }

  return (
    <div
      className={`sales-order-card${isOverdue ? ' sales-order-card--overdue' : ''}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="sales-order-card__header">
        <div className="sales-order-card__header-left">
          <span className="sales-order-card__client">{clientDisplay}</span>
        </div>
        <div className="sales-order-card__badge-row">
          {isShipped && (
            <span className="sales-order-card__shipped-badge">출고완료</span>
          )}
          {!isShipped && displayDueDate && (
            <span className={`sales-order-card__due-badge sales-order-card__due-badge--${dueClass}`}>
              {dueStatus.label || `납기 ${dueDisplay}`}
            </span>
          )}
        </div>
      </div>

      <div className="sales-order-card__progress">
        <div className="sales-order-card__progress-header">
          <span className={`sales-order-card__current-step sales-order-card__current-step--${currentStepStatus === '진행중' ? 'active' : currentStepStatus === '대기' ? 'waiting' : 'done'}`}>
            {currentStepName}
            {currentWorker && <span className="sales-order-card__current-worker-inline">({currentWorker})</span>}
            {currentStepStatus && <span className="sales-order-card__current-status"> {currentStepStatus}</span>}
          </span>
          <span className="sales-order-card__progress-text">{completedSteps}/{totalSteps}</span>
        </div>
        <div className="sales-order-card__progress-bar">
          <div
            className={`sales-order-card__progress-fill${progressPct === 100 ? ' sales-order-card__progress-fill--done' : ''}`}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

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
          <span className={`sales-order-card__info-value sales-order-card__due-value sales-order-card__due-value--${dueClass}`}>
            {dueDisplay}
            {dueStatus.label && <span className="sales-order-card__due-status">{dueStatus.label}</span>}
          </span>
        </div>
        {displayOrder.quantity > 1 && (
          <div className="sales-order-card__info-item">
            <span className="sales-order-card__info-label">수량</span>
            <span className="sales-order-card__info-value">{displayOrder.quantity}대</span>
          </div>
        )}
      </div>

      <div className="sales-order-card__expand-hint">
        {expanded ? '접기 ▲' : '상세보기 ▼'}
      </div>

      {expanded && (
        <div className="sales-order-card__detail">
          <div className="sales-order-card__detail-grid">
            {isShipped && displayOrder.ship_date && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">출고일</span>
                <span className="sales-order-card__detail-value">{displayOrder.ship_date}</span>
              </div>
            )}
            {displayOrder.order_date && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">발주일</span>
                <span className="sales-order-card__detail-value">{displayOrder.order_date}</span>
              </div>
            )}
            {displayDueDate && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">납기일</span>
                <span className="sales-order-card__detail-value">{displayDueDate}</span>
              </div>
            )}
            {displayOrder.sales_person && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">담당</span>
                <span className="sales-order-card__detail-value">{displayOrder.sales_person}</span>
              </div>
            )}
            {displayOrder.phone && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">연락처</span>
                <span className="sales-order-card__detail-value">{displayOrder.phone}</span>
              </div>
            )}
            {displayOrder.color && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">색상</span>
                <span className="sales-order-card__detail-value">{displayOrder.color}</span>
              </div>
            )}
            {displayOrder.design && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">디자인</span>
                <span className="sales-order-card__detail-value">{displayOrder.design}</span>
              </div>
            )}
            {deliveryAddress && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">주소</span>
                <span className="sales-order-card__detail-value">{deliveryAddress}</span>
              </div>
            )}
            {balanceDisplay && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">남은 잔금</span>
                <span className="sales-order-card__detail-value">{balanceDisplay}</span>
              </div>
            )}
            {freightPayment && (
              <div className="sales-order-card__detail-item">
                <span className="sales-order-card__detail-label">운임여부</span>
                <span className="sales-order-card__detail-value">{freightPayment}</span>
              </div>
            )}
            {workOrderImageUrl && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">작업지시서</span>
                <a
                  className="sales-order-card__detail-value sales-order-card__detail-file"
                  href={workOrderImageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  보기
                </a>
              </div>
            )}
            {visibleNotes && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">비고</span>
                <span className="sales-order-card__detail-value">{visibleNotes}</span>
              </div>
            )}
            {visibleRemarks && (
              <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                <span className="sales-order-card__detail-label">특이사항</span>
                <span className="sales-order-card__detail-value">{visibleRemarks}</span>
              </div>
            )}
          </div>

          {detailLoading && (
            <div className="sales-order-card__detail-note">상세 정보를 불러오는 중...</div>
          )}
          {detailError && (
            <div className="sales-order-card__detail-note sales-order-card__detail-note--error">{detailError}</div>
          )}

          {(orderPhotos.length > 0 || openIssues.length > 0) && (
            <div className="sales-order-card__detail-grid">
              {orderPhotos.length > 0 && (
                <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                  <span className="sales-order-card__detail-label">사진</span>
                  <span className="sales-order-card__detail-value sales-order-card__detail-attachments">
                    {orderPhotos.map((photo, index) => (
                      <a
                        key={photo.id || photo.file_path || index}
                        href={getPhotoHref(photo)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        사진 {index + 1}
                      </a>
                    ))}
                  </span>
                </div>
              )}
              {openIssues.length > 0 && (
                <div className="sales-order-card__detail-item sales-order-card__detail-item--full">
                  <span className="sales-order-card__detail-label">이슈</span>
                  <span className="sales-order-card__detail-value">
                    미해결 {openIssues.length}건
                  </span>
                </div>
              )}
            </div>
          )}

          {(isShipped || displayOrder.packing_photo_url) && (
            <div className="sales-order-card__packing-photo">
              {displayOrder.packing_photo_url ? (
                <>
                <button
                  className="sales-order-card__packing-photo-preview"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPackingPhotoOpen(true);
                  }}
                >
                  <img src={displayOrder.packing_photo_url} alt="포장사진" />
                  포장사진 보기
                </button>
                <a
                  className="sales-order-card__packing-photo-download"
                  href={displayOrder.packing_photo_url}
                  download="packing-photo"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  다운로드
                </a>
                </>
              ) : (
                <span className="sales-order-card__packing-photo-empty">포장사진 없음</span>
              )}
            </div>
          )}

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
              const completedTime = stepTimeMap[step];
              return (
                <div key={idx} className="sales-order-card__process-item">
                  <span className={dotCls} />
                  <span className="sales-order-card__process-name">
                    {step}
                    {worker && <span className="sales-order-card__process-worker-inline">({worker})</span>}
                    {isDone && completedTime && (
                      <span className="sales-order-card__process-time">{formatProcessCompletionTime(completedTime)}</span>
                    )}
                  </span>
                  <span className={statusCls}>
                    {statusText}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="sales-order-card__actions">
            {onEdit && !isShipped && (
              <button
                className="sales-order-card__edit-btn"
                onClick={(e) => { e.stopPropagation(); onEdit(order); }}
              >
                수정
              </button>
            )}
            {onShip && !isShipped && (
              !confirmShip ? (
                <button
                  className="sales-order-card__ship-btn"
                  onClick={(e) => { e.stopPropagation(); setConfirmShip(true); }}
                >
                  출고완료
                </button>
              ) : (
                <div className="sales-order-card__ship-confirm">
                  <span className="sales-order-card__ship-warn">출고 처리하시겠습니까?</span>
                  <button
                    className="sales-order-card__ship-btn sales-order-card__ship-btn--yes"
                    disabled={shipping}
                    onClick={async (e) => {
                      e.stopPropagation();
                      if (shipping) return;
                      setShipping(true);
                      try {
                        await onShip(order);
                        setConfirmShip(false);
                      } finally {
                        setShipping(false);
                      }
                    }}
                  >
                    {shipping ? '처리 중...' : '확인'}
                  </button>
                  <button
                    className="sales-order-card__ship-btn sales-order-card__ship-btn--no"
                    onClick={(e) => { e.stopPropagation(); setConfirmShip(false); }}
                    disabled={shipping}
                  >
                    취소
                  </button>
                </div>
              )
            )}
            <button
              className="sales-order-card__document-btn"
              onClick={(e) => openDocumentPreview('shipping', e)}
            >
              출하지시서 출력
            </button>
            <button
              className="sales-order-card__document-btn"
              onClick={(e) => openDocumentPreview('delivery', e)}
            >
              납품내역서 출력
            </button>
          </div>

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

      {packingPhotoOpen && displayOrder.packing_photo_url && (
        <div
          className="sales-order-card__photo-viewer"
          onClick={(e) => {
            e.stopPropagation();
            setPackingPhotoOpen(false);
          }}
        >
          <div className="sales-order-card__photo-viewer-panel" onClick={(e) => e.stopPropagation()}>
            <div className="sales-order-card__photo-viewer-head">
              <span>포장사진</span>
              <button
                className="sales-order-card__photo-viewer-close"
                onClick={(e) => {
                  e.stopPropagation();
                  setPackingPhotoOpen(false);
                }}
              >
                닫기
              </button>
            </div>
            <img src={displayOrder.packing_photo_url} alt="포장사진" className="sales-order-card__photo-viewer-img" />
          </div>
        </div>
      )}

      {documentPreview && createPortal((
        <div
          className="sales-order-card__document-modal"
          role="dialog"
          aria-modal="true"
          aria-label={`${documentPreview.title} 미리보기`}
          onClick={closeDocumentPreview}
        >
          <div
            className="sales-order-card__document-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sales-order-card__document-toolbar">
              <strong>{documentPreview.title} 미리보기</strong>
              <div className="sales-order-card__document-toolbar-actions">
                <button className="sales-order-card__document-print" onClick={printDocumentPreview}>
                  인쇄하기
                </button>
                <button className="sales-order-card__document-close" onClick={closeDocumentPreview}>
                  닫기
                </button>
              </div>
            </div>
            <div className={`sales-order-card__document-sheet${documentPreview.type === 'shipping' ? ' sales-order-card__document-sheet--shipping' : ''}`}>
              <div className="sales-order-card__document-top">
                <div>
                  <h2>{documentPreview.title}</h2>
                  <div className="sales-order-card__document-receiver">
                    <strong>{documentPreview.customerName}</strong>
                    <span>연락처 {documentPreview.customerPhone}</span>
                    <span>납품주소 {documentPreview.customerAddress}</span>
                  </div>
                </div>
                <div className="sales-order-card__document-supplier-wrap">
                  <div className="sales-order-card__document-stamp">한성<br />쇼케이스<br />그룹</div>
                  <table className="sales-order-card__document-supplier">
                    <tbody>
                      <tr>
                        <th rowSpan="4" className="sales-order-card__document-vertical">공<br />급<br />자</th>
                        <th>주문일</th>
                        <td>{documentPreview.orderDate}</td>
                        <th>출고일</th>
                        <td>{documentPreview.shipDate}</td>
                      </tr>
                      <tr>
                        <th>사업자번호</th>
                        <td>{documentPreview.company.businessNumber}</td>
                        <th>전화</th>
                        <td>{documentPreview.company.phone}</td>
                      </tr>
                      <tr>
                        <th>상호/성명</th>
                        <td colSpan="3">{documentPreview.company.name}</td>
                      </tr>
                      <tr>
                        <th>주소</th>
                        <td colSpan="3">{documentPreview.company.address}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <table className="sales-order-card__document-items">
                <thead>
                  <tr>
                    <th>월/일</th>
                    <th>품목명</th>
                    <th>규격</th>
                    <th>수량</th>
                    <th>적요</th>
                    {documentPreview.type === 'shipping' && <th>창고명</th>}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: documentPreview.type === 'shipping' ? 9 : 7 }, (_, index) => {
                    const row = documentPreview.rows[index] || {};
                    return (
                      <tr key={index}>
                        <td>{row.date || ''}</td>
                        <td>{row.itemName || ''}</td>
                        <td>{row.spec || ''}</td>
                        <td>{row.quantity || ''}</td>
                        <td>{row.note || ''}</td>
                        {documentPreview.type === 'shipping' && (
                          <td className="sales-order-card__document-red">{row.warehouse || ''}</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="sales-order-card__document-notice">
                {documentPreview.notice.map((line, index) => (
                  <div key={index}>※ {line}</div>
                ))}
              </div>
              {(documentPreview.balanceText || documentPreview.freightText) && (
                <table className="sales-order-card__document-balance">
                  <tbody>
                    {documentPreview.balanceText && <tr><th>잔금내역</th><td>{documentPreview.balanceText}</td></tr>}
                    {documentPreview.freightText && <tr><th>운임여부</th><td>{documentPreview.freightText}</td></tr>}
                  </tbody>
                </table>
              )}
              <table className="sales-order-card__document-sign">
                <tbody>
                  <tr>
                    <th>배송담당자</th><td className="sales-order-card__document-sign-cell" />
                    {documentPreview.type !== 'shipping' && (
                      <>
                        <th>수취인</th><td className="sales-order-card__document-sign-cell" />
                        <th>수평확인완료</th><td className="sales-order-card__document-sign-cell" />
                      </>
                    )}
                  </tr>
                </tbody>
              </table>
              {renderDocumentGuide(documentPreview.levelingGuide)}
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}
