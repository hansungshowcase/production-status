import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clearSmsConsoleClientCache, fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import KakaoTemplatePreview from './KakaoTemplatePreview.jsx';
import KakaoTemplateForm from './KakaoTemplateForm.jsx';
import SmsModal from './SmsModal.jsx';
import SmsAutoControls from './SmsAutoControls.jsx';
import SmsTextTemplateForm from './SmsTextTemplateForm.jsx';
import SmsChannelStatusStrip from './SmsChannelStatusStrip.jsx';
import {
  buildConditionSummary, channelCostOf, compactLightLabel, flowStepText, formatLastSentLabel, groupFlows,
  isAttentionTone, isKakaoEntry, itemLight, kakaoDisplayCategory, matchesSmsQuery, paginateRows, sortByNameNumeric,
} from './smsTemplateListModel.js';
import { SENDERS } from '../../../shared/smsTemplateKinds.js';
import {
  BMS_TEMPLATE_ID, KIND_KAKAO, autoConditionLine, autoTargetText, catchupPausedText,
  cloneConditionInitial, formInitialFromItem, imageUrlsFromItem, linkedTextEntries, myTextSection, photoBadgeText, previewFill,
} from './smsTextTemplateFormModel.js';
import { autoEffective, autoLightClass } from '../../../shared/smsAutoEffective.js';
import {
  ACTION_LABELS, availableActions, deleteConfirmed, deleteDecision,
  failBadge, formatDate, isValidRename, readOnlyAudienceSections,
  readOnlyKakaoItems, statusInfo, statusPills, templateAudienceKind, templateExtras,
  usageBadge, usageCount, usageFail, usageLastAt, usageSuccess,
} from './templateListModel.js';
import './SmsAutoControls.css';
import './SmsTemplateList.css';
import './KakaoTemplateManager.css';

const nonMakeExtras = (templateId, sent) => {
  const extra = templateExtras(templateId, sent);
  return extra && extra.sender !== SENDERS.make ? extra : null;
};

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
// 바로 나가는 조건(주문 등록·공정 시작/완료·회원가입)은 단계를 더하면 중복 발송되므로 단계 추가 버튼 제외
const FLOW_NO_STEP_KINDS = ['order_created', 'process_started', 'process_completed', 'member_joined'];

const isDesktopViewport = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(min-width: 769px)').matches
  : true);

const formatKpiDate = (value) => {
  const s = String(value || '').trim();
  if (!s) return '없음';
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s;
};

const compactTimeText = (summary) => {
  if (!summary?.whenSub) return '';
  const cleaned = summary.whenSub.replace(/ 발송.*$/, '').replace(/\s*·\s*$/, '').trim();
  return /^(오전|오후|매일|당일|\d)/.test(cleaned) ? cleaned : '';
};

function Icon({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'plus') return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === 'lock') return <svg {...common}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>;
  if (name === 'back') return <svg {...common}><path d="M15 6l-6 6 6 6" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
  if (name === 'zoom') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /><path d="M11 8v6M8 11h6" /></svg>;
  return <svg {...common}><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></svg>;
}

// 최소한의 대화상자: Esc 닫기, 초점 가두기, 닫히면 원래 자리로 초점 복귀
function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector(FOCUSABLE);
    (first || node)?.focus();
    return () => { if (previous && previous.focus) previous.focus(); };
  }, []);
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = Array.from(ref.current?.querySelectorAll(FOCUSABLE) || []);
    if (items.length === 0) { event.preventDefault(); return; }
    const head = items[0];
    const tail = items[items.length - 1];
    if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
    else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
  };
  return (
    <div className="ktm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ktm-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
        <h3 className="ktm-modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function emphasizeLabel(type) {
  if (type === 'NONE' || !type) return '기본형';
  if (type === 'TEXT') return '강조표기형';
  if (type === 'IMAGE') return '이미지첨부형';
  if (type === 'ITEM_LIST') return '리스트형';
  return type;
}
function messageLabel(type) {
  if (type === 'BA' || !type) return '기본';
  if (type === 'EX') return '부가정보';
  if (type === 'AD') return '채널추가형';
  if (type === 'MI') return '복합형';
  return type;
}

export default function KakaoTemplateManager({
  active,
  selectedId,
  mode,
  onRoute,
  onOpenLog,
  onOpenChannelLog,
  onSend,
  onSendText,
}) {
  const [tplState, setTplState] = useState({ loading: false, loaded: false, error: null, status: 0, data: null });
  const [usage, setUsage] = useState(null);
  const [sent, setSent] = useState(null);
  const [textItems, setTextItems] = useState([]);
  const [autoStatusMap, setAutoStatusMap] = useState({});
  const [selectedBmsId, setSelectedBmsId] = useState(null);
  const [openRoId, setOpenRoId] = useState('');
  const [bmsDetailMap, setBmsDetailMap] = useState({}); // { [id]: { loading, error, item, photos, buttons } }
  const [query, setQuery] = useState('');
  const [pickedFilter, setPickedFilter] = useState(selectedId ? 'all' : 'in_use');
  const [inspectFilter, setInspectFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState(''); // '' | 'bms-zero-send'
  const [pageNo, setPageNo] = useState(1);
  const autoPickedRef = useRef(Boolean(selectedId));
  const [menuId, setMenuId] = useState('');
  const [dialog, setDialog] = useState(null);
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [autoModal, setAutoModal] = useState(null); // { title, initial, siblings, startNew, pausedText }
  const [deleteAutoConfirm, setDeleteAutoConfirm] = useState(null);
  const [copied, setCopied] = useState(false);
  const [copiedBody, setCopiedBody] = useState(false);
  const [previewFilled, setPreviewFilled] = useState(false);
  const [lightbox, setLightbox] = useState(null); // { urls, index, title }
  const [lightboxFit, setLightboxFit] = useState('auto');
  const [lightboxDims, setLightboxDims] = useState(null);
  const startedRef = useRef(false);
  const userClearedRef = useRef(false);
  const pendingCreatedRef = useRef(null);

  const loadTextItems = useCallback((force = false) => {
    if (force) clearSmsConsoleClientCache();
    return fetchSmsConsole('text_templates', {}, { bypassCache: force })
      .then((res) => {
        const itemsList = Array.isArray(res?.items) ? res.items : [];
        setTextItems(itemsList);
        const parsed = myTextSection(itemsList)?.items || [];
        const kakaoIds = parsed.filter(isKakaoEntry).map((entry) => entry.id);
        if (kakaoIds.length) {
          fetchSmsConsole('auto_status_batch', { ids: kakaoIds.join(',') }, { bypassCache: force })
            .then((batch) => {
              if (batch?.statuses && typeof batch.statuses === 'object') {
                setAutoStatusMap((prev) => ({ ...prev, ...batch.statuses }));
              }
            })
            .catch(() => {});
        }
        return itemsList;
      })
      .catch(() => []);
  }, []);

  const loadTemplates = useCallback(async ({ fresh = false } = {}) => {
    setTplState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await fetchSmsConsole('templates', fresh ? { fresh: 1 } : {}, { bypassCache: fresh });
      setTplState({ loading: false, loaded: true, error: null, status: 200, data });
    } catch (err) {
      setTplState((prev) => ({ ...prev, loading: false, loaded: true, error: err.message || '불러오지 못했습니다.', status: err.status || 0 }));
    }
  }, []);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    loadTemplates({ fresh: false });
    loadTextItems(false);
    fetchSmsConsole('usage_sent')
      .then((res) => {
        setUsage(res);
        setSent(Array.isArray(res?.groups) ? res.groups : null);
      })
      .catch(() => {});
  }, [active, loadTemplates, loadTextItems]);

  // URL에 tpl 이 생기면 BMS/외부 선택을 비운다
  useEffect(() => {
    if (selectedId) {
      setSelectedBmsId(null);
      setOpenRoId('');
    }
  }, [selectedId]);

  const ensureBmsDetail = useCallback((id, force = false) => {
    if (!id) return;
    if (!force && (bmsDetailMap[id]?.item || bmsDetailMap[id]?.loading)) return;
    setBmsDetailMap((prev) => ({ ...prev, [id]: { ...prev[id], loading: true, error: '' } }));
    fetchSmsConsole('text_template', { id })
      .then((res) => {
        const item = res?.item || null;
        setBmsDetailMap((prev) => ({
          ...prev,
          [id]: {
            loading: false,
            error: '',
            item,
            photos: imageUrlsFromItem(item),
            buttons: Array.isArray(item?.auto_bms_buttons) ? item.auto_bms_buttons : [],
          },
        }));
      })
      .catch((err) => {
        setBmsDetailMap((prev) => ({
          ...prev,
          [id]: { ...prev[id], loading: false, error: err.message || '상세 정보를 불러오지 못했습니다.' },
        }));
      });
  }, [bmsDetailMap]);

  useEffect(() => {
    if (active && selectedBmsId) ensureBmsDetail(selectedBmsId);
  }, [active, selectedBmsId, ensureBmsDetail]);

  // 메뉴 바깥 누름·Esc 로 ⋮ 메뉴 닫기
  useEffect(() => {
    if (!menuId) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && event.target.closest?.('.ktm-menu-wrap')) return;
      setMenuId('');
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menuId]);

  useEffect(() => {
    setCopiedBody(false);
    setPreviewFilled(false);
    setDeleteAutoConfirm(null);
  }, [selectedId, selectedBmsId, openRoId]);

  // 라이트박스 Esc / 화살표 이동
  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setLightbox(null); }
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

  const data = tplState.data;
  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const write = data?.write || null;
  const writeOff = Boolean(write && write.enabled === false);

  const kakaoMineEntries = useMemo(() => {
    const section = myTextSection(textItems);
    const list = section ? section.items.filter(isKakaoEntry) : [];
    return sortByNameNumeric(list);
  }, [textItems]);
  const kakaoMineById = useMemo(() => new Map(kakaoMineEntries.map((entry) => [entry.id, entry])), [kakaoMineEntries]);

  const effOf = useCallback(
    (entry) => autoEffective(autoStatusMap[entry.id] ?? (entry.autoEnabled ? null : { enabled: false })),
    [autoStatusMap],
  );

  // 브랜드메시지(BMS)는 문자용 080 줄을 쓰지 않는 운영 원칙(2026-11-18)이고 하루 상한 도달은 정상 발송 완료 상태이므로
  // 화면 신호등에서는 거짓 주의/경고 대신 초록 '켜짐'(상한 시 '오늘 상한 완료' 칩)으로 표시한다.
  const displayLightOf = useCallback((entry) => {
    const eff = effOf(entry);
    const st = autoStatusMap[entry.id] || null;
    if (eff.tone === 'part' && !eff.blocked && !st?.catchup_paused) {
      const skip = String(st?.auto_skip_reason || '').trim();
      const blockedCode = String(st?.enable_blocked_reason || '').trim();
      if (/^하루 상한/.test(skip)) {
        return { tone: 'on', label: '켜짐', note: skip, capNote: '오늘 상한 완료' };
      }
      if (!skip && blockedCode === 'no_optout_080') {
        return { tone: 'on', label: '켜짐', note: '', capNote: '' };
      }
    }
    return { tone: autoLightClass(eff), label: compactLightLabel(eff), note: eff.text, capNote: '' };
  }, [effOf, autoStatusMap]);

  // 직접 관리되는 브랜드메시지(자유형) + 연결 알림톡이 목록에 없는 예외 자동 문구
  const managedKakaoEntries = useMemo(() => {
    const bmsList = kakaoMineEntries.filter((entry) => entry.autoAtaTemplate === BMS_TEMPLATE_ID);
    const listedIds = new Set(items.map((item) => item.id));
    const orphans = items.length
      ? kakaoMineEntries.filter((entry) => entry.autoAtaTemplate && entry.autoAtaTemplate !== BMS_TEMPLATE_ID && !listedIds.has(entry.autoAtaTemplate))
      : [];
    return [...bmsList, ...orphans];
  }, [kakaoMineEntries, items]);

  const flowById = useMemo(() => {
    const map = new Map();
    groupFlows(kakaoMineEntries).forEach((flow) => flow.steps.forEach((step) => map.set(step.id, flow)));
    return map;
  }, [kakaoMineEntries]);

  const allReadOnly = useMemo(
    () => readOnlyKakaoItems(items, sent, { status: 'all', query: '' }).filter((entry) => entry.sender !== SENDERS.make),
    [items, sent],
  );

  // 현황판·알약·목록 1:1 일치 기준
  const hasLinkedOn = useCallback((ataId) => {
    const linkedList = linkedTextEntries(textItems, ataId);
    return linkedList.some((entry) => ['on', 'part'].includes(effOf(entry).tone));
  }, [textItems, effOf]);
  const isManagedActive = useCallback((entry) => ['on', 'part'].includes(effOf(entry).tone), [effOf]);
  const isRoActive = useCallback((entry) => itemLight(entry).tone === 'on', []);
  const isAtaActive = useCallback((item) => {
    if (item.status !== 'APPROVED') return false;
    const ex = nonMakeExtras(item.id, sent);
    if (ex && ex.off) return false;
    return Boolean(item.program_use || ex || hasLinkedOn(item.id) || (usageSuccess(usage, item.id, sent) ?? 0) > 0);
  }, [sent, hasLinkedOn, usage]);
  const isDbAttention = useCallback((entry) => isAttentionTone(displayLightOf(entry).tone) || Boolean(autoStatusMap[entry.id]?.catchup_paused), [displayLightOf, autoStatusMap]);
  const isAtaAttention = useCallback((item) => item.status === 'REJECTED' || Boolean(nonMakeExtras(item.id, sent)?.off), [sent]);
  const isRoAttention = useCallback((entry) => isAttentionTone(itemLight(entry).tone), []);

  const kakaoAutoStats = useMemo(() => {
    const activeManagedCount = managedKakaoEntries.filter(isManagedActive).length;
    const activeAtaCount = items.filter(isAtaActive).length;
    const activeRoCount = allReadOnly.filter(isRoActive).length;
    const ataOn = activeAtaCount
      + managedKakaoEntries.filter((entry) => entry.autoAtaTemplate !== BMS_TEMPLATE_ID && isManagedActive(entry)).length
      + allReadOnly.filter((entry) => entry.channel !== 'BMS' && isRoActive(entry)).length;
    const bmsOn = managedKakaoEntries.filter((entry) => entry.autoAtaTemplate === BMS_TEMPLATE_ID && isManagedActive(entry)).length
      + allReadOnly.filter((entry) => entry.channel === 'BMS' && isRoActive(entry)).length;
    const attention = managedKakaoEntries.filter(isDbAttention).length
      + items.filter(isAtaAttention).length
      + allReadOnly.filter(isRoAttention).length;
    return {
      on: activeAtaCount + activeManagedCount + activeRoCount,
      total: items.length + managedKakaoEntries.length + allReadOnly.length,
      ataOn,
      bmsOn,
      attention,
    };
  }, [managedKakaoEntries, items, allReadOnly, isManagedActive, isAtaActive, isRoActive, isDbAttention, isAtaAttention, isRoAttention]);

  // 상단 알약(발송 중·브랜드메시지·꺼짐·확인 필요·전체) + 우측 검수 상태 드롭다운(문자 템플릿과 통일)
  const inspectPills = useMemo(
    () => statusPills(items, usage, sent).filter((pill) => !['all', 'in_use'].includes(pill.id)),
    [items, usage, sent],
  );

  const pills = useMemo(() => {
    const bmsCount = managedKakaoEntries.length + allReadOnly.filter((entry) => entry.channel === 'BMS').length;
    return [
      { id: 'in_use', label: '발송 중', count: kakaoAutoStats.on },
      ...(bmsCount > 0 ? [{ id: 'bms', label: '브랜드메시지', count: bmsCount }] : []),
      { id: 'attention', label: '꺼짐·확인 필요', count: kakaoAutoStats.attention },
      { id: 'all', label: '전체', count: kakaoAutoStats.total },
    ];
  }, [kakaoAutoStats, managedKakaoEntries.length, allReadOnly]);

  useEffect(() => {
    if (!active || !tplState.loaded || !data || autoPickedRef.current) return;
    if (selectedId) {
      autoPickedRef.current = true;
      const selItem = items.find((item) => item.id === selectedId);
      if (selItem && !isAtaActive(selItem)) setPickedFilter('all');
      return;
    }
    if (usage === null) return;
    autoPickedRef.current = true;
    if (kakaoAutoStats.on === 0 && pickedFilter === 'in_use') setPickedFilter('all');
  }, [active, tplState.loaded, data, usage, selectedId, items, isAtaActive, kakaoAutoStats.on, pickedFilter]);

  const statusFilter = pickedFilter || 'all';

  const isBmsZeroSend = useCallback((entry) => {
    const st = autoStatusMap[entry.id];
    return Boolean(st && displayLightOf(entry).tone === 'on' && !(Number(st.sent_7d) > 0) && !st.last_sent_date);
  }, [autoStatusMap, displayLightOf]);
  const isManagedOnBlocked = useCallback((entry) => {
    if (!entry.autoEnabled) return false;
    return effOf(entry).tone === 'blocked' || Boolean(autoStatusMap[entry.id]?.catchup_paused);
  }, [effOf, autoStatusMap]);
  const isAtaOnBlocked = useCallback((item) => {
    if (item.status !== 'APPROVED') return false;
    const linkedList = linkedTextEntries(textItems, item.id);
    const linkedBlocked = linkedList.some((entry) => entry.autoEnabled && (effOf(entry).tone === 'blocked' || Boolean(autoStatusMap[entry.id]?.catchup_paused)));
    if (linkedBlocked) return true;
    const used = usageSuccess(usage, item.id, sent);
    return usageCount(usage, item.id) > 0 && used === 0 && !hasLinkedOn(item.id);
  }, [textItems, effOf, autoStatusMap, usage, sent, hasLinkedOn]);
  const isRoOnBlocked = useCallback((entry) => {
    const tone = itemLight(entry).tone;
    return Boolean((entry.make_on === true || entry.active) && (tone === 'blocked' || tone === 'part'));
  }, []);
  const isAtaZeroSend = useCallback((item) => {
    if (item.status !== 'APPROVED') return false;
    const linkedOn = linkedTextEntries(textItems, item.id).filter((entry) => entry.autoEnabled && ['on', 'part'].includes(effOf(entry).tone));
    if (!linkedOn.length) return false;
    return linkedOn.every((entry) => {
      const st = autoStatusMap[entry.id];
      return Boolean(st && !(Number(st.sent_7d) > 0) && !st.last_sent_date);
    });
  }, [textItems, effOf, autoStatusMap]);

  // 브랜드메시지(DB) 필터링
  const visibleManaged = useMemo(() => {
    if (inspectFilter) return [];
    if (issueFilter === 'kakao-on-blocked') {
      return managedKakaoEntries.filter((entry) => {
        if (!isManagedOnBlocked(entry)) return false;
        const bodyText = bmsDetailMap[entry.id]?.item?.body ?? entry.preview ?? '';
        return matchesSmsQuery({ ...entry, body: bodyText }, query);
      });
    }
    if (issueFilter === 'kakao-zero-send') {
      return managedKakaoEntries.filter((entry) => {
        if (!isBmsZeroSend(entry)) return false;
        const bodyText = bmsDetailMap[entry.id]?.item?.body ?? entry.preview ?? '';
        return matchesSmsQuery({ ...entry, body: bodyText }, query);
      });
    }
    if (!['in_use', 'all', 'bms', 'attention'].includes(statusFilter)) return [];
    return managedKakaoEntries.filter((entry) => {
      if (statusFilter === 'in_use' && !isManagedActive(entry)) return false;
      if (statusFilter === 'attention' && !isDbAttention(entry)) return false;
      const bodyText = bmsDetailMap[entry.id]?.item?.body ?? entry.preview ?? '';
      return matchesSmsQuery({ ...entry, body: bodyText }, query);
    });
  }, [inspectFilter, issueFilter, managedKakaoEntries, statusFilter, isManagedActive, isDbAttention, isManagedOnBlocked, isBmsZeroSend, bmsDetailMap, query]);

  const kakaoIssues = useMemo(() => {
    const rejectedCount = items.filter((item) => item.status === 'REJECTED').length;
    const pendingCount = items.filter((item) => item.status === 'PENDING').length;
    const inspectingCount = items.filter((item) => item.status === 'INSPECTING').length;
    const onBlockedCount = managedKakaoEntries.filter(isManagedOnBlocked).length
      + items.filter(isAtaOnBlocked).length
      + allReadOnly.filter(isRoOnBlocked).length;
    const zeroSendCount = managedKakaoEntries.filter(isBmsZeroSend).length + items.filter(isAtaZeroSend).length;
    const toggleInspect = (status) => {
      userClearedRef.current = false;
      setIssueFilter('');
      setPickedFilter('all');
      setQuery('');
      setInspectFilter((prev) => (prev === status ? '' : status));
      setPageNo(1);
      setSelectedBmsId(null);
      setOpenRoId('');
    };
    const toggleIssue = (key) => {
      userClearedRef.current = false;
      setIssueFilter((prev) => (prev === key ? '' : key));
      setPickedFilter('all');
      setInspectFilter('');
      setQuery('');
      setPageNo(1);
      setSelectedBmsId(null);
      setOpenRoId('');
    };
    return [
      ...(onBlockedCount > 0 ? [{ key: 'kakao-on-blocked', tone: 'danger', label: '켜짐 · 발송 막힘', count: onBlockedCount, active: issueFilter === 'kakao-on-blocked', onClick: () => toggleIssue('kakao-on-blocked') }] : []),
      { key: 'kakao-zero-send', tone: 'info', label: '켜짐 · 최근 발송 없음', count: zeroSendCount, active: issueFilter === 'kakao-zero-send', onClick: () => toggleIssue('kakao-zero-send') },
      { key: 'ata-inspecting', tone: 'info', label: '검수 중', count: inspectingCount, active: inspectFilter === 'INSPECTING', onClick: () => toggleInspect('INSPECTING') },
      { key: 'ata-pending', tone: 'warn', label: '검수 전', count: pendingCount, active: inspectFilter === 'PENDING', onClick: () => toggleInspect('PENDING') },
      { key: 'ata-rejected', tone: 'warn', label: '검수 반려', count: rejectedCount, active: inspectFilter === 'REJECTED', onClick: () => toggleInspect('REJECTED') },
    ];
  }, [items, managedKakaoEntries, allReadOnly, isManagedOnBlocked, isAtaOnBlocked, isRoOnBlocked, isBmsZeroSend, isAtaZeroSend, inspectFilter, issueFilter]);

  // 알림톡 필터링(알약 상태 + 검수 상태 드롭다운 + 검색어, 띄어쓰기 무시)
  const visible = useMemo(() => {
    if (statusFilter === 'bms') return [];
    if (issueFilter === 'kakao-on-blocked' || issueFilter === 'kakao-zero-send') {
      const pred = issueFilter === 'kakao-on-blocked' ? isAtaOnBlocked : isAtaZeroSend;
      const q = String(query || '').trim().toLowerCase();
      const qNoSpace = q.replace(/\s+/g, '');
      return items.filter((item) => {
        if (!pred(item)) return false;
        if (!q) return true;
        const name = String(item.name || '').toLowerCase();
        const id = String(item.id || '').toLowerCase();
        if (name.includes(q) || id.includes(q) || (qNoSpace && name.replace(/\s+/g, '').includes(qNoSpace))) return true;
        const linkedEntries = linkedTextEntries(textItems, item.id);
        return linkedEntries.some((entry) => matchesSmsQuery(entry, q));
      });
    }
    const q = String(query || '').trim().toLowerCase();
    const qNoSpace = q.replace(/\s+/g, '');
    return items.filter((item) => {
      if (inspectFilter && item.status !== inspectFilter) return false;
      if (statusFilter === 'in_use') {
        if (!isAtaActive(item)) return false;
      } else if (statusFilter === 'attention') {
        if (!isAtaAttention(item)) return false;
      }
      if (!q) return true;
      const name = String(item.name || '').toLowerCase();
      const id = String(item.id || '').toLowerCase();
      if (name.includes(q) || id.includes(q) || (qNoSpace && name.replace(/\s+/g, '').includes(qNoSpace))) return true;
      const extras = nonMakeExtras(item.id, sent);
      if (extras && [extras.trigger, extras.who, extras.sender].some((v) => String(v || '').toLowerCase().includes(q) || (qNoSpace && String(v || '').toLowerCase().replace(/\s+/g, '').includes(qNoSpace)))) return true;
      const linkedEntries = linkedTextEntries(textItems, item.id);
      return linkedEntries.some((entry) => matchesSmsQuery(entry, q));
    });
  }, [issueFilter, statusFilter, inspectFilter, query, items, isAtaOnBlocked, isAtaZeroSend, isAtaActive, sent, isAtaAttention, textItems]);

  const readOnly = useMemo(() => {
    if (inspectFilter || issueFilter === 'kakao-zero-send') return [];
    const roStatus = statusFilter === 'in_use' ? 'in_use' : 'all';
    const list = readOnlyKakaoItems(items, sent, { status: roStatus, query })
      .filter((entry) => entry.sender !== SENDERS.make)
      .filter((entry) => (issueFilter === 'kakao-on-blocked' ? isRoOnBlocked(entry) : true))
      .filter((entry) => (statusFilter === 'in_use' ? isRoActive(entry) : true))
      .filter((entry) => (statusFilter === 'bms' ? entry.channel === 'BMS' : true))
      .filter((entry) => (statusFilter === 'attention' ? isRoAttention(entry) : true));
    return list;
  }, [inspectFilter, issueFilter, items, sent, statusFilter, query, isRoOnBlocked, isRoActive, isRoAttention]);

  // 비즈니스 카테고리(리뷰 이벤트 · 소개/혜택 · 주문/출고 · 상담/문의 · 직원 알림)로 통일 묶기
  const displayGroups = useMemo(() => {
    const byGroup = new Map();
    const ensure = (meta) => {
      let g = byGroup.get(meta.groupKey);
      if (!g) {
        g = { ...meta, rows: [] };
        byGroup.set(meta.groupKey, g);
      }
      return g;
    };
    visibleManaged.forEach((entry) => {
      ensure(kakaoDisplayCategory({ name: entry.name, audience: '고객' }, '이벤트·혜택')).rows.push({ type: 'bms', key: `bms-${entry.id}`, entry });
    });
    visible.forEach((item) => {
      const info = templateAudienceKind(item.id, sent);
      ensure(kakaoDisplayCategory({ name: item.name, audience: info.audience, kind: info.kind }, info.kind)).rows.push({ type: 'ata', key: `ata-${item.id}`, item });
    });
    return [...byGroup.values()].sort((a, b) => a.order - b.order);
  }, [visibleManaged, visible, sent]);
  const readOnlySections = useMemo(() => readOnlyAudienceSections(readOnly), [readOnly]);
  const rowKeys = useMemo(() => {
    const keys = [];
    displayGroups.forEach((group) => group.rows.forEach((r) => keys.push(r.key)));
    readOnlySections.forEach((group) => {
      group.items.forEach((entry) => keys.push(`ro-${entry.id}`));
    });
    return keys;
  }, [displayGroups, readOnlySections]);

  const paged = paginateRows(rowKeys, pageNo, 20);
  const pageSet = new Set(paged.rows);

  const pickFilter = (id) => {
    userClearedRef.current = false;
    setIssueFilter('');
    setPickedFilter(id);
    setPageNo(1);
    setSelectedBmsId(null);
    setOpenRoId('');
  };
  const pickInspect = (val) => {
    userClearedRef.current = false;
    setIssueFilter('');
    setInspectFilter(val);
    setPageNo(1);
    setSelectedBmsId(null);
    setOpenRoId('');
  };
  const changeQuery = (val) => {
    userClearedRef.current = false;
    setQuery(val);
    setPageNo(1);
  };
  const goPage = (next) => {
    userClearedRef.current = false;
    setPageNo(next);
    setSelectedBmsId(null);
    setOpenRoId('');
  };
  const hasActiveFilters = Boolean(query.trim() || inspectFilter || issueFilter || (statusFilter !== 'in_use' && statusFilter !== 'all'));
  const resetFilters = () => {
    userClearedRef.current = false;
    setQuery('');
    setInspectFilter('');
    setIssueFilter('');
    setPickedFilter(kakaoAutoStats.on > 0 ? 'in_use' : 'all');
    setPageNo(1);
    setSelectedBmsId(null);
    setOpenRoId('');
  };

  // "같은 문구로 조건 추가" 저장 직후 새 항목이 목록에 들어오면 해당 쪽으로 이동하고 바로 선택한다
  useEffect(() => {
    const pending = pendingCreatedRef.current;
    if (!pending || !pending.id) return;
    const isManaged = managedKakaoEntries.some((entry) => entry.id === pending.id);
    const rowKey = isManaged ? `bms-${pending.id}` : (pending.ata ? `ata-${pending.ata}` : '');
    if (!rowKey || !rowKeys.includes(rowKey)) return;
    const idx = rowKeys.indexOf(rowKey);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / 20) + 1;
      if (targetPage !== pageNo) setPageNo(targetPage);
    }
    setOpenRoId('');
    if (isManaged) {
      if (selectedId) onRoute({ tpl: '', mode: '' });
      setSelectedBmsId(pending.id);
      ensureBmsDetail(pending.id, true);
    } else if (pending.ata && selectedId !== pending.ata) {
      setSelectedBmsId(null);
      onRoute({ tpl: pending.ata, mode: '' });
    }
    pendingCreatedRef.current = null;
  }, [managedKakaoEntries, rowKeys, pageNo, selectedId, onRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  // URL tpl 또는 선택된 BMS 항목이 다른 쪽에 있으면 해당 쪽으로 자동 이동
  useEffect(() => {
    const key = selectedId ? `ata-${selectedId}` : (selectedBmsId ? `bms-${selectedBmsId}` : '');
    if (!key) return;
    const idx = rowKeys.indexOf(key);
    if (idx >= 0) {
      const targetPage = Math.floor(idx / 20) + 1;
      if (targetPage !== pageNo) setPageNo(targetPage);
    }
  }, [selectedId, selectedBmsId, rowKeys]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = selectedId ? items.find((item) => item.id === selectedId) || null : null;
  const selectedBms = !selectedId && selectedBmsId ? kakaoMineById.get(selectedBmsId) || null : null;
  const formOpen = mode === 'new' || (mode === 'edit' && selected);

  // 데스크톱 첫 진입·쪽 이동 시 현재 쪽 최상단 항목 자동 선택
  useEffect(() => {
    if (!active || !tplState.loaded || !data || mode === 'new' || mode === 'edit' || userClearedRef.current || pendingCreatedRef.current) return;
    if (!isDesktopViewport()) return;
    const activeKey = selectedId ? `ata-${selectedId}` : (selectedBmsId ? `bms-${selectedBmsId}` : (openRoId ? `ro-${openRoId}` : ''));
    if (activeKey && pageSet.has(activeKey)) return;
    const firstKey = paged.rows[0] || '';
    if (!firstKey) {
      if (selectedId) onRoute({ tpl: '', mode: '' });
      if (selectedBmsId) setSelectedBmsId(null);
      if (openRoId) setOpenRoId('');
      return;
    }
    if (firstKey.startsWith('bms-')) {
      const id = Number(firstKey.slice(4));
      if (selectedId) onRoute({ tpl: '', mode: '' });
      setOpenRoId('');
      if (selectedBmsId !== id) setSelectedBmsId(id);
    } else if (firstKey.startsWith('ata-')) {
      const id = firstKey.slice(4);
      setSelectedBmsId(null);
      setOpenRoId('');
      if (selectedId !== id) onRoute({ tpl: id, mode: '' });
    } else if (firstKey.startsWith('ro-')) {
      const id = firstKey.slice(3);
      if (selectedId) onRoute({ tpl: '', mode: '' });
      setSelectedBmsId(null);
      if (openRoId !== id) setOpenRoId(id);
    }
  }, [active, tplState.loaded, data, mode, selectedId, selectedBmsId, openRoId, paged.rows, onRoute]); // eslint-disable-line react-hooks/exhaustive-deps

  // ----- 자동 발송(브랜드메시지 · 알림톡 연결 문구) 모달 열기/저장/삭제 -----
  const loadSingleInit = (id) => fetchSmsConsole('text_template', { id }).then((res) => formInitialFromItem(res?.item));

  const openNewBms = () => {
    setNotice(null);
    setAutoModal({
      title: '브랜드메시지 등록',
      initial: { id: undefined, autoKind: 'ship_plus_days', days: '2', ataTemplate: BMS_TEMPLATE_ID },
      siblings: undefined,
      startNew: false,
      pausedText: '',
    });
  };

  const openAutoSetting = (ataId) => {
    setNotice(null);
    const existing = linkedTextEntries(textItems, ataId);
    if (existing.length === 1) {
      loadSingleInit(existing[0].id).then((init) => {
        setAutoModal({
          title: '알림톡 자동 발송 수정',
          initial: init,
          siblings: undefined,
          startNew: false,
          pausedText: catchupPausedText(autoStatusMap[existing[0].id]),
        });
      }).catch((err) => setNotice({ kind: 'error', text: err.message || '불러오지 못했습니다.' }));
      return;
    }
    setAutoModal({
      title: '이 알림톡으로 자동 발송 설정',
      initial: { id: undefined, autoKind: 'ship_plus_days', days: '2', ataTemplate: ataId },
      siblings: undefined,
      startNew: false,
      pausedText: '',
    });
  };

  const editAutoEntry = (entry) => {
    const flow = flowById.get(entry.id);
    const siblingsPromise = flow && flow.steps.length > 1
      ? Promise.all(flow.steps.map((step) => loadSingleInit(step.id)))
      : Promise.resolve(undefined);
    Promise.all([loadSingleInit(entry.id), siblingsPromise])
      .then(([init, siblings]) => {
        setAutoModal({
          title: entry.autoAtaTemplate === BMS_TEMPLATE_ID ? '브랜드메시지 수정' : '알림톡 자동 발송 수정',
          initial: init,
          siblings,
          startNew: false,
          pausedText: catchupPausedText(autoStatusMap[entry.id]),
        });
      })
      .catch((err) => setNotice({ kind: 'error', text: err.message || '불러오지 못했습니다.' }));
  };

  const addStepForFlow = (flow) => {
    Promise.all(flow.steps.map((step) => loadSingleInit(step.id)))
      .then((siblings) => {
        const last = siblings[siblings.length - 1];
        setAutoModal({
          title: '자동 발송 단계 추가',
          initial: { ...last, id: undefined, name: '', body: '', images: [] },
          siblings,
          startNew: true,
          pausedText: '',
        });
      })
      .catch((err) => setNotice({ kind: 'error', text: err.message || '불러오지 못했습니다.' }));
  };

  const cloneAutoEntry = (entry) => {
    setNotice(null);
    const existingNames = textItems.map((m) => m.name);
    loadSingleInit(entry.id)
      .then((init) => {
        setAutoModal({
          title: '같은 문구로 발송 조건 추가',
          initial: cloneConditionInitial(init, existingNames),
          siblings: undefined,
          startNew: false,
          cloneFromName: entry.name,
          existingNames,
          pausedText: '',
        });
      })
      .catch((err) => setNotice({ kind: 'error', text: err.message || '불러오지 못했습니다.' }));
  };

  const refreshAfterAutoChange = async (editedId = null) => {
    await loadTextItems(true);
    if (editedId && bmsDetailMap[editedId]) {
      ensureBmsDetail(editedId, true);
    }
    if (selectedBmsId) ensureBmsDetail(selectedBmsId, true);
  };

  const closeAutoModal = () => {
    const editedId = autoModal?.initial?.id || null;
    setAutoModal(null);
    refreshAfterAutoChange(editedId);
  };

  const deleteAutoEntry = async (entry) => {
    if (deleteAutoConfirm !== entry.id) {
      setDeleteAutoConfirm(entry.id);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await postSmsConsole('text_template_delete', { id: entry.id });
      setDeleteAutoConfirm(null);
      if (selectedBmsId === entry.id) setSelectedBmsId(null);
      setNotice({ kind: 'ok', text: `“${entry.name}” 자동 발송을 삭제했습니다.` });
      await loadTextItems();
    } catch (err) {
      setNotice({ kind: 'error', text: err.message || '삭제하지 못했습니다.' });
    } finally {
      setBusy(false);
    }
  };

  // ----- 쏠라피 알림톡 쓰기 -----
  const requireWrite = (run) => {
    if (writeOff) { setNotice({ kind: 'error', text: '등록·삭제가 꺼져 있습니다' }); return; }
    run();
  };
  const doWrite = (action, body) => postSmsConsole(action, body);
  const afterWrite = async (text, warning) => {
    setNotice({ kind: 'ok', text: warning ? `${text} ${warning}` : text });
    await loadTemplates({ fresh: true });
  };
  const closeDialog = () => { setDialog(null); setDialogError(''); };

  const submitDialog = (type, item, body) => {
    const run = async () => {
      setBusy(true);
      setDialogError('');
      try {
        await doWrite(type, { id: item.id, ...body });
        closeDialog();
        const messages = {
          rename: '이름을 바꿨습니다.', inspect: '검수를 요청했습니다.',
          cancel_inspect: '검수 요청을 취소했습니다.', delete: '템플릿을 삭제했습니다.',
        };
        if (type === 'delete' && selectedId === item.id) onRoute({ tpl: '' });
        await afterWrite(messages[type] || '완료했습니다.');
      } catch (err) {
        setDialogError(err.message || '실패했습니다.');
      } finally {
        setBusy(false);
      }
    };
    requireWrite(run);
  };

  const submitForm = (value, extra) => {
    const editing = mode === 'edit' && selected;
    const run = async () => {
      setBusy(true);
      setFormError('');
      try {
        const result = editing
          ? await doWrite('update', { id: selected.id, template: value })
          : await doWrite('create', { template: value, requestInspection: Boolean(extra?.requestInspection), comment: extra?.comment || '' });
        const newId = editing ? selected.id : result.item?.id;
        await afterWrite(editing ? '수정했습니다.' : '템플릿을 등록했습니다.', result.warning);
        setPickedFilter('all');
        onRoute({ mode: '', tpl: newId || '' });
      } catch (err) {
        setFormError(err.message || '실패했습니다.');
      } finally {
        setBusy(false);
      }
    };
    return new Promise((resolve) => { requireWrite(run); resolve(); });
  };

  const runAction = (action, item) => {
    setMenuId('');
    setNotice(null);
    if (action === 'today_log') { onOpenLog?.(item.id); return; }
    if (action === 'send') { onSend?.(item.id); return; }
    if (action === 'edit') { setFormError(''); onRoute({ tpl: item.id, mode: 'edit' }); return; }
    setDialogError('');
    setDialog({ type: action, item });
  };

  const copyId = async (id) => {
    try { await navigator.clipboard.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };

  const copyBody = async (text) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedBody(true);
      setTimeout(() => setCopiedBody(false), 1600);
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
        setCopiedBody(true);
        setTimeout(() => setCopiedBody(false), 1600);
      } catch { setCopiedBody(false); }
    }
  };

  const openLightbox = (urls, index, title) => {
    if (!Array.isArray(urls) || !urls.length) return;
    setLightbox({ urls, index: Math.max(0, Math.min(urls.length - 1, index || 0)), title: title || '첨부 이미지' });
    setLightboxFit('auto');
    setLightboxDims(null);
  };

  const lockBar = data && writeOff
    ? <div className="ktm-lockbar ktm-lockbar--off"><Icon name="lock" /><span>등록·삭제가 꺼져 있습니다(서버 설정 SMS_CONSOLE_WRITE=off)</span></div>
    : null;

  const renderConditionBoard = (summary, st, isMineAuto = true, catalogStats = null, onCloneCondition = null) => {
    const todayCount = Number(st?.today_targets) || 0;
    const recent7d = Number(st?.sent_7d) || 0;
    const sentTotal = Number(st?.sent_total) || 0;
    const uncertain = Number(st?.uncertain_total) || 0;
    return (
      <section className="stl-cond-board ktm-cond-board" aria-label="적용된 발송 조건">
        <div className="stl-section-eyebrow">발송 조건 · 현황</div>
        <div className="stl-cond-grid">
          <div className="stl-cond-tile stl-cond-tile--when">
            <span className="stl-cond-label">언제 보낼까</span>
            <strong className="stl-cond-val">{summary.whenMain}</strong>
            {summary.whenSub ? <span className="stl-cond-sub">{summary.whenSub}</span> : null}
          </div>
          <div className="stl-cond-tile">
            <span className="stl-cond-label">누구에게</span>
            <strong className="stl-cond-val">{summary.whoMain}</strong>
            {summary.whoSub ? <span className="stl-cond-sub">{summary.whoSub}</span> : null}
          </div>
          <div className="stl-cond-tile">
            <span className="stl-cond-label">{isMineAuto ? '횟수 · 비용' : '종류 · 비용'}</span>
            <strong className="stl-cond-val">{summary.howMain}</strong>
            {summary.howSub ? <span className="stl-cond-sub">{summary.howSub}</span> : null}
          </div>
        </div>
        {summary.catchup && !summary.catchup.includes('발송 완료됨') ? <div className="stl-cond-catchup" role="status">{summary.catchup}</div> : null}
        {summary.tags.length > 0 ? (
          <div className="stl-cond-tags" aria-label="세부 규칙">
            <span className="stl-cond-tags-label">세부 규칙</span>
            {summary.tags.map((tag) => <span key={tag} className="stl-rule-chip">{tag}</span>)}
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
                <strong className="stl-kpi-val">{formatLastSentLabel(st.last_sent_date) || '기록 없음'}</strong>
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
  };

  // ----- 오른쪽 상세: 브랜드메시지(DB 자동 발송) -----
  const renderBmsDetail = (entry) => {
    const st = autoStatusMap[entry.id] || null;
    const eff = effOf(entry);
    const light = displayLightOf(entry);
    const ch = channelCostOf(entry);
    const summary = buildConditionSummary(entry, { isMine: true });
    const paused = catchupPausedText(st);
    const detail = bmsDetailMap[entry.id] || {};
    const rawBody = String(detail.item?.body ?? '');
    const photos = detail.photos || [];
    const buttons = detail.buttons || [];
    const isBms = entry.autoAtaTemplate === BMS_TEMPLATE_ID;
    const isAd = /^\(광고\)/.test(rawBody.trim());
    const hasVars = /#\{[^{}\n]{1,40}\}/.test(rawBody);
    const lastLabel = formatLastSentLabel(st?.last_sent_date);

    return (
      <article className="stl-detail ktm-detail-sheet">
        <div className="stl-detail-head">
          <button type="button" className="ktm-btn stl-back" onClick={() => { userClearedRef.current = true; setSelectedBmsId(null); }}>
            <Icon name="back" /> 목록
          </button>
          <div className="stl-detail-meta">
            <span className={`stl-light stl-light--${light.tone}`}>{light.label}</span>
            {light.capNote ? (
              <>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span className="ktm-badge ktm-badge--info">{light.capNote}</span>
              </>
            ) : null}
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span>내 문구 · 고객</span>
            {entry.hasImage ? (
              <>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{photoBadgeText(entry)}</span>
              </>
            ) : null}
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {lastLabel ? `최근 발송 ${lastLabel}` : (st ? '발송 기록 없음' : '발송 확인 중')}
            </span>
          </div>
          <div className="stl-detail-titlebar">
            <h3 className="stl-detail-title">{entry.name}</h3>
            <div className="stl-detail-actions">
              <SmsAutoControls
                compact
                key={entry.id}
                id={entry.id}
                enabled={Boolean(st?.enabled ?? entry.autoEnabled)}
                photos={entry.imageCount}
                ata={!isBms}
                bms={isBms}
                onChanged={() => refreshAfterAutoChange(entry.id)}
              >
                <button type="button" className="ktm-btn" onClick={() => editAutoEntry(entry)}>수정</button>
                <button type="button" className="ktm-btn ktm-btn--danger-outline" disabled={busy} onClick={() => deleteAutoEntry(entry)}>
                  {deleteAutoConfirm === entry.id ? '삭제 확인' : '삭제'}
                </button>
              </SmsAutoControls>
            </div>
          </div>
          {paused ? (
            <p className="ktm-alert stl-detail-banner" role="alert">
              {paused}
              <span className="stl-detail-banner-sub"> (일반 자동 발송은 계속 켜져 있습니다)</span>
            </p>
          ) : null}
          {!paused && light.capNote ? (
            <p className="ktm-cap-note" role="status">{light.note}</p>
          ) : !paused && (eff.tone === 'blocked' || light.tone === 'part') ? (
            <p className={eff.tone === 'blocked' ? 'ktm-alert stl-detail-banner' : 'ktm-warn stl-detail-banner'} role="status">{light.note}</p>
          ) : null}
        </div>

        <div className="stl-detail-split">
          <div className="ktm-cond-col">
            {renderConditionBoard(summary, st, true, null, () => cloneAutoEntry(entry))}
          </div>

          {detail.loading && !detail.item ? (
            <div className="ktm-preview-stage">
              <div className="stl-card-subhead">
                <div className="stl-card-subhead-left">
                  <span className="stl-card-subhead-title">실제 발송 내용</span>
                </div>
              </div>
              <div className="ktm-empty">문구와 첨부 사진을 불러오는 중…</div>
            </div>
          ) : detail.error && !detail.item ? (
            <div className="ktm-preview-stage">
              <div className="ktm-error" role="alert">
                <p>{detail.error}</p>
                <button type="button" className="ktm-btn" onClick={() => ensureBmsDetail(entry.id, true)}>다시 시도</button>
              </div>
            </div>
          ) : (
            <div className={`stl-preview-stage ktm-preview-stage${photos.length > 0 ? ' has-media' : ''}`}>
              <section className="stl-msg-card" aria-label="발송 문구">
                <div className="stl-card-subhead">
                  <div className="stl-card-subhead-left">
                    <span className="stl-card-subhead-title">실제 발송 내용</span>
                    {rawBody ? <span className="stl-char-count">{rawBody.length}자</span> : null}
                  </div>
                  <div className="stl-card-subhead-right">
                    {rawBody && hasVars ? (
                      <button type="button" className={`ktm-btn stl-mini-btn${previewFilled ? ' is-active' : ''}`} onClick={() => setPreviewFilled((v) => !v)}>
                        {previewFilled ? '원래 양식 보기' : '실제 예시로 보기'}
                      </button>
                    ) : null}
                    {rawBody ? (
                      <button type="button" className="ktm-btn stl-mini-btn" onClick={() => copyBody(rawBody)}>
                        <Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}
                      </button>
                    ) : null}
                  </div>
                </div>
                <KakaoTemplatePreview
                  hideImage={photos.length > 0}
                  banner={isBms ? (isAd ? '브랜드메시지 (광고)' : '브랜드메시지') : '알림톡 도착'}
                  template={{
                    name: entry.name,
                    content: previewFilled ? previewFill(rawBody) : rawBody,
                    emphasizeType: photos.length ? 'IMAGE' : 'NONE',
                    imageUrl: photos[0] || '',
                    buttons: buttons.map((b) => ({ type: 'WL', name: b.name })),
                    targetName: '한성쇼케이스그룹',
                  }}
                />
                {buttons.length > 0 ? (
                  <div className="ktm-link-strip">
                    <span className="ktm-link-strip-label">버튼 연결 주소</span>
                    <ul className="ktm-bms-links">
                      {buttons.map((b, i) => (
                        <li key={`${b.name}-${i}`}>
                          <strong>{b.name}</strong>
                          <span>{b.link}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              {photos.length > 0 ? (
                <section className="stl-media-card" aria-label="첨부 이미지">
                  <div className="stl-card-subhead">
                    <div className="stl-card-subhead-left">
                      <span className="stl-card-subhead-title">첨부 사진</span>
                      <span className="stl-char-count">{photos.length}장</span>
                    </div>
                    <div className="stl-card-subhead-right">
                      <button type="button" className="ktm-btn stl-mini-btn" onClick={() => openLightbox(photos, 0, entry.name)}>
                        <Icon name="zoom" /> 크게 보기
                      </button>
                    </div>
                  </div>
                  <div className="stl-media-viewport">
                    <div className="stl-media-stack">
                      {photos.map((url, idx) => (
                        <button key={idx} type="button" className="stl-media-zoom-btn" onClick={() => openLightbox(photos, idx, entry.name)} title="클릭하면 원본 크기로 크게 봅니다">
                          <img className="stl-media-img" src={url} alt={`${entry.name} 첨부 사진 ${idx + 1}`} />
                        </button>
                      ))}
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          )}
        </div>
      </article>
    );
  };

  // ----- 오른쪽 상세: 외부 연동(읽기 전용) -----
  const renderReadOnlyDetail = (entry) => {
    const ch = channelCostOf(entry, { ataUnit: data?.ata_unit ?? 13 });
    const light = itemLight(entry);
    const summary = buildConditionSummary(entry, { isMine: false });
    const roLastLabel = formatLastSentLabel(entry.lastSentAt);
    return (
      <article className="stl-detail ktm-detail-sheet">
        <div className="stl-detail-head">
          <button type="button" className="ktm-btn stl-back" onClick={() => { userClearedRef.current = true; setOpenRoId(''); }}><Icon name="back" /> 목록</button>
          <div className="stl-detail-meta">
            <span className={`stl-light stl-light--${light.tone}`}>{light.text}</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
            {[entry.audience || '고객', entry.sender].filter(Boolean).map((part, idx) => (
              <React.Fragment key={`${idx}-${part}`}>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`stl-last-sent ${roLastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {roLastLabel ? `최근 발송 ${roLastLabel}` : '최근 7일 발송 없음'}
            </span>
          </div>
          <div className="stl-detail-titlebar">
            <h3 className="stl-detail-title">{entry.name}</h3>
            {entry.body ? (
              <div className="stl-detail-actions">
                <div className="stl-detail-btnrow">
                  <button type="button" className="ktm-btn" onClick={() => copyBody(entry.body)}><Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}</button>
                  {entry.image ? (
                    <button type="button" className="ktm-btn" onClick={() => openLightbox([entry.image], 0, entry.name)}>
                      <Icon name="zoom" /> 크게 보기
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="stl-detail-split">
          <div className="ktm-cond-col">
            {renderConditionBoard(summary, null, false, { count: entry.count, lastSentAt: entry.lastSentAt })}
          </div>

          <div className={`stl-preview-stage ktm-preview-stage${entry.image ? ' has-media' : ''}`}>
            <section className="stl-msg-card" aria-label="발송 문구">
              <div className="stl-card-subhead">
                <div className="stl-card-subhead-left">
                  <span className="stl-card-subhead-title">실제 발송 내용</span>
                  {entry.body ? <span className="stl-char-count">{entry.body.length}자</span> : null}
                </div>
                <div className="stl-card-subhead-right">
                  {entry.body ? (
                    <button type="button" className="ktm-btn stl-mini-btn" onClick={() => copyBody(entry.body)}>
                      <Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}
                    </button>
                  ) : null}
                </div>
              </div>
              <KakaoTemplatePreview
                hideImage={Boolean(entry.image)}
                banner={entry.channel === 'BMS' ? '브랜드메시지' : '알림톡 도착'}
                template={{
                  name: entry.name, content: entry.body || '', emphasizeType: entry.image ? 'IMAGE' : undefined, imageUrl: entry.image || '',
                  buttons: [], targetName: entry.sender || '',
                }}
              />
              <details className="ktm-tech-details">
                <summary>연동 상세 정보 보기</summary>
                <dl className="ktm-info">
                  <dt>종류 · 비용</dt><dd>{[ch.kindLabel, ch.costDetail].filter(Boolean).join(' · ')}</dd>
                  <dt>보내는 곳</dt><dd>{entry.sender}</dd>
                  <dt>업무 분류</dt><dd>{entry.kind}</dd>
                  {entry.who ? <><dt>대상</dt><dd>{entry.who}</dd></> : null}
                  {entry.trigger ? <><dt>언제 나가나</dt><dd>{entry.trigger}</dd></> : null}
                  {entry.scenario ? <><dt>자동화 이름</dt><dd>{entry.scenario}</dd></> : null}
                </dl>
              </details>
            </section>

            {entry.image ? (
              <section className="stl-media-card" aria-label="첨부 이미지">
                <div className="stl-card-subhead">
                  <div className="stl-card-subhead-left">
                    <span className="stl-card-subhead-title">첨부 사진</span>
                    <span className="stl-char-count">1장</span>
                  </div>
                  <div className="stl-card-subhead-right">
                    <button type="button" className="ktm-btn stl-mini-btn" onClick={() => openLightbox([entry.image], 0, entry.name)}>
                      <Icon name="zoom" /> 크게 보기
                    </button>
                  </div>
                </div>
                <div className="stl-media-viewport">
                  <button type="button" className="stl-media-zoom-btn" onClick={() => openLightbox([entry.image], 0, entry.name)} title="클릭하면 원본 크기로 크게 봅니다">
                    <img className="stl-media-img" src={entry.image} alt={`${entry.name} 첨부 사진`} />
                  </button>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </article>
    );
  };

  // ----- 오른쪽 상세: 쏠라피 알림톡 -----
  const renderDetail = () => {
    if (selectedBms) return renderBmsDetail(selectedBms);
    const roEntry = !selectedId && openRoId ? readOnly.find((entry) => entry.id === openRoId) : null;
    if (roEntry) return renderReadOnlyDetail(roEntry);
    if (!selectedId) {
      return (
        <div className="stl-detail-empty">
          <p className="stl-detail-empty-title">왼쪽에서 템플릿을 선택해 주세요</p>
          <p className="stl-detail-empty-sub">적용된 발송 조건과 실제 카카오톡 화면 미리보기를 바로 확인할 수 있습니다.</p>
        </div>
      );
    }
    if (!selected) return <div className="ktm-empty">선택한 템플릿을 찾을 수 없습니다. 삭제되었거나 이 화면에서 볼 수 없는 템플릿입니다.</div>;

    const info = statusInfo(selected.status);
    const selectedExt = nonMakeExtras(selected.id, sent);
    const linkedEntries = linkedTextEntries(textItems, selected.id);
    const showSelectedExt = Boolean(selectedExt);
    const comments = (Array.isArray(selected.comments) ? selected.comments : [])
      .slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 3);
    const variables = Array.isArray(selected.variables) ? selected.variables : [];
    const ataUnit = Number.isFinite(Number(data?.ata_unit)) && data.ata_unit !== null ? Number(data.ata_unit) : 13;
    const flowForFirst = linkedEntries[0] ? flowById.get(linkedEntries[0].id) : null;
    const canAddStep = Boolean(linkedEntries.length > 0 && flowForFirst && !FLOW_NO_STEP_KINDS.includes(linkedEntries[0].autoKind));
    const singleLinked = linkedEntries.length === 1 ? linkedEntries[0] : null;
    const singleLinkedStatus = singleLinked ? (autoStatusMap[singleLinked.id] || null) : null;
    const singleLinkedEff = singleLinked ? effOf(singleLinked) : null;
    const singleLinkedSummary = singleLinked ? buildConditionSummary(singleLinked, { isMine: true }) : null;
    const singleLinkedPaused = singleLinkedStatus ? catchupPausedText(singleLinkedStatus) : '';

    const hasAtaVars = /#\{[^{}\n]{1,40}\}/.test(String(selected.content || ''));
    const isApproved = selected.status === 'APPROVED';
    const detailActions = availableActions(selected);
    const ataLightTone = linkedEntries.length > 0
      ? (linkedEntries.some((e) => ['on', 'part'].includes(effOf(e).tone)) ? 'on' : 'off')
      : (selected.status === 'APPROVED' && (selected.program_use || selectedExt || (usageSuccess(usage, selected.id, sent) ?? 0) > 0) ? 'on' : 'off');
    const ataLightLabel = linkedEntries.length > 1
      ? `켜짐 ${linkedEntries.filter((e) => ['on', 'part'].includes(effOf(e).tone)).length}/${linkedEntries.length}`
      : (ataLightTone === 'on' ? '켜짐' : '꺼짐');
    const linkedDates = linkedEntries.map((entry) => autoStatusMap[entry.id]?.last_sent_date).filter(Boolean).sort();
    const ataLastAt = linkedDates.length ? linkedDates[linkedDates.length - 1] : (usageLastAt(usage, selected.id) || selectedExt?.lastSentAt || '');
    const ataLastLabel = formatLastSentLabel(ataLastAt);
    const ataRecentCount = usageCount(usage, selected.id);

    return (
      <article className="stl-detail ktm-detail-sheet">
        <div className="stl-detail-head">
          <button type="button" className="ktm-btn stl-back" onClick={() => { userClearedRef.current = true; onRoute({ tpl: '' }); }}><Icon name="back" /> 목록</button>
          <div className="stl-detail-meta">
            <span className={`stl-light stl-light--${ataLightTone}`}>{ataLightLabel}</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className="stl-ch stl-ch--ata">알림톡 · {ataUnit.toLocaleString('ko-KR')}원</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span>{selected.target?.name || '채널'}</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            <span className={`stl-last-sent ${ataLastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {ataLastLabel ? `최근 발송 ${ataLastLabel}` : '최근 발송 기록 없음'}
            </span>
          </div>
          <div className="stl-detail-titlebar">
            <h3 className="stl-detail-title">{selected.name}</h3>
            <div className="stl-detail-actions">
              {singleLinked ? (
                <SmsAutoControls
                  compact
                  key={singleLinked.id}
                  id={singleLinked.id}
                  enabled={Boolean(singleLinkedStatus?.enabled ?? singleLinked.autoEnabled)}
                  photos={singleLinked.imageCount}
                  ata
                  onChanged={() => refreshAfterAutoChange(singleLinked.id)}
                >
                  <button type="button" className="ktm-btn" onClick={() => editAutoEntry(singleLinked)}>수정</button>
                  <button type="button" className="ktm-btn ktm-btn--danger-outline" disabled={busy} onClick={() => deleteAutoEntry(singleLinked)}>
                    {deleteAutoConfirm === singleLinked.id ? '삭제 확인' : '삭제'}
                  </button>
                  {canAddStep ? (
                    <button type="button" className="ktm-btn" onClick={() => addStepForFlow(flowForFirst)}>+ 단계 추가</button>
                  ) : null}
                  {selected.status === 'APPROVED' && onSend ? (
                    <button type="button" className="ktm-btn" onClick={() => onSend(selected.id)}>보내기</button>
                  ) : null}
                </SmsAutoControls>
              ) : (
                <div className="stl-detail-btnrow">
                  {isApproved ? (
                    <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => openAutoSetting(selected.id)}>
                      {linkedEntries.length ? '+ 자동 발송' : '+ 자동 발송 설정'}
                    </button>
                  ) : (
                    <>
                      {detailActions.includes('edit') && !writeOff ? (
                        <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => runAction('edit', selected)}>
                          {selected.status === 'REJECTED' ? '수정 후 재검수' : '내용 수정'}
                        </button>
                      ) : null}
                      {detailActions.includes('inspect') && !writeOff ? (
                        <button type="button" className="ktm-btn" onClick={() => runAction('inspect', selected)}>검수 요청</button>
                      ) : null}
                      {selected.status === 'INSPECTING' ? <span className="ktm-badge ktm-badge--info">카카오 검수 중</span> : null}
                    </>
                  )}
                  {canAddStep ? (
                    <button type="button" className="ktm-btn" onClick={() => addStepForFlow(flowForFirst)}>+ 단계 추가</button>
                  ) : null}
                  {isApproved && onSend ? (
                    <button type="button" className="ktm-btn" onClick={() => onSend(selected.id)}>보내기</button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
          {selected.status === 'REJECTED' ? (
            <div className="ktm-reject-box" role="alert">
              <strong>카카오 검수 반려 사유{comments[0]?.date ? ` (${formatDate(comments[0].date)})` : ''}</strong>
              <p>{comments[0]?.content || '반려 사유가 아직 등록되지 않았습니다. 아래 상세 정보에서 검수 의견을 확인해 주세요.'}</p>
            </div>
          ) : null}
          {singleLinked && singleLinkedPaused ? (
            <p className="ktm-alert stl-detail-banner" role="alert">
              {singleLinkedPaused}
              <span className="stl-detail-banner-sub"> (일반 자동 발송은 계속 켜져 있습니다)</span>
            </p>
          ) : null}
          {singleLinked && !singleLinkedPaused && (singleLinkedEff?.tone === 'blocked' || singleLinkedEff?.tone === 'part') ? (
            <p className={singleLinkedEff.tone === 'blocked' ? 'ktm-alert stl-detail-banner' : 'ktm-warn stl-detail-banner'} role="status">{singleLinkedEff.text}</p>
          ) : null}
        </div>

        <div className="stl-detail-split">
          <div className="ktm-cond-col">
            {singleLinked ? (
              <>
                <div className="ktm-step-chip-row">
                  <span className="ktm-linked-step">{flowStepText(singleLinked)}</span>
                  {singleLinked.name && singleLinked.name !== selected.name ? <span className="ktm-step-name">{singleLinked.name}</span> : null}
                </div>
                {renderConditionBoard(singleLinkedSummary, singleLinkedStatus, true, null, () => cloneAutoEntry(singleLinked))}
              </>
            ) : (
              <section className="stl-cond-board" aria-label="이 템플릿에 적용된 발송 조건">
                {linkedEntries.length > 1 ? (
                  <>
                    <div className="ktm-linked-headrow">
                      <span className="ktm-linked-head">발송 조건 · {linkedEntries.length}단계</span>
                      <span className="ktm-kind-count">
                        켜짐 {linkedEntries.filter((e) => ['on', 'part'].includes(effOf(e).tone)).length}/{linkedEntries.length}
                      </span>
                    </div>
                    <ul className="ktm-linked-list">
                      {linkedEntries.map((entry) => {
                        const st = autoStatusMap[entry.id] || null;
                        const eff = effOf(entry);
                        const summary = buildConditionSummary(entry, { isMine: true });
                        const paused = catchupPausedText(st);
                        const timeStr = compactTimeText(summary);
                        return (
                          <li key={entry.id} className="ktm-linked-card">
                            <div className="ktm-linked-top">
                              <div className="ktm-linked-titlewrap">
                                <span className={`stl-light stl-light--${autoLightClass(eff)}`} title={eff.text}>{compactLightLabel(eff)}</span>
                                <span className="ktm-linked-step">{flowStepText(entry)}</span>
                                <strong className="ktm-linked-name">{entry.name}</strong>
                              </div>
                              <div className="ktm-linked-actions">
                                <SmsAutoControls
                                  compact
                                  id={entry.id}
                                  enabled={Boolean(st?.enabled ?? entry.autoEnabled)}
                                  photos={entry.imageCount}
                                  ata
                                  onChanged={() => refreshAfterAutoChange(entry.id)}
                                >
                                  <button type="button" className="ktm-btn" onClick={() => editAutoEntry(entry)}>수정</button>
                                  <button type="button" className="ktm-btn ktm-btn--danger-outline" disabled={busy} onClick={() => deleteAutoEntry(entry)}>
                                    {deleteAutoConfirm === entry.id ? '삭제 확인' : '삭제'}
                                  </button>
                                </SmsAutoControls>
                              </div>
                            </div>
                            <p className="ktm-linked-cond">
                              {[summary.whenMain, timeStr, summary.whoMain, summary.howMain].filter(Boolean).join(' · ')}
                            </p>
                            {st ? (
                              <p className="ktm-linked-kpis">
                                <span>오늘 대상 <strong>{Number(st.today_targets) || 0}</strong></span>
                                <span>최근 7일 <strong>{Number(st.sent_7d) || 0}</strong></span>
                                <span>누적 <strong>{Number(st.sent_total) || 0}</strong></span>
                                {(Number(st.uncertain_total) || 0) > 0 ? <span className="ktm-linked-warn">확인 필요 {st.uncertain_total}건</span> : null}
                                <span>마지막 {formatKpiDate(st.last_sent_date)}</span>
                              </p>
                            ) : null}
                            {paused ? (
                              <p className="ktm-alert ktm-linked-alert" role="alert">
                                {paused}
                                <span className="stl-detail-banner-sub"> (일반 자동 발송은 계속 켜져 있습니다)</span>
                              </p>
                            ) : null}
                            {!paused && (eff.tone === 'blocked' || eff.tone === 'part') ? (
                              <p className={eff.tone === 'blocked' ? 'ktm-alert ktm-linked-alert' : 'ktm-warn ktm-linked-alert'} role="status">{eff.text}</p>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : showSelectedExt ? (
                  <>
                    <div className="stl-section-eyebrow">발송 조건</div>
                    <div className="stl-cond-grid">
                      <div className="stl-cond-tile stl-cond-tile--when">
                        <span className="stl-cond-label">언제 보낼까</span>
                        <strong className="stl-cond-val">{selectedExt.trigger || '연동 조건에 따라 발송'}</strong>
                      </div>
                      <div className="stl-cond-tile">
                        <span className="stl-cond-label">누구에게</span>
                        <strong className="stl-cond-val">{selectedExt.who || '고객'}</strong>
                      </div>
                      <div className="stl-cond-tile">
                        <span className="stl-cond-label">보내는 곳 · 비용</span>
                        <strong className="stl-cond-val">{selectedExt.sender}</strong>
                        <span className="stl-cond-sub">알림톡 · 건당 {ataUnit.toLocaleString('ko-KR')}원</span>
                      </div>
                    </div>
                    <div className="stl-cond-kpis stl-cond-kpis--compact" aria-label="최근 발송 현황">
                      <div className="stl-kpi">
                        <span className="stl-kpi-label">최근 7일 발송</span>
                        <strong className={`stl-kpi-val${(ataRecentCount ?? 0) > 0 ? ' is-accent' : ''}`}>
                          {ataRecentCount === null || ataRecentCount === undefined ? '확인 못 함' : `${ataRecentCount}건`}
                        </strong>
                      </div>
                      <div className="stl-kpi">
                        <span className="stl-kpi-label">가장 최근 발송</span>
                        <strong className="stl-kpi-val">{ataLastLabel || '기록 없음'}</strong>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="stl-section-eyebrow">발송 조건</div>
                    {selected.status === 'REJECTED' ? (
                      <p className="ktm-linked-empty">카카오 검수에서 반려된 템플릿입니다. 위 반려 사유를 확인해 수정·재검수 후 승인이 완료되면 자동 발송을 연결할 수 있습니다.</p>
                    ) : selected.status === 'PENDING' ? (
                      <p className="ktm-linked-empty">검수 요청 전 상태입니다. 검수 요청 후 카카오 승인이 완료되면 자동 발송을 연결할 수 있습니다.</p>
                    ) : selected.status === 'INSPECTING' ? (
                      <p className="ktm-linked-empty">카카오 검수가 진행 중입니다. 승인이 완료되면 자동 발송을 연결할 수 있습니다.</p>
                    ) : (
                      <p className="ktm-linked-empty">아직 자동 발송이 연결되지 않았습니다. 위 <strong>+ 자동 발송 설정</strong> 버튼을 누르면 바로 설정할 수 있습니다.</p>
                    )}
                    <div className="stl-cond-kpis stl-cond-kpis--compact" aria-label="최근 발송 현황">
                      <div className="stl-kpi">
                        <span className="stl-kpi-label">최근 7일 발송</span>
                        <strong className={`stl-kpi-val${(ataRecentCount ?? 0) > 0 ? ' is-accent' : ''}`}>
                          {ataRecentCount === null || ataRecentCount === undefined ? '확인 못 함' : `${ataRecentCount}건`}
                        </strong>
                      </div>
                      <div className="stl-kpi">
                        <span className="stl-kpi-label">가장 최근 발송</span>
                        <strong className="stl-kpi-val">{ataLastLabel || '기록 없음'}</strong>
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}
          </div>

          <div className="stl-preview-stage ktm-preview-stage">
            <section className="stl-msg-card" aria-label="발송 문구">
              <div className="stl-card-subhead">
                <div className="stl-card-subhead-left">
                  <span className="stl-card-subhead-title">실제 발송 내용</span>
                  {selected.content ? <span className="stl-char-count">{selected.content.length}자</span> : null}
                </div>
                <div className="stl-card-subhead-right">
                  {selected.content && hasAtaVars ? (
                    <button type="button" className={`ktm-btn stl-mini-btn${previewFilled ? ' is-active' : ''}`} onClick={() => setPreviewFilled((v) => !v)}>
                      {previewFilled ? '원래 양식 보기' : '실제 예시로 보기'}
                    </button>
                  ) : null}
                  {selected.content ? (
                    <button type="button" className="ktm-btn stl-mini-btn" onClick={() => copyBody(selected.content)}>
                      <Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}
                    </button>
                  ) : null}
                </div>
              </div>

              <KakaoTemplatePreview template={{
                name: selected.name,
                content: previewFilled ? previewFill(selected.content || '') : (selected.content || ''),
                emphasizeType: selected.emphasizeType,
                emphasizeTitle: selected.emphasizeTitle,
                emphasizeSubtitle: selected.emphasizeSubtitle,
                extra: selected.extra,
                buttons: (selected.buttons || []).map((b) => ({ type: b.type, name: b.name })),
                targetName: selected.target?.name || '',
              }} />

              <details className="ktm-tech-details">
                <summary>상세 정보 · 템플릿 ID 보기</summary>
                <dl className="ktm-info">
                  <dt>종류 · 비용</dt><dd>알림톡 · 건당 {ataUnit.toLocaleString('ko-KR')}원</dd>
                  <dt>템플릿 ID</dt>
                  <dd className="ktm-id">
                    <code>{selected.id}</code>
                    <button type="button" className="ktm-btn ktm-btn--icon stl-mini-btn" onClick={() => copyId(selected.id)} aria-label="템플릿 ID 복사">
                      <Icon name="copy" /> {copied ? '복사됨' : '복사'}
                    </button>
                  </dd>
                  <dt>채널/그룹</dt><dd>{selected.target?.name || '-'}{selected.target?.kind === 'group' ? ' (그룹)' : ''}</dd>
                  <dt>유형</dt><dd>{emphasizeLabel(selected.emphasizeType)} · {messageLabel(selected.messageType)}</dd>
                  <dt>카테고리</dt><dd>{selected.categoryCode || '-'}</dd>
                  <dt>등록/수정</dt><dd>{formatDate(selected.dateCreated) || '-'} / {formatDate(selected.dateUpdated) || '-'}</dd>
                  <dt>변수</dt><dd>{variables.length ? variables.map((v) => (/^#\{.*\}$/.test(String(v)) ? String(v) : `#{${v}}`)).join(', ') : '없음'}</dd>
                  <dt>검수 의견</dt>
                  <dd>
                    {comments.length === 0 ? '없음' : (
                      <ul className="ktm-comments">
                        {comments.map((c, index) => (
                          <li key={index}>
                            <span className="ktm-comment-meta">{c.isAdmin ? '검수자' : '요청'} · {formatDate(c.date) || '-'}</span>
                            <span className="ktm-comment-text">{c.content}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
              </details>
            </section>
          </div>
        </div>
      </article>
    );
  };

  // ----- 왼쪽 카드: 브랜드메시지(DB) — 문자 템플릿과 동일한 컴팩트 행 -----
  const renderManagedCard = (entry) => {
    const light = displayLightOf(entry);
    const ch = channelCostOf(entry);
    const summary = buildConditionSummary(entry, { isMine: true });
    const timeStr = compactTimeText(summary);
    const st = autoStatusMap[entry.id] || null;
    const paused = catchupPausedText(st);
    const lastLabel = formatLastSentLabel(st?.last_sent_date);
    const sent7d = Number(st?.sent_7d) || 0;
    const isSelected = !selectedId && selectedBmsId === entry.id;
    const metaParts = [timeStr, summary.whoMain, entry.hasImage ? photoBadgeText(entry) : ''].filter(Boolean);
    return (
      <li key={`bms-${entry.id}`} className={`stl-item${isSelected ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="stl-item-btn"
          aria-current={isSelected ? 'true' : undefined}
          onClick={() => {
            setNotice(null);
            setOpenRoId('');
            setSelectedBmsId(entry.id);
            if (selectedId) onRoute({ tpl: '', mode: '' });
          }}
        >
          <div className="stl-item-top">
            <span className="stl-item-name">{entry.name}</span>
            <span className={`stl-light stl-light--${light.tone}`} title={light.note || light.label}>{light.label}</span>
          </div>
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
          <div className="stl-item-badges">
            <span className={`stl-last-sent ${lastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {lastLabel ? `최근 발송 ${lastLabel}${sent7d > 0 ? ` · 7일 ${sent7d}건` : ''}` : (st ? '발송 기록 없음' : '확인 중')}
            </span>
            {paused ? <span className="ktm-badge ktm-badge--danger">일괄 발송만 멈춤</span> : null}
            {!paused && light.capNote ? <span className="ktm-badge ktm-badge--info">{light.capNote}</span> : null}
          </div>
        </button>
      </li>
    );
  };

  // ----- 왼쪽 카드: 쏠라피 알림톡 — 문자 템플릿과 동일한 2줄 컴팩트 행 -----
  const renderCard = (item) => {
    const info = statusInfo(item.status);
    const badge = usageBadge(usage, item.id);
    const actions = [...(item.status === 'APPROVED' && onSend ? ['send'] : []), ...availableActions(item)];
    const isOpen = menuId === item.id;
    const linkedEntries = linkedTextEntries(textItems, item.id);
    const linkedOn = linkedEntries.filter((entry) => ['on', 'part'].includes(effOf(entry).tone)).length;
    const cardExtras = nonMakeExtras(item.id, sent);
    const used = usageSuccess(usage, item.id, sent);
    const linked = Boolean(item.program_use || cardExtras || linkedOn > 0);
    const lightOff = Boolean(cardExtras && cardExtras.off) || item.status !== 'APPROVED' || (!linked && used === 0);
    const allFailed = usageCount(usage, item.id) > 0 && used === 0 && linkedOn === 0;
    const light = lightOff ? 'off' : (allFailed ? 'part' : (linked || (used ?? 0) > 0 ? 'on' : ''));
    const targetEntry = linkedEntries.find((entry) => entry.autoKind) || null;
    const picked = item.id === selectedId;
    const ataUnit = Number.isFinite(Number(data?.ata_unit)) && data.ata_unit !== null ? Number(data.ata_unit) : 13;
    const failInfo = failBadge(usageFail(item.id, sent));
    const linkedDates = linkedEntries.map((entry) => autoStatusMap[entry.id]?.last_sent_date).filter(Boolean).sort();
    const ataLastAt = linkedDates.length ? linkedDates[linkedDates.length - 1] : (usageLastAt(usage, item.id) || cardExtras?.lastSentAt || '');
    const ataLastLabel = formatLastSentLabel(ataLastAt);

    let condShort = '';
    if (linkedEntries.length === 1) {
      const s = buildConditionSummary(linkedEntries[0], { isMine: true });
      const t = compactTimeText(s);
      condShort = [s.whenMain, t].filter(Boolean).join(' · ');
    } else if (linkedEntries.length > 1) {
      condShort = `자동 발송 ${linkedEntries.length}단계 (${linkedOn}/${linkedEntries.length} 켜짐)`;
    } else if (cardExtras?.trigger) {
      condShort = cardExtras.trigger;
    } else if (item.program_use) {
      condShort = '제작현황 고객 알림 자동 연결';
    } else if (badge?.text) {
      condShort = badge.text;
    }

    return (
      <li key={item.id} className={`stl-item ktm-ata-item${picked ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="stl-item-btn"
          onClick={() => { setNotice(null); setOpenRoId(''); setSelectedBmsId(null); onRoute({ tpl: item.id, mode: '' }); }}
          aria-current={picked ? 'true' : undefined}
        >
          <div className="stl-item-top">
            <span className="ktm-card-name">{item.name}</span>{' '}
            {light ? <span className={`stl-light stl-light--${light}`}>{light === 'on' ? '켜짐' : (light === 'part' ? '최근 실패뿐' : '꺼짐')}</span> : null}
          </div>
          <div className="stl-item-cond">
            <span className="stl-ch stl-ch--ata">알림톡 · {ataUnit.toLocaleString('ko-KR')}원</span>
            <span className="stl-meta-sep" aria-hidden="true">·</span>
            {item.status === 'APPROVED'
              ? <span>{info.label}</span>
              : <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>}
            {condShort ? (
              <>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span className="stl-when">{condShort}</span>
              </>
            ) : null}
          </div>
          {targetEntry ? <span className="ktm-card-target">대상: {autoTargetText(targetEntry)}</span> : null}
          <div className="stl-item-badges">
            <span className={`stl-last-sent ${ataLastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {ataLastLabel ? `최근 발송 ${ataLastLabel}` : '최근 발송 없음'}
            </span>
            {item.program_use ? <span className="ktm-badge ktm-badge--info">프로그램 알림</span> : null}
            {cardExtras && cardExtras.replaced7 > 0 ? <span className="ktm-badge ktm-badge--warn">문자 대체 {cardExtras.replaced7}건</span> : null}
            {failInfo ? <span className="ktm-badge ktm-badge--danger">{failInfo.text}</span> : null}
          </div>
        </button>
        <div className="ktm-menu-wrap">
          <button type="button" className="ktm-more" aria-haspopup="menu" aria-expanded={isOpen} aria-label={`${item.name} 동작 메뉴`} onClick={() => setMenuId(isOpen ? '' : item.id)}>
            <Icon name="more" />
          </button>
          {isOpen ? (
            <ul className="ktm-menu" role="menu">
              {actions.map((action) => (
                <li key={action} role="none">
                  <button type="button" role="menuitem" className={action === 'delete' ? 'is-danger' : ''} onClick={() => runAction(action, item)}>{ACTION_LABELS[action]}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </li>
    );
  };

  // ----- 왼쪽 카드: 외부 연동 카카오톡(카페24 · 읽기 전용) -----
  const renderReadOnlyCard = (entry) => {
    const opened = !selectedId && !selectedBmsId && openRoId === entry.id;
    const ch = channelCostOf(entry, { ataUnit: data?.ata_unit ?? 13 });
    const light = itemLight(entry);
    const metaParts = [entry.sender, entry.trigger || (entry.count === null ? '확인 못 함' : `최근 7일 ${entry.count}건`)].filter(Boolean);
    const roLastLabel = formatLastSentLabel(entry.lastSentAt);
    return (
      <li key={entry.id} className={`stl-item${opened ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="stl-item-btn"
          aria-current={opened ? 'true' : undefined}
          onClick={() => {
            setSelectedBmsId(null);
            setOpenRoId(entry.id);
            if (selectedId) onRoute({ tpl: '' });
          }}
        >
          <div className="stl-item-top">
            <span className="stl-item-name">{entry.name}</span>
            <span className={`stl-light stl-light--${light.tone}`}>{light.text}</span>
          </div>
          <div className="stl-item-cond">
            <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
            {metaParts.map((part, idx) => (
              <React.Fragment key={`${idx}-${part}`}>
                <span className="stl-meta-sep" aria-hidden="true">·</span>
                <span>{part}</span>
              </React.Fragment>
            ))}
          </div>
          <div className="stl-item-badges">
            <span className={`stl-last-sent ${roLastLabel ? 'stl-last-sent--recent' : 'stl-last-sent--none'}`}>
              {roLastLabel ? `최근 발송 ${roLastLabel}` : '최근 7일 발송 없음'}
            </span>
          </div>
        </button>
      </li>
    );
  };

  const renderDialog = () => {
    if (!dialog) return null;
    const { type, item } = dialog;
    if (type === 'rename') return <RenameDialog item={item} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={(name) => submitDialog('rename', item, { name })} />;
    if (type === 'inspect') return <InspectDialog item={item} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={(comment) => submitDialog('inspect', item, { comment })} />;
    if (type === 'cancel_inspect') {
      return (
        <Modal title="검수 요청 취소" onClose={closeDialog}>
          <p className="ktm-modal-text">“{item.name}” 의 검수 요청을 취소합니다.</p>
          {dialogError ? <p className="ktm-alert" role="alert">{dialogError}</p> : null}
          <div className="ktm-modal-actions">
            <button type="button" className="ktm-btn" onClick={closeDialog}>닫기</button>
            <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={() => submitDialog('cancel_inspect', item, {})}>{busy ? '처리 중…' : '검수 요청 취소'}</button>
          </div>
        </Modal>
      );
    }
    if (type === 'delete') return <DeleteDialog item={item} usage={usage} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={() => submitDialog('delete', item, { confirmName: item.name })} />;
    return null;
  };

  const renderLightbox = () => {
    if (!lightbox || typeof document === 'undefined') return null;
    const currentUrl = lightbox.urls[lightbox.index] || '';
    const autoFit = lightboxDims && lightboxDims.w > 0 && lightboxDims.h / lightboxDims.w > 1.5 ? 'width' : 'contain';
    const activeFit = lightboxFit === 'auto' ? autoFit : lightboxFit;
    return createPortal(
      <div className="stl-lb-backdrop" role="dialog" aria-modal="true" aria-label={`${lightbox.title} 이미지 원본 보기`} onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null); }}>
        <div className="stl-lb-head">
          <div className="stl-lb-title-wrap">
            <strong className="stl-lb-title">{lightbox.title}</strong>
            {lightboxDims ? <span className="stl-lb-meta">{lightboxDims.w} × {lightboxDims.h}px</span> : null}
          </div>
          <div className="stl-lb-tools">
            <button type="button" className={`stl-lb-btn${activeFit === 'width' ? ' is-active' : ''}`} onClick={() => setLightboxFit('width')}>너비 맞춤</button>
            <button type="button" className={`stl-lb-btn${activeFit === 'contain' ? ' is-active' : ''}`} onClick={() => setLightboxFit('contain')}>화면 맞춤</button>
            <button type="button" className="stl-lb-btn stl-lb-close" onClick={() => setLightbox(null)}>닫기 ×</button>
          </div>
        </div>
        <div className="stl-lb-stage" onMouseDown={(event) => { if (event.target === event.currentTarget) setLightbox(null); }}>
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

  // ----- 본문(문자 템플릿과 동일한 마스터-디테일 목록·쪽 나누기) -----
  const hasDetail = Boolean(selectedId || selectedBmsId || openRoId);
  let body;
  if (!tplState.loaded && tplState.loading) body = <div className="ktm-empty">불러오는 중…</div>;
  else if (tplState.error && !data) {
    const noPermission = tplState.status === 401 || tplState.status === 403;
    body = (
      <div className="ktm-error" role="alert">
        <p>{noPermission ? '쏠라피에서 권한을 받지 못했습니다.' : '템플릿을 불러오지 못했습니다.'}</p>
        <p className="ktm-error-detail">{tplState.error}</p>
        <button type="button" className="ktm-btn" onClick={() => loadTemplates({ fresh: true })}>다시 불러오기</button>
      </div>
    );
  } else if (data && data.configured === false) {
    body = <div className="ktm-empty">쏠라피 연결 정보가 설정되지 않아 템플릿을 볼 수 없습니다.</div>;
  } else if (data) {
    const totalVisible = rowKeys.length;
    const pagedDisplayGroups = displayGroups
      .map((group) => ({
        ...group,
        pageRows: group.rows.filter((row) => pageSet.has(row.key)),
      }))
      .filter((group) => group.pageRows.length > 0);
    const pagedRoSections = readOnlySections
      .map((group) => ({ group, pageItems: group.items.filter((entry) => pageSet.has(`ro-${entry.id}`)) }))
      .filter((entry) => entry.pageItems.length > 0);

    const activeIssueLabel = issueFilter === 'kakao-on-blocked'
      ? '켜짐 · 발송 막힘'
      : issueFilter === 'kakao-zero-send'
        ? '켜짐 · 최근 발송 없음'
        : (inspectFilter ? (inspectPills.find((p) => p.id === inspectFilter)?.label || inspectFilter) : '');

    body = (
      <>
        <div className="stl-toolbar">
          <div className="ktm-search stl-search">
            <Icon name="search" />
            <input type="search" value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="이름·조건·ID 검색" aria-label="카카오톡 템플릿 검색" />
          </div>
          <div className="ktm-pills" role="group" aria-label="발송 상태 거르기">
            {pills.map((pill) => (
              <button
                type="button"
                key={pill.id}
                className={`ktm-pill${!issueFilter && !inspectFilter && statusFilter === pill.id ? ' is-active' : ''}`}
                aria-pressed={!issueFilter && !inspectFilter && statusFilter === pill.id}
                onClick={() => pickFilter(pill.id)}
              >
                {pill.label} {pill.count}
              </button>
            ))}
          </div>
          <span className="stl-right">
            <select className="stl-cond-select" aria-label="검수 상태" value={inspectFilter} onChange={(event) => pickInspect(event.target.value)}>
              <option value="">검수 상태 전체</option>
              {inspectPills.map((pill) => (
                <option key={pill.id} value={pill.id}>{pill.label} {pill.count}</option>
              ))}
            </select>
            {hasActiveFilters ? <button type="button" className="ktm-btn stl-reset-btn" onClick={resetFilters}>초기화</button> : null}
            <span className="stl-total">{paged.pages > 1 ? `총 ${totalVisible}건 · ${paged.page}/${paged.pages}쪽` : `총 ${totalVisible}건`}</span>
          </span>
        </div>
        {activeIssueLabel ? (
          <div className="stl-issue-active-bar" role="status">
            <span>지금 확인 중인 이슈: <strong>{activeIssueLabel}</strong> ({totalVisible}건)</span>
            <button type="button" className="ktm-btn stl-mini-btn" onClick={resetFilters}>전체 보기</button>
          </div>
        ) : null}
        {data.unresolved_groups > 0 ? <p className="ktm-hint">범위를 확인하지 못한 템플릿 {data.unresolved_groups}개는 숨겼습니다</p> : null}

        <div className={`stl-layout${hasDetail ? ' has-detail' : ''}`}>
          <section className="stl-list-pane" aria-label="카카오톡 템플릿 목록">
            <div className="stl-list-card">
            {totalVisible === 0 ? (
              <div className="ktm-empty">조건에 맞는 카카오톡 템플릿이 없습니다.</div>
            ) : (
              <>
                {pagedDisplayGroups.map((group) => (
                  <section key={group.groupKey} className={`stl-group ${group.groupMod}`} aria-label={group.groupLabel}>
                    <h3 className="stl-grouphead">
                      <span className="stl-grouphead-left">
                        <span>{group.groupLabel}</span>
                      </span>
                      <span className="ktm-kind-count">{group.rows.length}</span>
                    </h3>
                    <ul className="ktm-cards stl-cards">
                      {group.pageRows.map((row) => (row.type === 'bms' ? renderManagedCard(row.entry) : renderCard(row.item)))}
                    </ul>
                  </section>
                ))}

                {pagedRoSections.map(({ group, pageItems }) => (
                  <section key={`ro-${group.group}`} className="stl-group stl-group--staff" aria-label={`외부 연동 ${group.group}`}>
                    <h3 className="stl-grouphead">
                      <span className="stl-grouphead-left">
                        <span>외부 연동 › {group.group}</span>
                        <span className="stl-grouphead-tag">카페24 · 읽기 전용</span>
                      </span>
                      <span className="ktm-kind-count">{group.items.length}</span>
                    </h3>
                    <ul className="ktm-cards stl-cards">{pageItems.map(renderReadOnlyCard)}</ul>
                  </section>
                ))}
              </>
            )}
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
        </section>
          <section className="stl-detail-pane" aria-label="발송 조건 및 미리보기">{renderDetail()}</section>
        </div>
      </>
    );
  } else body = null;

  return (
    <div className="ktm-root stl-rows ktm-kakao" hidden={!active}>
      <div className="ktm-header">
        <div>
          <h2 className="ktm-title">카카오톡 템플릿</h2>
          <p className="ktm-sub">왼쪽에서 카톡을 고르면, 오른쪽에 발송 조건과 실제 내용이 바로 보입니다.</p>
        </div>
        <div className="ktm-header-actions">
          <button type="button" className="ktm-btn" onClick={openNewBms}>
            <Icon name="plus" /> 브랜드메시지 등록
          </button>
          <button
            type="button"
            className="ktm-btn ktm-btn--primary"
            disabled={!data || data.configured === false || writeOff}
            onClick={() => { setNotice(null); setFormError(''); onRoute({ mode: 'new', tpl: '', kind: KIND_KAKAO }); }}
          >
            <Icon name="plus" /> 알림톡 등록
          </button>
        </div>
      </div>

      <SmsChannelStatusStrip
        channel="kakao"
        active={active}
        autoStats={kakaoAutoStats}
        issues={kakaoIssues}
        onOpenLog={onOpenChannelLog}
        onAttentionClick={() => pickFilter('attention')}
      />

      {lockBar}
      {notice ? <div className={`ktm-notice ktm-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div> : null}
      {tplState.error && data ? <div className="ktm-notice ktm-notice--error" role="alert">{tplState.error}</div> : null}
      {body}
      {renderDialog()}

      {formOpen ? (
        <SmsModal title={mode === 'edit' ? '알림톡 템플릿 수정' : '알림톡 템플릿 등록'} onClose={() => { if (!busy) { setFormError(''); onRoute({ mode: '' }); } }}>
          <KakaoTemplateForm
            key={mode === 'edit' ? selected.id : 'new'}
            mode={mode === 'edit' ? 'edit' : 'create'}
            initial={mode === 'edit' ? selected : null}
            targets={data?.targets || []}
            busy={busy}
            serverError={formError}
            onCancel={() => { setFormError(''); onRoute({ mode: '' }); }}
            onSubmit={submitForm}
          />
        </SmsModal>
      ) : null}

      {autoModal ? (
        <SmsModal title={autoModal.title} onClose={closeAutoModal}>
          <SmsTextTemplateForm
            key={autoModal.initial?.id || `new-${autoModal.cloneFromName || autoModal.initial?.ataTemplate || 'bms'}`}
            pausedText={autoModal.pausedText}
            initial={autoModal.initial}
            siblings={autoModal.siblings}
            startNew={autoModal.startNew}
            cloneFromName={autoModal.cloneFromName || ''}
            existingNames={autoModal.existingNames || []}
            onSend={(id) => onSendText?.(id)}
            onSaved={(savedItem) => {
              if (savedItem?.id) {
                pendingCreatedRef.current = { id: savedItem.id, ata: savedItem.auto_ata_template || '' };
                if (pickedFilter === 'in_use' && !savedItem.auto_enabled) setPickedFilter('all');
                if (inspectFilter) setInspectFilter('');
                if (query.trim()) setQuery('');
                refreshAfterAutoChange(savedItem.id);
              } else {
                setPickedFilter('all');
                refreshAfterAutoChange(autoModal.initial?.id);
              }
            }}
            onCancel={closeAutoModal}
          />
        </SmsModal>
      ) : null}

      {renderLightbox()}
    </div>
  );
}

function RenameDialog({ item, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState(item.name || '');
  const valid = isValidRename(name);
  return (
    <Modal title="이름 변경" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSubmit(name.trim()); }}>
        <label className="ktm-field">
          <span>새 이름 (1~100자)</span>
          <input type="text" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          <small>{name.trim().length}/100</small>
        </label>
        {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        <div className="ktm-modal-actions">
          <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
          <button type="submit" className="ktm-btn ktm-btn--primary" disabled={!valid || busy}>{busy ? '처리 중…' : '이름 변경'}</button>
        </div>
      </form>
    </Modal>
  );
}

function InspectDialog({ item, busy, error, onClose, onSubmit }) {
  const [comment, setComment] = useState('');
  return (
    <Modal title="검수 요청" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(comment.trim()); }}>
        <p className="ktm-modal-text">“{item.name}” 의 검수를 요청합니다. 검수에는 1~3 영업일이 걸립니다.</p>
        <label className="ktm-field">
          <span>검수자 참고 의견 (선택, 500자까지)</span>
          <textarea value={comment} maxLength={500} rows={3} onChange={(event) => setComment(event.target.value)} />
        </label>
        {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        <div className="ktm-modal-actions">
          <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
          <button type="submit" className="ktm-btn ktm-btn--primary" disabled={busy}>{busy ? '처리 중…' : '검수 요청'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ item, usage, busy, error, onClose, onSubmit }) {
  const [typed, setTyped] = useState('');
  const decision = deleteDecision(item, usage);
  const info = statusInfo(item.status);
  const count = usageCount(usage, item.id);
  return (
    <Modal title="템플릿 삭제" onClose={onClose}>
      <dl className="ktm-modal-info">
        <dt>이름</dt><dd>{item.name}</dd>
        <dt>상태</dt><dd>{info.label}</dd>
        <dt>최근 7일 발송</dt><dd>{count === null ? '확인 못 함' : `${count}건`}</dd>
      </dl>
      {!decision.allowed ? (
        <p className="ktm-alert" role="alert">
          {decision.reason === 'program'
            ? '이 프로그램의 고객 알림(주문 접수·제작 시작·포장·출고·일정 변경)에 쓰는 템플릿이라 여기서는 지울 수 없습니다.'
            : `${decision.reason === 'unknown' ? '최근 7일 사용 여부를 확인하지 못했습니다. ' : ''}지금 발송에 쓰이고 있어 여기서는 지울 수 없습니다. 이 템플릿을 쓰는 자동 발송(쏠라피 자동화·프로그램 알림)을 먼저 끄세요`}
        </p>
      ) : (
        <>
          <p className="ktm-warn">쏠라피 자동화에 연결된 템플릿이면 그 자동화가 멈춥니다.</p>
          {item.status === 'APPROVED' ? <p className="ktm-warn">승인된 템플릿입니다. 다시 등록하면 검수에 1~3 영업일이 걸립니다.</p> : null}
          <label className="ktm-field">
            <span>삭제하려면 템플릿 이름을 그대로 입력하세요</span>
            <input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </label>
        </>
      )}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <div className="ktm-modal-actions">
        <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
        {decision.allowed ? (
          <button type="button" className="ktm-btn ktm-btn--danger" disabled={!deleteConfirmed(item, typed) || busy} onClick={onSubmit}>{busy ? '삭제 중…' : '삭제'}</button>
        ) : null}
      </div>
    </Modal>
  );
}
