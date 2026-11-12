import React from 'react';
import { splitVariables } from './templateListModel.js';
import './KakaoTemplatePreview.css';

// 알림톡 미리보기 말풍선. 카카오 로고·상표는 쓰지 않고 글자만 쓴다.
export default function KakaoTemplatePreview({ template }) {
  const t = template || {};
  const emphasized = t.emphasizeType === 'TEXT';
  const buttons = Array.isArray(t.buttons) ? t.buttons.filter((b) => b && b.name) : [];
  const parts = splitVariables(t.content);
  return (
    <div className="ktp-board">
      <div className="ktp-bubble">
        <div className="ktp-banner">알림톡 도착</div>
        {t.emphasizeType === 'IMAGE' && t.imageUrl ? <img className="ktp-image" src={t.imageUrl} alt="" /> : null}
        <div className="ktp-body">
          {t.targetName ? <div className="ktp-sender">{t.targetName}</div> : null}
          {emphasized && t.emphasizeSubtitle ? <div className="ktp-subtitle">{t.emphasizeSubtitle}</div> : null}
          {emphasized && t.emphasizeTitle ? <div className="ktp-title">{t.emphasizeTitle}</div> : null}
          <div className="ktp-content">
            {parts.length === 0
              ? <span className="ktp-empty">내용이 없습니다.</span>
              : parts.map((part, index) => (part.variable
                ? <mark key={index} className="ktp-var">{part.text}</mark>
                : <React.Fragment key={index}>{part.text}</React.Fragment>))}
          </div>
          {t.extra ? <div className="ktp-extra">{t.extra}</div> : null}
        </div>
        {buttons.length > 0 ? (
          <div className="ktp-buttons">
            {buttons.map((button, index) => (
              <div key={`${button.name}-${index}`} className="ktp-button">{button.name}</div>
            ))}
          </div>
        ) : null}
      </div>
      <p className="ktp-note">미리보기는 실제 단말기와 다를 수 있습니다</p>
    </div>
  );
}
