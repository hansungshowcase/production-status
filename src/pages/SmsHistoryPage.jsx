import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchInternalNotifications } from '../api/internalNotifications';
import './SmsHistoryPage.css';

const FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'executive', label: '간부' },
  { value: 'member', label: '팀원' },
];

const STATUS_META = {
  success: { label: '쏠라피 접수 성공', className: 'success' },
  failed: { label: '발송 요청 실패', className: 'failed' },
  dry_run: { label: '테스트 기록', className: 'dry-run' },
};

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

export default function SmsHistoryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('loading');
  const [audience, setAudience] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  const loadNotifications = useCallback(async () => {
    setStatus('loading');
    try {
      const data = await fetchInternalNotifications({ limit: 100 });
      setItems(Array.isArray(data?.items) ? data.items : []);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    loadNotifications();
  }, [loadNotifications]);

  const filteredItems = useMemo(
    () => audience === 'all' ? items : items.filter(item => item.audience === audience),
    [items, audience],
  );

  const summary = useMemo(() => ({
    total: items.length,
    success: items.filter(item => item.status === 'success').length,
    failed: items.filter(item => item.status === 'failed').length,
  }), [items]);

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
            <p className="sms-history-eyebrow">내부 생산 자동문자</p>
            <h1>문자 발송내역</h1>
          </div>
        </div>
      </header>

      <main className="sms-history-main">
        <section className="sms-history-intro" aria-labelledby="sms-history-title">
          <div>
            <h2 id="sms-history-title">쏠라피 발송 현황</h2>
            <p>간부와 팀원에게 자동 발송된 문자 내용과 요청 결과입니다.</p>
          </div>
          <p className="sms-history-notice">
            ‘접수 성공’은 쏠라피가 발송 요청을 정상 접수했다는 뜻입니다.
          </p>
        </section>

        <section className="sms-history-summary" aria-label="발송 요약">
          <div className="sms-history-summary__cell">
            <span>전체 기록</span>
            <strong>{summary.total}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--success">
            <span>접수 성공</span>
            <strong>{summary.success}</strong>
          </div>
          <div className="sms-history-summary__cell sms-history-summary__cell--failed">
            <span>요청 실패</span>
            <strong>{summary.failed}</strong>
          </div>
        </section>

        <div className="sms-history-filters" role="group" aria-label="수신자 구분">
          {FILTERS.map(filter => (
            <button
              type="button"
              key={filter.value}
              className={audience === filter.value ? 'is-selected' : ''}
              aria-pressed={audience === filter.value}
              onClick={() => {
                setAudience(filter.value);
                setExpandedId(null);
              }}
            >
              {filter.label}
            </button>
          ))}
        </div>

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

        {status === 'ready' && filteredItems.length === 0 && (
          <div className="sms-history-state" role="status">
            <strong>표시할 발송내역이 없습니다.</strong>
            <span>내부 자동문자가 발송되면 여기에 기록됩니다.</span>
          </div>
        )}

        {status === 'ready' && filteredItems.length > 0 && (
          <section className="sms-history-list" aria-label="문자 발송 목록">
            {filteredItems.map(item => {
              const meta = statusMeta(item.status);
              const isExpanded = expandedId === item.id;
              const bodyId = `sms-history-body-${item.id}`;
              return (
                <article className="sms-history-item" key={item.id}>
                  <div className="sms-history-item__top">
                    <div className="sms-history-recipient">
                      <strong>{item.recipient_name}</strong>
                      <span className="sms-history-audience">
                        {item.audience === 'member' ? '팀원' : '간부'}
                      </span>
                    </div>
                    <span className={`sms-history-status sms-history-status--${meta.className}`}>
                      {meta.label}
                    </span>
                  </div>

                  <div className="sms-history-meta">
                    <span>{item.phone || '번호 정보 없음'}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={item.sent_at || undefined}>{formatSentAt(item.sent_at)}</time>
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
          </section>
        )}
      </main>
    </div>
  );
}
