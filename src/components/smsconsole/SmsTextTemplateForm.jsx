import { useEffect, useId, useRef, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { IMAGE_MAX_BYTES, shrinkImage, textInfo } from './sendPanelModel.js';
import { getKstToday } from '../../utils/dateUtils.js';
import { BMS_TEMPLATE_ID, isBmsAta, AUTO_DEFAULT_DAYS, AUTO_DEFAULT_INTERVAL, AUTO_DEFAULT_REPEAT, AUTO_KIND, AUTO_KIND_ORDER, AUTO_KIND_DUE, AUTO_KIND_SHIP_PLAN, AUTO_KIND_SHIP_OR_DUE, AUDIENCE_SALES, AUTO_KIND_ORDER_CREATED, AUTO_KIND_PROCESS_STARTED, AUTO_KIND_PROCESS_COMPLETED, AUTO_KIND_MEMBER_JOINED, AUTO_KIND_LEAD_PLUS, AUDIENCE_STAFF, IMAGE_MAX, mergeLayout, autoVariables, bodyVarNames, previewFill, isAdKind, isDateKind, isImmediateKind, moveImageEarlier, withAdFormat, TEXT_NAME_MAX, buildSaveBody, textFormStopText, validateTextForm, autoConditionLine, autoTargetText, normalizeOffset, normalizeDays, normalizeLeadDays, normalizeRepeat, normalizeInterval, dirDaily, SEND_TIMES, sendTimeLabel, hasSendTime, defaultSendTime, bootStages, stageOrder, stageLabel, duplicateStages, stageDirtySig, newStageValues, hasStageRow, LEAD_SOURCES, LEAD_SOURCE_OPTION_LABEL } from './smsTextTemplateFormModel.js';
import { ModalFoot } from './SmsModal.jsx';
import './SmsTextTemplateForm.css';

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

// 폼 상태 → autoConditionLine 이 받는 entry 모양으로 바꿔 결과 한 줄을 만든다(입력이 올바르지 않으면 빈 글).
function conditionResult(f, asTarget = false) {
  const kind = f.autoKind;
  if (!kind) return '';
  const entry = { autoKind: kind };
  if (f.ataTemplate) entry.autoAtaTemplate = f.ataTemplate;
  if (isImmediateKind(kind)) {
    Object.assign(entry, { autoStep: kind === AUTO_KIND_ORDER_CREATED ? '' : f.step, autoAudience: f.audience === AUDIENCE_STAFF ? AUDIENCE_STAFF : 'customer', autoStaffCount: f.staff.length });
  } else if (isDateKind(kind)) {
    const offset = normalizeOffset(f.offsetDir, f.offsetDays, f.daily);
    if (offset === null) return '';
    Object.assign(entry, { autoOffset: offset, autoDaily: dirDaily(f.offsetDir, f.daily), autoWeekdays: f.weekdays, autoAudience: f.audience, autoStaffCount: f.staff.length, autoUnlessStep: f.unlessStep, autoUnlessMode: f.unlessMode });
  } else if (kind === AUTO_KIND_LEAD_PLUS) {
    const leadDays = normalizeLeadDays(f.days);
    if (leadDays === null) return '';
    Object.assign(entry, { autoDays: leadDays, autoLeadSource: f.leadSource || '' });
  } else if (kind !== AUTO_KIND_MEMBER_JOINED) {
    const dayCount = normalizeDays(f.days);
    if (dayCount === null) return '';
    Object.assign(entry, { autoDays: dayCount, autoSendFrom: f.sendFrom, autoRepeat: normalizeRepeat(f.repeat) ?? AUTO_DEFAULT_REPEAT, autoInterval: normalizeInterval(f.interval) ?? AUTO_DEFAULT_INTERVAL });
  }
  const full = { ...entry, autoSendTime: hasSendTime(kind, f.days) ? f.sendTime : '' };
  return asTarget ? autoTargetText(full) : autoConditionLine(full);
}

// 문자 템플릿 등록: 이름·내용·사진 1장. 검수가 없어 등록하면 바로 쓸 수 있다.
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
  const [bmsButtons, setBmsButtons] = useState(v0.bmsButtons || []); // 브랜드메시지(자유형) 버튼 [{name, link}]
  const [leadSource, setLeadSource] = useState(v0.leadSource || ''); // 가입·문의 후 대상: '' 모두 · cafe24 회원가입 · airtable 견적 문의
  const [sendTime, setSendTime] = useState(v0.sendTime); // '' = 안 골랐음(칸에는 기본값이 보이고 저장 때는 빈 값)
  const [copyTo, setCopyTo] = useState(v0.copyTo || ''); // 사본 받을 번호(자동 발송이 고객에게 나간 날 같은 문자를 하루 1통)
  const [catchupOn, setCatchupOn] = useState(v0.catchupOn); // 이미 출고된 주문에도 한 번 보내기(기본 꺼짐)
  const [catchupFrom, setCatchupFrom] = useState(v0.catchupFrom); // 출고일 시작일(오늘까지)
  const [catchupDaily, setCatchupDaily] = useState(v0.catchupDaily || ''); // 문구별 하루 최대 건수(비우면 전역 상한)
  const [catchupAt, setCatchupAt] = useState(v0.catchupAt); // 보낼 시각 'YYYY-MM-DDTHH:MM'(KST)
  const [catchupInfo, setCatchupInfo] = useState({ loading: false, error: '', data: null });
  const [meta, setMeta] = useState({ steps: [], staff: [], ata: [] });
  const [imageError, setImageError] = useState('');
  const [adMark, setAdMark] = useState(true);
  const [merge, setMerge] = useState(true); // 2026-11-16 사장님 "이미지 2개를 등록하면 자동으로 합쳐서 보내도록, 비용도 아껴야": 사진 2장 이상은 등록·수정 모두 기본으로 한 장에 합친다(체크를 풀면 따로)
  const [merged, setMerged] = useState(null);
  const [mergeFailed, setMergeFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
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
  const adOn = isAdKind(autoKind, ataTemplate) && adMark;
  const outBody = adOn ? withAdFormat(body) : body;
  const check = validateTextForm({ name, body: outBody, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily, audience, staff, step, ataTemplate, catchupOn, catchupFrom, catchupAt, catchupDaily, copyTo, imageCount: merge && images.length >= 2 ? 1 : images.length, bmsButtons });
  useEffect(() => { setError(pendingError.current); pendingError.current = ''; }, [name, body, images, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, unlessStep, unlessMode, daily, weekdays, step, audience, staff, ataTemplate, bmsButtons, adMark, sendTime, copyTo, catchupOn, catchupFrom, catchupAt, catchupDaily, leadSource]);
  // 이미 출고된 주문 1회 발송 미리보기(읽기만): 켜져 있고 출고 완료 후 + 알림톡일 때 출고일 범위가 바뀌면 건수·비용·잔액을 다시 읽는다
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
    if (on && !catchupAt) { const next = new Date(Date.parse(`${getKstToday()}T00:00:00Z`) + 86400000).toISOString().slice(0, 10); setCatchupAt(`${next}T09:00`); } // 기본 보낼 시각: 내일 오전 9시
  };
  const pickAta = value => { setAtaTemplate(value); if (value) { setAudience('customer'); setStaff([]); } else setCatchupOn(false); if (value === BMS_TEMPLATE_ID && !bmsButtons.length) setBmsButtons([{ name: '', link: '' }]); };
  const bmsOn = isBmsAta(ataTemplate);
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
  const conditionForm = { leadSource, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, unlessStep, unlessMode, daily, weekdays, step, audience, staff, ataTemplate, sendTime };
  const conditionText = conditionResult(conditionForm);
  const targetText = conditionResult(conditionForm, true);
  const won = value => (value === null || value === undefined ? '확인 못 함' : `${Number(value).toLocaleString('ko-KR')}원`);
  const showTime = hasSendTime(autoKind, days);

  // ---- 단계(같은 흐름의 문구 여러 개) ----
  const collect = () => ({ leadSource, name, body, images, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, unlessStep, unlessMode, daily, weekdays, step, audience, staff, ataTemplate, bmsButtons, sendTime, copyTo, catchupOn, catchupFrom, catchupAt, catchupDaily });
  const applyValues = v => {
    setName(v.name); setBody(v.body); setImages(v.images); setAutoKind(v.autoKind); setDays(v.days); setSendFrom(v.sendFrom); setRepeat(v.repeat); setInterval(v.interval);
    setOffsetDir(v.offsetDir); setOffsetDays(v.offsetDays); setUnlessStep(v.unlessStep); setUnlessMode(v.unlessMode); setDaily(v.daily); setWeekdays(v.weekdays);
    setStep(v.step); setAudience(v.audience); setStaff(v.staff); setAtaTemplate(v.ataTemplate); setBmsButtons(v.bmsButtons || []); setSendTime(v.sendTime); setCopyTo(v.copyTo || ''); setCatchupOn(v.catchupOn); setCatchupFrom(v.catchupFrom); setCatchupAt(v.catchupAt); setCatchupDaily(v.catchupDaily || ''); setLeadSource(v.leadSource || ''); setImageError('');
  };
  const forms = stages.map(item => (item.key === activeKey ? collect() : item.form));
  const dupSet = duplicateStages(forms);
  const dirtyOf = (item, f) => item.base === null || stageDirtySig(f) !== item.base || (merge && f.images.length >= 2); // 따로 저장된 사진 2장 이상은 합쳐서 다시 저장해야 하므로 바뀐 단계로 본다
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
    const pick = multi ? list.filter(({ item, f }) => dirtyOf(item, f)) : list; // 안 바뀐 단계는 보내지 않는다(한 단계뿐이면 종전대로 저장)
    setStages(prev => prev.map(item => (item.failed ? { ...item, failed: false } : item)));
    const clash = pick.find(({ i }) => dupSet.has(i));
    if (multi && clash) { failAt(clash.i, textFormStopText('dup')); return; }
    const outOf = f => (isAdKind(f.autoKind, f.ataTemplate) && adMark ? withAdFormat(f.body) : f.body);
    for (const { f, i } of pick) {
      const chk = validateTextForm({ name: f.name, body: outOf(f), autoKind: f.autoKind, days: f.days, sendFrom: f.sendFrom, repeat: f.repeat, interval: f.interval, offsetDir: f.offsetDir, offsetDays: f.offsetDays, daily: f.daily, audience: f.audience, staff: f.staff, step: f.step, ataTemplate: f.ataTemplate, catchupOn: f.catchupOn, catchupFrom: f.catchupFrom, catchupAt: f.catchupAt, catchupDaily: f.catchupDaily, copyTo: f.copyTo, imageCount: merge && f.images.length >= 2 ? 1 : f.images.length, bmsButtons: f.bmsButtons });
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
        const out = await postSmsConsole('text_template_save', buildSaveBody({ id: item.id, name: f.name, body: outOf(f), images: imgs, auto: { leadSource: f.leadSource, kind: f.autoKind, days: f.days, sendFrom: f.sendFrom, repeat: f.repeat, interval: f.interval, offsetDir: f.offsetDir, offsetDays: f.offsetDays, daily: f.daily, unlessStep: f.unlessStep, unlessMode: f.unlessMode, weekdays: f.weekdays, step: f.step, audience: f.audience, staff: f.staff, ataTemplate: f.ataTemplate, bmsButtons: f.bmsButtons, sendTime: f.sendTime, copyTo: f.copyTo, catchupOn: f.catchupOn, catchupFrom: f.catchupFrom, catchupAt: f.catchupAt, catchupDaily: f.catchupDaily } }));
        last = out.item;
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
        <div className="stf-actions">
          {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>목록</button> : null}
          {autoKind ? null : <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => onSend(saved.id)}>이 문구로 보내기</button>}
        </div>
      </div>
    );
  }
  return (
    <div className="stf-split">
    <form id={formId} className={`stf-form${showStages ? ' has-stages' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
      {showStages ? (
        <div className="stf-stages" role="group" aria-label="단계">
          {chips.map(chip => (
            <button key={chip.key} type="button" className={`ktm-btn stf-chip${chip.key === activeKey ? ' is-active' : ''}${chip.dirty ? ' is-dirty' : ''}${chip.dup ? ' is-dup' : ''}${chip.failed ? ' is-failed' : ''}`} aria-pressed={chip.key === activeKey} onClick={() => switchTo(chip.key)}>{chip.label}{chip.dirty ? <i className="stf-dot" aria-hidden="true" /> : null}</button>
          ))}
          {immKind || autoKind === AUTO_KIND_MEMBER_JOINED ? null : <button type="button" className="ktm-btn stf-stage-add" onClick={() => addStage(false)}>+ 단계</button>}
          {immKind || autoKind === AUTO_KIND_MEMBER_JOINED ? null : <button type="button" className="ktm-btn stf-stage-clone" onClick={() => addStage(true)}>복제</button>}
        </div>
      ) : null}
      <label className="stf-field">템플릿 이름
        <input type="text" placeholder="목록에서 찾을 이름 (고객에게는 안 보임)" value={name} maxLength={TEXT_NAME_MAX} autoComplete="off" onChange={event => setName(event.target.value)} />
      </label>
      <label className="stf-field">내용
        <textarea ref={bodyRef} rows={autoKind ? 4 : 6}value={body} onChange={event => setBody(event.target.value)} />
      </label>
      <div className="stf-meta">
        <span className="stf-vars">{autoVariables(autoKind, audience, ataTemplate).map(item => <button key={item} type="button" className="ktm-btn stf-var" onClick={() => insertVar(item)}>{item}</button>)}</span>
        <span className="stf-count">{info.bytes} 바이트{info.type ? ` · ${info.type}` : ''}{info.tooLong ? ' · 너무 깁니다' : ''}{bodyVarNames(outBody).length ? ` · 변수 채우면 약 ${textInfo(previewFill(outBody)).bytes}바이트${textInfo(previewFill(outBody)).type ? `(${textInfo(previewFill(outBody)).type})` : ''}` : ''}</span>
      </div>
      <div className="stf-row">
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <button type="button" className="ktm-btn" disabled={images.length >= IMAGE_MAX} onClick={() => fileRef.current?.click()}>사진</button>
        {images.length >= 2 ? <label><input type="checkbox" className="stf-check" checked={merge} onChange={event => setMerge(event.target.checked)} />한 장으로 합치기</label> : null}
        {images.map((item, index) => (
          <span key={item.url || index} className="stf-photo">
            <img className="stf-thumb" src={item.url} alt="" />
            {index > 0 ? <button type="button" className="ktm-btn" onClick={() => setImages(prev => moveImageEarlier(prev, index))}>앞으로</button> : null}
            <button type="button" className="ktm-btn" onClick={() => removeImage(index)}>빼기</button>
          </span>
        ))}
      </div>
      <div className="stf-conds">
        <div className="stf-line">
          <span className="stf-tag">언제</span>
          <span className="stf-cells">
            <select value={autoKind} aria-label="자동 발송" onChange={event => setAutoKind(event.target.value)}>
              <option value="">자동 발송 없음</option>
              <option value={AUTO_KIND_MEMBER_JOINED}>자사몰 회원가입 시</option>
              <option value={AUTO_KIND_LEAD_PLUS}>가입·문의 후</option>
              <option value={AUTO_KIND_ORDER_CREATED}>주문 등록 시</option>
              <option value={AUTO_KIND_ORDER}>주문 등록 후</option>
              <option value={AUTO_KIND_PROCESS_STARTED}>공정 시작 시</option>
              <option value={AUTO_KIND_PROCESS_COMPLETED}>공정 완료 시</option>
              <option value={AUTO_KIND}>출고 완료 후</option>
              <option value={AUTO_KIND_DUE}>납기일 기준</option>
              <option value={AUTO_KIND_SHIP_PLAN}>출고예정일 기준</option>
              <option value={AUTO_KIND_SHIP_OR_DUE}>출고·납기일 기준</option>
            </select>
            {dayKind || leadKind ? <input type="text" inputMode="numeric" className="stf-days" value={days} maxLength={3} aria-label="일수" onChange={event => setDays(event.target.value)} /> : null}
            {dayKind || leadKind ? <span>일 뒤</span> : null}
            {leadKind ? (
              <select value={leadSource} aria-label="대상" onChange={event => setLeadSource(event.target.value)}>
                {LEAD_SOURCES.map(source => <option key={source} value={source}>{LEAD_SOURCE_OPTION_LABEL[source]}</option>)}
              </select>
            ) : null}
            {dateKind && offsetDir !== 'same' ? <input type="text" inputMode="numeric" className="stf-days" value={offsetDays} maxLength={3} aria-label="일수" onChange={event => setOffsetDays(event.target.value)} /> : null}
            {dateKind ? (
              <select value={offsetDir} aria-label="기준 방향" onChange={event => setOffsetDir(event.target.value)}>
                <option value="before">일 전</option>
                <option value="same">당일</option>
                <option value="after">일 지남</option>
              </select>
            ) : null}
            {showTime ? (
              <select className="stf-time" value={sendTime || defaultSendTime(autoKind)} aria-label="발송 시각" onChange={event => setSendTime(event.target.value)}>
                {SEND_TIMES.map(time => <option key={time} value={time}>{sendTimeLabel(time)}</option>)}
              </select>
            ) : null}
          </span>
        </div>
        {dateKind || immKind ? (
          <div className="stf-line">
            <span className="stf-tag">받는 사람</span>
            <span className="stf-cells">
              <select value={audience} aria-label="받는 사람" onChange={event => setAudience(event.target.value)}>
                <option value="customer">고객</option>
                {ataTemplate ? null : <option value={AUDIENCE_STAFF}>직원</option>}
                {dateKind && !ataTemplate ? <option value={AUDIENCE_SALES}>영업담당</option> : null}
              </select>
              {audience === AUDIENCE_STAFF ? meta.staff.map(person => (
                <button key={person.id} type="button" className={`ktm-btn stf-staff${staff.includes(person.id) ? ' is-active' : ''}`} aria-pressed={staff.includes(person.id)} onClick={() => toggleStaff(person.id)}>{person.name}</button>
              )) : null}
            </span>
          </div>
        ) : null}
        {dateKind || (immKind && autoKind !== AUTO_KIND_ORDER_CREATED) ? (
          <div className="stf-line">
            <span className="stf-tag">공정</span>
            <span className="stf-cells">
              {dateKind ? (
                <select value={unlessStep} aria-label="미완료 공정" onChange={event => setUnlessStep(event.target.value)}>
                  <option value="">공정 조건 없음</option>
                  {unlessStep && !meta.steps.includes(unlessStep) ? <option value={unlessStep}>{unlessStep}</option> : null}
                  {meta.steps.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              ) : (
                <select value={step} aria-label="공정" onChange={event => setStep(event.target.value)}>
                  <option value="">공정 선택</option>
                  {step && !meta.steps.includes(step) ? <option value={step}>{step}</option> : null}
                  {meta.steps.map(item => <option key={item} value={item}>{item}</option>)}
                </select>
              )}
              {dateKind && unlessStep ? (
                <select value={unlessMode} aria-label="공정 조건" onChange={event => setUnlessMode(event.target.value)}>
                  <option value="completed">미완료</option>
                  <option value="started">미착수</option>
                </select>
              ) : null}
            </span>
          </div>
        ) : null}
        {(dayKind && !ataTemplate) || dateKind ? (
          <div className="stf-line">
            <span className="stf-tag">반복</span>
            <span className="stf-cells">
              {dayKind ? <input type="date" className="stf-from" value={sendFrom} aria-label="시작일" onChange={event => setSendFrom(event.target.value)} /> : null}
              {dayKind ? <span>부터</span> : null}
              {dayKind ? <input type="text" inputMode="numeric" className="stf-days" value={repeat} maxLength={2} aria-label="횟수" onChange={event => setRepeat(event.target.value)} /> : null}
              {dayKind ? <span>번</span> : null}
              {dayKind && Number(repeat) >= 2 ? <input type="text" inputMode="numeric" className="stf-days" value={interval} maxLength={3} aria-label="간격" onChange={event => setInterval(event.target.value)} /> : null}
              {dayKind && Number(repeat) >= 2 ? <span>일 간격</span> : null}
              {dayKind && !ataTemplate ? <span>사본</span> : null}
              {dayKind && !ataTemplate ? <input type="text" inputMode="tel" className="stf-days" style={{ width: '8.5em' }} value={copyTo} maxLength={13} placeholder="내 번호" aria-label="사본 받을 번호" onChange={event => setCopyTo(event.target.value.replace(/[^\d-]/g, ''))} /> : null}
              {dateKind ? <label><input type="checkbox" className="stf-check" checked={daily} onChange={event => setDaily(event.target.checked)} />매일</label> : null}
              {dateKind ? <label><input type="checkbox" className="stf-check" checked={weekdays} onChange={event => setWeekdays(event.target.checked)} />평일만</label> : null}
            </span>
          </div>
        ) : null}
        {autoKind ? (
          <div className="stf-line">
            <span className="stf-tag">수단</span>
            <span className="stf-cells">
              {autoKind ? (
                <select value={ataTemplate} aria-label="발송 수단" onChange={event => pickAta(event.target.value)}>
                  <option value="">문자로</option>
                  <option value={BMS_TEMPLATE_ID}>브랜드메시지(자유형)</option>
                  {ataTemplate && ataTemplate !== BMS_TEMPLATE_ID && !meta.ata.some(item => item.id === ataTemplate) ? <option value={ataTemplate}>{`목록에 없는 알림톡 (…${ataTemplate.slice(-4)})`}</option> : null}
                  {meta.ata.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              ) : null}
              {isAdKind(autoKind, ataTemplate) ? <label><input type="checkbox" className="stf-check" checked={adMark} onChange={event => setAdMark(event.target.checked)} />광고 표기</label> : null}
            </span>
          </div>
        ) : null}
        {autoKind && bmsOn ? (
          <div className="stf-line" aria-label="브랜드메시지 버튼">
            <span className="stf-tag">버튼</span>
            <span className="stf-cells">
              {bmsButtons.map((button, index) => (
                <span key={index} className="stf-cells">
                  <input type="text" value={button.name} maxLength={14} placeholder="버튼 이름(14자까지)" aria-label={`버튼 ${index + 1} 이름`} onChange={event => setBmsButton(index, { name: event.target.value })} />
                  <input type="text" inputMode="url" value={button.link} maxLength={1000} placeholder="https:// 링크" aria-label={`버튼 ${index + 1} 링크`} onChange={event => setBmsButton(index, { link: event.target.value })} />
                  <button type="button" className="ktm-btn" aria-label={`버튼 ${index + 1} 지우기`} onClick={() => setBmsButtons(prev => prev.filter((_, i) => i !== index))}>지우기</button>
                </span>
              ))}
              {bmsButtons.length < 5 ? <button type="button" className="ktm-btn" onClick={() => setBmsButtons(prev => [...prev, { name: '', link: '' }])}>버튼 더하기</button> : null}
              <span className="stf-hint">사진 1장과 함께면 400자, 글만이면 1300자까지(고객명은 20자로 계산). 지금 {[...String(body).replace(/#\{고객명\}/g, '가'.repeat(20))].length}자. 채널 친구가 아니면 장문문자로 대체돼 나갑니다. 오전 8시~오후 8시 사이에만 보냅니다.</span>
              {images[0]?.url ? <img className="ktm-open-img sac-thumb" src={images[0].url} alt="브랜드메시지 이미지 미리보기" /> : null}
            </span>
          </div>
        ) : null}
        {pausedText ? <p className="ktm-alert" role="alert">{pausedText}</p> : null}
        {autoKind === AUTO_KIND ? (
          <div className="stf-line">
            <span className="stf-tag">1회 발송</span>
            <span className="stf-cells">
              <label><input type="checkbox" className="stf-check" checked={catchupOn} onChange={event => toggleCatchup(event.target.checked)} />이미 출고된 주문에도 한 번 보내기</label>
            </span>
          </div>
        ) : null}
        {catchupShown ? (
          <div className="stf-catchup" aria-label="이미 출고된 주문 1회 발송">
            <div className="stf-cells">
              <span>출고일</span>
              <input type="date" className="stf-from" value={catchupFrom} max={getKstToday()} aria-label="출고일 시작일" onChange={event => setCatchupFrom(event.target.value)} />
              <span>부터 {Number(days) >= 1 ? `출고 ${Number(days)}일이 지난 주문만(오늘 −${Number(days)}일까지)` : '오늘까지'}, 보낼 시각</span>
              <input type="datetime-local" className="stf-from" value={catchupAt} aria-label="보낼 시각" onChange={event => setCatchupAt(event.target.value)} />
            </div>
            <div className="stf-cells">
              <span>하루 최대</span>
              <input type="number" className="stf-from" min="1" max="1000" step="1" inputMode="numeric" placeholder="제한 없음" value={catchupDaily} aria-label="하루 최대 건수" onChange={event => setCatchupDaily(event.target.value)} />
              <span>건씩 보냅니다(비우면 제한 없음). 넘는 분은 다음 날 같은 시각 이후에 이어서 나갑니다.</span>
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
                <p className="stf-cu-foot">현재 잔액 {won(catchupInfo.data.balance)} · {catchupInfo.data.bms ? `브랜드메시지(자유형) 1건 ${won(catchupInfo.data.unit)}${catchupInfo.data.fallback_unit ? `(친구가 아니면 장문문자 ${won(catchupInfo.data.fallback_unit)}으로 대체)` : ''}` : `${ataTemplate ? '알림톡' : '문자'} 1건 ${won(catchupInfo.data.unit)}`} · 일괄 발송은 5분마다 {catchupInfo.data.per_run}건씩, 시작 후 약 {catchupInfo.data.eta_minutes}분 안에 모두 나갑니다({String(catchupDaily).trim() ? `하루 ${catchupInfo.data.daily_max}건씩${catchupInfo.data.days_needed > 1 ? `, 약 ${catchupInfo.data.days_needed}일` : ''}` : `하루 ${catchupInfo.data.daily_max}건까지${catchupInfo.data.days_needed > 1 ? `, 넘으면 다음 날 이어서 약 ${catchupInfo.data.days_needed}일` : ''}`}, 안내 문자 상한과 따로 셉니다)</p>
                {catchupInfo.data.balance_short ? <p className="ktm-alert" role="alert">잔액이 예상 비용보다 적습니다. 충전 후 보내세요(발송은 막지 않습니다).</p> : null}
                <p className="stf-cu-foot">{bmsOn ? '오전 8시~오후 8시 사이에만 나가며, 그 밖의 시각이면 다음 확인 때 나갑니다.' : !ataTemplate ? '오전 8시~오후 9시 사이에만 나가며, 평소 자동 발송 시각이 지난 뒤 이어서 나갑니다.' : '템플릿이 승인 상태여야 지정 시각에 나가며, 승인 전이면 승인 후 자동 발송을 켠 뒤 다음 확인 때 나갑니다.'} 출고 후 설정한 일수가 지난 주문만 보내고, 그 뒤 출고분은 평소 자동 발송이 그 일수째에 보냅니다. 같은 번호에는 겹쳐 보내지 않습니다.</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {conditionText ? <p className="stf-result" aria-label="발송 조건">{conditionText}</p> : null}
        {targetText ? <p className="stf-result" aria-label="발송 대상">대상: {targetText}</p> : null}
      </div>
      {imageError ? <p className="ktm-alert" role="alert">{imageError}</p> : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <ModalFoot>
        <div className="stf-actions">
          {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>취소</button> : null}
          <button type="submit" form={formId} className="ktm-btn ktm-btn--primary" disabled={busy || mergePending}>{busy ? (initial && !startNew ? '저장 중…' : '등록 중…') : (dirtyCount >= 2 ? `${dirtyCount}개 저장` : (initial && !startNew ? '저장' : '등록'))}</button>
        </div>
      </ModalFoot>
    </form>
    <aside className="stf-preview" aria-label="미리보기">
      <div className="stf-phone">
        {outBody || outImages.length ? <div className="stf-bubble">
          {outImages.map((item, index) => <img key={item.url || index} className="stf-pimg" src={item.url} alt="" />)}
          <span className="stf-ptext">{previewFill(outBody)}</span>
        </div> : null}
      </div>
    </aside>
    </div>
  );
}
