import React, { useState, useEffect, useCallback } from 'react';
import './RealtimeToast.css';

const EVENT_LABELS = {
  PROCESS_STARTED: '공정 시작',
  PROCESS_COMPLETED: '공정 완료',
  ISSUE_REPORTED: '이슈 보고',
  ORDER_CREATED: '주문 등록',
  PHOTO_UPLOADED: '사진 등록',
};

function formatEventMessage(event) {
  const label = EVENT_LABELS[event.type] || event.type;
  const orderNumber = event.order_number || event.orderNumber || '';
  const detail = event.step_name || event.stepName || '';
  const parts = [orderNumber, detail, label].filter(Boolean);
  return parts.join(' ');
}

export default function RealtimeToast({ event }) {
  const [toasts, setToasts] = useState([]);

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    if (!event) return;
    const id = Date.now() + Math.random();
    const message = formatEventMessage(event);
    setToasts((prev) => [...prev.slice(-4), { id, message, type: event.type }]);

    const timer = setTimeout(() => removeToast(id), 4000);
    return () => clearTimeout(timer);
  }, [event, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="realtime-toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`realtime-toast realtime-toast--${t.type === 'ISSUE_REPORTED' ? 'warn' : 'info'}`}
        >
          <span className="realtime-toast-icon">
            {t.type === 'PROCESS_COMPLETED' ? '\u2705' :
             t.type === 'PROCESS_STARTED' ? '\u25B6\uFE0F' :
             t.type === 'ISSUE_REPORTED' ? '\u26A0\uFE0F' : '\uD83D\uDCE1'}
          </span>
          <span className="realtime-toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
