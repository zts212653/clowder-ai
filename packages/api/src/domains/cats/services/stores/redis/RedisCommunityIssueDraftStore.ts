/**
 * F235: Redis-backed CommunityIssueDraftStore.
 *
 * Data structures (all auto-prefixed by ioredis keyPrefix):
 * - Hash   community-issue-draft:{draftId}          — draft fields
 * - String community-issue-draft:source:{sourceId}  — sourceId → draftId mapping (INV-3)
 * - ZSet   community-issue-drafts:user:{userId}     — user's drafts (score=createdAt)
 *
 * Iron Law #5 (LL-048): user-visible state defaults to persistent (no TTL).
 */

import type {
  CommunityIssueDraft,
  CommunityIssueDraftSourceType,
  CommunityIssueDraftStatus,
  CreateCommunityIssueDraftInput,
} from '@cat-cafe/shared';
import { createCommunityIssueDraft } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ICommunityIssueDraftStore, PublishDraftInput } from '../ports/CommunityIssueDraftStore.js';
import { CommunityIssueDraftKeys } from '../redis-keys/community-issue-draft-keys.js';

// ── Serialization ──────────────────────────────────────────────

function serialize(draft: CommunityIssueDraft): string[] {
  const pairs: string[] = [
    'draftId',
    draft.draftId,
    'status',
    draft.status,
    'sourceType',
    draft.sourceType,
    'sourceId',
    draft.sourceId,
    'title',
    draft.title,
    'bodyMarkdown',
    draft.bodyMarkdown,
    'targetRepo',
    draft.targetRepo,
    'labels',
    JSON.stringify(draft.labels),
    'threadId',
    draft.threadId,
    'userId',
    draft.userId,
    'createdAt',
    String(draft.createdAt),
  ];
  if (draft.githubIssueNumber != null) pairs.push('githubIssueNumber', String(draft.githubIssueNumber));
  if (draft.githubIssueUrl) pairs.push('githubIssueUrl', draft.githubIssueUrl);
  if (draft.publishedAt) pairs.push('publishedAt', String(draft.publishedAt));
  if (draft.cancelledAt) pairs.push('cancelledAt', String(draft.cancelledAt));
  return pairs;
}

function hydrate(fields: Record<string, string>): CommunityIssueDraft | null {
  if (!fields.draftId) return null;
  return {
    draftId: fields.draftId,
    status: fields.status as CommunityIssueDraftStatus,
    sourceType: fields.sourceType as CommunityIssueDraftSourceType,
    sourceId: fields.sourceId,
    title: fields.title,
    bodyMarkdown: fields.bodyMarkdown || '',
    targetRepo: fields.targetRepo,
    labels: JSON.parse(fields.labels || '[]'),
    threadId: fields.threadId,
    userId: fields.userId,
    createdAt: Number(fields.createdAt),
    ...(fields.githubIssueNumber ? { githubIssueNumber: Number(fields.githubIssueNumber) } : {}),
    ...(fields.githubIssueUrl ? { githubIssueUrl: fields.githubIssueUrl } : {}),
    ...(fields.publishedAt ? { publishedAt: Number(fields.publishedAt) } : {}),
    ...(fields.cancelledAt ? { cancelledAt: Number(fields.cancelledAt) } : {}),
  };
}

// ── Store ──────────────────────────────────────────────────────

export class RedisCommunityIssueDraftStore implements ICommunityIssueDraftStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft> {
    const draft = createCommunityIssueDraft(input);

    // INV-3: Atomic uniqueness claim via SET NX.
    // cancel() already DELs the source key, so NX only fails if an active draft exists.
    const sourceKey = CommunityIssueDraftKeys.source(input.sourceId);
    const claimed = await this.redis.set(sourceKey, draft.draftId, 'NX');
    if (!claimed) {
      // NX failed — check if orphaned (detail hash missing = previous crash left stale key)
      const existingDraftId = await this.redis.get(sourceKey);
      if (existingDraftId) {
        const existing = await this.getById(existingDraftId);
        if (existing && existing.status !== 'cancelled') {
          throw new Error(`Source ${input.sourceId} already has an active draft: ${existingDraftId}`);
        }
        // Orphaned or cancelled — reclaim (DEL + SET NX to stay race-safe)
        await this.redis.del(sourceKey);
        const retried = await this.redis.set(sourceKey, draft.draftId, 'NX');
        if (!retried) {
          throw new Error(`Source ${input.sourceId} already has an active draft (concurrent claim)`);
        }
      } else {
        // Key disappeared between NX and GET (concurrent cancel/delete).
        // Must re-claim before any write path continues — no claim = INV-3 violation.
        const retried = await this.redis.set(sourceKey, draft.draftId, 'NX');
        if (!retried) {
          throw new Error(`Source ${input.sourceId} already has an active draft (concurrent claim)`);
        }
      }
    }

    // Source slot claimed — write the rest with rollback on failure
    const key = CommunityIssueDraftKeys.detail(draft.draftId);
    try {
      const pipeline = this.redis.multi();
      pipeline.hset(key, ...serialize(draft));
      pipeline.zadd(CommunityIssueDraftKeys.userList(draft.userId), String(draft.createdAt), draft.draftId);
      await pipeline.exec();
    } catch (err) {
      // Rollback: remove orphaned source claim so future creates aren't bricked
      await this.redis.del(sourceKey).catch(() => {});
      throw err;
    }
    return draft;
  }

  async getById(draftId: string): Promise<CommunityIssueDraft | null> {
    const fields = await this.redis.hgetall(CommunityIssueDraftKeys.detail(draftId));
    if (!fields || !fields.draftId) return null;
    return hydrate(fields);
  }

  async getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null> {
    const sourceKey = CommunityIssueDraftKeys.source(sourceId);
    const draftId = await this.redis.get(sourceKey);
    if (!draftId) return null;
    const draft = await this.getById(draftId);
    if (!draft) {
      // Self-heal: orphaned source key (detail hash missing — previous crash left stale key).
      // Clean up so future create() calls aren't permanently bricked.
      await this.redis.del(sourceKey).catch(() => {});
      return null;
    }
    if (draft.status === 'cancelled') return null;
    return draft;
  }

  async publish(input: PublishDraftInput): Promise<CommunityIssueDraft> {
    const draft = await this.getById(input.draftId);
    if (!draft) throw new Error(`Draft ${input.draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${input.draftId} is ${draft.status}, cannot publish (not draft)`);
    }

    const now = Date.now();
    const key = CommunityIssueDraftKeys.detail(input.draftId);
    await this.redis.hset(
      key,
      'status',
      'published',
      'githubIssueNumber',
      String(input.githubIssueNumber),
      'githubIssueUrl',
      input.githubIssueUrl,
      'publishedAt',
      String(now),
    );

    return {
      ...draft,
      status: 'published',
      githubIssueNumber: input.githubIssueNumber,
      githubIssueUrl: input.githubIssueUrl,
      publishedAt: now,
    };
  }

  async cancel(draftId: string): Promise<CommunityIssueDraft> {
    const draft = await this.getById(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot cancel (not draft)`);
    }

    const now = Date.now();
    const pipeline = this.redis.multi();
    pipeline.hset(CommunityIssueDraftKeys.detail(draftId), 'status', 'cancelled', 'cancelledAt', String(now));
    // Remove source index so a new draft can be created (INV-3 edge)
    pipeline.del(CommunityIssueDraftKeys.source(draft.sourceId));
    await pipeline.exec();

    return { ...draft, status: 'cancelled', cancelledAt: now };
  }

  async updateContent(draftId: string, title: string, bodyMarkdown: string): Promise<CommunityIssueDraft> {
    const draft = await this.getById(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot update (not draft)`);
    }

    await this.redis.hset(CommunityIssueDraftKeys.detail(draftId), 'title', title, 'bodyMarkdown', bodyMarkdown);
    return { ...draft, title, bodyMarkdown };
  }
}
