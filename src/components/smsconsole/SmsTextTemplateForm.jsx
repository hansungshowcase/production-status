import { useEffect, useId, useRef, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { IMAGE_MAX_BYTES, shrinkImage, textInfo } from './sendPanelModel.js';
import { getKstToday } from '../../utils/dateUtils.js';
import {
  BMS_TEMPLATE_ID, isBmsAta, AUTO_DEFAULT_DAYS, AUTO_DEFAULT_INTERVAL, AUTO_DEFAULT_REPEAT,
  AUTO_KIND, AUTO_KIND_ORDER, AUTO_KIND_PROCESS_PLUS, AUTO_KIND_DUE, AUTO_KIND_SHIP_PLAN, AUTO_KIND_SHIP_OR_DUE,
  AUDIENCE_SALES, AUTO_KIND_ORDER_CREATED, AUTO_KIND_PROCESS_STARTED, AUTO_KIND_PROCESS_COMPLETED,
  AUTO_KIND_MEMBER_JOINED, AUTO_KIND_LEAD_PLUS, AUDIENCE_STAFF, IMAGE_MAX, DAY_OFF_OPTIONS,
  mergeLayout, autoVariables, bodyVarNames, previewFill, isAdKind, isDateKind, isImmediateKind,
  moveImageEarlier, withAdFormat, TEXT_NAME_MAX, buildSaveBody, textFormStopText, validateTextForm,
  estimateFormSendCost, normalizeRepeat, normalizeInterval, normalizeOffset, dirDaily, catchupSpanText,
  SEND_TIMES, sendTimeLabel, hasSendTime, defaultSendTime, bootStages, stageOrder, stageLabel,
  duplicateStages, stageDirtySig, newStageValues, hasStageRow, LEAD_SOURCES, LEAD_SOURCE_OPTION_LABEL,
  autoConfirmLine, toggleRejectText,
} from './smsTextTemplateFormModel.js';
import { buildConditionSummary } from './smsTemplateListModel.js';
import { ModalFoot } from './SmsModal.jsx';
import './SmsTextTemplateForm.css';

const SENDER_PRESETS = [
  { value: '', label: '기본 발신번호' },
  { value: '0319862458', label: '031-986-2458 (대표)' },
  { value: '01077314237', label: '010-7731-4237' },
];

function formatPhonePreview(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^01\d{8,9}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}`;
  if (/^0\d{8,10}$/.test(d)) {
    const area = d.startsWith('02') ? 2 : 3;
    return `${d.slice(0, area)}-${d.slice(area, d.length - 4)}-${d.slice(-4)}`;
  }
  return d;
}

function hasAdvancedValues(v) {
  return Boolean(
    v.sendFrom
    || Number(v.repeat) > 1
    || v.weekdays
    || v.daily
    || v.copyTo
    || v.catchupOn
    || v.chainSubject
    || v.chainFrom
    || v.chainSales
    || (Array.isArray(v.chainDaysOff) && v.chainDaysOff.length > 0)
    || v.chainPlain
    || v.chainAfter,
  );
}

// 저장 직후 꺼짐 경고: 서버가 본문·조건 변경으로 자동 발송을 껐을 때(item.auto_disabled) 다시 켜기 전까지 고객에게 안 나간다는 것을 보인다.
// [다시 켜기]는 목록의 켜기와 같은 auto_toggle 흐름(dry_run 확인 줄 → 켜기 확인)을 쓴다.
export function AutoOffNotice({ id, photos = 0 }) {
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!confirm) setConfirm(await postSmsConsole('auto_toggle', { id, enabled: true, dry_run: true }));
      else { await postSmsConsole('auto_toggle', { id, enabled: true }); setConfirm(null); setDone(true); }
    } catch (err) { setConfirm(null); setError(toggleRejectText(err?.data?.reason || err?.data?.error?.reason || '') || err?.message || '다시 켜지 못했습니다.'); } finally { setBusy(false); }
  };
  if (done) return <p className="stf-done" role="status">다시 켰습니다</p>;
  return (
    <div className="stf-autooff" role="alert" data-auto-off-notice>
      <p>자동 발송이 꺼졌습니다. 다시 켜야 고객에게 나갑니다</p>
      {confirm ? <p className="stf-autooff-line">{autoConfirmLine(confirm, photos)}</p> : null}
      {error ? <p className="stf-autooff-line">{error}</p> : null}
      <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={run}>{confirm ? '켜기 확인' : '다시 켜기'}</button>
    </div>
  );
}

// 사진 여러 장을 mergeLayout 배치대로 한 장(JPEG, 200KB 이하)으로 그린다. 안 되면 Error('사진이 너무 큽니다').
async function mergeImages(list) {
  const imgs = await Promise.all(list.map(item => new Promise((resolve, reject) => { const el = new Image(); el.onload = () => resolve(el); el.onerror = () => reject(new Error('사진이 너무 큽니다')); el.src = item.url; })));
  const sizes = imgs.map(el => ({ width: el.naturalWidth, height: el.naturalHeight }));
  let edge = undefined;
  for (let round = 0; round < 6; round += 1) {
    const lay = mergeLayout(sizes, edge ? { maxEdge: edge } : undefined);
    const canvas = document.createElement('canvas');
    canvas.width = lay.width; canvas.height = lay.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, lay.width, lay.height);
    imgs.forEach((el, i) => ctx.drawImage(el, lay.rects[i].x, lay.rects[i].y, lay.rects[i].w, lay.rects[i].h));
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= IMAGE_MAX_BYTES) {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
        return { data: btoa(binary), bytes: blob.size, url: URL.createObjectURL(blob) };
      }
    }
    edge = Math.round(Math.max(lay.width, lay.height) * 0.8);
  }
  throw new Error('사진이 너무 큽니다');
}

// 문자 템플릿 등록·수정: 초보자용 4단계 흐름 + 실시간 단가/미리보기
export default function SmsTextTemplateForm({ onSend, onCancel, onSaved, initial, siblings, startNew, pausedText = '' }) {
  const [boot] = useState(() => bootStages(initial, siblings, startNew));
  const v0 = boot.values;
  const [stages, setStages] = useState(boot.stages); // 단계별 보관 값(지금 편집 중인 단계의 최신 값은 아래 칸 상태에 있다)
  const [activeKey, setActiveKey] = useState(boot.activeKey);
  const nextKey = useRef(2);
  const pendingError = useRef('');
  const [name, setName] = useState(v0.name);
  const [body, setBody] = useState(v0.body);
  const [images, setImages] = useState(v0.images); // 최대 3장
  const [autoKind, setAutoKind] = useState(v0.autoKind);
  const [days, setDays] = useState(v0.days);
  const [sendFrom, setSendFrom] = useState(v0.sendFrom);
  const [repeat, setRepeat] = useState(v0.repeat);
  const [interval, setInterval] = useState(v0.interval);
  const [offsetDir, setOffsetDir] = useState(v0.offsetDir);
  const [offsetDays, setOffsetDays] = useState(v0.offsetDays);
  const [unlessStep, setUnlessStep] = useState(v0.unlessStep);
  const [unlessMode, setUnlessMode] = useState(v0.unlessMode);
  const [daily, setDaily] = useState(v0.daily);
  const [weekdays, setWeekdays] = useState(v0.weekdays);
  const [step, setStep] = useState(v0.step);
  const [audience, setAudience] = useState(v0.audience);
  const [staff, setStaff] = useState(v0.staff);
  const [ataTemplate, setAtaTemplate] = useState(v0.ataTemplate);
  const [ataSelected, setAtaSelected] = useState(() => Boolean(v0.ataTemplate) && !isBmsAta(v0.ataTemplate));
  const [bmsButtons, setBmsButtons] = useState(v0.bmsButtons || []); // 브랜드메시지(자유형) 버튼 [{name, link, linkPc?}]
  const [leadSource, setLeadSource] = useState(v0.leadSource || ''); // 가입·문의 후 대상: '' 모두 · cafe24 회원가입 · airtable 견적 문의
  const [sendTime, setSendTime] = useState(v0.sendTime); // '' = 안 골랐음(칸에는 기본값이 보이고 저장 때는 빈 값)
  const [copyTo, setCopyTo] = useState(v0.copyTo || ''); // 사본 받을 번호(자동 발송이 고객에게 나간 날 같은 문자를 하루 1통)
  const [catchupOn, setCatchupOn] = useState(v0.catchupOn); // 이미 출고된 주문에도 한 번 보내기(기본 꺼짐)
  const [catchupFrom, setCatchupFrom] = useState(v0.catchupFrom); // 출고일 시작일(오늘까지)
  const [catchupDaily, setCatchupDaily] = useState(v0.catchupDaily || ''); // 문구별 하루 최대 건수(비우면 전역 상한)
  const [catchupAt, setCatchupAt] = useState(v0.catchupAt); // 보낼 시각 'YYYY-MM-DDTHH:MM'(KST)
  const [catchupInfo, setCatchupInfo] = useState({ loading: false, error: '', data: null });
  const [chainSubject, setChainSubject] = useState(v0.chainSubject || '');
  const [chainFrom, setChainFrom] = useState(v0.chainFrom || '');
  const [chainSales, setChainSales] = useState(v0.chainSales || '');
  const [chainDaysOff, setChainDaysOff] = useState(v0.chainDaysOff || []);
  const [chainPlain, setChainPlain] = useState(Boolean(v0.chainPlain));
  const [chainAfter, setChainAfter] = useState(v0.chainAfter || null);
  const [hadChain, setHadChain] = useState(Boolean(v0.hadChain));
  const [meta, setMeta] = useState({ steps: [], staff: [], ata: [] });
  const [imageError, setImageError] = useState('');
  const [adMark, setAdMark] = useState(() => !Boolean(v0.chainPlain));
  const [merge, setMerge] = useState(true); // 사진 2장 이상은 기본 한 장 합치기
  const [merged, setMerged] = useState(null);
  const [mergeFailed, setMergeFailed] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(() => hasAdvancedValues(v0));
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [offItems, setOffItems] = useState([]); // 저장 응답이 auto_disabled 인 문구(저장 직후 꺼짐 경고)
  const formId = useId();
  const fileRef = useRef(null);
  const bodyRef = useRef(null);
  useEffect(() => {
    let alive = true;
    fetchSmsConsole('auto_meta').then(out => { if (alive && out) setMeta({ steps: Array.isArray(out.steps) ? out.steps : [], staff: Array.isArray(out.staff) ? out.staff : [], ata: Array.isArray(out.ata_templates) ? out.ata_templates : [] }); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const dateKind = isDateKind(autoKind);
  const immKind = isImmediateKind(autoKind);
  const dayKind = Boolean(autoKind) && !dateKind && !immKind && autoKind !== AUTO_KIND_MEMBER_JOINED && autoKind !== AUTO_KIND_LEAD_PLUS;
  const leadKind = autoKind === AUTO_KIND_LEAD_PLUS;
  const supportsSameDay = autoKind === AUTO_KIND_ORDER || leadKind;
  const bmsOn = isBmsAta(ataTemplate);
  const channelMode = bmsOn ? 'bms' : ((ataTemplate || ataSelected) ? 'ata' : 'sms');
  const adOn = isAdKind(autoKind, ataTemplate) && adMark && !chainPlain;
  const outBody = adOn ? withAdFormat(body) : body;

  const check = validateTextForm({
    name, body: outBody, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily,
    audience, staff, step, ataTemplate, catchupOn, catchupFrom, catchupAt, catchupDaily, copyTo,
    imageCount: merge && images.length >= 2 ? 1 : images.length, bmsButtons,
    chainSubject: autoKind && !ataTemplate ? chainSubject : '',
    chainFrom: autoKind && !ataTemplate ? chainFrom : '',
    chainSales: dateKind ? chainSales : '',
  });

  useEffect(() => {
    setError(pendingError.current); pendingError.current = '';
  }, [name, body, images, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, unlessStep, unlessMode, daily, weekdays, step, audience, staff, ataTemplate, ataSelected, bmsButtons, adMark, sendTime, copyTo, catchupOn, catchupFrom, catchupAt, catchupDaily, leadSource, chainSubject, chainFrom, chainSales, chainDaysOff, chainPlain]);

  // 이미 출고된 주문 1회 발송 미리보기(읽기만)
  const catchupShown = autoKind === AUTO_KIND && catchupOn;
  const stageId = stages.find(item => item.key === activeKey)?.id;
  useEffect(() => {
    if (!catchupShown) { setCatchupInfo({ loading: false, error: '', data: null }); return undefined; }
    let alive = true;
    setCatchupInfo(prev => ({ ...prev, loading: true, error: '' }));
    fetchSmsConsole('catchup_preview', { bms: isBmsAta(ataTemplate) ? '1' : '', ad: ataTemplate ? '' : '1', from: /^\d{4}-\d{2}-\d{2}$/.test(catchupFrom) ? catchupFrom : getKstToday(), id: stageId, days: Number(days) || 0, daily: /^\d+$/.test(String(catchupDaily).trim()) ? String(catchupDaily).trim() : '' })
      .then(out => { if (!alive) return; setCatchupInfo({ loading: false, error: '', data: out }); if (!catchupFrom && out?.oldest_ship_date) setCatchupFrom(out.oldest_ship_date); })
      .catch(err => { if (alive) setCatchupInfo({ loading: false, error: err.message || '미리보기를 불러오지 못했습니다.', data: null }); });
    return () => { alive = false; };
  }, [catchupShown, catchupFrom, stageId, days, ataTemplate, catchupDaily]);

  const toggleCatchup = on => {
    setCatchupOn(on);
    if (on && !catchupAt) { const next = new Date(Date.parse(`${getKstToday()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); setCatchupAt(`${next}T09:00`); }
  };
  const pickAta = value => {
    setAtaTemplate(value);
    if (value) {
      setAudience('customer'); setStaff([]);
      if (value === BMS_TEMPLATE_ID) {
        if (!bmsButtons.length) setBmsButtons([{ name: '', link: '' }]);
        if (sendTime === '20:00') setSendTime('19:30');
        if (images.length >= 2 && !merge) setMerge(true);
      }
    } else {
      setCatchupOn(false);
    }
  };
  const pickChannel = mode => {
    if (mode !== 'sms' && autoKind === AUTO_KIND_PROCESS_PLUS) return;
    if (mode === 'sms') {
      setAtaSelected(false);
      pickAta('');
      return;
    }
    if (!autoKind) {
      setAutoKind(AUTO_KIND);
      if (!days || Number(days) < 1) setDays('2');
    }
    if (mode === 'bms') {
      setAtaSelected(false);
      pickAta(BMS_TEMPLATE_ID);
      return;
    }
    setAtaSelected(true);
    if (!ataTemplate || isBmsAta(ataTemplate)) {
      pickAta(meta.ata[0]?.id || '');
    }
  };
  const pickAutoMode = enabled => {
    if (enabled) {
      if (!autoKind) {
        setAutoKind(AUTO_KIND);
        if (!days || Number(days) < 1) setDays('2');
      }
      return;
    }
    setAutoKind('');
    setAtaSelected(false);
    pickAta('');
    setCatchupOn(false);
  };
  const pickAutoKind = nextKind => {
    setAutoKind(nextKind);
    if (nextKind === AUTO_KIND_PROCESS_PLUS && (ataTemplate || ataSelected)) {
      setAtaSelected(false);
      pickAta('');
    }
    if ((nextKind === AUTO_KIND || nextKind === AUTO_KIND_PROCESS_PLUS) && (days === '0' || days === '')) {
      setDays('2');
    }
  };
  const toggleDayOff = dayId => {
    setChainDaysOff(prev => (prev.includes(dayId) ? prev.filter(d => d !== dayId) : [...prev, dayId]));
  };
  const toggleChainPlain = on => {
    setChainPlain(on);
    if (on) setAdMark(false);
    else if (isAdKind(autoKind, ataTemplate)) setAdMark(true);
  };

  const setBmsButton = (index, patchValue) => setBmsButtons(prev => prev.map((item, i) => (i === index ? { ...item, ...patchValue } : item)));
  const insertVar = varName => {
    const el = bodyRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [body.length, body.length];
    const text = `#{${varName}}`;
    setBody(prev => `${prev.slice(0, at[0])}${text}${prev.slice(at[1])}`);
    setTimeout(() => { if (el) { el.focus(); el.setSelectionRange(at[0] + text.length, at[0] + text.length); } }, 0);
  };

  const wantMerge = merge && images.length >= 2;
  useEffect(() => {
    setMerged(null); setMergeFailed(false);
    if (!wantMerge) return undefined;
    let alive = true; let made = null;
    mergeImages(images).then(out => { made = out; if (alive) setMerged(out); else URL.revokeObjectURL(out.url); }).catch(err => { if (alive) { setMergeFailed(true); setImageError(err.message || '사진이 너무 큽니다'); } });
    return () => { alive = false; if (made) URL.revokeObjectURL(made.url); };
  }, [images, wantMerge]);
  const outImages = wantMerge && !mergeFailed ? (merged ? [merged] : []) : images;
  const mergePending = wantMerge && !mergeFailed && !merged;
  const toggleStaff = id => setStaff(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const { info } = check;
  const won = value => (value === null || value === undefined ? '확인 못 함' : `${Number(value).toLocaleString('ko-KR')}원`);
  const showTime = hasSendTime(autoKind, days);
  const timeOptions = bmsOn ? SEND_TIMES.filter(t => t !== '20:00') : SEND_TIMES;
  const effectiveTime = timeOptions.includes(sendTime) ? sendTime : (bmsOn && defaultSendTime(autoKind) === '20:00' ? '19:30' : defaultSendTime(autoKind));

  const costEst = estimateFormSendCost({ body: outBody, imageCount: images.length, merge, ataTemplate });
  const previewBodyText = previewFill(outBody);
  const previewCostEst = estimateFormSendCost({ body: previewBodyText, imageCount: images.length, merge, ataTemplate });
  const charCount = [...String(outBody || '')].length;
  const bmsMaxChars = (merge ? (images.length >= 1 ? 1 : 0) : images.length) >= 1 ? 400 : 1300;
  const bmsChars = [...String(body).replace(/#\{고객명\}/g, '가'.repeat(20))].length;
  const costBumpedByVar = !ataTemplate && !images.length && bodyVarNames(outBody).length > 0 && previewCostEst.type !== costEst.type;

  const summaryEntry = autoKind ? {
    autoKind,
    autoDays: Number(days) || 0,
    autoOffset: dateKind ? (normalizeOffset(offsetDir, offsetDays, daily) ?? 0) : 0,
    autoDaily: dateKind ? dirDaily(offsetDir, daily) : '',
    autoWeekdays: weekdays,
    autoUnlessStep: unlessStep,
    autoUnlessMode: unlessMode,
    autoStep: step,
    autoAudience: ataTemplate ? 'customer' : audience,
    autoStaffCount: staff.length,
    autoAtaTemplate: ataTemplate,
    autoSendTime: showTime ? sendTime : '',
    autoLeadSource: leadSource,
    autoSendFrom: dayKind && !ataTemplate ? sendFrom : '',
    autoRepeat: dayKind && !ataTemplate ? (normalizeRepeat(repeat) ?? AUTO_DEFAULT_REPEAT) : AUTO_DEFAULT_REPEAT,
    autoInterval: dayKind && !ataTemplate ? (normalizeInterval(interval) ?? AUTO_DEFAULT_INTERVAL) : AUTO_DEFAULT_INTERVAL,
    autoCopyTo: (autoKind === AUTO_KIND || autoKind === AUTO_KIND_ORDER) && !ataTemplate ? copyTo : '',
    autoCatchupAt: catchupShown ? catchupAt : '',
    autoCatchupFrom: catchupShown ? catchupFrom : '',
    autoCatchupDaily: catchupShown ? catchupDaily : '',
    autoSales: dateKind ? chainSales : '',
    autoDaysOff: dateKind ? chainDaysOff : [],
    autoFrom: !ataTemplate ? chainFrom : '',
    sendCost: { type: costEst.type, unit: costEst.unit, fallback_unit: costEst.fallbackUnit },
  } : null;
  const summary = summaryEntry ? buildConditionSummary(summaryEntry, { isMine: true }) : null;

  const showAdvSubject = Boolean(autoKind && (!ataTemplate || chainSubject));
  const showAdvFrom = Boolean(autoKind && (!ataTemplate || chainFrom));
  const showAdvRepeat = Boolean((dayKind && !ataTemplate) || dateKind);
  const showAdvSales = Boolean(dateKind && audience !== AUDIENCE_SALES);
  const showAdvDaysOff = Boolean(dateKind);
  const showAdvCopy = Boolean((autoKind === AUTO_KIND || autoKind === AUTO_KIND_ORDER) && !ataTemplate);
  const showAdvPlain = Boolean(autoKind && (!ataTemplate || chainPlain));
  const showAdvCatchup = autoKind === AUTO_KIND;
  const showAdvSection = showAdvSubject || showAdvFrom || showAdvRepeat || showAdvSales || showAdvDaysOff || showAdvCopy || showAdvPlain || showAdvCatchup || Boolean(chainAfter);

  const activeAdvItems = [
    showAdvSubject && chainSubject.trim(),
    showAdvFrom && chainFrom.trim(),
    showAdvRepeat && (sendFrom || (dayKind && Number(repeat) > 1) || (dateKind && (Boolean(daily) || weekdays))),
    showAdvSales && chainSales.trim(),
    showAdvDaysOff && chainDaysOff.length > 0,
    showAdvCopy && copyTo.trim(),
    showAdvPlain && chainPlain,
    showAdvCatchup && catchupOn,
    Boolean(chainAfter),
  ].filter(Boolean).length;

  // ---- 단계(같은 흐름의 문구 여러 개) ----
  const collect = () => ({
    leadSource, name, body, images, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays,
    unlessStep, unlessMode, daily, weekdays, step, audience, staff, ataTemplate, bmsButtons, sendTime,
    copyTo, catchupOn, catchupFrom, catchupAt, catchupDaily,
    chainSubject, chainFrom, chainSales, chainDaysOff, chainPlain, chainAfter, hadChain,
  });
  const applyValues = v => {
    setName(v.name); setBody(v.body); setImages(v.images); setAutoKind(v.autoKind); setDays(v.days); setSendFrom(v.sendFrom); setRepeat(v.repeat); setInterval(v.interval);
    setOffsetDir(v.offsetDir); setOffsetDays(v.offsetDays); setUnlessStep(v.unlessStep); setUnlessMode(v.unlessMode); setDaily(v.daily); setWeekdays(v.weekdays);
    setStep(v.step); setAudience(v.audience); setStaff(v.staff); setAtaTemplate(v.ataTemplate);
    setAtaSelected(Boolean(v.ataTemplate) && !isBmsAta(v.ataTemplate));
    setBmsButtons(v.bmsButtons || []); setSendTime(v.sendTime); setCopyTo(v.copyTo || '');
    setCatchupOn(v.catchupOn); setCatchupFrom(v.catchupFrom); setCatchupAt(v.catchupAt); setCatchupDaily(v.catchupDaily || ''); setLeadSource(v.leadSource || '');
    setChainSubject(v.chainSubject || ''); setChainFrom(v.chainFrom || ''); setChainSales(v.chainSales || '');
    setChainDaysOff(v.chainDaysOff || []); setChainPlain(Boolean(v.chainPlain)); setChainAfter(v.chainAfter || null); setHadChain(Boolean(v.hadChain));
    setAdMark(!Boolean(v.chainPlain));
    if (hasAdvancedValues(v)) setAdvancedOpen(true);
    setImageError('');
  };
  const forms = stages.map(item => (item.key === activeKey ? collect() : item.form));
  const dupSet = duplicateStages(forms);
  const dirtyOf = (item, f) => item.base === null || stageDirtySig(f) !== item.base || (merge && f.images.length >= 2);
  const multi = stages.length > 1;
  const dirtyCount = multi ? stages.filter((item, i) => dirtyOf(item, forms[i])).length : 0;
  const showStages = hasStageRow(autoKind, siblings) || multi;
  const chips = stages.map((item, i) => ({ key: item.key, label: stageLabel(forms[i]), order: stageOrder(forms[i]), dirty: multi && dirtyOf(item, forms[i]), dup: dupSet.has(i), failed: item.failed && item.key !== activeKey, idx: i })).sort((a, b) => (a.order ?? 9999) - (b.order ?? 9999) || a.idx - b.idx);
  const switchTo = key => {
    if (key === activeKey) return;
    const target = stages.find(item => item.key === key);
    if (!target) return;
    const cur = collect();
    setStages(prev => prev.map(item => (item.key === activeKey ? { ...item, form: cur } : item)));
    applyValues(target.form);
    setActiveKey(key);
  };
  const addStage = withContent => {
    const cur = collect();
    const key = `n${nextKey.current}`;
    nextKey.current += 1;
    const form = newStageValues(cur, withContent);
    setStages(prev => [...prev.map(item => (item.key === activeKey ? { ...item, form: cur } : item)), { key, id: undefined, form, base: null, failed: false }]);
    applyValues(form);
    setActiveKey(key);
  };
  const failAt = (i, text) => {
    pendingError.current = text;
    setError(text);
    setStages(prev => prev.map((item, n) => (n === i ? { ...item, failed: true } : item)));
    if (stages[i].key !== activeKey) switchTo(stages[i].key);
  };

  const pickImage = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || images.length >= IMAGE_MAX) return;
    setImageError('');
    try {
      const next = await shrinkImage(file);
      setImages(prev => (prev.length >= IMAGE_MAX ? prev : [...prev, next]));
    } catch (err) { setImageError(err.message || '사진이 너무 큽니다'); }
  };
  const removeImage = index => {
    setImages(prev => { if (prev[index]?.url) URL.revokeObjectURL(prev[index].url); return prev.filter((_, i) => i !== index); });
    setImageError('');
  };

  const submit = async () => {
    if (busy || mergePending) return;
    const cur = collect();
    const list = stages.map((item, i) => ({ item, f: item.key === activeKey ? cur : item.form, i }));
    const pick = multi ? list.filter(({ item, f }) => dirtyOf(item, f)) : list;
    setStages(prev => prev.map(item => (item.failed ? { ...item, failed: false } : item)));
    const clash = pick.find(({ i }) => dupSet.has(i));
    if (multi && clash) { failAt(clash.i, textFormStopText('dup')); return; }
    if (autoKind && ataSelected && !ataTemplate) {
      failAt(stages.findIndex(item => item.key === activeKey), '사용할 카카오 알림톡 템플릿을 골라 주세요');
      return;
    }
    const outOf = f => (isAdKind(f.autoKind, f.ataTemplate) && adMark && !f.chainPlain ? withAdFormat(f.body) : f.body);
    for (const { f, i } of pick) {
      const fDate = isDateKind(f.autoKind);
      const chk = validateTextForm({
        name: f.name, body: outOf(f), autoKind: f.autoKind, days: f.days, sendFrom: f.sendFrom, repeat: f.repeat,
        interval: f.interval, offsetDir: f.offsetDir, offsetDays: f.offsetDays, daily: f.daily,
        audience: f.audience, staff: f.staff, step: f.step, ataTemplate: f.ataTemplate,
        catchupOn: f.catchupOn, catchupFrom: f.catchupFrom, catchupAt: f.catchupAt, catchupDaily: f.catchupDaily,
        copyTo: f.copyTo, imageCount: merge && f.images.length >= 2 ? 1 : f.images.length, bmsButtons: f.bmsButtons,
        chainSubject: f.autoKind ? f.chainSubject : '',
        chainFrom: f.autoKind ? f.chainFrom : '',
        chainSales: fDate ? f.chainSales : '',
      });
      if (!chk.ok) { failAt(i, textFormStopText(chk.reason)); return; }
    }
    setBusy(true);
    setError('');
    let last = null;
    let broke = false;
    for (const { item, f, i } of pick) {
      let made = null;
      try {
        let imgs = outImages;
        if (item.key !== activeKey) {
          imgs = f.images;
          if (merge && f.images.length >= 2) { made = await mergeImages(f.images); imgs = [made]; }
        }
        const fDate = isDateKind(f.autoKind);
        const payload = buildSaveBody({
          id: item.id,
          name: f.name,
          body: outOf(f),
          images: imgs,
          auto: {
            leadSource: f.leadSource, kind: f.autoKind, days: f.days, sendFrom: f.sendFrom, repeat: f.repeat,
            interval: f.interval, offsetDir: f.offsetDir, offsetDays: f.offsetDays, daily: f.daily,
            unlessStep: f.unlessStep, unlessMode: f.unlessMode, weekdays: f.weekdays, step: f.step,
            audience: f.audience, staff: f.staff, ataTemplate: f.ataTemplate, bmsButtons: f.bmsButtons,
            sendTime: f.sendTime, copyTo: f.copyTo, catchupOn: f.catchupOn, catchupFrom: f.catchupFrom,
            catchupAt: f.catchupAt, catchupDaily: f.catchupDaily,
          },
          chain: {
            subject: f.autoKind ? f.chainSubject : '',
            from: f.autoKind ? f.chainFrom : '',
            sales: fDate ? f.chainSales : '',
            daysOff: fDate ? f.chainDaysOff : [],
            plain: f.autoKind ? f.chainPlain : false,
            after: f.autoKind ? f.chainAfter : null,
            hadChain: Boolean(f.hadChain),
          },
        });
        const out = await postSmsConsole('text_template_save', payload);
        last = out.item;
        if (out.item?.auto_disabled === true) setOffItems(prev => [...prev.filter(x => x.id !== out.item.id), { id: out.item.id, photos: Array.isArray(imgs) ? imgs.length : 0 }]);
        setStages(prev => prev.map(x => (x.key === item.key ? { ...x, id: out.item.id, base: stageDirtySig(f) } : x)));
      } catch (err) {
        broke = true;
        failAt(i, textFormStopText(err?.data?.reason) || err.message || '등록하지 못했습니다.');
        break;
      } finally { if (made) URL.revokeObjectURL(made.url); }
    }
    setBusy(false);
    if (last) onSaved?.(last);
    if (!broke) setSaved(last || { id: stages.find(x => x.key === activeKey)?.id });
  };

  if (saved) {
    return (
      <div className="stf-form">
        <p className="stf-done" role="status">등록했습니다</p>
        {offItems.map(item => <AutoOffNotice key={item.id} id={item.id} photos={item.photos} />)}
        <div className="stf-actions">
          {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>목록</button> : null}
          {autoKind ? null : <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => onSend(saved.id)}>이 문구로 보내기</button>}
        </div>
      </div>
    );
  }

  const visibleButtons = bmsOn ? bmsButtons.filter(b => b && String(b.name || '').trim()) : [];
  const selectedAta = ataTemplate && !bmsOn ? meta.ata.find(item => item.id === ataTemplate) : null;

  return (
    <div className="stf-split">
      <form id={formId} className={`stf-form${showStages ? ' has-stages' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
        <div className="stf-mob-preview-bar">
          <span className="stf-mob-preview-cost">{costEst.badgeText}</span>
          <button type="button" className="ktm-btn" aria-expanded={mobilePreviewOpen} onClick={() => setMobilePreviewOpen(prev => !prev)}>
            {mobilePreviewOpen ? '미리보기 접기' : '미리보기 보기'}
          </button>
        </div>

        {showStages ? (
          <div className="stf-stages-wrap">
            <div className="stf-stages" role="group" aria-label="단계">
              {chips.map(chip => (
                <button key={chip.key} type="button" className={`ktm-btn stf-chip${chip.key === activeKey ? ' is-active' : ''}${chip.dirty ? ' is-dirty' : ''}${chip.dup ? ' is-dup' : ''}${chip.failed ? ' is-failed' : ''}`} aria-pressed={chip.key === activeKey} onClick={() => switchTo(chip.key)}>
                  {chip.label}{chip.dirty ? <i className="stf-dot" aria-hidden="true" /> : null}
                </button>
              ))}
              {immKind || autoKind === AUTO_KIND_MEMBER_JOINED ? null : <button type="button" className="ktm-btn stf-stage-add" onClick={() => addStage(false)}>+ 단계 추가</button>}
              {immKind || autoKind === AUTO_KIND_MEMBER_JOINED ? null : <button type="button" className="ktm-btn stf-stage-clone" onClick={() => addStage(true)}>현재 단계 복제</button>}
            </div>
            <p className="stf-stages-note">같은 조건에서 날짜·단계별로 여러 통을 이어서 보낼 수 있습니다.</p>
          </div>
        ) : null}

        {/* 1단계: 발송 수단 */}
        <section className="stf-step" aria-label="1단계 무엇으로 보낼까요">
          <div className="stf-step-head">
            <h3 className="stf-step-title"><span className="stf-step-num">1</span>무엇으로 보낼까요?</h3>
            <span className="stf-step-sub">{costEst.badgeText}</span>
          </div>
          <div className="stf-ch-grid" role="group" aria-label="발송 수단 선택">
            <button type="button" className={`stf-ch-card${channelMode === 'sms' ? ' is-active' : ''}`} aria-pressed={channelMode === 'sms'} onClick={() => pickChannel('sms')}>
              <span className="stf-ch-title">문자</span>
              <span className="stf-ch-price">단문 18원 · 장문 45원 · 사진 110원</span>
              <span className="stf-ch-desc">별도 승인 없이 바로 발송, 사진 최대 3장</span>
            </button>
            <button
              type="button"
              className={`stf-ch-card${channelMode === 'ata' ? ' is-active' : ''}`}
              aria-pressed={channelMode === 'ata'}
              disabled={autoKind === AUTO_KIND_PROCESS_PLUS}
              title={autoKind === AUTO_KIND_PROCESS_PLUS ? '공정 시작 후 조건은 문자로만 보낼 수 있습니다' : ''}
              onClick={() => pickChannel('ata')}
            >
              <span className="stf-ch-title">카카오 알림톡</span>
              <span className="stf-ch-price">건당 13원</span>
              <span className="stf-ch-desc">승인된 카톡 안내문으로 발송 (고객 전용)</span>
            </button>
            <button
              type="button"
              className={`stf-ch-card${channelMode === 'bms' ? ' is-active' : ''}`}
              aria-pressed={channelMode === 'bms'}
              disabled={autoKind === AUTO_KIND_PROCESS_PLUS}
              title={autoKind === AUTO_KIND_PROCESS_PLUS ? '공정 시작 후 조건은 문자로만 보낼 수 있습니다' : ''}
              onClick={() => pickChannel('bms')}
            >
              <span className="stf-ch-title">카카오 브랜드메시지</span>
              <span className="stf-ch-price">건당 100원 (대체 45원)</span>
              <span className="stf-ch-desc">사진 1장 + 링크 버튼, 미친구는 장문문자 대체</span>
            </button>
          </div>
          {autoKind === AUTO_KIND_PROCESS_PLUS ? <p className="stf-hint">공정 시작 후 조건은 일반 문자로만 발송할 수 있습니다.</p> : null}
          {channelMode === 'ata' ? (
            <div className="stf-subbox">
              <label htmlFor={`${formId}-ata`}>사용할 카카오 알림톡 템플릿</label>
              <select id={`${formId}-ata`} value={ataTemplate} aria-label="발송 수단" onChange={event => pickAta(event.target.value)}>
                <option value="">알림톡 템플릿을 선택해 주세요</option>
                {ataTemplate && !bmsOn && !meta.ata.some(item => item.id === ataTemplate) ? <option value={ataTemplate}>{`목록에 없는 알림톡 (…${ataTemplate.slice(-4)})`}</option> : null}
                {meta.ata.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <p className="stf-hint">{selectedAta ? '승인된 알림톡 템플릿 내용·변수에 맞춰 발송됩니다.' : '카카오에서 승인받은 알림톡 템플릿만 목록에 표시됩니다.'}</p>
            </div>
          ) : null}
        </section>

        {/* 2단계: 언제, 누구에게 */}
        <section className="stf-step" aria-label="2단계 언제 누구에게 보낼까요">
          <div className="stf-step-head">
            <h3 className="stf-step-title"><span className="stf-step-num">2</span>언제, 누구에게 보낼까요?</h3>
            <div className="stf-seg" role="group" aria-label="발송 방식 선택">
              <button type="button" className={`stf-seg-btn${autoKind ? ' is-active' : ''}`} aria-pressed={Boolean(autoKind)} onClick={() => pickAutoMode(true)}>조건 맞으면 자동 발송</button>
              <button type="button" className={`stf-seg-btn${!autoKind ? ' is-active' : ''}`} aria-pressed={!autoKind} onClick={() => pickAutoMode(false)}>직접 보낼 때만 (수동)</button>
            </div>
          </div>

          {autoKind ? (
            <div className="stf-conds">
              <div className="stf-line">
                <span className="stf-tag">발송 시점</span>
                <div className="stf-cells">
                  <select value={autoKind} aria-label="자동 발송" onChange={event => pickAutoKind(event.target.value)}>
                    <optgroup label="주문·회원 기준">
                      <option value={AUTO_KIND_ORDER_CREATED}>주문 등록 시 (바로 발송)</option>
                      <option value={AUTO_KIND_ORDER}>주문 등록 후 (당일 · N일 뒤)</option>
                      <option value={AUTO_KIND_MEMBER_JOINED}>자사몰 회원가입 시 (바로 발송)</option>
                      <option value={AUTO_KIND_LEAD_PLUS}>가입·문의 접수 후 (당일 · N일 뒤)</option>
                    </optgroup>
                    <optgroup label="제작 공정 기준">
                      <option value={AUTO_KIND_PROCESS_STARTED}>공정 시작 시 (바로 발송)</option>
                      <option value={AUTO_KIND_PROCESS_COMPLETED}>공정 완료 시 (바로 발송)</option>
                      <option value={AUTO_KIND_PROCESS_PLUS}>공정 시작 후 (N일 뒤)</option>
                    </optgroup>
                    <optgroup label="출고·납기일 기준">
                      <option value={AUTO_KIND}>출고 완료 후 (N일 뒤)</option>
                      <option value={AUTO_KIND_DUE}>납기일 기준 (전 · 당일 · 지남)</option>
                      <option value={AUTO_KIND_SHIP_PLAN}>출고예정일 기준 (전 · 당일 · 지남)</option>
                      <option value={AUTO_KIND_SHIP_OR_DUE}>출고·납기일 기준 (없으면 납기일)</option>
                    </optgroup>
                  </select>

                  {supportsSameDay ? (
                    <div className="stf-seg" role="group" aria-label="당일 또는 며칠 뒤">
                      <button type="button" className={`stf-seg-btn${days === '0' ? ' is-active' : ''}`} aria-pressed={days === '0'} onClick={() => setDays('0')}>당일</button>
                      <button type="button" className={`stf-seg-btn${days !== '0' ? ' is-active' : ''}`} aria-pressed={days !== '0'} onClick={() => { if (days === '0' || !days) setDays('1'); }}>며칠 뒤</button>
                    </div>
                  ) : null}

                  {(dayKind || leadKind) && (!supportsSameDay || days !== '0') ? (
                    <span className="stf-inline">
                      <input type="text" inputMode="numeric" className="stf-days" value={days} maxLength={3} aria-label="일수" onChange={event => setDays(event.target.value)} />
                      <span>일 뒤</span>
                    </span>
                  ) : null}

                  {leadKind ? (
                    <select value={leadSource} aria-label="대상" onChange={event => setLeadSource(event.target.value)}>
                      {LEAD_SOURCES.map(source => <option key={source} value={source}>{LEAD_SOURCE_OPTION_LABEL[source]}</option>)}
                    </select>
                  ) : null}

                  {dateKind ? (
                    <div className="stf-seg" role="group" aria-label="기준일 전후">
                      <button type="button" className={`stf-seg-btn${offsetDir === 'before' ? ' is-active' : ''}`} aria-pressed={offsetDir === 'before'} onClick={() => setOffsetDir('before')}>며칠 전</button>
                      <button type="button" className={`stf-seg-btn${offsetDir === 'same' ? ' is-active' : ''}`} aria-pressed={offsetDir === 'same'} onClick={() => setOffsetDir('same')}>당일</button>
                      <button type="button" className={`stf-seg-btn${offsetDir === 'after' ? ' is-active' : ''}`} aria-pressed={offsetDir === 'after'} onClick={() => setOffsetDir('after')}>며칠 지남</button>
                    </div>
                  ) : null}

                  {dateKind && offsetDir !== 'same' ? (
                    <span className="stf-inline">
                      <input type="text" inputMode="numeric" className="stf-days" value={offsetDays} maxLength={3} aria-label="일수" onChange={event => setOffsetDays(event.target.value)} />
                      <span>{offsetDir === 'before' ? '일 전' : '일 지남'}</span>
                    </span>
                  ) : null}

                  {showTime ? (
                    <select className="stf-time" value={effectiveTime} aria-label="발송 시각" onChange={event => setSendTime(event.target.value)}>
                      {timeOptions.map(time => <option key={time} value={time}>{sendTimeLabel(time)}</option>)}
                    </select>
                  ) : null}
                </div>
              </div>

              {dateKind || immKind ? (
                <div className="stf-line">
                  <span className="stf-tag">받는 사람</span>
                  <div className="stf-cells">
                    <select value={ataTemplate ? 'customer' : audience} aria-label="받는 사람" disabled={Boolean(ataTemplate)} onChange={event => setAudience(event.target.value)}>
                      <option value="customer">고객</option>
                      {ataTemplate ? null : <option value={AUDIENCE_STAFF}>직원 (내부 알림)</option>}
                      {dateKind && !ataTemplate ? <option value={AUDIENCE_SALES}>영업담당 (내부 알림)</option> : null}
                    </select>
                    {!ataTemplate && audience === AUDIENCE_STAFF ? meta.staff.map(person => (
                      <button key={person.id} type="button" className={`ktm-btn stf-staff${staff.includes(person.id) ? ' is-active' : ''}`} aria-pressed={staff.includes(person.id)} onClick={() => toggleStaff(person.id)}>{person.name}</button>
                    )) : null}
                  </div>
                </div>
              ) : null}

              {dateKind || (immKind && autoKind !== AUTO_KIND_ORDER_CREATED && autoKind !== AUTO_KIND_MEMBER_JOINED) || autoKind === AUTO_KIND_PROCESS_PLUS ? (
                <div className="stf-line">
                  <span className="stf-tag">{dateKind ? '공정 제외' : '기준 공정'}</span>
                  <div className="stf-cells">
                    {dateKind ? (
                      <select value={unlessStep} aria-label="미완료 공정" onChange={event => setUnlessStep(event.target.value)}>
                        <option value="">모든 주문 (공정 조건 없음)</option>
                        {unlessStep && !meta.steps.includes(unlessStep) ? <option value={unlessStep}>{unlessStep}</option> : null}
                        {meta.steps.map(item => <option key={item} value={item}>{item}</option>)}
                      </select>
                    ) : (
                      <select value={step} aria-label="공정" onChange={event => setStep(event.target.value)}>
                        <option value="">공정을 선택해 주세요</option>
                        {step && !meta.steps.includes(step) ? <option value={step}>{step}</option> : null}
                        {meta.steps.map(item => <option key={item} value={item}>{item}</option>)}
                      </select>
                    )}
                    {dateKind && unlessStep ? (
                      <select value={unlessMode} aria-label="공정 조건" onChange={event => setUnlessMode(event.target.value)}>
                        <option value="completed">공정 미완료만 발송</option>
                        <option value="started">공정 미착수만 발송</option>
                      </select>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {pausedText ? <p className="ktm-alert" role="alert">{pausedText}</p> : null}

              {summary ? (
                <div className="stf-summary" aria-label="발송 조건 요약">
                  <div className="stf-summary-grid">
                    <div className="stf-summary-cell">
                      <span className="stf-summary-label">언제 발송</span>
                      <span className="stf-summary-val">{summary.whenMain}</span>
                      {summary.whenSub ? <span className="stf-summary-sub">{summary.whenSub}</span> : null}
                    </div>
                    <div className="stf-summary-cell">
                      <span className="stf-summary-label">누구에게</span>
                      <span className="stf-summary-val">{summary.whoMain}</span>
                      {summary.whoSub ? <span className="stf-summary-sub">{summary.whoSub}</span> : null}
                    </div>
                    <div className="stf-summary-cell">
                      <span className="stf-summary-label">횟수 · 비용</span>
                      <span className="stf-summary-val">{summary.howMain}</span>
                      {summary.howSub ? <span className="stf-summary-sub">{summary.howSub}</span> : null}
                    </div>
                  </div>
                  {summary.tags.length || summary.catchup ? (
                    <div className="stf-summary-tags">
                      {summary.tags.map(tag => <span key={tag} className="stf-summary-tag">{tag}</span>)}
                      {summary.catchup ? <span className="stf-summary-tag">{summary.catchup}</span> : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="stf-summary" aria-label="수동 발송 안내">
              <div className="stf-summary-grid">
                <div className="stf-summary-cell">
                  <span className="stf-summary-label">발송 방식</span>
                  <span className="stf-summary-val">수동 발송 (보내기 화면)</span>
                  <span className="stf-summary-sub">자동으로 나가지 않고 필요할 때 직접 골라 보냅니다.</span>
                </div>
                <div className="stf-summary-cell">
                  <span className="stf-summary-label">누구에게</span>
                  <span className="stf-summary-val">발송 시 직접 선택</span>
                  <span className="stf-summary-sub">보낼 대상을 그때그때 지정합니다.</span>
                </div>
                <div className="stf-summary-cell">
                  <span className="stf-summary-label">예상 단가</span>
                  <span className="stf-summary-val">{costEst.kindLabel}</span>
                  <span className="stf-summary-sub">건당 {won(costEst.unit)}</span>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* 3단계: 문구와 사진 작성 */}
        <section className="stf-step" aria-label="3단계 문구와 사진 작성">
          <div className="stf-step-head">
            <h3 className="stf-step-title"><span className="stf-step-num">3</span>문구와 사진 작성</h3>
          </div>

          <label className="stf-field stf-field-full">템플릿 이름 (관리용)
            <input type="text" placeholder="예: 출고 20일 뒤 소개 혜택 안내 (고객에게는 안 보임)" value={name} maxLength={TEXT_NAME_MAX} autoComplete="off" onChange={event => setName(event.target.value)} />
          </label>

          <label className="stf-field stf-field-full">메시지 내용
            <textarea ref={bodyRef} rows={autoKind ? 5 : 6} placeholder="고객에게 보낼 내용을 입력하세요. 아래 변수 버튼을 누르면 이름이나 주문번호가 자동으로 채워집니다." value={body} onChange={event => setBody(event.target.value)} />
          </label>

          <div className="stf-meta">
            <span className="stf-vars">
              {autoVariables(autoKind, audience, ataTemplate).map(item => (
                <button key={item} type="button" className="ktm-btn stf-var" onClick={() => insertVar(item)}>+ {item}</button>
              ))}
            </span>
            <span className={`stf-count${info.tooLong || (bmsOn && bmsChars > bmsMaxChars) ? ' is-over' : ''}`}>
              <strong>{costEst.badgeText}</strong>
              {bmsOn
                ? ` · ${bmsChars}/${bmsMaxChars}자`
                : ` · ${charCount}자 (${info.bytes}/2000바이트)`}
              {info.tooLong ? ' · 글자 한도 초과' : ''}
              {costBumpedByVar ? ` · 변수 채우면 ${previewCostEst.badgeText}` : ''}
            </span>
          </div>

          {isAdKind(autoKind, ataTemplate) && !chainPlain ? (
            <label className="stf-inline">
              <input type="checkbox" className="stf-check" checked={adMark} onChange={event => setAdMark(event.target.checked)} />
              <span>(광고) 문구와 080 무료수신거부 자동으로 붙이기 (광고성 문자 법적 필수)</span>
            </label>
          ) : null}

          <div className="stf-photos">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
            <button type="button" className="ktm-btn" disabled={images.length >= IMAGE_MAX} onClick={() => fileRef.current?.click()}>
              + 사진 첨부 ({images.length}/{IMAGE_MAX})
            </button>
            {images.length >= 2 ? (
              <label className="stf-inline">
                <input type="checkbox" className="stf-check" checked={merge} onChange={event => setMerge(event.target.checked)} />
                <span>한 장으로 합치기 (1통 110원으로 절약)</span>
              </label>
            ) : null}
            {images.map((item, index) => (
              <span key={item.url || index} className="stf-photo">
                <img className="stf-thumb" src={item.url} alt="" />
                {index > 0 ? <button type="button" className="ktm-btn" onClick={() => setImages(prev => moveImageEarlier(prev, index))}>앞으로</button> : null}
                <button type="button" className="ktm-btn" onClick={() => removeImage(index)}>빼기</button>
              </span>
            ))}
          </div>
          {bmsOn && images.length >= 2 && !merge ? (
            <p className="ktm-alert" role="alert">브랜드메시지는 사진 1장만 보낼 수 있습니다. &apos;한 장으로 합치기&apos;를 켜거나 사진 1장만 남겨 주세요.</p>
          ) : null}

          {autoKind && bmsOn ? (
            <div className="stf-subbox" aria-label="브랜드메시지 버튼">
              <div className="stf-step-head">
                <span className="stf-sublabel">링크 버튼 (최대 5개)</span>
                {bmsButtons.length < 5 ? (
                  <button type="button" className="ktm-btn" onClick={() => setBmsButtons(prev => [...prev, { name: '', link: '' }])}>+ 버튼 추가</button>
                ) : null}
              </div>
              <div className="stf-bms-list">
                {bmsButtons.map((button, index) => (
                  <div key={index} className="stf-bms-card">
                    <div className="stf-bms-top">
                      <input type="text" value={button.name} maxLength={14} placeholder="버튼 이름 (14자까지)" aria-label={`버튼 ${index + 1} 이름`} onChange={event => setBmsButton(index, { name: event.target.value })} />
                      <input type="text" inputMode="url" value={button.link} maxLength={1000} placeholder="모바일 링크 (https://...)" aria-label={`버튼 ${index + 1} 링크`} onChange={event => setBmsButton(index, { link: event.target.value })} />
                      <button type="button" className="ktm-btn" aria-label={`버튼 ${index + 1} 지우기`} onClick={() => setBmsButtons(prev => prev.filter((_, i) => i !== index))}>지우기</button>
                    </div>
                    <div className="stf-bms-pc">
                      <span className="stf-bms-pclabel">PC 링크 (선택)</span>
                      <input type="text" inputMode="url" value={button.linkPc || ''} maxLength={1000} placeholder="비우면 모바일 링크와 같게 열립니다 (https://...)" aria-label={`버튼 ${index + 1} PC 링크`} onChange={event => setBmsButton(index, { linkPc: event.target.value })} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="stf-hint">
                사진과 함께면 400자, 글만이면 1,300자까지(고객명은 20자로 계산, 현재 {bmsChars}자). 채널 친구가 아니면 장문문자(45원)로 대체 발송되며 오전 8시~오후 8시 사이에만 발송됩니다.
              </p>
            </div>
          ) : null}
        </section>

        {/* 4단계: 추가 설정 (접기/펼치기) */}
        {showAdvSection ? (
          <section className="stf-step" aria-label="4단계 추가 설정">
            <div className="stf-adv">
              <button type="button" className="stf-adv-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(prev => !prev)}>
                <span className="stf-adv-left">
                  <span className="stf-step-num">4</span>
                  <span className="stf-adv-title">추가 설정 (제목 · 발신번호 · 반복 · 사본 · 휴무일)</span>
                  {activeAdvItems > 0 ? <span className="stf-adv-badge">{activeAdvItems}개 사용 중</span> : null}
                </span>
                <span className="stf-adv-chevron">{advancedOpen ? '접기 ▴' : '열기 ▾'}</span>
              </button>

              {advancedOpen ? (
                <div className="stf-adv-body">
                  {showAdvSubject ? (
                    <label className="stf-field">문자 제목 (선택 · 장문/사진 문자 상단에 굵게 표시)
                      <input type="text" placeholder="비우면 제목 없이 본문만 나갑니다 (최대 40자)" value={chainSubject} maxLength={40} onChange={event => setChainSubject(event.target.value)} />
                    </label>
                  ) : null}

                  {showAdvFrom ? (
                    <div className="stf-field">
                      <span>별도 발신번호 (선택)</span>
                      <input type="text" inputMode="tel" placeholder="비우면 시스템 기본 발신번호로 나갑니다 (숫자 8~12자리)" value={chainFrom} maxLength={13} onChange={event => setChainFrom(event.target.value.replace(/[^\d-]/g, ''))} />
                      <div className="stf-presets">
                        {SENDER_PRESETS.map(preset => {
                          const normalized = chainFrom.replace(/\D/g, '');
                          const activePreset = normalized === preset.value;
                          return (
                            <button key={preset.label} type="button" className={`ktm-btn stf-preset${activePreset ? ' is-active' : ''}`} onClick={() => setChainFrom(preset.value)}>
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {showAdvRepeat ? (
                    <div className="stf-line">
                      <span className="stf-tag">반복 · 요일</span>
                      <div className="stf-cells">
                        {dayKind ? (
                          <span className="stf-inline">
                            <input type="date" value={sendFrom} aria-label="시작일" onChange={event => setSendFrom(event.target.value)} />
                            <span>이후부터</span>
                            <input type="text" inputMode="numeric" className="stf-days" value={repeat} maxLength={2} aria-label="횟수" onChange={event => setRepeat(event.target.value)} />
                            <span>번</span>
                            {Number(repeat) >= 2 ? (
                              <>
                                <input type="text" inputMode="numeric" className="stf-days" value={interval} maxLength={3} aria-label="간격" onChange={event => setInterval(event.target.value)} />
                                <span>일 간격</span>
                              </>
                            ) : null}
                          </span>
                        ) : null}
                        {dateKind && daily === 'once' ? <span className="stf-chain-badge" title="기존 '납기 전까지 한 번만' 설정이 유지됩니다">놓친 건 납기 전까지 1회 발송</span> : null}
                        {dateKind && daily !== 'once' ? <label><input type="checkbox" className="stf-check" checked={daily} onChange={event => setDaily(event.target.checked)} />매일 반복</label> : null}
                        {dateKind ? <label><input type="checkbox" className="stf-check" checked={weekdays} onChange={event => setWeekdays(event.target.checked)} />평일만 (토·일 제외)</label> : null}
                      </div>
                    </div>
                  ) : null}

                  {showAdvSales ? (
                    <label className="stf-field">특정 영업담당 주문만 보내기 (선택)
                      <input type="text" placeholder="예: 이준형 (비우면 모든 영업담당 주문 대상)" value={chainSales} maxLength={20} onChange={event => setChainSales(event.target.value)} />
                    </label>
                  ) : null}

                  {showAdvDaysOff ? (
                    <div className="stf-field">
                      <span>휴무 요일 제외 (고른 요일에는 보내지 않음)</span>
                      <div className="stf-days-grid" role="group" aria-label="제외할 요일 선택">
                        {DAY_OFF_OPTIONS.map(opt => {
                          const on = chainDaysOff.includes(opt.id);
                          return (
                            <button key={opt.id} type="button" className={`stf-day-btn${on ? ' is-active' : ''}`} aria-pressed={on} onClick={() => toggleDayOff(opt.id)}>
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {showAdvCopy ? (
                    <div className="stf-field">
                      <span>내 번호로 확인 사본 받기 (선택)</span>
                      <input type="text" inputMode="tel" placeholder="비우면 사본을 보내지 않습니다 (예: 01012345678)" value={copyTo} maxLength={13} aria-label="사본 받을 번호" onChange={event => setCopyTo(event.target.value.replace(/[^\d-]/g, ''))} />
                      <p className="stf-copy-note">번호를 넣으면 고객에게 발송되는 날마다 하루 1통씩 이 번호로 같은 문자가 함께 발송됩니다.</p>
                    </div>
                  ) : null}

                  {showAdvPlain ? (
                    <div className="stf-field">
                      <label className="stf-inline">
                        <input type="checkbox" className="stf-check" checked={chainPlain} onChange={event => toggleChainPlain(event.target.checked)} />
                        <span>광고 표기 생략 (정보성 안내 문구로 발송)</span>
                      </label>
                      <p className="stf-hint">(광고)와 080 수신거부 없이 순수 안내 문자로만 보낼 때 선택하세요. 단, 할인·이벤트성 내용은 넣으면 안 됩니다.</p>
                    </div>
                  ) : null}

                  {chainAfter ? (
                    <div className="stf-line">
                      <span className="stf-tag">연쇄 발송</span>
                      <span className="stf-chain-badge">앞 템플릿(#{chainAfter})이 오늘 발송된 고객에게만 이어서 발송 (저장 시 유지)</span>
                    </div>
                  ) : null}

                  {showAdvCatchup ? (
                    <div className="stf-field">
                      <label className="stf-inline">
                        <input type="checkbox" className="stf-check" checked={catchupOn} onChange={event => toggleCatchup(event.target.checked)} />
                        <span>이미 출고된 옛 주문에도 한 번 보내기 (일괄 발송)</span>
                      </label>
                      {catchupShown ? (
                        <div className="stf-catchup" aria-label="이미 출고된 주문 1회 발송">
                          <div className="stf-cells">
                            <span>출고일</span>
                            <input type="date" value={catchupFrom} max={getKstToday()} aria-label="출고일 시작일" onChange={event => setCatchupFrom(event.target.value)} />
                            <span>부터 {Number(days) >= 1 ? `출고 ${Number(days)}일이 지난 주문만` : '오늘까지'}, 보낼 시각</span>
                            <input type="datetime-local" value={catchupAt} aria-label="보낼 시각" onChange={event => setCatchupAt(event.target.value)} />
                          </div>
                          <div className="stf-cells">
                            <span>하루 최대</span>
                            <input type="number" min="1" max="1000" step="1" inputMode="numeric" placeholder="제한 없음" value={catchupDaily} aria-label="하루 최대 건수" onChange={event => setCatchupDaily(event.target.value)} />
                            <span>건씩 보냅니다(비우면 제한 없음).</span>
                          </div>
                          {catchupInfo.error ? <p className="ktm-alert" role="alert">{catchupInfo.error}</p> : null}
                          {catchupInfo.data ? (
                            <div className="stf-cu-box" role="status">
                              <p className="stf-cu-head">대상 미리보기{catchupInfo.loading ? ' (갱신 중…)' : ''} · 수신거부·이미 보낸 번호 제외</p>
                              <ul className="stf-cu-list">
                                {catchupInfo.data.ranges.filter(range => range.key !== 'all' || range.from).map(range => (
                                  <li key={range.key}>
                                    <button type="button" className={`ktm-btn stf-cu-pick${range.key === 'selected' ? ' is-active' : ''}`} disabled={!range.from || range.key === 'selected'} onClick={() => setCatchupFrom(range.from)}>{range.key === 'selected' ? '고른 범위' : range.label}</button>
                                    <span>{range.from ? `${range.from} ~ ${catchupInfo.data.end_date || catchupInfo.data.today}` : '-'} · <b>{range.count}건</b> · 예상 비용 {won(range.cost)}</span>
                                  </li>
                                ))}
                              </ul>
                              <p className="stf-cu-foot">현재 잔액 {won(catchupInfo.data.balance)} · {catchupInfo.data.bms ? `브랜드메시지(자유형) 1건 ${won(catchupInfo.data.unit)}${catchupInfo.data.fallback_unit ? `(친구가 아니면 장문문자 ${won(catchupInfo.data.fallback_unit)}으로 대체)` : ''}` : `${ataTemplate ? '알림톡' : '문자'} 1건 ${won(catchupInfo.data.unit)}`} · 5분마다 {catchupInfo.data.per_run}건씩, {catchupSpanText(catchupInfo.data)}</p>
                              {catchupInfo.data.balance_short ? <p className="ktm-alert" role="alert">잔액이 예상 비용보다 적습니다. 충전 후 보내세요(발송은 막지 않습니다).</p> : null}
                              <p className="stf-cu-foot">{bmsOn ? '오전 8시~오후 8시 사이에만 나가며, 그 밖의 시각이면 다음 확인 때 나갑니다.' : !ataTemplate ? '오전 8시~오후 9시 사이에만 나가며, 평소 자동 발송 시각이 지난 뒤 이어서 나갑니다.' : '템플릿이 승인 상태여야 지정 시각에 나갑니다.'} 같은 번호에는 겹쳐 보내지 않습니다.</p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {imageError ? <p className="ktm-alert" role="alert">{imageError}</p> : null}
        {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        <ModalFoot>
          <div className="stf-actions">
            {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>취소</button> : null}
            <button type="submit" form={formId} className="ktm-btn ktm-btn--primary" disabled={busy || mergePending}>
              {busy ? (initial && !startNew ? '저장 중…' : '등록 중…') : (dirtyCount >= 2 ? `${dirtyCount}개 저장` : (initial && !startNew ? '저장' : '등록'))}
            </button>
          </div>
        </ModalFoot>
      </form>

      <aside className={`stf-preview${mobilePreviewOpen ? '' : ' is-mob-collapsed'}`} aria-label="미리보기">
        <div className="stf-cost-card">
          <div className="stf-cost-top">
            <span className="stf-cost-kicker">실시간 예상 비용</span>
            <span className="stf-cost-badge">{costEst.badgeText}</span>
          </div>
          <p className="stf-cost-note">{costEst.note}</p>
        </div>
        <div className="stf-phone">
          <div className="stf-phone-head">
            <span className="stf-phone-sender">{bmsOn || ataTemplate ? '카카오톡 · 한성쇼케이스' : '문자 메시지'}</span>
            {!bmsOn && !ataTemplate && chainFrom ? <span className="stf-phone-num">{formatPhonePreview(chainFrom)}</span> : null}
          </div>
          {outBody || outImages.length || visibleButtons.length || (!ataTemplate && chainSubject.trim()) ? (
            <div className="stf-bubble">
              {!ataTemplate && autoKind && chainSubject.trim() ? <span className="stf-psubj">{chainSubject.trim()}</span> : null}
              {outImages.map((item, index) => <img key={item.url || index} className="stf-pimg" src={item.url} alt="" />)}
              {outBody ? <span className="stf-ptext">{previewBodyText}</span> : null}
              {visibleButtons.length ? (
                <div className="stf-pbtns">
                  {visibleButtons.map((btn, index) => <span key={index} className="stf-pbtn">{btn.name}</span>)}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="stf-pempty">왼쪽에 내용을 입력하면 고객 휴대폰에 보이는 모양이 바로 표시됩니다.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
