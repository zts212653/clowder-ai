'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  type PersonalChromePluginAction,
  PersonalChromePluginCard,
  type PersonalChromePluginState,
} from './PersonalChromePluginCard';
import { SettingsText } from './primitives/SettingsText';

export function PersonalChromePluginPanel() {
  const [state, setState] = useState<PersonalChromePluginState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/plugins/personal-chrome');
      if (!response.ok) throw new Error(`Personal ChatGPT Pro 状态读取失败 (${response.status})`);
      setState((await response.json()) as PersonalChromePluginState);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Personal ChatGPT Pro 状态读取失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(async (action: PersonalChromePluginAction) => {
    if (action === 'uninstall' && !window.confirm('确认卸载 Personal ChatGPT Pro 本机组件？全部会话授权也会移除。')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/plugins/personal-chrome/${action}`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as PersonalChromePluginState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Personal ChatGPT Pro 操作失败 (${response.status})`);
      setState(body);
      if (action === 'install' && body.distribution.publication === 'published' && body.distribution.listingUrl) {
        window.open(body.distribution.listingUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Personal ChatGPT Pro 操作失败');
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(async (conversationId: string) => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/plugins/personal-chrome/authorizations/${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' },
      );
      const body = (await response.json().catch(() => ({}))) as PersonalChromePluginState & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `会话授权撤销失败 (${response.status})`);
      setState(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '会话授权撤销失败');
    } finally {
      setBusy(false);
    }
  }, []);

  if (!state && !error) return <SettingsText tone="muted">正在读取 Personal ChatGPT Pro 状态…</SettingsText>;

  return (
    <section className="contents" data-testid="personal-chrome-plugin-panel">
      {error && <div className="rounded-md bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">{error}</div>}
      {state && (
        <PersonalChromePluginCard
          state={state}
          expanded={expanded}
          busy={busy}
          onToggleDetails={() => setExpanded((current) => !current)}
          onAction={(action) => void mutate(action)}
          onRevoke={(conversationId) => void revoke(conversationId)}
        />
      )}
    </section>
  );
}
