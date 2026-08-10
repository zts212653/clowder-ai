import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  SourceAccessLeaseClaimResult,
  SourceAccessLeaseRecord,
  SourceAccessLeaseStore,
} from './SourceAccessLeaseService.js';
import { SignalIntakeKeys } from './signal-intake-keys.js';

const CLAIM_LUA = `
local raw = redis.call('get', KEYS[1])
if not raw then return {'not_found'} end
local record = cjson.decode(raw)
if record.intakeId ~= ARGV[1] or record.principalId ~= ARGV[2] or record.purpose ~= ARGV[3] then
  return {'scope_mismatch'}
end
if record.state == 'revoked' then return {'revoked'} end
if record.state == 'consumed' then return {'consumed'} end
if record.expiresAt <= tonumber(ARGV[4]) then return {'expired'} end
record.state = 'consumed'
local next = cjson.encode(record)
redis.call('set', KEYS[1], next, 'KEEPTTL')
return {'claimed', next}
`.trim();

const REVOKE_LUA = `
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.state ~= 'issued' then return 0 end
record.state = 'revoked'
redis.call('set', KEYS[1], cjson.encode(record), 'KEEPTTL')
return 1
`.trim();

function parse(raw: string): SourceAccessLeaseRecord {
  const value = JSON.parse(raw) as SourceAccessLeaseRecord;
  if (
    !value ||
    typeof value.grantHash !== 'string' ||
    typeof value.intakeId !== 'string' ||
    typeof value.principalId !== 'string' ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new Error('source access lease record is corrupt');
  }
  return value;
}

export class RedisSourceAccessLeaseStore implements SourceAccessLeaseStore {
  constructor(private readonly redis: RedisClient) {}

  async create(record: SourceAccessLeaseRecord): Promise<void> {
    const retentionMs = Math.max(1, record.expiresAt - record.issuedAt + 60_000);
    const result = await this.redis.set(
      SignalIntakeKeys.sourceGrant(record.grantHash),
      JSON.stringify(record),
      'PX',
      retentionMs,
      'NX',
    );
    if (result !== 'OK') throw new Error('source access grant collision');
  }

  async claim(
    grantHash: string,
    scope: Pick<SourceAccessLeaseRecord, 'intakeId' | 'principalId' | 'purpose'>,
    now: number,
  ): Promise<SourceAccessLeaseClaimResult> {
    const result = (await this.redis.eval(
      CLAIM_LUA,
      1,
      SignalIntakeKeys.sourceGrant(grantHash),
      scope.intakeId,
      scope.principalId,
      scope.purpose,
      String(now),
    )) as string[];
    const [outcome, raw] = result;
    if (outcome === 'claimed') {
      if (!raw) throw new Error('Redis source access claim omitted lease payload');
      return { outcome, record: parse(raw) };
    }
    if (
      outcome === 'not_found' ||
      outcome === 'scope_mismatch' ||
      outcome === 'expired' ||
      outcome === 'revoked' ||
      outcome === 'consumed'
    )
      return { outcome };
    throw new Error(`unexpected Redis source access claim outcome: ${outcome}`);
  }

  async revoke(grantHash: string): Promise<void> {
    await this.redis.eval(REVOKE_LUA, 1, SignalIntakeKeys.sourceGrant(grantHash));
  }
}
