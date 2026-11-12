import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchNotificationOverview } from '../../api/notificationOverview.js';
import {
  buildSmsItems, defaultSmsFilter, filterSmsItems, smsBadges, smsPills, sortSmsItems,
} from './smsTemplateListModel.js';
import './KakaoTemplateManager.css';

// 문자 템플릿: 자동 문자 문구 카탈로그를 카드로 보여 준다(조회만).
export default function SmsTemplateList({ active }) {
  const [state, setState] = useState({ loaded: false, error: '', items: [] });
  const [picked, setPicked] = useState(null);
  const [openId, setOpenId] = useState('');
  const startedRef = useRef(false);

  const load = () => {
    setState((prev) => ({ ...prev, error: '' }));
    fetchNotificationOverview()
      .then((data) => setState({ loaded: true, error: '', items: sortSmsItems(buildSmsItems(data)) }))
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
  const visible = useMemo(() => filterSmsItems(items, filter), [items, filter]);

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
        {visible.length === 0 ? <div className="ktm-empty">조건에 맞는 문자 템플릿이 없습니다.</div> : (
          <ul className="ktm-cards">
            {visible.map((item) => (
              <li key={item.id} className={`ktm-card${openId === item.id ? ' is-selected' : ''}`}>
                <button type="button" className="ktm-card-main" aria-expanded={openId === item.id} onClick={() => setOpenId(openId === item.id ? '' : item.id)}>
                  <span className="ktm-card-name">{item.name}</span>
                  <span className="ktm-card-meta">
                    <span className="ktm-chip">{item.audience.label}</span>
                    <span>{item.trigger}</span>
                  </span>
                  <span className="ktm-card-badges">
                    {smsBadges(item).map((badge) => <span key={badge.text} className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span>)}
                  </span>
                  {openId === item.id && item.example ? (
                    <span style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, paddingTop: 6 }}>{item.example.text}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
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
