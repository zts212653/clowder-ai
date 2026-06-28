/**
 * F222: Redis-backed FrustrationIssueStore.
 *
 * Data structures (all auto-prefixed by ioredis keyPrefix):
 * - Hash   frustration-issue:{issueId}           — issue fields
 * - ZSet   frustration-issues:thread:{threadId}   — issues by thread (score=createdAt)
 * - ZSet   frustration-issues:user:{userId}       — all issues for user (score=createdAt)
 * - ZSet   frustration-issues:confirmed:{userId}  — confirmed issues (score=confirmedAt)
 * - ZSet   frustration-issues:draft:{userId}      — draft issues (score=createdAt)
 *
 * Iron Law #5 (LL-048): user-visible state defaults to persistent (no TTL).
 */

import type { CreateFrustrationIssueInput, FrustrationIssue, FrustrationIssueStatus } from '@cat-cafe/shared';
import { createFrustrationIssue } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ConfirmIssueInput, IFrustrationIssueStore } from '../ports/FrustrationIssueStore.js';
import { FrustrationIssueKeys } from '../redis-keys/frustration-issue-keys.js';

const DEFAULT_LIST_LIMIT = 100;

// ── Serialization ──────────────────────────────────────────────

function serialize(issue: FrustrationIssue): string[] {
  const pairs: string[] = [
    'issueId',
    issue.issueId,
    'status',
    issue.status,
    'threadId',
    issue.threadId,
    'userId',
    issue.userId,
    'catId',
    issue.catId as string,
    'signalType',
    issue.signalType,
    'signalDetail',
    JSON.stringify(issue.signalDetail),
    'context',
    JSON.stringify(issue.context),
    'createdAt',
    String(issue.createdAt),
  ];
  if (issue.invocationId) pairs.push('invocationId', issue.invocationId);
  if (issue.userDescription) pairs.push('userDescription', issue.userDescription);
  if (issue.cardMessageId) pairs.push('cardMessageId', issue.cardMessageId);
  if (issue.confirmedAt) pairs.push('confirmedAt', String(issue.confirmedAt));
  if (issue.skippedAt) pairs.push('skippedAt', String(issue.skippedAt));
  if (issue.falsePositiveAt) pairs.push('falsePositiveAt', String(issue.falsePositiveAt));
  return pairs;
}

function hydrate(fields: Record<string, string>): FrustrationIssue | null {
  if (!fields.issueId) return null;
  return {
    issueId: fields.issueId,
    status: fields.status as FrustrationIssueStatus,
    threadId: fields.threadId,
    userId: fields.userId,
    catId: fields.catId as import('@cat-cafe/shared').CatId,
    signalType: fields.signalType as import('@cat-cafe/shared').FrustrationSignalType,
    signalDetail: JSON.parse(fields.signalDetail || '{}'),
    context: JSON.parse(fields.context || '{"recentMessages":[]}'),
    createdAt: Number(fields.createdAt),
    ...(fields.invocationId ? { invocationId: fields.invocationId } : {}),
    ...(fields.userDescription ? { userDescription: fields.userDescription } : {}),
    ...(fields.cardMessageId ? { cardMessageId: fields.cardMessageId } : {}),
    ...(fields.communityIssueDraftId ? { communityIssueDraftId: fields.communityIssueDraftId } : {}),
    ...(fields.confirmedAt ? { confirmedAt: Number(fields.confirmedAt) } : {}),
    ...(fields.skippedAt ? { skippedAt: Number(fields.skippedAt) } : {}),
    ...(fields.falsePositiveAt ? { falsePositiveAt: Number(fields.falsePositiveAt) } : {}),
  };
}

/** F245 Phase B — confirmed 窗口结果跨分片合并后按 confirmedAt 升序（issueId tie-break 保确定性）。 */
function byConfirmedAtAsc(a: FrustrationIssue, b: FrustrationIssue): number {
  return (a.confirmedAt ?? 0) - (b.confirmedAt ?? 0) || a.issueId.localeCompare(b.issueId);
}

// ── Store ──────────────────────────────────────────────────────

export class RedisFrustrationIssueStore implements IFrustrationIssueStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateFrustrationIssueInput): Promise<FrustrationIssue> {
    const issue = createFrustrationIssue(input);
    const key = FrustrationIssueKeys.detail(issue.issueId);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...serialize(issue));
    pipeline.zadd(FrustrationIssueKeys.threadList(issue.threadId), String(issue.createdAt), issue.issueId);
    pipeline.zadd(FrustrationIssueKeys.userList(issue.userId), String(issue.createdAt), issue.issueId);
    pipeline.zadd(FrustrationIssueKeys.userDraft(issue.userId), String(issue.createdAt), issue.issueId);
    await pipeline.exec();
    return issue;
  }

  async getById(issueId: string): Promise<FrustrationIssue | null> {
    const fields = await this.redis.hgetall(FrustrationIssueKeys.detail(issueId));
    if (!fields || !fields.issueId) return null;
    return hydrate(fields);
  }

  async confirm(input: ConfirmIssueInput): Promise<FrustrationIssue | null> {
    const issue = await this.getById(input.issueId);
    if (!issue || issue.status !== 'draft') return null;

    const now = Date.now();
    const key = FrustrationIssueKeys.detail(input.issueId);
    const pipeline = this.redis.multi();
    pipeline.hset(key, 'status', 'confirmed', 'confirmedAt', String(now));
    if (input.userDescription) {
      pipeline.hset(key, 'userDescription', input.userDescription);
    }
    // Move from draft to confirmed index
    pipeline.zrem(FrustrationIssueKeys.userDraft(issue.userId), input.issueId);
    pipeline.zadd(FrustrationIssueKeys.userConfirmed(issue.userId), String(now), input.issueId);
    await pipeline.exec();

    return {
      ...issue,
      status: 'confirmed',
      confirmedAt: now,
      ...(input.userDescription ? { userDescription: input.userDescription } : {}),
    };
  }

  async skip(issueId: string): Promise<FrustrationIssue | null> {
    const issue = await this.getById(issueId);
    if (!issue || issue.status !== 'draft') return null;

    const now = Date.now();
    const pipeline = this.redis.multi();
    pipeline.hset(FrustrationIssueKeys.detail(issueId), 'status', 'skipped', 'skippedAt', String(now));
    pipeline.zrem(FrustrationIssueKeys.userDraft(issue.userId), issueId);
    await pipeline.exec();

    return { ...issue, status: 'skipped', skippedAt: now };
  }

  async markFalsePositive(issueId: string): Promise<FrustrationIssue | null> {
    const issue = await this.getById(issueId);
    if (!issue || issue.status !== 'draft') return null;

    const now = Date.now();
    const pipeline = this.redis.multi();
    pipeline.hset(FrustrationIssueKeys.detail(issueId), 'status', 'false_positive', 'falsePositiveAt', String(now));
    pipeline.zrem(FrustrationIssueKeys.userDraft(issue.userId), issueId);
    await pipeline.exec();

    return { ...issue, status: 'false_positive', falsePositiveAt: now };
  }

  async setCardMessageId(issueId: string, cardMessageId: string): Promise<void> {
    await this.redis.hset(FrustrationIssueKeys.detail(issueId), 'cardMessageId', cardMessageId);
  }

  async setCommunityIssueDraftId(issueId: string, draftId: string): Promise<void> {
    await this.redis.hset(FrustrationIssueKeys.detail(issueId), 'communityIssueDraftId', draftId);
  }

  async listByThread(threadId: string): Promise<FrustrationIssue[]> {
    const ids = await this.redis.zrevrange(FrustrationIssueKeys.threadList(threadId), 0, DEFAULT_LIST_LIMIT - 1);
    return this.bulkGet(ids);
  }

  async listConfirmed(userId: string): Promise<FrustrationIssue[]> {
    const ids = await this.redis.zrevrange(FrustrationIssueKeys.userConfirmed(userId), 0, DEFAULT_LIST_LIMIT - 1);
    return this.bulkGet(ids);
  }

  async listDraft(userId: string): Promise<FrustrationIssue[]> {
    const ids = await this.redis.zrevrange(FrustrationIssueKeys.userDraft(userId), 0, DEFAULT_LIST_LIMIT - 1);
    return this.bulkGet(ids);
  }

  async listAll(userId: string): Promise<FrustrationIssue[]> {
    const ids = await this.redis.zrevrange(FrustrationIssueKeys.userList(userId), 0, DEFAULT_LIST_LIMIT - 1);
    return this.bulkGet(ids);
  }

  /**
   * F245 Phase B — 只读全局时间窗扫描 confirmed issue（守 KD-4）。
   * confirmed 索引按 user 分片（frustration-issues:confirmed:{userId}，score=confirmedAt），无全局索引。
   * scanStream 收集所有分片 key → 每 key ZRANGEBYSCORE 取 [sinceMs, untilMs) 窗内 issueId
   * （半开：sinceMs 含、untilMs 不含，`(` 排除上界）→ hydrate → 按 confirmedAt 升序合并。
   * 后台周期任务（非热路径），单次 scan 可接受；纯读不碰 confirm 写路径（KD-4 read-model 边界）。
   */
  async listConfirmedInWindow(sinceMs: number, untilMs: number): Promise<FrustrationIssue[]> {
    const keys = await this.scanKeys('frustration-issues:confirmed:*');
    // ids 跨分片收集：当前写路径每 issue 仅属一个 user 分片（confirm 只 zadd issue.userId），故天然无重，
    // 不做 Set 去重（避免为不可能场景加防御代码）。若将来引入全局/二级 confirmed 索引（一 issue 进多分片），
    // 此处需补 `[...new Set(ids)]`——gpt52 Phase B review 非阻塞备注的触发条件。
    const ids: string[] = [];
    for (const key of keys) {
      const batch = await this.redis.zrangebyscore(key, sinceMs, `(${untilMs}`);
      ids.push(...batch);
    }
    const issues = await this.bulkGet(ids);
    return issues.sort(byConfirmedAtAsc);
  }

  /**
   * Scan for keys matching pattern. ⚠️ ioredis keyPrefix 不自动作用于 scanStream MATCH——
   * 手动拼前缀做 match，返回 key 再剥前缀，让后续 auto-prefix 命令（zrangebyscore/hgetall）正确
   * （对齐 RedisSessionChainStore.scanKeys 先例）。
   */
  private async scanKeys(pattern: string): Promise<string[]> {
    const prefix = (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
    const prefixedPattern = `${prefix}${pattern}`;
    return new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = this.redis.scanStream({ match: prefixedPattern, count: 100 });
      stream.on('data', (batch: string[]) => {
        for (const k of batch) {
          const stripped = prefix && k.startsWith(prefix) ? k.slice(prefix.length) : k;
          keys.push(stripped);
        }
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }

  private async bulkGet(ids: string[]): Promise<FrustrationIssue[]> {
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(FrustrationIssueKeys.detail(id));
    }
    const results = await pipeline.exec();
    const issues: FrustrationIssue[] = [];
    if (results) {
      for (const [err, fields] of results) {
        if (!err && fields) {
          const issue = hydrate(fields as Record<string, string>);
          if (issue) issues.push(issue);
        }
      }
    }
    return issues;
  }
}
