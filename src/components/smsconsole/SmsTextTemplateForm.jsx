import { useRef, useState } from 'react';
import { postSmsConsole } from '../../api/smsConsole.js';
import { shrinkImage } from './sendPanelModel.js';
import { KIND_KAKAO, KIND_SMS, TEXT_NAME_MAX, buildSaveBody, validateTextForm } from './smsTextTemplateFormModel.js';
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
export default function SmsTextTemplateForm({ onSend, onCancel }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [image, setImage] = useState(null);
  const [imageError, setImageError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const fileRef = useRef(null);
  const check = validateTextForm({ name, body });
  const { info } = check;

  const pickImage = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImageError('');
    try {
      const next = await shrinkImage(file);
      if (image?.url) URL.revokeObjectURL(image.url);
      setImage(next);
    } catch (err) { setImageError(err.message || '사진이 너무 큽니다'); }
  };
  const removeImage = () => { if (image?.url) URL.revokeObjectURL(image.url); setImage(null); setImageError(''); };
  const submit = async () => {
    if (busy || !check.ok) return;
    setBusy(true);
    setError('');
    try {
      const out = await postSmsConsole('text_template_save', buildSaveBody({ name, body, image }));
      setSaved(out.item);
    } catch (err) { setError(err.message || '등록하지 못했습니다.'); } finally { setBusy(false); }
  };

  if (saved) {
    return (
      <div className="stf-form">
        <p className="stf-done" role="status">등록했습니다</p>
        <div className="stf-actions">
          <button type="button" className="ktm-btn ktm-btn--primary" onClick={() => onSend(saved.id)}>이 문구로 보내기</button>
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
        <button type="button" className="ktm-btn" onClick={() => fileRef.current?.click()}>사진</button>
        {image ? <img className="stf-thumb" src={image.url} alt="" /> : null}
        {image ? <button type="button" className="ktm-btn" onClick={removeImage}>빼기</button> : null}
      </div>
      {imageError ? <p className="ktm-alert" role="alert">{imageError}</p> : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <div className="stf-actions">
        {onCancel ? <button type="button" className="ktm-btn" onClick={onCancel}>취소</button> : null}
        <button type="submit" className="ktm-btn ktm-btn--primary" disabled={busy || !check.ok}>{busy ? '등록 중…' : '등록'}</button>
      </div>
    </form>
  );
}
