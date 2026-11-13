import { useRef, useState } from 'react';
import { postSmsConsole } from '../../api/smsConsole.js';
import { shrinkImage } from './sendPanelModel.js';
import { AUTO_DEFAULT_DAYS, AUTO_DEFAULT_INTERVAL, AUTO_DEFAULT_REPEAT, AUTO_KIND, AUTO_KIND_ORDER, IMAGE_MAX, KIND_KAKAO, KIND_SMS, TEXT_NAME_MAX, buildSaveBody, textFormStopText, validateTextForm } from './smsTextTemplateFormModel.js';
import './SmsTextTemplateForm.css';

// 새 템플릿 등록 맨 위의 종류 고르기(문자 / 알림톡)
export function TemplateKindChooser({ kind, onPick }) {
  return (
    <div className="stf-kinds" role="group" aria-label="템플릿 종류">
      <button type="button" className={`stf-kind${kind === KIND_SMS ? ' is-active' : ''}`} aria-pressed={kind === KIND_SMS} onClick={() => onPick(KIND_SMS)}>문자 템플릿</button>
      <button type="button" className={`stf-kind${kind === KIND_KAKAO ? ' is-active' : ''}`} aria-pressed={kind === KIND_KAKAO} onClick={() => onPick(KIND_KAKAO)}>알림톡 템플릿</button>
    </div>
  );
}

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
  const [imageError, setImageError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const fileRef = useRef(null);
  const check = validateTextForm({ name, body, autoKind, days, sendFrom, repeat, interval });
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
      const out = await postSmsConsole('text_template_save', buildSaveBody({ id: initial?.id, name, body, images, auto: { kind: autoKind, days, sendFrom, repeat, interval } }));
      setSaved(out.item);
      onSaved?.(out.item);
    } catch (err) { setError(err.message || '등록하지 못했습니다.'); } finally { setBusy(false); }
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
    <form className="stf-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
      <label className="stf-field">이름
        <input type="text" value={name} maxLength={TEXT_NAME_MAX} autoComplete="off" onChange={event => setName(event.target.value)} />
      </label>
      <label className="stf-field">내용
        <textarea rows={6} value={body} onChange={event => setBody(event.target.value)} />
        <span className="stf-count">{info.bytes} 바이트{info.type ? ` · ${info.type}` : ''}{info.tooLong ? ' · 너무 깁니다' : ''}</span>
      </label>
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
            <option value={AUTO_KIND}>출고 완료 후</option>
            <option value={AUTO_KIND_ORDER}>주문 등록 후</option>
          </select>
          {autoKind ? <input type="text" inputMode="numeric" className="stf-days" value={days} maxLength={3} aria-label="일수" onChange={event => setDays(event.target.value)} /> : null}
          {autoKind ? <span>일 뒤</span> : null}
          {autoKind ? <input type="date" className="stf-from" value={sendFrom} aria-label="시작일" onChange={event => setSendFrom(event.target.value)} /> : null}
          {autoKind ? <input type="text" inputMode="numeric" className="stf-days" value={repeat} maxLength={2} aria-label="횟수" onChange={event => setRepeat(event.target.value)} /> : null}
          {autoKind ? <span>번</span> : null}
          {autoKind && Number(repeat) >= 2 ? <input type="text" inputMode="numeric" className="stf-days" value={interval} maxLength={3} aria-label="간격" onChange={event => setInterval(event.target.value)} /> : null}
          {autoKind && Number(repeat) >= 2 ? <span>일 간격</span> : null}
        </span>
      </div>
      {imageError ? <p className="ktm-alert" role="alert">{imageError}</p> : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <div className="stf-actions">
        {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>취소</button> : null}
        <button type="submit" className="ktm-btn ktm-btn--primary" disabled={busy}>{busy ? (initial ? '저장 중…' : '등록 중…') : (initial ? '저장' : '등록')}</button>
      </div>
    </form>
  );
}
