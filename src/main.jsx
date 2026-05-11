import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';

// SW가 캐시 versioning 알아서 관리. 매 부팅 강제 삭제는 모바일 데이터/배터리 폭주라 제거.
// 새 버전 배포 시 SW update가 캐시 갱신 트리거.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.update());
  });
}

// Hide HTML splash screen as soon as JS loads
const splash = document.getElementById('splash');
if (splash) {
  splash.classList.add('hide');
  setTimeout(() => splash.remove(), 600);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
