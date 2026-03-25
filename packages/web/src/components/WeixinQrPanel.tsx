'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CheckCircleIcon, QrCodeIcon, SpinnerIcon } from './HubConfigIcons';

type QrState = 'idle' | 'fetching' | 'waiting' | 'scanned' | 'confirmed' | 'error' | 'expired';

const QR_POLL_INTERVAL_MS = 2500;
const QR_EXPIRE_MS = 60_000;

export function WeixinQrPanel({ configured }: { configured: boolean }) {
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
    (payload: string) => {
      stopPolling();

      const poll = async () => {
        try {
          const res = await apiFetch(`/api/connector/weixin/qrcode-status?qrPayload=${encodeURIComponent(payload)}`);
          if (!res.ok) return;
          const data = await res.json();

          if (data.status === 'scanned') {
            setQrState('scanned');
          } else if (data.status === 'confirmed') {
            stopPolling();
            setQrState('confirmed');
            setQrUrl(null);
          } else if (data.status === 'expired') {
            stopPolling();
            setQrState('expired');
            setQrUrl(null);
          }
        } catch {
          /* network hiccup — keep polling */
        }
      };

      pollRef.current = setInterval(poll, QR_POLL_INTERVAL_MS);
      poll();

      expireRef.current = setTimeout(() => {
        stopPolling();
        setQrState('expired');
        setQrUrl(null);
      }, QR_EXPIRE_MS);
    },
    [stopPolling],
  );

  const handleFetchQr = async () => {
    setQrState('fetching');
    setErrorMsg(null);
    try {
      const res = await apiFetch('/api/connector/weixin/qrcode', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setQrState('error');
        setErrorMsg(data.error ?? 'Failed to fetch QR code');
        return;
      }
      const data = await res.json();
      setQrUrl(data.qrUrl);
      setQrState('waiting');
      startPolling(data.qrPayload);
    } catch {
      setQrState('error');
      setErrorMsg('Network error');
    }
  };

  if (qrState === 'confirmed') {
    return (
      <div
        className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2.5"
        data-testid="weixin-connected"
      >
        <span className="text-green-600">
          <CheckCircleIcon />
        </span>
        <span className="text-sm font-medium text-green-700">WeChat connected</span>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="weixin-qr-panel">
      {(qrState === 'idle' || qrState === 'expired' || qrState === 'error') && (
        <div className="space-y-2">
          {qrState === 'expired' && (
            <p className="text-xs text-amber-600">QR code expired. Please generate a new one.</p>
          )}
          {qrState === 'error' && errorMsg && <p className="text-xs text-red-600">{errorMsg}</p>}
          <button
            type="button"
            onClick={handleFetchQr}
            className="flex items-center gap-1.5 px-4 py-2 text-[13px] font-semibold text-white rounded-lg transition-colors"
            style={{ backgroundColor: '#07C160' }}
            data-testid="weixin-generate-qr"
          >
            <QrCodeIcon />
            {qrState === 'expired' ? 'Regenerate QR Code' : 'Generate QR Code'}
          </button>
        </div>
      )}

      {qrState === 'fetching' && (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <SpinnerIcon />
          <span>Generating QR code...</span>
        </div>
      )}

      {(qrState === 'waiting' || qrState === 'scanned') && qrUrl && (
        <div className="flex flex-col items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl p-4">
          <img src={qrUrl} alt="WeChat login QR code" className="w-48 h-48 rounded-lg" data-testid="weixin-qr-image" />
          {qrState === 'waiting' && (
            <div className="flex items-center gap-2 text-gray-500 text-xs">
              <SpinnerIcon />
              <span>Scan the QR code with WeChat</span>
            </div>
          )}
          {qrState === 'scanned' && (
            <div className="flex items-center gap-2 text-green-600 text-xs font-medium">
              <SpinnerIcon />
              <span>Scanned! Confirm on your phone...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
