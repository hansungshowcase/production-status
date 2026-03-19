import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProcessesByStep, startProcess, completeProcess } from '../api/processes';
import { reportIssue, getIssues, resolveIssue } from '../api/issues';
import { getStats } from '../api/stats';
import { PROCESS_STEPS, STEP_ICONS } from '../stationConstants';
import { WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY } from '../constants';
import './WorkerStationViewPage.css';

const REFRESH_INTERVAL = 15000;

const CONTACTS = [
  { name: '박상규', role: '공장장', phone: '010-9322-3904' },
  { name: '신은철', role: '영업', phone: '010-7346-7407' },
  { name: '이시아', role: '영업', phone: '010-4221-4237' },
];

const ISSUE_TYPES = [
  { value: '자재부족', label: '자재 부족', icon: '📦', color: '#d97706' },
  { value: '불량발생', label: '불량 발생', icon: '❌', color: '#dc2626' },
  { value: '설비고장', label: '설비 고장', icon: '🔧', color: '#7c3aed' },
  { value: '기타', label: '기타', icon: '📝', color: '#64748b' },
];

export default function WorkerStationViewPage() {
  const { stepName } = useParams();
  const navigate = useNavigate();
  const decodedStep = decodeURIComponent(stepName);
  const icon = STEP_ICONS[decodedStep] || '';
  const workerName = sessionStorage.getItem(WORKER_STORAGE_KEY) || '현장작업자';
  const department = sessionStorage.getItem(DEPARTMENT_STORAGE_KEY) || '';

  const [items, setItems] = useState([]);
  const [factoryStats, setFactoryStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [toast, setToast] = useState(null);
  const [confirmTarget, setConfirmTarget] = useState(null); // { processId, clientName, status, orderId }
  const [completedIds, setCompletedIds] = useState(new Set()); // 완료 애니메이션용
  const [issueModal, setIssueModal] = useState(null);
  const [issueDesc, setIssueDesc] = useState('');
  const [issueLoading, setIssueLoading] = useState(false);
  const [photoModal, setPhotoModal] = useState(null);
  const [transitionAnim, setTransitionAnim] = useState(null); // { fromStep, toStep, clientName }
  const [issueAcknowledged, setIssueAcknowledged] = useState(false); // 이슈 확인 여부
  const [issueListModal, setIssueListModal] = useState(null); // 이슈 목록 모달 { issues, loading }
  const [resolvingId, setResolvingId] = useState(null);
  const prevIssueCountRef = useRef(0);

  const currentStepIndex = PROCESS_STEPS.indexOf(decodedStep);
  const nextSteps = PROCESS_STEPS.slice(currentStepIndex + 1, currentStepIndex + 3); // 다음 2개 공정
  const isLastStep = currentStepIndex === PROCESS_STEPS.length - 1;
  const timerRef = useRef(null);
  const toastTimerRef = useRef(null);

  function showResultToast(type, clientName) {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ type: 'complete', client: clientName, step: decodedStep, message: '공정 완료!' });
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  }

  const fetchData = useCallback(async () => {
    try {
      const [data, stats] = await Promise.all([
        getProcessesByStep(decodedStep),
        getStats().catch(() => null),
      ]);
      const raw = Array.isArray(data) ? data : data.processes || [];
      setItems(raw.map(item => ({
        ...item,
        status: item.status || item.process_status || 'waiting',
      })));
      if (stats) setFactoryStats(stats);
      setError(null);
    } catch (err) {
      console.error('Failed to fetch processes:', err);
      setError(err.message || '데이터를 불러올 수 없습니다.');
    } finally {
      setLoading(false);
    }
  }, [decodedStep]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    timerRef.current = setInterval(fetchData, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchData]);

  function requestComplete(processId) {
    const item = items.find(i => i.process_id === processId);
    const clientName = item?.client_name || '거래처';
    const status = item?.status || item?.process_status || 'waiting';
    setConfirmTarget({ processId, clientName, status, orderId: item?.order_id });
  }

  async function executeComplete(selectedNextStep) {
    if (!confirmTarget) return;
    const { processId, clientName, status, orderId } = confirmTarget;
    setConfirmTarget(null);
    setActionLoading(processId);
    try {
      // 대기 상태면 자동으로 시작 후 완료
      if (status === 'waiting' || status === '대기') {
        await startProcess(processId, { assigned_worker: workerName, assigned_team: department || decodedStep, actor: workerName });
      }
      await completeProcess(processId, { actor: workerName });

      // 중간 공정 건너뛰기 (선택된 다음 공정이 인접하지 않은 경우)
      if (selectedNextStep && orderId) {
        const selectedIdx = PROCESS_STEPS.indexOf(selectedNextStep);
        // 중간 공정들은 자동 완료 처리
        for (let i = currentStepIndex + 1; i < selectedIdx; i++) {
          const skipStep = PROCESS_STEPS[i];
          const stepData = await getProcessesByStep(skipStep);
          const raw = Array.isArray(stepData) ? stepData : stepData.processes || [];
          const match = raw.find(p => p.order_id === orderId);
          if (match) {
            await startProcess(match.process_id, { assigned_worker: workerName, assigned_team: skipStep, actor: workerName });
            await completeProcess(match.process_id, { actor: workerName });
          }
        }
        // 선택한 목표 공정을 시작 처리 (현황에 추가)
        const targetData = await getProcessesByStep(selectedNextStep);
        const targetRaw = Array.isArray(targetData) ? targetData : targetData.processes || [];
        const targetMatch = targetRaw.find(p => p.order_id === orderId);
        if (targetMatch && targetMatch.status !== 'in_progress' && targetMatch.status !== 'completed') {
          await startProcess(targetMatch.process_id, { assigned_worker: workerName, assigned_team: selectedNextStep, actor: workerName });
        }
      }

      // 전환 애니메이션 표시
      const nextStep = selectedNextStep || (currentStepIndex < PROCESS_STEPS.length - 1 ? PROCESS_STEPS[currentStepIndex + 1] : null);
      if (nextStep) {
        setTransitionAnim({ fromStep: decodedStep, toStep: nextStep, clientName });
        setTimeout(() => setTransitionAnim(null), 2200);
      }

      // 완료 애니메이션 시작
      setCompletedIds(prev => new Set([...prev, processId]));
      showResultToast('complete', clientName);
      // 애니메이션 후 데이터 갱신
      setTimeout(async () => {
        await fetchData();
        setCompletedIds(prev => { const next = new Set(prev); next.delete(processId); return next; });
      }, 600);
    } catch (err) {
      alert('공정 완료에 실패했습니다.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── 이슈 목록 모달 (상단 알림 클릭) ──
  async function openIssueListModal() {
    setIssueListModal({ issues: [], loading: true });
    try {
      const allIssues = await getIssues();
      // 현재 공정의 주문에 해당하는 미해결 이슈만 필터
      const orderIds = new Set(items.map(i => i.order_id));
      const filtered = allIssues.filter(iss => orderIds.has(iss.order_id) && !iss.resolved_at);
      // 거래처명 매핑
      const orderNameMap = {};
      items.forEach(i => { orderNameMap[i.order_id] = i.client_name; });
      const enriched = filtered.map(iss => ({ ...iss, client_name: orderNameMap[iss.order_id] || '' }));
      setIssueListModal({ issues: enriched, loading: false });
    } catch {
      setIssueListModal({ issues: [], loading: false });
    }
  }

  async function handleResolveIssue(issueId) {
    setResolvingId(issueId);
    try {
      await resolveIssue(issueId, workerName);
      setIssueListModal(prev => ({
        ...prev,
        issues: prev.issues.filter(i => i.id !== issueId),
      }));
      await fetchData();
    } catch {
      alert('이슈 해결에 실패했습니다.');
    } finally {
      setResolvingId(null);
    }
  }

  // ── Issue/Photo SMS handlers ──
  function openIssueModal(item) {
    setIssueModal({ item, step: 'select', issueType: null });
    setIssueDesc('');
  }

  function selectIssueType(issueType) {
    setIssueModal(prev => ({ ...prev, step: 'confirm', issueType }));
  }

  async function submitIssue() {
    if (!issueModal) return;
    const { item, issueType } = issueModal;
    setIssueLoading(true);
    try {
      await reportIssue({
        order_id: item.order_id,
        process_id: item.process_id,
        issue_type: issueType,
        description: issueDesc || `${decodedStep} - ${issueType}`,
        reported_by: workerName,
      });
      await fetchData();
      setIssueModal(prev => ({ ...prev, step: 'sms' }));
    } catch {
      alert('이슈 보고에 실패했습니다.');
    } finally {
      setIssueLoading(false);
    }
  }

  function buildIssueSmsBody(item, issueType) {
    return [
      `[한성쇼케이스 이슈보고]`,
      ``,
      `거래처: ${item.client_name || '-'}`,
      `공정: ${decodedStep}`,
      `이슈: ${issueType}`,
      issueDesc ? `내용: ${issueDesc}` : '',
      `사양: ${item.product_type || '-'}`,
      item.due_date ? `납기: ${item.due_date}` : '',
      ``,
      `보고자: ${workerName}`,
      `시각: ${new Date().toLocaleString('ko-KR')}`,
    ].filter(Boolean).join('\n');
  }

  function sendIssueSms(phone, item, issueType) {
    const body = buildIssueSmsBody(item, issueType);
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    window.open(`sms:${cleanPhone}?body=${encodeURIComponent(body)}`, '_self');
  }

  function sendPhotoSms(phone, item) {
    const body = [
      `[한성쇼케이스 사진첨부]`,
      ``,
      `거래처: ${item.client_name || '-'}`,
      `공정: ${decodedStep}`,
      `사양: ${item.product_type || '-'}`,
      item.due_date ? `납기: ${item.due_date}` : '',
      ``,
      `작업 사진을 첨부합니다.`,
      `보고자: ${workerName}`,
    ].filter(Boolean).join('\n');
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    window.open(`sms:${cleanPhone}?body=${encodeURIComponent(body)}`, '_self');
  }

  const today = new Date().toISOString().slice(0, 10);
  const waitingItems = items.filter(i => i.status === 'waiting' || i.status === '대기');
  const progressItems = items.filter(i => i.status === 'in_progress' || i.status === '진행중');
  const overdueItems = items.filter(i => i.due_date && i.due_date < today);
  const totalOpenIssues = items.reduce((sum, i) => sum + (parseInt(i.open_issues) || 0), 0);

  // 새 이슈 발생 시 확인 상태 리셋
  if (totalOpenIssues > prevIssueCountRef.current) {
    setIssueAcknowledged(false);
  }
  prevIssueCountRef.current = totalOpenIssues;

  const sorted = [...items].sort((a, b) => {
    const aOverdue = a.due_date && a.due_date < today ? -1 : 0;
    const bOverdue = b.due_date && b.due_date < today ? -1 : 0;
    if (aOverdue !== bOverdue) return aOverdue - bOverdue;
    return (a.due_date || '').localeCompare(b.due_date || '');
  });

  function getDday(dueDate) {
    if (!dueDate) return null;
    const due = new Date(dueDate);
    const now = new Date(today);
    const diff = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    if (diff < 0) return { label: `D+${Math.abs(diff)}`, cls: 'overdue' };
    if (diff === 0) return { label: 'D-Day', cls: 'today' };
    if (diff <= 3) return { label: `D-${diff}`, cls: 'soon' };
    return { label: `D-${diff}`, cls: 'normal' };
  }

  function statusLabel(status) {
    if (status === 'waiting' || status === '대기') return '대기';
    if (status === 'in_progress' || status === '진행중') return '진행중';
    return status;
  }

  function statusKey(status) {
    if (status === 'waiting' || status === '대기') return 'waiting';
    if (status === 'in_progress' || status === '진행중') return 'in_progress';
    return status;
  }

  return (
    <div className="station-view">
      <div className="station-view__header">
        <div className="station-view__header-top">
          <button
            className="station-view__back-btn"
            onClick={() => navigate('/')}
            aria-label="홈으로"
          >
            &#8592;
          </button>
          <div className="station-view__header-center">
            <h1 className="station-view__title">
              <span className="station-view__title-icon">{icon}</span>
              {decodedStep}
            </h1>
            <span className="station-view__worker-name">👷 {workerName}</span>
          </div>
          <div className="station-view__header-right">
            {totalOpenIssues > 0 && (
              <button
                className={`station-view__issue-noti${issueAcknowledged ? ' station-view__issue-noti--ack' : ''}`}
                onClick={openIssueListModal}
              >
                {!issueAcknowledged && <span className="station-view__issue-noti-pulse" />}
                이슈 {totalOpenIssues}
              </button>
            )}
            <button
              className="station-view__dept-change-btn"
              onClick={() => {
                sessionStorage.removeItem(DEPARTMENT_STORAGE_KEY);
                navigate('/worker/select', { state: { redirectTo: '/worker/station', deptChangeOnly: true } });
              }}
            >
              부서변경
            </button>
          </div>
        </div>
      </div>

      {/* Factory Overview */}
      {factoryStats && (
        <div className="factory-overview">
          <div className="factory-overview__header">
            <h2 className="factory-overview__title">공장 전체 현황</h2>
            <div className="factory-overview__global">
              <span className="factory-overview__global-item">
                주문 <strong>{factoryStats.total_orders}</strong>
              </span>
              <span className="factory-overview__global-item">
                생산중 <strong>{factoryStats.in_production}</strong>
              </span>
              <span className="factory-overview__global-item">
                출고 <strong>{factoryStats.shipped}</strong>
              </span>
              {factoryStats.overdue_count > 0 && (
                <span className="factory-overview__global-item factory-overview__global-item--red">
                  납기초과 <strong>{factoryStats.overdue_count}</strong>
                </span>
              )}
              {factoryStats.open_issues > 0 && (
                <span className="factory-overview__global-item factory-overview__global-item--orange">
                  이슈 <strong>{factoryStats.open_issues}</strong>
                </span>
              )}
            </div>
          </div>
          <div className="factory-overview__steps">
            {PROCESS_STEPS.map((step) => {
              const stepStat = (factoryStats.by_step || []).find(s => s.step_name === step);
              const isCurrent = step === decodedStep;
              const actionable = stepStat?.actionable || 0;
              const p = stepStat?.in_progress || 0;
              const c = stepStat?.completed || 0;
              const total = (stepStat?.waiting || 0) + p + c;
              const donePct = total > 0 ? Math.round((c / total) * 100) : 0;

              return (
                <div
                  key={step}
                  className={`factory-step${isCurrent ? ' factory-step--current' : ''}${actionable > 0 ? ' factory-step--active' : ''}`}
                  onClick={() => {
                    if (!isCurrent) navigate(`/worker/station/${encodeURIComponent(step)}`);
                  }}
                >
                  <div className="factory-step__icon">{STEP_ICONS[step] || ''}</div>
                  <div className="factory-step__name">{step}</div>
                  <div className="factory-step__bar">
                    <div className="factory-step__bar-fill" style={{ width: `${donePct}%` }} />
                  </div>
                  <div className="factory-step__counts">
                    {actionable > 0 && <span className="factory-step__count factory-step__count--waiting">{actionable}</span>}
                    <span className="factory-step__count factory-step__count--done">{c}/{total}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Current Department Stats */}
      <div className="station-view__section-title">
        {icon} {decodedStep} 작업 현황
      </div>
      <div className="station-view__summary">
        <div className="station-view__stat station-view__stat--total">
          <span className="station-view__stat-num">{items.length}</span>
          <span className="station-view__stat-label">전체</span>
        </div>
        <div className="station-view__stat station-view__stat--progress">
          <span className="station-view__stat-num">{progressItems.length}</span>
          <span className="station-view__stat-label">진행중</span>
        </div>
        <div className="station-view__stat station-view__stat--waiting">
          <span className="station-view__stat-num">{waitingItems.length}</span>
          <span className="station-view__stat-label">대기</span>
        </div>
        <div className={`station-view__stat station-view__stat--overdue${overdueItems.length > 0 ? ' has-overdue' : ''}`}>
          <span className="station-view__stat-num">{overdueItems.length}</span>
          <span className="station-view__stat-label">납기초과</span>
        </div>
      </div>

      <div className="station-view__body">
        {loading && <div className="station-view__loading">불러오는 중...</div>}
        {error && <div className="station-view__error">{error}</div>}

        {!loading && !error && sorted.length === 0 && (
          <div className="station-view__empty">현재 대기중인 작업이 없습니다</div>
        )}

        {!loading && !error && sorted.map((item) => {
          const sKey = statusKey(item.status);
          const isActioning = actionLoading === item.process_id;
          const overdue = item.due_date && item.due_date < today;
          const dday = getDday(item.due_date);
          const isExpanded = expandedId === item.process_id;
          const completedSteps = item.completed_steps || 0;
          const totalSteps = item.total_steps || 8;
          const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
          const dimensions = [item.width, item.depth, item.height].filter(Boolean).join('x');
          const isCompleting = completedIds.has(item.process_id);

          return (
            <div
              key={item.process_id}
              className={`station-view__card${overdue ? ' station-view__card--overdue' : ''} ${sKey === 'in_progress' ? 'station-view__card--active' : ''}${isCompleting ? ' station-view__card--completing' : ''}`}
              onClick={() => setExpandedId(isExpanded ? null : item.process_id)}
            >
              {/* Top row: client + status */}
              <div className="station-view__card-top">
                <div className="station-view__card-top-left">
                  <span className="station-view__client">{item.client_name || '거래처 미지정'}</span>
                  {item.sales_person && (
                    <span className="station-view__sales-person">담당: {item.sales_person}</span>
                  )}
                </div>
                <div className="station-view__card-top-right">
                  {overdue && <span className="station-view__overdue-tag">납기초과</span>}
                  <span className={`station-view__step-status station-view__step-status--${sKey}`}>
                    {statusLabel(item.status)}
                  </span>
                </div>
              </div>

              {/* Product info tags */}
              <div className="station-view__card-tags">
                {item.product_type && <span className="station-view__tag station-view__tag--product">{item.product_type}</span>}
                {item.door_type && <span className="station-view__tag station-view__tag--door">{item.door_type}</span>}
                {item.design && <span className="station-view__tag station-view__tag--design">{item.design}</span>}
                {item.quantity && <span className="station-view__tag station-view__tag--qty">수량 {item.quantity}</span>}
              </div>

              {/* Step history — who completed each previous step */}
              {item.step_history && item.step_history.length > 0 && (
                <div className="station-view__step-history">
                  {item.step_history.map((h, i) => (
                    <div key={i} className="station-view__history-item">
                      <span className="station-view__history-step">{STEP_ICONS[h.step_name] || ''} {h.step_name}</span>
                      <span className="station-view__history-worker">{h.completed_by || '-'}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Specs row */}
              <div className="station-view__card-specs">
                {dimensions && (
                  <span className="station-view__spec">
                    <span className="station-view__spec-icon">📐</span>
                    {dimensions}
                  </span>
                )}
                {item.color && (
                  <span className="station-view__spec">
                    <span className="station-view__spec-icon">🎨</span>
                    {item.color}
                  </span>
                )}
                {item.due_date && (
                  <span className="station-view__spec">
                    <span className="station-view__spec-icon">📅</span>
                    {item.due_date}
                    {dday && (
                      <span className={`station-view__dday station-view__dday--${dday.cls}`}>
                        {dday.label}
                      </span>
                    )}
                  </span>
                )}
              </div>

              {/* Overall progress bar */}
              <div className="station-view__progress">
                <div className="station-view__progress-header">
                  <span className="station-view__progress-label">전체 공정</span>
                  <span className="station-view__progress-steps-hint">
                    {PROCESS_STEPS.map((s, i) => (
                      <span key={i} className={`station-view__hint-step${i < completedSteps ? ' station-view__hint-step--done' : i === completedSteps ? ' station-view__hint-step--current' : ''}`}>
                        {i > 0 && <span className="station-view__hint-arrow">›</span>}
                        {s}
                      </span>
                    ))}
                  </span>
                  <span className="station-view__progress-text">{completedSteps}/{totalSteps}</span>
                </div>
                <div className="station-view__progress-bar">
                  <div
                    className={`station-view__progress-fill${progressPct === 100 ? ' station-view__progress-fill--done' : ''}`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>

              {/* Open issues alert */}
              {item.open_issues > 0 && (
                <div className="station-view__issue-alert">
                  미해결 이슈 {item.open_issues}건
                </div>
              )}

              {/* Expanded detail */}
              {isExpanded && (
                <div className="station-view__card-detail">
                  {item.order_date && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">발주일</span>
                      <span className="station-view__detail-value">{item.order_date}</span>
                    </div>
                  )}
                  {item.started_at && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">공정시작</span>
                      <span className="station-view__detail-value">{item.started_at.replace('T', ' ').slice(0, 16)}</span>
                    </div>
                  )}
                  {item.started_by && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">시작담당</span>
                      <span className="station-view__detail-value">{item.started_by}</span>
                    </div>
                  )}
                  {item.completed_by && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">완료담당</span>
                      <span className="station-view__detail-value">{item.completed_by}</span>
                    </div>
                  )}
                  {item.notes && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">비고</span>
                      <span className="station-view__detail-value">{item.notes}</span>
                    </div>
                  )}
                  {item.remarks && (
                    <div className="station-view__detail-row">
                      <span className="station-view__detail-label">특이사항</span>
                      <span className="station-view__detail-value">{item.remarks}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Actions */}
              <div className="station-view__card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="station-view__action-btn station-view__action-btn--complete"
                  onClick={() => requestComplete(item.process_id)}
                  disabled={isActioning}
                >
                  {isActioning ? '처리중...' : '작업 완료'}
                </button>
                <button
                  className="station-view__action-btn station-view__action-btn--issue"
                  onClick={() => openIssueModal(item)}
                >
                  이슈
                </button>
                <button
                  className="station-view__action-btn station-view__action-btn--photo"
                  onClick={() => setPhotoModal(item)}
                >
                  사진
                </button>
              </div>

              {/* Expand hint */}
              <div className="station-view__expand-hint">
                {isExpanded ? '접기 ▲' : '상세보기 ▼'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Confirm Modal */}
      {confirmTarget && (
        <div className="sv-confirm-overlay" onClick={() => setConfirmTarget(null)}>
          <div className="sv-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="sv-confirm__icon">✅</div>
            <div className="sv-confirm__title">
              {confirmTarget.clientName}
            </div>
            <div className="sv-confirm__detail">
              {isLastStep
                ? '이 공정을 완료하시겠습니까?'
                : '다음 공정으로 넘기겠습니까?'}
            </div>
            {!isLastStep && nextSteps.length > 0 && (
              <div className="sv-confirm__next-steps">
                {nextSteps.map((step, idx) => (
                  <button
                    key={step}
                    className={`sv-confirm__next-btn${idx === 0 ? ' sv-confirm__next-btn--primary' : ''}`}
                    onClick={() => executeComplete(step)}
                  >
                    {STEP_ICONS[step] || ''} {step}
                    {idx > 0 && <span className="sv-confirm__skip-hint">건너뛰기</span>}
                  </button>
                ))}
              </div>
            )}
            <div className="sv-confirm__actions">
              {isLastStep && (
                <button className="sv-confirm__btn sv-confirm__btn--ok" onClick={() => executeComplete(null)}>
                  완료
                </button>
              )}
              <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => setConfirmTarget(null)}>
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Result Toast */}
      {toast && (
        <div className={`sv-toast sv-toast--${toast.type}`} onClick={() => setToast(null)}>
          <div className="sv-toast__icon">✅</div>
          <div className="sv-toast__body">
            <div className="sv-toast__title">{toast.message}</div>
            <div className="sv-toast__detail">
              <strong>{toast.client}</strong> &middot; {toast.step}
            </div>
            <div className="sv-toast__status">
              대기 {waitingItems.length}건 · 진행 {progressItems.length}건
            </div>
          </div>
        </div>
      )}
      {/* ── Step Transition Animation ── */}
      {transitionAnim && (
        <div className="sv-transition-overlay">
          <div className="sv-transition">
            <div className="sv-transition__client">{transitionAnim.clientName}</div>
            <div className="sv-transition__steps">
              <div className="sv-transition__step sv-transition__step--from">
                <span className="sv-transition__step-icon">{STEP_ICONS[transitionAnim.fromStep] || ''}</span>
                <span className="sv-transition__step-name">{transitionAnim.fromStep}</span>
                <span className="sv-transition__check">✓</span>
              </div>
              <div className="sv-transition__arrow">
                <div className="sv-transition__arrow-line" />
                <div className="sv-transition__arrow-head">▶</div>
              </div>
              <div className="sv-transition__step sv-transition__step--to">
                <span className="sv-transition__step-icon">{STEP_ICONS[transitionAnim.toStep] || ''}</span>
                <span className="sv-transition__step-name">{transitionAnim.toStep}</span>
              </div>
            </div>
            <div className="sv-transition__label">다음 공정으로 이동</div>
          </div>
        </div>
      )}

      {/* ── Issue Modal ── */}
      {issueModal && (
        <div className="sv-confirm-overlay" onClick={() => !issueLoading && setIssueModal(null)}>
          <div className="sv-confirm" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            {issueModal.step === 'select' && (
              <>
                <div className="sv-confirm__icon">⚠️</div>
                <div className="sv-confirm__title">이슈 유형 선택</div>
                <div className="sv-confirm__detail">{issueModal.item.client_name} · {decodedStep}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '16px 0' }}>
                  {ISSUE_TYPES.map(t => (
                    <button
                      key={t.value}
                      onClick={() => selectIssueType(t.value)}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                        padding: '14px 8px', border: `2px solid ${t.color}20`, borderRadius: 12,
                        background: `${t.color}08`, cursor: 'pointer', fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                      }}
                    >
                      <span style={{ fontSize: 24 }}>{t.icon}</span>
                      <span style={{ color: t.color }}>{t.label}</span>
                    </button>
                  ))}
                </div>
                <div className="sv-confirm__actions">
                  <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => setIssueModal(null)}>취소</button>
                </div>
              </>
            )}
            {issueModal.step === 'confirm' && (
              <>
                <div className="sv-confirm__icon">⚠️</div>
                <div className="sv-confirm__title">{ISSUE_TYPES.find(t => t.value === issueModal.issueType)?.label}</div>
                <div className="sv-confirm__detail">{issueModal.item.client_name} · {decodedStep}</div>
                <textarea
                  placeholder="상세 내용을 입력하세요 (선택)"
                  value={issueDesc}
                  onChange={e => setIssueDesc(e.target.value)}
                  rows={3}
                  style={{
                    width: '100%', padding: 12, border: '1.5px solid #e2e8f0', borderRadius: 10,
                    fontFamily: 'inherit', fontSize: 14, resize: 'vertical', margin: '12px 0',
                    boxSizing: 'border-box',
                  }}
                />
                <div className="sv-confirm__actions">
                  <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => setIssueModal(prev => ({ ...prev, step: 'select' }))} disabled={issueLoading}>뒤로</button>
                  <button className="sv-confirm__btn sv-confirm__btn--ok" onClick={submitIssue} disabled={issueLoading}>
                    {issueLoading ? '보고중...' : '이슈 보고'}
                  </button>
                </div>
              </>
            )}
            {issueModal.step === 'sms' && (
              <>
                <div className="sv-confirm__icon">✅</div>
                <div className="sv-confirm__title">이슈 보고 완료</div>
                <div className="sv-confirm__detail">담당자에게 문자를 보내세요</div>
                <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, margin: '12px 0', fontSize: 13, color: '#334155', lineHeight: 1.5 }}>
                  <strong>{issueModal.item.client_name}</strong> · {decodedStep}<br />
                  이슈: {issueModal.issueType}
                  {issueDesc && <><br />내용: {issueDesc}</>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {CONTACTS.map(c => (
                    <button
                      key={c.name}
                      onClick={() => sendIssueSms(c.phone, issueModal.item, issueModal.issueType)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                        border: '1.5px solid #e2e8f0', borderRadius: 12, background: '#fff',
                        cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left',
                      }}
                    >
                      <div style={{
                        width: 38, height: 38, borderRadius: 10, background: '#0ea5e9',
                        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 800, fontSize: 15, flexShrink: 0,
                      }}>{c.name.charAt(0)}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 14 }}>{c.name} ({c.role})</div>
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>{c.phone}</div>
                      </div>
                      <span style={{ fontSize: 13, color: '#0ea5e9', fontWeight: 700 }}>📩 문자</span>
                    </button>
                  ))}
                </div>
                <div className="sv-confirm__actions" style={{ marginTop: 12 }}>
                  <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => setIssueModal(null)}>닫기</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Photo Modal ── */}
      {photoModal && (
        <div className="sv-confirm-overlay" onClick={() => setPhotoModal(null)}>
          <div className="sv-confirm" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="sv-confirm__icon">📷</div>
            <div className="sv-confirm__title">사진 전송</div>
            <div className="sv-confirm__detail">{photoModal.client_name} · {decodedStep}</div>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, margin: '12px 0', fontSize: 13, color: '#334155' }}>
              담당자에게 작업 사진을 문자로 보내세요
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {CONTACTS.map(c => (
                <button
                  key={c.name}
                  onClick={() => sendPhotoSms(c.phone, photoModal)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
                    border: '1.5px solid #e2e8f0', borderRadius: 12, background: '#fff',
                    cursor: 'pointer', fontFamily: 'inherit', width: '100%', textAlign: 'left',
                  }}
                >
                  <div style={{
                    width: 38, height: 38, borderRadius: 10, background: '#059669',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 800, fontSize: 15, flexShrink: 0,
                  }}>{c.name.charAt(0)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{c.name} ({c.role})</div>
                    <div style={{ fontSize: 12, color: '#94a3b8' }}>{c.phone}</div>
                  </div>
                  <span style={{ fontSize: 13, color: '#059669', fontWeight: 700 }}>📩 문자</span>
                </button>
              ))}
            </div>
            <div className="sv-confirm__actions" style={{ marginTop: 12 }}>
              <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => setPhotoModal(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Issue List Modal (상단 이슈 알림 클릭) ── */}
      {issueListModal && (
        <div className="sv-confirm-overlay" onClick={() => { setIssueListModal(null); setIssueAcknowledged(true); }}>
          <div className="sv-issue-list-modal" onClick={e => e.stopPropagation()}>
            <div className="sv-issue-list__header">
              <span className="sv-issue-list__header-icon">⚠️</span>
              <h2 className="sv-issue-list__title">미해결 이슈</h2>
              <span className="sv-issue-list__count">{issueListModal.issues.length}건</span>
            </div>

            {issueListModal.loading ? (
              <div className="sv-issue-list__loading">불러오는 중...</div>
            ) : issueListModal.issues.length === 0 ? (
              <div className="sv-issue-list__empty">미해결 이슈가 없습니다</div>
            ) : (
              <div className="sv-issue-list__body">
                {issueListModal.issues.map(iss => {
                  const typeInfo = ISSUE_TYPES.find(t => t.value === iss.issue_type) || { icon: '📝', label: iss.issue_type, color: '#64748b' };
                  const reportedTime = iss.reported_at ? new Date(iss.reported_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                  return (
                    <div key={iss.id} className="sv-issue-list__item">
                      <div className="sv-issue-list__item-top">
                        <span className="sv-issue-list__item-icon" style={{ color: typeInfo.color }}>{typeInfo.icon}</span>
                        <div className="sv-issue-list__item-info">
                          <span className="sv-issue-list__item-client">{iss.client_name || '-'}</span>
                          <span className="sv-issue-list__item-type" style={{ color: typeInfo.color }}>{typeInfo.label}</span>
                        </div>
                        <span className="sv-issue-list__item-time">{reportedTime}</span>
                      </div>
                      {iss.description && (
                        <div className="sv-issue-list__item-desc">{iss.description}</div>
                      )}
                      {iss.reported_by && (
                        <div className="sv-issue-list__item-reporter">보고: {iss.reported_by}</div>
                      )}
                      <button
                        className="sv-issue-list__resolve-btn"
                        onClick={() => handleResolveIssue(iss.id)}
                        disabled={resolvingId === iss.id}
                      >
                        {resolvingId === iss.id ? '처리중...' : '확인 (해결)'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="sv-issue-list__footer">
              <button className="sv-confirm__btn sv-confirm__btn--cancel" onClick={() => { setIssueListModal(null); setIssueAcknowledged(true); }}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
