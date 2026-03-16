import { useEffect, useState } from 'react';

export type HmrStatus = 'idle' | 'connected' | 'disconnected';

export function useHmrStatus(gatewayPort: number, targetPort: number): HmrStatus {
  const [status, setStatus] = useState<HmrStatus>('idle');

  useEffect(() => {
    if (!gatewayPort || !targetPort) return;
    setStatus('idle');

    const wsUrl = `ws://localhost:${gatewayPort}/?__preview_port=${targetPort}`;
    let ws: WebSocket | null = null;
    let closed = false;
    let hasEverConnected = false;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
          hasEverConnected = true;
          setStatus('connected');
        };
        ws.onclose = () => {
          // Only show "disconnected" if we previously had a connection.
          // Static servers (python http.server, npx serve, etc.) never
          // have a WebSocket endpoint — no point showing HMR status for them.
          if (hasEverConnected) {
            setStatus('disconnected');
            if (!closed) setTimeout(connect, 3000);
          }
          // else: stay 'idle' — server doesn't support HMR
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (hasEverConnected) setStatus('disconnected');
      }
    };
    connect();

    return () => {
      closed = true;
      ws?.close();
    };
  }, [gatewayPort, targetPort]);

  return status;
}
