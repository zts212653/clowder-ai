/**
 * Redis Community Issue Store (F168)
 *
 * Redis 数据结构:
 *   community-issue:{id}                       → Hash (issue 详情)
 *   community-issues:repo:{repo}               → Sorted Set (score=updatedAt)
 *   community-issues:all                       → Sorted Set (score=updatedAt)
 *   community-issue:lookup:{repo}:{number}     → String (id, dedup)
 *
 * TTL 默认 0 (persistent, 铁律 #5).
 */

import type { CommunityIssueItem, CreateCommunityIssueInput, UpdateCommunityIssueInput } from '@cat-cafe/shared';
import { generateId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ICommunityIssueStore } from '../ports/CommunityIssueStore.js';
import { CommunityIssueKeys } from '../redis-keys/community-issue-keys.js';

const DEFAULT_TTL = 0;

const CREATE_IF_NOT_EXISTS_LUA = `
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX')
if not acquired then
  return 0
end
redis.call('HSET', KEYS[2], unpack(ARGV, 4))
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[2], ARGV[1])
local ttl = tonumber(ARGV[3])
if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
end
return 1
`;

const HSET_IF_HAS_ID_LUA = `
if redis.call('HEXISTS', KEYS[1], 'id') == 0 then
  return 0
end
redis.call('HSET', KEYS[1], unpack(ARGV))
return 1
`;

const DELETE_ISSUE_LUA = `
local detail = KEYS[1]
local repoSet = KEYS[2]
local allSet = KEYS[3]
local lookupKey = KEYS[4]
local id = ARGV[1]
local existed = redis.call('DEL', detail)
redis.call('ZREM', repoSet, id)
redis.call('ZREM', allSet, id)
redis.call('DEL', lookupKey)
return existed
`;

export class RedisCommunityIssueStore implements ICommunityIssueStore {
  private readonly ttl: number;

  constructor(
    private readonly redis: RedisClient,
    options?: { ttlSeconds?: number },
  ) {
    this.ttl = options?.ttlSeconds ?? DEFAULT_TTL;
  }

  async create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    const id = generateId();
    const now = Date.now();
    const item: CommunityIssueItem = {
      id,
      repo: input.repo,
      issueNumber: input.issueNumber,
      issueType: input.issueType,
      title: input.title,
      state: 'unreplied',
      replyState: 'unreplied',
      assignedThreadId: null,
      assignedCatId: null,
      linkedPrNumbers: [],
      directionCard: null,
      ownerDecision: null,
      relatedFeature: null,
      lastActivity: { at: now, event: 'created' },
      createdAt: now,
      updatedAt: now,
    };

    const flat = this.serialize(item);
    const hashArgs = Object.entries(flat).flat();

    const result = await this.redis.eval(
      CREATE_IF_NOT_EXISTS_LUA,
      4,
      CommunityIssueKeys.lookup(input.repo, input.issueNumber),
      CommunityIssueKeys.detail(id),
      CommunityIssueKeys.repo(input.repo),
      CommunityIssueKeys.all,
      id,
      now,
      this.ttl,
      ...hashArgs,
    );

    if (result === 0) return null;
    return item;
  }

  async get(id: string): Promise<CommunityIssueItem | null> {
    const raw = await this.redis.hgetall(CommunityIssueKeys.detail(id));
    if (!raw || !raw.id) return null;
    return this.hydrate(raw);
  }

  async getByRepoAndNumber(repo: string, issueNumber: number): Promise<CommunityIssueItem | null> {
    const id = await this.redis.get(CommunityIssueKeys.lookup(repo, issueNumber));
    if (!id) return null;
    return this.get(id);
  }

  async listByRepo(repo: string): Promise<CommunityIssueItem[]> {
    const ids = await this.redis.zrevrange(CommunityIssueKeys.repo(repo), 0, -1);
    return this.hydrateMany(ids);
  }

  async listAll(): Promise<CommunityIssueItem[]> {
    const ids = await this.redis.zrevrange(CommunityIssueKeys.all, 0, -1);
    return this.hydrateMany(ids);
  }

  async update(id: string, input: UpdateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const now = Date.now();
    const merged: CommunityIssueItem = {
      ...existing,
      ...input,
      linkedPrNumbers: input.linkedPrNumbers ? [...input.linkedPrNumbers] : existing.linkedPrNumbers,
      updatedAt: now,
    };

    const flat = this.serialize(merged);
    const args = Object.entries(flat).flat();
    await this.redis.eval(HSET_IF_HAS_ID_LUA, 1, CommunityIssueKeys.detail(id), ...args);

    const repoKey = CommunityIssueKeys.repo(existing.repo);
    const allKey = CommunityIssueKeys.all;
    const pipeline = this.redis.pipeline();
    pipeline.zadd(repoKey, now, id);
    pipeline.zadd(allKey, now, id);
    await pipeline.exec();

    return merged;
  }

  async delete(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;

    const result = await this.redis.eval(
      DELETE_ISSUE_LUA,
      4,
      CommunityIssueKeys.detail(id),
      CommunityIssueKeys.repo(existing.repo),
      CommunityIssueKeys.all,
      CommunityIssueKeys.lookup(existing.repo, existing.issueNumber),
      id,
    );
    return result === 1;
  }

  private serialize(item: CommunityIssueItem): Record<string, string | number> {
    return {
      id: item.id,
      repo: item.repo,
      issueNumber: item.issueNumber,
      issueType: item.issueType,
      title: item.title,
      state: item.state,
      replyState: item.replyState,
      consensusState: item.consensusState ?? '',
      assignedThreadId: item.assignedThreadId ?? '',
      assignedCatId: item.assignedCatId ?? '',
      linkedPrNumbers: JSON.stringify(item.linkedPrNumbers),
      directionCard: item.directionCard ? JSON.stringify(item.directionCard) : '',
      ownerDecision: item.ownerDecision ?? '',
      relatedFeature: item.relatedFeature ?? '',
      lastActivityAt: item.lastActivity.at,
      lastActivityEvent: item.lastActivity.event,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private hydrate(raw: Record<string, string>): CommunityIssueItem {
    return {
      id: raw.id,
      repo: raw.repo,
      issueNumber: Number(raw.issueNumber),
      issueType: raw.issueType as CommunityIssueItem['issueType'],
      title: raw.title,
      state: raw.state as CommunityIssueItem['state'],
      replyState: raw.replyState as CommunityIssueItem['replyState'],
      consensusState: raw.consensusState ? (raw.consensusState as CommunityIssueItem['consensusState']) : undefined,
      assignedThreadId: raw.assignedThreadId || null,
      assignedCatId: raw.assignedCatId || null,
      linkedPrNumbers: raw.linkedPrNumbers ? JSON.parse(raw.linkedPrNumbers) : [],
      directionCard: raw.directionCard ? JSON.parse(raw.directionCard) : null,
      ownerDecision: raw.ownerDecision ? (raw.ownerDecision as CommunityIssueItem['ownerDecision']) : null,
      relatedFeature: raw.relatedFeature || null,
      lastActivity: {
        at: Number(raw.lastActivityAt),
        event: raw.lastActivityEvent,
      },
      createdAt: Number(raw.createdAt),
      updatedAt: Number(raw.updatedAt),
    };
  }

  private async hydrateMany(ids: string[]): Promise<CommunityIssueItem[]> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(CommunityIssueKeys.detail(id));
    }
    const results = await pipeline.exec();
    const items: CommunityIssueItem[] = [];
    if (results) {
      for (const [err, raw] of results) {
        if (!err && raw && typeof raw === 'object' && (raw as any).id) {
          items.push(this.hydrate(raw as Record<string, string>));
        }
      }
    }
    return items;
  }
}
