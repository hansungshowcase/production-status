import { useState, useEffect, useRef, useCallback } from 'react';
import { toRealtimeMessage } from './realtimeEvents';

export default function useWebSocket() {
  const [lastMessage, setLastMessage] = useState(null);
  const [isConnected, setIsConnected] = useState(true);
  const lastTimestampRef = useRef(new Date().toISOString());

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch(`/api/events?since=${encodeURIComponent(lastTimestampRef.current)}`);
        if (!res.ok) throw new Error('Poll failed');
        const data = await res.json();
        if (!active) return;

        setIsConnected(true);
        const message = toRealtimeMessage(data);
        if (message) {
          lastTimestampRef.current = data.timestamp;
          setLastMessage(message);
        }
      } catch {
        if (active) setIsConnected(false);
      }
    };

    poll(); // Initial poll
    const interval = setInterval(poll, 300000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const send = useCallback(() => {}, []); // No-op for polling

  return { lastMessage, isConnected, send };
}
