import { pluginAttentionReason, pluginHasUpdate } from './plugin-manager-attention';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

export type PluginBatchAction = { kind: 'update'; version: string } | { kind: 'repair' };
export type PluginBatchBlock =
  | 'configuration'
  | 'authorization'
  | 'transition'
  | 'incompatible'
  | 'catalog'
  | 'unavailable';
export interface PluginBatchEntry {
  plugin: PluginManagerDesignFixture;
  action?: PluginBatchAction;
  blocked?: PluginBatchBlock;
}
export interface PluginBatchResult {
  id: string;
  state: 'queued' | 'working' | 'updated' | 'repaired' | 'failed' | 'unknown' | 'skipped';
  version?: string;
  live?: PluginManagerDesignFixture['live'];
  disabled?: boolean;
  repairAllowed?: boolean;
  message?: string;
}

export function pluginBatchEntry(plugin: PluginManagerDesignFixture, catalogUnavailable = false): PluginBatchEntry {
  const entry: PluginBatchEntry = { plugin };
  if (plugin.artifact !== 'installed') return { ...entry, blocked: 'unavailable' };
  if (plugin.config !== 'ready') return { ...entry, blocked: 'configuration' };
  if (plugin.auth !== 'not-required' && plugin.auth !== 'connected') return { ...entry, blocked: 'authorization' };
  if (plugin.live === 'starting' || plugin.live === 'handshaking') return { ...entry, blocked: 'transition' };
  if (!catalogUnavailable && pluginHasUpdate(plugin))
    return { ...entry, action: { kind: 'update', version: plugin.availableVersion } };
  if (plugin.actions?.repair && pluginAttentionReason(plugin)) return { ...entry, action: { kind: 'repair' } };
  if (catalogUnavailable && plugin.availableVersion !== plugin.installedVersion)
    return { ...entry, blocked: 'catalog' };
  return {
    ...entry,
    blocked: plugin.actions?.blockingReasons.includes('package-incompatible') ? 'incompatible' : 'unavailable',
  };
}

export function batchResultText(result: PluginBatchResult): string {
  switch (result.state) {
    case 'queued':
      return '还没开始';
    case 'working':
      return '正在处理…';
    case 'unknown':
      return '结果待确认';
    case 'skipped':
      return result.message ?? '没有开始';
    case 'failed':
      return result.message ?? '处理失败';
    case 'updated':
      return result.disabled
        ? `已更新到 ${result.version}`
        : batchResultPending(result)
          ? `已更新到 ${result.version} · 启动中，结果待确认`
          : result.live === 'running'
            ? `已更新到 ${result.version} · 运行正常`
            : `已更新到 ${result.version}，但启动还是出错`;
    case 'repaired':
      return result.disabled
        ? '已尝试修复，仍是停用的'
        : batchResultPending(result)
          ? '已尝试修复 · 启动中，结果待确认'
          : result.live === 'running'
            ? '已修复 · 运行正常'
            : '已尝试修复，但启动还是出错';
  }
}

export function batchResultPending(result: PluginBatchResult): boolean {
  return (
    (result.state === 'updated' || result.state === 'repaired') &&
    !result.disabled &&
    (result.live === 'starting' || result.live === 'handshaking' || result.live === undefined)
  );
}

export function batchResultProblem(result: PluginBatchResult): boolean {
  return (
    result.state === 'failed' ||
    ((result.state === 'updated' || result.state === 'repaired') &&
      !result.disabled &&
      !batchResultPending(result) &&
      result.live !== 'running')
  );
}

export function batchResultTitle(results: readonly PluginBatchResult[]): string {
  const updated = results.filter((r) => r.state === 'updated').length;
  const repaired = results.filter((r) => r.state === 'repaired').length;
  const failed = results.filter(batchResultProblem).length;
  const unknown = results.filter((r) => r.state === 'unknown' || batchResultPending(r)).length;
  const skipped = results.filter((r) => r.state === 'skipped').length;
  return `处理完了：${[updated && `${updated} 个已更新`, repaired && `${repaired} 个已尝试修复`, failed && `${failed} 个仍有问题`, unknown && `${unknown} 个结果待确认`, skipped && `${skipped} 个未开始`].filter(Boolean).join('，') || '没有执行操作'}`;
}
