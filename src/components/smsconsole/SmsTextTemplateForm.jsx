import { useEffect, useId, useRef, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { shrinkImage } from './sendPanelModel.js';
import { AUTO_DEFAULT_DAYS, AUTO_DEFAULT_INTERVAL, AUTO_DEFAULT_REPEAT, AUTO_KIND, AUTO_KIND_ORDER, AUTO_KIND_DUE, AUTO_KIND_SHIP_PLAN, AUTO_KIND_SHIP_OR_DUE, AUDIENCE_SALES, AUTO_KIND_ORDER_CREATED, AUTO_KIND_PROCESS_STARTED, AUTO_KIND_PROCESS_COMPLETED, AUTO_KIND_MEMBER_JOINED, AUTO_KIND_LEAD_PLUS, AUDIENCE_STAFF, IMAGE_MAX, autoVariables, isDateKind, isImmediateKind, TEXT_NAME_MAX, buildSaveBody, textFormStopText, validateTextForm } from './smsTextTemplateFormModel.js';
import { ModalFoot } from './SmsModal.jsx';
import './SmsTextTemplateForm.css';

// 문자 템플릿 등록: 이름·내용·사진 1장. 검수가 없어 등록하면 바로 쓸 수 있다.
export default function SmsTextTemplateForm({ onSend, onCancel, onSaved, initial }) {
  const [name, setName] = useState(initial?.name || '');
  const [body, setBody] = useState(initial?.body || '');
  const [images, setImages] = useState(initial?.images || []); // 최대 3장
  const [autoKind, setAutoKind] = useState(initial?.autoKind || '');
  const [days, setDays] = useState(initial?.days || String(AUTO_DEFAULT_DAYS));
  const [sendFrom, setSendFrom] = useState(initial?.sendFrom || '');
  const [repeat, setRepeat] = useState(initial?.repeat || String(AUTO_DEFAULT_REPEAT));
  const [interval, setInterval] = useState(initial?.interval || String(AUTO_DEFAULT_INTERVAL));
  const [offsetDir, setOffsetDir] = useState(initial?.offsetDir || 'before');
  const [offsetDays, setOffsetDays] = useState(initial?.offsetDays || '3');
  const [unlessStep, setUnlessStep] = useState(initial?.unlessStep || '');
  const [unlessMode, setUnlessMode] = useState(initial?.unlessMode || 'completed');
  const [daily, setDaily] = useState(Boolean(initial?.daily));
  const [weekdays, setWeekdays] = useState(Boolean(initial?.weekdays));
  const [step, setStep] = useState(initial?.step || '');
  const [audience, setAudience] = useState(initial?.audience || 'customer');
  const [staff, setStaff] = useState(initial?.staff || []);
  const [ataTemplate, setAtaTemplate] = useState(initial?.ataTemplate || '');
  const [meta, setMeta] = useState({ steps: [], staff: [], ata: [] });
  const [imageError, setImageError] = useState('');
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
  const check = validateTextForm({ name, body, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily, audience, staff, step });
  const insertVar = varName => {
    const el = bodyRef.current;
    const at = el ? [el.selectionStart, el.selectionEnd] : [body.length, body.length];
    const text = `#{${varName}}`;
    setBody(prev => `${prev.slice(0, at[0])}${text}${prev.slice(at[1])}`);
    setTimeout(() => { if (el) { el.focus(); el.setSelectionRange(at[0] + text.length, at[0] + text.length); } }, 0);
  };
  const toggleStaff = id => setStaff(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const { info } = check;

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
    if (busy) return;
    if (!check.ok) { setError(textFormStopText(check.reason)); return; }
    setBusy(true);
    setError('');
    try {
      const out = await postSmsConsole('text_template_save', buildSaveBody({ id: initial?.id, name, body, images, auto: { kind: autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily, unlessStep, unlessMode, weekdays, step, audience, staff, ataTemplate } }));
      setSaved(out.item);
      onSaved?.(out.item);
    } catch (err) { setError(textFormStopText(err?.data?.reason) || err.message || '등록하지 못했습니다.'); } finally { setBusy(false); }
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
    <form id={formId} className="stf-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
      <label className="stf-field">이름
        <input type="text" value={name} maxLength={TEXT_NAME_MAX} autoComplete="off" onChange={event => setName(event.target.value)} />
      </label>
      <label className="stf-field">내용
        <textarea ref={bodyRef} rows={6} value={body} onChange={event => setBody(event.target.value)} />
      </label>
      <div className="stf-meta">
        <span className="stf-vars">{autoVariables(autoKind, audience).map(item => <button key={item} type="button" className="ktm-btn stf-var" onClick={() => insertVar(item)}>{item}</button>)}</span>
        <span className="stf-count">{info.bytes} 바이트{info.type ? ` · ${info.type}` : ''}{info.tooLong ? ' · 너무 깁니다' : ''}</span>
      </div>
      <div className="stf-row">
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickImage} />
        <button type="button" className="ktm-btn" disabled={images.length >= IMAGE_MAX} onClick={() => fileRef.current?.click()}>사진</button>
        {images.map((item, index) => (
          <span key={item.url || index} className="stf-photo">
            <img className="stf-thumb" src={item.url} alt="" />
            <button type="button" className="ktm-btn" onClick={() => removeImage(index)}>빼기</button>
          </span>
        ))}
        <span className="stf-auto">
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
            <select value={ataTemplate} aria-label="알림톡" onChange={event => setAtaTemplate(event.target.value)}>
              <option value="">문자로</option>
              {ataTemplate && !meta.ata.some(item => item.id === ataTemplate) ? <option value={ataTemplate}>{ataTemplate}</option> : null}
              {meta.ata.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          ) : null}
          {dayKind ? <input type="date" className="stf-from" value={sendFrom} aria-label="시작일" onChange={event => setSendFrom(event.target.value)} /> : null}
          {dayKind ? <input type="text" inputMode="numeric" className="stf-days" value={repeat} maxLength={2} aria-label="횟수" onChange={event => setRepeat(event.target.value)} /> : null}
          {dayKind ? <span>번</span> : null}
          {dayKind && Number(repeat) >= 2 ? <input type="text" inputMode="numeric" className="stf-days" value={interval} maxLength={3} aria-label="간격" onChange={event => setInterval(event.target.value)} /> : null}
          {dayKind && Number(repeat) >= 2 ? <span>일 간격</span> : null}
          {dateKind && offsetDir !== 'same' ? <input type="text" inputMode="numeric" className="stf-days" value={offsetDays} maxLength={3} aria-label="일수" onChange={event => setOffsetDays(event.target.value)} /> : null}
          {dateKind ? (
            <select value={offsetDir} aria-label="기준 방향" onChange={event => setOffsetDir(event.target.value)}>
              <option value="before">일 전</option>
              <option value="same">당일</option>
              <option value="after">일 지남</option>
            </select>
          ) : null}
          {dateKind ? (
            <select value={unlessStep} aria-label="미완료 공정" onChange={event => setUnlessStep(event.target.value)}>
              <option value="">공정 조건 없음</option>
              {unlessStep && !meta.steps.includes(unlessStep) ? <option value={unlessStep}>{unlessStep}</option> : null}
              {meta.steps.map(step => <option key={step} value={step}>{step}</option>)}
            </select>
          ) : null}
          {dateKind && unlessStep ? (
            <select value={unlessMode} aria-label="공정 조건" onChange={event => setUnlessMode(event.target.value)}>
              <option value="completed">미완료</option>
              <option value="started">미착수</option>
            </select>
          ) : null}
          {dateKind ? <label><input type="checkbox" className="stf-check" checked={daily} onChange={event => setDaily(event.target.checked)} />매일</label> : null}
          {dateKind ? <label><input type="checkbox" className="stf-check" checked={weekdays} onChange={event => setWeekdays(event.target.checked)} />평일만</label> : null}
          {immKind && autoKind !== AUTO_KIND_ORDER_CREATED ? (
            <select value={step} aria-label="공정" onChange={event => setStep(event.target.value)}>
              <option value="">공정 선택</option>
              {step && !meta.steps.includes(step) ? <option value={step}>{step}</option> : null}
              {meta.steps.map(item => <option key={item} value={item}>{item}</option>)}
            </select>
          ) : null}
          {dateKind || immKind ? (
            <select value={audience} aria-label="받는 사람" onChange={event => setAudience(event.target.value)}>
              <option value="customer">고객</option>
              <option value={AUDIENCE_STAFF}>직원</option>
              {dateKind ? <option value={AUDIENCE_SALES}>영업담당</option> : null}
            </select>
          ) : null}
          {(dateKind || immKind) && audience === AUDIENCE_STAFF ? meta.staff.map(person => (
            <button key={person.id} type="button" className={`ktm-btn stf-staff${staff.includes(person.id) ? ' is-active' : ''}`} aria-pressed={staff.includes(person.id)} onClick={() => toggleStaff(person.id)}>{person.name}</button>
          )) : null}
        </span>
      </div>
      {imageError ? <p className="ktm-alert" role="alert">{imageError}</p> : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <ModalFoot>
        <div className="stf-actions">
          {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>취소</button> : null}
          <button type="submit" form={formId} className="ktm-btn ktm-btn--primary" disabled={busy}>{busy ? (initial ? '저장 중…' : '등록 중…') : (initial ? '저장' : '등록')}</button>
        </div>
      </ModalFoot>
    </form>
    <aside className="stf-preview" aria-label="미리보기">
      <div className="stf-phone">
        {body || images.length ? <div className="stf-bubble">
          {images.map((item, index) => <img key={item.url || index} className="stf-pimg" src={item.url} alt="" />)}
          <span className="stf-ptext">{body}</span>
        </div> : null}
      </div>
    </aside>
    </div>
  );
}
