import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchInternalNotifications } from '../api/internalNotifications';
import NotificationOverview from '../components/NotificationOverview';
import {
  groupNotificationsByKstDate,
  NOTIFICATION_RECIPIENT_FILTERS,
  notificationPageNumbers,
} from './smsHistoryFilters';
import './SmsHistoryPage.css';

const STATUS_META = {
  success: { label: '발송 요청 완료', className: 'success' },
  failed: { label: '발송 요청 실패', className: 'failed' },
  dry_run: { label: '시험 기록', className: 'dry-run' },
};

const AUDIENCE_LABELS = {
  executive: '생산',
  member: '팀원',
  sales: '영업',
};

const EMPTY_SUMMARY = Object.freeze({
  total: 0,
  success: 0,
  failed: 0,
  delivery: Object.freeze({ received: 0, failed: 0, pending: 0, unknown: 0 }),
});
const EMPTY_PAGINATION = Object.freeze({
  page: 1,
  page_size: 10,
  total_items: 0,
  total_pages: 0,
});

const KST_DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatSentAt(value) {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '시간 정보 없음';
  return KST_DATE_TIME.format(date);
}

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.failed;
}

function deliveryMeta(item) {
  const delivery = item.delivery;
  const className = { received: 'success', failed: 'failed', pending: 'pending', unknown: 'dry-run' }[delivery?.state] || 'dry-run';
  return { label: delivery?.label || '전달 미확인', className };
}

export default function SmsHistoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading');
  const [recipient, setRecipient] = useState('');
  const [date, setDate] = useState('');
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [pagination, setPagination] = useState(EMPTY_PAGINATION);
  const [expandedId, setExpandedId] = useState(null);
  const [activePanel, setActivePanel] = useState('history');
  const requestIdRef = useRef(0);

  const loadNotifications = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');
    try {
      const data = await fetchInternalNotifications({ recipient, date, page, limit: 10 });
      if (requestId !== requestIdRef.current) return;
      setItems(Array.isArray(data?.items) ? data.items : []);
      setSummary({
        total: Number(data?.counts?.total) || 0,
        success: Number(data?.counts?.success) || 0,
        failed: Number(data?.counts?.failed) || 0,
        delivery: {
          received: Number(data?.counts?.delivery?.received) || 0,
          failed: Number(data?.counts?.delivery?.failed) || 0,
          pending: Number(data?.counts?.delivery?.pending) || 0,
          unknown: Number(data?.counts?.delivery?.unknown) || 0,
        },
      });
      setPagination({
        page: Number(data?.pagination?.page) || 1,
        page_size: Number(data?.pagination?.page_size) || 10,
        total_items: Number(data?.pagination?.total_items) || 0,
        total_pages: Number(data?.pagination?.total_pages) || 0,
      });
      setStatus('ready');
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus('error');
    }
  }, [date, page, recipient]);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const dateGroups = useMemo(() => groupNotificationsByKstDate(items), [items]);

  const pageNumbers = useMemo(
    () => notificationPageNumbers(pagination.page, pagination.total_pages),
    [pagination.page, pagination.total_pages],
  );

  const filterResult = status === 'loading'
    ? '선택한 조건의 발송내역을 조회하는 중입니다.'
    : status === 'ready'
      ? `${recipient || '전체 수신자'} · ${date || '전체 날짜'} · 총 ${summary.total}건 · ${pagination.page}/${pagination.total_pages || 1}페이지`
      : '선택한 조건의 발송내역을 불러오지 못했습니다.';

  return (
    <div className="sms-history-page">
      <header className="sms-history-header">
        <div className="sms-history-header__inner">
          <button
            type="button"
            className="sms-history-back"
            onClick={() => navigate('/')}
            aria-label="홈으로 돌아가기"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div>
            <p className="sms-history-eyebrow">자동문자 운영 현황</p>
            <h1>문자 발송내역</h1>
          </div>
        </div>
      </header>

      <main className="sms-history-main">
        <div className="sms-history-view-tabs" role="tablist" aria-label="문자 현황 보기">
          <button
            type="button"
            role="tab"
            id="sms-history-tab-history"
            aria-selected={activePanel === 'history'}
            aria-controls="sms-history-panel-history"
            onClick={() => setActivePanel('history')}
          >
            발송 내역
          </button>
          <button
            type="button"
            role="tab"
            id="sms-history-tab-overview"
            aria-selected={activePanel === 'overview'}
            aria-controls="sms-history-panel-overview"
            onClick={() => setActivePanel('overview')}
          >
            적용 현황
          </button>
        </div>

        <div className="sms-history-workspace">
          <section
            className={`sms-history-workspace-panel sms-history-workspace-panel--overview ${activePanel === 'overview' ? 'is-active' : ''}`}
            id="sms-history-panel-overview"
            role="tabpanel"
            aria-labelledby="sms-history-tab-overview"
            data-sms-panel="overview"
          >
            <NotificationOverview />
          </section>

          <section
            className={`sms-history-workspace-panel sms-history-workspace-panel--history ${activePanel === 'history' ? 'is-active' : ''}`}
            id="sms-history-panel-history"
            role="tabpanel"
            aria-labelledby="sms-history-tab-history"
            data-sms-panel="history"
          >

        <section className="sms-history-intro" aria-labelledby="sms-history-title">
          <div>
            <h2 id="sms-history-title">직원 알림 발송내역</h2>
            <p>
              생산 담당자, 작업자, 영업담당자에게 자동 발송된{' '}
              <span className="sms-history-keep-together">문자 내용과 요청 결과입니다.</span>
            </p>
          </div>
          <p className="sms-history-notice">
            발송 요청 완료는 문자 서비스에 요청이 접수됐다는 뜻이며,{' '}
            <span className="sms-history-keep-together">실제 수신 여부와는 다릅니다.</span>
          </p>
        </section>

        <section className="sms-history-filter-panel" aria-label="발송내역 조회 조건">
          <div className="sms-history-filter-controls">
            <label className="sms-history-filter-section" htmlFor="sms-history-recipient">
              <span className="sms-history-filter-label">수신자별 발송내역</span>
              <select
                id="sms-history-recipient"
                aria-label="수신자별 발송내역"
                value={recipient}
                onChange={event => {
                  setRecipient(event.target.value);
                  setPage(1);
                  setExpandedId(null);
                }}
              >
                <option value="">전체 수신자</option>
                {NOTIFICATION_RECIPIENT_FILTERS.map(name => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>

            <div className="sms-history-date-filter">
            <label htmlFor="sms-history-date">
              <span className="sms-history-date-label">
                <span className="sms-history-filter-label">날짜별 보기</span>
                <small>최신 날짜순 자동 정렬</small>
              </span>
              <input
                id="sms-history-date"
                type="date"
                aria-label="발송 날짜"
                value={date}
                onChange={event => {
                  setDate(event.target.value);
                  setPage(1);
                  setExpandedId(null);
                }}
              />
            </label>
            <button
              type="button"
              className="sms-history-date-clear"
              disabled={!date}
              onClick={() => {
                setDate('');
                setPage(1);
                setExpandedId(null);
              }}
            >
              전체 날짜
            </button>
            </div>
          </div>
          <p
            className="sms-history-live-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {filterResult}
          </p>
        </section>

        <section className="sms-history-summary" aria-label="발송 요약">
          <div className="sms-history-summary__cell">
            <span>조회 기록</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--success">
            <span>발송 요청 완료</span>
            <strong>{summary.success}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--failed">
            <span>요청 실패</span>
            <strong>{summary.failed}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--success">
            <span>수신 완료</span>
            <strong>{summary.delivery.received}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--failed">
            <span>전달 실패</span>
            <strong>{summary.delivery.failed}</strong>
          </div>
          <div className="sms-history-summary__cell">
            <span>확인 중·미확인</span>
            <strong>{summary.delivery.pending + summary.delivery.unknown}</strong>
          </div>
        </section>

        <div className="sms-history-list-scroll" data-history-scroll aria-label="문자 발송 기록" tabIndex={0}>
        {status === 'loading' && (
          <div className="sms-history-state" role="status" aria-live="polite">
            <span className="sms-history-spinner" aria-hidden="true" />
            문자 발송내역을 불러오는 중입니다.
          </div>
        )}

        {status === 'error' && (
          <div className="sms-history-state sms-history-state--error" role="alert">
            <strong>발송내역을 불러오지 못했습니다.</strong>
            <span>잠시 후 다시 시도해 주세요.</span>
            <button type="button" onClick={loadNotifications}>다시 불러오기</button>
          </div>
        )}

        {status === 'ready' && items.length === 0 && (
          <div className="sms-history-state" role="status">
            <strong>선택한 조건의 발송내역이 없습니다.</strong>
            <span>내부 자동문자가 발송되면 여기에 기록됩니다.</span>
          </div>
        )}

        {status === 'ready' && items.length > 0 && (
          <section className="sms-history-groups" aria-label="문자 발송 목록">
            {dateGroups.map(group => (
              <section
                className="sms-history-date-group"
                key={group.date}
                aria-labelledby={`sms-history-date-${group.date}`}
              >
                <div className="sms-history-date-heading">
                  <h2 id={`sms-history-date-${group.date}`}>{group.label}</h2>
                  <span>{group.items.length}건</span>
                </div>
                <div className="sms-history-list">
                  {group.items.map(item => {
                    const meta = statusMeta(item.status);
                    const delivery = deliveryMeta(item);
                    const isExpanded = expandedId === item.id;
                    const bodyId = `sms-history-body-${item.id}`;
                    return (
                      <article className="sms-history-item" key={item.id}>
                        <div className="sms-history-item__top">
                          <div className="sms-history-recipient">
                            <strong>{item.recipient_name}</strong>
                            <span className="sms-history-audience">
                              {AUDIENCE_LABELS[item.audience] || '수신자'}
                            </span>
                          </div>
                          <div className="sms-history-results">
                            <span className={`sms-history-status sms-history-status--${delivery.className}`}>
                              {delivery.label}
                            </span>
                            <span className="sms-history-request-status">{meta.label}</span>
                          </div>
                        </div>

                        <div className="sms-history-meta">
                          <span>{item.phone || '번호 정보 없음'}</span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={item.sent_at || undefined}>{formatSentAt(item.sent_at)}</time>
                          {item.delivery?.reported_at && (
                            <span>결과 확정 {formatSentAt(item.delivery.reported_at)}</span>
                          )}
                          {item.delivery?.checked_at && (
                            <span>확인 {formatSentAt(item.delivery.checked_at)}</span>
                          )}
                        </div>

                        <h3>{item.subject || '제목 저장 전 기록'}</h3>

                        <button
                          type="button"
                          className="sms-history-disclosure"
                          aria-expanded={isExpanded}
                          aria-controls={bodyId}
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                        >
                          <span>{isExpanded ? '내용 접기' : '발송 내용 보기'}</span>
                          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </button>

                        {isExpanded && (
                          <div className="sms-history-body" id={bodyId}>
                            {item.text || '내용 저장 전 기록'}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </section>
        )}
        </div>

        {status === 'ready' && pagination.total_pages > 0 && (
          <nav className="sms-history-pagination" aria-label="문자 발송내역 페이지">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => {
                setPage(Math.max(1, pagination.page - 1));
                setExpandedId(null);
              }}
            >
              이전
            </button>
            {pageNumbers.map(pageNumber => (
              <button
                type="button"
                key={pageNumber}
                className={pagination.page === pageNumber ? 'is-selected' : ''}
                aria-current={pagination.page === pageNumber ? 'page' : undefined}
                aria-label={`${pageNumber}페이지`}
                onClick={() => {
                  setPage(pageNumber);
                  setExpandedId(null);
                }}
              >
                {pageNumber}
              </button>
            ))}
            <button
              type="button"
              disabled={pagination.page >= pagination.total_pages}
              onClick={() => {
                setPage(Math.min(pagination.total_pages, pagination.page + 1));
                setExpandedId(null);
              }}
            >
              다음
            </button>
          </nav>
        )}
          </section>
        </div>
      </main>
    </div>
  );
}
