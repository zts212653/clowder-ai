/**
 * F257 V1 — DeviationEventLog: append-only, owner-scoped deviation ledger.
 *
 * Storage contract single source of truth: redesign §3.1 「DeviationEventLog
 * 存储规格」(TTL=0 / 分页不静默截断 / owner 进索引与查询授权; fact 层与本账本
 * 两层不得合并) + T-C §3.6 (claim+append 同一 Lua / 幂等 idempotencyKey).
 * Lua single-script pattern follows BallCustodyEventLog APPEND_LUA precedent.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { type DeviationEvent, V1_ALLOWED_UNIT_TYPES, validateDeviationEvent } from './deviation-event.js';

export type AppendOutcome = 'appended' | 'incident_claimed' | 'idempotent_replay';

export interface AppendResult {
  outcome: AppendOutcome;
  /** 'appended' → new event; 'incident_claimed'/'idempotent_replay' → the previously stored event */
  eventId: string;
}

export interface DeviationQueryInput {
  ownerUserId: string;
  /** inclusive epoch ms */
  fromMs?: number;
  /** inclusive epoch ms */
  toMs?: number;
  /** page size; more pages are signalled via nextCursor — never silently truncated */
  limit?: number;
  /** opaque cursor from a previous page */
  cursor?: string;
}

export interface DeviationQueryResult {
  events: DeviationEvent[];
  nextCursor: string | null;
  /** indexed ids whose bodies are missing — surfaced, never silently skipped */
  missingBodies: string[];
}

export interface IDeviationEventLog {
  /** Validates (§3.1) then atomically claims + appends (T-C). Invalid events throw — await-append, no fail-open (§4.5-2). */
  append(event: DeviationEvent, opts?: { idempotencyKey?: string }): Promise<AppendResult>;
  query(input: DeviationQueryInput): Promise<DeviationQueryResult>;
  /** Complete aggregation over [fromMs, toMs] inclusive — independent of pagination. */
  countInWindow(ownerUserId: string, fromMs: number, toMs: number): Promise<number>;
}

/** All owner-namespaced; TTL is never set on any of these keys (§3.1 / 铁律#5). */
export const DeviationKeys = {
  /** HASH eventId → event JSON */
  events: (owner: string) => `deviation:evt:${owner}`,
  /** ZSET score=timestamp member=eventId */
  index: (owner: string) => `deviation:idx:${owner}`,
  /** HASH incidentKey → eventId (T-C claim) */
  claims: (owner: string) => `deviation:claims:${owner}`,
  /** HASH scoped idempotencyKey → eventId (T-C 幂等) */
  idempotency: (owner: string) => `deviation:idem:${owner}`,
} as const;

// KEYS[1]=claims KEYS[2]=events KEYS[3]=index KEYS[4]=idempotency
// ARGV[1]=incidentKey ARGV[2]=eventId ARGV[3]=json ARGV[4]=timestamp ARGV[5]=idemKey ('' = none)
// One script ⇒ claim + append are atomic; a failed append leaves no phantom claim (T-C).
const APPEND_LUA = `
if ARGV[5] ~= '' then
  local prior = redis.call('HGET', KEYS[4], ARGV[5])
  if prior then
    return {'idempotent_replay', prior}
  end
end
local claimed = redis.call('HGET', KEYS[1], ARGV[1])
if claimed then
  return {'incident_claimed', claimed}
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('ZADD', KEYS[3], ARGV[4], ARGV[2])
if ARGV[5] ~= '' then
  redis.call('HSET', KEYS[4], ARGV[5], ARGV[2])
end
return {'appended', ARGV[2]}
`;

const DEFAULT_PAGE_LIMIT = 1000;
const CURSOR_SEP = ':';

interface IndexEntry {
  id: string;
  score: number;
}

function encodeCursor(entry: IndexEntry): string {
  return `${entry.score}${CURSOR_SEP}${entry.id}`;
}

function decodeCursor(cursor: string): IndexEntry | null {
  const sep = cursor.indexOf(CURSOR_SEP);
  if (sep <= 0) return null;
  const score = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (!Number.isFinite(score) || !id) return null;
  return { id, score };
}

export class RedisDeviationEventLog implements IDeviationEventLog {
  constructor(
    private readonly redis: RedisClient,
    private readonly allowedUnitTypes: ReadonlySet<string> = V1_ALLOWED_UNIT_TYPES,
  ) {}

  async append(event: DeviationEvent, opts?: { idempotencyKey?: string }): Promise<AppendResult> {
    const errors = validateDeviationEvent(event, this.allowedUnitTypes);
    if (errors.length > 0) {
      throw new Error(`invalid deviation event: ${errors.join('; ')}`);
    }
    const owner = event.ownerUserId;
    const [outcome, eventId] = (await this.redis.eval(
      APPEND_LUA,
      4,
      DeviationKeys.claims(owner),
      DeviationKeys.events(owner),
      DeviationKeys.index(owner),
      DeviationKeys.idempotency(owner),
      event.incidentKey,
      event.eventId,
      JSON.stringify(event),
      String(event.timestamp),
      opts?.idempotencyKey ?? '',
    )) as [AppendOutcome, string];
    return { outcome, eventId };
  }

  async query(input: DeviationQueryInput): Promise<DeviationQueryResult> {
    const limit = Math.max(1, input.limit ?? DEFAULT_PAGE_LIMIT);
    const toArg = input.toMs !== undefined ? String(input.toMs) : '+inf';
    const indexKey = DeviationKeys.index(input.ownerUserId);

    let boundary = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !boundary) {
      throw new Error(`malformed cursor: ${input.cursor}`);
    }

    // Cursor walk: refetch from the boundary score (inclusive) and skip
    // already-emitted members via (score, member-lex) ordering — Redis orders
    // equal-score members lexicographically, so the boundary is a total order.
    // Immune to offset drift from concurrent appends.
    const selected: IndexEntry[] = [];
    let chunk = Math.min(limit + 16, 4096);
    for (;;) {
      const min = boundary ? String(boundary.score) : String(input.fromMs ?? 0);
      const raw = await this.redis.zrangebyscore(indexKey, min, toArg, 'WITHSCORES', 'LIMIT', 0, chunk);
      const entries: IndexEntry[] = [];
      for (let i = 0; i < raw.length; i += 2) {
        entries.push({ id: raw[i], score: Number(raw[i + 1]) });
      }
      const fresh = boundary
        ? entries.filter((e) => e.score > boundary!.score || (e.score === boundary!.score && e.id > boundary!.id))
        : entries;
      for (const e of fresh) {
        selected.push(e);
        boundary = e;
        if (selected.length > limit) break;
      }
      if (selected.length > limit) break;
      if (entries.length < chunk) break; // range exhausted
      if (fresh.length === 0) chunk = Math.min(chunk * 4, 4096); // chunk was all pre-boundary ties → widen
    }

    const hasMore = selected.length > limit;
    const page = hasMore ? selected.slice(0, limit) : selected;
    if (page.length === 0) {
      return { events: [], nextCursor: null, missingBodies: [] };
    }

    const bodies = await this.redis.hmget(DeviationKeys.events(input.ownerUserId), ...page.map((e) => e.id));
    const events: DeviationEvent[] = [];
    const missingBodies: string[] = [];
    for (let i = 0; i < page.length; i += 1) {
      const body = bodies[i];
      if (body === null || body === undefined) {
        missingBodies.push(page[i].id);
        continue;
      }
      events.push(JSON.parse(body) as DeviationEvent);
    }
    const last = page[page.length - 1];
    return { events, nextCursor: hasMore ? encodeCursor(last) : null, missingBodies };
  }

  async countInWindow(ownerUserId: string, fromMs: number, toMs: number): Promise<number> {
    return this.redis.zcount(DeviationKeys.index(ownerUserId), fromMs, toMs);
  }
}
