import React, { useEffect, useRef } from 'react';
import './Modal.css';

export default function Modal({ visible, children, onClose }) {
  const boxRef = useRef(null);
  const touchStartY = useRef(0);
  const currentTranslateY = useRef(0);

  useEffect(() => {
    if (!visible) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose && onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible, onClose]);

  const handleTouchStart = (e) => {
    touchStartY.current = e.touches[0].clientY;
    currentTranslateY.current = 0;
    if (boxRef.current) {
      boxRef.current.style.transition = 'none';
    }
  };

  const handleTouchMove = (e) => {
    const deltaY = e.touches[0].clientY - touchStartY.current;
    if (deltaY > 0) {
      currentTranslateY.current = deltaY;
      if (boxRef.current) {
        boxRef.current.style.transform = `translateY(${deltaY}px)`;
      }
    }
  };

  const handleTouchEnd = () => {
    if (!boxRef.current) return;
    boxRef.current.style.transition = 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)';
    if (currentTranslateY.current > 100) {
      boxRef.current.style.transform = 'translateY(100%)';
      setTimeout(() => onClose && onClose(), 200);
    } else {
      boxRef.current.style.transform = 'translateY(0)';
    }
  };

  if (!visible) return null;

  return (
    <div className="modal-overlay show" onClick={onClose} role="dialog" aria-modal="true">
      <div
        ref={boxRef}
        className="modal-box"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
