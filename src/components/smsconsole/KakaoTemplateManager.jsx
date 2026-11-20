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
  buildConditionSummary, channelCostOf, compactLightLabel, flowStepText, groupFlows,
  isAttentionTone, isKakaoEntry, itemLight, matchesSmsQuery, sortByNameNumeric,
} from './smsTemplateListModel.js';
import { SENDERS } from '../../../shared/smsTemplateKinds.js';
import {
  BMS_TEMPLATE_ID, KIND_KAKAO, autoConditionLine, autoTargetText, catchupPausedText,
  formInitialFromItem, imageUrlsFromItem, linkedTextEntries, myTextSection, photoBadgeText, previewFill,
} from './smsTextTemplateFormModel.js';
import { autoEffective, autoLightClass } from '../../../shared/smsAutoEffective.js';
import {
  ACTION_LABELS, availableActions, defaultStatusFilter, deleteConfirmed, deleteDecision,
  failBadge, filterTemplates, formatDate, isValidRename, readOnlyAudienceSections,
  readOnlyKakaoItems, statusInfo, statusPills, templateAudienceSections, templateExtras,
  usageBadge, usageCount, usageFail, usageSuccess,
} from './templateListModel.js';

const nonMakeExtras = (templateId, sent) => {
  const extra = templateExtras(templateId, sent);
  return extra && extra.sender !== SENDERS.make ? extra : null;
};
import './SmsAutoControls.css';
import './KakaoTemplateManager.css';

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
  const [pickedFilter, setPickedFilter] = useState(null);
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

  // 현황판 카톡 자동 발송 집계
  const kakaoAutoStats = useMemo(() => {
    const dbAta = kakaoMineEntries.filter((entry) => entry.autoAtaTemplate !== BMS_TEMPLATE_ID);
    const dbBms = kakaoMineEntries.filter((entry) => entry.autoAtaTemplate === BMS_TEMPLATE_ID);
    const dbAtaOn = dbAta.filter((entry) => ['on', 'part'].includes(effOf(entry).tone)).length;
    const dbBmsOn = dbBms.filter((entry) => ['on', 'part'].includes(effOf(entry).tone)).length;
    const roAta = allReadOnly.filter((entry) => entry.channel !== 'BMS');
    const roBms = allReadOnly.filter((entry) => entry.channel === 'BMS');
    const roAtaOn = roAta.filter((entry) => itemLight(entry).tone === 'on').length;
    const roBmsOn = roBms.filter((entry) => itemLight(entry).tone === 'on').length;
    const extProgramAta = items.filter((item) => Boolean(item.program_use || nonMakeExtras(item.id, sent)));
    const extProgramAtaOn = extProgramAta.filter((item) => {
      const ex = nonMakeExtras(item.id, sent);
      return item.status === 'APPROVED' && !(ex && ex.off);
    }).length;
    const dbAttention = kakaoMineEntries.filter((entry) => isAttentionTone(effOf(entry).tone) || Boolean(autoStatusMap[entry.id]?.catchup_paused)).length;
    const ataOn = dbAtaOn + roAtaOn + extProgramAtaOn;
    const bmsOn = dbBmsOn + roBmsOn;
    return {
      on: ataOn + bmsOn,
      total: dbAta.length + dbBms.length + roAta.length + roBms.length + extProgramAta.length,
      ataOn,
      bmsOn,
      attention: dbAttention,
    };
  }, [kakaoMineEntries, effOf, allReadOnly, items, sent, autoStatusMap]);

  // 알약 필터 계산 (브랜드메시지 포함)
  const basePills = useMemo(() => statusPills(items, usage, sent), [items, usage, sent]);
  const hasLinkedOn = useCallback((ataId) => {
    const linkedList = linkedTextEntries(textItems, ataId);
    return linkedList.some((entry) => ['on', 'part'].includes(effOf(entry).tone));
  }, [textItems, effOf]);

  const pills = useMemo(() => {
    const activeManagedCount = managedKakaoEntries.filter((entry) => ['on', 'part'].includes(effOf(entry).tone)).length;
    const activeRoCount = allReadOnly.filter((entry) => (entry.count ?? 0) - (entry.fail ?? 0) > 0).length;
    const activeAtaCount = items.filter((item) => (usageSuccess(usage, item.id, sent) ?? 0) > 0 || hasLinkedOn(item.id)).length;
    const bmsCount = managedKakaoEntries.length + allReadOnly.filter((entry) => entry.channel === 'BMS').length;

    const list = basePills.map((pill) => {
      if (pill.id === 'in_use') return { ...pill, count: activeAtaCount + activeManagedCount + activeRoCount };
      if (pill.id === 'all') return { ...pill, count: items.length + managedKakaoEntries.length + allReadOnly.length };
      return pill;
    });
    const allIdx = list.findIndex((p) => p.id === 'all');
    if (bmsCount > 0 && allIdx >= 0) {
      list.splice(allIdx + 1, 0, { id: 'bms', label: '브랜드메시지', count: bmsCount });
    }
    return list;
  }, [basePills, managedKakaoEntries, effOf, allReadOnly, items, usage, sent, hasLinkedOn]);

  const statusFilter = pickedFilter ?? (selectedBmsId ? 'all' : defaultStatusFilter(basePills, selectedId, usage, sent));

  // 브랜드메시지(DB) 필터링
  const visibleManaged = useMemo(() => {
    if (!['in_use', 'all', 'bms'].includes(statusFilter)) return [];
    return managedKakaoEntries.filter((entry) => {
      if (statusFilter === 'in_use' && !['on', 'part'].includes(effOf(entry).tone)) return false;
      const bodyText = bmsDetailMap[entry.id]?.item?.body ?? entry.preview ?? '';
      return matchesSmsQuery({ ...entry, body: bodyText }, query);
    });
  }, [managedKakaoEntries, statusFilter, effOf, bmsDetailMap, query]);

  // 알림톡 필터링(이름·ID 뿐 아니라 연결된 발송 조건 텍스트도 검색)
  const visible = useMemo(() => {
    if (statusFilter === 'bms') return [];
    const q = String(query || '').trim().toLowerCase();
    return items.filter((item) => {
      if (statusFilter === 'in_use') {
        if (!((usageSuccess(usage, item.id, sent) ?? 0) > 0 || hasLinkedOn(item.id))) return false;
      } else if (statusFilter !== 'all' && item.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      if (String(item.name || '').toLowerCase().includes(q) || String(item.id || '').toLowerCase().includes(q)) return true;
      const extras = nonMakeExtras(item.id, sent);
      if (extras && [extras.trigger, extras.who, extras.sender].some((v) => String(v || '').toLowerCase().includes(q))) return true;
      const linkedEntries = linkedTextEntries(textItems, item.id);
      return linkedEntries.some((entry) => matchesSmsQuery(entry, q));
    });
  }, [statusFilter, query, items, usage, sent, hasLinkedOn, textItems]);

  const readOnly = useMemo(() => {
    const list = statusFilter === 'bms'
      ? readOnlyKakaoItems(items, sent, { status: 'all', query }).filter((entry) => entry.channel === 'BMS')
      : readOnlyKakaoItems(items, sent, { status: statusFilter, query });
    return list.filter((entry) => entry.sender !== SENDERS.make);
  }, [items, sent, statusFilter, query]);

  const listSections = useMemo(() => templateAudienceSections(visible, sent), [visible, sent]);
  const readOnlySections = useMemo(() => readOnlyAudienceSections(readOnly), [readOnly]);
  const selected = selectedId ? items.find((item) => item.id === selectedId) || null : null;
  const selectedBms = !selectedId && selectedBmsId ? kakaoMineById.get(selectedBmsId) || null : null;
  const formOpen = mode === 'new' || (mode === 'edit' && selected);

  // 데스크톱 첫 진입 시 최상단 항목 자동 선택
  useEffect(() => {
    if (!active || !tplState.loaded || !data || selectedId || selectedBmsId || openRoId || mode === 'new' || mode === 'edit' || userClearedRef.current) return;
    if (!isDesktopViewport()) return;
    if (statusFilter === 'bms') {
      if (visibleManaged[0]) { setSelectedBmsId(visibleManaged[0].id); return; }
      const firstRo = readOnlySections[0]?.items?.[0];
      if (firstRo) setOpenRoId(firstRo.id);
      return;
    }
    const firstItem = listSections[0]?.kinds?.[0]?.items?.[0];
    if (firstItem) { onRoute({ tpl: firstItem.id, mode: '' }); return; }
    if (visibleManaged[0]) { setSelectedBmsId(visibleManaged[0].id); return; }
    const firstRo = readOnlySections[0]?.items?.[0];
    if (firstRo) setOpenRoId(firstRo.id);
  }, [active, tplState.loaded, data, selectedId, selectedBmsId, openRoId, mode, statusFilter, visibleManaged, listSections, readOnlySections, onRoute]);

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

  const renderConditionBoard = (summary, st, isMineAuto = true) => {
    const todayCount = Number(st?.today_targets) || 0;
    const recent7d = Number(st?.sent_7d) || 0;
    const sentTotal = Number(st?.sent_total) || 0;
    const uncertain = Number(st?.uncertain_total) || 0;
    return (
      <section className="stl-cond-board ktm-cond-board" aria-label="적용된 발송 조건">
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
        {summary.catchup ? <div className="stl-cond-catchup" role="status">{summary.catchup}</div> : null}
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
                <span className="stl-kpi-label">마지막 발송</span>
                <strong className="stl-kpi-val">{formatKpiDate(st.last_sent_date)}</strong>
              </div>
            </div>
          ) : (
            <p className="stl-cond-loading">발송 현황 불러오는 중…</p>
          )
        ) : null}
      </section>
    );
  };

  // ----- 오른쪽 상세: 브랜드메시지(DB 자동 발송) -----
  const renderBmsDetail = (entry) => {
    const st = autoStatusMap[entry.id] || null;
    const eff = effOf(entry);
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

    return (
      <div className="ktm-detail ktm-bms-detail">
        <div className="ktm-bms-head">
          <div className="ktm-detail-head">
            <button type="button" className="ktm-btn ktm-back" onClick={() => { userClearedRef.current = true; setSelectedBmsId(null); }}>
              <Icon name="back" /> 목록
            </button>
            <span className={`stl-light stl-light--${autoLightClass(eff)}`}>{eff.text}</span>
            <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
            {entry.hasImage ? <span className="ktm-badge ktm-badge--muted">{photoBadgeText(entry)}</span> : null}
          </div>
          <div className="ktm-bms-titlebar">
            <h3 className="ktm-detail-name">{entry.name}</h3>
            <div className="ktm-bms-controls">
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
            <p className="ktm-alert" role="alert">
              {paused}
              <span className="stl-detail-banner-sub"> (일반 자동 발송은 계속 켜져 있습니다)</span>
            </p>
          ) : null}
          {!paused && (eff.tone === 'blocked' || eff.tone === 'part') ? (
            <p className={eff.tone === 'blocked' ? 'ktm-alert' : 'ktm-warn'} role="status">{eff.text}</p>
          ) : null}
        </div>

        {renderConditionBoard(summary, st, true)}

        <div className="ktm-bms-preview-bar">
          <span className="ktm-linked-head">발송 내용 미리보기</span>
          <div className="ktm-detail-actions">
            {rawBody && hasVars ? (
              <button type="button" className="ktm-btn" onClick={() => setPreviewFilled((v) => !v)}>
                {previewFilled ? '변수 원문 보기' : '예시 채워보기'}
              </button>
            ) : null}
            {photos.length > 0 ? (
              <button type="button" className="ktm-btn" onClick={() => openLightbox(photos, 0, entry.name)}>
                <Icon name="zoom" /> 사진 크게 보기
              </button>
            ) : null}
            {rawBody ? (
              <button type="button" className="ktm-btn" onClick={() => copyBody(rawBody)}>
                <Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}
              </button>
            ) : null}
          </div>
        </div>

        {detail.loading && !detail.item ? (
          <div className="ktm-empty">문구와 첨부 사진을 불러오는 중…</div>
        ) : detail.error && !detail.item ? (
          <div className="ktm-error" role="alert">
            <p>{detail.error}</p>
            <button type="button" className="ktm-btn" onClick={() => ensureBmsDetail(entry.id, true)}>다시 시도</button>
          </div>
        ) : (
          <div className="ktm-detail-split">
            <KakaoTemplatePreview
              banner={isBms ? (isAd ? '브랜드메시지 (광고)' : '브랜드메시지') : '알림톡 도착'}
              onImageClick={photos.length ? () => openLightbox(photos, 0, entry.name) : undefined}
              template={{
                name: entry.name,
                content: previewFilled ? previewFill(rawBody) : rawBody,
                emphasizeType: photos.length ? 'IMAGE' : 'NONE',
                imageUrl: photos[0] || '',
                buttons: buttons.map((b) => ({ type: 'WL', name: b.name })),
                targetName: '한성쇼케이스그룹',
              }}
            />
            <dl className="ktm-info">
              <dt>종류 · 단가</dt><dd>{ch.kindLabel}{ch.costDetail ? ` · ${ch.costDetail}` : ''}</dd>
              <dt>자동 발송 시점</dt><dd>{summary.whenMain}{summary.whenSub ? ` (${summary.whenSub})` : ''}</dd>
              <dt>발송 대상</dt><dd>{summary.whoMain}{summary.whoSub ? ` · ${summary.whoSub}` : ''}</dd>
              <dt>버튼 링크</dt>
              <dd>
                {buttons.length === 0 ? '없음' : (
                  <ul className="ktm-bms-links">
                    {buttons.map((b, i) => (
                      <li key={`${b.name}-${i}`}>
                        <strong>{b.name}</strong>
                        <span>{b.link}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          </div>
        )}
      </div>
    );
  };

  // ----- 오른쪽 상세: 외부 연동(읽기 전용) -----
  const renderReadOnlyDetail = (entry) => {
    const ch = channelCostOf(entry, { ataUnit: data?.ata_unit ?? 13 });
    const light = itemLight(entry);
    const summary = buildConditionSummary(entry, { isMine: false });
    return (
      <div className="ktm-detail ktm-bms-detail">
        <div className="ktm-detail-head">
          <button type="button" className="ktm-btn ktm-back" onClick={() => { userClearedRef.current = true; setOpenRoId(''); }}><Icon name="back" /> 목록</button>
          <h3 className="ktm-detail-name">{entry.name}</h3>
          <span className={`ktm-light ktm-light--${light.tone}`}>{light.text}</span>
          <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span>
        </div>
        {entry.body ? (
          <div className="ktm-detail-actions">
            <button type="button" className="ktm-btn" onClick={() => copyBody(entry.body)}><Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}</button>
            {entry.image ? (
              <button type="button" className="ktm-btn" onClick={() => openLightbox([entry.image], 0, entry.name)}>
                <Icon name="zoom" /> 사진 크게 보기
              </button>
            ) : null}
          </div>
        ) : null}
        {renderConditionBoard(summary, null, false)}
        <div className="ktm-detail-split">
          <KakaoTemplatePreview
            banner={entry.channel === 'BMS' ? '브랜드메시지' : '알림톡 도착'}
            onImageClick={entry.image ? () => openLightbox([entry.image], 0, entry.name) : undefined}
            template={{
              name: entry.name, content: entry.body || '', emphasizeType: entry.image ? 'IMAGE' : undefined, imageUrl: entry.image || '',
              buttons: [], targetName: entry.sender || '',
            }}
          />
          <dl className="ktm-info">
            <dt>종류 · 비용</dt><dd>{[ch.kindLabel, ch.costDetail].filter(Boolean).join(' · ')}</dd>
            <dt>보내는 곳</dt><dd>{entry.sender}</dd>
            <dt>업무 분류</dt><dd>{entry.kind}</dd>
            {entry.who ? <><dt>대상</dt><dd>{entry.who}</dd></> : null}
            {entry.trigger ? <><dt>언제 나가나</dt><dd>{entry.trigger}</dd></> : null}
            {entry.scenario ? <><dt>자동화 이름</dt><dd>{entry.scenario}</dd></> : null}
          </dl>
        </div>
      </div>
    );
  };

  // ----- 왼쪽 카드: 선택 분기 -----
  const renderDetail = () => {
    if (selectedBms) return renderBmsDetail(selectedBms);
    const roEntry = !selectedId && openRoId ? readOnly.find((entry) => entry.id === openRoId) : null;
    if (roEntry) return renderReadOnlyDetail(roEntry);
    if (!selectedId) return <div className="ktm-empty">왼쪽에서 템플릿을 고르면 적용된 발송 조건과 미리보기가 보입니다.</div>;
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

    return (
      <div className="ktm-detail">
        <div className="ktm-detail-head">
          <button type="button" className="ktm-btn ktm-back" onClick={() => { userClearedRef.current = true; onRoute({ tpl: '' }); }}><Icon name="back" /> 목록</button>
          <h3 className="ktm-detail-name">{selected.name}</h3>
          <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>
          <span className="stl-ch stl-ch--ata">알림톡 · 건당 {ataUnit.toLocaleString('ko-KR')}원</span>
        </div>
        <div className="ktm-detail-actions">
          <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => openAutoSetting(selected.id)}>
            {linkedEntries.length ? '+ 자동 발송 추가' : '이 알림톡으로 자동 발송 설정'}
          </button>
          {canAddStep ? (
            <button type="button" className="ktm-btn" onClick={() => addStepForFlow(flowForFirst)}>+ 단계 추가</button>
          ) : null}
          {selected.status === 'APPROVED' && onSend ? (
            <button type="button" className="ktm-btn" onClick={() => onSend(selected.id)}>이 템플릿으로 보내기</button>
          ) : null}
          {selected.content ? (
            <button type="button" className="ktm-btn" onClick={() => copyBody(selected.content)}>
              <Icon name="copy" /> {copiedBody ? '복사됨 ✓' : '문구 복사'}
            </button>
          ) : null}
        </div>

        <section className="ktm-linked" aria-label="이 템플릿에 적용된 발송 조건">
          <div className="ktm-linked-headrow">
            <h4 className="ktm-linked-head">이 템플릿에 적용된 발송 조건</h4>
            {linkedEntries.length > 0 ? (
              <span className="ktm-kind-count">
                켜짐 {linkedEntries.filter((e) => ['on', 'part'].includes(effOf(e).tone)).length}/{linkedEntries.length}
              </span>
            ) : null}
          </div>
          {showSelectedExt ? (
            <dl className="ktm-info">
              <dt>보내는 곳</dt><dd>{selectedExt.sender}</dd>
              {selectedExt.who ? <><dt>대상</dt><dd>{selectedExt.who}</dd></> : null}
              {selectedExt.trigger ? <><dt>언제 나가나</dt><dd>{selectedExt.trigger}</dd></> : null}
              {selectedExt.scenario ? <><dt>자동화 이름</dt><dd>{selectedExt.scenario}</dd></> : null}
            </dl>
          ) : null}
          {linkedEntries.length === 0 ? (
            showSelectedExt ? null : <p className="ktm-linked-empty">적용된 자동 발송 조건이 없습니다. 위 버튼으로 바로 설정할 수 있습니다.</p>
          ) : (
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
          )}
        </section>

        <div className="ktm-detail-split">
          <KakaoTemplatePreview template={{
            name: selected.name, content: selected.content, emphasizeType: selected.emphasizeType,
            emphasizeTitle: selected.emphasizeTitle, emphasizeSubtitle: selected.emphasizeSubtitle,
            extra: selected.extra, buttons: (selected.buttons || []).map((b) => ({ type: b.type, name: b.name })),
            targetName: selected.target?.name || '',
          }} />
          <dl className="ktm-info">
            <dt>종류 · 비용</dt><dd>알림톡 · 건당 {ataUnit.toLocaleString('ko-KR')}원</dd>
            <dt>템플릿 ID</dt>
            <dd className="ktm-id">
              <code>{selected.id}</code>
              <button type="button" className="ktm-btn ktm-btn--icon" onClick={() => copyId(selected.id)} aria-label="템플릿 ID 복사">
                <Icon name="copy" /> {copied ? '복사됨' : '복사'}
              </button>
            </dd>
            <dt>채널/그룹</dt><dd>{selected.target?.name || '-'}{selected.target?.kind === 'group' ? ' (그룹)' : ''}</dd>
            <dt>유형</dt><dd>{emphasizeLabel(selected.emphasizeType)} · {messageLabel(selected.messageType)}</dd>
            <dt>카테고리</dt><dd>{selected.categoryCode || '-'}</dd>
            <dt>등록일</dt><dd>{formatDate(selected.dateCreated) || '-'}</dd>
            <dt>수정일</dt><dd>{formatDate(selected.dateUpdated) || '-'}</dd>
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
        </div>
      </div>
    );
  };

  // ----- 왼쪽 카드: 브랜드메시지(DB) -----
  const renderManagedCard = (entry) => {
    const eff = effOf(entry);
    const ch = channelCostOf(entry);
    const summary = buildConditionSummary(entry, { isMine: true });
    const timeStr = compactTimeText(summary);
    const paused = catchupPausedText(autoStatusMap[entry.id]);
    const isSelected = !selectedId && selectedBmsId === entry.id;
    return (
      <li key={`bms-${entry.id}`} className={`ktm-card ktm-card--slim${isSelected ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="ktm-card-main"
          aria-current={isSelected ? 'true' : undefined}
          onClick={() => {
            setNotice(null);
            setOpenRoId('');
            setSelectedBmsId(entry.id);
            if (selectedId) onRoute({ tpl: '', mode: '' });
          }}
        >
          <span className="ktm-card-name">{entry.name}</span>
          <span className="ktm-card-badges">
            <span className={`ktm-light ktm-light--${autoLightClass(eff)}`} title={eff.text}>{compactLightLabel(eff)}</span>
            {ch.fullLabel ? <span className={`stl-ch stl-ch--${ch.tone}`}>{ch.fullLabel}</span> : null}
            {entry.hasImage ? <span className="ktm-badge ktm-badge--muted">{photoBadgeText(entry)}</span> : null}
            {paused ? <span className="ktm-badge ktm-badge--danger">일괄 발송 멈춤</span> : null}
          </span>
          <span className="ktm-card-cond">조건: {[summary.whenMain, timeStr, summary.whoMain].filter(Boolean).join(' · ')}</span>
        </button>
      </li>
    );
  };

  // ----- 왼쪽 카드: 쏠라피 알림톡 -----
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
    const extraBadges = item.program_use || (cardExtras && cardExtras.replaced7 > 0) ? (
      <>
        {item.program_use ? <span className="ktm-badge ktm-badge--info">프로그램 알림에 사용</span> : null}
        {cardExtras && cardExtras.replaced7 > 0 ? <span className="ktm-badge ktm-badge--warn">문자 대체 {cardExtras.replaced7}건</span> : null}
      </>
    ) : null;

    let cardCondText = '';
    if (linkedEntries.length === 1) {
      const s = buildConditionSummary(linkedEntries[0], { isMine: true });
      const t = compactTimeText(s);
      const stateWord = linkedOn > 0 ? '자동 켜짐' : '자동 꺼짐';
      cardCondText = `조건: ${[s.whenMain, t, stateWord].filter(Boolean).join(' · ')}`;
    } else if (linkedEntries.length > 1) {
      cardCondText = `조건: 자동 발송 ${linkedEntries.length}단계 (켜짐 ${linkedOn}/${linkedEntries.length})`;
    } else if (cardExtras?.trigger) {
      cardCondText = `조건: ${cardExtras.trigger}`;
    }

    return (
      <li key={item.id} className={`ktm-card ktm-card--slim${item.id === selectedId ? ' is-selected' : ''}`}>
        <button
          type="button"
          className="ktm-card-main"
          onClick={() => { setNotice(null); setOpenRoId(''); setSelectedBmsId(null); onRoute({ tpl: item.id, mode: '' }); }}
          aria-current={item.id === selectedId ? 'true' : undefined}
        >
          <span className="ktm-card-name">{item.name}</span>
          {' '}
          {picked ? (
            <span className="ktm-card-meta">
              <span className="ktm-chip">{item.target?.name || '채널'}{item.target?.kind === 'group' ? ' · 그룹' : ''}</span>
              <span className="ktm-date">{formatDate(item.dateCreated)}</span>
              {cardExtras ? <span className="ktm-chip ktm-chip--sender">{cardExtras.sender}</span> : null}
              {cardExtras ? <span className="ktm-chip">{cardExtras.kind}</span> : null}
              {extraBadges}
            </span>
          ) : extraBadges ? <span className="ktm-card-meta">{extraBadges}</span> : null}
          <span className="ktm-card-badges">
            {light ? <span className={`ktm-light ktm-light--${light}`}>{light === 'on' ? '켜짐' : (light === 'part' ? '최근 실패뿐' : '꺼짐')}</span> : null}
            {light ? ' ' : null}
            <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>
            {data ? <span className="ktm-badge ktm-badge--muted">알림톡{Number.isFinite(Number(data.ata_unit)) && data.ata_unit !== null ? ` · 건당 ${Number(data.ata_unit).toLocaleString('ko-KR')}원` : ''}</span> : null}
            {badge ? <span className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span> : null}
            {failBadge(usageFail(item.id, sent)) ? <span className="ktm-badge ktm-badge--danger">{failBadge(usageFail(item.id, sent)).text}</span> : null}
          </span>
          {targetEntry ? <span className="ktm-card-target">대상: {autoTargetText(targetEntry)}</span> : null}
          {cardCondText ? <span className="ktm-card-cond">{cardCondText}</span> : null}
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

  // ----- 왼쪽 카드: 외부 연동 카카오톡(읽기 전용) -----
  const renderReadOnly = () => (
    <section className="ktm-kind" aria-label="외부 연동 카카오톡">
      <h3 className="ktm-kind-head">외부 연동 카카오톡 (카페24) <span className="ktm-kind-count">{readOnly.length}</span></h3>
      {readOnlySections.map((group) => (
        <div key={group.group} className="ktm-aud-sub">
          <h4 className="ktm-kind-head ktm-kind-head--sub">{group.group} <span className="ktm-kind-count">{group.items.length}</span></h4>
          <ul className="ktm-cards">
            {group.items.map((entry) => {
              const opened = !selectedId && !selectedBmsId && openRoId === entry.id;
              return (
                <li key={entry.id} className={`ktm-card ktm-card--slim${opened ? ' is-selected' : ''}`}>
                  <button
                    type="button"
                    className="ktm-card-main"
                    aria-expanded={opened}
                    onClick={() => {
                      setSelectedBmsId(null);
                      setOpenRoId(opened ? '' : entry.id);
                      if (!opened && selectedId) onRoute({ tpl: '' });
                    }}
                  >
                    <span className="ktm-card-name">{entry.name}</span>
                    {opened ? (
                      <span className="ktm-card-meta">
                        <span className="ktm-chip ktm-chip--sender">{entry.sender}</span>
                        <span className="ktm-chip">{entry.kind}</span>
                        <span className="ktm-chan">{entry.channel === 'BMS' ? '브랜드메시지·친구톡' : '알림톡'}</span>
                      </span>
                    ) : null}
                    <span className="ktm-card-badges">
                      <span className={`ktm-light ktm-light--${itemLight(entry).tone}`}>{itemLight(entry).text}</span>
                      {(() => { const ch = channelCostOf(entry, { ataUnit: data?.ata_unit ?? 13 }); return ch.fullLabel ? <span className="ktm-badge ktm-badge--muted">{ch.fullLabel}</span> : null; })()}
                      {entry.count === null ? <span className="ktm-badge ktm-badge--muted">사용 여부 확인 못 함</span>
                        : <span className={`ktm-badge ktm-badge--${entry.count > 0 ? 'warn' : 'muted'}`}>최근 7일 {entry.count}건</span>}
                      {failBadge(entry.fail) ? <span className="ktm-badge ktm-badge--danger">{failBadge(entry.fail).text}</span> : null}
                      {entry.ad ? <span className="ktm-badge ktm-badge--info">광고</span> : null}
                    </span>
                    {entry.trigger ? <span className="ktm-card-cond">조건: {entry.trigger}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );

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

  // ----- 본문 -----
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
    const totalVisible = visibleManaged.length + visible.length + readOnly.length;
    body = (
      <div className={`ktm-layout${hasDetail ? ' has-detail' : ''}`}>
        <section className="ktm-list-pane" aria-label="카카오톡 템플릿 목록">
          <div className="ktm-search">
            <Icon name="search" />
            <input type="search" value={query} onChange={(event) => { userClearedRef.current = false; setQuery(event.target.value); }} placeholder="이름·발송 조건·템플릿 ID 검색" aria-label="카카오톡 템플릿 검색" />
          </div>
          <div className="ktm-pills" role="group" aria-label="상태 거르기">
            {pills.map((pill) => (
              <button
                type="button"
                key={pill.id}
                className={`ktm-pill${statusFilter === pill.id ? ' is-active' : ''}`}
                aria-pressed={statusFilter === pill.id}
                onClick={() => { userClearedRef.current = false; setPickedFilter(pill.id); }}
              >
                {pill.label} {pill.count}
              </button>
            ))}
          </div>
          {data.unresolved_groups > 0 ? <p className="ktm-hint">범위를 확인하지 못한 템플릿 {data.unresolved_groups}개는 숨겼습니다</p> : null}

          {totalVisible === 0 ? (
            <div className="ktm-empty">조건에 맞는 카카오톡 템플릿이 없습니다.</div>
          ) : (
            <>
              {visibleManaged.length > 0 ? (
                <section className="ktm-kind" aria-label="브랜드메시지">
                  <h3 className="ktm-kind-head">브랜드메시지 (직접 관리 · 자동 발송) <span className="ktm-kind-count">{visibleManaged.length}</span></h3>
                  <ul className="ktm-cards">{visibleManaged.map(renderManagedCard)}</ul>
                </section>
              ) : null}

              {visible.length > 0 ? (
                listSections.map((aud) => (
                  <section key={aud.group} className="ktm-aud" aria-label={aud.group}>
                    <h3 className="ktm-kind-head ktm-kind-head--aud">{aud.group} · 알림톡 <span className="ktm-kind-count">{aud.count}</span></h3>
                    {aud.kinds.map((section) => (
                      <section key={section.kind || aud.group} className="ktm-kind" aria-label={section.kind || aud.group}>
                        {section.kind ? <h3 className="ktm-kind-head">{section.kind} <span className="ktm-kind-count">{section.items.length}</span></h3> : null}
                        <ul className="ktm-cards">{section.items.map(renderCard)}</ul>
                      </section>
                    ))}
                  </section>
                ))
              ) : null}

              {readOnly.length > 0 ? renderReadOnly() : null}
            </>
          )}
        </section>
        <section className="ktm-detail-pane" aria-label="발송 조건 및 미리보기">{renderDetail()}</section>
      </div>
    );
  } else body = null;

  return (
    <div className="ktm-root" hidden={!active}>
      <div className="ktm-header">
        <div>
          <h2 className="ktm-title">카카오톡 템플릿</h2>
          <p className="ktm-sub">카카오톡 발송 현황을 위에서 보고, 알림톡·브랜드메시지 템플릿과 적용된 발송 조건을 한곳에서 관리합니다.</p>
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
        onOpenLog={onOpenChannelLog}
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
            key={autoModal.initial?.id || `new-${autoModal.initial?.ataTemplate || 'bms'}`}
            pausedText={autoModal.pausedText}
            initial={autoModal.initial}
            siblings={autoModal.siblings}
            startNew={autoModal.startNew}
            onSend={(id) => onSendText?.(id)}
            onSaved={() => { setPickedFilter('all'); refreshAfterAutoChange(autoModal.initial?.id); }}
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
