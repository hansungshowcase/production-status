import { useRef, useState } from 'react';
import { postSmsConsole } from '../../api/smsConsole.js';
import { autoConfirmLine, testPhoneDigits, testResultText, toggleRejectText } from './smsTextTemplateFormModel.js';

const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const reasonOf = (err) => err?.data?.reason || err?.data?.error?.reason || '';

// 자동 발송 문구 카드의 [켜기/끄기] · [내 번호로 시험]. 켜기·끄기·시험 발송 모두 확인 줄을 거친 뒤 확정한다.
export default function SmsAutoControls({ id, enabled, photos = 0, ata = false, bms = false, compact = false, onChanged, children }) {
  const [confirm, setConfirm] = useState(null); // 켜기 확인 줄
  const [offConfirm, setOffConfirm] = useState(false); // 끄기 2단계 실수 방지 확인
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testOpen, setTestOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [preview, setPreview] = useState(null); // 시험 dry_run 결과
  const [result, setResult] = useState('');
  const keyRef = useRef('');
  const fullTestLabel = bms ? '내 번호로 브랜드메시지 시험' : ata ? '내 번호로 알림톡 시험' : '내 번호로 시험';

  const fail = (err) => setError(toggleRejectText(reasonOf(err)) || err?.message || '처리하지 못했습니다.');
  const toggle = async () => {
    if (busy) return;
    if (enabled && !offConfirm) {
      setError('');
      setConfirm(null);
      setOffConfirm(true);
      return;
    }
    setBusy(true); setError('');
    try {
      if (enabled) {
        await postSmsConsole('auto_toggle', { id, enabled: false });
        setOffConfirm(false);
        onChanged?.();
      } else if (!confirm) {
        setConfirm(await postSmsConsole('auto_toggle', { id, enabled: true, dry_run: true }));
      } else {
        await postSmsConsole('auto_toggle', { id, enabled: true });
        setConfirm(null);
        onChanged?.();
      }
    } catch (err) { fail(err); setConfirm(null); setOffConfirm(false); } finally { setBusy(false); }
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

  const toggleBtnLabel = enabled ? (offConfirm ? '끄기 확인' : '끄기') : (confirm ? '켜기 확인' : '켜기');
  const toggleBtnClass = enabled && offConfirm ? 'ktm-btn ktm-btn--danger-outline' : 'ktm-btn';

  return (
    <div className="sac">
      <div className="ktm-modal-actions sac-row">
        <button type="button" className={toggleBtnClass} disabled={busy} onClick={toggle}>{toggleBtnLabel}</button>
        {(confirm || offConfirm) ? <button type="button" className="ktm-btn" disabled={busy} onClick={() => { setConfirm(null); setOffConfirm(false); }}>취소</button> : null}
        <button type="button" className="ktm-btn" title={fullTestLabel} aria-label={fullTestLabel} onClick={() => { setTestOpen((v) => !v); setOffConfirm(false); setConfirm(null); setPreview(null); setResult(''); setError(''); }}>{compact ? '시험 발송' : fullTestLabel}</button>
        {children}
      </div>
      {offConfirm ? <p className="sac-line sac-off-warn" role="status">자동 발송을 끄면 고객에게 더 이상 나가지 않습니다. 정말 끄시려면 &apos;끄기 확인&apos;을 누르세요.</p> : null}
      {confirm ? <p className="sac-line">{autoConfirmLine(confirm, photos)}{confirm.overlap === true ? ' · 기존 알림과 겹칠 수 있음' : ''}</p> : null}
      {testOpen ? (
        <div className="sac-test">
          <label className="sac-test-label">
            <span>받을 번호</span>
            <input
              type="text"
              inputMode="tel"
              value={phone}
              maxLength={13}
              autoComplete="off"
              placeholder="010-1234-5678 (내 번호)"
              aria-label="시험 받을 번호"
              onChange={(event) => { setPhone(event.target.value); setPreview(null); }}
            />
          </label>
          <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={test}>{preview ? '발송' : '확인'}</button>
          {preview ? <span className="sac-line">{preview.bms ? '' : preview.ata ? '알림톡 · ' : ''}{autoConfirmLine({ parts: preview.parts, cost: preview.cost, bms: preview.bms, unit: preview.unit, fallback_unit: preview.fallback_unit }, photos)}</span> : null}
          {result ? <span className="sac-line" role="status">{result}</span> : null}
        </div>
      ) : null}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
    </div>
  );
}
