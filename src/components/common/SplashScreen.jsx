import { useState, useEffect } from 'react';
import '../../styles/transitions.css';

export default function SplashScreen() {
  const [visible, setVisible] = useState(true);
  const [hiding, setHiding] = useState(false);

  useEffect(() => {
    // Signal that the app is ready
    const timer = setTimeout(() => {
      setHiding(true);
      // Dispatch event for the HTML splash screen
      window.dispatchEvent(new Event('app-ready'));
      setTimeout(() => setVisible(false), 500);
    }, 800);

    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={`splash-screen ${hiding ? 'hiding' : ''}`}>
      <div className="splash-logo">HS</div>
      <div className="splash-title">한성쇼케이스</div>
      <div className="splash-subtitle">제작현황 관리 시스템</div>
      <div className="splash-loader" />
    </div>
  );
}
