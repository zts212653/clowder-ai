'use client';

import { forwardRef, useImperativeHandle, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CheckCircleIcon, SpinnerIcon } from './HubConfigIcons';

type SetupState = 'idle' | 'testing' | 'connected' | 'error';

interface WeComBotSetupPanelProps {
  configured: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

export interface WeComBotSetupPanelHandle {
  validate(): Promise<boolean>;
  hasPendingCredentials(): boolean;
}

/**
 * F132 Phase E: WeCom Bot guided setup panel.
 * Validates credentials via real WebSocket connection, then auto-activates the adapter.
 * Follows the same pattern as FeishuQrPanel / WeixinQrPanel.
 */
export const WeComBotSetupPanel = forwardRef<WeComBotSetupPanelHandle, WeComBotSetupPanelProps>(
  function WeComBotSetupPanel({ configured, onConnected, onDisconnected }, ref) {
    const [state, setState] = useState<SetupState>(configured ? 'connected' : 'idle');
    const [botId, setBotId] = useState('');
    const [secret, setSecret] = useState('');
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [disconnecting, setDisconnecting] = useState(false);

    const handleValidate = async (): Promise<boolean> => {
      if (!botId.trim() || !secret.trim()) {
        setErrorMsg('Please enter both Bot ID and Bot Secret');
        setState('error');
        return false;
      }

      setState('testing');
      setErrorMsg(null);

      try {
        const res = await apiFetch('/api/connector/wecom-bot/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ botId: botId.trim(), secret: secret.trim() }),
        });

        const data = await res.json();

        if (res.ok && data.valid) {
          setState('connected');
          setBotId('');
          setSecret('');
          setErrorMsg(null);
          onConnected?.();
          return true;
        }
        setState('error');
        setErrorMsg(data.error ?? 'Validation failed');
        return false;
      } catch {
        setState('error');
        setErrorMsg('Network error');
        return false;
      }
    };

    useImperativeHandle(ref, () => ({
      validate: handleValidate,
      hasPendingCredentials: () => !!(botId.trim() && secret.trim()),
    }));

    const handleDisconnect = async () => {
      setDisconnecting(true);
      try {
        const res = await apiFetch('/api/connector/wecom-bot/disconnect', { method: 'POST' });
        if (res.ok) {
          setState('idle');
          setErrorMsg(null);
          onDisconnected?.();
        }
      } catch {
        // button stays enabled for retry
      } finally {
        setDisconnecting(false);
      }
    };

    if (state === 'connected' || (configured && state !== 'error' && state !== 'testing')) {
      return (
        <div className="space-y-2" data-testid="wecom-bot-connected">
          <div className="flex items-center gap-2 rounded-[20px] border border-conn-emerald-ring bg-conn-emerald-bg px-3 py-2.5">
            <span className="text-conn-emerald-text">
              <CheckCircleIcon />
            </span>
            <span className="text-sm font-medium text-conn-emerald-text">WeCom Bot connected</span>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={disconnecting}
              className="ml-auto text-xs font-medium text-conn-red-text hover:text-conn-red-text transition-colors disabled:opacity-50"
              data-testid="wecom-bot-disconnect"
            >
              {disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-cafe-tertiary">
            WebSocket long-connection active. Messages from WeCom will be routed to Cat Cafe.
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-3" data-testid="wecom-bot-setup-panel">
        <div className="space-y-2.5">
          <div>
            <label htmlFor="wecom-bot-id" className="block text-xs font-medium text-cafe-secondary mb-1">
              Bot ID
            </label>
            <input
              id="wecom-bot-id"
              type="text"
              placeholder="e.g. xianxian_bot"
              value={botId}
              onChange={(e) => setBotId(e.target.value)}
              className="w-full h-9 px-3 text-[13px] bg-cafe-surface-elevated border border-[var(--console-border-soft)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-cafe-accent)]/30 focus:border-[var(--color-cafe-accent)] transition-colors"
              data-testid="wecom-bot-id-input"
            />
          </div>
          <div>
            <label htmlFor="wecom-bot-secret" className="block text-xs font-medium text-cafe-secondary mb-1">
              Bot Secret
            </label>
            <input
              id="wecom-bot-secret"
              type="password"
              placeholder="Paste secret here"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="w-full h-9 px-3 text-[13px] bg-cafe-surface-elevated border border-[var(--console-border-soft)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-cafe-accent)]/30 focus:border-[var(--color-cafe-accent)] transition-colors"
              data-testid="wecom-bot-secret-input"
            />
          </div>
        </div>

        {errorMsg && (
          <p
            className="text-xs text-conn-red-text bg-conn-red-bg rounded-[20px] px-3 py-2 border border-conn-red-ring"
            data-testid="wecom-bot-error"
          >
            {errorMsg}
          </p>
        )}

        {state === 'testing' && (
          <div className="flex items-center gap-2 text-sm text-cafe-secondary">
            <SpinnerIcon />
            <span>Testing WebSocket connection...</span>
          </div>
        )}
      </div>
    );
  },
);
