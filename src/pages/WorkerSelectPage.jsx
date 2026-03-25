import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { WORKERS, WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY, DEPARTMENTS, DEPARTMENT_STEP_MAP, DEPT_ICONS, LAST_STATION_KEY, PROCESS_STEPS, STEP_ICONS, WORKER_DEPARTMENT_FILTER } from '../constants';
import { getStats } from '../api/stats';
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

  useEffect(() => {
    // 스크롤 방지: stats 로드 시 레이아웃 변경으로 스크롤 밀림 방지
    document.body.style.overflow = 'hidden';
    getStats().then((data) => {
      window.scrollTo(0, 0);
      setFactoryStats(data);
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
        document.body.style.overflow = '';
      });
    }).catch(() => {
      document.body.style.overflow = '';
    });
  }, []);

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
          {(WORKER_DEPARTMENT_FILTER[selectedWorker] || DEPARTMENTS).map((dept) => (
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

      {/* 공장 전체 현황 */}
      {factoryStats && (
        <div className="worker-select-page__factory">
          <h2 className="worker-select-page__factory-title">공장 전체 현황</h2>
          <div className="worker-select-page__factory-global">
            <span className="worker-select-page__factory-stat">
              주문 <strong>{factoryStats.total_orders}</strong>
            </span>
            <span className="worker-select-page__factory-stat">
              생산중 <strong>{factoryStats.in_production}</strong>
            </span>
            <span className="worker-select-page__factory-stat">
              출고 <strong>{factoryStats.shipped}</strong>
            </span>
            {factoryStats.overdue_count > 0 && (
              <span className="worker-select-page__factory-stat worker-select-page__factory-stat--red">
                납기초과 <strong>{factoryStats.overdue_count}</strong>
              </span>
            )}
          </div>
          <div className="worker-select-page__factory-steps">
            {PROCESS_STEPS.map((s) => {
              const st = (factoryStats.by_step || []).find(x => x.step_name === s);
              const w = st?.waiting || 0;
              const p = st?.in_progress || 0;
              const c = st?.completed || 0;
              const total = w + p + c;
              const pct = total > 0 ? Math.round((c / total) * 100) : 0;
              return (
                <div key={s} className={`worker-select-page__fstep${p > 0 ? ' worker-select-page__fstep--active' : ''}`}>
                  <div className="worker-select-page__fstep-icon">{STEP_ICONS[s]}</div>
                  <div className="worker-select-page__fstep-name">{s}</div>
                  <div className="worker-select-page__fstep-bar">
                    <div className="worker-select-page__fstep-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="worker-select-page__fstep-counts">
                    {p > 0 && <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--prog">{p}</span>}
                    {w > 0 && <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--wait">{w}</span>}
                    <span className="worker-select-page__fstep-cnt worker-select-page__fstep-cnt--done">{c}/{total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="worker-select-page__footer">
        <span className="worker-select-page__motto">잘 만든 제품은 고객의 삶을 바꿉니다.</span>
      </div>
    </div>
  );
}
