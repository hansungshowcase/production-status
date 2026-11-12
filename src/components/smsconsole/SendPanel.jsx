import { useEffect, useRef, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import { allVariablesFilled, buildRecipients, fillTemplateContent, lockedLine, makeIdempotencyKey, payloadSignature, templateVariableNames, textInfo } from './sendPanelModel.js';
import './SendPanel.css';

const wonText = value => (value === null || value === undefined ? '모름' : `${Number(value || 0).toLocaleString('ko-KR')}원`);
const typeText = type => (type === 'ATA' ? '알림톡' : type);

// 문자 직접 보내기. 화면이 처음 열릴 때 설정을 1번만 읽고, 이후 요청은 미리보기·보내기를 누를 때뿐이다.
export default function SendPanel({ active = true, template = '' }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [phoneText, setPhoneText] = useState('');
  const [staffIds, setStaffIds] = useState([]);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null); // { sig, count, type, cost }
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const keyRef = useRef({ sig: '', key: '' });
  const loadedRef = useRef(false);
  const [tplItem, setTplItem] = useState(null); // 알림톡으로 보낼 때만: 승인된 템플릿
  const [tplError, setTplError] = useState('');
  const [values, setValues] = useState({});

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    fetchSmsConsole('send').then(setOptions).catch(err => { loadedRef.current = false; setLoadError(err.message || '불러오지 못했습니다.'); });
  }, [active]);

  // 템플릿 모드: 템플릿 목록(서버 60초 캐시)을 1번 읽어 그 템플릿을 찾는다. 템플릿이 없으면 이 칸은 아무것도 하지 않는다.
  useEffect(() => {
    if (!template) { setTplItem(null); setTplError(''); return undefined; }
    setTplItem(null); setTplError(''); setValues({}); setPreview(null); setResult(null);
    if (!active) return undefined;
    let alive = true;
    fetchSmsConsole('templates').then(data => {
      if (!alive) return;
      const found = (data?.items || []).find(item => item.id === template);
      if (found && found.status === 'APPROVED') setTplItem(found); else setTplError('승인된 템플릿을 찾을 수 없습니다.');
    }).catch(err => { if (alive) setTplError(err.message || '템플릿을 불러오지 못했습니다.'); });
    return () => { alive = false; };
  }, [template, active]);

  const varNames = tplItem ? templateVariableNames(tplItem) : [];
  const { recipients, invalid } = buildRecipients(phoneText, staffIds);
  const info = textInfo(text);
  const sig = payloadSignature(recipients, template ? JSON.stringify([template, values]) : text);
  const locked = lockedLine(options);
  const previewOk = preview && preview.sig === sig;
  const contentReady = template ? Boolean(tplItem) && allVariablesFilled(varNames, values) : Boolean(info.type) && !info.tooLong;
  const canPreview = !locked && !busy && recipients.length > 0 && invalid === 0 && contentReady;

  const toggleStaff = id => { setStaffIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])); setResult(null); };
  const request = async dryRun => {
    setBusy(dryRun ? 'preview' : 'send');
    setError('');
    if (keyRef.current.sig !== sig) keyRef.current = { sig, key: makeIdempotencyKey() };
    try {
      const body = template ? { recipients, kakao: { templateId: template, variables: values }, dry_run: dryRun, idempotencyKey: keyRef.current.key } : { recipients, text, dry_run: dryRun, idempotencyKey: keyRef.current.key };
      const out = await postSmsConsole('send', body);
      if (dryRun) { setPreview({ sig, count: out.count, type: out.type, cost: out.cost }); setResult(null); return; }
      setResult(out);
      setPhoneText(''); setStaffIds([]); setPreview(null);
      keyRef.current = { sig: '', key: '' };
    } catch (err) {
      setError(err.message || '요청에 실패했습니다.');
    } finally {
      setBusy('');
    }
  };

  if (loadError) return <p className="smsc-send__error" role="alert">{loadError}</p>;
  if (!options) return <p className="sms-console-loading" role="status">불러오는 중…</p>;

  return (
    <form className="smsc-send" onSubmit={event => event.preventDefault()} noValidate>
      <div className="smsc-send__field">
        <label htmlFor="smsc-send-phones">받는 번호</label>
        <textarea id="smsc-send-phones" rows={4} value={phoneText} inputMode="tel" autoComplete="off"
          onChange={event => { setPhoneText(event.target.value); setResult(null); }} aria-invalid={invalid > 0} />
        {invalid > 0 ? <p className="smsc-send__error">휴대폰 번호 형식이 아닌 번호가 {invalid}개 있습니다.</p> : null}
      </div>
      {options.staff?.length ? (
        <fieldset className="smsc-send__group">
          <legend>직원</legend>
          <div className="smsc-send__choices">
            {options.staff.map(person => (
              <label key={person.id} className="smsc-send__choice">
                <input type="checkbox" checked={staffIds.includes(person.id)} onChange={() => toggleStaff(person.id)} />
                <span>{person.name} ({person.tail})</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {template ? (
        <div className="smsc-send__tpl">
          {tplError ? <p className="smsc-send__error" role="alert">{tplError}</p> : null}
          {!tplError && !tplItem ? <p className="sms-console-loading" role="status">불러오는 중…</p> : null}
          {tplItem ? (
            <>
              <div className="smsc-send__field">
                <label>{tplItem.name}</label>
                <pre className="smsc-send__tplbody">{fillTemplateContent(tplItem.content, values)}</pre>
              </div>
              {varNames.map((name, index) => (
                <div className="smsc-send__field" key={name}>
                  <label htmlFor={`smsc-send-var-${index}`}>{name}</label>
                  <textarea id={`smsc-send-var-${index}`} rows={2} value={values[name] || ''}
                    onChange={event => { setValues(prev => ({ ...prev, [name]: event.target.value })); setResult(null); }} />
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
      <div className="smsc-send__field" hidden={Boolean(template)}>
        <label htmlFor="smsc-send-text">내용</label>
        <textarea id="smsc-send-text" rows={6} value={text} onChange={event => { setText(event.target.value); setResult(null); }} />
        <p className="smsc-send__count">{info.bytes} 바이트{info.type ? ` · ${info.type}` : ''}{info.tooLong ? ' · 너무 깁니다' : ''}</p>
      </div>
      {error ? <p className="smsc-send__server" role="alert">{error}</p> : null}
      {previewOk ? <p className="smsc-send__preview" role="status">{preview.count}명 · {typeText(preview.type)} · 예상 {wonText(preview.cost)}</p> : null}
      {result ? <p className="smsc-send__result" role="status">성공 {result.success}건 · 실패 {result.fail}건{result.message ? ` · ${result.message}` : ''}</p> : null}
      {locked ? <p className="smsc-send__locked">{locked}</p> : (
        <div className="smsc-send__actions">
          <button type="button" className="smsc-send__btn" disabled={!canPreview} onClick={() => request(true)}>{busy === 'preview' ? '확인 중…' : '미리보기'}</button>
          <button type="button" className="smsc-send__btn smsc-send__btn--primary" disabled={!canPreview || !previewOk} onClick={() => request(false)}>{busy === 'send' ? '보내는 중…' : '보내기'}</button>
        </div>
      )}
    </form>
  );
}
