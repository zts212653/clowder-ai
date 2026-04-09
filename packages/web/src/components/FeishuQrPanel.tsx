'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CheckCircleIcon, QrCodeIcon, SpinnerIcon } from './HubConfigIcons';

type QrState = 'idle' | 'fetching' | 'waiting' | 'confirmed' | 'error' | 'expired' | 'denied';

interface FeishuQrPanelProps {
  configured: boolean;
  onConfirmed?: () => void;
  onDisconnected?: () => void;
}

function statusMessage(status: QrState, errorMsg: string | null) {
  if (status === 'expired') return 'QR code expired. Please generate a new one.';
  if (status === 'denied') return 'Authorization denied. Please retry and confirm in Feishu.';
  if (status === 'error') return errorMsg ?? 'Failed to fetch QR code';
  return null;
}

export function FeishuQrPanel({ configured, onConfirmed, onDisconnected }: FeishuQrPanelProps) {
  const [qrState, setQrState] = useState<QrState>(configured ? 'confirmed' : 'idle');
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalRef = useRef(false);
  const requestSeqRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    terminalRef.current = configured;
    setQrState(configured ? 'confirmed' : 'idle');
    if (configured) {
      stopPolling();
      setQrUrl(null);
      setErrorMsg(null);
    }
  }, [configured, stopPolling]);
  useEffect(() => () => stopPolling(), [stopPolling]);

  const schedulePoll = useCallback(
    (payload: string, intervalMs: number) => {
      stopPolling();
      terminalRef.current = false;

      const poll = async () => {
        if (terminalRef.current) return;

        const requestId = ++requestSeqRef.current;
        try {
          const res = await apiFetch(`/api/connector/feishu/qrcode-status?qrPayload=${encodeURIComponent(payload)}`);
          if (!res.ok) {
            pollRef.current = setTimeout(poll, intervalMs);
            return;
          }
          const data = await res.json();
          if (terminalRef.current || requestId !== requestSeqRef.current) return;

          if (data.status === 'waiting') {
            pollRef.current = setTimeout(poll, intervalMs);
            return;
          }

          stopPolling();
          terminalRef.current = true;

          if (data.status === 'confirmed' || data.status === 'expired' || data.status === 'denied') {
            setQrState(data.status);
            setQrUrl(null);
            if (data.status === 'confirmed') {
              setErrorMsg(null);
              onConfirmed?.();
            }
            return;
          }
          setQrState('error');
          setErrorMsg('Unexpected QR status');
          setQrUrl(null);
        } catch {
          if (terminalRef.current || requestId !== requestSeqRef.current) return;
          pollRef.current = setTimeout(poll, intervalMs);
        }
      };

      poll();
    },
    [onConfirmed, stopPolling],
  );

  const handleFetchQr = async () => {
    stopPolling();
    terminalRef.current = false;
    setQrState('fetching');
    setErrorMsg(null);

    try {
      const res = await apiFetch('/api/connector/feishu/qrcode', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setQrState('error');
        setErrorMsg(data.error ?? 'Failed to fetch QR code');
        return;
      }

      const data = await res.json();
      setQrUrl(data.qrUrl);
      setQrState('waiting');
      schedulePoll(data.qrPayload, data.intervalMs ?? 2500);
    } catch {
      setQrState('error');
      setErrorMsg('Network error');
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await apiFetch('/api/connector/feishu/disconnect', { method: 'POST' });
      if (res.ok) {
        setQrState('idle');
        onDisconnected?.();
      }
    } catch {
      // button stays enabled for retry
    } finally {
      setDisconnecting(false);
    }
  };

  if (qrState === 'confirmed') {
    return (
      <div className="space-y-2" data-testid="feishu-connected">
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-3 py-2.5">
          <span className="text-green-600">
            <CheckCircleIcon />
          </span>
          <span className="text-sm font-medium text-green-700">Feishu connected</span>
          <button
            type="button"
            onClick={handleDisconnect}
            disabled={disconnecting}
            className="ml-auto text-xs font-medium text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
            data-testid="feishu-disconnect"
          >
            {disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
        <p className="text-xs leading-relaxed text-cafe-tertiary">
          扫码绑定已完成。后续如需切换凭证，仍可继续通过下方表单手动覆盖。
        </p>
      </div>
    );
  }

  const message = statusMessage(qrState, errorMsg);

  return (
    <div className="space-y-3" data-testid="feishu-qr-panel">
      {(qrState === 'idle' || qrState === 'expired' || qrState === 'error' || qrState === 'denied') && (
        <div className="space-y-2">
          {message && <p className="text-xs text-cafe-secondary">{message}</p>}
          <button
            type="button"
            onClick={handleFetchQr}
            className="flex items-center gap-1.5 rounded-lg bg-[#3370FF] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#295ad6]"
            data-testid="feishu-generate-qr"
          >
            <QrCodeIcon />
            {qrState === 'idle' ? 'Generate QR Code' : 'Regenerate QR Code'}
          </button>
        </div>
      )}

      {qrState === 'fetching' && (
        <div className="flex items-center gap-2 text-sm text-cafe-secondary">
          <SpinnerIcon />
          <span>Generating QR code...</span>
        </div>
      )}

      {qrState === 'waiting' && qrUrl && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-cafe bg-cafe-surface-elevated p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrUrl} alt="Feishu QR code" className="h-48 w-48 rounded-lg" data-testid="feishu-qr-image" />
          <div className="flex items-center gap-2 text-xs text-cafe-secondary">
            <SpinnerIcon />
            <span>Scan the QR code in Feishu and confirm authorization.</span>
          </div>
        </div>
      )}
    </div>
  );
}
