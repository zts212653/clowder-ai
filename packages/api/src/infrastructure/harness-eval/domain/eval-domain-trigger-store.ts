import type { RedisClient } from '@cat-cafe/shared/utils';

export type EvalDomainTriggerReceiptKind = 'window' | 'event';
export type EvalDomainTriggerChannel = 'time' | 'threshold_event';

export interface EvalDomainTriggerReceiptRef {
  kind: EvalDomainTriggerReceiptKind;
  domainId: string;
  receiptId: string;
  token: string;
}

export interface EvalDomainTriggerClaimInput extends EvalDomainTriggerReceiptRef {
  nowMs: number;
  leaseMs: number;
}

export type EvalDomainTriggerClaimResult =
  | { outcome: 'claimed' }
  | { outcome: 'deduped' }
  | { outcome: 'overlap' }
  | { outcome: 'cooldown' };

export interface EvalDomainTriggerCompleteInput extends EvalDomainTriggerReceiptRef {
  channel: EvalDomainTriggerChannel;
  nowMs: number;
  cooldownUntilMs?: number;
}

export interface IEvalDomainTriggerStore {
  claim(input: EvalDomainTriggerClaimInput): Promise<EvalDomainTriggerClaimResult>;
  complete(input: EvalDomainTriggerCompleteInput): Promise<boolean>;
  release(input: EvalDomainTriggerReceiptRef): Promise<void>;
}

const KEYSPACE = 'eval-domain-trigger';

export const EvalDomainTriggerKeys = {
  receipt: (kind: EvalDomainTriggerReceiptKind, domainId: string, receiptId: string): string =>
    `${KEYSPACE}:${kind}:${domainId}:${receiptId}`,
  cooldown: (domainId: string): string => `${KEYSPACE}:cooldown:${domainId}`,
} as const;

const CLAIM_LUA = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'dispatched' then
  return 0
end

if status == 'claimed' then
  local leaseUntilMs = tonumber(redis.call('HGET', KEYS[1], 'leaseUntilMs') or '0')
  if leaseUntilMs > tonumber(ARGV[2]) then
    return -1
  end
end

if ARGV[1] == 'window' then
  local cooldownUntilMs = tonumber(redis.call('GET', KEYS[2]) or '0')
  if cooldownUntilMs > tonumber(ARGV[2]) then
    redis.call(
      'HSET', KEYS[1],
      'status', 'dispatched',
      'channel', 'cooldown',
      'dispatchedAtMs', ARGV[2]
    )
    return -2
  end
end

redis.call(
  'HSET', KEYS[1],
  'status', 'claimed',
  'token', ARGV[3],
  'claimedAtMs', ARGV[2],
  'leaseUntilMs', tonumber(ARGV[2]) + tonumber(ARGV[4])
)
return 1
`;

const COMPLETE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'claimed' then
  return 0
end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[2] then
  return 0
end

redis.call(
  'HSET', KEYS[1],
  'status', 'dispatched',
  'channel', ARGV[3],
  'dispatchedAtMs', ARGV[4]
)
redis.call('HDEL', KEYS[1], 'token', 'claimedAtMs', 'leaseUntilMs')
if ARGV[1] == 'window' and tonumber(ARGV[5]) > 0 then
  redis.call('SET', KEYS[2], ARGV[5])
end
return 1
`;

const RELEASE_LUA = `
if redis.call('HGET', KEYS[1], 'status') ~= 'claimed' then
  return 0
end
if redis.call('HGET', KEYS[1], 'token') ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

export class RedisEvalDomainTriggerStore implements IEvalDomainTriggerStore {
  constructor(private readonly redis: RedisClient) {}

  async claim(input: EvalDomainTriggerClaimInput): Promise<EvalDomainTriggerClaimResult> {
    const result = Number(
      await this.redis.eval(
        CLAIM_LUA,
        2,
        EvalDomainTriggerKeys.receipt(input.kind, input.domainId, input.receiptId),
        EvalDomainTriggerKeys.cooldown(input.domainId),
        input.kind,
        input.nowMs.toString(),
        input.token,
        input.leaseMs.toString(),
      ),
    );
    if (result === 1) return { outcome: 'claimed' };
    if (result === 0) return { outcome: 'deduped' };
    if (result === -1) return { outcome: 'overlap' };
    if (result === -2) return { outcome: 'cooldown' };
    throw new Error(`unexpected eval trigger claim result: ${result}`);
  }

  async complete(input: EvalDomainTriggerCompleteInput): Promise<boolean> {
    const result = await this.redis.eval(
      COMPLETE_LUA,
      2,
      EvalDomainTriggerKeys.receipt(input.kind, input.domainId, input.receiptId),
      EvalDomainTriggerKeys.cooldown(input.domainId),
      input.kind,
      input.token,
      input.channel,
      input.nowMs.toString(),
      (input.cooldownUntilMs ?? 0).toString(),
    );
    return Number(result) === 1;
  }

  async release(input: EvalDomainTriggerReceiptRef): Promise<void> {
    await this.redis.eval(
      RELEASE_LUA,
      1,
      EvalDomainTriggerKeys.receipt(input.kind, input.domainId, input.receiptId),
      input.token,
    );
  }
}
