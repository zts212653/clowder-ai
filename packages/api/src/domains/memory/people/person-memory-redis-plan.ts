import { z } from 'zod';

export type RedisPlanMutation =
  | { op: 'set'; keyIndex: number; value: string }
  | { op: 'sadd'; keyIndex: number; member: string }
  | { op: 'srem'; keyIndex: number; member: string }
  | { op: 'zadd'; keyIndex: number; member: string; score: number }
  | { op: 'zrem'; keyIndex: number; member: string }
  | { op: 'hdel'; keyIndex: number; member: string }
  | { op: 'del'; keyIndex: number };

export type RedisPlanPrecondition =
  | { kind: 'string'; keyIndex: number; expected: string }
  | { kind: 'zrange'; keyIndex: number; expected: string[] }
  | { kind: 'smembers'; keyIndex: number; expected: string[] }
  | { kind: 'hash_field'; keyIndex: number; member: string; expected: string }
  | { kind: 'zscore'; keyIndex: number; member: string; expected: string };

export type RedisValueType = 'none' | 'string' | 'set' | 'zset' | 'hash' | 'list' | 'stream';
export type CanonicalRedisValueType = Exclude<RedisValueType, 'none'>;

export interface SerializedRedisPlan {
  fenceKeyIndexes: number[];
  expectedTypes: Array<{ keyIndex: number; type: CanonicalRedisValueType; allowNone: boolean }>;
  preconditions: RedisPlanPrecondition[];
  mutations: RedisPlanMutation[];
}

const keyIndexSchema = z.number().int().positive();
const memberSchema = z.string();
const canonicalRedisValueTypeSchema = z.enum(['string', 'set', 'zset', 'hash', 'list', 'stream']);
const redisPlanSchema = z
  .object({
    fenceKeyIndexes: z.array(keyIndexSchema),
    expectedTypes: z.array(
      z
        .object({
          keyIndex: keyIndexSchema,
          type: canonicalRedisValueTypeSchema,
          allowNone: z.boolean(),
        })
        .strict(),
    ),
    preconditions: z.array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('string'), keyIndex: keyIndexSchema, expected: z.string() }).strict(),
        z.object({ kind: z.literal('zrange'), keyIndex: keyIndexSchema, expected: z.array(z.string()) }).strict(),
        z.object({ kind: z.literal('smembers'), keyIndex: keyIndexSchema, expected: z.array(z.string()) }).strict(),
        z
          .object({
            kind: z.literal('hash_field'),
            keyIndex: keyIndexSchema,
            member: memberSchema,
            expected: z.string(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('zscore'),
            keyIndex: keyIndexSchema,
            member: memberSchema,
            expected: z.string(),
          })
          .strict(),
      ]),
    ),
    mutations: z.array(
      z.discriminatedUnion('op', [
        z.object({ op: z.literal('set'), keyIndex: keyIndexSchema, value: z.string() }).strict(),
        z.object({ op: z.literal('sadd'), keyIndex: keyIndexSchema, member: memberSchema }).strict(),
        z.object({ op: z.literal('srem'), keyIndex: keyIndexSchema, member: memberSchema }).strict(),
        z
          .object({
            op: z.literal('zadd'),
            keyIndex: keyIndexSchema,
            member: memberSchema,
            score: z.number().finite(),
          })
          .strict(),
        z.object({ op: z.literal('zrem'), keyIndex: keyIndexSchema, member: memberSchema }).strict(),
        z.object({ op: z.literal('hdel'), keyIndex: keyIndexSchema, member: memberSchema }).strict(),
        z.object({ op: z.literal('del'), keyIndex: keyIndexSchema }).strict(),
      ]),
    ),
  })
  .strict();

export class PersonMemoryRedisPlan {
  readonly keys: string[];
  private readonly keyIndexes = new Map<string, number>();
  private readonly fenceKeyIndexes: number[] = [];
  private readonly expectedTypes: Array<{
    keyIndex: number;
    type: CanonicalRedisValueType;
    allowNone: boolean;
  }> = [];
  private readonly preconditions: RedisPlanPrecondition[] = [];
  private readonly mutations: RedisPlanMutation[] = [];

  constructor(fixedKeys: string[]) {
    this.keys = [];
    for (const key of fixedKeys) this.keyIndex(key);
  }

  keyIndex(key: string): number {
    const existing = this.keyIndexes.get(key);
    if (existing !== undefined) return existing;
    this.keys.push(key);
    const index = this.keys.length;
    this.keyIndexes.set(key, index);
    return index;
  }

  fence(key: string): void {
    this.fenceKeyIndexes.push(this.keyIndex(key));
  }

  expect(key: string, expected: string): void {
    this.expectType(key, 'string', true);
    this.preconditions.push({ kind: 'string', keyIndex: this.keyIndex(key), expected });
  }

  expectZRange(key: string, expected: string[]): void {
    this.expectType(key, 'zset', true);
    this.preconditions.push({ kind: 'zrange', keyIndex: this.keyIndex(key), expected });
  }

  expectSetMembers(key: string, expected: string[]): void {
    this.expectType(key, 'set', true);
    this.preconditions.push({ kind: 'smembers', keyIndex: this.keyIndex(key), expected });
  }

  expectHashField(key: string, member: string, expected: string): void {
    this.expectType(key, 'hash', true);
    this.preconditions.push({ kind: 'hash_field', keyIndex: this.keyIndex(key), member, expected });
  }

  expectZScore(key: string, member: string, expected: string): void {
    this.expectType(key, 'zset', true);
    this.preconditions.push({ kind: 'zscore', keyIndex: this.keyIndex(key), member, expected });
  }

  expectType(key: string, type: CanonicalRedisValueType, allowNone: boolean): void {
    const keyIndex = this.keyIndex(key);
    const prior = this.expectedTypes.find((item) => item.keyIndex === keyIndex);
    if (prior && prior.type !== type) throw new Error(`conflicting Redis type expectation for ${key}`);
    if (prior) {
      prior.allowNone = prior.allowNone && allowNone;
    } else {
      this.expectedTypes.push({ keyIndex, type, allowNone });
    }
  }

  set(key: string, value: string): void {
    this.expectType(key, 'string', true);
    this.mutations.push({ op: 'set', keyIndex: this.keyIndex(key), value });
  }

  sadd(key: string, member: string): void {
    this.expectType(key, 'set', true);
    this.mutations.push({ op: 'sadd', keyIndex: this.keyIndex(key), member });
  }

  srem(key: string, member: string): void {
    this.expectType(key, 'set', true);
    this.mutations.push({ op: 'srem', keyIndex: this.keyIndex(key), member });
  }

  zadd(key: string, score: number, member: string): void {
    this.expectType(key, 'zset', true);
    this.mutations.push({ op: 'zadd', keyIndex: this.keyIndex(key), score, member });
  }

  zrem(key: string, member: string): void {
    this.expectType(key, 'zset', true);
    this.mutations.push({ op: 'zrem', keyIndex: this.keyIndex(key), member });
  }

  hdel(key: string, member: string): void {
    this.expectType(key, 'hash', true);
    this.mutations.push({ op: 'hdel', keyIndex: this.keyIndex(key), member });
  }

  del(key: string, type: CanonicalRedisValueType): void {
    this.expectType(key, type, true);
    this.mutations.push({ op: 'del', keyIndex: this.keyIndex(key) });
  }

  serialize(): string {
    const plan: SerializedRedisPlan = {
      fenceKeyIndexes: this.fenceKeyIndexes,
      expectedTypes: this.expectedTypes,
      preconditions: this.preconditions,
      mutations: this.mutations,
    };
    return JSON.stringify(redisPlanSchema.parse(plan));
  }
}
