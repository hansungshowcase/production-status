import { useCallback, useEffect, useId, useRef, useState } from 'react';
import './AdminUnlockDialog.css';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], select:not([disabled]), textarea:not([disabled])';

// 관리자 비밀번호 잠금 해제 대화상자. 비밀번호는 이 컴포넌트의 state 에만 잠깐 있고 닫히면 비운다.
// 맞는지는 verify(password) → Promise<boolean>, 맞으면 onUnlocked(password) 를 부르고 닫는다.
export default function AdminUnlockDialog({ open, onClose, verify, onUnlocked }) {
  const titleId = useId();
  const errorId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  const aliveRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 열릴 때: 이전 초점 기억 + 입력 칸 초점. 닫힐 때: 비밀번호·오류 비우고 이전 초점 복귀.
  useEffect(() => {
    if (!open) return undefined;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(timer);
      setPassword('');
      setError('');
      setBusy(false);
      busyRef.current = false;
      const back = returnFocusRef.current;
      returnFocusRef.current = null;
      if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    };
  }, [open]);

  const close = useCallback(() => {
    if (busyRef.current) return;
    onClose?.();
  }, [onClose]);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function submit(event) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!password) { setError('비밀번호를 입력하세요.'); inputRef.current?.focus(); return; }
    busyRef.current = true;
    setBusy(true);
    setError('');
    const typed = password;
    try {
      const ok = await verify(typed);
      if (!aliveRef.current) return;
      if (ok) {
        busyRef.current = false;
        setBusy(false);
        setPassword('');
        onUnlocked?.(typed);
        onClose?.();
        return;
      }
      setError('비밀번호가 맞지 않습니다.');
      setPassword('');
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err?.message || '확인하지 못했습니다. 잠시 뒤 다시 시도하세요.');
    }
    busyRef.current = false;
    setBusy(false);
    inputRef.current?.focus();
  }

  if (!open) return null;

  return (
    <div className="smsc-unlock-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div
        className="smsc-unlock"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <form onSubmit={submit} noValidate>
          <h3 id={titleId} className="smsc-unlock__title">관리자 잠금 해제</h3>
          <p className="smsc-unlock__desc">템플릿 등록·수정·삭제는 관리자 비밀번호가 필요합니다. 새로고침하거나 탭을 닫으면 다시 잠깁니다.</p>
          <label className="smsc-unlock__label" htmlFor={`${titleId}-pw`}>관리자 비밀번호</label>
          <input
            id={`${titleId}-pw`}
            ref={inputRef}
            className="smsc-unlock__input"
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={event => { setPassword(event.target.value); if (error) setError(''); }}
          />
          <p id={errorId} className="smsc-unlock__error" role="alert">{error}</p>
          <div className="smsc-unlock__actions">
            <button type="button" className="smsc-unlock__btn" onClick={close} disabled={busy}>취소</button>
            <button type="submit" className="smsc-unlock__btn smsc-unlock__btn--primary" disabled={busy}>
              {busy ? '확인 중…' : '잠금 해제'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
