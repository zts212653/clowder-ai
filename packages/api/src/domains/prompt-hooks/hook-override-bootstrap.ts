import type { RedisClient } from '@cat-cafe/shared/utils';
import { HookOverrideStore } from './HookOverrideStore.js';
import { getCachedRegistry, refreshOverrideSnapshot, setOverrideStore } from './PipelinePromptBuilder.js';

/**
 * Create the one production HookOverrideStore shared by prompt assembly and
 * every Console read/write surface. A second instance would split the runtime
 * snapshot from the audit/version views even when both point at Redis.
 */
export async function bootstrapHookOverrideStore(redis: RedisClient): Promise<HookOverrideStore> {
  const manifestLookup = (hookId: string) => getCachedRegistry()?.getHook(hookId)?.manifest;
  const store = new HookOverrideStore(redis, manifestLookup);
  setOverrideStore(store);
  await refreshOverrideSnapshot();
  return store;
}
