import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { WORKERS, WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY, WORKER_CONFIRMED_KEY, DEPARTMENTS, DEPARTMENT_STEP_MAP, DEPT_ICONS, LAST_STATION_KEY, PROCESS_STEPS, STEP_ICONS, WORKER_DEPARTMENT_FILTER } from '../constants';
import { getStats } from '../api/stats';
import { getOrders } from '../api/orders';
import { getActor, getRole, login } from '../utils/authClient';
import './WorkerSelectPage.css';

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

export default function WorkerSelectPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const redirectTo = location.state?.redirectTo || '/worker/station';

  // 부서변경으로 왔으면 작업자는 이미 선택된 상태 → 바로 부서 선택
  const existingWorker = sessionStorage.getItem(WORKER_STORAGE_KEY);
  const deptChangeOnly = location.state?.deptChangeOnly && existingWorker && getRole() === 'worker' && getActor() === existingWorker;

  const [step, setStep] = useState(deptChangeOnly ? 'department' : 'worker');
  const [selectedWorker, setSelectedWorker] = useState(deptChangeOnly ? existingWorker : null);
  const [workerPassword, setWorkerPassword] = useState('');
  const [workerLoginError, setWorkerLoginError] = useState('');
  const [workerLoggingIn, setWorkerLoggingIn] = useState(false);
  const [sessionRole, setSessionRole] = useState(getRole());
  const [factoryStats, setFactoryStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsLastSuccess, setStatsLastSuccess] = useState(null);
  const [workOrderSearch, setWorkOrderSearch] = useState('');
  const [workOrderResults, setWorkOrderResults] = useState([]);
  const [workOrderLoading, setWorkOrderLoading] = useState(false);
  const workOrderSearchSeqRef = useRef(0);
  const workOrderSearchRegionRef = useRef(null);
  const workOrderResultsRef = useRef(null);
  const statsRequestSeqRef = useRef(0);
  const statsMountedRef = useRef(false);
  const showWorkOrderResults = Boolean(workOrderSearch.trim());
  const selectableDepartments = WORKER_DEPARTMENT_FILTER[selectedWorker] || DEPARTMENTS;
  const delayedOrders = factoryStats?.delayed_orders || [];
  const delayedSteps = factoryStats?.delayed_by_step || [];
  const dueTodayOrders = factoryStats?.due_today_orders || [];
  const dueTodayOrdersTotalCount = Number(factoryStats?.due_today_count || 0) || dueTodayOrders.length;
  const delayedOrdersTotalCount = Number(factoryStats?.overdue_count || 0) || delayedOrders.length;

  const loadStats = useCallback(async () => {
    const requestSeq = ++statsRequestSeqRef.current;
    setStatsLoading(true);
    try {
      const stats = await getStats();
      if (!statsMountedRef.current || requestSeq !== statsRequestSeqRef.current) return;
      setFactoryStats(stats);
      setStatsLastSuccess(new Date());
      setStatsError(null);
    } catch (err) {
      if (statsMountedRef.current && requestSeq === statsRequestSeqRef.current) {
        setStatsError(err.message || '공장 현황을 불러오지 못했습니다.');
      }
    } finally {
      if (statsMountedRef.current && requestSeq === statsRequestSeqRef.current) {
        setStatsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    statsMountedRef.current = true;
    if (sessionRole) loadStats();
    else setStatsLoading(false);
    return () => {
      statsMountedRef.current = false;
    };
  }, [loadStats, sessionRole]);

  useEffect(() => {
    if (!sessionRole) {
      setWorkOrderResults([]);
      setWorkOrderLoading(false);
      return undefined;
    }
    const query = workOrderSearch.trim();
    if (!query) {
      setWorkOrderResults([]);
      setWorkOrderLoading(false);
      return undefined;
    }

    const seq = ++workOrderSearchSeqRef.current;
    setWorkOrderLoading(true);
    const timer = setTimeout(async () => {
      try {
        const activeRes = await getOrders({ search: query, search_mode: 'work_order', status: 'in_production', limit: 12 });
        let results = Array.isArray(activeRes) ? activeRes : (activeRes.orders || []);
        if (results.length === 0) {
          const allRes = await getOrders({ search: query, search_mode: 'work_order', limit: 12 });
          results = Array.isArray(allRes) ? allRes : (allRes.orders || []);
        }
        if (seq === workOrderSearchSeqRef.current) {
          setWorkOrderResults(results);
        }
      } catch {
        if (seq === workOrderSearchSeqRef.current) {
          setWorkOrderResults([]);
        }
      } finally {
        if (seq === workOrderSearchSeqRef.current) {
          setWorkOrderLoading(false);
        }
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [sessionRole, workOrderSearch]);

  useLayoutEffect(() => {
    if (step !== 'worker' || !showWorkOrderResults) return undefined;

    const searchRegion = workOrderSearchRegionRef.current;
    const resultsList = workOrderResultsRef.current;
    const appRoot = document.getElementById('root');
    if (!searchRegion || !resultsList || !appRoot) return undefined;

    const visualViewport = window.visualViewport;
    let animationFrameId = null;
    let banner = null;
    let mobileHeader = null;

    const measureAvailableHeight = () => {
      animationFrameId = null;
      const anchorRect = searchRegion.getBoundingClientRect();
      const viewportTop = visualViewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (visualViewport?.height ?? window.innerHeight);
      const belowStart = anchorRect.bottom + 8;
      const aboveEnd = anchorRect.top - 8;
      let belowEnd = viewportBottom;
      let aboveStart = viewportTop + 8;

      const cardRows = [...resultsList.querySelectorAll('.worker-select-page__work-order-item')];
      const renderedRows = cardRows.length > 0
        ? cardRows
        : [...resultsList.querySelectorAll('.worker-select-page__work-order-empty')];
      const rowHeights = renderedRows.map(row => row.getBoundingClientRect().height);
      if (rowHeights.length === 0) return;

      const listStyle = window.getComputedStyle(resultsList);
      const listChromeHeight = [
        listStyle.paddingTop,
        listStyle.paddingBottom,
        listStyle.borderTopWidth,
        listStyle.borderBottomWidth,
      ].reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
      const minimumListHeight = Math.max(...rowHeights) + listChromeHeight;

      if (banner) {
        const bannerRect = banner.getBoundingClientRect();
        const bannerStyle = window.getComputedStyle(banner);
        const horizontallyOverlaps = bannerRect.right > anchorRect.left && bannerRect.left < anchorRect.right;
        const visiblyIntersectsViewport = bannerRect.width > 0
          && bannerRect.height > 0
          && bannerRect.bottom > viewportTop
          && bannerRect.top < viewportBottom
          && bannerStyle.display !== 'none'
          && bannerStyle.visibility !== 'hidden';

        if (horizontallyOverlaps && visiblyIntersectsViewport) {
          const intersectsBelow = bannerRect.bottom > belowStart && bannerRect.top < viewportBottom;
          const intersectsAbove = bannerRect.top < aboveEnd && bannerRect.bottom > aboveStart;
          if (intersectsBelow) belowEnd = Math.min(viewportBottom, bannerRect.top - 8);
          if (intersectsAbove) aboveStart = Math.max(viewportTop + 8, bannerRect.bottom + 8);
        }
      }

      if (mobileHeader) {
        const headerRect = mobileHeader.getBoundingClientRect();
        const headerStyle = window.getComputedStyle(mobileHeader);
        const horizontallyOverlaps = headerRect.right > anchorRect.left && headerRect.left < anchorRect.right;
        const visiblyIntersectsViewport = headerRect.width > 0
          && headerRect.height > 0
          && headerRect.bottom > viewportTop
          && headerRect.top < viewportBottom
          && headerStyle.display !== 'none'
          && headerStyle.visibility !== 'hidden'
          && Number.parseFloat(headerStyle.opacity) > 0
          && !mobileHeader.hidden;
        const intersectsAbove = headerRect.top < aboveEnd && headerRect.bottom > viewportTop;

        if (horizontallyOverlaps && visiblyIntersectsViewport && intersectsAbove) {
          aboveStart = Math.max(aboveStart, headerRect.bottom + 8);
        }
      }

      const belowAvailableHeight = Math.max(0, Math.floor(belowEnd - belowStart));
      const aboveAvailableHeight = Math.max(0, Math.floor(aboveEnd - aboveStart));
      let opensUpward = false;
      if (belowAvailableHeight >= minimumListHeight) {
        opensUpward = false;
      } else if (aboveAvailableHeight >= minimumListHeight) {
        opensUpward = true;
      } else {
        opensUpward = aboveAvailableHeight > belowAvailableHeight;
      }

      const availableHeight = opensUpward ? aboveAvailableHeight : belowAvailableHeight;
      const nextHeight = `${availableHeight}px`;
      resultsList.classList.toggle('worker-select-page__work-order-results--up', opensUpward);
      if (resultsList.style.getPropertyValue('--work-order-results-available-height') !== nextHeight) {
        resultsList.style.setProperty('--work-order-results-available-height', nextHeight);
      }
    };

    const scheduleMeasurement = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(measureAvailableHeight);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasurement);
    resizeObserver.observe(searchRegion);
    resizeObserver.observe(resultsList);

    const headerAttributeObserver = new MutationObserver(scheduleMeasurement);

    const reconnectOverlays = () => {
      let changed = false;
      const nextBanner = appRoot.querySelector('.install-prompt');
      if (nextBanner !== banner) {
        if (banner) {
          resizeObserver.unobserve(banner);
          banner.removeEventListener('animationend', scheduleMeasurement);
        }
        banner = nextBanner;
        if (banner) {
          resizeObserver.observe(banner);
          banner.addEventListener('animationend', scheduleMeasurement);
        }
        changed = true;
      }

      const nextHeader = appRoot.querySelector('.mobile-header-bar');
      if (nextHeader !== mobileHeader) {
        headerAttributeObserver.disconnect();
        if (mobileHeader) {
          resizeObserver.unobserve(mobileHeader);
          mobileHeader.removeEventListener('transitionend', scheduleMeasurement);
          mobileHeader.removeEventListener('animationend', scheduleMeasurement);
        }
        mobileHeader = nextHeader;
        if (mobileHeader) {
          resizeObserver.observe(mobileHeader);
          mobileHeader.addEventListener('transitionend', scheduleMeasurement);
          mobileHeader.addEventListener('animationend', scheduleMeasurement);
          headerAttributeObserver.observe(mobileHeader, {
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden'],
          });
        }
        changed = true;
      }

      if (changed) scheduleMeasurement();
    };

    reconnectOverlays();
    const mutationObserver = new MutationObserver(reconnectOverlays);
    mutationObserver.observe(appRoot, { childList: true, subtree: true });

    window.addEventListener('resize', scheduleMeasurement);
    window.addEventListener('scroll', scheduleMeasurement, { passive: true });
    visualViewport?.addEventListener('resize', scheduleMeasurement);
    visualViewport?.addEventListener('scroll', scheduleMeasurement);
    document.addEventListener('scroll', scheduleMeasurement, true);
    scheduleMeasurement();

    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      mutationObserver.disconnect();
      headerAttributeObserver.disconnect();
      resizeObserver.disconnect();
      if (banner) banner.removeEventListener('animationend', scheduleMeasurement);
      if (mobileHeader) {
        mobileHeader.removeEventListener('transitionend', scheduleMeasurement);
        mobileHeader.removeEventListener('animationend', scheduleMeasurement);
      }
      window.removeEventListener('resize', scheduleMeasurement);
      window.removeEventListener('scroll', scheduleMeasurement);
      visualViewport?.removeEventListener('resize', scheduleMeasurement);
      visualViewport?.removeEventListener('scroll', scheduleMeasurement);
      document.removeEventListener('scroll', scheduleMeasurement, true);
      resultsList.classList.remove('worker-select-page__work-order-results--up');
      resultsList.style.removeProperty('--work-order-results-available-height');
    };
  }, [showWorkOrderResults, step]);

  function handleSelectWorker(name) {
    setSelectedWorker(name);
    if (getRole() === 'worker' && getActor() === name) {
      setStep('department');
      return;
    }
    setWorkerPassword('');
    setWorkerLoginError('');
    setStep('password');
  }

  async function handleWorkerLogin(event) {
    event.preventDefault();
    if (!selectedWorker || !workerPassword || workerLoggingIn) return;
    setWorkerLoggingIn(true);
    setWorkerLoginError('');
    try {
      await login('worker', { actor: selectedWorker, password: workerPassword });
      setSessionRole('worker');
      setWorkerPassword('');
      setStep('department');
    } catch (error) {
      setWorkerLoginError(error.message || '로그인에 실패했습니다.');
    } finally {
      setWorkerLoggingIn(false);
    }
  }

  function handleSelectDepartment(dept) {
    finishSelection(selectedWorker, dept);
  }

  function finishSelection(name, department) {
    sessionStorage.setItem(WORKER_STORAGE_KEY, name);
    sessionStorage.setItem(DEPARTMENT_STORAGE_KEY, department);
    // 선택 화면을 거쳤으면 같은 사람을 다시 골랐더라도 공정 화면에서 한 번 더 확인받는다.
    // (공정 사이를 오갈 때는 확인된 이름이 남아 있어 다시 묻지 않는다.)
    sessionStorage.removeItem(WORKER_CONFIRMED_KEY);

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
    setWorkerPassword('');
    setWorkerLoginError('');
  }

  function getCurrentStep(order) {
    const summary = parseProcessSummary(order?.process_summary);
    return PROCESS_STEPS.find((name) => summary[name]?.status !== 'completed') || PROCESS_STEPS[PROCESS_STEPS.length - 1];
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

  if (step === 'password') {
    return (
      <div className="worker-select-page">
        <div className="worker-select-page__header">
          <button className="worker-select-page__back-btn" onClick={handleBack}>← 다시 선택</button>
          <button className="worker-select-page__home-btn" onClick={() => navigate('/')}>🏠 홈</button>
        </div>
        <div className="worker-select-page__hero">
          <div className="worker-select-page__avatar worker-select-page__avatar--selected"><span>👤</span></div>
          <h1 className="worker-select-page__name">{selectedWorker}</h1>
          <p className="worker-select-page__subtitle">본인 확인을 위해 비밀번호를 입력해주세요</p>
        </div>
        <form className="worker-select-page__password-form" onSubmit={handleWorkerLogin}>
          <label htmlFor="worker-password">비밀번호</label>
          <input
            id="worker-password"
            type="password"
            value={workerPassword}
            onChange={(event) => setWorkerPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
          {workerLoginError && <div className="worker-select-page__password-error" role="alert">{workerLoginError}</div>}
          <button type="submit" className="worker-select-page__password-submit" disabled={!workerPassword || workerLoggingIn}>
            {workerLoggingIn ? '확인 중...' : '확인'}
          </button>
        </form>
      </div>
    );
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

      <div className="worker-select-page__work-order-search" ref={workOrderSearchRegionRef}>
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
        {showWorkOrderResults && (
          <div className="worker-select-page__work-order-results" ref={workOrderResultsRef}>
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
        <div className="worker-select-page__stats-status">
          <span>
            {statsLastSuccess
              ? `${statsError ? '마지막 정상 조회' : '조회'} ${statsLastSuccess.getHours().toString().padStart(2, '0')}:${statsLastSuccess.getMinutes().toString().padStart(2, '0')}`
              : (statsLoading ? '현황 조회 중...' : '현황 조회 실패')}
          </span>
          <button
            type="button"
            className="worker-select-page__stats-refresh"
            onClick={loadStats}
            disabled={statsLoading}
          >
            {statsLoading ? '새로고침 중...' : '새로고침'}
          </button>
        </div>
        {statsError && (
          <div className="worker-select-page__stats-error" role="alert">
            <span>
              공장 현황을 불러오지 못했습니다. {statsLastSuccess ? '이전 정상 현황을 표시합니다.' : '잠시 후 다시 시도해 주세요.'}
            </span>
            <button type="button" onClick={loadStats} disabled={statsLoading}>다시 시도</button>
          </div>
        )}
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
          {factoryStats?.due_today_count > 0 && (
            <span className="worker-select-page__factory-stat worker-select-page__factory-stat--today">
              금일출고 <strong>{factoryStats.due_today_count}</strong>
            </span>
          )}
        </div>
        {dueTodayOrders.length > 0 && (
          <div className="worker-select-page__delay-panel worker-select-page__delay-panel--today">
            <div className="worker-select-page__delay-head">
              <span className="worker-select-page__delay-title">금일 출고건</span>
              <span className="worker-select-page__delay-count">{dueTodayOrdersTotalCount}건</span>
            </div>
            <p className="worker-select-page__delay-message">
              오늘 납기 건입니다. 출고 전까지 현재 공정과 담당자를 확인해 주세요.
            </p>
            <div className="worker-select-page__delay-list">
              {dueTodayOrders.map(order => {
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
                      <span className="worker-select-page__delay-due">납기 {order.due_date || '-'}</span>
                      <span className="worker-select-page__delay-worker">담당 {order.started_by || '미배정'}</span>
                      <strong>D-Day</strong>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {delayedOrders.length > 0 && (
          <div className="worker-select-page__delay-panel">
            <div className="worker-select-page__delay-head">
              <span className="worker-select-page__delay-title">납기초과 작업</span>
              <span className="worker-select-page__delay-count">{delayedOrdersTotalCount}건</span>
            </div>
            <p className="worker-select-page__delay-message">
              우리가 늦으면, 고객의 시작도 늦어집니다. 오늘 우리의 빠른 대응이 고객의 오픈일을 지킵니다. 납기 초과 건은 최우선으로 진행 부탁드립니다.
            </p>
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
              {delayedOrders.map(order => {
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
                      <span className="worker-select-page__delay-due">납기 {order.due_date || '-'}</span>
                      <span className="worker-select-page__delay-worker">담당 {order.started_by || '미배정'}</span>
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
            // Postgres COUNT/SUM 은 bigint 라 드라이버가 문자열로 돌려준다.
            // Number() 로 감싸지 않으면 3+1+6 이 '316' 이 되어 "6/316", 진행률 2% 로 표시된다.
            const w = Number(st?.waiting) || 0;
            const p = Number(st?.in_progress) || 0;
            const c = Number(st?.completed) || 0;
            const d = Number(st?.delayed) || 0;
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
