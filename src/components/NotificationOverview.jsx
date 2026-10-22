import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNotificationOverview } from '../api/notificationOverview';
import {
  notificationChannelPresentation,
  notificationLogMessagePresentation,
  notificationRecentLabelPresentation,
  notificationStatusPresentation,
  notificationTextPresentation,
} from './notificationOverviewPresentation';
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
  if (recent?.state === 'unavailable') return '최근 처리 결과를 불러올 수 없음';
  const counts = recent?.counts || {};
  if (!counts.total) return `최근 ${days}일 기록 없음`;
  const parts = [
    `총 ${counts.total}건`,
    `수신 확인 ${counts.received || 0}건`,
    `발송 요청 완료 ${counts.accepted || 0}건`,
  ];
  if (counts.processing) parts.push(`전달 확인 중 ${counts.processing}건`);
  if (counts.failed) parts.push(`실패 ${counts.failed}건`);
  if (counts.dry_run) parts.push(`시험 ${counts.dry_run}건`);
  if (counts.other) parts.push(`상태 확인 필요 ${counts.other}건`);
  return `최근 ${days}일 · ${parts.join(' · ')}`;
}

function notificationCatalogWarning(catalogStatus) {
  const state = catalogStatus?.state;
  if (state === 'partial') return '일부 자동 알림 종류를 불러오지 못했습니다.';
  if (state === 'unavailable') return '자동 알림 종류를 확인하지 못했습니다.';
  return '';
}

function ExampleMessage({ exampleMessage }) {
  const text = exampleMessage?.text;
  if (typeof text !== 'string' || !text.trim()) return null;

  const label = typeof exampleMessage.label === 'string' && exampleMessage.label.trim()
    ? exampleMessage.label
    : '예시 발송 문구';
  const subject = typeof exampleMessage.subject === 'string' ? exampleMessage.subject : '';

  return (
    <div className="notification-overview-example-message" data-notification-example-message>
      <p className="notification-overview-example-message__label">{label}</p>
      {subject.trim() && (
        <p className="notification-overview-example-message__subject">{subject}</p>
      )}
      <p className="notification-overview-example-message__text">{text}</p>
    </div>
  );
}

function OverviewItem({ item, days, expanded, onToggle }) {
  const detailsId = `notification-overview-details-${item.id}`;
  const state = notificationStatusPresentation(item);
  return (
    <article
      className={`notification-overview-item notification-overview-item--${state.key}`}
      data-notification-rule={item.id}
    >
      <div className="notification-overview-item__row">
        <div className="notification-overview-item__heading">
          <h4>{item.name}</h4>
          <div className="notification-overview-badges">
            <span className={`notification-overview-badge notification-overview-badge--${state.key}`}>
              {state.label}
            </span>
          </div>
        </div>

        <dl className="notification-overview-facts">
          <div>
            <dt>받는 사람</dt>
            <dd>{notificationTextPresentation(item.target)}</dd>
          </div>
        </dl>

        <button
          type="button"
          className="notification-overview-disclosure"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span>{expanded ? '자세히 접기' : '자세히 보기'}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>

      {expanded && (
        <div className="notification-overview-details" id={detailsId}>
          <dl>
            <div><dt>언제 보내나</dt><dd>{notificationTextPresentation(item.trigger)}</dd></div>
            <div><dt>최근 결과</dt><dd>{recentSummary(item.recent, days)}</dd></div>
            <div><dt>발송 시간</dt><dd>{notificationTextPresentation(item.timing)}</dd></div>
            <div><dt>보내는 방법</dt><dd>{notificationChannelPresentation(item.configuration.channel)}</dd></div>
            <div><dt>확인 시각</dt><dd>{formatDateTime(item.checked_at)}</dd></div>
            {item.recent?.latest && (
              <div>
                <dt>마지막 기록</dt>
                <dd>
                  {`${notificationRecentLabelPresentation(item.recent.latest.label)}${item.recent.latest.channel ? ` · ${notificationChannelPresentation(item.recent.latest.channel)}` : ''} · ${formatDateTime(item.recent.latest.occurred_at)}`}
                </dd>
              </div>
            )}
          </dl>
          <ExampleMessage exampleMessage={item.example_message} />
        </div>
      )}
    </article>
  );
}

export default function NotificationOverview() {
  const [status, setStatus] = useState('loading');
  const [overview, setOverview] = useState(null);
  const [activeGroupId, setActiveGroupId] = useState('customer');
  const [expandedByGroup, setExpandedByGroup] = useState({ customer: null, internal: null });
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
  const groups = overview?.groups || [];
  const customerCount = groups.find(group => group.id === 'customer')?.items?.length || 0;
  const internalCount = groups.find(group => group.id === 'internal')?.items?.length || 0;
  const pausedCount = groups.reduce(
    (count, group) => count + (group.items || []).filter(item => item.policy?.status === 'paused').length,
    0,
  );
  const catalogWarning = notificationCatalogWarning(overview?.catalog_status);

  return (
    <section
      className="notification-overview"
      aria-labelledby="notification-overview-title"
      data-notification-overview
    >
      <div className="notification-overview__intro">
        <div>
          <p className="notification-overview__eyebrow">자동 알림 적용 현황</p>
          <h2 id="notification-overview-title">자동 알림과 받는 사람</h2>
        </div>
        {status === 'ready' && (
          <time dateTime={overview?.checked_at || undefined}>
            {formatDateTime(overview?.checked_at)} 확인
          </time>
        )}
      </div>

      <p className="notification-overview__notice">
        발송 요청 완료는 문자 서비스에 요청이 접수됐다는 뜻이며, 실제 수신 여부와는 다릅니다.
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
          <dl className="notification-overview-summary" aria-label="자동 알림 종류 요약">
            <div><dt>고객 알림</dt><dd>{customerCount}</dd></div>
            <div><dt>직원 알림</dt><dd>{internalCount}</dd></div>
            <div><dt>보내지 않음</dt><dd>{pausedCount}</dd></div>
          </dl>
          {catalogWarning && (
            <p className="notification-overview__log-warning" role="status">
              {catalogWarning}
            </p>
          )}
          {overview?.log_status?.state === 'unavailable' && (
            <p className="notification-overview__log-warning" role="status">
              {notificationLogMessagePresentation(overview.log_status.message)}
            </p>
          )}
          <div
            className="notification-overview-group-tabs"
            role="tablist"
            aria-label="알림 대상 그룹"
          >
            {groups.map(group => {
              const tabId = `notification-overview-tab-${group.id}`;
              const panelId = `notification-overview-panel-${group.id}`;
              const label = group.id === 'internal' ? '직원 알림' : group.label;
              return (
                <button
                  type="button"
                  role="tab"
                  id={tabId}
                  key={group.id}
                  aria-selected={activeGroupId === group.id}
                  aria-controls={panelId}
                  onClick={() => setActiveGroupId(group.id)}
                >
                  {label} <strong>{group.items.length}</strong>
                </button>
              );
            })}
          </div>
          <div className="notification-overview-scroll" aria-label="자동 알림 종류 목록" tabIndex={0}>
            <div className="notification-overview-groups">
            {groups.map(group => (
              <section
                className="notification-overview-group"
                role="tabpanel"
                id={`notification-overview-panel-${group.id}`}
                aria-labelledby={`notification-overview-tab-${group.id}`}
                key={group.id}
                hidden={activeGroupId !== group.id}
              >
                <div className="notification-overview-list">
                  {group.items.map(item => (
                    <OverviewItem
                      key={item.id}
                      item={item}
                      days={days}
                      expanded={expandedByGroup[group.id] === item.id}
                      onToggle={() => setExpandedByGroup(current => ({
                        ...current,
                        [group.id]: current[group.id] === item.id ? null : item.id,
                      }))}
                    />
                  ))}
                </div>
              </section>
            ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
