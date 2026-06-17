'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CheckCircleIcon, SpinnerIcon, WifiIcon } from './HubConfigIcons';

type SetupState = 'idle' | 'testing' | 'connected' | 'error';

interface WeComBotSetupPanelProps {
  configured: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
}

/**
 * F132 Phase E: WeCom Bot guided setup panel.
 * Validates credentials via real WebSocket connection, then auto-activates the adapter.
 * Follows the same pattern as FeishuQrPanel / WeixinQrPanel.
 */
export function WeComBotSetupPanel({ configured, onConnected, onDisconnected }: WeComBotSetupPanelProps) {
  const [state, setState] = useState<SetupState>(configured ? 'connected' : 'idle');
  const [botId, setBotId] = useState('');
  const [secret, setSecret] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleValidate = async () => {
    if (!botId.trim() || !secret.trim()) {
      setErrorMsg('Please enter both Bot ID and Bot Secret');
      setState('error');
      return;
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
      } else {
        setState('error');
        setErrorMsg(data.error ?? 'Validation failed');
      }
    } catch {
      setState('error');
      setErrorMsg('Network error');
    }
  };

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
        <div className="flex items-center gap-2 rounded-lg border border-conn-green-ring bg-conn-green-bg px-3 py-2.5">
          <span className="text-conn-green-text">
            <CheckCircleIcon />
          </span>
          <span className="text-sm font-medium text-conn-green-text">WeCom Bot connected</span>
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
          WebSocket long-connection active. Messages from WeCom will be routed to Clowder AI.
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
            className="w-full h-9 px-3 text-sm border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] rounded-[10px] focus:outline-none focus:ring-1 focus:ring-cafe-accent transition-colors"
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
            className="w-full h-9 px-3 text-sm border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] rounded-[10px] focus:outline-none focus:ring-1 focus:ring-cafe-accent transition-colors"
            data-testid="wecom-bot-secret-input"
          />
        </div>
      </div>

      {errorMsg && (
        <p
          className="text-xs text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2 border border-conn-red-ring"
          data-testid="wecom-bot-error"
        >
          {errorMsg}
        </p>
      )}

      {state === 'testing' ? (
        <div className="flex items-center gap-2 text-sm text-cafe-secondary">
          <SpinnerIcon />
          <span>Testing WebSocket connection...</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleValidate}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--conn-wecom-bg)] px-4 py-2 text-sm font-semibold text-[var(--cafe-surface)] transition-colors hover:opacity-90"
          data-testid="wecom-bot-validate"
        >
          <WifiIcon />
          Test &amp; Connect
        </button>
      )}
    </div>
  );
}
