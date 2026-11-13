import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchNotificationOverview } from '../../api/notificationOverview.js';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { fetchInternalNotifications } from '../../api/internalNotifications.js';
import { getKstToday } from '../../utils/dateUtils.js';
import {
  CONDITION_GROUPS, audienceSections, buildKindedItems, conditionGroup, conditionLine, defaultSmsFilter, kindBadges, paginateRows, smsBadges, smsPills, sortByNameNumeric, sortSmsItems,
} from './smsTemplateListModel.js';
import { autoConditionLine, autoConditionParts, autoStatusLine, ensureAutoSection, formInitialFromItem, imageUrlsFromItem, myTextSection, photoBadgeText } from './smsTextTemplateFormModel.js';
import SmsModal from './SmsModal.jsx';
import SmsTextTemplateForm from './SmsTextTemplateForm.jsx';
import SmsAutoControls from './SmsAutoControls.jsx';
import SmsOptoutRow from './SmsOptoutRow.jsx';
import './KakaoTemplateManager.css';
import './SmsAutoControls.css';
import './SmsTemplateList.css';

// 문자 템플릿: 자동 문자 문구 카탈로그를 카드로 보여 준다(조회만).
export default function SmsTemplateList({ active, onSendText, openNew, onNewHandled }) {
  const [state, setState] = useState({ loaded: false, error: '', items: [] });
  const [recipients, setRecipients] = useState(null); // 직원 문자 관리의 등록 직원(못 받으면 null — 조건만 보임)
  const [picked, setPicked] = useState(null);
  const [openId, setOpenId] = useState('');
  const startedRef = useRef(false);
  const [mine, setMine] = useState([]); // 내 문구(저장된 문자 문구). 목록에는 사진 본문 없이 has_image 만 온다
  const [mineOpen, setMineOpen] = useState('');
  const [minePhoto, setMinePhoto] = useState({}); // 펼친 문구의 사진(단건 조회)
  const [mineConfirm, setMineConfirm] = useState('');
  const [mineError, setMineError] = useState('');
  const [pageNo, setPageNo] = useState(1); // 목록은 10행씩 쪽으로 나눈다
  const [cond, setCond] = useState(''); // 발송 조건 거르기('' = 전체)

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

  // 내 문구는 화면이 열릴 때마다 가볍게 다시 읽는다(방금 등록한 문구가 바로 보이게)
  const [autoStatus, setAutoStatus] = useState({}); // 자동 발송 문구별 현황(resource=auto_status)
  const loadStatus = (id) => fetchSmsConsole('auto_status', { id }).then((res) => setAutoStatus((prev) => ({ ...prev, [id]: res }))).catch(() => {});
  const loadMine = () => fetchSmsConsole('text_templates').then((res) => {
    const items = Array.isArray(res?.items) ? res.items : [];
    setMine(items);
    items.filter((item) => item.auto_kind).forEach((item) => loadStatus(item.id));
  }).catch(() => {});
  useEffect(() => {
    if (!active) return;
    loadMine();
  }, [active]);
  const [adding, setAdding] = useState(false); // 이 화면 안에서 문자 템플릿 새로 등록
  const openMine = (entry) => {
    const next = mineOpen === entry.id ? '' : entry.id;
    setMineOpen(next); setMineConfirm(''); setMineError('');
    if (next && entry.hasImage && !minePhoto[entry.id]) {
      fetchSmsConsole('text_template', { id: entry.id }).then((res) => {
        const urls = imageUrlsFromItem(res?.item);
        if (urls.length) setMinePhoto((prev) => ({ ...prev, [entry.id]: urls }));
      }).catch(() => {});
    }
  };
  // 옛 주소(mode=new&kind=sms)로 들어오면 등록 팝업을 연 채로 보여 준다
  useEffect(() => { if (active && openNew) { setAdding(true); onNewHandled?.(); } }, [active, openNew]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editInit, setEditInit] = useState(null); // 고치는 문구의 양식 초기값(단건 조회)
  const editMine = (entry) => {
    setMineError('');
    fetchSmsConsole('text_template', { id: entry.id }).then((res) => {
      setEditInit(formInitialFromItem(res?.item));
      setAdding(true);
    }).catch((err) => setMineError(err.message || '불러오지 못했습니다.'));
  };
  const closeForm = () => { setAdding(false); setEditInit(null); loadMine(); };
  const deleteMine = async (entry) => {
    if (mineConfirm !== entry.id) { setMineConfirm(entry.id); return; }
    setMineError('');
    try {
      await postSmsConsole('text_template_delete', { id: entry.id });
      setMine((prev) => prev.filter((item) => item.id !== entry.id));
      setMineConfirm(''); setMineOpen('');
    } catch (err) { setMineError(err.message || '지우지 못했습니다.'); }
  };
  const mySection = useMemo(() => myTextSection(mine), [mine]);
  // 내 문구 카드. 켜진 자동 문구는 '발송 중' 묶음에도 같은 카드로 보인다(그래서 함수로 둔다)
  const renderMine = (entry, prefix = '') => (
    <li key={`${prefix}${entry.id}`} className={`ktm-card stl-row${mineOpen === entry.id ? ' is-selected' : ''}`}>
      <button type="button" className="ktm-card-main" aria-expanded={mineOpen === entry.id} onClick={() => openMine(entry)}>
        <span className="ktm-card-name">{entry.name}</span>
        {entry.autoKind ? (() => {
          const cp = autoConditionParts(entry);
          return (
            <span className="ktm-card-meta stl-cond" title={autoConditionLine(entry)}>
              <span className="stl-when">{cp.when}</span>
              {cp.who ? <span className={`ktm-chip stl-who ${cp.who === '고객' ? 'stl-who--cust' : (cp.who === '영업담당' ? 'stl-who--sales' : 'stl-who--staff')}`}>{cp.who}</span> : null}
              {cp.via ? <span className="ktm-chip stl-via">{cp.via}</span> : null}
              {cp.extras.length ? <span className="stl-extras">{cp.extras.join(' · ')}</span> : null}
            </span>
          );
        })() : <span className="ktm-card-meta"><span>{entry.preview}</span></span>}
        {entry.hasImage ? <span className="ktm-card-badges"><span className="ktm-badge ktm-badge--muted">{photoBadgeText(entry)}</span></span> : null}
        {mineOpen === entry.id ? (
          <span className="ktm-open">
            {entry.autoKind ? <span className="stl-open-cond">{autoConditionLine(entry)}</span> : null}
            {entry.autoKind && autoStatus[entry.id] ? <span className="sac-status">{autoStatusLine(autoStatus[entry.id])}</span> : null}
            {(minePhoto[entry.id] || []).map((url, index, all) => <img key={index} className={all.length > 1 ? 'ktm-open-img sac-thumb' : 'ktm-open-img'} src={url} alt="" />)}
            <span className="ktm-open-body">{(mine.find((item) => item.id === entry.id) || {}).body}</span>
          </span>
        ) : null}
      </button>
      {entry.autoKind ? <SmsAutoControls id={entry.id} enabled={Boolean(autoStatus[entry.id]?.enabled ?? entry.autoEnabled)} photos={entry.imageCount} onChanged={() => { loadMine(); }}><button type="button" className="ktm-btn" onClick={() => editMine(entry)}>수정</button></SmsAutoControls> : null}
      {mineOpen === entry.id ? (
        <div className="ktm-modal-actions">
          {entry.autoKind ? null : <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => onSendText?.(entry.id)}>이 문구로 보내기</button>}
          {entry.autoKind ? null : <button type="button" className="ktm-btn" onClick={() => editMine(entry)}>수정</button>}
          <button type="button" className="ktm-btn" onClick={() => deleteMine(entry)}>{mineConfirm === entry.id ? '삭제 확인' : '삭제'}</button>
        </div>
      ) : null}
    </li>
  );

  const { items } = state;
  const allMine = useMemo(() => sortByNameNumeric(mySection ? mySection.items : []), [mySection]);
  const sortedMine = useMemo(() => allMine.filter((row) => !cond || conditionGroup(row) === cond), [allMine, cond]);
  // 탭 숫자는 조건 거르기와 상관없이 전체 기준
  const runningAll = useMemo(() => allMine.filter((entry) => entry.autoKind && (autoStatus[entry.id]?.enabled ?? entry.autoEnabled)).length, [allMine, autoStatus]);
  const condItems = useMemo(() => (cond ? items.filter((item) => conditionGroup(item) === cond) : items), [items, cond]);
  const runningAutos = useMemo(() => sortedMine.filter((entry) => entry.autoKind && (autoStatus[entry.id]?.enabled ?? entry.autoEnabled)), [sortedMine, autoStatus]);
  // '발송 중' 숫자에는 켜진 내 자동 문구도 센다(표의 총 건수와 같게)
  const pills = useMemo(() => [...smsPills(items).map((pill) => (pill.id === 'in_use' ? { ...pill, count: pill.count + runningAll } : pill)), ...(mySection ? [{ id: 'mine', label: '내 문구', count: mySection.count }] : [])], [items, mySection, runningAll]);
  const rawTab = picked ?? defaultSmsFilter(items);
  const tab = rawTab === 'mine' && !mySection ? defaultSmsFilter(items) : rawTab;
  const isMineTab = tab === 'mine';
  const filter = isMineTab ? 'all' : tab;
  const shownAutos = filter === 'in_use' ? runningAutos : [];
  const sections = useMemo(() => ensureAutoSection(audienceSections(condItems, filter), shownAutos.length), [condItems, filter, shownAutos.length]);

  // 쪽 나누기는 선택한 탭의 행에만 적용한다
  const rowKeys = useMemo(() => {
    if (isMineTab) return sortedMine.map((entry) => `m-${entry.id}`);
    const keys = [];
    sections.forEach((aud) => aud.kinds.forEach((section) => {
      if (aud.group === '고객' && section.kind === '이벤트·혜택') shownAutos.forEach((entry) => keys.push(`run-${entry.id}`));
      section.items.forEach((item) => keys.push(`i-${item.id}`));
    }));
    return keys;
  }, [isMineTab, sortedMine, sections, shownAutos]);
  const paged = paginateRows(rowKeys, pageNo);
  const pageSet = new Set(paged.rows);
  const pickCond = (value) => { setCond(value); setPageNo(1); setOpenId(''); setMineOpen(''); setMineConfirm(''); };
  const pickFilter = (id) => { setPicked(id); setPageNo(1); setOpenId(''); setMineOpen(''); };
  const goPage = (next) => { setPageNo(next); setOpenId(''); setMineOpen(''); setMineConfirm(''); };
  const kindHasRow = (aud, section) => section.items.some((item) => pageSet.has(`i-${item.id}`))
    || (aud.group === '고객' && section.kind === '이벤트·혜택' && shownAutos.some((entry) => pageSet.has(`run-${entry.id}`)));

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
        {mineError ? <p className="ktm-alert" role="alert">{mineError}</p> : null}
        <div className="stl-tabs">
          <div className="ktm-pills" role="group" aria-label="발송 상태 거르기">
            {pills.map((pill) => (
              <button type="button" key={pill.id} className={`ktm-pill${tab === pill.id ? ' is-active' : ''}`} aria-pressed={tab === pill.id} onClick={() => pickFilter(pill.id)}>
                {pill.label} {pill.count}
              </button>
            ))}
          </div>
          <span className="stl-right">
            <select className="stl-cond-select" aria-label="발송 조건" value={cond} onChange={(event) => pickCond(event.target.value)}>
              <option value="">조건 전체</option>
              {CONDITION_GROUPS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <span className="stl-total">{paged.pages > 1 ? `총 ${rowKeys.length}건 · ${paged.page}/${paged.pages}쪽` : `총 ${rowKeys.length}건`}</span>
          </span>
        </div>
        <div className="stl-table">
          <div className="stl-cols" aria-hidden="true"><span>템플릿 이름</span><span>발송 조건</span><span>상태</span><span>관리</span></div>
          {isMineTab ? (
            <ul className="ktm-cards">
              {sortedMine.filter((entry) => pageSet.has(`m-${entry.id}`)).map((entry) => renderMine(entry))}
            </ul>
          ) : sections.length === 0 ? <div className="ktm-empty">조건에 맞는 문자 템플릿이 없습니다.</div> : sections.filter((aud) => aud.kinds.some((section) => kindHasRow(aud, section))).map((aud) => (
            aud.kinds.filter((section) => kindHasRow(aud, section)).map((section) => (
              <section key={`${aud.group}/${section.kind || ''}`} className="stl-group" aria-label={section.kind || aud.group}>
                <h3 className="stl-grouphead">
                  {section.kind ? `${aud.group} › ${section.kind}` : aud.group}{' '}
                  <span className="ktm-kind-count">{section.kind ? section.items.length + (aud.group === '고객' && section.kind === '이벤트·혜택' ? shownAutos.length : 0) : aud.count}</span>
                </h3>
                <ul className="ktm-cards">
                  {aud.group === '고객' && section.kind === '이벤트·혜택' ? shownAutos.filter((entry) => pageSet.has(`run-${entry.id}`)).map((entry) => renderMine(entry, 'run-')) : null}
                  {section.items.filter((item) => pageSet.has(`i-${item.id}`)).map((item) => {
                    const expandable = Boolean(item.body || item.image || (item.external && (item.trigger || item.scenario)));
                    const line = conditionLine(item, recipients);
                    return (
                      <li key={item.id} className={`ktm-card stl-row${openId === item.id ? ' is-selected' : ''}`}>
                        <button type="button" className={`ktm-card-main${expandable ? '' : ' is-flat'}`} aria-expanded={openId === item.id} onClick={() => setOpenId(openId === item.id ? '' : item.id)}>
                          <span className="ktm-card-name">{item.name}</span>
                          <span className="ktm-card-meta" title={line || undefined}>
                            <span className="ktm-chip">{item.audience.label}</span>
                            <span className="ktm-chip ktm-chip--sender">{item.sender}</span>
                            {item.channel ? <span className="ktm-chan">{item.channel}</span> : null}
                            {line ? <span className="stl-line">{line}</span> : null}
                          </span>
                          <span className="ktm-card-badges">
                            {[...smsBadges(item), ...kindBadges(item)].map((badge) => <span key={badge.text} className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span>)}
                          </span>
                          {openId === item.id && expandable ? (
                            <span className="ktm-open">
                              {line ? <span className="stl-open-cond">{line}</span> : null}
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
            ))
          ))}
        </div>
        {paged.pages > 1 ? (
          <nav className="stl-pager" aria-label="쪽 이동">
            <button type="button" className="stl-page" disabled={paged.page <= 1} aria-label="이전 쪽" onClick={() => goPage(paged.page - 1)}>‹</button>
            {Array.from({ length: paged.pages }, (_, i) => i + 1).map((n) => (
              <button type="button" key={n} className={`stl-page${n === paged.page ? ' is-active' : ''}`} aria-current={n === paged.page ? 'page' : undefined} onClick={() => goPage(n)}>{n}</button>
            ))}
            <button type="button" className="stl-page" disabled={paged.page >= paged.pages} aria-label="다음 쪽" onClick={() => goPage(paged.page + 1)}>›</button>
          </nav>
        ) : null}
        <SmsOptoutRow active={active} />
      </>
    );
  }

  return (
    <div className="ktm-root stl-rows" hidden={!active}>
      <div className="ktm-header">
        <h2 className="ktm-title">문자 템플릿</h2>
        <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => setAdding(true)}>+ 템플릿 등록</button>
      </div>
      {body}
      {adding ? (
        <SmsModal title={editInit ? '문자 템플릿 수정' : '문자 템플릿 등록'} onClose={closeForm}>
          <SmsTextTemplateForm key={editInit?.id || 'new'} initial={editInit || undefined} onSend={(id) => onSendText?.(id)} onSaved={loadMine} onCancel={closeForm} />
        </SmsModal>
      ) : null}
    </div>
  );
}
