import React, { useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './BottomNav.css';

const workerNavItems = [
  { icon: '📋', label: '작업현황' },
  { icon: '🏠', label: '홈', action: 'home' },
];

const salesNavItems = [
  { icon: '📦', label: '주문추적' },
  { icon: '📊', label: '통계' },
  { icon: '🏠', label: '홈', action: 'home' },
];

export default function BottomNav({ activeIndex = 0, onSelect, mode = 'worker' }) {
  const navigate = useNavigate();
  const navItems = mode === 'sales' ? salesNavItems : workerNavItems;
  const navRef = useRef(null);
  const [indicatorStyle, setIndicatorStyle] = useState({});

  useEffect(() => {
    if (!navRef.current) return;
    const buttons = navRef.current.querySelectorAll('.nav-item');
    const activeBtn = buttons[activeIndex];
    if (activeBtn) {
      const navRect = navRef.current.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      setIndicatorStyle({
        left: btnRect.left - navRect.left + btnRect.width / 2 - 16,
        width: 32,
      });
    }
  }, [activeIndex, navItems.length]);

  const handleSelect = (idx) => {
    // Haptic feedback
    if ('vibrate' in navigator) navigator.vibrate(5);

    const item = navItems[idx];
    if (item.action === 'home') {
      navigate('/');
      return;
    }
    onSelect && onSelect(idx);
  };

  return (
    <nav className="bottom-nav" ref={navRef} role="navigation" aria-label="하단 네비게이션">
      <div className="nav-indicator" style={{
        transform: `translateX(${indicatorStyle.left || 0}px)`,
        width: `${indicatorStyle.width || 32}px`,
      }} />
      {navItems.map((item, idx) => (
        <button
          key={idx}
          className={`nav-item ${idx === activeIndex ? 'active' : ''}`}
          onClick={() => handleSelect(idx)}
          aria-label={item.label}
        >
          <span className={`nav-icon ${idx === activeIndex ? 'nav-icon-active' : ''}`}>
            {item.icon}
          </span>
          <span className="nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
