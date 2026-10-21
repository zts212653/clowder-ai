'use client';

import type { PluginManagerListResponse } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';
import { apiFetch } from '@/utils/api-client';
import type { SettingsPageHeaderProps } from '../SettingsPageHeader';
import { PluginManagerContent } from './PluginManagerContent';
import type { PluginManagerPresentation } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';
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
const EMPTY_COMPATIBILITY: readonly PluginManagerDesignFixture[] = [];
// Dependency preparation alone may take five minutes; allow checkout and package admission as well.
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const INSTALL_UNCONFIRMED = '安装结果尚未确认，后台可能仍在处理。请查看插件列表确认状态，避免重复安装。';

export function PluginManagerLiveContent({
  presentation = 'v1',
  pageHeader,
  compatibilityFixtures = EMPTY_COMPATIBILITY,
  renderCompatibilityDetail,
}: {
  presentation?: PluginManagerPresentation;
  pageHeader?: Omit<SettingsPageHeaderProps, 'children'>;
  compatibilityFixtures?: readonly PluginManagerDesignFixture[];
  renderCompatibilityDetail?: (pluginId: string, plugin: PluginManagerDesignFixture) => ReactNode | undefined;
} = {}) {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<PluginManagerListResponse | null>(null);
  const [detailState, setDetailState] = useState<DetailLoadState>({ state: 'idle' });
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const [linkedPluginId, setLinkedPluginId] = useState<string | null>(null);
  const [configurationSavedPluginId, setConfigurationSavedPluginId] = useState<string | null>(null);
  const selectedPluginIdRef = useRef<string | null>(null);
  const query = useRef('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const mounted = useRef(true);
  const initialSelection = useRef<string | null>(null);
  const [initialDetailPluginId, setInitialDetailPluginId] = useState<string | null>(null);
  const enableRequests = useRef(new Set<string>());

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
      if (pluginId && !compatibilityFixtures.some((plugin) => plugin.id === pluginId)) {
        void loadDetail(pluginId);
        return;
      }
      detailGeneration.current += 1;
      setDetailState({ state: 'idle' });
    },
    [loadDetail, compatibilityFixtures],
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

  const loadList = useCallback(
    async (search: string, afterMutation = false) => {
      const generation = ++listGeneration.current;
      try {
        const value = await fetchManagerList(search, afterMutation);
        if (!mounted.current) return;
        if (generation !== listGeneration.current) return value;
        setSnapshot(value);
        const requested = initialSelection.current;
        initialSelection.current = null;
        if (requested && value.plugins.some((plugin) => plugin.pluginId === requested)) {
          setInitialDetailPluginId(requested);
          selectPlugin(requested);
          return;
        }
        const current = selectedPluginIdRef.current;
        if (current && value.plugins.some((plugin) => plugin.pluginId === current)) {
          await loadDetail(current, afterMutation);
        }
        return value;
      } catch {
        if (!mounted.current || generation !== listGeneration.current) return;
        setError('插件列表加载失败；现有状态没有被改写。');
      }
    },
    [loadDetail, selectPlugin],
  );

  useEffect(() => {
    mounted.current = true;
    initialSelection.current = new URLSearchParams(window.location.search).get('plugin');
    void loadList('');
    const timer = window.setInterval(() => void loadList(query.current), POLL_INTERVAL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [loadList]);

  const refresh = useCallback(async () => {
    await loadList(query.current, true);
  }, [loadList]);

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
          await refresh();
          setError(failure.message);
          return;
        }
        setConfigurationSavedPluginId(pluginId);
        await refresh();
      } catch {
        setError('未能确认配置保存结果，请刷新后检查。');
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
        const response = await apiFetch(
          path,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
          path.endsWith('/install') || path.endsWith('/update') ? { mutationTimeoutMs: INSTALL_TIMEOUT_MS } : undefined,
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
      onOperationChange={(pluginId) => void loadDetail(pluginId, true)}
    />
  );
}
