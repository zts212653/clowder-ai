import type { SuggestionEventType } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';
import { ConciergeKeys } from '../concierge/concierge-keys.js';
import { WATCHER_OUTPUT_FENCE_LUA, type WatcherOutputFence } from '../concierge/watcher/watcher-output-fence.js';
import {
  type CreateSuggestionResult,
  HIDDEN_FIELD_SEPARATOR,
  type HiddenKindEntry,
  hiddenField,
  type ISuggestionStore,
  parseRecord,
  type SuggestionCounts,
  SuggestionKeys,
  type SuggestionRecord,
  type SwapSuggestionResult,
  tracksAsOpen,
  tracksOnDesk,
} from './SuggestionStore.js';

/**
 * KEYS: message, record, thread, userKind, userKinds, counts, open, desk[, watcher config, thread detail].
 * ARGV: id, json, createdAt, kind, countEvent ('' = none), openScore ('' = not open), onDesk ('1' / '')[, fence].
 * The watcher fence reads the last two KEYS and the last ARGV, so it is appended after the desk slot.
 */
const CREATE_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then return {'message_taken', existing} end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
redis.call('SADD', KEYS[5], ARGV[4])
if ARGV[5] ~= '' then redis.call('HINCRBY', KEYS[6], ARGV[5], 1) end
if ARGV[6] ~= '' then redis.call('ZADD', KEYS[7], ARGV[6], ARGV[1]) end
if ARGV[7] ~= '' then redis.call('ZADD', KEYS[8], ARGV[3], ARGV[1]) end
return {'created'}
`;

/**
 * KEYS: record, counts, open, desk.
 * ARGV: expectedRevision, json, countEvent ('' = none), openScore ('' = leave open set), id, deskScore ('' = off the desk).
 */
const SWAP_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return 'missing' end
local ok, decoded = pcall(cjson.decode, current)
if not ok or type(decoded) ~= 'table' then return 'conflict' end
if tonumber(decoded.revision) ~= tonumber(ARGV[1]) then return 'conflict' end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] ~= '' then redis.call('HINCRBY', KEYS[2], ARGV[3], 1) end
if ARGV[4] ~= '' then redis.call('ZADD', KEYS[3], ARGV[4], ARGV[5]) else redis.call('ZREM', KEYS[3], ARGV[5]) end
if ARGV[6] ~= '' then redis.call('ZADD', KEYS[4], ARGV[6], ARGV[5]) else redis.call('ZREM', KEYS[4], ARGV[5]) end
return 'swapped'
`;

const openScore = (record: SuggestionRecord) => (tracksAsOpen(record) ? String(record.expiresAt) : '');
const deskScore = (record: SuggestionRecord) => (tracksOnDesk(record) ? String(record.createdAt) : '');

export class RedisSuggestionStore implements ISuggestionStore {
  constructor(private readonly redis: RedisClient) {}

  async create(
    record: SuggestionRecord,
    countEvent?: SuggestionEventType,
    fence?: WatcherOutputFence,
  ): Promise<CreateSuggestionResult> {
    const reply = (await this.redis.eval(
      (fence ? WATCHER_OUTPUT_FENCE_LUA : '') + CREATE_LUA,
      fence ? 10 : 8,
      SuggestionKeys.message(record.messageId),
      SuggestionKeys.record(record.id),
      SuggestionKeys.thread(record.threadId),
      SuggestionKeys.userKind(record.userId, record.kind),
      SuggestionKeys.userKinds(record.userId),
      SuggestionKeys.counts(record.userId, record.kind),
      SuggestionKeys.open(record.userId, record.kind),
      SuggestionKeys.desk(record.userId),
      ...(fence ? [ConciergeKeys.config(fence.userId), ThreadKeys.detail(fence.threadId)] : []),
      record.id,
      JSON.stringify(record),
      String(record.createdAt),
      record.kind,
      countEvent ?? '',
      openScore(record),
      tracksOnDesk(record) ? '1' : '',
      ...(fence ? [JSON.stringify(fence)] : []),
    )) as [string, string?];
    if (reply[0] === 'message_taken') return { kind: 'message_taken', existingId: reply[1] ?? '' };
    return { kind: 'created' };
  }

  async get(id: string): Promise<SuggestionRecord | null> {
    return parseRecord(await this.redis.get(SuggestionKeys.record(id)));
  }

  async swap(
    next: SuggestionRecord,
    expectedRevision: number,
    countEvent?: SuggestionEventType,
  ): Promise<SwapSuggestionResult> {
    if (next.revision !== expectedRevision + 1) throw new Error('next.revision must be expectedRevision + 1');
    const reply = (await this.redis.eval(
      SWAP_LUA,
      4,
      SuggestionKeys.record(next.id),
      SuggestionKeys.counts(next.userId, next.kind),
      SuggestionKeys.open(next.userId, next.kind),
      SuggestionKeys.desk(next.userId),
      String(expectedRevision),
      JSON.stringify(next),
      countEvent ?? '',
      openScore(next),
      next.id,
      deskScore(next),
    )) as string;
    if (reply === 'swapped') return { kind: 'swapped' };
    if (reply === 'missing') return { kind: 'missing' };
    return { kind: 'conflict' };
  }

  private async loadMany(ids: string[]): Promise<SuggestionRecord[]> {
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(...ids.map((id) => SuggestionKeys.record(id)));
    return raws.map(parseRecord).filter((record): record is SuggestionRecord => record !== null);
  }

  async listThread(threadId: string, limit: number): Promise<SuggestionRecord[]> {
    return this.loadMany(await this.redis.zrevrange(SuggestionKeys.thread(threadId), 0, Math.max(0, limit - 1)));
  }

  async listUserKind(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]> {
    return this.loadMany(await this.redis.zrevrange(SuggestionKeys.userKind(userId, kind), 0, Math.max(0, limit - 1)));
  }

  async listUserKinds(userId: string): Promise<string[]> {
    return (await this.redis.smembers(SuggestionKeys.userKinds(userId))).sort();
  }

  async kindCounts(userId: string, kind: string): Promise<SuggestionCounts> {
    const raw = await this.redis.hgetall(SuggestionKeys.counts(userId, kind));
    return Object.fromEntries(Object.entries(raw).map(([type, value]) => [type, Number(value) || 0]));
  }

  async listOpenDue(userId: string, kind: string, now: number, limit: number): Promise<SuggestionRecord[]> {
    const ids = await this.redis.zrangebyscore(SuggestionKeys.open(userId, kind), '-inf', now, 'LIMIT', 0, limit);
    return this.loadMany(ids);
  }

  async countOpen(userId: string, kind: string): Promise<number> {
    return this.redis.zcard(SuggestionKeys.open(userId, kind));
  }

  async listOpen(userId: string, kind: string, limit: number): Promise<SuggestionRecord[]> {
    return this.loadMany(await this.redis.zrevrange(SuggestionKeys.open(userId, kind), 0, Math.max(0, limit - 1)));
  }

  async listDesk(userId: string, limit: number): Promise<SuggestionRecord[]> {
    return this.loadMany(await this.redis.zrange(SuggestionKeys.desk(userId), 0, Math.max(0, limit - 1)));
  }

  async hide(userId: string, entry: HiddenKindEntry): Promise<void> {
    await this.redis.hset(
      SuggestionKeys.hidden(userId),
      hiddenField(entry.catId, entry.kind),
      JSON.stringify({ hiddenAt: entry.hiddenAt, byline: entry.byline }),
    );
  }

  async unhide(userId: string, catId: string, kind: string): Promise<boolean> {
    return (await this.redis.hdel(SuggestionKeys.hidden(userId), hiddenField(catId, kind))) > 0;
  }

  async listHidden(userId: string): Promise<HiddenKindEntry[]> {
    const all = await this.redis.hgetall(SuggestionKeys.hidden(userId));
    const entries: HiddenKindEntry[] = [];
    for (const [field, raw] of Object.entries(all)) {
      const [catId, kind] = field.split(HIDDEN_FIELD_SEPARATOR);
      if (!catId || !kind) continue;
      try {
        const value = JSON.parse(raw) as { hiddenAt?: number; byline?: string };
        entries.push({
          catId,
          kind,
          hiddenAt: typeof value.hiddenAt === 'number' ? value.hiddenAt : 0,
          byline: value.byline === 'watcher' ? 'watcher' : 'cat',
        });
      } catch {
        // A malformed row is skipped rather than hiding every other row from the settings page.
      }
    }
    return entries.sort((a, b) => b.hiddenAt - a.hiddenAt);
  }

  async isHidden(userId: string, catId: string, kind: string): Promise<boolean> {
    return (await this.redis.hexists(SuggestionKeys.hidden(userId), hiddenField(catId, kind))) === 1;
  }
}
