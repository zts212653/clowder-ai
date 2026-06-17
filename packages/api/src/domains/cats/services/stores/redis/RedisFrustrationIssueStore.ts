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
