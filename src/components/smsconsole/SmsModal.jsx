import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './SmsModal.css';

// 팝업 아래 고정 줄. 폼의 버튼 줄을 ModalFoot 로 감싸면 팝업 안에서는 아래 줄로 옮겨 그려진다(팝업 밖이면 제자리).
const FootContext = createContext(undefined);

export function ModalFoot({ children }) {
  const foot = useContext(FootContext);
  if (foot === undefined) return children;
  return foot ? createPortal(children, foot) : null;
}

// 템플릿 등록·수정 팝업 껍데기: 머리(제목·X) / 본문(스크롤) / 아래 고정 줄. 배경 클릭으로는 닫지 않는다.
export default function SmsModal({ title, onClose, children }) {
  const titleId = useId();
  const bodyRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [foot, setFoot] = useState(null);
  useEffect(() => {
    const back = document.activeElement;
    bodyRef.current?.querySelector('input:not([type="hidden"]):not([hidden]), textarea, select')?.focus();
    const onKey = event => { if (event.key === 'Escape') closeRef.current?.(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (back && back.isConnected) back.focus();
    };
  }, []);
  return (
    <div className="smsm-wrap">
      <div className="smsm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="smsm-head">
          <h2 id={titleId} className="smsm-title">{title}</h2>
          <button type="button" className="ktm-btn smsm-x" aria-label="닫기" onClick={() => closeRef.current?.()}>×</button>
        </header>
        <div className="smsm-body" ref={bodyRef}>
          <FootContext.Provider value={foot}>{children}</FootContext.Provider>
        </div>
        <div className="smsm-foot" ref={setFoot} />
      </div>
    </div>
  );
}
