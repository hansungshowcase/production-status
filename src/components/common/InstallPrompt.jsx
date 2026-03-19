import React, { useState, useEffect } from 'react';
import './InstallPrompt.css';

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    if (result.outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    setDeferredPrompt(null);
  };

  if (!deferredPrompt || dismissed) return null;

  return (
    <div className="install-prompt">
      <div className="install-prompt__content">
        <div className="install-prompt__info">
          <strong className="install-prompt__title">앱 설치</strong>
          <p className="install-prompt__desc">
            홈 화면에 추가하면 더 빠르게 접근할 수 있습니다.
          </p>
        </div>
        <div className="install-prompt__actions">
          <button className="install-prompt__btn install-prompt__btn--install" onClick={handleInstall}>
            설치
          </button>
          <button className="install-prompt__btn install-prompt__btn--dismiss" onClick={handleDismiss}>
            나중에
          </button>
        </div>
      </div>
    </div>
  );
}
