import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchInternalNotifications } from '../api/internalNotifications';
import { formatProcessCompletionTime, getKstToday } from '../utils/dateUtils';
import { phoneTail, recipientWithPhoneTail } from '../utils/phoneTail';
import { staffHistoryCategory } from './notificationOverviewPresentation';
import { customerChannelBadge } from './customerSmsPresentation';
import './StaffSmsPanel.css';

// 직원 문자 관리 발송내역(2026-11-11 사장님 결정): 안내 문구·요약 칸·쪽 넘김 없이 미니멀하게.
// 문자를 받도록 등록된 직원 이름 (끝 4자리)을 누르면 그날 그 사람에게 간 문자, [전체보기]는 그날 전체를 발송 순서(먼저 보낸 것 위)로.

// 2026-11-11 사장님 "발송된 날짜가 떠야" — 줄마다 시각만이 아니라 발송 날짜+시각(KST, 예: 11/11 08:40).
function shiftYmd(ymd, deltaDays) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!match) return getKstToday();
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + deltaDays));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatSentAt(value) {
  return formatProcessCompletionTime(value) || '날짜 미확인';
}

function sentOrder(left, right) {
  const leftTime = new Date(left?.sent_at).getTime();
  const rightTime = new Date(right?.sent_at).getTime();
  const safeLeft = Number.isNaN(leftTime) ? Number.POSITIVE_INFINITY : leftTime;
  const safeRight = Number.isNaN(rightTime) ? Number.POSITIVE_INFINITY : rightTime;
  return safeLeft - safeRight || (Number(left?.id) || 0) - (Number(right?.id) || 0);
}

// 성공·확인 중은 아무 표시도 하지 않고, 실패·시험 기록만 작은 점 + 짧은 글자(실패·시험)로 알린다.
function problemOf(item) {
  if (item?.status === 'dry_run') return { tone: 'test', short: '시험', label: '시험 기록' };
  if (item?.status !== 'success' || item?.delivery?.state === 'failed') {
    return { tone: 'failed', short: '실패', label: item?.delivery?.label || '발송 요청 실패' };
  }
  return null;
}

export default function StaffSmsPanel({ active = true }) {
  const today = getKstToday();
  const [date, setDate] = useState(today);
  const [selected, setSelected] = useState('');
  const [selectedCat, setSelectedCat] = useState('');
  const [items, setItems] = useState([]);
  const [recipients, setRecipients] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('loading');
  const [expandedId, setExpandedId] = useState(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus('loading');
    try {
      const data = await fetchInternalNotifications({ view: 'day', date });
      if (requestId !== requestIdRef.current) return;
      setItems(Array.isArray(data?.items) ? [...data.items].sort(sentOrder) : []);
      setRecipients(Array.isArray(data?.recipients) ? data.recipients : []);
      setTruncated(Boolean(data?.truncated));
      setStatus('ready');
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus('error');
    }
  }, [date]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  // 등록된 직원은 그날 0건이어도 모두 보이고, 명단 밖 이름으로 간 문자가 있으면 버튼을 덧붙인다.
  const people = useMemo(() => {
    const counts = new Map();
    for (const item of items) counts.set(item.recipient_name, (counts.get(item.recipient_name) || 0) + 1);
    const list = recipients.map(person => ({
      name: person.name,
      tail: person.phone_tail || '',
      count: counts.get(person.name) || 0,
    }));
    const known = new Set(list.map(person => person.name));
    for (const item of items) {
      if (known.has(item.recipient_name)) continue;
      known.add(item.recipient_name);
      list.push({ name: item.recipient_name, tail: phoneTail(item.phone), count: counts.get(item.recipient_name) || 0 });
    }
    return list;
  }, [items, recipients]);

  const byPerson = useMemo(
    () => (selected ? items.filter(item => item.recipient_name === selected) : items),
    [items, selected],
  );
  const categories = useMemo(() => {
    const map = new Map();
    for (const item of byPerson) {
      const cat = staffHistoryCategory(item);
      const cur = map.get(cat.key);
      if (cur) cur.count += 1;
      else map.set(cat.key, { ...cat, count: 1 });
    }
    return [...map.values()].sort((a, b) => a.order - b.order);
  }, [byPerson]);
  const shown = useMemo(
    () => (selectedCat ? byPerson.filter(item => staffHistoryCategory(item).key === selectedCat) : byPerson),
    [byPerson, selectedCat],
  );
  const selectedPerson = people.find(person => person.name === selected);

  const choose = name => {
    setSelected(name);
    setSelectedCat('');
    setExpandedId(null);
  };
  const changeDate = value => {
    if (!value) return;
    setDate(value);
    setSelectedCat('');
    setExpandedId(null);
    // 등록된 직원을 골라 둔 채면 다른 날도 그 사람으로, 명단 밖 이름이면 전체보기로 돌아간다
    if (selected && !recipients.some(person => person.name === selected)) setSelected('');
  };

  return (
    <div className="staff-sms" data-staff-sms>
      <div className="staff-sms__head">
        <h2 id="sms-history-title">직원 발송 내역</h2>
        <div className="staff-sms__date">
          <button
            type="button"
            className="staff-sms__day-btn"
            aria-label="이전 날짜"
            onClick={() => changeDate(shiftYmd(date, -1))}
          >‹</button>
          <input
            type="date"
            aria-label="발송 날짜"
            value={date}
            max={today}
            onChange={event => changeDate(event.target.value)}
          />
          <button
            type="button"
            className="staff-sms__day-btn"
            aria-label="다음 날짜"
            disabled={date >= today}
            onClick={() => {
              const next = shiftYmd(date, 1);
              changeDate(next > today ? today : next);
            }}
          >›</button>
          <button type="button" disabled={date === today} onClick={() => changeDate(today)}>
            오늘
          </button>
        </div>
      </div>

      <div className="staff-sms__people" role="group" aria-label="받는 사람">
        <button type="button" aria-pressed={selected === ''} onClick={() => choose('')}>
          <span>전체보기</span>
          <span className="staff-sms__count">{status === 'ready' ? items.length : '-'}</span>
        </button>
        {people.map(person => (
          <button
            type="button"
            key={person.name}
            className={status === 'ready' && person.count === 0 ? 'is-empty' : undefined}
            aria-pressed={selected === person.name}
            onClick={() => choose(person.name)}
          >
            {/* 이름 (4237) — 칸이 좁으면 이름 다음에서만 줄을 바꾼다 */}
            <span className="staff-sms__who">
              <span>{person.name}</span>
              {person.tail && <span>({person.tail})</span>}
            </span>
            <span className="staff-sms__count">{status === 'ready' ? person.count : '-'}</span>
          </button>
        ))}
      </div>

      {status === 'ready' && categories.length >= 2 && (
        <div className="staff-sms__cats" role="group" aria-label="알림 종류별 보기">
          <button
            type="button"
            className="staff-sms__catpill"
            aria-pressed={selectedCat === ''}
            onClick={() => { setSelectedCat(''); setExpandedId(null); }}
          >
            전체 {byPerson.length}
          </button>
          {categories.map(cat => (
            <button
              key={cat.key}
              type="button"
              className={`staff-sms__catpill staff-sms__catpill--${cat.tone}`}
              aria-pressed={selectedCat === cat.key}
              onClick={() => { setSelectedCat(selectedCat === cat.key ? '' : cat.key); setExpandedId(null); }}
            >
              {cat.label} {cat.count}
            </button>
          ))}
        </div>
      )}

      <div className="sms-history-list-scroll staff-sms__scroll" data-history-scroll aria-label="문자 발송 기록" tabIndex={0}>
        {status === 'loading' && (
          <div className="sms-history-state" role="status" aria-live="polite">
            <span className="sms-history-spinner" aria-hidden="true" />
            불러오는 중입니다.
          </div>
        )}

        {status === 'error' && (
          <div className="sms-history-state sms-history-state--error" role="alert">
            <strong>발송내역을 불러오지 못했습니다.</strong>
            <button type="button" onClick={load}>다시 불러오기</button>
          </div>
        )}

        {status === 'ready' && shown.length === 0 && (
          <div className="sms-history-state" role="status">
            <strong>
              {selected
                ? `이 날 ${recipientWithPhoneTail(selected, selectedPerson?.tail)}님에게 보낸 문자가 없습니다.`
                : '이 날 보낸 직원 문자가 없습니다.'}
            </strong>
          </div>
        )}

        {status === 'ready' && truncated && (
          <p className="staff-sms__note" role="status">이 날 기록이 많아 먼저 보낸 300건만 보여 줍니다.</p>
        )}

        {status === 'ready' && shown.length > 0 && (
          <ol className="staff-sms__list">
            {shown.map(item => {
              const problem = problemOf(item);
              const isExpanded = expandedId === item.id;
              const bodyId = `staff-sms-body-${item.id}`;
              const cat = staffHistoryCategory(item);
              const chBadge = item.channel ? customerChannelBadge(item.channel) : null;
              const toggleRow = () => setExpandedId(isExpanded ? null : item.id);
              return (
                <li className={`staff-sms__item staff-sms__item--${cat.tone}${isExpanded ? ' is-open' : ''}`} key={item.id}>
                  <div className="staff-sms__row-trigger" onClick={toggleRow}>
                    <div className="staff-sms__line">
                      <time dateTime={item.sent_at || undefined}>{formatSentAt(item.sent_at)}</time>
                      <span className={`staff-sms__cat staff-sms__cat--${cat.tone}`}>{cat.label}</span>
                      {chBadge && <span className={`staff-sms__ch is-${chBadge.tone}`}>{chBadge.label}</span>}
                      {!selected && <strong>{recipientWithPhoneTail(item.recipient_name, item.phone)}</strong>}
                      {problem && (
                        <span className={`staff-sms__flag staff-sms__flag--${problem.tone}`} title={problem.label}>
                          <span className={`staff-sms__dot staff-sms__dot--${problem.tone}`} aria-hidden="true" />
                          {problem.short}
                        </span>
                      )}
                    </div>
                    <h3>{item.subject || '제목 저장 전 기록'}</h3>
                    <button
                      type="button"
                      className="sms-history-disclosure"
                      aria-expanded={isExpanded}
                      aria-controls={bodyId}
                      onClick={(event) => { event.stopPropagation(); toggleRow(); }}
                    >
                      <span>{isExpanded ? '접기' : '내용'}</span>
                      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="m6 9 6 6 6-6" />
                      </svg>
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="sms-history-body" id={bodyId}>
                      {item.text || '내용 저장 전 기록'}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
