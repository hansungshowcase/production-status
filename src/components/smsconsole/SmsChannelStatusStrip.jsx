import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSolapiMessages } from '../../api/solapiMessages.js';
import { clearSmsConsoleClientCache, fetchSmsConsole } from '../../api/smsConsole.js';
import { SOLAPI_HEALTH_REASONS } from '../../../shared/solapiHealthText.js';
import { balanceState, summarizeChannelLog, templateCountsView } from './dashboardModel.js';
import './SmsChannelStatusStrip.css';

const REFRESH_MS = 120000;
const pad = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function healthBandText(health) {
  if (!health || typeof health !== 'object') return '';
  const bad = health.state && health.state !== 'ok' && health.state !== 'unknown';
  if (!bad && !health.cron_stale) return '';
  const reason = bad ? (SOLAPI_HEALTH_REASONS[health.state] || '연동 상태를 확인하세요') : SOLAPI_HEALTH_REASONS.cron_stale;
  let okAt = '';
  const t = health.last_ok_at ? new Date(health.last_ok_at) : null;
  if (t && !Number.isNaN(t.getTime())) {
    okAt = t.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  }
  return `쏠라피 연동 이상: ${reason}${okAt ? ` · 마지막 정상 ${okAt}` : ''}`;
}

/**
 * Compact channel-specific status board rendered directly above SMS or Kakao template screens.
 */
export default function SmsChannelStatusStrip({
  channel = 'sms',
  active = true,
  autoStats = null,
  onOpenLog,
  onAttentionClick,
}) {
  const isKakao = channel === 'kakao';
  const chKey = isKakao ? 'kakao' : 'sms';
  const [log, setLog] = useState({ data: null, error: '' });
  const [overview, setOverview] = useState({ data: null, error: '' });
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');
  const [visible, setVisible] = useState(isVisible);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (force = false) => {
    if (busyRef.current) return;
    if (force) clearSmsConsoleClientCache();
    busyRef.current = true;
    setLoading(true);
    const [logRes, ovRes] = await Promise.allSettled([
      fetchSolapiMessages({ channel: chKey, view: 'groups', page_size: 20 }),
      fetchSmsConsole('overview', {}, { bypassCache: force }),
    ]);
    busyRef.current = false;
    if (!aliveRef.current) return;
    setLog((prev) => (logRes.status === 'fulfilled'
      ? { data: logRes.value, error: '' }
      : prev?.data ? prev : { data: null, error: logRes.reason?.message || '발송 현황을 불러오지 못했습니다.' }));
    setOverview((prev) => (ovRes.status === 'fulfilled'
      ? { data: ovRes.value, error: '' }
      : prev?.data ? prev : { data: null, error: ovRes.reason?.message || '잔액 정보를 불러오지 못했습니다.' }));
    setCheckedAt(nowLabel());
    setLoading(false);
  }, [chKey]);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  useEffect(() => {
    if (active && !loadedOnceRef.current) {
      loadedOnceRef.current = true;
      load();
    }
  }, [active, load]);

  useEffect(() => {
    if (!active || !visible) return undefined;
    const timer = setInterval(() => { load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, visible, load]);

  const summary = summarizeChannelLog(log.data, chKey);
  const configured = overview.data ? overview.data.configured !== false : true;
  const logConfigured = log.data ? log.data.configured !== false : true;
  const balance = balanceState(overview.data?.balance);
  const tplCounts = isKakao ? templateCountsView(overview.data?.template_counts) : null;
  const band = healthBandText(overview.data?.solapi_health);
  const firstLoading = !checkedAt && loading;
  const onCount = Number(autoStats?.on) || 0;
  const totalCount = Number(autoStats?.total) || 0;
  const attentionCount = Number(autoStats?.attention) || 0;
  const ataOn = Number(autoStats?.ataOn) || 0;
  const bmsOn = Number(autoStats?.bmsOn) || 0;

  return (
    <section className="scss-root" aria-label={isKakao ? '카카오톡 발송 현황판' : '문자 발송 현황판'}>
      {band ? <p className="scss-health" role="alert">{band}</p> : null}

      <div className="scss-grid">
        <div className="scss-cell scss-cell--link">
          <button
            type="button"
            className="scss-hit"
            disabled={!onOpenLog || Boolean(log.error)}
            onClick={() => onOpenLog?.({ aud: 'all', ch: chKey })}
            aria-label={isKakao ? '오늘 카카오톡 발송 내역 보기' : '오늘 문자 발송 내역 보기'}
          >
            <div className="scss-label-row">
              <span className="scss-label">{isKakao ? '오늘 카카오톡 발송' : '오늘 문자 발송'}</span>
              {onOpenLog && !log.error ? <span className="scss-more">내역 →</span> : null}
            </div>
            {log.error ? (
              <p className="scss-err">{log.error}</p>
            ) : !logConfigured ? (
              <p className="scss-muted">쏠라피 연결 전</p>
            ) : firstLoading && !log.data ? (
              <p className="scss-muted">불러오는 중…</p>
            ) : (
              <>
                <div className="scss-val-row">
                  <strong className="scss-val">{summary.total.toLocaleString('ko-KR')}건</strong>
                  <span className="scss-stats">
                    <span className="scss-ok">성공 {summary.success}</span>
                    {summary.pending > 0 ? <span className="scss-info">발송중 {summary.pending}</span> : null}
                    <span className={summary.hasFailed ? 'scss-danger' : 'scss-muted-inline'}>실패 {summary.failed}</span>
                  </span>
                </div>
                <p className="scss-sub">고객 {summary.customerTotal}건 · 직원 {summary.staffTotal}건</p>
              </>
            )}
          </button>
        </div>

        <div className="scss-cell">
          <div className="scss-label-row">
            <span className="scss-label">{isKakao ? '카톡 자동 발송' : '문자 자동 발송'}</span>
            {attentionCount > 0 && onAttentionClick ? (
              <button type="button" className="scss-warn-btn" onClick={onAttentionClick}>
                확인 필요 {attentionCount}건 →
              </button>
            ) : null}
          </div>
          {autoStats ? (
            <>
              <div className="scss-val-row">
                <strong className="scss-val">켜짐 {onCount}개</strong>
                <span className="scss-sub-inline">/ 전체 {totalCount}개</span>
              </div>
              <p className="scss-sub">
                {isKakao ? (
                  <>알림톡 {ataOn}개 · 브랜드메시지 {bmsOn}개</>
                ) : attentionCount > 0 ? (
                  <span className="scss-warn-text">꺼짐·확인 필요 {attentionCount}건 있습니다</span>
                ) : (
                  <span>적용된 자동 문자 정상 운영 중</span>
                )}
              </p>
            </>
          ) : (
            <p className="scss-muted">집계 중…</p>
          )}
        </div>

        <div className="scss-cell">
          {isKakao ? (
            <>
              <div className="scss-label-row">
                <span className="scss-label">알림톡 검수 상태</span>
              </div>
              {overview.error ? (
                <p className="scss-err">{overview.error}</p>
              ) : !configured ? (
                <p className="scss-muted">쏠라피 키 미설정</p>
              ) : !tplCounts?.known ? (
                <p className="scss-muted">{firstLoading ? '불러오는 중…' : '상태 확인 중'}</p>
              ) : (
                <div className="scss-tpl-pills">
                  {tplCounts.items.map((item) => (
                    <span
                      key={item.key}
                      className={`scss-tpl-chip scss-tpl-chip--${item.tone}${item.key === 'REJECTED' && item.count > 0 ? ' is-alert' : ''}`}
                    >
                      {item.label} <strong>{item.count}</strong>
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="scss-label-row">
                <span className="scss-label">최근 문자 발송 요청</span>
              </div>
              {log.error ? (
                <p className="scss-err">불러오지 못함</p>
              ) : summary.recent.length === 0 ? (
                <p className="scss-muted">{firstLoading ? '불러오는 중…' : '오늘 발송 요청이 없습니다.'}</p>
              ) : (
                <ul className="scss-mini-recent">
                  {summary.recent.slice(0, 2).map((row) => (
                    <li key={row.key}>
                      <span className="scss-r-time">{row.time || '-'}</span>
                      <span className="scss-r-kind">{row.kind}</span>
                      <span className="scss-r-count">{row.total}건</span>
                      <span className={`scss-r-state scss-tone-${row.tone}`}>{row.stateLabel}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="scss-cell scss-cell--balance">
          <div className="scss-label-row">
            <span className="scss-label">쏠라피 잔액</span>
            <button type="button" className="scss-refresh" onClick={() => load(true)} disabled={loading}>
              {loading ? '확인 중' : '새로고침'}
            </button>
          </div>
          {overview.error ? (
            <p className="scss-err">{overview.error}</p>
          ) : !configured ? (
            <p className="scss-muted">쏠라피 키 미설정</p>
          ) : (
            <>
              <div className="scss-val-row">
                <strong className="scss-val">{balance.known ? balance.text : (firstLoading ? '확인 중…' : balance.text)}</strong>
                {checkedAt ? <span className="scss-checked">확인 {checkedAt}</span> : null}
              </div>
              {balance.low ? <p className="scss-warn-text" role="alert">{balance.warning}</p> : <p className="scss-sub">한성쇼케이스 계정 기준</p>}
            </>
          )}
        </div>
      </div>

      {isKakao && summary.recent.length > 0 ? (
        <div className="scss-footer-bar">
          <span className="scss-footer-label">오늘 최근 카톡 발송</span>
          <div className="scss-footer-items">
            {summary.recent.map((row) => (
              <span key={row.key} className="scss-footer-chip">
                <span className="scss-r-time">{row.time || '-'}</span>
                <span>{row.kind}</span>
                <strong>{row.total}건</strong>
                <span className={`scss-tone-${row.tone}`}>({row.stateLabel})</span>
              </span>
            ))}
          </div>
          {onOpenLog ? (
            <button type="button" className="scss-footer-link" onClick={() => onOpenLog({ aud: 'all', ch: 'kakao' })}>
              전체 내역 →
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
