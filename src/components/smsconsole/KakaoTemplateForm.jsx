import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  TEMPLATE_LIMITS,
  BUTTON_TYPES,
  DEFAULT_CATEGORY,
  validateTemplateInput,
} from '../../../shared/smsConsole.js';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import KakaoTemplatePreview from './KakaoTemplatePreview.jsx';
import {
  addButton,
  afterCreate,
  canAddButton,
  countChars,
  cropToBanner,
  emptyFormValues,
  extraErrors,
  firstErrorKey,
  formValuesFromTemplate,
  insertVariable,
  inspectFailText,
  missingFieldsText,
  moveButton,
  previewTemplate,
  removeButton,
  submitSteps,
  targetKey,
  toValidationInput,
  updateButton,
  variableNameError,
} from './templateFormModel.js';
import './KakaoTemplateForm.css';

const FALLBACK_CATEGORIES = [{ code: DEFAULT_CATEGORY, name: '기타' }];
let categoriesPromise = null; // 모듈 안 캐시: 양식을 몇 번 열어도 조회는 1번

function loadCategories() {
  if (!categoriesPromise) {
    categoriesPromise = fetchSmsConsole('categories')
      .then(data => (Array.isArray(data?.items) && data.items.length ? data.items : FALLBACK_CATEGORIES))
      .catch(() => FALLBACK_CATEGORIES);
  }
  return categoriesPromise;
}

function useNarrow() {
  const query = '(max-width: 768px)';
  const [narrow, setNarrow] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    onChange();
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  return narrow;
}

export default function KakaoTemplateForm({
  mode = 'create', initial = null, targets = [], busy = false, serverError = '', onCancel, onSubmit,
}) {
  const isEdit = mode === 'edit';
  const uid = useId();
  const fid = key => `${uid}-${String(key).replace(/\./g, '-')}`;
  const [form, setForm] = useState(() => (isEdit ? formValuesFromTemplate(initial) : { ...emptyFormValues(targets), requestInspection: true }));
  const [submitted, setSubmitted] = useState(false);
  const [stopText, setStopText] = useState('');
  const [createdId, setCreatedId] = useState(null);
  const [inspectError, setInspectError] = useState('');
  const [pending, setPending] = useState(false);
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [varOpen, setVarOpen] = useState(false);
  const [varName, setVarName] = useState('');
  const [varError, setVarError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const narrow = useNarrow();
  const contentRef = useRef(null);
  const selectionRef = useRef({ start: null, end: null });
  const cursorRef = useRef(null);
  const sendingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let live = true;
    loadCategories().then(items => { if (live) setCategories(items); });
    return () => { live = false; aliveRef.current = false; };
  }, []);

  // targets 가 나중에 도착해 1개뿐이면 자동 선택(create 에서 아직 비어 있을 때만)
  useEffect(() => {
    if (isEdit || form.targetKey || !Array.isArray(targets) || targets.length !== 1) return;
    setForm(prev => (prev.targetKey ? prev : { ...prev, targetKey: targetKey(targets[0]) }));
  }, [isEdit, targets, form.targetKey]);

  // 변수 삽입 뒤 커서 복원
  useLayoutEffect(() => {
    if (cursorRef.current == null || !contentRef.current) return;
    const pos = cursorRef.current;
    cursorRef.current = null;
    contentRef.current.focus();
    contentRef.current.setSelectionRange(pos, pos);
  }, [form.content]);

  const categoryList = useMemo(() => {
    const list = [...categories];
    if (form.categoryCode && !list.some(c => c.code === form.categoryCode)) list.push({ code: form.categoryCode, name: '' });
    return list;
  }, [categories, form.categoryCode]);

  function validateAll(current) {
    const result = validateTemplateInput(toValidationInput(current), { requireTarget: !isEdit });
    return { ...(result.ok ? {} : result.errors), ...extraErrors(current) };
  }

  const errors = useMemo(() => (submitted ? validateAll(form) : {}), [submitted, form, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = busy || pending;
  const set = patch => setForm(prev => ({ ...prev, ...patch }));
  const isText = form.emphasizeType === 'TEXT';
  const isImage = form.emphasizeType === 'IMAGE';
  const isEx = form.messageType === 'EX';
  const editTarget = isEdit ? (initial?.target || targets.find(t => targetKey(t) === form.targetKey)) : null;
  const preview = useMemo(() => {
    const view = previewTemplate(form, targets);
    if (isEdit && !view.targetName) view.targetName = editTarget?.name || '';
    return view;
  }, [form, targets, isEdit, editTarget]);

  const errProps = key => (errors[key]
    ? { 'aria-invalid': 'true', 'aria-describedby': `${fid(key)}-err` }
    : {});
  const errNode = key => (errors[key]
    ? <p id={`${fid(key)}-err`} className="smsc-form__error">{errors[key]}</p>
    : null);

  function focusKey(key) {
    const direct = document.getElementById(fid(key));
    const target = direct
      || document.getElementById(`${fid(key)}-name`)
      || (key === 'buttons' ? document.getElementById(fid('add-button')) : null);
    if (target) {
      target.focus();
      target.scrollIntoView?.({ block: 'center' });
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (locked || sendingRef.current) return;
    setSubmitted(true);
    setStopText('');
    const result = validateTemplateInput(toValidationInput(form), { requireTarget: !isEdit });
    const all = { ...(result.ok ? {} : result.errors), ...extraErrors(form) };
    if (Object.keys(all).length || !result.ok) {
      const key = firstErrorKey(all);
      setStopText(missingFieldsText(all));
      setTimeout(() => focusKey(key), 0);
      return;
    }
    sendingRef.current = true;
    setPending(true);
    setInspectError('');
    const comment = !isEdit ? String(form.comment || '').trim() : '';
    try {
      const [step] = submitSteps({ isEdit, createdId });
      if (step === 'inspect') {
        await runInspect(createdId, comment);
      } else {
        const created = await onSubmit?.(result.value, { requestInspection: !isEdit, comment });
        const next = afterCreate(created);
        if (next.createdId && aliveRef.current) setCreatedId(next.createdId);
        if (next.createdId && next.inspect) await runInspect(next.createdId, comment);
      }
    } catch {
      // 오류 문구는 부모가 serverError 로 보여 준다
    } finally {
      sendingRef.current = false;
      if (aliveRef.current) setPending(false);
    }
  }

  async function runInspect(id, comment) {
    try {
      await postSmsConsole('inspect', { id, comment });
    } catch (error) {
      if (aliveRef.current) setInspectError(inspectFailText(error));
    }
  }

  async function pickImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || imageBusy) return;
    setImageError('');
    setImageBusy(true);
    try {
      const shrunk = await cropToBanner(file);
      const out = await postSmsConsole('kakao_image_upload', { image: { data: shrunk.data } });
      if (!out?.imageId) throw new Error('이미지를 올리지 못했습니다.');
      if (aliveRef.current) setForm(prev => ({ ...prev, imageId: String(out.imageId), imageUrl: shrunk.url }));
    } catch (error) {
      if (aliveRef.current) setImageError(String(error?.message || '이미지를 올리지 못했습니다.'));
    } finally {
      if (aliveRef.current) setImageBusy(false);
    }
  }

  function openVariable() {
    const area = contentRef.current;
    selectionRef.current = area ? { start: area.selectionStart, end: area.selectionEnd } : { start: null, end: null };
    setVarName('');
    setVarError('');
    setVarOpen(true);
  }

  function insertNow() {
    const problem = variableNameError(varName);
    if (problem) { setVarError(problem); return; }
    const { start, end } = selectionRef.current;
    const next = insertVariable(form.content, start, varName, end);
    cursorRef.current = next.cursor;
    set({ content: next.text });
    setVarOpen(false);
    setVarName('');
    setVarError('');
  }

  const typeButtons = (
    <fieldset className="smsc-form__group">
      <legend>템플릿 유형</legend>
      <div className="smsc-form__choices">
        <label className="smsc-form__choice">
          <input id={fid('emphasizeType')} type="radio" name={`${uid}-emp`} checked={!isText} onChange={() => set({ emphasizeType: 'NONE' })} disabled={locked} />
          <span>기본형</span>
        </label>
        <label className="smsc-form__choice">
          <input type="radio" name={`${uid}-emp`} checked={isText} onChange={() => set({ emphasizeType: 'TEXT' })} disabled={locked} />
          <span>강조표기형</span>
        </label>
        <label className="smsc-form__choice">
          <input type="radio" name={`${uid}-emp`} checked={isImage} onChange={() => set({ emphasizeType: 'IMAGE' })} disabled={locked} />
          <span>이미지형</span>
        </label>
        <label className="smsc-form__choice smsc-form__choice--off">
          <input type="radio" disabled name={`${uid}-emp`} />
          <span>리스트형 <em>쏠라피에서 등록</em></span>
        </label>
      </div>
      {errNode('emphasizeType')}
    </fieldset>
  );

  const formBody = (
    <form className="smsc-form__form" onSubmit={submit} noValidate>
      <div className="smsc-form__field">
        <label htmlFor={fid('target')}>채널 / 그룹 <b aria-hidden="true">*</b></label>
        {isEdit ? (
          <p className="smsc-form__readonly" id={fid('target')}>{editTarget?.name || '(알 수 없음)'} <small>수정할 수 없습니다</small></p>
        ) : (
          <select id={fid('target')} value={form.targetKey} onChange={e => set({ targetKey: e.target.value })} disabled={locked} {...errProps('target')}>
            {targets.length !== 1 ? <option value="">선택하세요</option> : null}
            {targets.map(t => (
              <option key={targetKey(t)} value={targetKey(t)}>{t.name}{t.kind === 'group' ? ' (그룹)' : ''}</option>
            ))}
          </select>
        )}
        {errNode('target')}
      </div>

      <div className="smsc-form__field">
        <label htmlFor={fid('categoryCode')}>카테고리 <b aria-hidden="true">*</b></label>
        <select id={fid('categoryCode')} value={form.categoryCode} onChange={e => set({ categoryCode: e.target.value })} disabled={locked} {...errProps('categoryCode')}>
          {categoryList.map(c => <option key={c.code} value={c.code}>{c.code}{c.name ? ` ${c.name}` : ''}</option>)}
        </select>
        {errNode('categoryCode')}
      </div>

      {typeButtons}

      <fieldset className="smsc-form__group">
        <legend>메시지 유형</legend>
        <div className="smsc-form__choices">
          <label className="smsc-form__choice">
            <input id={fid('messageType')} type="radio" name={`${uid}-msg`} checked={!isEx} onChange={() => set({ messageType: 'BA' })} disabled={locked} />
            <span>기본</span>
          </label>
          <label className="smsc-form__choice">
            <input type="radio" name={`${uid}-msg`} checked={isEx} onChange={() => set({ messageType: 'EX' })} disabled={locked} />
            <span>부가정보</span>
          </label>
        </div>
        {errNode('messageType')}
      </fieldset>

      <div className="smsc-form__field">
        <label htmlFor={fid('name')}>템플릿 이름 <b aria-hidden="true">*</b></label>
        <input id={fid('name')} type="text" value={form.name} maxLength={TEMPLATE_LIMITS.name} onChange={e => set({ name: e.target.value })} disabled={locked} autoComplete="off" {...errProps('name')} />
        <p className="smsc-form__count">{countChars(form.name)} / {TEMPLATE_LIMITS.name}</p>
        {errNode('name')}
      </div>

      {isImage ? (
        <div className="smsc-form__field">
          <label htmlFor={fid('imageId')}>이미지 <b aria-hidden="true">*</b></label>
          {imageError ? <p className="smsc-form__error" role="alert">{imageError}</p> : null}
          <div className="smsc-form__imagerow">
            <input id={fid('imageId')} type="file" accept="image/jpeg,image/png" onChange={pickImage} disabled={locked || imageBusy} {...errProps('imageId')} />
            {form.imageId ? <button type="button" className="smsc-form__btn smsc-form__btn--small" disabled={locked || imageBusy} onClick={() => set({ imageId: '', imageUrl: '' })}>빼기</button> : null}
          </div>
          {form.imageId && form.imageUrl ? <img className="smsc-form__imagethumb" src={form.imageUrl} alt="올린 이미지" /> : null}
          {errNode('imageId')}
        </div>
      ) : null}

      {isText ? (
        <>
          <div className="smsc-form__field">
            <label htmlFor={fid('emphasizeSubtitle')}>보조 문구 <b aria-hidden="true">*</b></label>
            <input id={fid('emphasizeSubtitle')} type="text" value={form.emphasizeSubtitle} maxLength={TEMPLATE_LIMITS.emphasize} onChange={e => set({ emphasizeSubtitle: e.target.value })} disabled={locked} autoComplete="off" {...errProps('emphasizeSubtitle')} />
            <p className="smsc-form__count">{countChars(form.emphasizeSubtitle)} / {TEMPLATE_LIMITS.emphasize}</p>
            {errNode('emphasizeSubtitle')}
          </div>
          <div className="smsc-form__field">
            <label htmlFor={fid('emphasizeTitle')}>강조 제목 <b aria-hidden="true">*</b></label>
            <input id={fid('emphasizeTitle')} type="text" value={form.emphasizeTitle} maxLength={TEMPLATE_LIMITS.emphasize} onChange={e => set({ emphasizeTitle: e.target.value })} disabled={locked} autoComplete="off" {...errProps('emphasizeTitle')} />
            <p className="smsc-form__count">{countChars(form.emphasizeTitle)} / {TEMPLATE_LIMITS.emphasize}</p>
            {errNode('emphasizeTitle')}
          </div>
        </>
      ) : null}

      <div className="smsc-form__field">
        <div className="smsc-form__labelrow">
          <label htmlFor={fid('content')}>내용 <b aria-hidden="true">*</b></label>
          <button type="button" className="smsc-form__btn smsc-form__btn--small" onClick={openVariable} disabled={locked}>변수 추가</button>
        </div>
        {varOpen ? (
          <div className="smsc-form__varbox">
            <label htmlFor={fid('var')}>변수 이름 (한글·영문·숫자·밑줄 1~20자)</label>
            <div className="smsc-form__varrow">
              <input
                id={fid('var')}
                type="text"
                value={varName}
                autoFocus
                autoComplete="off"
                maxLength={20}
                aria-invalid={varError ? 'true' : undefined}
                aria-describedby={varError ? `${fid('var')}-err` : undefined}
                onChange={e => { setVarName(e.target.value); if (varError) setVarError(''); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); insertNow(); }
                  if (e.key === 'Escape') { e.stopPropagation(); setVarOpen(false); }
                }}
              />
              <button type="button" className="smsc-form__btn smsc-form__btn--primary" onClick={insertNow}>넣기</button>
              <button type="button" className="smsc-form__btn" onClick={() => setVarOpen(false)}>닫기</button>
            </div>
            {varError ? <p id={`${fid('var')}-err`} className="smsc-form__error">{varError}</p> : null}
          </div>
        ) : null}
        <textarea id={fid('content')} ref={contentRef} rows={8} value={form.content} onChange={e => set({ content: e.target.value })} disabled={locked} {...errProps('content')} />
        <p className="smsc-form__count">{countChars(form.content)} / {TEMPLATE_LIMITS.content}</p>
        {errNode('content')}
      </div>

      {isEx ? (
        <div className="smsc-form__field">
          <label htmlFor={fid('extra')}>부가정보 <b aria-hidden="true">*</b></label>
          <textarea id={fid('extra')} rows={3} value={form.extra} onChange={e => set({ extra: e.target.value })} disabled={locked} {...errProps('extra')} />
          <p className="smsc-form__count">{countChars(form.extra)} / {TEMPLATE_LIMITS.extra} · 변수·링크는 넣을 수 없습니다</p>
          {errNode('extra')}
        </div>
      ) : null}

      <label className="smsc-form__check">
        <input type="checkbox" checked={form.securityFlag} onChange={e => set({ securityFlag: e.target.checked })} disabled={locked} />
        <span>보안 템플릿</span>
      </label>

      <fieldset className="smsc-form__group">
        <legend>버튼 ({form.buttons.length} / {TEMPLATE_LIMITS.buttons})</legend>
        {form.buttons.map((button, index) => (
          <div className="smsc-form__button" key={index}>
            <div className="smsc-form__buttonhead">
              <strong>버튼 {index + 1}</strong>
              <span className="smsc-form__buttonops">
                <button type="button" className="smsc-form__btn smsc-form__btn--icon" aria-label={`버튼 ${index + 1} 위로`} disabled={locked || index === 0} onClick={() => set({ buttons: moveButton(form.buttons, index, -1) })}>▲</button>
                <button type="button" className="smsc-form__btn smsc-form__btn--icon" aria-label={`버튼 ${index + 1} 아래로`} disabled={locked || index === form.buttons.length - 1} onClick={() => set({ buttons: moveButton(form.buttons, index, 1) })}>▼</button>
                <button type="button" className="smsc-form__btn smsc-form__btn--small" aria-label={`버튼 ${index + 1} 삭제`} disabled={locked} onClick={() => set({ buttons: removeButton(form.buttons, index) })}>삭제</button>
              </span>
            </div>
            <label htmlFor={`${fid(`buttons.${index}`)}-type`}>유형</label>
            <select id={`${fid(`buttons.${index}`)}-type`} value={button.type} disabled={locked} onChange={e => set({ buttons: updateButton(form.buttons, index, { type: e.target.value }) })}>
              {Object.entries(BUTTON_TYPES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
            <label htmlFor={`${fid(`buttons.${index}`)}-name`}>버튼 이름 (1~{TEMPLATE_LIMITS.buttonName}자)</label>
            <input
              id={`${fid(`buttons.${index}`)}-name`}
              type="text"
              value={button.name}
              maxLength={TEMPLATE_LIMITS.buttonName}
              disabled={locked}
              autoComplete="off"
              onChange={e => set({ buttons: updateButton(form.buttons, index, { name: e.target.value }) })}
              {...(errors[`buttons.${index}`] ? { 'aria-invalid': 'true', 'aria-describedby': `${fid(`buttons.${index}`)}-err` } : {})}
            />
            {button.type === 'WL' ? (
              <>
                <label htmlFor={`${fid(`buttons.${index}`)}-mo`}>모바일 링크</label>
                <input id={`${fid(`buttons.${index}`)}-mo`} type="text" inputMode="url" placeholder="https://" value={button.linkMo} disabled={locked} autoComplete="off" onChange={e => set({ buttons: updateButton(form.buttons, index, { linkMo: e.target.value }) })} />
                <label htmlFor={`${fid(`buttons.${index}`)}-pc`}>PC 링크 (선택)</label>
                <input id={`${fid(`buttons.${index}`)}-pc`} type="text" inputMode="url" placeholder="https://" value={button.linkPc} disabled={locked} autoComplete="off" onChange={e => set({ buttons: updateButton(form.buttons, index, { linkPc: e.target.value }) })} />
              </>
            ) : null}
            {errNode(`buttons.${index}`)}
          </div>
        ))}
        <button id={fid('add-button')} type="button" className="smsc-form__btn" disabled={locked || !canAddButton(form.buttons)} onClick={() => set({ buttons: addButton(form.buttons, 'WL') })} {...errProps('buttons')}>
          + 버튼 추가
        </button>
        {errNode('buttons')}
      </fieldset>

      {!isEdit ? (
        <div className="smsc-form__field">
          <label htmlFor={fid('comment')}>검수자 참고 의견 (선택)</label>
          <textarea id={fid('comment')} rows={3} value={form.comment} onChange={e => set({ comment: e.target.value })} disabled={locked} {...errProps('comment')} />
          <p className="smsc-form__count">{countChars(form.comment)} / {TEMPLATE_LIMITS.comment}</p>
          {errNode('comment')}
        </div>
      ) : null}

      <div className="smsc-form__field">
        <label className="smsc-form__check">
          <input id={fid('confirmed')} type="checkbox" checked={form.confirmed} onChange={e => set({ confirmed: e.target.checked })} disabled={locked} {...errProps('confirmed')} />
          <span>정보성 메시지만 등록할 수 있음을 확인했습니다</span>
        </label>
        {errNode('confirmed')}
      </div>

      {narrow ? (
        <div className="smsc-form__mpreview">
          <button type="button" className="smsc-form__btn" aria-expanded={previewOpen} aria-controls={fid('preview')} onClick={() => setPreviewOpen(v => !v)}>
            {previewOpen ? '미리보기 접기' : '미리보기 펼치기'}
          </button>
          {previewOpen ? <div id={fid('preview')} className="smsc-form__previewbox"><KakaoTemplatePreview template={preview} /></div> : null}
        </div>
      ) : null}

      <div className="smsc-form__footer">
        {stopText ? <p className="smsc-form__error" role="alert">{stopText}</p> : null}
        {inspectError ? <p className="smsc-form__error" role="alert">{inspectError}</p> : null}
        {serverError ? <p className="smsc-form__server" role="alert">{serverError}</p> : null}
        <div className="smsc-form__actions">
          <button type="button" className="smsc-form__btn" onClick={onCancel} disabled={locked}>취소</button>
          <button type="submit" className="smsc-form__btn smsc-form__btn--primary" disabled={locked}>
            {locked ? '처리 중…' : (isEdit ? '수정 저장' : (createdId ? '검수 요청' : '등록하고 검수 요청'))}
          </button>
        </div>
      </div>
    </form>
  );

  return (
    <section className="smsc-form" aria-label={isEdit ? '알림톡 템플릿 수정' : '알림톡 템플릿 등록'}>
      <div className="smsc-form__main">{formBody}</div>
      {!narrow ? (
        <aside className="smsc-form__side" aria-label="미리보기">
          <KakaoTemplatePreview template={preview} />
        </aside>
      ) : null}
    </section>
  );
}
