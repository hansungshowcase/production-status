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
          // Use the most recent event (last in array)
          const latest = data.events[data.events.length - 1];
          setLastMessage({
            type: latest.action_type,
            data: latest,
            timestamp: latest.created_at,
          });
        }
      } catch {
        if (active) setIsConnected(false);
      }
    };

    poll(); // Initial poll
    const interval = setInterval(poll, 15000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const send = useCallback(() => {}, []); // No-op for polling

  return { lastMessage, isConnected, send };
}
