import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createNotificationCampaign,
  fetchNotificationCampaigns,
  updateNotificationCampaign,
} from '../api/notificationCampaigns';
import './SmsCampaignManager.css';

const EMPTY_FORM = { id: '', revision: 0, name: '', subject: '', text: '', trigger: 'packing_completed', delayDays: 0 };

function campaignForm(item, audience) {
  if (!item) return { ...EMPTY_FORM, trigger: audience === 'employee' ? 'manual' : 'packing_completed' };
  return {
    id: item.id,
    revision: item.revision,
    name: item.name,
    subject: item.subject,
    text: item.text,
    trigger: audience === 'employee' ? 'manual' : item.trigger,
    delayDays: audience === 'employee' ? 0 : item.delayDays,
  };
}

function unresolvedPlaceholders(text, variables) {
  const allowed = new Set(variables.map(variable => variable.key));
  const unknown = [...text.matchAll(/\{([^{}]*)\}/g)].map(match => match[1]).filter(key => !allowed.has(key));
  const remainder = text.replace(/\{[^{}]*\}/g, '');
  if (remainder.includes('{') || remainder.includes('}')) unknown.push('잘못된 중괄호 형식');
  return [...new Set(unknown)];
}

function previewText(value, variables) {
  return variables.reduce((text, variable) => text.replaceAll(`{${variable.key}}`, variable.example), value);
}

export default function SmsCampaignManager({ audience }) {
  const [data, setData] = useState({ status: 'loading', items: [], variables: [], capabilities: { canRegister: false, canActivate: false }, notice: '' });
  const [view, setView] = useState('list');
  const [form, setForm] = useState(() => campaignForm(null, audience));
  const [message, setMessage] = useState('');
  const [messageType, setMessageType] = useState('');
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const dialogRef = useRef(null);
  const textareaRef = useRef(null);
  const returnFocusRef = useRef(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setData(current => ({ ...current, status: 'loading' }));
    try {
      const response = await fetchNotificationCampaigns(audience);
      if (requestId !== requestIdRef.current) return null;
      const next = {
        status: 'ready',
        items: Array.isArray(response?.items) ? response.items : [],
        variables: Array.isArray(response?.variables) ? response.variables : [],
        capabilities: { canRegister: false, canActivate: false, ...response?.capabilities },
        notice: response?.notice || '등록한 문자는 초안으로 저장됩니다.',
      };
      setData(next);
      return next;
    } catch {
      if (requestId === requestIdRef.current) setData(current => ({ ...current, status: 'error' }));
      return null;
    }
  }, [audience]);

  useEffect(() => {
    if (dialogRef.current?.open) dialogRef.current.close();
    setView('list');
    setForm(campaignForm(null, audience));
    setMessage('');
    setMessageType('');
    setStale(false);
    load();
  }, [audience, load]);

  const openDialog = (nextView, item, trigger) => {
    if (!dialogRef.current?.open) returnFocusRef.current = trigger;
    setView(nextView);
    setForm(campaignForm(item, audience));
    setMessage('');
    setMessageType('');
    setStale(false);
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  };

  const closeDialog = () => dialogRef.current?.close();
  const restoreFocus = () => returnFocusRef.current?.focus();
  const unknownVariables = useMemo(() => unresolvedPlaceholders(`${form.subject}\n${form.text}`, data.variables), [data.variables, form.subject, form.text]);
  const valid = form.name.trim().length >= 1 && form.name.trim().length <= 80
    && form.subject.trim().length >= 1 && form.subject.length <= 40
    && form.text.trim().length >= 1 && form.text.length <= 2000
    && unknownVariables.length === 0
    && (form.trigger === 'manual' || (form.delayDays !== '' && Number.isInteger(Number(form.delayDays)) && Number(form.delayDays) >= 0 && Number(form.delayDays) <= 30));

  const changeTrigger = trigger => setForm(current => ({ ...current, trigger, delayDays: trigger === 'manual' ? 0 : current.delayDays }));
  const insertVariable = variable => {
    const token = `{${variable.key}}`;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? form.text.length;
    const end = textarea?.selectionEnd ?? form.text.length;
    setForm(current => ({ ...current, text: `${current.text.slice(0, start)}${token}${current.text.slice(end)}` }));
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async event => {
    event.preventDefault();
    if (saving || !valid || !data.capabilities.canRegister) return;
    setSaving(true);
    setMessage('');
    setMessageType('');
    const payload = {
      audience,
      name: form.name.trim(),
      subject: form.subject.trim(),
      text: form.text,
      trigger: audience === 'employee' ? 'manual' : form.trigger,
      delayDays: form.trigger === 'packing_completed' && audience === 'customer' ? Number(form.delayDays) : 0,
    };
    try {
      const response = form.id
        ? await updateNotificationCampaign(form.id, { ...payload, revision: form.revision })
        : await createNotificationCampaign(payload);
      setData(current => ({ ...current, items: form.id ? current.items.map(item => item.id === response.item.id ? response.item : item) : [response.item, ...current.items] }));
      setForm(campaignForm(response.item, audience));
      setMessage('초안으로 저장했습니다. 발송은 활성화되지 않았습니다.');
      setMessageType('success');
      setStale(false);
    } catch (error) {
      if (error?.status === 409) {
        setMessage('다른 곳에서 수정된 초안입니다. 작성 내용은 유지됩니다. 최신 초안을 불러온 뒤 다시 확인해 주세요.');
        setMessageType('error');
        setStale(true);
      } else {
        setMessage(error?.message || '초안을 저장하지 못했습니다.');
        setMessageType('error');
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadStale = async () => {
    const latest = await load();
    const item = latest?.items.find(candidate => candidate.id === form.id);
    if (item) {
      setForm(campaignForm(item, audience));
      setMessage('최신 초안을 불러왔습니다. 내용을 다시 확인해 주세요.');
      setMessageType('success');
      setStale(false);
    }
  };

  return (
    <section className="sms-campaign-manager" aria-label="등록 문자 관리">
      <div className="sms-campaign-toolbar">
        <strong>{data.status === 'ready' ? `등록한 문자 ${data.items.length}개` : data.status === 'error' ? '등록한 문자 확인 필요' : '등록한 문자 확인 중'}</strong>
        <div>
          <button type="button" onClick={event => openDialog('list', null, event.currentTarget)}>문자 관리</button>
          <button type="button" className="is-primary" disabled={!data.capabilities.canRegister} onClick={event => openDialog('form', null, event.currentTarget)}>새 문자 등록</button>
        </div>
      </div>

      <dialog ref={dialogRef} className="sms-campaign-dialog" aria-labelledby="sms-campaign-dialog-title" onClose={restoreFocus}>
        <div className="sms-campaign-dialog__shell">
          <header>
            <div><p>{audience === 'customer' ? '고객 문자' : '직원 문자'}</p><h2 id="sms-campaign-dialog-title">{view === 'list' ? '등록 문자 관리' : form.id ? '문자 초안 수정' : '새 문자 등록'}</h2></div>
            <button type="button" className="sms-campaign-dialog__close" aria-label="문자 관리 닫기" onClick={closeDialog}>닫기</button>
          </header>

          {view === 'list' ? <div className="sms-campaign-dialog__body">
            <p className="sms-campaign-notice" role="status">{data.notice || '등록한 문자는 초안으로만 저장됩니다.'}</p>
            {data.status === 'loading' && <p className="sms-campaign-state" role="status">등록 문자를 불러오는 중입니다.</p>}
            {data.status === 'error' && <div className="sms-campaign-state" role="alert"><span>등록 문자를 불러오지 못했습니다.</span><button type="button" onClick={load}>다시 불러오기</button></div>}
            {data.status === 'ready' && data.items.length === 0 && <p className="sms-campaign-state">등록한 문자 초안이 없습니다.</p>}
            {data.status === 'ready' && data.items.length > 0 && <div className="sms-campaign-list">{data.items.map(item => <article key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <span>{item.audience === 'customer' ? '고객' : '직원'}</span>
                <span>{item.trigger === 'packing_completed' ? `포장완료 후 ${item.delayDays}일` : '직접 선택'}</span>
                <span>초안 · 발송 꺼짐</span>
              </div>
              <h3>{item.subject}</h3>
              <p>{item.text}</p>
              <button type="button" onClick={event => openDialog('form', item, event.currentTarget)}>미리보기·수정</button>
            </article>)}</div>}
          </div> : <form className="sms-campaign-form" onSubmit={save}>
            <div className="sms-campaign-form__scroll">
              <p className="sms-campaign-notice">{data.notice}</p>
              <label><span>관리 이름</span><input aria-label="관리 이름" type="text" required maxLength={80} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
              <label><span>문자 제목</span><input aria-label="문자 제목" type="text" required maxLength={40} value={form.subject} onChange={event => setForm(current => ({ ...current, subject: event.target.value }))} /></label>
              <fieldset>
                <legend>발송 조건</legend>
                {audience === 'customer' && <label><input type="radio" name="campaign-trigger" checked={form.trigger === 'packing_completed'} onChange={() => changeTrigger('packing_completed')} />포장완료 후</label>}
                <label><input type="radio" name="campaign-trigger" checked={form.trigger === 'manual'} onChange={() => changeTrigger('manual')} />직접 선택</label>
              </fieldset>
              {audience === 'customer' && form.trigger === 'packing_completed' && <label><span>대기일</span><input aria-label="대기일" type="number" required min="0" max="30" step="1" value={form.delayDays} onChange={event => setForm(current => ({ ...current, delayDays: event.target.value }))} /></label>}
              <label><span>문자 본문</span><textarea aria-label="문자 본문" ref={textareaRef} required maxLength={2000} rows="7" value={form.text} onChange={event => setForm(current => ({ ...current, text: event.target.value }))} /></label>
              <div className="sms-campaign-variables" aria-label="본문 변수 삽입">{data.variables.map(variable => <button type="button" key={variable.key} onClick={() => insertVariable(variable)}>{`{${variable.key}}`}</button>)}</div>
              {unknownVariables.length > 0 && <p className="sms-campaign-validation" role="alert">사용할 수 없는 변수: {unknownVariables.join(', ')}</p>}
              <section className="sms-campaign-preview" aria-label="문자 미리보기"><h3>{previewText(form.subject, data.variables) || '제목 미리보기'}</h3><p>{previewText(form.text, data.variables) || '본문 미리보기'}</p></section>
              {message && <div className={`sms-campaign-message ${messageType === 'error' ? 'is-error' : ''}`} role={messageType === 'error' ? 'alert' : 'status'}><span>{message}</span>{stale && <button type="button" onClick={reloadStale}>최신 초안 불러오기</button>}</div>}
            </div>
            <footer><button type="button" onClick={() => setView('list')}>목록으로</button><button type="submit" className="is-primary" disabled={saving || !valid || !data.capabilities.canRegister}>{saving ? '저장 중' : '초안 저장'}</button></footer>
          </form>}
        </div>
      </dialog>
    </section>
  );
}
