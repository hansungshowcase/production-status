import { useState, useEffect, useRef, useCallback } from 'react';

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
        if (data.events && data.events.length > 0) {
          lastTimestampRef.current = data.timestamp;
          // Emit each event as a message
          for (const event of data.events.reverse()) {
            setLastMessage({
              type: event.action_type,
              data: event,
              timestamp: event.created_at,
            });
          }
        }
      } catch {
        if (active) setIsConnected(false);
      }
    };

    poll(); // Initial poll
    const interval = setInterval(poll, 5000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const send = useCallback(() => {}, []); // No-op for polling

  return { lastMessage, isConnected, send };
}
