import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROCESS_STEPS, STEP_ICONS } from '../stationConstants';
import { WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY, DEPARTMENT_STEP_MAP, LAST_STATION_KEY } from '../constants';
import './WorkerStationPage.css';

export default function WorkerStationPage() {
  const navigate = useNavigate();
  const workerName = sessionStorage.getItem(WORKER_STORAGE_KEY);
  const department = sessionStorage.getItem(DEPARTMENT_STORAGE_KEY);
  const lastStation = localStorage.getItem(LAST_STATION_KEY);

  useEffect(() => {
    if (!workerName) {
      navigate('/worker/select', { state: { redirectTo: '/worker/station' }, replace: true });
      return;
    }

    // 부서가 이미 선택되어 있으면 해당 공정으로 바로 이동
    if (department) {
      const stepName = DEPARTMENT_STEP_MAP[department];
      if (stepName) {
        localStorage.setItem(LAST_STATION_KEY, stepName);
        navigate(`/worker/station/${encodeURIComponent(stepName)}`, { replace: true });
        return;
      }
    }
  }, [workerName, department, navigate]);

  function handleSelect(stepName) {
    localStorage.setItem(LAST_STATION_KEY, stepName);
    navigate(`/worker/station/${encodeURIComponent(stepName)}`);
  }

  function handleChangeWorker() {
    sessionStorage.removeItem(WORKER_STORAGE_KEY);
    sessionStorage.removeItem(DEPARTMENT_STORAGE_KEY);
    navigate('/worker/select', { state: { redirectTo: '/worker/station' } });
  }

  return (
    <div className="station-page">
      <div className="station-page__top-bar">
        <button className="station-page__home-btn" onClick={() => navigate('/')}>🏠 홈</button>
      </div>
      {workerName && (
        <div className="station-page__worker-bar">
          <span className="station-page__worker-name">👷 {workerName}님{department ? ` (${department})` : ''}</span>
          <button className="station-page__change-worker-btn" onClick={handleChangeWorker}>
            작업자 변경
          </button>
        </div>
      )}

      <h1 className="station-page__title">어디 작업자이신가요?</h1>

      {lastStation && (
        <div
          className="station-page__last-pick"
          onClick={() => handleSelect(lastStation)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleSelect(lastStation)}
        >
          <span className="station-page__last-pick-label">마지막 선택:</span>
          <span className="station-page__last-pick-name">
            {STEP_ICONS[lastStation] || ''} {lastStation}
          </span>
          <span className="station-page__last-pick-arrow">&rarr;</span>
        </div>
      )}

      <div className="station-page__grid">
        {PROCESS_STEPS.map((step) => (
          <button
            key={step}
            className="station-page__btn"
            onClick={() => handleSelect(step)}
          >
            <span className="station-page__btn-icon">{STEP_ICONS[step]}</span>
            <span className="station-page__btn-label">{step}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
