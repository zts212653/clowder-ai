import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type ConfigurationUpdate, configurationRequest, responseError } from './plugin-manager-live-api';
import { mutationRequestOptions } from './plugin-manager-mutation-options';

export function usePluginConfigurationSave({
  snapshot,
  refresh,
  onBusy,
  onError,
  onWarning,
  onSaved,
}: {
  snapshot: PluginManagerListResponse | null;
  refresh(): Promise<void>;
  onBusy(id: string | null): void;
  onError(message: string | null): void;
  onWarning(message: string | null): void;
  onSaved(id: string | null): void;
}) {
  return useCallback(
    async (pluginId: string, updates: readonly ConfigurationUpdate[]) => {
      const plugin = snapshot?.plugins.find((candidate) => candidate.pluginId === pluginId);
      const request = configurationRequest(plugin, updates);
      if (!request) {
        onError('该插件没有可用的配置贡献。');
        return;
      }
      onBusy(pluginId);
      onError(null);
      onSaved(null);
      try {
        const response = await apiFetch(request.path, request.init, mutationRequestOptions(request.path));
        if (!response.ok) {
          const failure = await responseError(response, `配置保存失败 (${response.status})`);
          await refresh();
          onError(failure.message);
          return;
        }
        const receipt: unknown = await response.json().catch(() => null);
        onSaved(pluginId);
        await refresh();
        if (receipt && typeof receipt === 'object' && 'warning' in receipt && typeof receipt.warning === 'string') {
          onWarning(receipt.warning);
        } else onWarning(null);
      } catch {
        await refresh();
        onError('未能确认配置保存结果，请刷新后检查。');
      } finally {
        onBusy(null);
      }
    },
    [snapshot, refresh, onBusy, onError, onWarning, onSaved],
  );
}
