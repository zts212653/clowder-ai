'use client';

import { type PreviewVisiblePageAttestation, previewVisiblePageAttestationSchema } from '@cat-cafe/shared';
import { useCallback, useEffect, useState } from 'react';
import type { PreviewVisiblePageAdmissionRequest } from '@/lib/preview-visible-page-admission-controller';
import { apiFetch } from '@/utils/api-client';
import type { ConsoleEntry } from './ConsolePanel';
import { getPreviewBridgeOrigin, isValidBridgeOrigin } from './preview-bridge-origin';

function persistBridgeScreenshot(
  dataUrl: unknown,
  setScreenshotUrl: (url: string | null) => void,
  setIsCapturing: (capturing: boolean) => void,
): void {
  apiFetch('/api/preview/screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  })
    .then((response) => response.json() as Promise<{ url: string }>)
    .then((data) => {
      setScreenshotUrl(data.url);
      setTimeout(() => setScreenshotUrl(null), 5000);
    })
    .catch(() => {})
    .finally(() => setIsCapturing(false));
}

function appendBridgeConsoleEntry(
  data: { level: ConsoleEntry['level']; args: string[]; timestamp: number },
  setConsoleEntries: React.Dispatch<React.SetStateAction<ConsoleEntry[]>>,
  setConsoleOpen: (open: boolean) => void,
): void {
  setConsoleEntries((previous) => {
    const next = [...previous, { level: data.level, args: data.args, timestamp: data.timestamp }];
    return next.length > 500 ? next.slice(-500) : next;
  });
  if (data.level === 'error') setConsoleOpen(true);
}

function isAuthorizedBridgeMessage(
  event: MessageEvent,
  iframe: HTMLIFrameElement | null,
  gatewayPort: number,
  targetPort: number,
): boolean {
  return (
    event.data?.source === 'cat-cafe-bridge' &&
    iframe !== null &&
    event.source === iframe.contentWindow &&
    isValidBridgeOrigin(event.origin, gatewayPort, targetPort, window.location.origin)
  );
}

/**
 * F120 Phase C: Listens for bridge script postMessage events (console + screenshot).
 * Extracted to reduce BrowserPanel cognitive complexity.
 */
export function usePreviewBridge(
  iframeRef: React.RefObject<HTMLIFrameElement | null>,
  gatewayPort = 0,
  targetPort = 0,
  onVisiblePageAttestation?: (attestation: PreviewVisiblePageAttestation) => void,
) {
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!isAuthorizedBridgeMessage(event, iframeRef.current, gatewayPort, targetPort)) return;
      switch (event.data.type) {
        case 'visible-page-attestation': {
          const parsed = previewVisiblePageAttestationSchema.safeParse(event.data.attestation);
          if (parsed.success) onVisiblePageAttestation?.(parsed.data);
          break;
        }
        case 'screenshot-result':
          persistBridgeScreenshot(event.data.dataUrl, setScreenshotUrl, setIsCapturing);
          break;
        case 'screenshot-error':
          setIsCapturing(false);
          break;
        case 'console':
          appendBridgeConsoleEntry(event.data, setConsoleEntries, setConsoleOpen);
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [iframeRef, gatewayPort, onVisiblePageAttestation, targetPort]);

  const handleScreenshot = useCallback(() => {
    if (!iframeRef.current?.contentWindow || isCapturing) return;
    setIsCapturing(true);
    const targetOrigin = getPreviewBridgeOrigin(gatewayPort, targetPort) ?? '*';
    iframeRef.current.contentWindow.postMessage(
      { type: 'screenshot-request', source: 'cat-cafe-preview' },
      targetOrigin,
    );
  }, [isCapturing, iframeRef, gatewayPort, targetPort]);

  const clearConsole = useCallback(() => setConsoleEntries([]), []);

  const requestVisiblePageAttestation = useCallback(
    (request: PreviewVisiblePageAdmissionRequest): boolean => {
      const targetOrigin = getPreviewBridgeOrigin(gatewayPort, targetPort);
      if (
        !iframeRef.current?.contentWindow ||
        !targetOrigin ||
        request.port !== targetPort ||
        request.targetOrigin !== targetOrigin
      ) {
        return false;
      }
      iframeRef.current.contentWindow.postMessage(
        {
          type: 'visible-page-admission-request',
          source: 'cat-cafe-preview',
          eventId: request.eventId,
          targetPort: request.port,
          admission: request.admission,
        },
        targetOrigin,
      );
      return true;
    },
    [gatewayPort, iframeRef, targetPort],
  );

  return {
    consoleEntries,
    consoleOpen,
    setConsoleOpen,
    isCapturing,
    screenshotUrl,
    handleScreenshot,
    clearConsole,
    requestVisiblePageAttestation,
  };
}
