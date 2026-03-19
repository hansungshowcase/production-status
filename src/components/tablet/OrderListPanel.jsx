import { useState, useMemo } from 'react';
import { PROCESS_STEPS } from '../../constants';
import StepFilterBar from './StepFilterBar';
import './OrderListPanel.css';

const STEP_ORDER = PROCESS_STEPS;

function getCurrentStep(processes) {
  if (!processes || !processes.length) return '도면설계';
  for (const step of STEP_ORDER) {
    const proc = processes.find((p) => p.step_name === step);
    if (proc && proc.status !== 'done') return step;
  }
  return '포장';
}

function isOverdue(dueDate) {
  if (!dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dueDate) < today;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function OrderListPanel({ orders = [], selectedId, onSelect }) {
  const [activeStep, setActiveStep] = useState('전체');
  const [search, setSearch] = useState('');

  const ordersWithStep = useMemo(() => {
    return orders.map((order) => ({
      ...order,
      currentStep: getCurrentStep(order.processes),
    }));
  }, [orders]);

  const stepCounts = useMemo(() => {
    const counts = {};
    STEP_ORDER.forEach((s) => (counts[s] = 0));
    ordersWithStep.forEach((o) => {
      if (counts[o.currentStep] !== undefined) counts[o.currentStep]++;
    });
    return counts;
  }, [ordersWithStep]);

  const filtered = useMemo(() => {
    let list = ordersWithStep;
    if (activeStep !== '전체') {
      list = list.filter((o) => o.currentStep === activeStep);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (o) =>
          (o.client_name || '').toLowerCase().includes(q) ||
          (o.product_type || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [ordersWithStep, activeStep, search]);

  return (
    <div className="order-list-panel">
      <div className="order-list-header">
        <h2>오늘의 작업 주문</h2>
        <input
          type="text"
          className="order-list-search"
          placeholder="거래처 또는 사양 검색..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <StepFilterBar
        activeStep={activeStep}
        onStepChange={setActiveStep}
        stepCounts={stepCounts}
      />
      <div className="order-list-scroll">
        {filtered.length === 0 ? (
          <div className="order-list-empty">해당 조건의 주문이 없습니다.</div>
        ) : (
          filtered.map((order) => {
            const overdue = isOverdue(order.due_date) && order.status !== '출고완료';
            return (
              <div
                key={order.id}
                className={[
                  'order-list-item',
                  selectedId === order.id ? 'order-list-item--selected' : '',
                  overdue ? 'order-list-item--overdue' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onSelect(order.id)}
              >
                <div className="order-list-client">{order.client_name || '(거래처 없음)'}</div>
                <div className="order-list-spec">
                  {order.product_type || '-'} · {order.width}x{order.depth}x{order.height}
                </div>
                <div className="order-list-meta">
                  <span className="order-list-step">{order.currentStep}</span>
                  <span className={`order-list-due ${overdue ? 'order-list-due--overdue' : ''}`}>
                    납기 {formatDate(order.due_date)} {overdue ? '⚠ 초과' : ''}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
