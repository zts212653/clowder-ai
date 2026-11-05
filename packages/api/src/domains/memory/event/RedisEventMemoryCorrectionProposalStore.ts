import { createHash } from 'node:crypto';
import type { ApprovalEnvelope, ApprovalPublication, EventMemoryCorrectionProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { reconcileSettledIndexTime } from '../../../utils/reconcile-settled-index-time.js';
import { readRedisSettledPage } from '../../../utils/redis-settled-page.js';
import type { SettledHistoryPageOptions, SettledHistorySourcePage } from '../../../utils/settled-history-page.js';
import {
  abortRedisStaged,
  commitRedisApprovalEnvelope,
} from '../../cats/services/stores/redis/RedisApprovalPublication.js';
import type {
  CreateEventMemoryCorrectionProposalInput,
  EventMemoryCorrectionProposalStore,
} from './EventMemoryCorrectionProposalStore.js';
import {
  hydrateEventCorrectionProposal,
  serializeEventCorrectionProposal,
} from './event-memory-correction-proposal-redis-codec.js';

const CREATE_LUA = `
  if redis.call('GET', KEYS[4]) ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], unpack(ARGV, 4))
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
  redis.call('PERSIST', KEYS[4])
  return 1
`;

const CLAIM_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
  if redis.call('HGET', KEYS[1], 'ownerUserId') ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], 'status', 'approving', 'approvedBy', ARGV[1])
  return 1
`;

const FINALIZE_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'approving' then return 0 end
  if redis.call('HGET', KEYS[1], 'ownerUserId') ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], 'status', 'approved', 'approvedBy', ARGV[1],
    'approvedAt', ARGV[2], 'appliedRevision', ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
  redis.call('ZREM', KEYS[4], ARGV[3])
  return 1
`;

const ROLLBACK_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'approving' then return 0 end
  redis.call('HSET', KEYS[1], 'status', 'pending')
  redis.call('HDEL', KEYS[1], 'approvedBy')
  return 1
`;

const REJECT_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
  if redis.call('HGET', KEYS[1], 'ownerUserId') ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], 'status', 'rejected', 'rejectedBy', ARGV[1],
    'rejectedAt', ARGV[2], 'rejectionReason', ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[3])
  redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
  redis.call('ZREM', KEYS[4], ARGV[3])
  return 1
`;

export class RedisEventMemoryCorrectionProposalStore implements EventMemoryCorrectionProposalStore {
  constructor(private readonly redis: RedisClient) {}

  async create(input: CreateEventMemoryCorrectionProposalInput): Promise<EventMemoryCorrectionProposal> {
    const createdAt = Date.now();
    const proposal: EventMemoryCorrectionProposal = {
      ...structuredClone(input),
      status: 'pending',
      createdAt,
      publication: { state: 'staged', stagedAt: createdAt },
    };
    const created = await this.redis.eval(
      CREATE_LUA,
      4,
      keys.detail(input.proposalId),
      keys.pending(input.ownerUserId),
      keys.event(input.ownerUserId, input.eventId),
      keys.dedup(input.ownerUserId, input.clientRequestId),
      input.proposalId,
      String(createdAt),
      input.proposalId,
      ...serializeEventCorrectionProposal(proposal),
    );
    if (created !== 1) throw new Error(`event correction proposal dedup reservation lost: ${input.proposalId}`);
    return proposal;
  }

  async get(proposalId: string): Promise<EventMemoryCorrectionProposal | null> {
    const raw = await this.redis.hgetall(keys.detail(proposalId));
    return raw && Object.keys(raw).length > 0 ? hydrateEventCorrectionProposal(raw) : null;
  }

  async listActionable(ownerUserId: string, limit = 100): Promise<EventMemoryCorrectionProposal[]> {
    return this.readIndex(keys.pending(ownerUserId), limit, (proposal) =>
      ['pending', 'approving'].includes(proposal.status),
    );
  }

  async listSettledPage(
    owner: string,
    options: SettledHistoryPageOptions,
  ): Promise<SettledHistorySourcePage<EventMemoryCorrectionProposal>> {
    return readRedisSettledPage(this.redis, keys.settled(owner), options, async (id, at) => {
      const p = await this.get(id);
      if (!p) return null;
      if (p.ownerUserId !== owner || !['approved', 'rejected'].includes(p.status))
        throw new Error('Settled index canonical owner/status mismatch');
      if (p.proposalId !== id) throw new Error('Settled index identity mismatch');
      await reconcileSettledIndexTime(this.redis, keys.settled(owner), id, at, p.approvedAt ?? p.rejectedAt ?? 0, [
        {
          key: keys.detail(id),
          fields: { status: p.status, ownerUserId: p.ownerUserId, approvedAt: p.approvedAt, rejectedAt: p.rejectedAt },
        },
      ]);
      return p;
    });
  }

  async listSettled(ownerUserId: string, limit = 100): Promise<EventMemoryCorrectionProposal[]> {
    return this.readIndex(keys.settled(ownerUserId), limit);
  }

  async countActionableForEvents(
    ownerUserId: string,
    eventIds: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    if (eventIds.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const eventId of eventIds) pipeline.zcard(keys.event(ownerUserId, eventId));
    const rows = await pipeline.exec();
    const counts = new Map<string, number>();
    eventIds.forEach((eventId, index) => {
      const [error, count] = rows?.[index] ?? [new Error('missing Redis pipeline result'), 0];
      if (error) throw error;
      counts.set(eventId, Number(count));
    });
    return counts;
  }

  async listActionableForEvent(
    ownerUserId: string,
    eventId: string,
    limit = 100,
  ): Promise<EventMemoryCorrectionProposal[]> {
    return this.readIndex(keys.event(ownerUserId, eventId), limit, (proposal) =>
      ['pending', 'approving'].includes(proposal.status),
    );
  }

  async claimForApproval(proposalId: string, approvedBy: string): Promise<EventMemoryCorrectionProposal | null> {
    const before = await this.get(proposalId);
    if (!before) return null;
    const claimed = await this.redis.eval(CLAIM_LUA, 1, keys.detail(proposalId), approvedBy);
    return claimed === 1 ? { ...before, status: 'approving', approvedBy } : null;
  }

  async finalizeApproval(
    proposalId: string,
    approvedBy: string,
    appliedRevision: string,
  ): Promise<EventMemoryCorrectionProposal | null> {
    const before = await this.get(proposalId);
    if (!before) return null;
    const approvedAt = Date.now();
    const finalized = await this.redis.eval(
      FINALIZE_LUA,
      4,
      keys.detail(proposalId),
      keys.pending(before.ownerUserId),
      keys.settled(before.ownerUserId),
      keys.event(before.ownerUserId, before.eventId),
      approvedBy,
      String(approvedAt),
      proposalId,
      appliedRevision,
    );
    return finalized === 1 ? { ...before, status: 'approved', approvedBy, approvedAt, appliedRevision } : null;
  }

  async rollbackClaim(proposalId: string): Promise<boolean> {
    return (await this.redis.eval(ROLLBACK_LUA, 1, keys.detail(proposalId))) === 1;
  }

  async markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason: string,
  ): Promise<EventMemoryCorrectionProposal | null> {
    const before = await this.get(proposalId);
    if (!before) return null;
    const rejectedAt = Date.now();
    const rejected = await this.redis.eval(
      REJECT_LUA,
      4,
      keys.detail(proposalId),
      keys.pending(before.ownerUserId),
      keys.settled(before.ownerUserId),
      keys.event(before.ownerUserId, before.eventId),
      rejectedBy,
      String(rejectedAt),
      proposalId,
      rejectionReason,
    );
    return rejected === 1 ? { ...before, status: 'rejected', rejectedBy, rejectedAt, rejectionReason } : null;
  }

  getDedupProposalId(ownerUserId: string, clientRequestId: string): Promise<string | null> {
    return this.redis.get(keys.dedup(ownerUserId, clientRequestId));
  }

  async reserveDedup(ownerUserId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = keys.dedup(ownerUserId, clientRequestId);
    const reserved = await this.redis.set(key, proposalId, 'EX', 300, 'NX');
    return reserved === 'OK' ? proposalId : ((await this.redis.get(key)) ?? proposalId);
  }

  async releaseDedup(ownerUserId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 0 then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      2,
      keys.dedup(ownerUserId, clientRequestId),
      keys.detail(expectedProposalId),
      expectedProposalId,
    );
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.get(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F321',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, keys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    await abortRedisStaged(
      this.redis,
      keys.detail(proposalId),
      [keys.pending(proposal.ownerUserId), keys.event(proposal.ownerUserId, proposal.eventId)],
      proposalId,
      keys.dedup(proposal.ownerUserId, proposal.clientRequestId),
    );
  }

  private async readIndex(
    key: string,
    limit: number,
    predicate?: (proposal: EventMemoryCorrectionProposal) => boolean,
  ): Promise<EventMemoryCorrectionProposal[]> {
    const ids = await this.redis.zrevrange(key, 0, Math.max(0, limit) - 1);
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(keys.detail(id));
    const rows = await pipeline.exec();
    if (!rows) return [];
    const proposals: EventMemoryCorrectionProposal[] = [];
    for (const [error, raw] of rows) {
      if (error || !raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) continue;
      const proposal = hydrateEventCorrectionProposal(raw as Record<string, string>);
      if (!predicate || predicate(proposal)) proposals.push(proposal);
    }
    return proposals;
  }
}

const keys = {
  detail: (proposalId: string) => `event-memory-correction:${proposalId}`,
  pending: (ownerUserId: string) => `event-memory-correction:pending:${digest(ownerUserId)}`,
  settled: (ownerUserId: string) => `event-memory-correction:settled:${digest(ownerUserId)}`,
  event: (ownerUserId: string, eventId: string) =>
    `event-memory-correction:event:${digest(`${ownerUserId}\0${eventId}`)}`,
  dedup: (ownerUserId: string, clientRequestId: string) =>
    `event-memory-correction:dedup:${digest(`${ownerUserId}\0${clientRequestId}`)}`,
};

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
