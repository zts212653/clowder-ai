import type { PluginManagerCatalogProjection, PluginManagerListItem } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { type PluginBatchEntry, type PluginBatchResult, pluginBatchEntry } from './plugin-batch-model';
import { designFixture, responseError } from './plugin-manager-live-api';
import { mutationRequestOptions } from './plugin-manager-mutation-options';

async function readItem(
  id: string,
): Promise<{ plugin: PluginManagerListItem; catalog: PluginManagerCatalogProjection }> {
  const response = await apiFetch(`/api/plugin-manager/plugins/${encodeURIComponent(id)}`, undefined, {
    afterCurrentGet: true,
  });
  if (!response.ok) throw new Error('无法读取最新插件状态');
  const body = await response.json();
  if (body?.plugin?.pluginId !== id || !body.catalog) throw new Error('无法确认最新插件状态');
  return body;
}

export async function runPluginBatch(
  entries: readonly PluginBatchEntry[],
  ports: {
    active: () => boolean;
    onResult: (result: PluginBatchResult) => void;
    onChanged: () => Promise<void>;
  },
): Promise<void> {
  for (const entry of entries) {
    const id = entry.plugin.id;
    if (!ports.active()) break;
    let latest: Awaited<ReturnType<typeof readItem>>;
    try {
      latest = await readItem(id);
    } catch {
      ports.onResult({ id, state: 'skipped', message: '最新状态读不到，未开始' });
      continue;
    }
    if (!ports.active()) break;
    const current = pluginBatchEntry(
      designFixture(latest.plugin, undefined, { state: 'absent' }),
      latest.catalog.status === 'unavailable',
    );
    const action = current.action;
    if (
      !entry.action ||
      !action ||
      action.kind !== entry.action.kind ||
      (action.kind === 'update' && entry.action.kind === 'update' && action.version !== entry.action.version) ||
      latest.plugin.lifecycleRevision === null ||
      (entry.plugin.pluginInstanceId != null && entry.plugin.pluginInstanceId !== latest.plugin.pluginInstanceId) ||
      (entry.plugin.packageDigest != null && entry.plugin.packageDigest !== latest.plugin.packageDigest)
    ) {
      ports.onResult({ id, state: 'skipped', message: '状态已变化，请重新查看后处理' });
      continue;
    }
    ports.onResult({ id, state: 'working' });
    const path = `/api/plugin-manager/plugins/${encodeURIComponent(id)}/${action.kind === 'update' ? 'update' : 'repair'}`;
    let failure: string | undefined;
    let uncertain = false;
    try {
      const response = await apiFetch(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: latest.plugin.lifecycleRevision,
            ...(action.kind === 'update' ? { expectedVersion: action.version } : {}),
          }),
        },
        mutationRequestOptions(path),
      );
      if (!response.ok) {
        const error = await responseError(response, `操作失败 (${response.status})`);
        failure =
          error.code === 'ARCHIVE_REPLACEMENT_CONFIRMATION_REQUIRED'
            ? '需要确认替换，请在插件详情中继续'
            : error.message;
      }
    } catch {
      uncertain = true;
    }
    let after: PluginManagerListItem | undefined;
    try {
      after = (await readItem(id)).plugin;
      if (after.pluginInstanceId !== latest.plugin.pluginInstanceId) uncertain = true;
    } catch {
      uncertain = true;
    }
    if (uncertain) ports.onResult({ id, state: 'unknown', message: '结果待确认，不会自动重发' });
    else if (after && action.kind === 'update' && after.installedVersion === action.version) {
      ports.onResult({
        id,
        state: 'updated',
        version: after.installedVersion,
        live: after.live,
        disabled: after.intent !== 'enabled',
        repairAllowed: after.actions.repair === true,
      });
    } else if (failure) ports.onResult({ id, state: 'failed', message: failure });
    else if (after && action.kind === 'repair')
      ports.onResult({ id, state: 'repaired', live: after.live, disabled: after.intent !== 'enabled' });
    else ports.onResult({ id, state: 'unknown', message: '结果待确认，不会自动重发' });
    // A received operation is not aborted on exit. No later operation may start, even if the view remounts.
    if (!ports.active()) break;
    await ports.onChanged().catch(() => undefined);
  }
}
