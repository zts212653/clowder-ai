import type { MeetingIntake } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  AcceptMeetingIntakeInput,
  AcceptMeetingIntakeResult,
  MeetingIntakeCasResult,
  MeetingIntakeSettlement,
  MeetingIntakeStore,
} from './MeetingIntakeStore.js';
import { parseMeetingIntake } from './meeting-intake-codec.js';
import { SignalIntakeKeys } from './signal-intake-keys.js';

const ACCEPT_LUA = `
local settlement = redis.call('get', KEYS[1])
if settlement then
  local decoded = cjson.decode(settlement)
  if decoded.canonicalDigest ~= ARGV[1] then return {'idempotency_conflict'} end
  local intake = redis.call('get', KEYS[3])
  if not intake then return {'corrupt'} end
  return {'duplicate', intake}
end
if redis.call('exists', KEYS[2]) == 1 then return {'source_identity_conflict'} end
if redis.call('exists', KEYS[3]) == 1 then return {'intake_id_collision'} end
redis.call('set', KEYS[1], ARGV[2])
redis.call('set', KEYS[2], ARGV[3])
redis.call('set', KEYS[3], ARGV[4])
redis.call('sadd', KEYS[4], ARGV[3])
return {'accepted', ARGV[4]}
`.trim();

const CAS_LUA = `
local current = redis.call('get', KEYS[1])
if not current then return {'missing'} end
local decoded = cjson.decode(current)
if decoded.revision ~= tonumber(ARGV[1]) then return {'revision_conflict', current} end
redis.call('set', KEYS[1], ARGV[2])
return {'written', ARGV[2]}
`.trim();

export class RedisMeetingIntakeStore implements MeetingIntakeStore {
  constructor(private readonly redis: RedisClient) {}

  async accept(input: AcceptMeetingIntakeInput): Promise<AcceptMeetingIntakeResult> {
    const intakeKey = SignalIntakeKeys.intake(input.intake.intakeId);
    const settlement = JSON.stringify({
      canonicalDigest: input.intake.ingress.canonicalDigest,
      intakeId: input.intake.intakeId,
      publicationId: input.intake.ingress.publicationId,
    });
    const result = (await this.redis.eval(
      ACCEPT_LUA,
      4,
      SignalIntakeKeys.settlement(input.settlementKey),
      SignalIntakeKeys.sourceIdentity(input.sourceIdentityKey),
      intakeKey,
      SignalIntakeKeys.allIntakes(),
      input.intake.ingress.canonicalDigest,
      settlement,
      input.intake.intakeId,
      JSON.stringify(input.intake),
    )) as string[];
    const [outcome, raw] = result;
    if (outcome === 'accepted' || outcome === 'duplicate') {
      if (!raw) throw new Error('Redis meeting intake admission omitted intake payload');
      return { outcome, intake: parseMeetingIntake(raw) };
    }
    if (outcome === 'idempotency_conflict' || outcome === 'source_identity_conflict') return { outcome };
    throw new Error(`Redis meeting intake admission invariant failed: ${outcome}`);
  }

  async get(intakeId: string): Promise<MeetingIntake | null> {
    const raw = await this.redis.get(SignalIntakeKeys.intake(intakeId));
    return raw ? parseMeetingIntake(raw) : null;
  }

  async lookupSettlement(settlementKey: string): Promise<MeetingIntakeSettlement | null> {
    const raw = await this.redis.get(SignalIntakeKeys.settlement(settlementKey));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Redis meeting intake settlement is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Redis meeting intake settlement is malformed');
    }
    const settlement = parsed as Record<string, unknown>;
    if (
      typeof settlement.canonicalDigest !== 'string' ||
      typeof settlement.intakeId !== 'string' ||
      typeof settlement.publicationId !== 'string'
    ) {
      throw new Error('Redis meeting intake settlement is malformed');
    }
    const intake = await this.get(settlement.intakeId);
    if (
      !intake ||
      intake.ingress.canonicalDigest !== settlement.canonicalDigest ||
      intake.ingress.publicationId !== settlement.publicationId
    ) {
      throw new Error('Redis meeting intake settlement is inconsistent with its intake');
    }
    return {
      canonicalDigest: settlement.canonicalDigest,
      intakeId: settlement.intakeId,
      publicationId: settlement.publicationId,
    };
  }

  async list(): Promise<MeetingIntake[]> {
    const intakeIds = await this.redis.smembers(SignalIntakeKeys.allIntakes());
    if (intakeIds.length === 0) return [];
    const raw = await this.redis.mget(...intakeIds.map(SignalIntakeKeys.intake));
    return raw.filter((value): value is string => value !== null).map(parseMeetingIntake);
  }

  async compareAndSet(
    intakeId: string,
    expectedRevision: number,
    next: MeetingIntake,
  ): Promise<MeetingIntakeCasResult> {
    if (next.intakeId !== intakeId || next.revision !== expectedRevision + 1) {
      throw new Error('meeting intake CAS candidate has invalid identity or revision');
    }
    const result = (await this.redis.eval(
      CAS_LUA,
      1,
      SignalIntakeKeys.intake(intakeId),
      String(expectedRevision),
      JSON.stringify(next),
    )) as string[];
    const [outcome, raw] = result;
    if (outcome === 'missing') return { outcome };
    if (!raw) throw new Error('Redis meeting intake CAS omitted intake payload');
    if (outcome === 'written' || outcome === 'revision_conflict') {
      return { outcome, intake: parseMeetingIntake(raw) };
    }
    throw new Error(`unexpected Redis meeting intake CAS outcome: ${outcome}`);
  }
}
