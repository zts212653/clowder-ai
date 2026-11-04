import { parseWatcherThreadControl } from '@cat-cafe/shared';
import type { ILabelStore, IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { IConciergeConfigStore } from '../ConciergeConfigStore.js';
import { effectiveWatcherState, readWatcherPreferences } from './watcher-controls.js';

/** Host-only expected control values, checked again in the output owner's atomic Redis commit. */
export interface WatcherOutputFence {
  userId: string;
  threadId: string;
  configRevision: number;
  controlRevision: number;
  labels: string;
}
export async function readWatcherOutputFence(
  owners: { configs: IConciergeConfigStore; threads: IThreadStore; labels: ILabelStore },
  userId: string,
  threadId: string,
  catId: string,
): Promise<WatcherOutputFence | null> {
  const [preferences, thread] = await Promise.all([
    readWatcherPreferences(owners.configs, owners.labels, userId),
    owners.threads.get(threadId),
  ]);
  if (
    !thread ||
    thread.deletedAt ||
    preferences.config.memberCatId !== catId ||
    !effectiveWatcherState(preferences.config, thread, preferences.quietLabels).maySpeak
  )
    return null;
  return {
    userId,
    threadId,
    configRevision: preferences.config.revision,
    controlRevision: parseWatcherThreadControl(thread.watcher).revision,
    labels: JSON.stringify(thread.labels ?? []),
  };
}

/** KEYS last two: config / thread; ARGV last: expected snapshot. Nothing has been written when this fails. */
export const WATCHER_OUTPUT_FENCE_LUA = `
local watcherFence = cjson.decode(ARGV[#ARGV])
local watcherConfigRaw = redis.call('GET', KEYS[#KEYS-1])
local watcherConfig = watcherConfigRaw and cjson.decode(watcherConfigRaw).watcher or {revision=0}
local watcherControlRaw = redis.call('HGET', KEYS[#KEYS], 'watcher')
local watcherControl = watcherControlRaw and cjson.decode(watcherControlRaw) or {revision=0}
local watcherLabels = redis.call('HGET', KEYS[#KEYS], 'labels') or '[]'
local watcherDeletedAt = redis.call('HGET', KEYS[#KEYS], 'deletedAt')
if watcherConfig.revision ~= watcherFence.configRevision or watcherControl.revision ~= watcherFence.controlRevision
  or watcherLabels ~= watcherFence.labels or (watcherDeletedAt and watcherDeletedAt ~= '') then
  return redis.error_reply('watcher_output_control_changed')
end
`;
