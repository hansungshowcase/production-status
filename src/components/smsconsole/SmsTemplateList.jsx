import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchNotificationOverview } from '../../api/notificationOverview.js';
import { clearSmsConsoleClientCache, fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { fetchInternalNotifications } from '../../api/internalNotifications.js';
import { getKstToday } from '../../utils/dateUtils.js';
import {
  CONDITION_GROUPS, buildConditionSummary, buildKindedItems, channelCostOf, compactLightLabel, conditionGroup, defaultSmsFilter, flowLightTone, flowStepText, formatLastSentLabel, groupFlows, isAttentionTone, isKakaoEntry, itemLight, matchesSmsQuery, paginateRows, smsDisplayCategory, smsPills, sortByNameNumeric, sortSmsItems, splitMessageVars,
} from './smsTemplateListModel.js';
import { SENDERS } from '../../../shared/smsTemplateKinds.js';
import { BMS_TEMPLATE_ID, catchupPausedText, cloneConditionInitial, autoConditionLine, autoConditionParts, autoTargetText, formInitialFromItem, imageUrlsFromItem, myTextSection, photoBadgeText, previewFill } from './smsTextTemplateFormModel.js';
import { autoEffective, autoLightClass } from '../../../shared/smsAutoEffective.js';
import SmsModal from './SmsModal.jsx';
// 바로 나가는 조건(주문 등록 시·공정 시작/완료 시·회원가입 시)은 단계를 더하면 같은 조건 문구가 둘이 되어 둘 다 발송된다 → 단계 추가를 두지 않는다
const FLOW_NO_STEP_KINDS = ['order_created', 'process_started', 'process_completed', 'member_joined'];
import SmsTextTemplateForm from './SmsTextTemplateForm.jsx';
import SmsAutoControls from './SmsAutoControls.jsx';
import SmsOptoutRow from './SmsOptoutRow.jsx';
import SmsChannelStatusStrip from './SmsChannelStatusStrip.jsx';
import './KakaoTemplateManager.css';
import './SmsAutoControls.css';
import './SmsTemplateList.css';

function SmsIcon({ name }) {
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>;
  if (name === 'back') return <svg {...common}><path d="M15 6l-6 6 6 6" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
  if (name === 'zoom') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /><path d="M11 8v6M8 11h6" /></svg>;
  return null;
}

const isDesktopViewport = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(min-width: 1024px)').matches
  : true);

const renderBodyContent = (text, filled) => {
  if (filled) return previewFill(text);
  return splitMessageVars(text).map((part, index) => (part.isVar
    ? <mark key={index} className="stl-var">{part.text}</mark>
    : <React.Fragment key={index}>{part.text}</React.Fragment>));
};

const plainKoreanText = (text) => String(text || '').replace(/멱등 발송/g, '중복 없이 1번 발송');

// 문자 템플릿: 왼쪽 목록 + 오른쪽 미리보기·관리(channel='sms').
// channel 'kakao': 알림톡 템플릿 화면 위에 끼워 넣는 모드(알림톡이 붙은 자동 발송 흐름만 그린다)
export default function SmsTemplateList({ active, onSendText, onOpenLog, openNew, onNewHandled, channel = 'sms', ataPreset = '', editPreset = '' }) {
  const isKakao = channel === 'kakao';
  const [state, setState] = useState({ loaded: false, error: '', items: [] });
  const [recipients, setRecipients] = useState(null); // 직원 문자 관리의 등록 직원(못 받으면 null — 조건만 보임)
  const [picked, setPicked] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(''); // 'm-<id>' | 'i-<id>'
  const startedRef = useRef(false);
  const loadReqRef = useRef(0);
  const [mine, setMine] = useState([]); // 내 문구(저장된 문자 문구). 목록에는 사진 본문 없이 has_image 만 온다
  const [mineLoaded, setMineLoaded] = useState(false);
  const [mineOpen, setMineOpen] = useState(''); // channel='kakao' 단계 펼침
  const [minePhoto, setMinePhoto] = useState({}); // 단건 조회한 사진 URL 목록
  const [minePhotoState, setMinePhotoState] = useState({}); // { [id]: 'loading' | 'loaded' | 'error' }
  const [extImgError, setExtImgError] = useState({}); // { [id]: boolean }
  const [tallImgMap, setTallImgMap] = useState({}); // { [key]: boolean }
  const [mineConfirm, setMineConfirm] = useState('');
  const [mineError, setMineError] = useState('');
  const [pageNo, setPageNo] = useState(1); // 목록은 10행씩 쪽으로 나눈다
  const [cond, setCond] = useState(''); // 발송 조건 거르기('' = 전체)
  const [issueFilter, setIssueFilter] = useState(''); // '' | 'catchup-paused' | 'off-blocked' | 'on-zero-send'
  const [copiedKey, setCopiedKey] = useState('');
  const [previewFilled, setPreviewFilled] = useState(false);
  const [expandedImg, setExpandedImg] = useState(false);

  // 이미지 원본 크기 보기 라이트박스
  const [lightbox, setLightbox] = useState(null); // { urls, index, title }
  const [lightboxFit, setLightboxFit] = useState('auto'); // 'auto' | 'width' | 'contain'
  const [lightboxDims, setLightboxDims] = useState(null); // { w, h }
  const lbFocusRef = useRef(null);
  const lbBackRef = useRef(null);

  const load = () => {
    const reqId = ++loadReqRef.current;
    setState((prev) => ({ ...prev, error: '' }));
    // 보낸 묶음(sent)은 7일 쏠라피 조회라 느릴 수 있어, 먼저 현황판을 그려 화면 대기를 없애고 뒤이어 건수를 합친다
    fetchInternalNotifications({ view: 'day', date: getKstToday() }).then((res) => setRecipients(Array.isArray(res?.recipients) ? res.recipients : null)).catch(() => setRecipients(null));
    const sentPromise = fetchSmsConsole('sent').catch(() => null);
    fetchNotificationOverview()
      .then((data) => {
        if (loadReqRef.current !== reqId) return;
        setState({ loaded: true, error: '', items: sortSmsItems(buildKindedItems(data, null)).filter((item) => item.kind !== '미분류') });
        sentPromise.then((sent) => {
          if (loadReqRef.current !== reqId || !sent || !Array.isArray(sent.groups)) return;
          setState({ loaded: true, error: '', items: sortSmsItems(buildKindedItems(data, sent.groups)).filter((item) => item.kind !== '미분류') });
        });
      })
      .catch((err) => {
        if (loadReqRef.current !== reqId) return;
        setState({ loaded: true, error: err.message || '불러오지 못했습니다.', items: [] });
      });
  };
  useEffect(() => {
    if (!active || startedRef.current || isKakao) return;
    startedRef.current = true;
    load();
  }, [active]);

  // 내 문구는 처음 열릴 때 한 번 묶어 읽고, 수정·켜기/끄기 뒤에는 새로 읽는다
  const [autoStatus, setAutoStatus] = useState({}); // 자동 발송 문구별 현황(resource=auto_status_batch)
  const loadMine = (force = false) => {
    if (force) clearSmsConsoleClientCache();
    return fetchSmsConsole('text_templates', {}, { bypassCache: force }).then((res) => {
      const items = Array.isArray(res?.items) ? res.items : [];
      setMine(items);
      const autoIds = items.filter((item) => item.auto_kind).map((item) => item.id);
      if (autoIds.length) {
        fetchSmsConsole('auto_status_batch', { ids: autoIds.join(',') }, { bypassCache: force })
          .then((batch) => {
            if (batch?.statuses && typeof batch.statuses === 'object') {
              setAutoStatus((prev) => ({ ...prev, ...batch.statuses }));
            }
          })
          .catch(() => {});
      }
    }).catch(() => {}).finally(() => setMineLoaded(true));
  };
  useEffect(() => {
    if (!active) return;
    loadMine();
  }, [active]);

  const ensureMinePhoto = (entry, force = false) => {
    if (!entry?.hasImage) return;
    if (!force && (minePhoto[entry.id]?.length || minePhotoState[entry.id] === 'loading')) return;
    setMinePhotoState((prev) => ({ ...prev, [entry.id]: 'loading' }));
    fetchSmsConsole('text_template', { id: entry.id }).then((res) => {
      const urls = imageUrlsFromItem(res?.item);
      if (urls.length) {
        setMinePhoto((prev) => ({ ...prev, [entry.id]: urls }));
        setMinePhotoState((prev) => ({ ...prev, [entry.id]: 'loaded' }));
      } else {
        setMinePhotoState((prev) => ({ ...prev, [entry.id]: 'error' }));
      }
    }).catch(() => {
      setMinePhotoState((prev) => ({ ...prev, [entry.id]: 'error' }));
    });
  };

  const [adding, setAdding] = useState(false); // 이 화면 안에서 문자 템플릿 새로 등록
  const openMine = (entry) => {
    const next = mineOpen === entry.id ? '' : entry.id;
    setMineOpen(next); setMineConfirm(''); setMineError('');
    if (next && entry.hasImage) ensureMinePhoto(entry);
  };
  // 옛 주소(mode=new&kind=sms)로 들어오면 등록 팝업을 연 채로 보여 준다
  // 알림톡 상세에서 들어오면(ata 주소) 출고 완료 후 + 그 알림톡이 골라진 새 등록 팝업을 연다(저장은 사장님이 직접)
  const [editInit, setEditInit] = useState(null); // 고치는 문구의 양식 초기값(단건 조회)
  const [formOpts, setFormOpts] = useState({}); // 같은 흐름의 문구(siblings)와 새 단계 여부(startNew)
  const pendingCreatedIdRef = useRef(null);
  useEffect(() => { if (active && openNew && editPreset) { editMine({ id: Number(editPreset) }); onNewHandled?.(); return; } if (active && openNew) { if (ataPreset) setEditInit({ id: undefined, autoKind: 'ship_plus_days', days: '2', ataTemplate: ataPreset }); setAdding(true); onNewHandled?.(); } }, [active, openNew]); // eslint-disable-line react-hooks/exhaustive-deps
  const loadInit = (id) => fetchSmsConsole('text_template', { id }).then((res) => formInitialFromItem(res?.item));
  const editMine = (entry, flow = null) => {
    setMineError('');
    const inits = flow && flow.steps.length ? Promise.all(flow.steps.map((step) => loadInit(step.id))) : null;
    Promise.all([loadInit(entry.id), inits]).then(([init, siblings]) => {
      setFormOpts(siblings ? { siblings, startNew: false } : {});
      setEditInit(init);
      setAdding(true);
    }).catch((err) => setMineError(err.message || '불러오지 못했습니다.'));
  };
  // 흐름에 새 단계 추가: 마지막 단계의 조건을 복사하고 이름·내용·사진은 비운 채 새 문구로 연다
  const addStep = (flow) => {
    setMineError('');
    Promise.all(flow.steps.map((step) => loadInit(step.id))).then((siblings) => {
      const last = siblings[siblings.length - 1];
      setFormOpts({ siblings, startNew: true });
      setEditInit({ ...last, id: undefined, name: '', body: '', images: [] });
      setAdding(true);
    }).catch((err) => setMineError(err.message || '불러오지 못했습니다.'));
  };
  // 같은 문구·사진·설정을 그대로 복사해 발송 조건(날짜·시점)만 추가한다
  const cloneMine = (entry) => {
    setMineError('');
    const existingNames = allMine.map((m) => m.name);
    loadInit(entry.id).then((init) => {
      setFormOpts({ siblings: undefined, startNew: false, cloneFromName: entry.name, existingNames });
      setEditInit(cloneConditionInitial(init, existingNames));
      setAdding(true);
    }).catch((err) => setMineError(err.message || '불러오지 못했습니다.'));
  };
  const closeForm = () => {
    setAdding(false); setEditInit(null); setFormOpts({});
    setMinePhoto({}); setMinePhotoState({});
    loadMine(true);
  };
  const deleteMine = async (entry) => {
    if (mineConfirm !== entry.id) { setMineConfirm(entry.id); return; }
    setMineError('');
    try {
      await postSmsConsole('text_template_delete', { id: entry.id });
      setMine((prev) => prev.filter((item) => item.id !== entry.id));
      setMineConfirm(''); setMineOpen('');
      if (selectedKey === `m-${entry.id}`) setSelectedKey('');
    } catch (err) { setMineError(err.message || '지우지 못했습니다.'); }
  };

  const openLightbox = (urls, index, title) => {
    if (!Array.isArray(urls) || !urls.length) return;
    lbBackRef.current = document.activeElement;
    setLightbox({ urls, index: Math.max(0, Math.min(urls.length - 1, index || 0)), title: title || '첨부 이미지' });
    setLightboxFit('auto');
    setLightboxDims(null);
  };
  const closeLightbox = () => {
    setLightbox(null);
    const back = lbBackRef.current;
    if (back && back.isConnected && typeof back.focus === 'function') back.focus();
  };
  useEffect(() => {
    if (!lightbox) return undefined;
    lbFocusRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeLightbox(); }
      else if (event.key === 'ArrowLeft' && lightbox.urls.length > 1) {
        setLightboxDims(null);
        setLightbox((prev) => (prev ? { ...prev, index: (prev.index - 1 + prev.urls.length) % prev.urls.length } : prev));
      } else if (event.key === 'ArrowRight' && lightbox.urls.length > 1) {
        setLightboxDims(null);
        setLightbox((prev) => (prev ? { ...prev, index: (prev.index + 1) % prev.urls.length } : prev));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const copyText = async (text, key) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? '' : prev)), 1600);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setCopiedKey(key);
        setTimeout(() => setCopiedKey((prev) => (prev === key ? '' : prev)), 1600);
      } catch { /* 클립보드 권한 없음 */ }
    }
  };

  const mySection = useMemo(() => {
    const section = myTextSection(mine);
    if (!section) return null;
    const rows = section.items.filter((entry) => isKakaoEntry(entry) === isKakao);
    return rows.length ? { ...section, items: rows, count: rows.length } : null;
  }, [mine, isKakao]);
  const mineById = useMemo(() => new Map(mine.map((item) => [item.id, item])), [mine]);
  const effOf = (entry) => autoEffective(autoStatus[entry.id] ?? (entry.autoEnabled ? null : { enabled: false }));

  // channel='kakao' 용 컴팩트 1줄 단계 행(개발자 수식 제거 · 배지 중복 없음 · 버튼 영역 완전 분리)
  const renderKakaoStep = (entry) => {
    const open = mineOpen === entry.id;
    const bodyText = mineById.get(entry.id)?.body || '';
    const photos = minePhoto[entry.id] || [];
    const pState = minePhotoState[entry.id];
    const eff = effOf(entry);
    const ch = channelCostOf(entry);
    const summary = buildConditionSummary(entry, { isMine: true });
    const timeOnly = summary.whenSub.replace(/ 발송.*$/, '').replace(/\s*·\s*$/, '').trim();
    const paused = catchupPausedText(autoStatus[entry.id]);
    const stepMeta = [
      summary.whenMain,
      timeOnly && timeOnly !== summary.whenMain ? timeOnly : '',
      entry.hasImage ? photoBadgeText(entry) : '',
      ...summary.tags.filter((tag) => !tag.startsWith('광고성')),
    ].filter(Boolean);
    return (
      <li key={`step-${entry.id}`} className={`stl-kstep${open ? ' is-selected' : ''}`}>
        <button type="button" className="stl-kstep-main" aria-expanded={open} onClick={() => openMine(entry)}>
          <span className="stl-kstep-top">
            <span className={`stl-light stl-light--${autoLightClass(eff)}`} title={eff.text}>{compactLightLabel(eff)}</span>
            <span className="stl-kstep-badge">{flowStepText(entry)}</span>
            <strong className="stl-kstep-name">{entry.name}</strong>
          </span>
          <span className="stl-kstep-sub">
            {ch.fullLabel ? <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span> : null}
            {stepMeta.map((part, idx) => (
              <React.Fragment key={`${idx}-${part}`}>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
          </span>
          {paused ? <span className="stl-kstep-warn" role="alert">{paused}</span> : null}
        </button>
        <div className="stl-kstep-actions">
          <SmsAutoControls compact id={entry.id} enabled={Boolean(autoStatus[entry.id]?.enabled ?? entry.autoEnabled)} photos={entry.imageCount} ata={Boolean(entry.autoAtaTemplate)} bms={entry.autoAtaTemplate === BMS_TEMPLATE_ID} onChanged={() => { loadMine(true); }}>
            <button type="button" className="ktm-btn" onClick={() => editMine(entry, flowById.get(entry.id))}>수정</button>
          </SmsAutoControls>
        </div>
        {open ? (
          <div className="stl-kstep-open">
            {entry.autoKind && (eff.tone === 'blocked' || eff.tone === 'part') ? <p className="sac-status">{eff.text}</p> : null}
            <div className={photos.length ? 'stl-open-split' : 'stl-open-plain'}>
              <div className="ktm-open-body">{renderBodyContent(bodyText, false)}</div>
              {entry.hasImage ? (
                <div className="stl-open-media">
                  {pState === 'loading' && !photos.length ? <p className="stl-media-msg">이미지를 불러오는 중…</p> : null}
                  {pState === 'error' && !photos.length ? (
                    <div className="stl-media-err">
                      <span>이미지를 불러오지 못했습니다.</span>
                      <button type="button" className="ktm-btn" onClick={() => ensureMinePhoto(entry, true)}>다시 시도</button>
                    </div>
                  ) : null}
                  {photos.length ? (
                    <div className="stl-open-imgs">
                      {photos.map((url, index) => (
                        <button key={index} type="button" className="stl-thumb-btn" onClick={() => openLightbox(photos, index, entry.name)} title="클릭하면 원본 크기로 봅니다">
                          <img className="ktm-open-img stl-open-img" src={url} alt={`${entry.name} 이미지 ${index + 1}`} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="ktm-modal-actions">
              <button type="button" className="ktm-btn ktm-btn--danger-outline" onClick={() => deleteMine(entry)}>{mineConfirm === entry.id ? '삭제 확인' : '삭제'}</button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  // channel='kakao' 용 2열 요약 카드(한눈에 조건·단가·켜짐 수·시점 확인, 하단 독립 액션 바)
  const renderKakaoFlow = (flow) => {
    const open = flowOpen === flow.key;
    const stepLabels = flow.steps.map((step) => flowStepText(step));
    const shownSteps = stepLabels.slice(0, 4);
    const hiddenCount = Math.max(0, stepLabels.length - shownSteps.length);
    const channels = [...new Map(flow.steps.map((step) => {
      const ch = channelCostOf(step);
      return [ch.fullLabel, ch];
    }).filter(([k]) => Boolean(k))).values()];
    const firstSummary = flow.steps[0] ? buildConditionSummary(flow.steps[0], { isMine: true }) : null;
    const tone = flowLightTone(flow.on, flow.total);
    const statusText = tone === 'on'
      ? (flow.total > 1 ? `모두 켜짐 (${flow.on}/${flow.total})` : '켜짐')
      : tone === 'part'
        ? `일부 켜짐 (${flow.on}/${flow.total})`
        : (flow.total > 1 ? `모두 꺼짐 (0/${flow.total})` : '꺼짐');
    return (
      <li key={flow.key} className={`stl-kflow-card${open ? ' is-open' : ''}`}>
        <div className="stl-kflow-top">
          <div className="stl-kflow-head">
            <span className="stl-kflow-title">{flow.label}</span>
            <span className={`stl-light stl-light--${tone}`}>{statusText}</span>
          </div>
          <div className="stl-kflow-meta">
            {channels.map((ch) => <span key={ch.fullLabel} className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>)}
            {flow.who ? <span className={`ktm-chip stl-who ${flow.who === '고객' ? 'stl-who--cust' : (flow.who === '영업담당' ? 'stl-who--sales' : 'stl-who--staff')}`}>{flow.who}</span> : null}
            {flow.time ? <span className="stl-kflow-time">{flow.time}</span> : null}
            {shownSteps.map((lbl, idx) => <span key={`${idx}-${lbl}`} className="stl-kflow-step">{lbl}</span>)}
            {hiddenCount > 0 ? <span className="stl-kflow-more">외 {hiddenCount}개 단계</span> : null}
          </div>
          {firstSummary?.tags?.length ? (
            <div className="stl-kflow-tags">
              {firstSummary.tags.slice(0, 2).map((tag) => <span key={tag} className="stl-rule-chip">{tag}</span>)}
            </div>
          ) : null}
        </div>
        <div className="stl-kflow-foot">
          <button type="button" className="ktm-btn stl-kflow-toggle" aria-expanded={open} onClick={() => { setFlowOpen(open ? '' : flow.key); setMineOpen(''); setMineConfirm(''); }}>
            {open ? '단계 접기 ▴' : `단계 보기 (${flow.total}) ▾`}
          </button>
          <span className="stl-kflow-btns">
            {FLOW_NO_STEP_KINDS.includes(flow.steps[0]?.autoKind) ? null : <button type="button" className="ktm-btn" onClick={() => addStep(flow)}>단계 추가</button>}
            <button type="button" className="ktm-btn" onClick={() => editMine(flow.steps[0], flow)}>수정</button>
          </span>
        </div>
        {open ? <ul className="stl-ksteps">{flow.steps.map((step) => renderKakaoStep(step))}</ul> : null}
      </li>
    );
  };

  // channel='kakao' 단일 단계 호환 렌더러
  const renderMine = (entry) => (
    <li key={entry.id} className="stl-kflow-card is-open">
      <ul className="stl-ksteps">{renderKakaoStep(entry)}</ul>
    </li>
  );

  // 흐름 행(내 문구 탭에서 사용)
  const renderFlow = (flow, selectOnStep = false) => {
    const open = flowOpen === flow.key;
    const chips = flow.steps.map((step) => flowStepText(step)).join(' · ');
    return (
      <li key={flow.key} className={`ktm-card stl-row stl-flow${open ? ' is-selected' : ''}`}>
        <button type="button" className="ktm-card-main" aria-expanded={open} onClick={() => { setFlowOpen(open ? '' : flow.key); setMineOpen(''); setMineConfirm(''); }}>
          <span className="ktm-card-name stl-flow-name">{flow.label}</span>
          <span className="ktm-card-meta stl-flow-meta" title={chips}>
            <span className="stl-stepchips">{flow.steps.map((step) => <span key={step.id} className="ktm-chip stl-stepchip">{flowStepText(step)}</span>)}</span>
            {flow.who ? <span className={`ktm-chip stl-who ${flow.who === '고객' ? 'stl-who--cust' : (flow.who === '영업담당' ? 'stl-who--sales' : 'stl-who--staff')}`}>{flow.who}</span> : null}
            {flow.via ? <span className={`ktm-chip stl-via${flow.via.includes('알림톡') ? ' stl-via--talk' : (flow.via.includes('브랜드') ? ' stl-via--bms' : '')}`}>{flow.via}</span> : null}
            {flow.time ? <span className="stl-extras stl-time">{flow.time}</span> : null}
          </span>
          <span className="ktm-card-badges stl-flow-on"><span className={`stl-light stl-light--${flowLightTone(flow.on, flow.total)}`}>켜짐 {flow.on}/{flow.total}</span></span>
        </button>
        <span className="stl-flow-actions">
          {FLOW_NO_STEP_KINDS.includes(flow.steps[0]?.autoKind) ? null : <button type="button" className="ktm-btn" onClick={() => addStep(flow)}>단계 추가</button>}
          <button type="button" className="ktm-btn" onClick={() => editMine(flow.steps[0], flow)}>수정</button>
        </span>
        {open ? <ul className="ktm-cards stl-steps">{flow.steps.map((step) => (selectOnStep ? renderMineListCard(step, 'step-') : renderKakaoStep(step)))}</ul> : null}
      </li>
    );
  };

  const items = useMemo(
    () => state.items.filter((item) => item.sender !== SENDERS.make),
    [state.items],
  );
  const allMine = useMemo(() => sortByNameNumeric(mySection ? mySection.items : []), [mySection]);
  const sortedMine = useMemo(
    () => allMine.filter((row) => (!cond || conditionGroup(row) === cond) && matchesSmsQuery({ ...row, body: mineById.get(row.id)?.body || '' }, query, recipients)),
    [allMine, cond, query, recipients, mineById],
  );
  // 내 문구 탭은 흐름(기준 시점) 단위 행. siblings 는 조건 거르기와 상관없이 같은 흐름 전체
  const flowRows = useMemo(() => groupFlows(sortedMine, (entry) => ['on', 'part'].includes(effOf(entry).tone)), [sortedMine, autoStatus]);
  const flowById = useMemo(() => {
    const map = new Map();
    groupFlows(allMine).forEach((flow) => flow.steps.forEach((step) => map.set(step.id, flow)));
    return map;
  }, [allMine]);
  const [flowOpen, setFlowOpen] = useState('');
  // 탭 숫자는 조건 거르기·검색과 상관없이 전체 기준(상단 현황판·알약·목록 1:1 일치)
  const isMineActive = (entry) => Boolean(entry.autoKind && (autoStatus[entry.id] ? ['on', 'part'].includes(effOf(entry).tone) : entry.autoEnabled));
  const isCatalogActive = (item) => itemLight(item).tone === 'on';
  const runningAll = useMemo(() => allMine.filter(isMineActive).length, [allMine, autoStatus]);
  const condItems = useMemo(
    () => items.filter((item) => (!cond || conditionGroup(item) === cond) && matchesSmsQuery(item, query, recipients)),
    [items, cond, query, recipients],
  );
  const runningAutos = useMemo(() => sortedMine.filter(isMineActive), [sortedMine, autoStatus]);
  const autoAll = useMemo(() => allMine.filter((entry) => entry.autoKind).length, [allMine]);
  const attentionAutosAll = useMemo(() => allMine.filter((entry) => entry.autoKind && isAttentionTone(effOf(entry).tone)), [allMine, autoStatus]);
  const attentionItemsAll = useMemo(() => items.filter((item) => isAttentionTone(itemLight(item).tone)), [items]);
  const attentionTotal = attentionAutosAll.length + attentionItemsAll.length;
  const activeCatalogAll = useMemo(() => items.filter(isCatalogActive).length, [items]);
  const smsAutoStats = useMemo(() => ({
    on: runningAll + activeCatalogAll,
    total: autoAll + items.length,
    attention: attentionTotal,
  }), [runningAll, activeCatalogAll, autoAll, items.length, attentionTotal]);
  const SMS_ISSUE_LABELS = {
    'catchup-paused': '일괄 발송 멈춤',
    'off-blocked': '꺼짐 · 설정 미완료',
    'on-zero-send': '켜짐 · 최근 발송 없음',
  };
  const isEntryCatchupPaused = (entry) => Boolean(entry.autoKind && catchupPausedText(autoStatus[entry.id]));
  const isEntryOffBlocked = (entry) => Boolean(entry.autoKind && ['off', 'blocked'].includes(effOf(entry).tone));
  const isItemOffBlocked = (item) => ['off', 'blocked'].includes(itemLight(item).tone);
  const isEntryOnZeroSend = (entry) => {
    const st = autoStatus[entry.id];
    return Boolean(entry.autoKind && st && effOf(entry).tone !== 'off' && !(Number(st.sent_7d) > 0) && !st.last_sent_date);
  };
  const isItemOnZeroSend = (item) => itemLight(item).tone === 'on' && item.count === 0 && !item.lastSentAt;

  const smsIssues = useMemo(() => {
    const pausedCount = allMine.filter(isEntryCatchupPaused).length;
    const offBlockedMine = allMine.filter(isEntryOffBlocked).length;
    const offBlockedItems = items.filter(isItemOffBlocked).length;
    const onZeroMine = allMine.filter(isEntryOnZeroSend).length;
    const onZeroItems = items.filter(isItemOnZeroSend).length;
    return [
      ...(pausedCount > 0 ? [{ key: 'catchup-paused', tone: 'warn', label: '일괄 발송 멈춤', count: pausedCount, active: issueFilter === 'catchup-paused', onClick: () => toggleIssueFilter('catchup-paused') }] : []),
      { key: 'off-blocked', tone: 'danger', label: '꺼짐 · 설정 미완료', count: offBlockedMine + offBlockedItems, active: issueFilter === 'off-blocked', onClick: () => toggleIssueFilter('off-blocked') },
      { key: 'on-zero-send', tone: 'info', label: '켜짐 · 최근 발송 없음', count: onZeroMine + onZeroItems, active: issueFilter === 'on-zero-send', onClick: () => toggleIssueFilter('on-zero-send') },
    ];
  }, [allMine, autoStatus, items, issueFilter]);
  const pills = useMemo(() => [
    { id: 'in_use', label: '발송 중', count: runningAll + activeCatalogAll },
    { id: 'attention', label: '꺼짐·확인 필요', count: attentionTotal },
    { id: 'all', label: '전체', count: autoAll + items.length },
    ...(mySection ? [{ id: 'mine', label: '직접 등록', count: mySection.count }] : []),
  ], [items.length, mySection, runningAll, activeCatalogAll, autoAll, attentionTotal]);
  const defaultTab = (runningAll + activeCatalogAll) > 0 ? 'in_use' : 'all';
  const rawTab = picked ?? defaultTab;
  const tab = rawTab === 'mine' && !mySection ? defaultTab : rawTab;
  const isMineTab = tab === 'mine';
  const isAttentionTab = tab === 'attention';
  const allAutos = useMemo(() => sortedMine.filter((entry) => entry.autoKind), [sortedMine]);
  const manualMatched = useMemo(
    () => (query.trim() ? sortedMine.filter((entry) => !entry.autoKind) : []),
    [query, sortedMine],
  );
  const attentionAutos = useMemo(() => sortedMine.filter((entry) => entry.autoKind && isAttentionTone(effOf(entry).tone)), [sortedMine, autoStatus]);
  const shownAutos = isMineTab ? [] : (
    issueFilter === 'catchup-paused' ? sortedMine.filter(isEntryCatchupPaused)
      : issueFilter === 'off-blocked' ? sortedMine.filter(isEntryOffBlocked)
        : issueFilter === 'on-zero-send' ? sortedMine.filter(isEntryOnZeroSend)
          : (isAttentionTab ? attentionAutos : (tab === 'in_use' ? [...runningAutos, ...manualMatched] : [...allAutos, ...manualMatched]))
  );
  const sectionItems = useMemo(() => {
    if (isMineTab || issueFilter === 'catchup-paused') return [];
    const filtered = issueFilter === 'off-blocked'
      ? condItems.filter(isItemOffBlocked)
      : issueFilter === 'on-zero-send'
        ? condItems.filter(isItemOnZeroSend)
        : (tab === 'in_use' ? condItems.filter(isCatalogActive) : (isAttentionTab ? condItems.filter((item) => isAttentionTone(itemLight(item).tone)) : condItems));
    return sortSmsItems(filtered);
  }, [condItems, isMineTab, isAttentionTab, tab, issueFilter]);

  // 비즈니스 카테고리(리뷰 이벤트 · 소개/혜택 · 주문/출고/주의사항 · 직원/관리자)로 일관되게 묶는다
  const displayGroups = useMemo(() => {
    if (isMineTab) return [];
    const byGroup = new Map();
    const ensureGroup = (meta) => {
      let g = byGroup.get(meta.groupKey);
      if (!g) {
        g = { ...meta, mineEntries: [], items: [] };
        byGroup.set(meta.groupKey, g);
      }
      return g;
    };
    shownAutos.forEach((entry) => {
      ensureGroup(smsDisplayCategory(entry)).mineEntries.push(entry);
    });
    sectionItems.forEach((item) => {
      ensureGroup(smsDisplayCategory(item)).items.push(item);
    });
    return [...byGroup.values()].sort((a, b) => a.order - b.order);
  }, [isMineTab, shownAutos, sectionItems]);

  // 쪽 나누기는 선택한 탭의 행에만 적용한다(카테고리 한 화면에 모이도록 20행 단위)
  const rowKeys = useMemo(() => {
    if (isMineTab) return flowRows.map((row) => row.key);
    const keys = [];
    displayGroups.forEach((group) => {
      group.mineEntries.forEach((entry) => keys.push(`run-${entry.id}`));
      group.items.forEach((item) => keys.push(`i-${item.id}`));
    });
    return keys;
  }, [isMineTab, flowRows, displayGroups]);
  const paged = paginateRows(rowKeys, pageNo, 20);
  const pageSet = new Set(paged.rows);
  const pickCond = (value) => { setIssueFilter(''); setCond(value); setPageNo(1); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey(''); };
  const pickFilter = (id) => { setIssueFilter(''); setPicked(id); setPageNo(1); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey(''); };
  const toggleIssueFilter = (key) => {
    setPageNo(1); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey('');
    setIssueFilter((prev) => {
      if (prev === key) return '';
      setPicked('all');
      setCond('');
      setQuery('');
      return key;
    });
  };
  const goPage = (next) => { setPageNo(next); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey(''); };
  const changeQuery = (value) => { setQuery(value); setPageNo(1); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey(''); };
  const hasActiveFilters = Boolean(query.trim() || cond || issueFilter || (tab !== 'in_use' && tab !== 'all'));
  const resetFilters = () => { setQuery(''); setCond(''); setIssueFilter(''); setPicked(null); setPageNo(1); setMineOpen(''); setMineConfirm(''); setFlowOpen(''); setSelectedKey(''); };

  // 현재 쪽에서 선택 가능한 항목 키 목록(표시 순서)
  const visibleCandidateKeys = useMemo(() => {
    if (isKakao) return [];
    const keys = [];
    if (isMineTab) {
      flowRows.filter((row) => pageSet.has(row.key)).forEach((row) => {
        if (row.single) keys.push(`m-${row.entry.id}`);
        else row.steps.forEach((step) => keys.push(`m-${step.id}`));
      });
      return keys;
    }
    displayGroups.forEach((group) => {
      group.mineEntries.filter((entry) => pageSet.has(`run-${entry.id}`)).forEach((entry) => keys.push(`m-${entry.id}`));
      group.items.filter((item) => pageSet.has(`i-${item.id}`)).forEach((item) => keys.push(`i-${item.id}`));
    });
    return keys;
  }, [isKakao, isMineTab, flowRows, displayGroups, paged.page, paged.rows]);

  const selectedMine = useMemo(
    () => (selectedKey.startsWith('m-') ? allMine.find((entry) => `m-${entry.id}` === selectedKey) || null : null),
    [selectedKey, allMine],
  );
  const selectedItem = useMemo(
    () => (selectedKey.startsWith('i-') ? items.find((item) => `i-${item.id}` === selectedKey) || null : null),
    [selectedKey, items],
  );

  // "같은 문구로 조건 추가" 저장 직후 새 항목이 목록에 들어오면 해당 쪽으로 이동하고 바로 선택한다
  useEffect(() => {
    const targetId = pendingCreatedIdRef.current;
    if (isKakao || !active || !targetId || !mineLoaded) return;
    if (!allMine.some((entry) => entry.id === targetId)) return;
    const rowKey = isMineTab
      ? flowRows.find((row) => (row.single ? row.entry.id === targetId : row.steps.some((step) => step.id === targetId)))?.key
      : `run-${targetId}`;
    if (rowKey) {
      const idx = rowKeys.indexOf(rowKey);
      if (idx >= 0) {
        const targetPage = Math.floor(idx / 20) + 1;
        if (targetPage !== pageNo) setPageNo(targetPage);
      }
      if (isMineTab) setFlowOpen(rowKey);
    }
    setSelectedKey(`m-${targetId}`);
    pendingCreatedIdRef.current = null;
  }, [isKakao, active, mineLoaded, allMine, isMineTab, flowRows, rowKeys, pageNo]);

  // PC(>=1024px)에서는 카탈로그·내 문구 모두 읽은 뒤 목록 첫 항목을 자동으로 골라 오른쪽 미리보기를 바로 채운다
  useEffect(() => {
    if (isKakao || !active || !state.loaded || !mineLoaded || pendingCreatedIdRef.current) return;
    if (!isDesktopViewport()) {
      if (selectedKey && !selectedMine && !selectedItem) setSelectedKey('');
      return;
    }
    if (!selectedKey || !visibleCandidateKeys.includes(selectedKey)) {
      if (visibleCandidateKeys.length > 0) {
        const firstKey = visibleCandidateKeys[0];
        setSelectedKey(firstKey);
        if (isMineTab) {
          const firstFlow = flowRows.find((row) => pageSet.has(row.key));
          if (firstFlow && !firstFlow.single) setFlowOpen(firstFlow.key);
        }
      } else if (selectedKey) {
        setSelectedKey('');
      }
    }
  }, [isKakao, active, state.loaded, mineLoaded, selectedKey, selectedMine, selectedItem, visibleCandidateKeys, isMineTab, flowRows]);

  // 선택한 항목이 바뀌면 미리보기 보조 상태 초기화 + 첨부 이미지 자동 조회
  useEffect(() => {
    setPreviewFilled(false);
    setExpandedImg(false);
    setMineConfirm('');
    setMineError('');
    if (active && !isKakao && selectedMine?.hasImage) ensureMinePhoto(selectedMine);
  }, [selectedKey, active, isKakao, selectedMine?.id, selectedMine?.hasImage]); // eslint-disable-line react-hooks/exhaustive-deps

const formatKpiDate = (value) => {
  const s = String(value || '').trim();
  if (!s) return '없음';
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
};

// 상세 상단 3단 발송 조건·규칙·현황 보드
function renderConditionBoard(summary, st, isMineAuto, catalogStats = null, onCloneCondition = null) {
  const thirdLabel = isMineAuto || summary.manual ? '횟수 · 비용' : '종류 · 비용';
  const todayCount = Number(st?.today_targets) || 0;
  const recent7d = Number(st?.sent_7d) || 0;
  const sentTotal = Number(st?.sent_total) || 0;
  const uncertain = Number(st?.uncertain_total) || 0;
  return (
    <section className="stl-cond-board" aria-label="발송 조건 및 현황">
      <div className="stl-section-eyebrow">발송 조건 · 현황</div>
      <div className="stl-cond-grid">
        <div className="stl-cond-tile stl-cond-tile--when">
          <span className="stl-cond-label">언제 보낼까</span>
          <strong className="stl-cond-val">{plainKoreanText(summary.whenMain)}</strong>
          {summary.whenSub ? <span className="stl-cond-sub">{plainKoreanText(summary.whenSub)}</span> : null}
        </div>
        <div className="stl-cond-tile">
          <span className="stl-cond-label">누구에게</span>
          <strong className="stl-cond-val">{summary.whoMain}</strong>
          {summary.whoSub ? <span className="stl-cond-sub">{summary.whoSub}</span> : null}
        </div>
        <div className="stl-cond-tile">
          <span className="stl-cond-label">{thirdLabel}</span>
          <strong className="stl-cond-val">{summary.howMain}</strong>
          {summary.howSub ? <span className="stl-cond-sub">{summary.howSub}</span> : null}
        </div>
      </div>

      {summary.catchup && !summary.catchup.includes('발송 완료됨') ? (
        <div className="stl-cond-catchup" role="status">{summary.catchup}</div>
      ) : null}

      {summary.tags.length > 0 ? (
        <div className="stl-cond-tags" aria-label="세부 규칙">
          <span className="stl-cond-tags-label">세부 규칙</span>
          {summary.tags.map((tag) => (
            <span key={tag} className="stl-rule-chip">{tag}</span>
          ))}
        </div>
      ) : null}

      {isMineAuto ? (
        st ? (
          <div className="stl-cond-kpis" aria-label="발송 현황">
            <div className="stl-kpi">
              <span className="stl-kpi-label">오늘 대상</span>
              <strong className={`stl-kpi-val${todayCount > 0 ? ' is-accent' : ''}`}>{todayCount}건</strong>
            </div>
            <div className="stl-kpi">
              <span className="stl-kpi-label">최근 7일</span>
              <strong className={`stl-kpi-val${recent7d > 0 ? ' is-accent' : ''}`}>{recent7d}건</strong>
            </div>
            <div className="stl-kpi">
              <span className="stl-kpi-label">누적 발송</span>
              <strong className="stl-kpi-val">{sentTotal}건</strong>
            </div>
            <div className="stl-kpi">
              <span className="stl-kpi-label">확인 필요</span>
              <strong className={`stl-kpi-val${uncertain > 0 ? ' is-warn' : ''}`}>{uncertain}건</strong>
            </div>
            <div className="stl-kpi">
              <span className="stl-kpi-label">가장 최근 발송</span>
              <strong className="stl-kpi-val" title={st.last_sent_date || '발송 기록 없음'}>{formatLastSentLabel(st.last_sent_date) || '기록 없음'}</strong>
            </div>
          </div>
        ) : (
          <p className="stl-cond-loading">발송 현황 불러오는 중…</p>
        )
      ) : catalogStats ? (
        <div className="stl-cond-kpis stl-cond-kpis--compact" aria-label="최근 발송 현황">
          <div className="stl-kpi">
            <span className="stl-kpi-label">최근 7일 발송</span>
            <strong className={`stl-kpi-val${(catalogStats.count ?? 0) > 0 ? ' is-accent' : ''}`}>
              {catalogStats.count === null ? '확인 못 함' : `${catalogStats.count}건`}
            </strong>
          </div>
          <div className="stl-kpi">
            <span className="stl-kpi-label">가장 최근 발송</span>
            <strong className="stl-kpi-val">{formatLastSentLabel(catalogStats.lastSentAt) || '기록 없음'}</strong>
          </div>
        </div>
      ) : null}
      {onCloneCondition ? (
        <button type="button" className="stl-cond-clone-btn" onClick={onCloneCondition}>
          + 같은 문구로 조건 추가
        </button>
      ) : null}
    </section>
  );
}

  // 왼쪽 목록 카드(내 문구 단일/단계 항목)
  const renderMineListCard = (entry, prefix = '') => {
    const key = `m-${entry.id}`;
    const isSelected = selectedKey === key;
    const eff = effOf(entry);
    const ch = channelCostOf(entry);
    const cp = entry.autoKind ? autoConditionParts(entry) : null;
    const summary = entry.autoKind ? buildConditionSummary(entry, { isMine: true }) : null;
    const compactTime = summary ? summary.whenSub.replace(/ 발송.*$/, '').trim() : '';
    const showTime = Boolean(compactTime && /^(오전|오후|매일|당일|\d)/.test(compactTime));
    const repeatCount = Number(entry.autoRepeat) || 1;
    const showRepeat = Boolean(entry.autoKind && repeatCount > 1);
    const paused = catchupPausedText(autoStatus[entry.id]);
    const st = autoStatus[entry.id];
    const lastLabel = formatLastSentLabel(st?.last_sent_date);
    const sent7d = Number(st?.sent_7d) || 0;
    const metaParts = [
      showTime ? compactTime : '',
      cp?.who || '',
      showRepeat ? `최대 ${repeatCount}회` : '',
    ].filter(Boolean);
    return (
      <li key={`${prefix}${entry.id}`} className={`stl-item${prefix === 'step-' ? ' stl-item--step' : ''}${isSelected ? ' is-selected' : ''}`}>
        <button type="button" className="stl-item-btn" aria-current={isSelected ? 'true' : undefined} onClick={() => setSelectedKey(key)}>
          <div className="stl-item-top">
            <span className="stl-item-name">{entry.name}</span>
            {entry.autoKind ? <span className={`stl-light stl-light--${autoLightClass(eff)}`} title={eff.text}>{compactLightLabel(eff)}</span> : <span className="stl-sender-chip">수동 문구</span>}
          </div>
          {summary ? (
            <div className="stl-item-cond">
              <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
              <span className="stl-meta-sep" aria-hidden="true">·</span>
              <span className="stl-when">{summary.whenMain}</span>
              {metaParts.map((part, idx) => (
                <React.Fragment key={`${idx}-${part}`}>
                  <span className="stl-meta-sep" aria-hidden="true">·</span>
                  <span>{part}</span>
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div className="stl-item-cond">
              <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
              <span className="stl-meta-sep" aria-hidden="true">·</span>
              <span className="stl-preview-line">{entry.preview || '내용 없음'}</span>
            </div>
          )}
          <div className="stl-item-badges">
            {entry.autoKind ? (
              <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
                {lastLabel ? `최근 발송 ${lastLabel}${sent7d > 0 ? ` · 7일 ${sent7d}건` : ''}` : '발송 기록 없음'}
              </span>
            ) : null}
            {paused ? <span className="ktm-badge ktm-badge--danger" title={paused}>일괄 발송만 멈춤</span> : null}
          </div>
        </button>
      </li>
    );
  };

  // 왼쪽 목록 카드(카탈로그·외부 문구)
  const renderItemListCard = (item) => {
    const key = `i-${item.id}`;
    const isSelected = selectedKey === key;
    const light = itemLight(item);
    const ch = channelCostOf(item);
    const summary = buildConditionSummary(item, { isMine: false, recipients });
    const lastLabel = formatLastSentLabel(item.lastSentAt);
    const detailPart = item.audience?.id !== 'customer' && summary.whoMain
      ? summary.whoMain
      : (item.count !== null && item.count > 0 ? `7일 ${item.count}건` : plainKoreanText(summary.whenSub || ''));
    const metaParts = [
      item.audience.label,
      item.external ? '' : item.sender,
      detailPart,
    ].filter(Boolean);
    const exceptionBadges = [];
    if (item.config?.status === 'incomplete') exceptionBadges.push({ tone: 'danger', text: item.config.label || '설정 미완료' });
    if (item.policy?.status === 'paused') exceptionBadges.push({ tone: 'warn', text: item.policy.label || '정책 중단' });
    if (item.ad) exceptionBadges.push({ tone: 'info', text: '광고' });
    if (item.count === null) exceptionBadges.push({ tone: 'muted', text: '발송 확인 안 됨' });
    return (
      <li key={item.id} className={`stl-item${isSelected ? ' is-selected' : ''}`}>
        <button type="button" className="stl-item-btn" aria-current={isSelected ? 'true' : undefined} onClick={() => setSelectedKey(key)}>
          <div className="stl-item-top">
            <span className="stl-item-name">{item.name}</span>
            <span className={`stl-light stl-light--${light.tone}`} title={light.text}>{light.text}</span>
          </div>
          <div className="stl-item-cond">
            <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
            {item.external && item.sender ? (
              <>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span className="stl-sender-chip">{item.sender}</span>
              </>
            ) : null}
            {summary.whenMain ? (
              <>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span className="stl-when">{plainKoreanText(summary.whenMain)}</span>
              </>
            ) : null}
            {metaParts.map((part, idx) => (
              <React.Fragment key={`${idx}-${part}`}>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="stl-item-badges">
            <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {lastLabel ? `최근 발송 ${lastLabel}` : '최근 7일 발송 없음'}
            </span>
            {exceptionBadges.map((badge) => <span key={badge.text} className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span>)}
          </div>
        </button>
      </li>
    );
  };

  // 오른쪽 상세·미리보기 패널
  const renderDetailPane = () => {
    if (!selectedMine && !selectedItem) {
      return (
        <div className="stl-detail-empty">
          <p className="stl-detail-empty-title">왼쪽 목록에서 템플릿을 선택하세요</p>
          <p className="stl-detail-empty-sub">전체 문구와 첨부 이미지를 잘림 없이 크게 확인하고, 바로 수정·시험 발송할 수 있습니다.</p>
        </div>
      );
    }

    if (selectedMine) {
      const entry = selectedMine;
      const rawBody = String(mineById.get(entry.id)?.body || '');
      const st = autoStatus[entry.id];
      const eff = effOf(entry);
      const cp = entry.autoKind ? autoConditionParts(entry) : null;
      const summary = buildConditionSummary(entry, { isMine: true });
      const paused = catchupPausedText(st);
      const photos = minePhoto[entry.id] || [];
      const pState = minePhotoState[entry.id];
      const hasBody = Boolean(rawBody.trim());
      const hasMedia = Boolean(entry.hasImage);
      const hasVars = /#\{[^{}\n]{1,40}\}/.test(rawBody);
      const isLongBody = rawBody.length > 120 || rawBody.split('\n').length > 4;
      const isTall = Boolean(tallImgMap[`m-${entry.id}`]);
      const msgCard = (
        <section key="msg" className="stl-msg-card" aria-label="발송 문구">
          <div className="stl-card-subhead">
            <div className="stl-card-subhead-left">
              <span className="stl-card-subhead-title">실제 발송 내용</span>
              {hasBody ? <span className="stl-char-count">{[...rawBody].length}자</span> : null}
            </div>
            <div className="stl-card-subhead-right">
              {hasBody && hasVars ? (
                <button type="button" className={`ktm-btn stl-mini-btn${previewFilled ? ' is-active' : ''}`} aria-pressed={previewFilled} onClick={() => setPreviewFilled((v) => !v)}>
                  {previewFilled ? '원래 양식 보기' : '실제 예시로 보기'}
                </button>
              ) : null}
              {hasBody ? (
                <button type="button" className="ktm-btn stl-mini-btn" onClick={() => copyText(rawBody, `m-${entry.id}`)}>
                  <SmsIcon name="copy" /> {copiedKey === `m-${entry.id}` ? '복사됨 ✓' : '문구 복사'}
                </button>
              ) : null}
            </div>
          </div>
          {hasBody ? (
            <div className="stl-msg-body">{renderBodyContent(rawBody, previewFilled)}</div>
          ) : (
            <p className="stl-msg-empty">등록된 문구 내용이 없습니다.</p>
          )}
        </section>
      );
      const mediaCard = hasMedia ? (
        <section key="media" className="stl-media-card" aria-label="첨부 이미지">
          <div className="stl-card-subhead">
            <div className="stl-card-subhead-left">
              <span className="stl-card-subhead-title">첨부 사진</span>
              <span className="stl-char-count">{photos.length ? `${photos.length}장` : photoBadgeText(entry)}</span>
            </div>
            {photos.length ? (
              <div className="stl-card-subhead-right">
                {isTall ? (
                  <button type="button" className="ktm-btn stl-mini-btn" onClick={() => setExpandedImg((v) => !v)}>
                    {expandedImg ? '높이 접기' : '전체 펼치기'}
                  </button>
                ) : null}
                <button type="button" className="ktm-btn stl-mini-btn" onClick={() => openLightbox(photos, 0, entry.name)}>
                  <SmsIcon name="zoom" /> 크게 보기
                </button>
              </div>
            ) : null}
          </div>
          {pState === 'loading' && !photos.length ? (
            <div className="stl-media-state">이미지를 불러오는 중…</div>
          ) : pState === 'error' && !photos.length ? (
            <div className="stl-media-state stl-media-state--err">
              <span>이미지를 불러오지 못했습니다.</span>
              <button type="button" className="ktm-btn" onClick={() => ensureMinePhoto(entry, true)}>다시 시도</button>
            </div>
          ) : photos.length ? (
            <>
              <div className={`stl-media-viewport${expandedImg ? ' is-expanded' : ''}`}>
                <div className="stl-media-stack">
                  {photos.map((url, index) => (
                    <button key={index} type="button" className="stl-media-zoom-btn" onClick={() => openLightbox(photos, index, entry.name)} title="클릭하면 원본 크기로 크게 봅니다">
                      <img
                        className="stl-media-img"
                        src={url}
                        alt={`${entry.name} 첨부 이미지 ${index + 1}`}
                        onLoad={(event) => {
                          const img = event.currentTarget;
                          if (img.naturalHeight > 360 && img.naturalHeight > img.naturalWidth * 1.1) {
                            setTallImgMap((prev) => (prev[`m-${entry.id}`] ? prev : { ...prev, [`m-${entry.id}`]: true }));
                          }
                        }}
                      />
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="stl-media-state">이미지를 준비하는 중…</div>
          )}
        </section>
      ) : null;

      return (
        <article className="stl-detail" aria-label={`${entry.name} 상세 보기`}>
          <div className="stl-detail-head">
            <button type="button" className="ktm-btn stl-back" onClick={() => setSelectedKey('')}>
              <SmsIcon name="back" /> 목록으로
            </button>
            <div className="stl-detail-meta">
              {entry.autoKind ? <span className={`stl-light stl-light--${autoLightClass(eff)}`}>{eff.text}</span> : <span className="stl-detail-kind">수동 발송</span>}
              {(() => {
                const ch = channelCostOf(entry);
                return (
                  <>
                    <span className="stl-meta-sep" aria-hidden="true">·</span>
                    <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
                  </>
                );
              })()}
              {['내 문구', cp?.who, entry.hasImage && entry.imageCount > 1 ? photoBadgeText(entry) : ''].filter(Boolean).map((part, idx) => (
                <React.Fragment key={`${idx}-${part}`}>
                  <span className="stl-meta-sep" aria-hidden="true">·</span>
                  <span>{part}</span>
                </React.Fragment>
              ))}
              {entry.autoKind ? (() => {
                const lastLabel = formatLastSentLabel(st?.last_sent_date);
                return (
                  <>
                    <span className="stl-meta-sep" aria-hidden="true">·</span>
                    <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
                      {lastLabel ? `최근 발송 ${lastLabel}` : '발송 기록 없음'}
                    </span>
                  </>
                );
              })() : null}
            </div>
            <div className="stl-detail-titlebar">
              <h3 className="stl-detail-title">{entry.name}</h3>
              <div className="stl-detail-actions">
                {entry.autoKind ? (
                  <SmsAutoControls
                    compact
                    key={entry.id}
                    id={entry.id}
                    enabled={Boolean(st?.enabled ?? entry.autoEnabled)}
                    photos={entry.imageCount}
                    ata={Boolean(entry.autoAtaTemplate)}
                    bms={entry.autoAtaTemplate === BMS_TEMPLATE_ID}
                    onChanged={() => { loadMine(true); }}
                  >
                    <button type="button" className="ktm-btn" onClick={() => editMine(entry, flowById.get(entry.id))}>수정</button>
                    <button type="button" className="ktm-btn ktm-btn--danger-outline" onClick={() => deleteMine(entry)}>{mineConfirm === entry.id ? '삭제 확인' : '삭제'}</button>
                  </SmsAutoControls>
                ) : (
                  <div className="stl-detail-btnrow">
                    <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => onSendText?.(entry.id)}>이 문구로 보내기</button>
                    <button type="button" className="ktm-btn" onClick={() => editMine(entry)}>수정</button>
                    <button type="button" className="ktm-btn ktm-btn--danger-outline" onClick={() => deleteMine(entry)}>{mineConfirm === entry.id ? '삭제 확인' : '삭제'}</button>
                  </div>
                )}
              </div>
            </div>
            {paused ? (
              <p className="ktm-alert stl-detail-banner" role="alert">
                {paused}
                <span className="stl-detail-banner-sub"> (일반 자동 발송은 계속 켜져 있습니다. 일괄 발송이 끝났다면 [수정]에서 일괄 발송 예약을 비워 주세요.)</span>
              </p>
            ) : null}
            {!paused && entry.autoKind && (eff.tone === 'blocked' || eff.tone === 'part') ? (
              <p className={eff.tone === 'blocked' ? 'ktm-alert stl-detail-banner' : 'ktm-warn stl-detail-banner'} role="status">{eff.text}</p>
            ) : null}
            {mineError ? <p className="ktm-alert stl-detail-banner" role="alert">{mineError}</p> : null}
          </div>

          <div className="stl-detail-split">
            {renderConditionBoard(summary, st, Boolean(entry.autoKind), null, () => cloneMine(entry))}
            <div className={`stl-preview-stage${hasMedia ? ' has-media' : ''}`}>
              {msgCard}
              {mediaCard}
            </div>
          </div>
        </article>
      );
    }

    // 카탈로그·외부 문구 상세
    const item = selectedItem;
    const light = itemLight(item);
    const summary = buildConditionSummary(item, { isMine: false, recipients });
    const rawBody = String(item.body || '');
    const hasBody = Boolean(rawBody.trim());
    const hasMedia = Boolean(item.image);
    const hasVars = /#\{[^{}\n]{1,40}\}/.test(rawBody);
    const isLongBody = rawBody.length > 120 || rawBody.split('\n').length > 4;
    const isTall = Boolean(tallImgMap[`i-${item.id}`]);
    const imgBroken = Boolean(extImgError[item.id]);
    const msgCard = (
      <section key="msg" className="stl-msg-card" aria-label="발송 문구">
        <div className="stl-card-subhead">
          <div className="stl-card-subhead-left">
            <span className="stl-card-subhead-title">실제 발송 내용</span>
            {hasBody ? <span className="stl-char-count">{[...rawBody].length}자</span> : null}
          </div>
          <div className="stl-card-subhead-right">
            {hasBody && hasVars ? (
              <button type="button" className={`ktm-btn stl-mini-btn${previewFilled ? ' is-active' : ''}`} aria-pressed={previewFilled} onClick={() => setPreviewFilled((v) => !v)}>
                {previewFilled ? '원래 양식 보기' : '실제 예시로 보기'}
              </button>
            ) : null}
            {hasBody ? (
              <button type="button" className="ktm-btn stl-mini-btn" onClick={() => copyText(rawBody, `i-${item.id}`)}>
                <SmsIcon name="copy" /> {copiedKey === `i-${item.id}` ? '복사됨 ✓' : '문구 복사'}
              </button>
            ) : null}
          </div>
        </div>
        {hasBody ? (
          <div className="stl-msg-body">{renderBodyContent(rawBody, previewFilled)}</div>
        ) : (
          <p className="stl-msg-empty">{item.sender === '카페24' ? '카페24 쇼핑몰에서 직접 발송되는 문구입니다(외부 설정에서 본문 관리).' : '등록된 예시 문구가 없습니다.'}</p>
        )}
      </section>
    );
    const mediaCard = hasMedia ? (
      <section key="media" className="stl-media-card" aria-label="첨부 이미지">
        <div className="stl-card-subhead">
          <div className="stl-card-subhead-left">
            <span className="stl-card-subhead-title">첨부 사진</span>
            <span className="stl-char-count">1장</span>
          </div>
          {!imgBroken ? (
            <div className="stl-card-subhead-right">
              {isTall ? (
                <button type="button" className="ktm-btn stl-mini-btn" onClick={() => setExpandedImg((v) => !v)}>
                  {expandedImg ? '높이 접기' : '전체 펼치기'}
                </button>
              ) : null}
              <button type="button" className="ktm-btn stl-mini-btn" onClick={() => openLightbox([item.image], 0, item.name)}>
                <SmsIcon name="zoom" /> 크게 보기
              </button>
            </div>
          ) : null}
        </div>
        {imgBroken ? (
          <div className="stl-media-state stl-media-state--err">
            <span>이미지를 불러오지 못했습니다.</span>
            <button type="button" className="ktm-btn" onClick={() => setExtImgError((prev) => ({ ...prev, [item.id]: false }))}>다시 시도</button>
          </div>
        ) : (
          <>
            <div className={`stl-media-viewport${expandedImg ? ' is-expanded' : ''}`}>
              <button type="button" className="stl-media-zoom-btn" onClick={() => openLightbox([item.image], 0, item.name)} title="클릭하면 원본 크기로 크게 봅니다">
                <img
                  className="stl-media-img"
                  src={item.image}
                  alt={`${item.name} 첨부 이미지`}
                  onLoad={(event) => {
                    const img = event.currentTarget;
                    if (img.naturalHeight > 360 && img.naturalHeight > img.naturalWidth * 1.1) {
                      setTallImgMap((prev) => (prev[`i-${item.id}`] ? prev : { ...prev, [`i-${item.id}`]: true }));
                    }
                  }}
                  onError={() => setExtImgError((prev) => ({ ...prev, [item.id]: true }))}
                />
              </button>
            </div>
          </>
        )}
      </section>
    ) : null;

    return (
      <article className="stl-detail" aria-label={`${item.name} 상세 보기`}>
        <div className="stl-detail-head">
          <button type="button" className="ktm-btn stl-back" onClick={() => setSelectedKey('')}>
            <SmsIcon name="back" /> 목록으로
          </button>
          <div className="stl-detail-meta">
            <span className={`stl-light stl-light--${light.tone}`}>{light.text}</span>
            {(() => {
              const ch = channelCostOf(item);
              return (
                <>
                  <span className="stl-meta-sep" aria-hidden="true">·</span>
                  <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
                </>
              );
            })()}
            {[item.audience.label, item.sender, item.ad ? '광고' : ''].filter(Boolean).map((part, idx) => (
              <React.Fragment key={`${idx}-${part}`}>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
            {(() => {
              const lastLabel = formatLastSentLabel(item.lastSentAt);
              return (
                <>
                  <span className="stl-meta-sep" aria-hidden="true">·</span>
                  <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
                    {lastLabel ? `최근 발송 ${lastLabel}` : '최근 7일 발송 없음'}
                  </span>
                </>
              );
            })()}
          </div>
          <h3 className="stl-detail-title">{item.name}</h3>
          {item.config?.status === 'incomplete' ? (
            <p className="ktm-alert stl-detail-banner" role="status">{item.config.label || '설정 미완료'}: 현재 자동 발송이 비활성화되어 있습니다.</p>
          ) : null}
          {item.policy?.status === 'paused' ? (
            <p className="ktm-warn stl-detail-banner" role="status">{item.policy.label || '정책 중단'}: 발송 전에 정책에 따라 중단됩니다.</p>
          ) : null}
        </div>

        <div className="stl-detail-split">
          {renderConditionBoard(summary, null, false, { count: item.count, lastSentAt: item.lastSentAt })}
          <div className={`stl-preview-stage${hasMedia ? ' has-media' : ''}`}>
            {msgCard}
            {mediaCard}
          </div>
        </div>
      </article>
    );
  };

  // 전체 화면 이미지 라이트박스 포털
  const renderLightbox = () => {
    if (!lightbox || typeof document === 'undefined') return null;
    const currentUrl = lightbox.urls[lightbox.index] || '';
    const autoFit = lightboxDims && lightboxDims.w > 0 && lightboxDims.h / lightboxDims.w > 1.5 ? 'width' : 'contain';
    const activeFit = lightboxFit === 'auto' ? autoFit : lightboxFit;
    return createPortal(
      <div className="stl-lb-backdrop" role="dialog" aria-modal="true" aria-label={`${lightbox.title} 이미지 원본 보기`} onMouseDown={(event) => { if (event.target === event.currentTarget) closeLightbox(); }}>
        <div className="stl-lb-head">
          <div className="stl-lb-title-wrap">
            <strong className="stl-lb-title">{lightbox.title}</strong>
            {lightbox.urls.length > 1 ? <span className="stl-lb-meta">{lightbox.index + 1} / {lightbox.urls.length}</span> : null}
            {lightboxDims ? <span className="stl-lb-meta">{lightboxDims.w} × {lightboxDims.h}px</span> : null}
          </div>
          <div className="stl-lb-tools">
            <button type="button" className={`stl-lb-btn${activeFit === 'width' ? ' is-active' : ''}`} onClick={() => setLightboxFit('width')}>너비 맞춤</button>
            <button type="button" className={`stl-lb-btn${activeFit === 'contain' ? ' is-active' : ''}`} onClick={() => setLightboxFit('contain')}>화면 맞춤</button>
            {lightbox.urls.length > 1 ? (
              <>
                <button type="button" className="stl-lb-btn" onClick={() => { setLightboxDims(null); setLightbox((prev) => ({ ...prev, index: (prev.index - 1 + prev.urls.length) % prev.urls.length })); }}>이전</button>
                <button type="button" className="stl-lb-btn" onClick={() => { setLightboxDims(null); setLightbox((prev) => ({ ...prev, index: (prev.index + 1) % prev.urls.length })); }}>다음</button>
              </>
            ) : null}
            <button ref={lbFocusRef} type="button" className="stl-lb-btn stl-lb-close" onClick={closeLightbox}>닫기 ×</button>
          </div>
        </div>
        <div className="stl-lb-stage" onMouseDown={(event) => { if (event.target === event.currentTarget) closeLightbox(); }}>
          <img
            className={`stl-lb-img stl-lb-img--${activeFit}`}
            src={currentUrl}
            alt={`${lightbox.title} 원본`}
            onLoad={(event) => setLightboxDims({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
          />
        </div>
      </div>,
      document.body,
    );
  };

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
    const visibleDisplayGroups = displayGroups
      .map((group) => ({
        ...group,
        pageMine: group.mineEntries.filter((entry) => pageSet.has(`run-${entry.id}`)),
        pageItems: group.items.filter((item) => pageSet.has(`i-${item.id}`)),
      }))
      .filter((group) => group.pageMine.length > 0 || group.pageItems.length > 0);
    const visibleFlows = flowRows.filter((row) => pageSet.has(row.key));
    body = (
      <>
        <div className="stl-toolbar">
          <div className="ktm-search stl-search">
            <SmsIcon name="search" />
            <input type="search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="이름·문구·조건 검색" aria-label="문자 템플릿 검색" />
          </div>
          <div className="ktm-pills" role="group" aria-label="발송 상태 거르기">
            {pills.map((pill) => (
              <button type="button" key={pill.id} className={`ktm-pill${!issueFilter && tab === pill.id ? ' is-active' : ''}`} aria-pressed={!issueFilter && tab === pill.id} onClick={() => pickFilter(pill.id)}>
                {pill.label} {pill.count}
              </button>
            ))}
          </div>
          <span className="stl-right">
            <select className="stl-cond-select" aria-label="발송 조건" value={cond} onChange={(event) => pickCond(event.target.value)}>
              <option value="">조건 전체</option>
              {CONDITION_GROUPS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {hasActiveFilters ? <button type="button" className="ktm-btn stl-reset-btn" onClick={resetFilters}>초기화</button> : null}
            <span className="stl-total">{paged.pages > 1 ? `총 ${rowKeys.length}건 · ${paged.page}/${paged.pages}쪽` : `총 ${rowKeys.length}건`}</span>
          </span>
        </div>

        {issueFilter && !isMineTab ? (
          <div className="stl-issue-active-bar" role="status">
            <span>지금 확인 중인 이슈: <strong>{SMS_ISSUE_LABELS[issueFilter] || issueFilter}</strong> ({rowKeys.length}건)</span>
            <button type="button" className="ktm-btn stl-mini-btn" onClick={resetFilters}>전체 보기</button>
          </div>
        ) : null}

        <div className={`stl-layout${selectedKey ? ' has-detail' : ''}`}>
          <section className="stl-list-pane" aria-label="문자 템플릿 목록">
            <div className="stl-list-card">
            {isMineTab ? (
              visibleFlows.length === 0
                ? <div className="ktm-empty">조건에 맞는 내 문구가 없습니다.</div>
                : (
                  <ul className="ktm-cards stl-cards">
                    {visibleFlows.map((row) => (row.single ? renderMineListCard(row.entry) : renderFlow(row, true)))}
                  </ul>
                )
            ) : visibleDisplayGroups.length === 0 ? (
              <div className="ktm-empty">조건에 맞는 문자 템플릿이 없습니다.</div>
            ) : visibleDisplayGroups.map((group) => (
              <section key={group.groupKey} className={`stl-group ${group.groupMod}`} aria-label={group.groupLabel}>
                <h3 className="stl-grouphead">
                  <span className="stl-grouphead-left">
                    <span>{group.groupLabel}</span>
                  </span>
                  <span className="ktm-kind-count">{group.mineEntries.length + group.items.length}</span>
                </h3>
                <ul className="ktm-cards stl-cards">
                  {group.pageMine.map((entry) => renderMineListCard(entry, 'run-'))}
                  {group.pageItems.map(renderItemListCard)}
                </ul>
              </section>
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
        </section>

          <section className="stl-detail-pane" aria-label="템플릿 미리보기 및 관리">
            {renderDetailPane()}
          </section>
        </div>
      </>
    );
  }

  if (isKakao) {
    if (!mySection) return null;
    return (
      <div className="ktm-root stl-rows stl-kakao" hidden={!active}>
        <div className="stl-kflow-topbar">
          <div>
            <h3 className="stl-grouphead stl-flowhead">자동 발송 조건 <span className="ktm-kind-count">{flowRows.length}</span></h3>
            <p className="stl-flowsub">조건별 발송 현황과 건당 단가를 한눈에 보고 바로 켜고 끄거나 시험 발송할 수 있습니다.</p>
          </div>
        </div>
        {mineError ? <p className="ktm-alert" role="alert">{mineError}</p> : null}
        <ul className="stl-kflow-grid">
          {flowRows.map((row) => (row.single ? renderMine(row.entry) : renderKakaoFlow(row)))}
        </ul>
        {adding ? (
          <SmsModal title={formOpts.startNew ? '문자 템플릿 단계 추가' : (editInit ? '문자 템플릿 수정' : '문자 템플릿 등록')} onClose={closeForm}>
            <SmsTextTemplateForm key={editInit?.id || 'new'} pausedText={catchupPausedText(autoStatus[editInit?.id])} initial={editInit || undefined} siblings={formOpts.siblings} startNew={Boolean(formOpts.startNew)} onSend={(id) => onSendText?.(id)} onSaved={() => loadMine(true)} onCancel={closeForm} />
          </SmsModal>
        ) : null}
        {renderLightbox()}
      </div>
    );
  }

  return (
    <div className="ktm-root stl-rows" hidden={!active}>
      <div className="ktm-header">
        <div>
          <h2 className="ktm-title">문자 템플릿</h2>
          <p className="ktm-sub">왼쪽에서 문자를 고르면, 오른쪽에 발송 조건과 실제 내용이 바로 보입니다.</p>
        </div>
        <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => setAdding(true)}>+ 템플릿 등록</button>
      </div>
      <SmsChannelStatusStrip
        channel="sms"
        active={active}
        autoStats={smsAutoStats}
        issues={smsIssues}
        onOpenLog={onOpenLog}
        onAttentionClick={() => pickFilter('attention')}
      />
      {body}
      {adding ? (
        <SmsModal title={formOpts.cloneFromName ? '같은 문구로 발송 조건 추가' : (formOpts.startNew ? '문자 템플릿 단계 추가' : (editInit?.id ? '문자 템플릿 수정' : '문자 템플릿 등록'))} onClose={closeForm}>
          <SmsTextTemplateForm
            key={editInit?.id || (formOpts.cloneFromName ? `clone-${formOpts.cloneFromName}` : 'new')}
            pausedText={catchupPausedText(autoStatus[editInit?.id])}
            initial={editInit || undefined}
            siblings={formOpts.siblings}
            startNew={Boolean(formOpts.startNew)}
            cloneFromName={formOpts.cloneFromName || ''}
            existingNames={formOpts.existingNames || []}
            onSend={(id) => onSendText?.(id)}
            onSaved={(savedItem) => {
              if (savedItem?.id) {
                pendingCreatedIdRef.current = savedItem.id;
                if (tab === 'in_use' && !savedItem.auto_enabled) setPicked('all');
                if (cond) setCond('');
                if (query.trim()) setQuery('');
              }
              loadMine(true);
            }}
            onCancel={closeForm}
          />
        </SmsModal>
      ) : null}
      {renderLightbox()}
    </div>
  );
}
