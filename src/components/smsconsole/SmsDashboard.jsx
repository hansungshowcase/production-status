import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSolapiMessages } from '../../api/solapiMessages';
import { fetchSmsConsole } from '../../api/smsConsole';
import {
  summarizeToday, matrixCells, hourlyBars, recentGroups, balanceState, templateCountsView,
} from './dashboardModel';
import './SmsDashboard.css';

const REFRESH_MS = 120000;

const pad = (n) => String(n).padStart(2, '0');
const nowLabel = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

function CardError({ message }) {
  return <p className="smsd-error" role="alert">{message}</p>;
}

function Card({ className = '', title, icon, onClick, onClickLabel, children }) {
  const body = (
    <>
      <h3 className="smsd-card-title">
        <svg className="smsd-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{icon}</svg>
        <span>{title}</span>
      </h3>
      {children}
    </>
  );
  if (onClick) {
    return (
      <section className={`smsd-card smsd-card-link ${className}`}>
        <button type="button" className="smsd-card-hit" onClick={onClick} aria-label={onClickLabel || title}>
          {body}
        </button>
      </section>
    );
  }
  return <section className={`smsd-card ${className}`}>{body}</section>;
}

const ICONS = {
  today: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  matrix: <path d="M4 4h16v16H4zM4 12h16M12 4v16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  hour: <path d="M12 7v5l3 2M12 3a9 9 0 100 18 9 9 0 000-18z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  recent: <path d="M5 6h14M5 12h14M5 18h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  balance: <path d="M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />,
  template: <path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
};

export default function SmsDashboard({ active = true, onNavigate }) {
  const [log, setLog] = useState({ data: null, error: '' });
  const [overview, setOverview] = useState({ data: null, error: '' });
  const [loading, setLoading] = useState(false);
  const [checkedAt, setCheckedAt] = useState('');
  const [visible, setVisible] = useState(isVisible);
  const busy = useRef(false);
  const alive = useRef(true);
  const loadedOnce = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    const [a, b] = await Promise.allSettled([
      fetchSolapiMessages({ view: 'groups', page_size: 20 }),
      fetchSmsConsole('overview'),
    ]);
    busy.current = false;
    if (!alive.current) return;
    setLog(a.status === 'fulfilled' ? { data: a.value, error: '' } : { data: null, error: a.reason?.message || '발송 현황을 불러오지 못했습니다.' });
    setOverview(b.status === 'fulfilled' ? { data: b.value, error: '' } : { data: null, error: b.reason?.message || '잔액·템플릿을 불러오지 못했습니다.' });
    setCheckedAt(nowLabel());
    setLoading(false);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const onChange = () => setVisible(isVisible());
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  // active 가 처음 true 가 될 때 1번 조회
  useEffect(() => {
    if (active && !loadedOnce.current) {
      loadedOnce.current = true;
      load();
    }
  }, [active, load]);

  // 보일 때만 120초 자동 새로고침. 숨기거나 active=false 면 해제
  useEffect(() => {
    if (!active || !visible) return undefined;
    const timer = setInterval(() => { load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, visible, load]);

  const go = (menu, patch) => () => { if (typeof onNavigate === 'function') onNavigate(menu, patch); };

  const logData = log.data;
  const today = summarizeToday(logData?.counts);
  const matrix = matrixCells(logData?.matrix);
  const bars = hourlyBars(logData?.hourly);
  const recent = recentGroups(logData?.groups, 5);
  const configured = overview.data ? overview.data.configured !== false : true;
  const logConfigured = logData ? logData.configured !== false : true;
  const balance = balanceState(overview.data?.balance);
  const tpl = templateCountsView(overview.data?.template_counts);
  const noKey = '쏠라피 키가 설정되지 않았습니다';
  const first = !checkedAt && loading;

  return (
    <div className="smsd">
      <div className="smsd-top">
        <span className="smsd-checked" aria-live="polite">{checkedAt ? `확인 ${checkedAt}` : (first ? '불러오는 중' : '')}</span>
        <button type="button" className="smsd-refresh" onClick={load} disabled={loading}>
          {loading ? '불러오는 중' : '새로고침'}
        </button>
      </div>

      <div className="smsd-grid">
        <Card className="smsd-today" title="오늘 발송" icon={ICONS.today} onClick={log.error ? null : go('log', { aud: 'all', ch: 'all' })} onClickLabel="오늘 발송 내역 보기">
          {log.error ? <CardError message={log.error} /> : !logConfigured ? <p className="smsd-muted">{noKey}</p> : (
            <>
              <p className="smsd-big">총 <strong>{today.total.toLocaleString('ko-KR')}</strong>건</p>
              <p className="smsd-sub">
                <span className="smsd-ok">성공 {today.success}</span>
                <span className="smsd-info">발송중 {today.pending}</span>
                <span className={today.hasFailed ? 'smsd-danger' : 'smsd-muted-inline'}>실패 {today.failed}</span>
              </p>
            </>
          )}
        </Card>

        <section className="smsd-card smsd-matrix">
          <h3 className="smsd-card-title">
            <svg className="smsd-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS.matrix}</svg>
            <span>받는 사람 × 종류</span>
          </h3>
          {log.error ? <CardError message={log.error} /> : (
            <>
              <table className="smsd-table">
                <thead>
                  <tr><th scope="col"><span className="smsd-sr">받는 사람</span></th><th scope="col">문자</th><th scope="col">알림톡</th></tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => (
                    <tr key={row.aud}>
                      <th scope="row">{row.label}</th>
                      {row.cells.map((c) => (
                        <td key={c.ch}>
                          <button
                            type="button"
                            className="smsd-cell"
                            onClick={go('log', { aud: c.aud, ch: c.ch })}
                            aria-label={`${row.label} ${c.label} ${c.total}건${c.failed > 0 ? `, 실패 ${c.failed}건` : ''} 보기`}
                          >
                            <strong>{c.total.toLocaleString('ko-KR')}</strong>
                            {c.failed > 0 ? <em className="smsd-danger">실패 {c.failed}</em> : null}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {matrix.otherTotal > 0 ? <p className="smsd-muted smsd-other">기타 {matrix.otherTotal.toLocaleString('ko-KR')}건</p> : null}
            </>
          )}
        </section>

        <Card className="smsd-balance" title="잔액" icon={ICONS.balance}>
          {overview.error ? <CardError message={overview.error} /> : !configured ? <p className="smsd-muted">{noKey}</p> : (
            <>
              <p className="smsd-big"><strong>{balance.text}</strong></p>
              {balance.low ? <p className="smsd-warn" role="alert">{balance.warning}</p> : null}
            </>
          )}
        </Card>

        <section className="smsd-card smsd-hourly">
          <h3 className="smsd-card-title">
            <svg className="smsd-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{ICONS.hour}</svg>
            <span>오늘 시간대별</span>
          </h3>
          {log.error ? <CardError message={log.error} /> : (
            <>
              <div className="smsd-bars" role="list">
                {bars.map((b) => (
                  <div className="smsd-bar-col" role="listitem" key={b.hour} title={b.label} aria-label={b.label}>
                    <div className="smsd-bar-area">
                      {b.heightPct > 0 ? (
                        <div className="smsd-bar" style={{ height: `${b.heightPct}%` }}>
                          {b.failed > 0 ? <span className="smsd-bar-fail" style={{ height: `${Math.max(b.failPct, 8)}%` }} /> : null}
                        </div>
                      ) : <div className="smsd-bar-zero" />}
                    </div>
                    <span className="smsd-bar-hour" aria-hidden="true">{b.hour % 6 === 0 ? b.hour : ''}</span>
                  </div>
                ))}
              </div>
              <p className="smsd-muted smsd-axis">시(時) 기준 · 빨간 띠는 실패</p>
            </>
          )}
        </section>

        <Card className="smsd-templates" title="알림톡 템플릿" icon={ICONS.template} onClick={go('templates', {})} onClickLabel="알림톡 템플릿 보기">
          {overview.error ? <CardError message={overview.error} /> : !configured ? <p className="smsd-muted">{noKey}</p> : !tpl.known ? (
            <p className="smsd-muted">템플릿 상태를 확인하지 못했습니다.</p>
          ) : (
            <ul className="smsd-tpl-list">
              {tpl.items.map((i) => (
                <li key={i.key} className={`smsd-tpl smsd-tpl-${i.tone}${i.key === 'REJECTED' && i.count > 0 ? ' smsd-tpl-alert' : ''}`}>
                  <span>{i.label}</span><strong>{i.count}</strong>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="smsd-recent" title="최근 발송 요청" icon={ICONS.recent} onClick={log.error ? null : go('log', {})} onClickLabel="요청별 발송 내역 보기">
          {log.error ? <CardError message={log.error} /> : recent.length === 0 ? (
            <p className="smsd-muted">{logConfigured ? '오늘 발송 요청이 없습니다.' : noKey}</p>
          ) : (
            <ul className="smsd-recent-list">
              {recent.map((r) => (
                <li key={r.key}>
                  <span className="smsd-r-time">{r.time || '-'}</span>
                  <span className="smsd-r-kind">{r.kind}</span>
                  <span className="smsd-r-count">{r.total}건</span>
                  <span className={`smsd-r-state smsd-tone-${r.tone}`}>{r.stateLabel}</span>
                  <span className="smsd-r-id">{r.idTail}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
