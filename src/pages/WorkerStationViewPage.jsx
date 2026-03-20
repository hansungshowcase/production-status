import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getProcessesByStep, startProcess, completeProcess } from '../api/processes';
import { reportIssue, getIssues, resolveIssue } from '../api/issues';
import { uploadPhoto } from '../api/photos';
import { getStats } from '../api/stats';
import { PROCESS_STEPS, STEP_ICONS } from '../stationConstants';
import { WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY } from '../constants';
import './WorkerStationViewPage.css';

const REFRESH_INTERVAL = 5000;

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
  const [issuePhotos, setIssuePhotos] = useState([]);
  const [issueLoading, setIssueLoading] = useState(false);
  const [photoModal, setPhotoModal] = useState(null);
  // transitionAnim 제거됨 (검은화면 없이 토스트로 대체)
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
    return () => {
      clearInterval(timerRef.current);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, [fetchData]);

  // 모달 하나 열면 나머지 전부 닫기
  function closeAllModals() {
    setConfirmTarget(null);
    setIssueModal(null);
    setPhotoModal(null);
    setIssueListModal(null);
  }

  function requestComplete(processId) {
    if (actionLoading) return; // 처리 중 연타 방지
    closeAllModals();
    const item = items.find(i => i.process_id === processId);
    const clientName = item?.client_name || '거래처';
    const status = item?.status || item?.process_status || 'waiting';
    setConfirmTarget({ processId, clientName, status, orderId: item?.order_id });
  }

  async function executeComplete(selectedNextStep) {
    if (!confirmTarget || actionLoading) return; // 이중 실행 방지
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

      // 화살표 모션 토스트 표시 (검은화면 없이)
      const nextStep = selectedNextStep || (currentStepIndex < PROCESS_STEPS.length - 1 ? PROCESS_STEPS[currentStepIndex + 1] : null);
      setCompletedIds(prev => new Set([...prev, processId]));
      if (nextStep) {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast({ type: 'transition', client: clientName, fromStep: decodedStep, toStep: nextStep, fromIcon: STEP_ICONS[decodedStep] || '', toIcon: STEP_ICONS[nextStep] || '' });
        toastTimerRef.current = setTimeout(() => setToast(null), 3000);
      } else {
        showResultToast('complete', clientName);
      }
      // 즉시 데이터 갱신
      setTimeout(async () => {
        await fetchData();
        setCompletedIds(prev => { const next = new Set(prev); next.delete(processId); return next; });
      }, 400);
    } catch (err) {
      alert('공정 완료에 실패했습니다.');
    } finally {
      setActionLoading(null);
    }
  }

  // ── 이슈 목록 모달 (상단 알림 클릭) ──
  async function openIssueListModal() {
    // 이미 열려있으면 닫기 (토글)
    if (issueListModal) {
      setIssueListModal(null);
      setIssueAcknowledged(true);
      return;
    }
    closeAllModals();
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
    closeAllModals();
    setIssueModal({ item, step: 'select', issueType: null });
    setIssueDesc('');
    setIssuePhotos([]);
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
      // Upload attached photos
      for (const file of issuePhotos) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('order_id', item.order_id);
        formData.append('process_id', item.process_id);
        formData.append('uploaded_by', workerName);
        try { await uploadPhoto(formData); } catch { /* skip failed uploads */ }
      }
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
    // 납기초과 건은 항상 상단
    const aOverdue = a.due_date && a.due_date < today ? 1 : 0;
    const bOverdue = b.due_date && b.due_date < today ? 1 : 0;
    if (aOverdue !== bOverdue) return bOverdue - aOverdue;
    // 나머지는 최신 등록순 (order_id 큰 것이 위)
    return (b.order_id || 0) - (a.order_id || 0);
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
            onClick={() => navigate(-1)}
            aria-label="뒤로가기"
          >
            &#8592;
          </button>
          <h1 className="station-view__title">
            <span className="station-view__title-icon">{icon}</span>
            {decodedStep}
          </h1>
          {totalOpenIssues > 0 && (
            <div className="station-view__issue-noti-wrap">
              <button
                className={`station-view__issue-noti${issueAcknowledged ? ' station-view__issue-noti--ack' : ''}`}
                onClick={openIssueListModal}
              >
                {!issueAcknowledged && <span className="station-view__issue-noti-pulse" />}
                이슈 {totalOpenIssues}
              </button>
              {/* 이슈 목록 - 버튼 바로 아래에 팝업 */}
              {issueListModal && (
                <div className="sv-issue-dropdown" onClick={e => e.stopPropagation()}>
                  <div className="sv-issue-dropdown__header">
                    <span>⚠️</span>
                    <strong>미해결 이슈</strong>
                    <span className="sv-issue-dropdown__count">{issueListModal.issues.length}건</span>
                    <button className="sv-issue-dropdown__close" onClick={() => { setIssueListModal(null); setIssueAcknowledged(true); }}>✕</button>
                  </div>
                  {issueListModal.loading ? (
                    <div className="sv-issue-dropdown__empty">불러오는 중...</div>
                  ) : issueListModal.issues.length === 0 ? (
                    <div className="sv-issue-dropdown__empty">미해결 이슈가 없습니다</div>
                  ) : (
                    <div className="sv-issue-dropdown__body">
                      {issueListModal.issues.map(iss => {
                        const typeInfo = ISSUE_TYPES.find(t => t.value === iss.issue_type) || { icon: '📝', label: iss.issue_type, color: '#64748b' };
                        const reportedTime = iss.reported_at ? new Date(iss.reported_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                        return (
                          <div key={iss.id} className="sv-issue-dropdown__item">
                            <div className="sv-issue-dropdown__item-top">
                              <span style={{ color: typeInfo.color }}>{typeInfo.icon}</span>
                              <strong>{iss.client_name || '-'}</strong>
                              <span style={{ color: typeInfo.color, fontSize: 12 }}>{typeInfo.label}</span>
                              <span className="sv-issue-dropdown__time">{reportedTime}</span>
                            </div>
                            {iss.description && <div className="sv-issue-dropdown__desc">{iss.description}</div>}
                            <button
                              className="sv-issue-dropdown__resolve"
                              onClick={() => handleResolveIssue(iss.id)}
                              disabled={resolvingId === iss.id}
                            >
                              {resolvingId === iss.id ? '처리중...' : '✓ 해결'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="station-view__header-sub">
          <span className="station-view__worker-name">👷 {workerName}</span>
          <div className="station-view__header-actions">
            <button
              className="station-view__action-chip"
              onClick={() => {
                sessionStorage.removeItem(WORKER_STORAGE_KEY);
                sessionStorage.removeItem(DEPARTMENT_STORAGE_KEY);
                navigate('/worker/select', { state: { redirectTo: '/worker/station' } });
              }}
            >
              작업자 변경
            </button>
            <button
              className="station-view__action-chip"
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
          <div className="factory-overview__steps factory-overview__steps--grid">
            {PROCESS_STEPS.map((step) => {
              const stepStat = (factoryStats.by_step || []).find(s => s.step_name === step);
              const isCurrent = step === decodedStep;
              const w = Number(stepStat?.waiting) || 0;
              const p = Number(stepStat?.in_progress) || 0;
              const c = Number(stepStat?.completed) || 0;
              const total = w + p + c;
              const actionable = Number(stepStat?.actionable) || 0;
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
                    {actionable > 0 && <span className="factory-step__count factory-step__count--waiting">잔여 {actionable}</span>}
                    <span className="factory-step__count factory-step__count--done">완료 {c}/{total}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Mobile compact list */}
          <div className="factory-overview__steps factory-overview__steps--compact">
            {PROCESS_STEPS.map((step) => {
              const stepStat = (factoryStats.by_step || []).find(s => s.step_name === step);
              const isCurrent = step === decodedStep;
              const c = Number(stepStat?.completed) || 0;
              const total = (Number(stepStat?.waiting) || 0) + (Number(stepStat?.in_progress) || 0) + c;
              const actionable = Number(stepStat?.actionable) || 0;
              const donePct = total > 0 ? Math.round((c / total) * 100) : 0;

              return (
                <div
                  key={step}
                  className={`factory-row${isCurrent ? ' factory-row--current' : ''}${actionable > 0 ? ' factory-row--active' : ''}`}
                  onClick={() => {
                    if (!isCurrent) navigate(`/worker/station/${encodeURIComponent(step)}`);
                  }}
                >
                  <span className="factory-row__icon">{STEP_ICONS[step] || ''}</span>
                  <span className="factory-row__name">{step}</span>
                  <div className="factory-row__bar">
                    <div className="factory-row__bar-fill" style={{ width: `${donePct}%` }} />
                  </div>
                  <span className="factory-row__nums">
                    {actionable > 0 && <span className="factory-row__badge factory-row__badge--wait">{actionable}</span>}
                    <span className="factory-row__badge factory-row__badge--done">{c}/{total}</span>
                  </span>
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

        {!loading && !error && sorted.length > 0 && (
          <div className="station-view__table-header">
            <span className="station-view__th station-view__th--status" />
            <span className="station-view__th station-view__th--client">거래처</span>
            <span className="station-view__th station-view__th--product">제품</span>
            <span className="station-view__th station-view__th--spec">규격</span>
            <span className="station-view__th station-view__th--due">납기</span>
            <span className="station-view__th station-view__th--progress">진행</span>
            <span className="station-view__th station-view__th--actions">작업</span>
          </div>
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
              {/* Single row: 거래처 | 제품 | 규격 | 납기 | 진행 | 액션 */}
              <div className="station-view__row">
                <span className={`station-view__row-status station-view__row-status--${sKey}`} />
                <span className="station-view__row-client">
                  {item.client_name || '미지정'}
                  {item.open_issues > 0 && <span className="station-view__row-issue-dot" title={`이슈 ${item.open_issues}건`} />}
                </span>
                <span className="station-view__row-product">
                  {item.product_type || '-'}
                  {item.door_type ? `/${item.door_type}` : ''}
                  {item.quantity > 1 ? ` x${item.quantity}` : ''}
                </span>
                <span className="station-view__row-spec">{dimensions || '-'}</span>
                <span className="station-view__row-due">
                  {item.due_date ? item.due_date.slice(5) : '-'}
                  {dday && (
                    <span className={`station-view__dday station-view__dday--${dday.cls}`}>{dday.label}</span>
                  )}
                </span>
                <span className="station-view__row-progress">
                  <span className="station-view__progress-bar-mini">
                    <span className={`station-view__progress-fill-mini${progressPct === 100 ? ' station-view__progress-fill-mini--done' : ''}`} style={{ width: `${progressPct}%` }} />
                  </span>
                  <span className="station-view__progress-text-mini">{completedSteps}/{totalSteps}</span>
                </span>
                <span className="station-view__row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="station-view__row-btn station-view__row-btn--complete"
                    onClick={() => requestComplete(item.process_id)}
                    disabled={isActioning || !!actionLoading}
                  >
                    {isActioning ? '...' : '완료'}
                  </button>
                  <button
                    className="station-view__row-btn station-view__row-btn--issue"
                    onClick={() => openIssueModal(item)}
                    disabled={!!actionLoading}
                  >
                    이슈보고
                  </button>
                </span>
              </div>

              {/* Expanded detail on tap */}
              {isExpanded && (
                <div className="station-view__row-expand">
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
                  <div className="station-view__row-details">
                    {item.color && <span className="station-view__row-detail-item">색상: {item.color}</span>}
                    {item.design && <span className="station-view__row-detail-item">디자인: {item.design}</span>}
                    {item.sales_person && <span className="station-view__row-detail-item">담당: {item.sales_person}</span>}
                    {item.order_date && <span className="station-view__row-detail-item">발주: {item.order_date}</span>}
                    {item.started_by && <span className="station-view__row-detail-item">시작: {item.started_by}</span>}
                    {item.started_at && <span className="station-view__row-detail-item">시작일: {item.started_at.replace('T', ' ').slice(0, 16)}</span>}
                  </div>
                  {(item.notes || item.remarks) && (
                    <div className="station-view__row-notes">
                      {item.notes && <span>{item.notes}</span>}
                      {item.remarks && <span>{item.remarks}</span>}
                    </div>
                  )}
                </div>
              )}


              {/* ── Popup: Confirm ── */}
              {confirmTarget && confirmTarget.processId === item.process_id && (
                <div className="sv-card-popup" onClick={(e) => e.stopPropagation()}>
                  <div className="sv-card-popup__title">{confirmTarget.clientName}</div>
                  {isLastStep ? (
                    <>
                      <div className="sv-card-popup__desc">최종 공정을 완료하시겠습니까?</div>
                      <div className="sv-card-popup__flow">
                        <div className="sv-card-popup__flow-step sv-card-popup__flow-step--from">
                          <span className="sv-card-popup__flow-icon">{icon}</span>
                          <span className="sv-card-popup__flow-name">{decodedStep}</span>
                        </div>
                        <div className="sv-card-popup__flow-arrow">
                          <div className="sv-card-popup__flow-arrow-track">
                            <div className="sv-card-popup__flow-arrow-dot" />
                          </div>
                          <span className="sv-card-popup__flow-arrow-head">▶</span>
                        </div>
                        <div className="sv-card-popup__flow-step sv-card-popup__flow-step--done">
                          <span className="sv-card-popup__flow-icon">🏁</span>
                          <span className="sv-card-popup__flow-name">완료</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="sv-card-popup__desc">다음 공정으로 넘기겠습니까?</div>
                      <div className="sv-card-popup__flow">
                        <div className="sv-card-popup__flow-step sv-card-popup__flow-step--from">
                          <span className="sv-card-popup__flow-icon">{icon}</span>
                          <span className="sv-card-popup__flow-name">{decodedStep}</span>
                        </div>
                        <div className="sv-card-popup__flow-arrow">
                          <div className="sv-card-popup__flow-arrow-track">
                            <div className="sv-card-popup__flow-arrow-dot" />
                          </div>
                          <span className="sv-card-popup__flow-arrow-head">▶</span>
                        </div>
                        <div className="sv-card-popup__flow-step sv-card-popup__flow-step--to">
                          <span className="sv-card-popup__flow-icon">{STEP_ICONS[nextSteps[0]] || ''}</span>
                          <span className="sv-card-popup__flow-name">{nextSteps[0]}</span>
                        </div>
                      </div>
                    </>
                  )}
                  {!isLastStep && nextSteps.length > 0 && (
                    <div className="sv-card-popup__next-steps">
                      {nextSteps.map((step, idx) => (
                        <button
                          key={step}
                          className={`sv-card-popup__next-btn${idx === 0 ? ' sv-card-popup__next-btn--primary' : ''}`}
                          onClick={() => executeComplete(step)}
                        >
                          {STEP_ICONS[step] || ''} {step}
                          {idx > 0 && <span className="sv-card-popup__skip-hint">건너뛰기</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="sv-card-popup__actions">
                    {isLastStep && (
                      <button className="sv-card-popup__btn sv-card-popup__btn--ok" onClick={() => executeComplete(null)}>완료</button>
                    )}
                    <button className="sv-card-popup__btn sv-card-popup__btn--cancel" onClick={() => setConfirmTarget(null)}>취소</button>
                  </div>
                </div>
              )}

              {/* ── Popup: Issue ── */}
              {issueModal && issueModal.item.process_id === item.process_id && (
                <div className="sv-card-popup" onClick={(e) => e.stopPropagation()}>
                  {issueModal.step === 'select' && (
                    <>
                      <div className="sv-card-popup__icon">⚠️</div>
                      <div className="sv-card-popup__title">이슈 유형 선택</div>
                      <div className="sv-card-popup__desc">{issueModal.item.client_name} · {decodedStep}</div>
                      <div className="sv-card-popup__issue-grid">
                        {ISSUE_TYPES.map(t => (
                          <button
                            key={t.value}
                            className="sv-card-popup__issue-btn"
                            onClick={() => selectIssueType(t.value)}
                            style={{ borderColor: `${t.color}30`, background: `${t.color}08` }}
                          >
                            <span style={{ fontSize: 22 }}>{t.icon}</span>
                            <span style={{ color: t.color, fontWeight: 600, fontSize: 13 }}>{t.label}</span>
                          </button>
                        ))}
                      </div>
                      <div className="sv-card-popup__actions">
                        <button className="sv-card-popup__btn sv-card-popup__btn--cancel" onClick={() => setIssueModal(null)}>취소</button>
                      </div>
                    </>
                  )}
                  {issueModal.step === 'confirm' && (
                    <>
                      <div className="sv-card-popup__icon">⚠️</div>
                      <div className="sv-card-popup__title">{ISSUE_TYPES.find(t => t.value === issueModal.issueType)?.label}</div>
                      <div className="sv-card-popup__desc">{issueModal.item.client_name} · {decodedStep}</div>
                      <textarea
                        className="sv-card-popup__textarea"
                        placeholder="상세 내용을 입력하세요 (선택)"
                        value={issueDesc}
                        onChange={e => setIssueDesc(e.target.value)}
                        rows={3}
                      />
                      <label className="sv-card-popup__photo-attach">
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          capture="environment"
                          style={{ display: 'none' }}
                          onChange={e => setIssuePhotos(prev => [...prev, ...Array.from(e.target.files)])}
                        />
                        <span className="sv-card-popup__photo-btn">📷 사진 첨부 {issuePhotos.length > 0 && `(${issuePhotos.length})`}</span>
                      </label>
                      <div className="sv-card-popup__actions">
                        <button className="sv-card-popup__btn sv-card-popup__btn--cancel" onClick={() => setIssueModal(prev => ({ ...prev, step: 'select' }))} disabled={issueLoading}>뒤로</button>
                        <button className="sv-card-popup__btn sv-card-popup__btn--ok" onClick={submitIssue} disabled={issueLoading}>
                          {issueLoading ? '보고중...' : '이슈 보고'}
                        </button>
                      </div>
                    </>
                  )}
                  {issueModal.step === 'sms' && (
                    <>
                      <div className="sv-card-popup__icon">✅</div>
                      <div className="sv-card-popup__title">이슈 보고 완료</div>
                      <div className="sv-card-popup__desc">담당자에게 문자를 보내세요</div>
                      <div className="sv-card-popup__sms-preview">
                        <strong>{issueModal.item.client_name}</strong> · {decodedStep}<br />
                        이슈: {issueModal.issueType}
                        {issueDesc && <><br />내용: {issueDesc}</>}
                      </div>
                      <div className="sv-card-popup__contacts">
                        {CONTACTS.map(c => (
                          <button key={c.name} className="sv-card-popup__contact-btn" onClick={() => sendIssueSms(c.phone, issueModal.item, issueModal.issueType)}>
                            <div className="sv-card-popup__contact-avatar" style={{ background: '#0ea5e9' }}>{c.name.charAt(0)}</div>
                            <div className="sv-card-popup__contact-info">
                              <span className="sv-card-popup__contact-name">{c.name} ({c.role})</span>
                              <span className="sv-card-popup__contact-phone">{c.phone}</span>
                            </div>
                            <span style={{ fontSize: 13, color: '#0ea5e9', fontWeight: 700 }}>📩 문자</span>
                          </button>
                        ))}
                      </div>
                      <div className="sv-card-popup__actions">
                        <button className="sv-card-popup__btn sv-card-popup__btn--cancel" onClick={() => setIssueModal(null)}>닫기</button>
                      </div>
                    </>
                  )}
                </div>
              )}


            </div>
          );
        })}
      </div>

      {/* 공정 완료 전환 애니메이션 */}
      {toast && toast.type === 'transition' && (
        <div className="sv-transition-banner" onClick={() => setToast(null)}>
          <div className="sv-transition-banner__client">{toast.client}</div>
          <div className="sv-transition-banner__message">완료 처리합니다</div>
          <div className="sv-transition-banner__flow">
            <div className="sv-transition-banner__step sv-transition-banner__step--from">
              <span className="sv-transition-banner__step-icon">{toast.fromIcon}</span>
              <span className="sv-transition-banner__step-name">{toast.fromStep}</span>
              <span className="sv-transition-banner__check">✓</span>
            </div>
            <div className="sv-transition-banner__arrow">
              <div className="sv-transition-banner__arrow-track">
                <div className="sv-transition-banner__arrow-dot" />
              </div>
              <span className="sv-transition-banner__arrow-head">▶</span>
            </div>
            <div className="sv-transition-banner__step sv-transition-banner__step--to">
              <span className="sv-transition-banner__step-icon">{toast.toIcon}</span>
              <span className="sv-transition-banner__step-name">{toast.toStep}</span>
            </div>
          </div>
        </div>
      )}
      {toast && toast.type !== 'transition' && (
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
      {/* 이슈 목록은 상단 버튼 옆 드롭다운으로 이동됨 */}
    </div>
  );
}
