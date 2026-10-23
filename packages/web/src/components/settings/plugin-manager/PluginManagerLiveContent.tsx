'use client';

import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import { PluginManagerContent } from './PluginManagerContent';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';
import {
  type DetailLoadState,
  designFixture,
  detailProjection,
  fetchManagerDetail,
  fetchManagerList,
  responseError,
} from './plugin-manager-live-api';
import type { PluginManagerLiveContentProps } from './plugin-manager-live-types';
import { INSTALL_TIMEOUT_MS, mutationRequestOptions } from './plugin-manager-mutation-options';
import { usePluginConfigurationSave } from './usePluginConfigurationSave';

const EMPTY_COMPATIBILITY: readonly PluginManagerDesignFixture[] = [];
const INSTALL_UNCONFIRMED = '安装结果尚未确认，后台可能仍在处理。请查看插件列表确认状态，避免重复安装。';

export function PluginManagerLiveContent({
  presentation = 'v1',
  pageHeader,
  compatibilityFixtures = EMPTY_COMPATIBILITY,
  renderCompatibilityDetail,
}: PluginManagerLiveContentProps = {}) {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<PluginManagerListResponse | null>(null);
  const [detailState, setDetailState] = useState<DetailLoadState>({ state: 'idle' });
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [linkedPluginId, setLinkedPluginId] = useState<string | null>(null);
  const [configurationSavedPluginId, setConfigurationSavedPluginId] = useState<string | null>(null);
  const selectedPluginIdRef = useRef<string | null>(null);
  const query = useRef('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);
  const localPluginIds = useRef(new Set<string>());
  const initialSelection = useRef<string | null>(null);
  const [initialDetailPluginId, setInitialDetailPluginId] = useState<string | null>(null);
  const enableRequests = useRef(new Set<string>());

  const loadDetail = useCallback(async (pluginId: string, afterMutation = false, local = false) => {
    const generation = ++detailGeneration.current;
    setDetailState((current) =>
      (current.state === 'ready' || current.state === 'unavailable') && current.pluginId === pluginId
        ? current
        : { state: 'loading', pluginId },
    );
    try {
      const value = await fetchManagerDetail(pluginId, afterMutation, local);
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetailState({ state: 'ready', pluginId, detail: value });
    } catch {
      if (!mounted.current || generation !== detailGeneration.current) return;
      setDetailState({ state: 'unavailable', pluginId });
    }
  }, []);

  const loadCurrentDetail = useCallback(
    (pluginId: string, afterMutation = false) =>
      loadDetail(pluginId, afterMutation, localPluginIds.current.has(pluginId)),
    [loadDetail],
  );

  const selectPlugin = useCallback(
    (pluginId: string | null) => {
      selectedPluginIdRef.current = pluginId;
      setSelectedPluginId(pluginId);
      setConfigurationSavedPluginId((current) => (current === pluginId ? current : null));
      if (pluginId && !compatibilityFixtures.some((plugin) => plugin.id === pluginId)) {
        void loadCurrentDetail(pluginId);
        return;
      }
      detailGeneration.current += 1;
      setDetailState({ state: 'idle' });
    },
    [loadCurrentDetail, compatibilityFixtures],
  );
  const linkedSelection = useRef(selectPlugin);
  linkedSelection.current = selectPlugin;

  const catalogReady = snapshot !== null;
  useEffect(() => {
    if (!catalogReady) return;
    const selectLinkedPlugin = () => {
      const hash = window.location.hash;
      const pluginId =
        hash === '#chatgpt-dot'
          ? 'official.chatgpt-dot'
          : hash === '#personal-chatgpt-pro'
            ? 'personal-chrome-host'
            : null;
      setLinkedPluginId(pluginId);
      if (pluginId) linkedSelection.current(pluginId);
    };
    selectLinkedPlugin();
    window.addEventListener('hashchange', selectLinkedPlugin);
    return () => window.removeEventListener('hashchange', selectLinkedPlugin);
  }, [catalogReady]);

  const commitListSnapshot = useCallback(
    async (
      value: PluginManagerListResponse,
      generation: number,
      afterMutation: boolean,
      local: boolean,
      localInventory?: PluginManagerListResponse,
    ): Promise<boolean> => {
      if (!mounted.current || generation !== listGeneration.current) return false;
      if (localInventory) localPluginIds.current = new Set(localInventory.plugins.map((plugin) => plugin.pluginId));
      setSnapshot(value);
      const requested = initialSelection.current;
      if (requested && value.plugins.some((plugin) => plugin.pluginId === requested)) {
        initialSelection.current = null;
        setInitialDetailPluginId(requested);
        selectPlugin(requested);
        return true;
      }
      if (!local) initialSelection.current = null;
      const current = selectedPluginIdRef.current;
      if (current && value.plugins.some((plugin) => plugin.pluginId === current)) {
        await loadCurrentDetail(current, afterMutation);
      }
      return true;
    },
    [loadCurrentDetail, selectPlugin],
  );

  const hydrateRemoteList = useCallback(
    async (search: string, generation: number, afterMutation: boolean, localCommitted: boolean) => {
      try {
        const value = await fetchManagerList(search, afterMutation);
        await commitListSnapshot(value, generation, afterMutation, false);
        return value;
      } catch {
        if (!mounted.current || generation !== listGeneration.current) return;
        if (localCommitted) {
          setSnapshot((current) =>
            current === null
              ? current
              : {
                  ...current,
                  catalog: {
                    status: 'unavailable',
                    refreshedAt: null,
                    message: '目录暂时不可用；已安装插件仍可管理，稍后再次打开或搜索会重新加载。',
                  },
                },
          );
          return;
        }
        setError('插件列表加载失败；现有状态没有被改写。');
      }
    },
    [commitListSnapshot],
  );

  const loadList = useCallback(
    async (search: string, afterMutation = false) => {
      const generation = ++listGeneration.current;
      try {
        const normalizedSearch = search.trim();
        const localInventoryPromise = fetchManagerList('', afterMutation, true);
        const localValuePromise =
          normalizedSearch.length === 0
            ? localInventoryPromise
            : fetchManagerList(normalizedSearch, afterMutation, true);
        const [localInventory, localValue] = await Promise.all([localInventoryPromise, localValuePromise]);
        const localCommitted = await commitListSnapshot(localValue, generation, afterMutation, true, localInventory);
        if (!localCommitted) return localValue;
        void hydrateRemoteList(search, generation, afterMutation, true);
        return localValue;
      } catch {
        // Older Hosts and partially upgraded desktop bundles can still fall through to canonical discovery.
        return hydrateRemoteList(search, generation, afterMutation, false);
      }
    },
    [commitListSnapshot, hydrateRemoteList],
  );

  useEffect(() => {
    mounted.current = true;
    initialSelection.current = new URLSearchParams(window.location.search).get('plugin');
    void loadList('');
    return () => {
      mounted.current = false;
    };
  }, [loadList]);

  const refresh = useCallback(async () => {
    await loadList(query.current, true);
  }, [loadList]);

  const configure = usePluginConfigurationSave({
    snapshot,
    refresh,
    onBusy: setBusyPluginId,
    onError: setError,
    onWarning: setWarning,
    onSaved: setConfigurationSavedPluginId,
  });

  const mutate = useCallback(
    async (pluginId: string, path: string, body: unknown) => {
      setBusyPluginId(pluginId);
      setError(null);
      try {
        const response = await apiFetch(
          path,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          mutationRequestOptions(path),
        );
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
        await refresh();
        setError(path.endsWith('/install') ? INSTALL_UNCONFIRMED : '操作结果尚未确认，请查看最新插件状态。');
      } finally {
        setBusyPluginId(null);
      }
    },
    [refresh],
  );

  const installFromDirectory = useCallback(
    async (path: string) => {
      setError(null);
      let response: Response;
      try {
        response = await apiFetch(
          '/api/plugin-manager/plugins/install',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source: { kind: 'local-directory', path } }),
          },
          { mutationTimeoutMs: INSTALL_TIMEOUT_MS },
        );
      } catch {
        await refresh();
        throw new Error(INSTALL_UNCONFIRMED);
      }
      if (!response.ok) {
        const failure = await responseError(response, `本地插件安装失败 (${response.status})`);
        throw new Error(failure.message);
      }
      await refresh();
    },
    [refresh],
  );

  const plugins = snapshot?.plugins ?? [];
  // Compatibility still owns operations; presentation comes from the Host's manifest projection.
  const compatibilityPresentation = compatibilityFixtures.map((fixture) => {
    const plugin = plugins.find((candidate) => candidate.pluginId === fixture.id);
    return plugin
      ? {
          ...fixture,
          icon: plugin.icon ?? fixture.icon,
          ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
        }
      : fixture;
  });
  const requestEnable = useCallback(
    async (pluginId: string) => {
      if (enableRequests.current.has(pluginId)) return;
      enableRequests.current.add(pluginId);
      setBusyPluginId(pluginId);
      setError(null);
      try {
        const latest = await loadList(query.current, true);
        if (!mounted.current || !latest) return;
        const plugin = latest.plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin?.actions.setEnabled || plugin.lifecycleRevision === null || plugin.intent === 'enabled') return;
        await mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/set-enabled`, {
          enabled: true,
          expectedRevision: plugin.lifecycleRevision,
        });
      } finally {
        enableRequests.current.delete(pluginId);
        if (mounted.current) setBusyPluginId(null);
      }
    },
    [loadList, mutate],
  );

  const compatibilityIds = new Set(compatibilityFixtures.map((plugin) => plugin.id));
  const fixtures = plugins
    .filter((plugin) => !compatibilityIds.has(plugin.pluginId))
    .map((plugin) => {
      const projection = detailProjection(plugin.pluginId, detailState);
      return designFixture(plugin, projection.detail, projection.readme);
    });

  return (
    <PluginManagerContent
      pageHeader={pageHeader}
      presentation={presentation}
      initialDetailPluginId={initialDetailPluginId}
      fixtures={[...fixtures, ...compatibilityPresentation]}
      renderCompatibilityDetail={renderCompatibilityDetail}
      onStateChanged={refresh}
      onRequestEnable={requestEnable}
      catalogStatus={snapshot?.catalog.status ?? 'fresh'}
      catalogMessage={snapshot?.catalog.message}
      loading={snapshot === null && error === null}
      error={error}
      warning={warning}
      busyPluginId={busyPluginId}
      selectedPluginId={selectedPluginId}
      linkedPluginId={linkedPluginId}
      onPluginSelect={selectPlugin}
      onSearchChange={(value) => {
        query.current = value;
        void loadList(value);
      }}
      onInstall={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (plugin?.artifact === 'installed') {
          void mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/update`, {
            expectedVersion: plugin.availableVersion,
            expectedRevision: plugin.lifecycleRevision,
          });
          return;
        }
        if (plugin?.source.kind === 'git' && plugin.source.marketplace) {
          void mutate(pluginId, '/api/plugin-manager/plugins/install', {
            source: { kind: 'git', url: plugin.source.url, marketplace: plugin.source.marketplace },
          });
          return;
        }
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
      onMarketplaceChange={refresh}
      onDirectoryInstall={installFromDirectory}
      onRepair={(pluginId) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        if (!plugin?.actions.repair || plugin.lifecycleRevision === null) return;
        void mutate(pluginId, `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}/repair`, {
          expectedRevision: plugin.lifecycleRevision,
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
        const dot = pluginId === 'official.chatgpt-dot';
        const operation = plugin.artifact === 'quarantined' ? '移除隔离记录' : dot ? '移除 dot 协作支持' : '卸载';
        void (async () => {
          const accepted = await confirm({
            title: dot ? operation : `${operation}插件`,
            message: dot
              ? `确认${operation}？新的 dot 召唤将停止；已连接的 Pro、历史回复和已保存的图片保留。`
              : `确认${operation} ${plugin.displayName}？`,
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
      onOperationChange={(pluginId) => void loadCurrentDetail(pluginId, true)}
    />
  );
}
