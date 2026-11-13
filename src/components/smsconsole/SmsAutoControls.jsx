import { useRef, useState } from 'react';
import { postSmsConsole } from '../../api/smsConsole.js';
import { autoConfirmLine, testPhoneDigits, testResultText, toggleRejectText } from './smsTextTemplateFormModel.js';

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const reasonOf = (err) => err?.data?.reason || err?.data?.error?.reason || '';

// 자동 발송 문구 카드의 [켜기/끄기] · [내 번호로 시험]. 켜기와 시험 발송은 dry_run 확인 줄을 보인 뒤 한 번 더 눌러 확정한다.
export default function SmsAutoControls({ id, enabled, photos = 0, onChanged, children }) {
  const [confirm, setConfirm] = useState(null); // 켜기 확인 줄
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testOpen, setTestOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [preview, setPreview] = useState(null); // 시험 dry_run 결과
  const [result, setResult] = useState('');
  const keyRef = useRef('');

  const fail = (err) => setError(toggleRejectText(reasonOf(err)) || err?.message || '처리하지 못했습니다.');
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (enabled) {
        await postSmsConsole('auto_toggle', { id, enabled: false });
        onChanged?.();
      } else if (!confirm) {
        setConfirm(await postSmsConsole('auto_toggle', { id, enabled: true, dry_run: true }));
      } else {
        await postSmsConsole('auto_toggle', { id, enabled: true });
        setConfirm(null);
        onChanged?.();
      }
    } catch (err) { fail(err); setConfirm(null); } finally { setBusy(false); }
  };
  const test = async () => {
    const to = testPhoneDigits(phone);
    if (busy) return;
    if (!to) { setError('받을 번호를 010 으로 시작하는 숫자로 넣어 주세요.'); return; }
    setBusy(true); setError('');
    try {
      if (!preview) {
        setResult('');
        setPreview(await postSmsConsole('auto_test', { id, to, dry_run: true }));
        keyRef.current = newKey();
      } else {
        setResult(testResultText(await postSmsConsole('auto_test', { id, to, dry_run: false, idempotencyKey: keyRef.current })));
        setPreview(null);
        onChanged?.();
      }
    } catch (err) { setError(err?.message || '시험하지 못했습니다.'); setPreview(null); } finally { setBusy(false); }
  };

  return (
    <div className="sac">
      <div className="ktm-modal-actions sac-row">
        <button type="button" className="ktm-btn" disabled={busy} onClick={toggle}>{enabled ? '끄기' : (confirm ? '켜기 확인' : '켜기')}</button>
        {confirm ? <button type="button" className="ktm-btn" onClick={() => setConfirm(null)}>취소</button> : null}
        <button type="button" className="ktm-btn" onClick={() => { setTestOpen((v) => !v); setPreview(null); setResult(''); setError(''); }}>내 번호로 시험</button>
        {children}
      </div>
      {confirm ? <p className="sac-line">{autoConfirmLine(confirm, photos)}{confirm.overlap === true ? ' · 기존 알림과 겹칠 수 있음' : ''}</p> : null}
      {testOpen ? (
        <div className="sac-test">
          <input type="text" inputMode="tel" value={phone} maxLength={13} autoComplete="off" aria-label="시험 받을 번호" onChange={(event) => { setPhone(event.target.value); setPreview(null); }} />
          <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={test}>{preview ? '발송' : '확인'}</button>
          {preview ? <span className="sac-line">{autoConfirmLine({ parts: preview.parts, cost: preview.cost }, photos)}</span> : null}
          {result ? <span className="sac-line" role="status">{result}</span> : null}
        </div>
      ) : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
    </div>
  );
}
