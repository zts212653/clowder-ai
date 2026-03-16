'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ConsoleEntry } from './ConsolePanel';

/**
 * F120 Phase C: Listens for bridge script postMessage events (console + screenshot).
 * Extracted to reduce BrowserPanel cognitive complexity.
 */
export function usePreviewBridge(iframeRef: React.RefObject<HTMLIFrameElement | null>, gatewayPort?: number) {
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.source !== 'cat-cafe-bridge') return;
      // Validate message origin: must come from our iframe and gateway origin
      if (iframeRef.current && event.source !== iframeRef.current.contentWindow) return;
      // Validate origin: accept gateway origin (where iframe loads) on both localhost and 127.0.0.1,
      // and also accept the Hub origin (window.location.origin) since the bridge script
      // may post from either depending on how the gateway proxies.
      if (gatewayPort) {
        const validOrigins = [
          `http://localhost:${gatewayPort}`,
          `http://127.0.0.1:${gatewayPort}`,
          window.location.origin,
        ];
        if (!validOrigins.includes(event.origin)) return;
      }
      switch (event.data.type) {
        case 'screenshot-result':
          apiFetch('/api/preview/screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl: event.data.dataUrl }),
          })
            .then((r) => r.json() as Promise<{ url: string }>)
            .then((data) => {
              setScreenshotUrl(data.url);
              setTimeout(() => setScreenshotUrl(null), 5000);
            })
            .catch(() => {})
            .finally(() => setIsCapturing(false));
          break;
        case 'screenshot-error':
          setIsCapturing(false);
          break;
        case 'console':
          setConsoleEntries((prev) => {
            const next = [...prev, { level: event.data.level, args: event.data.args, timestamp: event.data.timestamp }];
            return next.length > 500 ? next.slice(-500) : next;
          });
          if (event.data.level === 'error') setConsoleOpen(true);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [iframeRef, gatewayPort]);

  const handleScreenshot = useCallback(() => {
    if (!iframeRef.current?.contentWindow || isCapturing) return;
    setIsCapturing(true);
    const targetOrigin = gatewayPort ? `http://localhost:${gatewayPort}` : '*';
    iframeRef.current.contentWindow.postMessage(
      { type: 'screenshot-request', source: 'cat-cafe-preview' },
      targetOrigin,
    );
  }, [isCapturing, iframeRef, gatewayPort]);

  const clearConsole = useCallback(() => setConsoleEntries([]), []);

  return { consoleEntries, consoleOpen, setConsoleOpen, isCapturing, screenshotUrl, handleScreenshot, clearConsole };
}
