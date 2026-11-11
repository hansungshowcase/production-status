import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSolapiMessages } from '../api/solapiMessages';
import './SolapiMessageLog.css';

const AUDIENCE_TABS = [
  { value: 'all', label: '전체' },
  { value: 'customer', label: '고객' },
  { value: 'staff', label: '직원' },
];

const VIEW_TABS = [
  { value: 'messages', label: '건별 내역' },
  { value: 'groups', label: '요청별 내역' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: '전체' },
  { value: 'success', label: '발송 성공' },
  { value: 'pending', label: '발송중/대기' },
  { value: 'failed', label: '실패' },
];

const AUDIENCE_LABEL = { customer: '고객', staff: '직원', other: '기타' };

const kstDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const kstTimeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function todayKst() {
  return kstDateFormat.format(new Date());
}

function formatKst(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return kstTimeFormat.format(d);
}

function pageNumbers(page, totalPages) {
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  const out = [];
  for (let n = start; n <= end; n += 1) out.push(n);
  return out;
}

function emptyCounts() {
  return { total: 0, success: 0, pending: 0, failed: 0 };
}

function AudienceBadge({ audience }) {
  return (
    <span className={`solapi-log-audience solapi-log-audience--${audience}`}>
      {AUDIENCE_LABEL[audience] || '기타'}
    </span>
  );
}

function StatusChip({ item }) {
  return (
    <span className={`solapi-log-status solapi-log-status--${item.status}`}>
      {item.status_label}
      {item.status_code && !String(item.status_label || '').includes(item.status_code) ? <small>{item.status_code}</small> : null}
    </span>
  );
}

function Recipient({ item }) {
  return (
    <span className="solapi-log-recipient">
      {item.recipient_name ? <strong>{item.recipient_name}</strong> : null}
      <span>{item.to}</span>
    </span>
  );
}

function Detail({ item, id }) {
  return (
    <div className="solapi-log-detail" id={id}>
      {item.subject ? <p className="solapi-log-detail__subject">{item.subject}</p> : null}
      <div className="solapi-log-detail__text">{item.text || '(본문 없음)'}</div>
      <dl className="solapi-log-detail__meta">
        <div><dt>메시지 ID</dt><dd>{item.message_id}</dd></div>
        <div><dt>그룹 ID</dt><dd>{item.group_id}</dd></div>
        <div><dt>발신번호</dt><dd>{item.from || '-'}</dd></div>
        <div><dt>접수 시각</dt><dd>{formatKst(item.created_at)}</dd></div>
        <div><dt>리포트 시각</dt><dd>{formatKst(item.reported_at)}</dd></div>
        <div><dt>수신 시각</dt><dd>{formatKst(item.received_at)}</dd></div>
        {item.reason ? <div><dt>실패 사유</dt><dd>{item.reason}</dd></div> : null}
      </dl>
    </div>
  );
}

export default function SolapiMessageLog() {
  const [audience, setAudience] = useState('all');
  const [view, setView] = useState('messages');
  const [status, setStatus] = useState('all');
  const [date, setDate] = useState(todayKst);
  const [type, setType] = useState('all');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSolapiMessages({ date, audience, status, type, view, page });
      if (requestId !== requestIdRef.current) return;
      setData(result);
      setExpandedId('');
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err?.message || '쏠라피 발송내역을 불러오지 못했습니다');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [date, audience, status, type, view, page]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const counts = data?.counts || {};
  const shown = counts[audience] || counts.all || emptyCounts();
  const otherTotal = counts.other?.total || 0;
  const pagination = data?.pagination || { page: 1, total_pages: 0, total_items: 0 };
  const items = data?.items || [];
  const groups = data?.groups || [];
  const types = data?.types || [];
  const rows = view === 'groups' ? groups : items;
  const notConfigured = data && data.configured === false;

  // 구분·날짜가 바뀌면 타입 목록도 바뀌므로 타입은 '전체'로 되돌린다(안 보이는 필터가 남지 않게).
  function changeAudience(value) { setAudience(value); setType('all'); setPage(1); }
  function changeView(value) { setView(value); setPage(1); }
  function changeStatus(value) { setStatus(value); setPage(1); }
  function changeDate(value) { if (value) { setDate(value); setType('all'); setPage(1); } }
  function changeType(value) { setType(value); setPage(1); }

  return (
    <section className="solapi-log" aria-label="쏠라피 발송내역">
      <div className="solapi-log-audience-tabs" role="tablist" aria-label="받는 사람 구분">
        {AUDIENCE_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={audience === tab.value}
            onClick={() => changeAudience(tab.value)}
          >
            {tab.label}
            <span className="solapi-log-badge">{(counts[tab.value]?.total) ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="solapi-log-view-tabs" role="tablist" aria-label="보기 전환">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={view === tab.value}
            onClick={() => changeView(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="solapi-log-filters">
        <label className="solapi-log-field">
          <span>발송 상태</span>
          <select value={status} onChange={(e) => changeStatus(e.target.value)} aria-label="발송 상태">
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <label className="solapi-log-field">
          <span>날짜</span>
          <input type="date" value={date} onChange={(e) => changeDate(e.target.value)} aria-label="발송 날짜" />
        </label>
        <label className="solapi-log-field">
          <span>타입</span>
          <select value={type} onChange={(e) => changeType(e.target.value)} aria-label="메시지 타입">
            <option value="all">전체</option>
            {types.map((t) => (
              <option key={t.type} value={t.type}>{t.type} ({t.count})</option>
            ))}
          </select>
        </label>
        <button type="button" className="solapi-log-refresh" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
          새로고침
        </button>
      </div>

      <div className="solapi-log-notice" role="status" aria-live="polite" aria-atomic="true">
        <p>
          쏠라피 기록 기준 · {date} 0시~24시(한국시간) · 수신번호 가운데 가림
          {data?.checked_at ? ` · 확인 ${formatKst(data.checked_at)}` : ''}
        </p>
        <p>쏠라피에 닿기 전에 멈춘 문자(키 미설정·시험 기록·요청 실패)는 이 탭에 없고 &apos;고객 문자 관리&apos;·&apos;직원 알림 관리&apos; 탭에 있습니다.</p>
        {data?.partial ? <p className="solapi-log-notice__warn">건수가 많아 1,500건까지만 표시합니다(일부 누락).</p> : null}
        {notConfigured ? <p className="solapi-log-notice__warn">쏠라피 키가 설정되지 않아 조회할 수 없습니다.</p> : null}
      </div>

      <div className="solapi-log-summary">
        <div className="solapi-log-summary__cell"><span>전체</span><strong>{shown.total}</strong></div>
        <div className="solapi-log-summary__cell solapi-log-summary__cell--success"><span>발송 성공</span><strong>{shown.success}</strong></div>
        <div className="solapi-log-summary__cell solapi-log-summary__cell--pending"><span>발송중·대기</span><strong>{shown.pending}</strong></div>
        <div className="solapi-log-summary__cell solapi-log-summary__cell--failed"><span>실패</span><strong>{shown.failed}</strong></div>
      </div>
      {otherTotal > 0 ? <p className="solapi-log-other">기타 {otherTotal}</p> : null}

      {loading && !data ? (
        <div className="solapi-log-state" role="status"><div className="solapi-log-spinner" /><strong>불러오는 중</strong></div>
      ) : error ? (
        <div className="solapi-log-state solapi-log-state--error" role="alert">
          <strong>발송내역을 불러오지 못했습니다</strong>
          <span>{error}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)}>다시 불러오기</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="solapi-log-state">
          <strong>{loading ? '불러오는 중' : '조건에 맞는 발송내역이 없습니다'}</strong>
          <span>{date} 기준으로 조회했습니다.</span>
        </div>
      ) : view === 'groups' ? (
        <ul className="solapi-log-cards" aria-label="요청별 내역">
          {groups.map((g, i) => (
            <li key={g.group_id || `${g.created_at}-${i}`} className="solapi-log-card">
              <div className="solapi-log-card__top">
                <AudienceBadge audience={g.audience} />
                <span className="solapi-log-time">{formatKst(g.created_at)}</span>
              </div>
              <p className="solapi-log-card__title">{g.category}</p>
              <p className="solapi-log-card__meta">{g.type_label}</p>
              <p className="solapi-log-progress">
                성공 {g.success} · 발송중 {g.pending} · 실패 {g.failed} / 총 {g.total}
              </p>
              <p className="solapi-log-card__meta">
                {(g.recipients_preview || []).join(', ')}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="solapi-log-table-wrap">
            <table className="solapi-log-table">
              <thead>
                <tr>
                  <th>시각</th><th>구분</th><th>받는 사람</th><th>종류</th><th>타입</th><th>상태</th><th><span className="solapi-log-sr">상세</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const open = expandedId === item.message_id;
                  const detailId = `solapi-log-detail-${item.message_id}`;
                  return [
                    <tr key={item.message_id} className={open ? 'is-open' : ''}>
                      <td>{formatKst(item.created_at)}</td>
                      <td><AudienceBadge audience={item.audience} /></td>
                      <td><Recipient item={item} /></td>
                      <td>{item.category}</td>
                      <td>{item.type_label}</td>
                      <td><StatusChip item={item} /></td>
                      <td>
                        <button
                          type="button"
                          className="solapi-log-toggle"
                          aria-expanded={open}
                          aria-controls={detailId}
                          onClick={() => setExpandedId(open ? '' : item.message_id)}
                        >
                          {open ? '접기' : '상세'}
                        </button>
                      </td>
                    </tr>,
                    open ? (
                      <tr key={`${item.message_id}-d`} className="solapi-log-table__detail">
                        <td colSpan={7}><Detail item={item} id={detailId} /></td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>

          <ul className="solapi-log-cards solapi-log-cards--messages" aria-label="건별 내역">
            {items.map((item) => {
              const open = expandedId === item.message_id;
              const detailId = `solapi-log-card-detail-${item.message_id}`;
              return (
                <li key={item.message_id} className="solapi-log-card">
                  <div className="solapi-log-card__top">
                    <AudienceBadge audience={item.audience} />
                    <StatusChip item={item} />
                  </div>
                  <Recipient item={item} />
                  <p className="solapi-log-card__meta">
                    {formatKst(item.created_at)} · {item.category} · {item.type_label}
                  </p>
                  <button
                    type="button"
                    className="solapi-log-toggle solapi-log-toggle--wide"
                    aria-expanded={open}
                    aria-controls={detailId}
                    onClick={() => setExpandedId(open ? '' : item.message_id)}
                  >
                    {open ? '접기' : '본문·상세 보기'}
                  </button>
                  {open ? <Detail item={item} id={detailId} /> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {pagination.total_pages > 0 ? (
        <nav className="solapi-log-pagination" aria-label="쏠라피 발송내역 페이지">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>이전</button>
          {pageNumbers(pagination.page || page, pagination.total_pages).map((n) => (
            <button
              key={n}
              type="button"
              className={n === (pagination.page || page) ? 'is-selected' : ''}
              aria-current={n === (pagination.page || page) ? 'page' : undefined}
              disabled={loading}
              onClick={() => setPage(n)}
            >
              {n}
            </button>
          ))}
          <button type="button" disabled={page >= pagination.total_pages || loading} onClick={() => setPage(page + 1)}>다음</button>
        </nav>
      ) : null}
    </section>
  );
}
