import type { PawFeelDutyConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { z } from 'zod';

const DUTY_CONFIG_KEY = 'paw-feel:disposition:duty-config';
const SYSTEM_THREAD_ID = 'thread_eval_friction' as const;

const CvoPrincipalSchema = z.object({ kind: z.literal('cvo'), id: z.string().trim().min(1) }).strict();
const DutyUpdateSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    primaryCatId: z.string().trim().min(1),
    backupCatId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.primaryCatId === value.backupCatId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'primary and backup duty cats must differ' });
    }
  });

const DutyHashSchema = z
  .object({
    systemThreadId: z.literal(SYSTEM_THREAD_ID),
    primaryCatId: z.string().min(1).optional(),
    backupCatId: z.string().min(1).optional(),
    version: z.coerce.number().int().positive(),
    updatedAt: z.string().datetime({ offset: true }),
    updatedBy: z.string().min(1),
  })
  .strict();

const UPDATE_LUA = `
local current = tonumber(redis.call('HGET', KEYS[1], 'version') or '0')
if current ~= tonumber(ARGV[1]) then
  return {-1, current}
end

local next = current + 1
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1],
  'systemThreadId', 'thread_eval_friction',
  'version', tostring(next),
  'updatedAt', ARGV[4],
  'updatedBy', ARGV[5])
if ARGV[2] ~= '' then redis.call('HSET', KEYS[1], 'primaryCatId', ARGV[2]) end
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'backupCatId', ARGV[3]) end
return {1, next}
`;

export type PawFeelDutyConfigStoreErrorCode = 'unauthorized' | 'invalid_config' | 'version_conflict';

export class PawFeelDutyConfigStoreError extends Error {
  constructor(
    readonly code: PawFeelDutyConfigStoreErrorCode,
    message: string,
    readonly actualVersion?: number,
  ) {
    super(message);
    this.name = 'PawFeelDutyConfigStoreError';
  }
}

function parseHash(raw: Record<string, string>): PawFeelDutyConfig {
  return DutyHashSchema.parse(raw);
}

export interface IPawFeelDutyConfigStore {
  read(): Promise<PawFeelDutyConfig | null>;
  update(principal: unknown, input: unknown): Promise<PawFeelDutyConfig>;
}

export class RedisPawFeelDutyConfigStore implements IPawFeelDutyConfigStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async read(): Promise<PawFeelDutyConfig | null> {
    const raw = await this.redis.hgetall(DUTY_CONFIG_KEY);
    return Object.keys(raw).length === 0 ? null : parseHash(raw);
  }

  async update(principal: unknown, input: unknown): Promise<PawFeelDutyConfig> {
    const actor = CvoPrincipalSchema.safeParse(principal);
    if (!actor.success) {
      throw new PawFeelDutyConfigStoreError('unauthorized', 'only the operator may assign paw-feel duty');
    }
    const command = DutyUpdateSchema.safeParse(input);
    if (!command.success) {
      throw new PawFeelDutyConfigStoreError('invalid_config', command.error.message);
    }
    const updatedAt = z.string().datetime({ offset: true }).parse(this.now());
    const result = (await this.redis.eval(
      UPDATE_LUA,
      1,
      DUTY_CONFIG_KEY,
      command.data.expectedVersion.toString(),
      command.data.primaryCatId,
      command.data.backupCatId,
      updatedAt,
      actor.data.id,
    )) as [number, number];
    if (result[0] === -1) {
      throw new PawFeelDutyConfigStoreError(
        'version_conflict',
        `duty config expected version ${command.data.expectedVersion}, actual ${result[1]}`,
        result[1],
      );
    }
    const stored = await this.read();
    if (!stored) throw new Error('duty config update did not become durable');
    return stored;
  }
}

export const PawFeelDutyConfigKey = DUTY_CONFIG_KEY;
