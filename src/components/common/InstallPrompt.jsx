import React, { useState, useEffect } from 'react';
import './InstallPrompt.css';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [show, setShow] = useState(false);

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const [installMode, setInstallMode] = useState(isIos ? 'ios' : 'manual');

  useEffect(() => {
    if (isStandalone) return;

    setShow(true);

    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setInstallMode('native');
      setShow(true);
    };

    window.addEventListener('beforeinstallprompt', handler);

    const installedHandler = () => {
      setShow(false);
      setDeferredPrompt(null);
    };

    window.addEventListener('appinstalled', installedHandler);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      window.removeEventListener('appinstalled', installedHandler);
    };
  }, [isStandalone]);

  const handleInstall = async () => {
    if (!deferredPrompt) {
      setInstallMode(isIos ? 'ios' : 'manual');
      setShow(true);
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setShow(false);
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    setShow(false);
    setDeferredPrompt(null);
  };

  if (!show) return null;

  return (
    <div className="install-prompt">
      <div className="install-prompt__content">
        <div className="install-prompt__icon" aria-hidden="true">HS</div>
        <div className="install-prompt__info">
          <strong className="install-prompt__title">한성쇼케이스 앱 설치</strong>
          {installMode === 'ios' ? (
            <p className="install-prompt__desc">
              공유 버튼을 누른 후 <strong>홈 화면에 추가</strong>를 선택하면
              최신 버전 앱으로 바로 사용할 수 있습니다.
            </p>
          ) : installMode === 'manual' ? (
            <p className="install-prompt__desc">
              주소창의 설치 아이콘 또는 브라우저 메뉴의 <strong>앱 설치</strong>를 선택하세요.
              설치 앱은 실행할 때 최신 버전을 자동 확인합니다.
            </p>
          ) : (
            <p className="install-prompt__desc">
              앱을 설치하면 PC와 모바일에서 빠르게 열리고 최신 배포가 자동 반영됩니다.
            </p>
          )}
        </div>
        <div className="install-prompt__actions">
          <button className="install-prompt__btn install-prompt__btn--install" onClick={handleInstall}>
            {deferredPrompt ? '앱 설치' : '설치 방법'}
          </button>
          <button className="install-prompt__btn install-prompt__btn--dismiss" onClick={handleDismiss}>
            나중에
          </button>
        </div>
      </div>
    </div>
  );
}
