import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchNotificationOverview } from '../../api/notificationOverview.js';
import { fetchSmsConsole } from '../../api/smsConsole.js';
import { fetchInternalNotifications } from '../../api/internalNotifications.js';
import { getKstToday } from '../../utils/dateUtils.js';
import {
  audienceSections, buildKindedItems, conditionLine, defaultSmsFilter, kindBadges, smsBadges, smsPills, sortSmsItems,
} from './smsTemplateListModel.js';
import './KakaoTemplateManager.css';

// 문자 템플릿: 자동 문자 문구 카탈로그를 카드로 보여 준다(조회만).
export default function SmsTemplateList({ active }) {
  const [state, setState] = useState({ loaded: false, error: '', items: [] });
  const [recipients, setRecipients] = useState(null); // 직원 문자 관리의 등록 직원(못 받으면 null — 조건만 보임)
  const [picked, setPicked] = useState(null);
  const [openId, setOpenId] = useState('');
  const startedRef = useRef(false);

  const load = () => {
    setState((prev) => ({ ...prev, error: '' }));
    // 보낸 묶음(sent)은 못 불러와도 카탈로그 카드는 그대로 보인다
    fetchInternalNotifications({ view: 'day', date: getKstToday() }).then((res) => setRecipients(Array.isArray(res?.recipients) ? res.recipients : null)).catch(() => setRecipients(null));
    Promise.all([fetchNotificationOverview(), fetchSmsConsole('sent').catch(() => null)])
      .then(([data, sent]) => setState({ loaded: true, error: '', items: sortSmsItems(buildKindedItems(data, sent && Array.isArray(sent.groups) ? sent.groups : null)) }))
      .catch((err) => setState({ loaded: true, error: err.message || '불러오지 못했습니다.', items: [] }));
  };
  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    load();
  }, [active]);

  const { items } = state;
  const pills = useMemo(() => smsPills(items), [items]);
  const filter = picked ?? defaultSmsFilter(items);
  const sections = useMemo(() => audienceSections(items, filter), [items, filter]);

  let body;
  if (!state.loaded) body = <div className="ktm-empty">불러오는 중…</div>;
  else if (state.error) {
    body = (
      <div className="ktm-error" role="alert">
        <p>문자 템플릿을 불러오지 못했습니다.</p>
        <p className="ktm-error-detail">{state.error}</p>
        <button type="button" className="ktm-btn" onClick={load}>다시 불러오기</button>
      </div>
    );
  } else {
    body = (
      <>
        <div className="ktm-pills" role="group" aria-label="발송 상태 거르기">
          {pills.map((pill) => (
            <button type="button" key={pill.id} className={`ktm-pill${filter === pill.id ? ' is-active' : ''}`} aria-pressed={filter === pill.id} onClick={() => setPicked(pill.id)}>
              {pill.label} {pill.count}
            </button>
          ))}
        </div>
        {sections.length === 0 ? <div className="ktm-empty">조건에 맞는 문자 템플릿이 없습니다.</div> : sections.map((aud) => (
          <section key={aud.group} className="ktm-aud" aria-label={aud.group}>
            <h3 className="ktm-kind-head ktm-kind-head--aud">{aud.group} <span className="ktm-kind-count">{aud.count}</span></h3>
            {aud.kinds.map((section) => (
              <section key={section.kind || aud.group} className="ktm-kind" aria-label={section.kind || aud.group}>
                {section.kind ? <h3 className="ktm-kind-head">{section.kind} <span className="ktm-kind-count">{section.items.length}</span></h3> : null}
                <ul className="ktm-cards">
                  {section.items.map((item) => {
                    const expandable = Boolean(item.body || item.image || (item.external && (item.trigger || item.scenario)));
                    const line = conditionLine(item, recipients);
                    return (
                      <li key={item.id} className={`ktm-card${openId === item.id ? ' is-selected' : ''}`}>
                        <button type="button" className="ktm-card-main" aria-expanded={openId === item.id} onClick={() => setOpenId(openId === item.id ? '' : item.id)}>
                          <span className="ktm-card-name">{item.name}</span>
                          <span className="ktm-card-meta">
                            <span className="ktm-chip">{item.audience.label}</span>
                            <span className="ktm-chip ktm-chip--sender">{item.sender}</span>
                            {item.channel ? <span className="ktm-chan">{item.channel}</span> : null}
                            {line ? <span>{line}</span> : null}
                          </span>
                          <span className="ktm-card-badges">
                            {[...smsBadges(item), ...kindBadges(item)].map((badge) => <span key={badge.text} className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span>)}
                          </span>
                          {openId === item.id && expandable ? (
                            <span className="ktm-open">
                              {item.external && item.trigger ? <span className="ktm-open-line"><b>언제 나가나</b> {item.trigger}</span> : null}
                              {item.scenario ? <span className="ktm-open-line"><b>{item.sender === '메이크' ? '메이크 시나리오' : '자동화 이름'}</b> {item.scenario}</span> : null}
                              {item.image ? <img className="ktm-open-img" src={item.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
                              {item.body ? <span className="ktm-open-body">{item.body}</span> : null}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </section>
        ))}
      </>
    );
  }

  return (
    <div className="ktm-root" hidden={!active}>
      <div className="ktm-header"><h2 className="ktm-title">문자 템플릿</h2></div>
      {body}
    </div>
  );
}
