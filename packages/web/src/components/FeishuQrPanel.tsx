'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CheckCircleIcon, QrCodeIcon, SpinnerIcon } from './HubConfigIcons';

type QrState = 'idle' | 'fetching' | 'waiting' | 'confirmed' | 'error' | 'expired' | 'denied';

const DEFAULT_POLL_INTERVAL_MS = 2500;
const DEFAULT_EXPIRE_MS = 10 * 60_000;

interface FeishuQrPanelProps {
  configured: boolean;
  onConfirmed?: () => void;
}

export function FeishuQrPanel({ configured, onConfirmed }: FeishuQrPanelProps) {
  const [qrState, setQrState] = useState<QrState>(configured ? 'confirmed' : 'idle');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expireRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (expireRef.current) {
      clearTimeout(expireRef.current);
      expireRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback(
    (payload: string, intervalMs: number, expireMs: number) => {
      stopPolling();

      const poll = async () => {
        try {
          const res = await apiFetch(`/api/connector/feishu/qrcode-status?qrPayload=${encodeURIComponent(payload)}`);
          if (!res.ok) return;
          const data = await res.json();

          if (data.status === 'confirmed') {
            stopPolling();
            setQrState('confirmed');
            setQrUrl(null);
            onConfirmed?.();
          } else if (data.status === 'expired') {
            stopPolling();
            setQrState('expired');
            setQrUrl(null);
          } else if (data.status === 'denied') {
            stopPolling();
            setQrState('denied');
            setQrUrl(null);
          } else if (data.status === 'error') {
            stopPolling();
            setQrState('error');
            setQrUrl(null);
            setErrorMsg(data.error ?? 'Failed to complete QR binding');
          } else {
            setQrState('waiting');
          }
        } catch {
          /* network hiccup — keep polling */
        }
      };

      pollRef.current = setInterval(poll, intervalMs);
      poll();

      expireRef.current = setTimeout(() => {
        stopPolling();
        setQrState('expired');
        setQrUrl(null);
      }, expireMs);
    },
    [onConfirmed, stopPolling],
  );

  const handleFetchQr = async () => {
    setQrState('fetching');
    setErrorMsg(null);

    try {
      const res = await apiFetch('/api/connector/feishu/qrcode', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setQrState('error');
        setErrorMsg(data.error ?? 'Failed to fetch Feishu QR code');
        return;
      }

      const data = await res.json();
      const interval = typeof data.interval === 'number' && data.interval > 0 ? data.interval * 1000 : 2500;
      const expiresIn = typeof data.expiresIn === 'number' && data.expiresIn > 0 ? data.expiresIn * 1000 : 600_000;
      setQrUrl(data.qrUrl ?? null);
      setQrState('waiting');
      startPolling(data.qrPayload, interval || DEFAULT_POLL_INTERVAL_MS, expiresIn || DEFAULT_EXPIRE_MS);
    } catch {
      setQrState('error');
      setErrorMsg('Network error');
    }
  };

  if (qrState === 'confirmed') {
    return (
      <div
        className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5"
        data-testid="feishu-connected"
      >
        <span className="text-green-600">
          <CheckCircleIcon />
        </span>
        <span className="text-sm font-medium text-green-700">Feishu bot bound (restart API to take effect)</span>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="feishu-qr-panel">
      {(qrState === 'idle' || qrState === 'expired' || qrState === 'error' || qrState === 'denied') && (
        <div className="space-y-2">
          {qrState === 'expired' && (
            <p className="text-xs text-amber-600">QR code expired. Please generate a new one.</p>
          )}
          {qrState === 'denied' && <p className="text-xs text-amber-600">Authorization denied. Please try again.</p>}
          {qrState === 'error' && errorMsg && <p className="text-xs text-red-600">{errorMsg}</p>}
          <button
            type="button"
            onClick={handleFetchQr}
            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold text-white rounded-lg transition-colors bg-[#3370FF] hover:bg-[#255CE0]"
            data-testid="feishu-generate-qr"
          >
            <QrCodeIcon />
            {qrState === 'expired' || qrState === 'denied' ? 'Regenerate QR Code' : 'Generate QR Code'}
          </button>
        </div>
      )}

      {qrState === 'fetching' && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <SpinnerIcon />
          <span>Generating QR code...</span>
        </div>
      )}

      {qrState === 'waiting' && qrUrl && (
        <div className="flex flex-col items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl p-4">
          <img
            src={qrUrl}
            alt="Feishu bot binding QR code"
            className="w-48 h-48 rounded-lg"
            data-testid="feishu-qr-image"
          />
          <div className="flex items-center gap-2 text-gray-500 text-xs">
            <SpinnerIcon />
            <span>Scan the QR code with Feishu</span>
          </div>
        </div>
      )}
    </div>
  );
}
