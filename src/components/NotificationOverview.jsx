import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotificationOverview } from '../api/notificationOverview';
import './NotificationOverview.css';

const KST_DATE_TIME = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatDateTime(value) {
  if (!value) return '기록 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '기록 없음' : KST_DATE_TIME.format(date);
}
function recentSummary(recent, days) {
  if (recent?.state === 'unavailable') return '최근 처리 결과 조회 불가';
  const counts = recent?.counts || {};
  if (!counts.total) return `최근 ${days}일 기록 없음`;
  const parts = [
    `총 ${counts.total}건`,
    `수신 확인 ${counts.received || 0}건`,
    `접수 성공 ${counts.accepted || 0}건`,
  ];
  if (counts.processing) parts.push(`처리 중 ${counts.processing}건`);
  if (counts.failed) parts.push(`실패 ${counts.failed}건`);
  if (counts.dry_run) parts.push(`테스트 ${counts.dry_run}건`);
  if (counts.other) parts.push(`기타 ${counts.other}건`);
  return `최근 ${days}일 · ${parts.join(' · ')}`;
}

function aggregateRecent(groups) {
  const totals = { total: 0, received: 0, processing: 0, accepted: 0, failed: 0, dry_run: 0 };
  for (const group of groups || []) {
    for (const item of group.items || []) {
      for (const key of Object.keys(totals)) {
        totals[key] += Number(item.recent?.counts?.[key]) || 0;
      }
    }
  }
  return totals;
}

function OverviewItem({ item, days, expanded, onToggle }) {
  const detailsId = `notification-overview-details-${item.id}`;
  return (
    <article className="notification-overview-item" data-notification-rule={item.id}>
      <div className="notification-overview-item__row">
        <div className="notification-overview-item__heading">
          <h4>{item.name}</h4>
          <div className="notification-overview-badges">
            <span className={`notification-overview-badge notification-overview-badge--policy-${item.policy.status}`}>
              {item.policy.label}
            </span>
            {item.policy.status !== 'paused' && (
              <span className={`notification-overview-badge notification-overview-badge--${item.configuration.status}`}>
                {item.configuration.label}
              </span>
            )}
          </div>
        </div>

        <dl className="notification-overview-facts">
          <div>
            <dt>대상</dt>
            <dd>{item.target}</dd>
          </div>
          <div>
            <dt>발송 조건</dt>
            <dd>{item.trigger}</dd>
          </div>
        </dl>

        <button
          type="button"
          className="notification-overview-disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span>{expanded ? '접기' : '상세'}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="notification-overview-details" id={detailsId}>
          <dl>
            <div><dt>최근 결과</dt><dd>{recentSummary(item.recent, days)}</dd></div>
            <div><dt>발송 시간</dt><dd>{item.timing}</dd></div>
            <div><dt>채널</dt><dd>{item.configuration.channel}</dd></div>
            <div><dt>설정 판단</dt><dd>{item.configuration.reason}</dd></div>
            <div><dt>확인 시각</dt><dd>{formatDateTime(item.checked_at)}</dd></div>
            {item.recent?.latest && (
              <div>
                <dt>마지막 기록</dt>
                <dd>
                  {`${item.recent.latest.label}${item.recent.latest.channel ? ` · ${item.recent.latest.channel}` : ''} · ${formatDateTime(item.recent.latest.occurred_at)}`}
                </dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </article>
  );
}

export default function NotificationOverview() {
  const [status, setStatus] = useState('loading');
  const [overview, setOverview] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const requestIdRef = useRef(0);

  const loadOverview = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');
    try {
      const data = await fetchNotificationOverview();
      if (requestId !== requestIdRef.current) return;
      setOverview(data);
      setStatus('ready');
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const days = Number(overview?.recent_period?.days) || 7;
  const recentTotals = aggregateRecent(overview?.groups);

  return (
    <section
      className="notification-overview"
      aria-labelledby="notification-overview-title"
      data-notification-overview
    >
      <div className="notification-overview__intro">
        <div>
          <p className="notification-overview__eyebrow">자동 알림 적용 현황</p>
          <h2 id="notification-overview-title">현재 어떤 알림이 누구에게 가는지</h2>
          <p>실제 발송 진입점과 실행 설정을 기준으로 확인한 현황입니다.</p>
        </div>
        {status === 'ready' && (
          <time dateTime={overview?.checked_at || undefined}>
            {formatDateTime(overview?.checked_at)} 확인
          </time>
        )}
      </div>

      <p className="notification-overview__notice">
        제공사 접수 성공은 전송 요청이 접수됐다는 뜻입니다. 실제 수신은 전달 결과가 확인된 기록만 별도로 표시합니다.
      </p>

      {status === 'loading' && (
        <div className="notification-overview-state" role="status" aria-live="polite">
          자동 알림 적용 현황을 불러오는 중입니다.
        </div>
      )}

      {status === 'error' && (
        <div className="notification-overview-state notification-overview-state--error" role="alert">
          <strong>자동 알림 적용 현황을 불러오지 못했습니다.</strong>
          <span>아래 직원 알림 발송내역은 계속 확인할 수 있습니다.</span>
          <button type="button" onClick={loadOverview}>현황 다시 불러오기</button>
        </div>
      )}

      {status === 'ready' && (
        <>
          {overview?.log_status?.state === 'unavailable' && (
            <p className="notification-overview__log-warning" role="status">
              {overview.log_status.message}
            </p>
          )}
          {overview?.log_status?.state === 'available' && (
            <section className="notification-overview-summary" aria-label={`최근 ${days}일 처리 결과`}>
              <h3>최근 {days}일 처리 결과</h3>
              <dl>
                <div><dt>전체</dt><dd>{recentTotals.total}</dd></div>
                <div><dt>수신 확인</dt><dd>{recentTotals.received}</dd></div>
                <div><dt>접수 성공</dt><dd>{recentTotals.accepted}</dd></div>
                <div><dt>처리 중</dt><dd>{recentTotals.processing}</dd></div>
                <div><dt>실패</dt><dd>{recentTotals.failed}</dd></div>
                <div><dt>테스트</dt><dd>{recentTotals.dry_run}</dd></div>
              </dl>
            </section>
          )}
          <div className="notification-overview-groups">
            {(overview?.groups || []).map(group => (
              <section
                className="notification-overview-group"
                aria-labelledby={`notification-overview-group-${group.id}`}
                key={group.id}
              >
                <div className="notification-overview-group__heading">
                  <h3 id={`notification-overview-group-${group.id}`}>{group.label}</h3>
                  <span>{group.items.length}개 규칙</span>
                </div>
                <div className="notification-overview-list">
                  {group.items.map(item => (
                    <OverviewItem
                      key={item.id}
                      item={item}
                      days={days}
                      expanded={expandedId === item.id}
                      onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
