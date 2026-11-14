import {
  applyWatcherConfigPatch,
  type ConciergeConfig,
  parseWatcherConfig,
  type WatcherConfig,
  type WatcherConfigPatch,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from '../concierge-keys.js';

const PATCH_WATCHER_LUA = `
local raw = redis.call('GET', KEYS[1])
local config = raw and cjson.decode(raw) or cjson.decode(ARGV[3])
local revision = config.watcher and config.watcher.revision or 0
if revision ~= tonumber(ARGV[1]) then return '' end
local next = cjson.decode(ARGV[2])
if config.watcher then
  for _, field in ipairs({'startedAfterSequence', 'activationRevision', 'activatedAt'}) do
    if next[field] == nil then next[field] = config.watcher[field] end
  end
end
config.watcher = next
redis.call('SET', KEYS[1], cjson.encode(config))
return cjson.encode(config.watcher)
`;

export async function updateRedisWatcherConfig(
  redis: RedisClient,
  userId: string,
  expectedRevision: number,
  patch: WatcherConfigPatch,
  defaults: ConciergeConfig,
  resumeAfterSequence?: number,
): Promise<WatcherConfig | null> {
  assertWatcherConfigRevision(expectedRevision);
  const key = ConciergeKeys.config(userId);
  const raw = await redis.get(key);
  const current = parseWatcherConfig(raw ? (JSON.parse(raw) as ConciergeConfig).watcher : undefined);
  if (current.revision !== expectedRevision) return null;
  const next = applyWatcherConfigPatch(current, patch);
  if (resumeAfterSequence !== undefined) {
    assertWatcherConfigRevision(resumeAfterSequence);
    next.startedAfterSequence = Math.max(current.startedAfterSequence ?? 0, resumeAfterSequence);
    next.activationRevision = next.revision;
    next.activatedAt = Date.now();
  }
  const result = await redis.eval(
    PATCH_WATCHER_LUA,
    1,
    key,
    String(expectedRevision),
    JSON.stringify(next),
    JSON.stringify(defaults),
  );
  return typeof result === 'string' && result ? parseWatcherConfig(JSON.parse(result)) : null;
}

export function assertWatcherConfigRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid watcher preference revision');
}
