import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSolapiMessages } from '../api/solapiMessages';
import SolapiGroupTable from './solapi/SolapiGroupTable';
import SolapiMessageTable from './solapi/SolapiMessageTable';
import SolapiMessageDetail from './solapi/SolapiMessageDetail';
import { CHANNEL_KINDS } from '../../shared/smsConsole.js';
import './SolapiMessageLog.css';

const VIEW_TABS = [
  { value: 'groups', label: '요청별 내역' },
  { value: 'messages', label: '건별 내역' },
];

const AUDIENCE_TABS = [
  { value: 'all', label: '전체' },
  { value: 'customer', label: '고객' },
  { value: 'staff', label: '직원' },
];

const CHANNEL_TABS = [
  { value: 'all', label: '전체' },
  { value: 'sms', label: '문자' },
  { value: 'kakao', label: '알림톡' },
].filter((t) => CHANNEL_KINDS.includes(t.value));

const PAGE_SIZES = [20, 50, 100];

const MESSAGE_STATUS = [
  { value: 'success', label: '발송 성공' },
  { value: 'pending', label: '발송중·대기' },
  { value: 'failed', label: '실패' },
];

const GROUP_STATUS = [
  { value: 'COMPLETE', label: '처리완료' },
  { value: 'SENDING', label: '발송요청완료' },
  { value: 'PENDING', label: '접수대기' },
  { value: 'SCHEDULED', label: '예약대기' },
  { value: 'FAILED', label: '실패' },
];

const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const TEMPLATE_RE = /^[\w-]{1,64}$/;
const SENDER_RE = /^[0-9*-]{4,20}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{6,60}$/;
// 서버(api/solapi-messages.js optionalCount)와 같은 상한 100,000
const COUNT_RE = /^(?:[0-9]{1,5}|100000)$/;

// 칩 정의: 보기마다 다르다. kind = select | text | number | date
const CHIPS = {
  groups: [
    { key: 'date', label: '생성일', kind: 'date' },
    { key: 'group_status', label: '그룹상태', kind: 'select', options: GROUP_STATUS },
    { key: 'group_id', label: 'Group ID', kind: 'text', test: ID_RE, hint: '영문·숫자 10~40자' },
    { key: 'min_total', label: '접수건수', kind: 'number', test: COUNT_RE, hint: '이상(숫자)' },
    { key: 'min_sent', label: '발송건수', kind: 'number', test: COUNT_RE, hint: '이상(숫자)' },
  ],
  messages: [
    { key: 'status', label: '발송 상태', kind: 'select', options: MESSAGE_STATUS },
    { key: 'date', label: '생성일', kind: 'date' },
    { key: 'type', label: '메시지종류', kind: 'select', dynamic: 'types' },
    { key: 'to4', label: '수신번호', kind: 'text', test: /^[0-9]{4}$/, hint: '끝 4자리' },
    { key: 'from', label: '발신번호', kind: 'select', dynamic: 'senders' },
    { key: 'message_id', label: 'Message ID', kind: 'text', test: MESSAGE_ID_RE, hint: '메시지 ID' },
    { key: 'group_id', label: 'Group ID', kind: 'text', test: ID_RE, hint: '영문·숫자 10~40자' },
    { key: 'template_id', label: '알림톡 템플릿 ID', kind: 'text', test: TEMPLATE_RE, hint: '템플릿 ID' },
  ],
};

const FILTER_KEYS_BY_VIEW = {
  groups: CHIPS.groups.filter((c) => c.key !== 'date').map((c) => c.key),
  messages: CHIPS.messages.filter((c) => c.key !== 'date').map((c) => c.key),
};

const kstDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const kstClockFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function todayKst() {
  return kstDateFormat.format(new Date());
}

function dayBeforeKst(offset) {
  const [y, m, d] = todayKst().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - offset)).toISOString().slice(0, 10);
}

function clock(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : kstClockFormat.format(d);
}

function keepFor(view, filters, dropDynamic) {
  const next = {};
  for (const key of FILTER_KEYS_BY_VIEW[view]) {
    if (dropDynamic && (key === 'type' || key === 'from')) continue;
    if (filters[key]) next[key] = filters[key];
  }
  return next;
}

function useOutsideClose(ref, open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, onClose]);
}

function FilterChip({ chip, value, options, onApply, onClear }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const wrapRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClose(wrapRef, open, close);

  const active = Boolean(value);
  const clearable = chip.key !== 'date';
  const shown = chip.kind === 'select'
    ? (options.find((o) => o.value === value)?.label || value)
    : value;

  function toggle() {
    setDraft(value || '');
    setInvalid(false);
    setOpen((v) => !v);
  }

  function apply(next) {
    const text = String(next || '').trim();
    if (!text) { if (clearable) onClear(chip.key); setOpen(false); return; }
    if (chip.test && !chip.test.test(text)) { setInvalid(true); return; }
    onApply(chip.key, text);
    setOpen(false);
  }

  return (
    <span className="solapi-log-chipwrap" ref={wrapRef}>
      <span className={`solapi-log-chip${active ? ' is-active' : ''}`}>
        <button
          type="button"
          className="solapi-log-chip__main"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
        >
          <span aria-hidden="true">{active ? '' : '⊕ '}</span>
          {chip.label}{active ? `: ${shown}` : ''}
        </button>
        {active && clearable ? (
          <button
            type="button"
            className="solapi-log-chip__clear"
            aria-label={`${chip.label} 필터 해제`}
            onClick={() => onClear(chip.key)}
          >
            ✕
          </button>
        ) : null}
      </span>
      {open ? (
        <div className="solapi-log-pop" role="dialog" aria-label={`${chip.label} 필터`}>
          {chip.kind === 'select' ? (
            <ul className="solapi-log-pop__list">
              {options.length === 0 ? <li className="solapi-log-pop__empty">고를 값이 없습니다</li> : null}
              {options.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    className={o.value === value ? 'is-selected' : ''}
                    onClick={() => apply(o.value)}
                  >
                    {o.label}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <form
              className="solapi-log-pop__form"
              onSubmit={(e) => { e.preventDefault(); apply(draft); }}
            >
              <input
                autoFocus
                type={chip.kind === 'date' ? 'date' : chip.kind === 'number' ? 'number' : 'text'}
                min={chip.kind === 'number' ? 0 : undefined}
                inputMode={chip.key === 'to4' || chip.kind === 'number' ? 'numeric' : undefined}
                value={draft}
                placeholder={chip.hint || ''}
                aria-label={chip.label}
                onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
              />
              {invalid ? <span className="solapi-log-pop__error" role="alert">형식이 맞지 않습니다 ({chip.hint})</span> : null}
              <button type="submit" className="solapi-log-pop__apply">적용</button>
            </form>
          )}
        </div>
      ) : null}
    </span>
  );
}

export default function SolapiMessageLog({
  audience: audienceProp,
  channel: channelProp,
  onAudienceChange,
  onChannelChange,
  preset,
} = {}) {
  const [view, setView] = useState('groups');
  const [audience, setAudience] = useState(audienceProp || 'all');
  const [channel, setChannel] = useState(CHANNEL_KINDS.includes(channelProp) ? channelProp : 'all');
  const [prevAudienceProp, setPrevAudienceProp] = useState(audienceProp);
  const [prevChannelProp, setPrevChannelProp] = useState(channelProp);
  const [prevPresetKey, setPrevPresetKey] = useState(undefined);
  const [date, setDate] = useState(todayKst);
  const [filters, setFilters] = useState({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState(null);
  const requestIdRef = useRef(0);
  const rowRef = useRef(null);

  // 바깥에서 받는 값이 바뀌면 같은 렌더에서 안쪽 상태를 맞춘다(불필요한 조회 방지)
  if (audienceProp !== prevAudienceProp) {
    setPrevAudienceProp(audienceProp);
    if (audienceProp && audienceProp !== audience) {
      setAudience(audienceProp);
      setFilters((f) => keepFor(view, f, true));
      setPage(1);
    }
  }
  if (channelProp !== prevChannelProp) {
    setPrevChannelProp(channelProp);
    if (CHANNEL_KINDS.includes(channelProp) && channelProp !== channel) {
      setChannel(channelProp);
      setFilters((f) => keepFor(view, f, true));
      setPage(1);
    }
  }
  if (preset?.key !== prevPresetKey) {
    setPrevPresetKey(preset?.key);
    if (preset && preset.key !== undefined) {
      const nextView = VIEW_TABS.some((t) => t.value === preset.view) ? preset.view : view;
      if (nextView !== view) { setView(nextView); setSelected(null); }
      setFilters(keepFor(nextView, preset.filters || {}, false));
      setPage(1);
    }
  }

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const result = await fetchSolapiMessages({ date, audience, channel, view, page, page_size: pageSize, ...filters });
      if (requestId !== requestIdRef.current) return;
      setData(result);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err?.message || '쏠라피 발송내역을 불러오지 못했습니다');
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [date, audience, channel, view, page, pageSize, filters]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const counts = data?.counts || {};
  const groupCounts = data?.group_counts || {};
  const pagination = data?.pagination || { page: 1, total_pages: 0, total_items: 0 };
  const items = data?.items || [];
  const groups = data?.groups || [];
  const rows = view === 'groups' ? groups : items;
  const notConfigured = data && data.configured === false;
  const summary = counts[audience] || counts.all || { success: 0, pending: 0, failed: 0 };
  const currentPage = pagination.page || page;

  const audienceTabs = [...AUDIENCE_TABS];
  const otherCount = view === 'groups' ? groupCounts.other || 0 : counts.other?.total || 0;
  if (otherCount > 0 || audience === 'other') audienceTabs.push({ value: 'other', label: '기타' });
  function audienceCount(value) {
    return view === 'groups' ? groupCounts[value] ?? 0 : counts[value]?.total ?? 0;
  }

  function changeView(next) {
    if (next === view) return;
    setView(next);
    setFilters((f) => keepFor(next, f, false));
    setPage(1);
    setSelected(null);
  }
  function changeAudience(next) {
    setAudience(next);
    setFilters((f) => keepFor(view, f, true));
    setPage(1);
    if (onAudienceChange) onAudienceChange(next);
  }
  function changeChannel(next) {
    if (next === channel) return;
    setChannel(next);
    setFilters((f) => keepFor(view, f, true));
    setPage(1);
    if (onChannelChange) onChannelChange(next);
  }
  function changeDate(value) {
    if (!value) return;
    setDate(value);
    setFilters((f) => keepFor(view, f, true));
    setPage(1);
  }
  function applyFilter(key, value) {
    if (key === 'date') { changeDate(value); return; }
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }
  function clearFilter(key) {
    setFilters((f) => {
      const next = { ...f };
      delete next[key];
      return next;
    });
    setPage(1);
  }
  function changePageSize(value) {
    setPageSize(Number(value));
    setPage(1);
  }
  function openGroup(groupId) {
    setView('messages');
    setFilters({ group_id: groupId });
    setPage(1);
  }
  function openMessage(item, rowEl) {
    rowRef.current = rowEl || null;
    setSelected(item);
  }
  function closeMessage() {
    setSelected(null);
    const el = rowRef.current;
    if (el && el.isConnected && typeof el.focus === 'function') el.focus();
  }

  const chips = CHIPS[view];
  const checked = clock(data?.checked_at);

  return (
    <section className="solapi-log" aria-label="쏠라피 발송내역">
      <div className="solapi-log-tabrow">
        <div className="solapi-log-pills" role="tablist" aria-label="보기 전환">
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
        <div className="solapi-log-pills solapi-log-pills--audience" role="tablist" aria-label="받는 사람 구분">
          {audienceTabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={audience === tab.value}
              onClick={() => changeAudience(tab.value)}
            >
              {tab.label}
              <span className="solapi-log-badge">{audienceCount(tab.value)}</span>
            </button>
          ))}
        </div>
        <div className="solapi-log-pills solapi-log-pills--channel" role="tablist" aria-label="메시지 종류 구분">
          {CHANNEL_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={channel === tab.value}
              onClick={() => changeChannel(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="solapi-log-notice" role="status" aria-live="polite" aria-atomic="true">
        <p>
          쏠라피 발송 기록 · {date} 하루(한국시간) · 수신번호 가운데와 본문 속 링크·전화번호는 가림
          {checked ? ` · 확인 ${checked}` : ''}
        </p>
        <p>쏠라피에 닿기 전에 멈춘 문자(키 미설정·시험 기록·요청 실패)는 이 탭에 없고 &apos;고객 문자 관리&apos;·&apos;직원 문자 관리&apos; 메뉴에 있습니다.</p>
        {data?.partial ? <p className="solapi-log-notice__warn">건수가 많아 1,500건까지만 표시합니다(일부 누락).</p> : null}
        {notConfigured ? <p className="solapi-log-notice__warn">쏠라피 키가 설정되지 않아 조회할 수 없습니다.</p> : null}
        {data?.groups_partial ? <p className="solapi-log-notice__warn">쏠라피 요청 목록을 일부만 불러왔습니다(조회 실패 또는 건수 많음). 상태·타입이 비어 있는 줄이 있을 수 있습니다.</p> : null}
      </div>

      <div className="solapi-log-chips" role="group" aria-label="필터">
        <span className="solapi-log-funnel" aria-hidden="true">▼</span>
        {chips.map((chip) => {
          const options = chip.dynamic === 'types'
            ? (data?.types || []).map((t) => ({ value: t.type, label: `${t.type} (${t.count})` }))
            : chip.dynamic === 'senders'
              ? (data?.senders || []).map((s) => ({ value: s.from, label: `${s.from} (${s.count})` }))
              : chip.options || [];
          return (
            <FilterChip
              key={`${view}-${chip.key}`}
              chip={chip}
              value={chip.key === 'date' ? date : filters[chip.key] || ''}
              options={options}
              onApply={applyFilter}
              onClear={clearFilter}
            />
          );
        })}
        {[['오늘', 0], ['어제', 1]].map(([label, back]) => (
          <button key={label} type="button" className={`solapi-log-day${date === dayBeforeKst(back) ? ' is-active' : ''}`} onClick={() => changeDate(dayBeforeKst(back))}>{label}</button>
        ))}
      </div>

      {view === 'messages' ? (
        <p className="solapi-log-maskbar">👁 수신번호·본문 일부가 가려져 있습니다</p>
      ) : null}

      <div className="solapi-log-card">
        <div className="solapi-log-toolbar">
          <button type="button" className="solapi-log-refresh" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
            <span aria-hidden="true">⟳ </span>새로고침
          </button>
          <div className="solapi-log-toolbar__right">
            <span className="solapi-log-summary" title="필터와 관계없이 이 날짜·구분의 전체 건수">
              하루 합계 · 성공 {summary.success} · 발송중 {summary.pending} · 실패 {summary.failed}
            </span>
            <label className="solapi-log-size">
              <span className="solapi-log-sr">쪽 크기</span>
              <select value={pageSize} onChange={(e) => changePageSize(e.target.value)} aria-label="쪽 크기">
                {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <nav className="solapi-log-pager" aria-label="쏠라피 발송내역 페이지">
              <span>{pagination.total_pages > 0 ? `${currentPage} / ${pagination.total_pages}` : '0 / 0'}</span>
              <button type="button" aria-label="이전 쪽" disabled={currentPage <= 1 || loading} onClick={() => setPage(currentPage - 1)}>‹</button>
              <button type="button" aria-label="다음 쪽" disabled={currentPage >= pagination.total_pages || loading} onClick={() => setPage(currentPage + 1)}>›</button>
            </nav>
          </div>
        </div>

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
            <strong>{loading ? '불러오는 중' : '조회된 내역이 없습니다'}</strong>
            <span>{date} 기준으로 조회했습니다.</span>
          </div>
        ) : view === 'groups' ? (
          <SolapiGroupTable groups={groups} checkedAt={data?.checked_at} onOpenGroup={openGroup} />
        ) : (
          <SolapiMessageTable items={items} onOpen={openMessage} />
        )}
      </div>

      {selected ? (
        <SolapiMessageDetail
          item={selected}
          group={data?.group_map?.[selected.group_id] || null}
          checkedAt={data?.checked_at}
          onClose={closeMessage}
        />
      ) : null}
    </section>
  );
}
