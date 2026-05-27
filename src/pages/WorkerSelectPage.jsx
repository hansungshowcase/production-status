import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { WORKERS, WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY, DEPARTMENTS, DEPARTMENT_STEP_MAP, DEPT_ICONS, LAST_STATION_KEY, PROCESS_STEPS, STEP_ICONS, WORKER_DEPARTMENT_FILTER } from '../constants';
import { getStats } from '../api/stats';
import { getOrders } from '../api/orders';
import './WorkerSelectPage.css';

export default function WorkerSelectPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.redirectTo || '/worker/station';

  // 부서변경으로 왔으면 작업자는 이미 선택된 상태 → 바로 부서 선택
  const existingWorker = sessionStorage.getItem(WORKER_STORAGE_KEY);
  const deptChangeOnly = location.state?.deptChangeOnly && existingWorker;

  const [step, setStep] = useState(deptChangeOnly ? 'department' : 'worker');
  const [selectedWorker, setSelectedWorker] = useState(deptChangeOnly ? existingWorker : null);
  const [factoryStats, setFactoryStats] = useState(null);
  const [workOrderSearch, setWorkOrderSearch] = useState('');
  const [workOrderResults, setWorkOrderResults] = useState([]);
  const [workOrderLoading, setWorkOrderLoading] = useState(false);
  const selectableDepartments = WORKER_DEPARTMENT_FILTER[selectedWorker] || DEPARTMENTS;
  const delayedOrders = factoryStats?.delayed_orders || [];
  const delayedSteps = factoryStats?.delayed_by_step || [];

  useEffect(() => {
    getStats().then(setFactoryStats).catch(() => {});
  }, []);

  useEffect(() => {
    const query = workOrderSearch.trim();
    if (!query) {
      setWorkOrderResults([]);
      setWorkOrderLoading(false);
      return undefined;
    }

    setWorkOrderLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await getOrders({ search: query, status: 'in_production', limit: 8 });
        setWorkOrderResults(Array.isArray(res) ? res : (res.orders || []));
      } catch {
        setWorkOrderResults([]);
      } finally {
        setWorkOrderLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [workOrderSearch]);

  function handleSelectWorker(name) {
    setSelectedWorker(name);
    setStep('department');
  }

  function handleSelectDepartment(dept) {
    finishSelection(selectedWorker, dept);
  }

  function finishSelection(name, department) {
    sessionStorage.setItem(WORKER_STORAGE_KEY, name);
    sessionStorage.setItem(DEPARTMENT_STORAGE_KEY, department);

    const stepName = DEPARTMENT_STEP_MAP[department];
    if (stepName) {
      localStorage.setItem(LAST_STATION_KEY, stepName);
      navigate(`/worker/station/${encodeURIComponent(stepName)}`);
    } else {
      navigate(redirectTo);
    }
  }

  function handleBack() {
    setStep('worker');
    setSelectedWorker(null);
  }

  function getCurrentStep(order) {
    const summary = order?.process_summary || {};
    return (
      PROCESS_STEPS.find((name) => summary[name]?.status === 'in_progress') ||
      PROCESS_STEPS.find((name) => summary[name]?.status === 'waiting') ||
      PROCESS_STEPS[0]
    );
  }

  function handleSelectWorkOrder(order) {
    const stepName = getCurrentStep(order);
    localStorage.setItem(LAST_STATION_KEY, stepName);
    navigate(`/worker/station/${encodeURIComponent(stepName)}`, {
      state: { focusOrderId: order.id },
    });
  }

  function handleSelectDelayedOrder(order) {
    const stepName = order.step_name || getCurrentStep(order);
    localStorage.setItem(LAST_STATION_KEY, stepName);
    navigate(`/worker/station/${encodeURIComponent(stepName)}`, {
      state: { focusOrderId: order.order_id || order.id },
    });
  }

  // 부서 선택 단계
  if (step === 'department') {
    return (
      <div className="worker-select-page">
        <div className="worker-select-page__header">
          <button className="worker-select-page__back-btn" onClick={handleBack}>
            ← 다시 선택
          </button>
          <button className="worker-select-page__home-btn" onClick={() => navigate('/')}>🏠 홈</button>
        </div>

        <div className="worker-select-page__hero">
          <div className="worker-select-page__avatar worker-select-page__avatar--selected">
            <span>👤</span>
          </div>
          <h1 className="worker-select-page__name">{selectedWorker}</h1>
          <p className="worker-select-page__subtitle">현재 하고 계시는 작업을 선택해주세요</p>
        </div>

        <div className="worker-select-page__dept-grid">
          {selectableDepartments.map((dept) => (
            <button
              key={dept}
              className="worker-select-page__dept-btn"
              onClick={() => handleSelectDepartment(dept)}
            >
              <span className="worker-select-page__dept-icon">{DEPT_ICONS[dept] || '🏭'}</span>
              <span className="worker-select-page__dept-label">{dept}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // 작업자 선택 단계
  return (
    <div className="worker-select-page">
      <div className="worker-select-page__top-bar">
        <button className="worker-select-page__home-btn" onClick={() => navigate('/')}>🏠 홈</button>
      </div>
      <div className="worker-select-page__hero">
        <div className="worker-select-page__logo">HS</div>
        <h1 className="worker-select-page__title">한성쇼케이스</h1>
        <p className="worker-select-page__subtitle">작업자를 선택해주세요</p>
      </div>

      <div className="worker-select-page__work-order-search">
        <input
          className="worker-select-page__work-order-input"
          type="search"
          value={workOrderSearch}
          onChange={(e) => setWorkOrderSearch(e.target.value)}
          placeholder="작업지시서 검색: 발주처/상호/제품/규격/메모"
          autoComplete="off"
        />
        {workOrderSearch && (
          <button
            className="worker-select-page__work-order-clear"
            type="button"
            onClick={() => setWorkOrderSearch('')}
            aria-label="검색어 지우기"
          >
            지우기
          </button>
        )}
        {workOrderSearch.trim() && (
          <div className="worker-select-page__work-order-results">
            {workOrderLoading && (
              <div className="worker-select-page__work-order-empty">검색 중...</div>
            )}
            {!workOrderLoading && workOrderResults.length === 0 && (
              <div className="worker-select-page__work-order-empty">검색된 작업지시서가 없습니다</div>
            )}
            {!workOrderLoading && workOrderResults.map((order) => {
              const stepName = getCurrentStep(order);
              const dimensions = [order.width, order.depth, order.height].filter(Boolean).join('x');
              const spec = [order.product_type, order.door_type].filter(Boolean).join(' / ') || '-';
              return (
                <button
                  key={order.id}
                  type="button"
                  className="worker-select-page__work-order-item"
                  onClick={() => handleSelectWorkOrder(order)}
                >
                  <span className="worker-select-page__work-order-client">{order.client_name || '미지정'}</span>
                  <span className="worker-select-page__work-order-meta">
                    {spec} · {dimensions || '규격없음'} · {order.due_date || '납기없음'}
                  </span>
                  <span className="worker-select-page__work-order-step">{stepName}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="worker-select-page__grid">
        {WORKERS.map((name) => (
          <button
            key={name}
            className="worker-select-page__btn"
            onClick={() => handleSelectWorker(name)}
          >
            <div className="worker-select-page__avatar">
              <span>👤</span>
            </div>
            <span className="worker-select-page__btn-label">{name}</span>
          </button>
        ))}
      </div>

      {/* 공장 전체 현황 - 항상 렌더링하여 레이아웃 시프트 방지 */}
      <div className="worker-select-page__factory">
        <h2 className="worker-select-page__factory-title">공장 전체 현황</h2>
        <div className="worker-select-page__factory-global">
          <span className="worker-select-page__factory-stat">
            주문 <strong>{factoryStats?.total_orders ?? '-'}</strong>
          </span>
          <span className="worker-select-page__factory-stat">
            생산중 <strong>{factoryStats?.in_production ?? '-'}</strong>
          </span>
          <span className="worker-select-page__factory-stat">
            출고 <strong>{factoryStats?.shipped ?? '-'}</strong>
          </span>
          {factoryStats?.overdue_count > 0 && (
            <span className="worker-select-page__factory-stat worker-select-page__factory-stat--red">
              납기초과 <strong>{factoryStats.overdue_count}</strong>
            </span>
          )}
        </div>
        {delayedOrders.length > 0 && (
          <div className="worker-select-page__delay-panel">
            <div className="worker-select-page__delay-head">
              <span className="worker-select-page__delay-title">납기초과 작업</span>
              <span className="worker-select-page__delay-count">{delayedOrders.length}건</span>
            </div>
            {delayedSteps.length > 0 && (
              <div className="worker-select-page__delay-steps">
                {delayedSteps.slice(0, 4).map(step => (
                  <span key={step.step_name} className="worker-select-page__delay-step">
                    {step.step_name} <strong>{step.delayed}</strong>
                  </span>
                ))}
              </div>
            )}
            <div className="worker-select-page__delay-list">
              {delayedOrders.slice(0, 6).map(order => {
                const product = [order.product_type, order.door_type].filter(Boolean).join(' / ') || '제품 미입력';
                const size = [order.width, order.depth, order.height].filter(Boolean).join('x');
                return (
                  <button
                    key={order.order_id}
                    type="button"
                    className="worker-select-page__delay-item"
                    onClick={() => handleSelectDelayedOrder(order)}
                  >
                    <span className="worker-select-page__delay-main">
                      <strong>{order.client_name || '거래처 미입력'}</strong>
                      <span>{product}{size ? ` · ${size}` : ''}</span>
                    </span>
                    <span className="worker-select-page__delay-meta">
                      <span>{order.step_name}</span>
                      <strong>D+{order.days_overdue}</strong>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="worker-select-page__factory-steps">
          {PROCESS_STEPS.map((s) => {
            const st = (factoryStats?.by_step || []).find(x => x.step_name === s);
            const w = st?.waiting || 0;
            const p = st?.in_progress || 0;
            const c = st?.completed || 0;
            const d = st?.delayed || 0;
            const total = w + p + c;
            const pct = total > 0 ? Math.round((c / total) * 100) : 0;
            return (
              <div key={s} className={`worker-select-page__fstep${p > 0 ? ' worker-select-page__fstep--active' : ''}${d > 0 ? ' worker-select-page__fstep--delayed' : ''}`}>
                <div className="worker-select-page__fstep-icon">{STEP_ICONS[s]}</div>
                <div className="worker-select-page__fstep-name">{s}</div>
                <div className="worker-select-page__fstep-bar">
                  <div className="worker-select-page__fstep-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="worker-select-page__fstep-counts">
                  {d > 0 && <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--delay">지연 {d}</span>}
                  {p > 0 && <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--prog">{p}</span>}
                  {w > 0 && <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--wait">{w}</span>}
                  <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--done">{c}/{total}</span>
                </div>
              </div>
              );
            })}
          </div>
      </div>
      <div className="worker-select-page__footer">
        <span className="worker-select-page__motto">잘 만든 제품은 고객의 삶을 바꿉니다.</span>
      </div>
    </div>
  );
}
