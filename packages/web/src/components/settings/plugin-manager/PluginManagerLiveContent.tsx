'use client';

import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import { PluginManagerContent } from './PluginManagerContent';
import {
  type ConfigurationUpdate,
  configurationRequest,
  type DetailLoadState,
  designFixture,
  detailProjection,
  fetchManagerDetail,
  fetchManagerList,
  responseError,
} from './plugin-manager-live-api';

const POLL_INTERVAL_MS = 5_000;

export function PluginManagerLiveContent() {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<PluginManagerListResponse | null>(null);
  const [detailState, setDetailState] = useState<DetailLoadState>({ state: 'idle' });
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [configurationSavedPluginId, setConfigurationSavedPluginId] = useState<string | null>(null);
  const selectedPluginIdRef = useRef<string | null>(null);
  const query = useRef('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);

  const loadDetail = useCallback(async (pluginId: string, afterMutation = false) => {
    const generation = ++detailGeneration.current;
    setDetailState((current) =>
      (current.state === 'ready' || current.state === 'unavailable') && current.pluginId === pluginId
        ? current
        : { state: 'loading', pluginId },
    );
    try {
      const value = await fetchManagerDetail(pluginId, afterMutation);
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetailState({ state: 'ready', pluginId, detail: value });
    } catch {
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetailState({ state: 'unavailable', pluginId });
    }
  }, []);

  const selectPlugin = useCallback(
    (pluginId: string | null) => {
      selectedPluginIdRef.current = pluginId;
      setSelectedPluginId(pluginId);
      setConfigurationSavedPluginId((current) => (current === pluginId ? current : null));
      if (pluginId) {
        void loadDetail(pluginId);
        return;
      }
      detailGeneration.current += 1;
      setDetailState({ state: 'idle' });
    },
    [loadDetail],
  );

  const loadList = useCallback(
    async (search: string, afterMutation = false) => {
      const generation = ++listGeneration.current;
      try {
        const value = await fetchManagerList(search, afterMutation);
        if (!mounted.current || generation !== listGeneration.current) return;
        setSnapshot(value);
        const current = selectedPluginIdRef.current;
        if (current && value.plugins.some((plugin) => plugin.pluginId === current)) {
          await loadDetail(current, afterMutation);
        }
      } catch {
        if (!mounted.current || generation !== listGeneration.current) return;
        setError('插件列表加载失败；现有状态没有被改写。');
      }
    },
    [loadDetail],
  );

  useEffect(() => {
    mounted.current = true;
    void loadList('');
    const timer = window.setInterval(() => void loadList(query.current), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [loadList]);

  const refresh = useCallback(() => loadList(query.current, true), [loadList]);

  const configure = useCallback(
    async (pluginId: string, updates: readonly ConfigurationUpdate[]) => {
      const plugin = snapshot?.plugins.find((candidate) => candidate.pluginId === pluginId);
      const request = configurationRequest(plugin, updates);
      if (!request) {
        setError('该插件没有可用的配置贡献。');
        return;
      }
      setBusyPluginId(pluginId);
      setError(null);
      setConfigurationSavedPluginId(null);
      try {
        const response = await apiFetch(request.path, request.init);
        if (!response.ok) {
          const failure = await responseError(response, `配置保存失败 (${response.status})`);
          setError(failure.message);
          return;
        }
        setConfigurationSavedPluginId(pluginId);
        await refresh();
      } catch {
        setError('配置保存失败；现有配置没有被改写。');
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh, snapshot],
  );

  const mutate = useCallback(
    async (pluginId: string, path: string, body: unknown) => {
      setBusyPluginId(pluginId);
      setError(null);
      try {
        const response = await apiFetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const failure = await responseError(response, `插件操作失败 (${response.status})`);
          await refresh();
          setError(
            response.status === 409 || failure.code === 'STALE_REVISION'
              ? '插件状态已变化，已刷新最新状态。'
              : failure.message,
          );
          return;
        }
        await refresh();
      } catch {
        setError('插件操作失败；现有状态没有被改写。');
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh],
  );

  const plugins = snapshot?.plugins ?? [];
  const fixtures = plugins.map((plugin) => {
    const projection = detailProjection(plugin.pluginId, detailState);
    return designFixture(plugin, projection.detail, projection.readme);
  });

  return (
    <PluginManagerContent
      fixtures={fixtures}
      catalogStatus={snapshot?.catalog.status ?? 'fresh'}
      catalogMessage={snapshot?.catalog.message}
      loading={snapshot === null && error === null}
      error={error}
      busyPluginId={busyPluginId}
      selectedPluginId={selectedPluginId}
      onPluginSelect={selectPlugin}
      onSearchChange={(value) => {
        query.current = value;
        void loadList(value);
      }}
      onInstall={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (
          !plugin ||
          plugin.source.kind !== 'catalog' ||
          plugin.availableVersion === null ||
          plugin.packageDigest === null
        ) {
          setError('插件缺少可验证的 catalog release，无法安装。');
          return;
        }
        void mutate(pluginId, '/api/plugin-manager/plugins/install', {
          source: { kind: 'catalog', catalogId: plugin.source.catalogId },
          expectedVersion: plugin.availableVersion,
          expectedDigest: plugin.packageDigest,
        });
      }}
      onSetEnabled={(pluginId, enabled) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin || plugin.lifecycleRevision === null) {
          setError('插件缺少当前 lifecycle revision，无法变更启用状态。');
          return;
        }
        void mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/set-enabled`, {
          enabled,
          expectedRevision: plugin.lifecycleRevision,
        });
      }}
      configurationSavedPluginId={configurationSavedPluginId}
      onUninstall={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin || plugin.lifecycleRevision === null) {
          setError('插件缺少当前 lifecycle revision，无法卸载。');
          return;
        }
        const operation = plugin.artifact === 'quarantined' ? '移除隔离记录' : '卸载';
        void (async () => {
          const accepted = await confirm({
            title: `${operation}插件`,
            message: `确认${operation} ${plugin.displayName}？`,
            confirmLabel: operation,
            cancelLabel: '取消',
            variant: 'danger',
          });
          if (!accepted) return;
          await mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/uninstall`, {
            expectedRevision: plugin.lifecycleRevision,
          });
        })();
      }}
      onConfigure={(pluginId, updates) => void configure(pluginId, updates)}
    />
  );
}
