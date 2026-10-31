import type { PawFeelReconciliationCoverage } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';

const COVERAGE_KEY = 'paw-feel:disposition:coverage';

const CoverageSchema = z
  .object({
    coverageStartAt: z.string().datetime({ offset: true }),
    typedCaptureActivatedAt: z.string().datetime({ offset: true }).optional(),
    lastFullScanStartedAt: z.string().datetime({ offset: true }).optional(),
    lastFullScanCompletedAt: z.string().datetime({ offset: true }).optional(),
    lastOverlapCompletedAt: z.string().datetime({ offset: true }).optional(),
    lastSeenTimelineAt: z.string().datetime({ offset: true }).optional(),
    status: z.enum(['uninitialized', 'healthy', 'lagging', 'unavailable']),
    lagMs: z.coerce.number().int().nonnegative().optional(),
    unavailableReason: z.string().min(1).optional(),
  })
  .strict();

const INITIALIZE_LUA = `
redis.call('HSETNX', KEYS[1], 'coverageStartAt', ARGV[1])
redis.call('HSETNX', KEYS[1], 'typedCaptureActivatedAt', ARGV[2])
redis.call('HSETNX', KEYS[1], 'status', 'uninitialized')
return redis.call('HGETALL', KEYS[1])
`;

const SUCCEED_LUA = `
redis.call('HSET', KEYS[1],
  ARGV[1], ARGV[2],
  ARGV[3], ARGV[4],
  'lastSeenTimelineAt', ARGV[5],
  'status', 'healthy',
  'lagMs', '0')
redis.call('HDEL', KEYS[1], 'unavailableReason')
return redis.call('HGETALL', KEYS[1])
`;

export type PawFeelReconciliationKind = 'full' | 'overlap';

export interface IPawFeelReconciliationCoverageStore {
  read(): Promise<PawFeelReconciliationCoverage | null>;
  getOrInitialize(coverageStartAt: string, typedCaptureActivatedAt: string): Promise<PawFeelReconciliationCoverage>;
  recordStarted(kind: PawFeelReconciliationKind, startedAt: string): Promise<PawFeelReconciliationCoverage>;
  recordSucceeded(
    kind: PawFeelReconciliationKind,
    startedAt: string,
    completedAt: string,
    lastSeenTimelineAt: string,
  ): Promise<PawFeelReconciliationCoverage>;
  recordUnavailable(
    kind: PawFeelReconciliationKind,
    attemptedAt: string,
    reason: string,
  ): Promise<PawFeelReconciliationCoverage>;
}

function parseHash(raw: readonly string[]): PawFeelReconciliationCoverage {
  const record: Record<string, string> = {};
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    const value = raw[index + 1];
    if (key !== undefined && value !== undefined) record[key] = value;
  }
  return CoverageSchema.parse(record);
}

async function readHash(redis: RedisClient): Promise<PawFeelReconciliationCoverage> {
  const raw = await redis.hgetall(COVERAGE_KEY);
  return CoverageSchema.parse(raw);
}

export class RedisPawFeelReconciliationCoverageStore implements IPawFeelReconciliationCoverageStore {
  constructor(private readonly redis: RedisClient) {}

  async read(): Promise<PawFeelReconciliationCoverage | null> {
    const raw = await this.redis.hgetall(COVERAGE_KEY);
    return Object.keys(raw).length === 0 ? null : CoverageSchema.parse(raw);
  }

  async getOrInitialize(
    coverageStartAt: string,
    typedCaptureActivatedAt: string,
  ): Promise<PawFeelReconciliationCoverage> {
    const parsedStart = z.string().datetime({ offset: true }).parse(coverageStartAt);
    const parsedActivation = z.string().datetime({ offset: true }).parse(typedCaptureActivatedAt);
    const raw = (await this.redis.eval(INITIALIZE_LUA, 1, COVERAGE_KEY, parsedStart, parsedActivation)) as string[];
    return parseHash(raw);
  }

  async recordStarted(kind: PawFeelReconciliationKind, startedAt: string): Promise<PawFeelReconciliationCoverage> {
    if (kind === 'full') {
      await this.redis.hset(COVERAGE_KEY, 'lastFullScanStartedAt', startedAt);
    }
    return readHash(this.redis);
  }

  async recordSucceeded(
    kind: PawFeelReconciliationKind,
    startedAt: string,
    completedAt: string,
    lastSeenTimelineAt: string,
  ): Promise<PawFeelReconciliationCoverage> {
    const completionField = kind === 'full' ? 'lastFullScanCompletedAt' : 'lastOverlapCompletedAt';
    const startField = kind === 'full' ? 'lastFullScanStartedAt' : 'lastOverlapCompletedAt';
    const startValue = kind === 'full' ? startedAt : completedAt;
    const raw = (await this.redis.eval(
      SUCCEED_LUA,
      1,
      COVERAGE_KEY,
      startField,
      startValue,
      completionField,
      completedAt,
      lastSeenTimelineAt,
    )) as string[];
    return parseHash(raw);
  }

  async recordUnavailable(
    kind: PawFeelReconciliationKind,
    attemptedAt: string,
    reason: string,
  ): Promise<PawFeelReconciliationCoverage> {
    const fields: string[] = ['status', 'unavailable', 'unavailableReason', reason];
    if (kind === 'full') fields.push('lastFullScanStartedAt', attemptedAt);
    await this.redis.hset(COVERAGE_KEY, ...fields);
    return readHash(this.redis);
  }
}

export const PawFeelReconciliationCoverageKey = COVERAGE_KEY;
