import React, { useState, useEffect } from 'react';
import './InstallPrompt.css';

const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed';
const INSTALL_DONE_KEY = 'pwa_installed';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    // 이미 설치했거나 거절한 사용자는 안 보여줌
    if (localStorage.getItem(INSTALL_DONE_KEY)) return;
    if (localStorage.getItem(INSTALL_DISMISSED_KEY)) return;

    // 이미 PWA로 실행 중이면 안 보여줌
    if (window.matchMedia('(display-mode: standalone)').matches) {
      localStorage.setItem(INSTALL_DONE_KEY, '1');
      return;
    }

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShow(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    // 설치 완료 감지
    window.addEventListener('appinstalled', () => {
      localStorage.setItem(INSTALL_DONE_KEY, '1');
      setShow(false);
      setDeferredPrompt(null);
    });

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      localStorage.setItem(INSTALL_DONE_KEY, '1');
    }
    setShow(false);
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1');
    setShow(false);
    setDeferredPrompt(null);
  };

  if (!show) return null;

  return (
    <div className="install-prompt">
      <div className="install-prompt__content">
        <div className="install-prompt__icon">📲</div>
        <div className="install-prompt__info">
          <strong className="install-prompt__title">바로가기를 만드시겠습니까?</strong>
          <p className="install-prompt__desc">
            홈 화면에 추가하면 앱처럼 바로 사용할 수 있습니다.
          </p>
        </div>
        <div className="install-prompt__actions">
          <button className="install-prompt__btn install-prompt__btn--install" onClick={handleInstall}>
            추가하기
          </button>
          <button className="install-prompt__btn install-prompt__btn--dismiss" onClick={handleDismiss}>
            괜찮습니다
          </button>
        </div>
      </div>
    </div>
  );
}
