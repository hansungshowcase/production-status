import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchCustomerNotifications, fetchCustomerReviews } from '../api/customerNotifications';
import { notificationPageNumbers } from '../pages/smsHistoryFilters';
import {
  canSelectReviewCustomer,
  customerDeliveryTone,
  customerRequestLabel,
  customerRequestTone,
  EMPTY_CUSTOMER_COUNTS,
  EMPTY_PAGINATION,
  formatCustomerSmsTime,
  todayInKst,
} from './customerSmsPresentation';
import './CustomerSmsPanel.css';

function Pagination({ pagination, onPage, label }) {
  if (pagination.total_pages <= 0) return null;
  const pages = notificationPageNumbers(pagination.page, pagination.total_pages);
  return (
    <nav className="customer-sms-pagination" aria-label={label}>
      <button type="button" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>이전</button>
      {pages.map(value => (
        <button type="button" key={value} className={value === pagination.page ? 'is-selected' : ''} aria-current={value === pagination.page ? 'page' : undefined} onClick={() => onPage(value)}>{value}</button>
      ))}
      <button type="button" disabled={pagination.page >= pagination.total_pages} onClick={() => onPage(pagination.page + 1)}>다음</button>
    </nav>
  );
}

function LoadState({ status, empty, error, onRetry }) {
  if (status === 'loading') return <div className="customer-sms-state" role="status">불러오는 중입니다.</div>;
  if (status === 'error') return <div className="customer-sms-state customer-sms-state--error" role="alert"><strong>{error}</strong><button type="button" onClick={onRetry}>다시 불러오기</button></div>;
  if (empty) return <div className="customer-sms-state" role="status">조건에 맞는 기록이 없습니다.</div>;
  return null;
}

export default function CustomerSmsPanel() {
  const [tab, setTab] = useState('history');
  const [date, setDate] = useState(todayInKst);
  const [kind, setKind] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [history, setHistory] = useState({ status: 'loading', items: [], counts: EMPTY_CUSTOMER_COUNTS, pagination: EMPTY_PAGINATION, kinds: [], reviewSync: { state: 'not_requested', notice: '', checked_at: null } });
  const [expandedId, setExpandedId] = useState(null);
  const [campaign, setCampaign] = useState('');
  const [reviewPage, setReviewPage] = useState(1);
  const [reviews, setReviews] = useState({ status: 'idle', items: [], campaigns: [], counts: { total: 0, ready: 0, blocked: 0 }, pagination: EMPTY_PAGINATION, connection: { state: 'pending', label: '연결 확인 중', notice: '발송 연결 상태를 확인한 뒤 이용할 수 있습니다.', canSend: false } });
  const [selected, setSelected] = useState([]);
  const historyRequest = useRef(0);
  const reviewRequest = useRef(0);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequest.current;
    setHistory(current => ({ ...current, status: 'loading' }));
    try {
      const data = await fetchCustomerNotifications({ date, kind, page: historyPage });
      if (requestId !== historyRequest.current) return;
      setHistory({ status: 'ready', items: Array.isArray(data?.items) ? data.items : [], counts: { ...EMPTY_CUSTOMER_COUNTS, ...data?.counts, delivery: { ...EMPTY_CUSTOMER_COUNTS.delivery, ...data?.counts?.delivery } }, pagination: { ...EMPTY_PAGINATION, ...data?.pagination }, kinds: Array.isArray(data?.kinds) ? data.kinds : [], reviewSync: { state: 'not_requested', notice: '', checked_at: null, ...data?.review_sync } });
    } catch {
      if (requestId === historyRequest.current) setHistory(current => ({ ...current, status: 'error' }));
    }
  }, [date, historyPage, kind]);

  const loadReviews = useCallback(async () => {
    const requestId = ++reviewRequest.current;
    setReviews(current => ({ ...current, status: 'loading' }));
    try {
      const data = await fetchCustomerReviews({ campaign, page: reviewPage });
      if (requestId !== reviewRequest.current) return;
      setReviews({ status: 'ready', items: Array.isArray(data?.items) ? data.items : [], campaigns: Array.isArray(data?.campaigns) ? data.campaigns : [], counts: { total: Number(data?.counts?.total) || 0, ready: Number(data?.counts?.ready) || 0, blocked: Number(data?.counts?.blocked) || 0 }, pagination: { ...EMPTY_PAGINATION, ...data?.pagination }, connection: { state: 'pending', label: '연결 확인 중', notice: '발송 연결 상태를 확인한 뒤 이용할 수 있습니다.', canSend: false, ...data?.connection } });
      setSelected([]);
    } catch {
      if (requestId === reviewRequest.current) setReviews(current => ({ ...current, status: 'error' }));
    }
  }, [campaign, reviewPage]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  useEffect(() => { if (tab === 'reviews') loadReviews(); }, [loadReviews, tab]);

  const reviewCampaign = useMemo(() => reviews.campaigns.find(item => item.id === campaign) || reviews.campaigns[0], [campaign, reviews.campaigns]);
  const sendDisabledReason = reviews.connection.notice || '기존 Make 발송 연결이 확인되기 전에는 발송할 수 없습니다.';

  return (
    <section className="customer-sms-panel" aria-labelledby="customer-sms-title">
      <div className="customer-sms-intro">
        <div><h2 id="customer-sms-title">고객 문자 관리</h2><p>고객 안내의 발송 결과와 스마트스토어를 제외한 리뷰 이벤트 대상을 확인합니다.</p></div>
        <p className="customer-sms-intro__notice">실제 수신 결과는 전달 상태를 기준으로 확인합니다.</p>
      </div>

      <div className="customer-sms-tabs" role="tablist" aria-label="고객 문자 관리 보기">
        <button type="button" role="tab" aria-selected={tab === 'history'} aria-controls="customer-sms-history" onClick={() => setTab('history')}>발송이력</button>
        <button type="button" role="tab" aria-selected={tab === 'reviews'} aria-controls="customer-sms-reviews" onClick={() => setTab('reviews')}>리뷰이벤트</button>
      </div>

      <div id="customer-sms-history" role="tabpanel" hidden={tab !== 'history'}>
        <div className="customer-sms-filters">
          <label><span>날짜</span><input type="date" value={date} onChange={event => { setDate(event.target.value); setHistoryPage(1); setExpandedId(null); }} /></label>
          <label><span>안내 유형</span><select aria-label="안내 유형" value={kind} onChange={event => { setKind(event.target.value); setHistoryPage(1); setExpandedId(null); }}><option value="">전체 유형</option>{history.kinds.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <button type="button" disabled={date === todayInKst() && !kind} onClick={() => { setDate(todayInKst()); setKind(''); setHistoryPage(1); setExpandedId(null); }}>조건 초기화</button>
        </div>
        {history.status === 'ready' && history.reviewSync.notice && <p className={`customer-sms-sync-notice is-${history.reviewSync.state}`} role="status"><span>{history.reviewSync.notice}</span>{history.reviewSync.checked_at && <time dateTime={history.reviewSync.checked_at}>확인 {formatCustomerSmsTime(history.reviewSync.checked_at)}</time>}</p>}
        <div className="customer-sms-summary" aria-label="고객 문자 발송 요약">
          <div><span>전체</span><strong>{history.counts.total}</strong></div><div className="is-success"><span>수신 완료</span><strong>{history.counts.delivery.received}</strong></div><div className="is-failed"><span>전달 실패</span><strong>{history.counts.delivery.failed}</strong></div><div><span>미발송·확인 중</span><strong>{history.counts.delivery.pending + history.counts.delivery.unknown + history.counts.delivery.not_sent + history.counts.delivery.uncertain}</strong></div>
        </div>
        <LoadState status={history.status} empty={history.items.length === 0} error="고객 발송이력을 불러오지 못했습니다." onRetry={loadHistory} />
        {history.status === 'ready' && history.items.length > 0 && <div className="customer-sms-list">{history.items.map(item => { const expanded = expandedId === item.id; return <article className="customer-sms-item" key={item.id}>
          <div className="customer-sms-item__heading"><div><strong>{item.customer_name || '고객명 미확인'}</strong><span>{item.phone || '번호 미확인'}</span></div><div><span className={`customer-sms-badge is-${customerDeliveryTone(item.delivery?.state)}`}>{item.delivery?.label || '전달 상태 미확인'}</span><span className={`customer-sms-badge is-${customerRequestTone(item.status)}`}>{customerRequestLabel(item.status)}</span></div></div>
          <p className="customer-sms-meta"><span>{item.kind_label || '안내 유형 미확인'}</span><span>{item.channel || '채널 미확인'}</span><time dateTime={item.sent_at || undefined}>{formatCustomerSmsTime(item.sent_at)}</time>{Number(item.attempt_count) > 0 && <span>발송 시도 {item.attempt_count}회</span>}{item.delivery?.code && <span>결과 코드 {item.delivery.code}</span>}{item.delivery?.received_at && <span>수신 {formatCustomerSmsTime(item.delivery.received_at)}</span>}{item.delivery?.reported_at && <span>결과 확정 {formatCustomerSmsTime(item.delivery.reported_at)}</span>}{item.delivery?.checked_at && <span>확인 {formatCustomerSmsTime(item.delivery.checked_at)}</span>}</p>
          <h3>{item.subject || '제목 미보관'}</h3>
          <button type="button" className="customer-sms-disclosure" aria-expanded={expanded} aria-controls={`customer-sms-body-${item.id}`} onClick={() => setExpandedId(expanded ? null : item.id)}>{expanded ? '본문 접기' : '발송 본문 보기'}<span aria-hidden="true">⌄</span></button>
          {expanded && <div className="customer-sms-body" id={`customer-sms-body-${item.id}`}><p>{item.text ?? '발송 당시 본문 미보관'}</p>{Array.isArray(item.attempts) && item.attempts.length > 0 && <section className="customer-sms-attempts" aria-label="실제 발송 시도"><h4>실제 발송 시도 {item.attempt_count || item.attempts.length}회</h4><ul>{item.attempts.map((attempt, index) => <li key={`${attempt.channel}-${attempt.code}-${index}`}><strong>{attempt.channel || '채널 미확인'}</strong><span className={`customer-sms-badge is-${customerDeliveryTone(attempt.state)}`}>{attempt.label || '결과 미확인'}</span><span>결과 코드 {attempt.code || '없음'}</span></li>)}</ul></section>}</div>}
        </article>; })}</div>}
        {history.status === 'ready' && <Pagination pagination={history.pagination} onPage={value => { setHistoryPage(value); setExpandedId(null); }} label="고객 문자 발송이력 페이지" />}
      </div>

      <div id="customer-sms-reviews" role="tabpanel" hidden={tab !== 'reviews'}>
        <div className={`customer-sms-connection is-${reviews.connection.state}`} role="status"><strong>{reviews.connection.label}</strong><span>{reviews.connection.notice}</span></div>
        <div className="customer-sms-review-toolbar"><label><span>리뷰 이벤트</span><select aria-label="리뷰 이벤트" value={campaign} onChange={event => { setCampaign(event.target.value); setReviewPage(1); setSelected([]); }}><option value="">전체 이벤트</option>{reviews.campaigns.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div><span>발송 가능 {reviews.counts.ready}</span><span>제외 {reviews.counts.blocked}</span></div></div>
        {reviewCampaign && <section className="customer-sms-campaign" aria-label="선택한 리뷰 이벤트"><div><strong>{reviewCampaign.name}</strong><span>{reviewCampaign.source || '출처 정보 없음'}</span><span>{reviewCampaign.status || '상태 정보 없음'}</span></div><h3>{reviewCampaign.subject || '제목 정보 없음'}</h3>{reviewCampaign.preview ? <p>{reviewCampaign.preview}</p> : <p>미리보기 정보 없음</p>}<dl><div><dt>발송 방식</dt><dd>{reviewCampaign.channel || '정보 없음'}</dd></div><div><dt>대체 발송</dt><dd>{reviewCampaign.replacement || '정보 없음'}</dd></div><div><dt>비용 안내</dt><dd>{reviewCampaign.cost_note || '정보 없음'}</dd></div></dl></section>}
        <LoadState status={reviews.status} empty={reviews.items.length === 0} error="리뷰 이벤트 대상을 불러오지 못했습니다." onRetry={loadReviews} />
        {reviews.status === 'ready' && reviews.items.length > 0 && <div className="customer-sms-review-list">{reviews.items.map(item => { const selectable = canSelectReviewCustomer(item, reviews.connection); return <label className={`customer-sms-review-item ${selectable ? '' : 'is-disabled'}`} key={item.orderId}><input type="checkbox" disabled={!selectable} checked={selected.includes(item.orderId)} onChange={event => setSelected(values => event.target.checked ? [...values, item.orderId] : values.filter(value => value !== item.orderId))} /><span className="customer-sms-review-item__copy"><strong>{item.customer_name || '고객명 미확인'}</strong><span>{item.maskedRecipient || '번호 미확인'} · 포장 {formatCustomerSmsTime(item.packedAt)}</span>{item.reasons?.length > 0 && <span>{item.reasons.map(reason => reason.label).join(' · ')}</span>}</span><span className={`customer-sms-badge is-${item.eligibility === 'ready' ? 'success' : 'muted'}`}>{item.eligibility === 'ready' ? '대상' : '제외'}</span></label>; })}</div>}
        {reviews.status === 'ready' && <><Pagination pagination={reviews.pagination} onPage={value => { setReviewPage(value); setSelected([]); }} label="리뷰 이벤트 대상 페이지" /><div className="customer-sms-send"><p>{reviews.connection.canSend ? `${selected.length}명을 선택했습니다.` : sendDisabledReason}</p><button type="button" disabled={!reviews.connection.canSend || selected.length === 0} title={!reviews.connection.canSend ? sendDisabledReason : undefined}>선택 고객에게 발송</button></div></>}
      </div>
    </section>
  );
}
