import { useState, useEffect } from 'react';
import { PROCESS_STEPS } from '../../constants';
import { updatePreProduction } from '../../api/preProduction';
import './OrderDetailPanel.css';

const STEP_ORDER = PROCESS_STEPS;

function isCompletedStatus(status) {
  return status === 'completed' || status === 'done';
}

function getProcessMap(processes) {
  const map = {};
  if (!processes) return map;
  const priority = { in_progress: 3, waiting: 2, completed: 1, done: 1 };
  processes.forEach((p) => {
    const current = map[p.step_name];
    if (!current || (priority[p.status] || 0) > (priority[current.status] || 0)) {
      map[p.step_name] = p;
    }
  });
  return map;
}

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

function normalizeProcesses(order) {
  if (order?.processes?.length > 0) return order.processes;
  const summary = parseProcessSummary(order?.process_summary);
  return STEP_ORDER
    .map((step) => summary[step] ? { step_name: step, ...summary[step] } : null)
    .filter(Boolean);
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getFullYear()}.${(d.getMonth() + 1).toString().padStart(2, '0')}.${d.getDate().toString().padStart(2, '0')}`;
}

function displayProcessWorker(step, processLike, salesPerson) {
  if (!processLike) return '';
  if (step === '도면설계') return '김보수 팀장';
  if (processLike.completed_by) return processLike.completed_by;
  if (processLike.started_by && processLike.started_by !== salesPerson) return processLike.started_by;
  return '';
}

const PRE_PRODUCTION_ITEMS = [
  { key: 'instruction_check', label: '지시서 확인' },
  { key: 'material_drawing', label: '자재 도면' },
  { key: 'laser_drawing', label: '레이저 도면' },
  { key: 'material_order_received', label: '자재 발주 접수' },
  { key: 'material_order_completed', label: '자재 발주 완료' },
  { key: 'material_received', label: '자재 입고' },
];

export default function OrderDetailPanel({ order, onStartProcess, onCompleteProcess, onPhotoAttach, onIssueReport }) {
  const [confirm, setConfirm] = useState(null);
  const [preChecklist, setPreChecklist] = useState(() => order?.pre_production || {});
  const [preSaving, setPreSaving] = useState(false);

  // order 변경 시 서버의 pre_production 값으로 초기화 (새로고침 후 체크 보존)
  useEffect(() => {
    setPreChecklist(order?.pre_production || {});
  }, [order?.id, order?.pre_production]);

  if (!order) {
    return (
      <div className="order-detail-panel">
        <div className="order-detail-empty">
          좌측에서 주문을 선택하세요
        </div>
      </div>
    );
  }

  const processMap = getProcessMap(normalizeProcesses(order));

  // Determine current step
  let currentStepName = null;
  let currentProcess = null;
  for (const step of STEP_ORDER) {
    const proc = processMap[step];
    if (!proc || !isCompletedStatus(proc.status)) {
      currentStepName = step;
      currentProcess = proc || null;
      break;
    }
  }

  const canStart = currentProcess?.id && currentProcess.status === 'waiting';
  const canComplete = currentProcess?.id && currentProcess.status === 'in_progress';

  function handleConfirmAction() {
    if (!confirm) return;
    if (confirm.type === 'start') {
      onStartProcess(currentProcess.id);
    } else if (confirm.type === 'complete') {
      onCompleteProcess(currentProcess.id);
    }
    setConfirm(null);
  }

  async function handlePreChecklistToggle(key) {
    const updated = { ...preChecklist, [key]: !preChecklist[key] };
    setPreChecklist(updated);
    setPreSaving(true);
    try {
      await updatePreProduction(order.id, updated);
    } catch (err) {
      console.error('사전생산 체크리스트 업데이트 실패:', err);
    } finally {
      setPreSaving(false);
    }
  }

  // Build pipeline status for each step
  function getStepStatus(stepName) {
    const proc = processMap[stepName];
    if (!proc) {
      return stepName === currentStepName ? 'active' : 'waiting';
    }
    if (isCompletedStatus(proc.status)) return 'done';
    if (proc.status === 'in_progress') return 'active';
    if (stepName === currentStepName) return 'active';
    return 'waiting';
  }

  // Timeline entries
  const timeline = [];
  STEP_ORDER.forEach((step) => {
    const proc = processMap[step];
    if (!proc) return;
    if (proc.started_at) {
      timeline.push({
        step,
        action: '시작',
        worker: displayProcessWorker(step, proc, order.sales_person) || '-',
        time: proc.started_at,
        active: proc.status === 'in_progress',
      });
    }
    if (proc.completed_at) {
      timeline.push({
        step,
        action: '완료',
        worker: displayProcessWorker(step, proc, order.sales_person) || '-',
        time: proc.completed_at,
        active: false,
      });
    }
  });
  timeline.sort((a, b) => new Date(b.time) - new Date(a.time));

  return (
    <div className="order-detail-panel">
      {/* Order info */}
      <div className="order-detail-info">
        <div className="order-detail-client">{order.client_name || '(거래처 없음)'}</div>
        <div className="order-detail-grid">
          <div className="order-detail-field">
            <span className="order-detail-field-label">사양</span>
            <span className="order-detail-field-value">{order.product_type || '-'}</span>
          </div>
          <div className="order-detail-field">
            <span className="order-detail-field-label">규격</span>
            <span className="order-detail-field-value">
              {order.width || '-'} x {order.depth || '-'} x {order.height || '-'}
            </span>
          </div>
          <div className="order-detail-field">
            <span className="order-detail-field-label">색상</span>
            <span className="order-detail-field-value">{order.color || '-'}</span>
          </div>
          <div className="order-detail-field">
            <span className="order-detail-field-label">수량</span>
            <span className="order-detail-field-value">{order.quantity || '-'}대</span>
          </div>
          <div className="order-detail-field">
            <span className="order-detail-field-label">납기일</span>
            <span className="order-detail-field-value">{formatDate(order.due_date)}</span>
          </div>
          <div className="order-detail-field">
            <span className="order-detail-field-label">담당</span>
            <span className="order-detail-field-value">{order.sales_person || '-'}</span>
          </div>
        </div>
      </div>

      {/* Pre-production checklist */}
      <div className="order-detail-prechecklist">
        <h3>사전생산 체크리스트 {preSaving && <span style={{ fontSize: '0.8em', color: 'var(--text-dim)' }}>(저장중...)</span>}</h3>
        <div className="prechecklist-items">
          {PRE_PRODUCTION_ITEMS.map((item) => (
            <label key={item.key} className="prechecklist-item">
              <input
                type="checkbox"
                checked={!!preChecklist[item.key]}
                onChange={() => handlePreChecklistToggle(item.key)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Pipeline */}
      <div className="order-detail-pipeline">
        <h3>공정 진행 상황</h3>
        <div className="pipeline-steps">
          {STEP_ORDER.map((step, idx) => {
            const status = getStepStatus(step);
            return (
              <div key={step} style={{ display: 'contents' }}>
                {idx > 0 && (
                  <div
                    className={`pipeline-connector ${status === 'done' || getStepStatus(STEP_ORDER[idx - 1]) === 'done' ? 'pipeline-connector--done' : ''}`}
                  />
                )}
                <div className={`pipeline-step pipeline-step--${status}`}>
                  <div className="pipeline-step-dot">
                    {status === 'done' ? '✓' : idx + 1}
                  </div>
                  <span className="pipeline-step-label">{step}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Current status */}
      {currentProcess && (
        <div className="order-detail-status">
          <div className="order-detail-status-info">
            현재 공정: <strong>{currentStepName}</strong>
            {currentProcess.status === 'in_progress' && displayProcessWorker(currentStepName, currentProcess, order.sales_person) && (
              <> — {displayProcessWorker(currentStepName, currentProcess, order.sales_person)}님이 {formatDateTime(currentProcess.started_at)}에 시작</>
            )}
            {currentProcess.status === 'waiting' && <> — 대기 중</>}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="order-detail-actions">
        <button
          className="tablet-btn tablet-btn--blue"
          disabled={!canStart}
          onClick={() => setConfirm({ type: 'start', label: `${currentStepName} 공정을 시작하시겠습니까?` })}
        >
          공정 시작
        </button>
        <button
          className="tablet-btn tablet-btn--green"
          disabled={!canComplete}
          onClick={() => setConfirm({ type: 'complete', label: `${currentStepName} 공정을 완료하시겠습니까?` })}
        >
          공정 완료
        </button>
        <button
          className="tablet-btn tablet-btn--purple"
          onClick={() => onPhotoAttach && onPhotoAttach(order.id)}
        >
          사진 첨부
        </button>
        <button
          className="tablet-btn tablet-btn--red"
          onClick={() => onIssueReport && onIssueReport(order.id)}
        >
          이슈 보고
        </button>
      </div>

      {/* Process timeline */}
      {timeline.length > 0 && (
        <div className="order-detail-timeline">
          <h3>공정 이력</h3>
          {timeline.map((entry, idx) => (
            <div key={idx} className="timeline-item">
              <div className={`timeline-dot ${entry.active ? 'timeline-dot--active' : ''}`} />
              <div className="timeline-content">
                <div className="timeline-step">
                  {entry.step} {entry.action}
                </div>
                <div className="timeline-detail">
                  {entry.worker} · {formatDateTime(entry.time)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Confirmation modal */}
      {confirm && (
        <div className="confirm-overlay" onClick={() => setConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3>확인</h3>
            <p>{confirm.label}</p>
            <div className="confirm-modal-buttons">
              <button className="tablet-btn tablet-btn--outline" onClick={() => setConfirm(null)}>
                취소
              </button>
              <button
                className={`tablet-btn ${confirm.type === 'start' ? 'tablet-btn--blue' : 'tablet-btn--green'}`}
                onClick={handleConfirmAction}
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
