'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type OfficialPluginAction, OfficialPluginCard, type OfficialPluginInfo } from './OfficialPluginCard';
import { SettingsText } from './primitives/SettingsText';

const HEALTH_REFRESH_MS = 5_000;

interface MutationRequest {
  readonly target: string;
  readonly init: RequestInit;
}

function actionConfirmed(plugin: OfficialPluginInfo, action: OfficialPluginAction): boolean {
  if (action === 'enable') return window.confirm('确认启用飞书会议纪要同步？启用后会连接本机 lark-cli。');
  if (action === 'update') {
    return window.confirm(`确认更新到 ${plugin.availableVersion}？更新后保持停用，需要你再次启用。`);
  }
  if (action === 'uninstall') {
    return window.confirm('确认卸载？运行中的进程会先停止，已缓存的不可变包会保留。');
  }
  return true;
}

function mutationRequest(plugin: OfficialPluginInfo, action: OfficialPluginAction): MutationRequest | undefined {
  if (action === 'install') return { target: plugin.catalogId, init: { method: 'POST' } };
  if (!plugin.instance) return undefined;
  return {
    target: plugin.instance.pluginInstanceId,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: plugin.instance.lifecycleRevision }),
    },
  };
}

export function OfficialPluginsPanel() {
  const [plugins, setPlugins] = useState<OfficialPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (clearError = true) => {
    try {
      const response = await apiFetch('/api/plugins/official');
      if (!response.ok) throw new Error(`官方插件读取失败 (${response.status})`);
      const body = (await response.json()) as { plugins?: OfficialPluginInfo[] };
      setPlugins(Array.isArray(body.plugins) ? body.plugins : []);
      if (clearError) setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '官方插件读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = window.setInterval(() => void load(), HEALTH_REFRESH_MS);
    return () => window.clearInterval(refresh);
  }, [load]);

  const mutate = useCallback(
    async (plugin: OfficialPluginInfo, action: OfficialPluginAction) => {
      if (!actionConfirmed(plugin, action)) return;
      const request = mutationRequest(plugin, action);
      if (!request) return;
      setBusyId(plugin.catalogId);
      setError(null);
      try {
        const response = await apiFetch(`/api/plugins/official/${request.target}/${action}`, request.init);
        const body = (await response.json().catch(() => ({}))) as OfficialPluginInfo & {
          error?: string;
          code?: string;
        };
        if (response.ok) {
          setPlugins((current) => current.map((item) => (item.catalogId === plugin.catalogId ? body : item)));
        } else if (body.code === 'STALE_REVISION') {
          setError('插件状态已变化，已刷新到最新状态，请重试。');
          await load(false);
        } else {
          setError(body.error ?? `官方插件操作失败 (${response.status})`);
        }
      } catch {
        setError('官方插件操作网络错误');
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  if (loading) return <SettingsText tone="muted">正在读取飞书会议纪要同步状态…</SettingsText>;
  if (plugins.length === 0 && !error) return null;

  return (
    <section className="contents" data-testid="official-plugins-panel">
      {error && <div className="rounded-md bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">{error}</div>}
      {plugins.map((plugin) => (
        <OfficialPluginCard
          key={plugin.catalogId}
          plugin={plugin}
          busy={busyId === plugin.catalogId}
          onAction={(action) => void mutate(plugin, action)}
        />
      ))}
    </section>
  );
}
