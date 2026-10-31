import type { ConciergeConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from './concierge-keys.js';

export type AppAssistClaim = 'claimed' | 'already_claimed' | 'disabled' | 'clock_rollback' | 'capacity';
export type AppAssistPolicyListener = (allowed: boolean | null) => void | Promise<void>;
export interface AppAssistDay {
  day: string;
  keys: string[];
}

export function appAssistAllowed(config: ConciergeConfig): boolean {
  return config.appAssistEnabled === true && config.enabled !== false && config.muted !== true;
}

export function validateAppAssistClaim(appKey: string, day: string): void {
  if (
    !/^[a-f0-9]{64}$/.test(appKey) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day
  )
    throw new Error('Invalid app-assist claim');
}

// Both the saved independent consent and the current-day set are read in one
// atomic operation. Raw application identity never enters this Redis record.
const CLAIM_DAY = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'disabled' end
local config = cjson.decode(raw)
if config.appAssistEnabled ~= true or config.enabled == false or config.muted == true then return 'disabled' end
local rawDay = redis.call('GET', KEYS[2])
local current = rawDay and cjson.decode(rawDay) or {day=ARGV[1], keys={}}
if ARGV[1] < current.day then return 'clock_rollback' end
if ARGV[1] > current.day then current = {day=ARGV[1], keys={}} end
for _, key in ipairs(current.keys) do if key == ARGV[2] then return 'already_claimed' end end
if #current.keys >= 256 then return 'capacity' end
table.insert(current.keys, ARGV[2])
redis.call('SET', KEYS[2], cjson.encode(current))
return 'claimed'
`;

// Preserve concurrent partial settings changes, including a newer opt-out.
// Publication is in the same Redis operation; it carries one boolean only.
const WRITE_CONFIG = `
local config = cjson.decode(ARGV[1])
if ARGV[3] == 'patch' then
  local current = redis.call('GET', KEYS[1])
  local merged = cjson.decode(current or ARGV[4])
  for key, value in pairs(config) do merged[key] = value end
  config = merged
end
redis.call('SET', KEYS[1], cjson.encode(config))
local allowed = config.appAssistEnabled == true and config.enabled ~= false and config.muted ~= true
redis.call('PUBLISH', ARGV[2], allowed and 'enabled' or 'disabled')
return 1
`;

function policyChannel(redis: RedisClient, userId: string): string {
  // Redis keyPrefix applies to EVAL KEYS but not pub/sub channel arguments.
  return `${redis.options.keyPrefix ?? ''}${ConciergeKeys.appAssistPolicy(userId)}`;
}

export async function writeConciergeConfig(
  redis: RedisClient,
  userId: string,
  value: Partial<ConciergeConfig>,
  defaults?: ConciergeConfig,
): Promise<void> {
  await redis.eval(
    WRITE_CONFIG,
    1,
    ConciergeKeys.config(userId),
    JSON.stringify(value),
    policyChannel(redis, userId),
    defaults ? 'patch' : 'put',
    JSON.stringify(defaults ?? {}),
  );
}

export async function claimRedisAppAssistDay(
  redis: RedisClient,
  userId: string,
  appKey: string,
  day: string,
): Promise<AppAssistClaim> {
  validateAppAssistClaim(appKey, day);
  const result = await redis.eval(
    CLAIM_DAY,
    2,
    ConciergeKeys.config(userId),
    ConciergeKeys.appAssistDay(userId),
    day,
    appKey,
  );
  if (!['claimed', 'already_claimed', 'disabled', 'clock_rollback', 'capacity'].includes(String(result)))
    throw new Error('App-assist claim unavailable');
  return result as AppAssistClaim;
}

export function claimMemoryAppAssistDay(
  days: Map<string, AppAssistDay>,
  userId: string,
  appKey: string,
  day: string,
): AppAssistClaim {
  validateAppAssistClaim(appKey, day);
  const previous = days.get(userId);
  if (previous && day < previous.day) return 'clock_rollback';
  const current = previous?.day === day ? previous : { day, keys: [] };
  if (current.keys.includes(appKey)) return 'already_claimed';
  if (current.keys.length >= 256) return 'capacity';
  current.keys.push(appKey);
  days.set(userId, current);
  return 'claimed';
}

export async function watchRedisAppAssistPolicy(
  redis: RedisClient,
  userId: string,
  listener: AppAssistPolicyListener,
): Promise<() => Promise<void>> {
  const subscription = redis.duplicate({ lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  const channel = policyChannel(redis, userId);
  let disposed = false;
  const notify = (allowed: boolean | null) => {
    if (!disposed)
      void Promise.resolve()
        .then(() => listener(allowed))
        .catch(() => {});
  };
  subscription.on('message', (received, value) => {
    if (received === channel) notify(value === 'enabled' ? true : value === 'disabled' ? false : null);
  });
  subscription.on('error', () => notify(null));
  subscription.on('close', () => notify(null));
  try {
    await subscription.connect();
    await subscription.subscribe(channel);
  } catch (error) {
    disposed = true;
    subscription.disconnect();
    throw error;
  }
  return async () => {
    disposed = true;
    subscription.disconnect();
  };
}
