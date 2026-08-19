import type { ApprovalEnvelope, ApprovalPublication, DispatchProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../../cats/services/owner-auth-provenance.js';
import { commitRedisApprovalEnvelope } from '../../../cats/services/stores/redis/RedisApprovalPublication.js';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';
import {
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  computeLineageKey,
  type DispatchCanonicalAdmissionBlock,
  type DispatchCanonicalAdmissionLookup,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  type IDispatchProposalStore,
} from '../ports/IDispatchProposalStore.js';
import {
  canonicalAdmissionIndexKeysForProposal,
  canonicalAdmissionStoredFields,
  RedisDispatchProposalCanonicalAdmission,
} from './RedisDispatchProposalCanonicalAdmission.js';
import {
  type CanonicalAdmissionClaimInput,
  claimRedisActionSuccessorWithCanonicalAdmission,
  RedisCanonicalAdmissionUnavailableError,
} from './RedisDispatchProposalCanonicalClaim.js';
import { createRedisDispatchProposal } from './RedisDispatchProposalCreate.js';
import {
  CAS_APPROVE_DISPATCH_PROPOSAL_LUA,
  CAS_REJECT_DISPATCH_PROPOSAL_LUA,
  CAS_REVERT_DISPATCH_PROPOSAL_PENDING_LUA,
} from './RedisDispatchProposalLifecycle.js';
import { RedisDispatchProposalNegativeAuthorization } from './RedisDispatchProposalNegativeAuthorization.js';
import { abortRedisDispatchStaged } from './RedisDispatchProposalRollback.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

/** Canonical persistent proposal store; denial indexes remain derived projections. */
export class RedisDispatchProposalStore implements IDispatchProposalStore, ApprovalPublicationStore {
  private readonly negativeAuthorization: RedisDispatchProposalNegativeAuthorization;
  private readonly canonicalAdmission: RedisDispatchProposalCanonicalAdmission;

  constructor(private readonly redis: RedisClient) {
    this.negativeAuthorization = new RedisDispatchProposalNegativeAuthorization(redis);
    this.canonicalAdmission = new RedisDispatchProposalCanonicalAdmission(redis);
  }

  async create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult> {
    return createRedisDispatchProposal(this.redis, input);
  }

  async get(proposalId: string): Promise<DispatchProposal | null> {
    const key = DispatchProposalKeys.detail(proposalId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrateDispatchProposal(raw);
  }

  async listPendingByUser(userId: string): Promise<DispatchProposal[]> {
    const pendingKey = DispatchProposalKeys.userPending(userId);
    // Reverse order: newest first (highest score = most recent createdAt)
    const ids = await this.redis.zrevrange(pendingKey, 0, -1);
    if (!ids.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(DispatchProposalKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const proposals: DispatchProposal[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) continue;
      const p = hydrateDispatchProposal(raw as Record<string, string>);
      // Double-check status in case of race between ZREM and this read
      if (p.status === 'pending') proposals.push(p);
    }
    return proposals;
  }

  async approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance = 'unknown',
  ): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;
    const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);
    const blockingIndexKeys = [
      ...this.negativeAuthorization.keysForProposal(proposal),
      ...canonicalAdmissionIndexKeysForProposal(proposal),
    ];
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_APPROVE_DISPATCH_PROPOSAL_LUA,
      3 + blockingIndexKeys.length,
      key,
      pendingKey,
      settledKey,
      ...blockingIndexKeys,
      String(now),
      userId,
      proposalId,
      provenance,
    );

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'approved',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined> {
    const value = await this.redis.hget(DispatchProposalKeys.detail(proposalId), 'approvalOwnerAuthProvenance');
    return value === null ? undefined : requireOwnerAuthProvenance(value);
  }

  async recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void> {
    const key = DispatchProposalKeys.detail(proposalId);
    await this.redis.hset(key, 'deliveredMessageId', deliveredMessageId);
  }

  async revertToPending(proposalId: string): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);

    // Phase J (INV-J5): pass lineage key so Lua can check for successor.
    // If a newer proposal holds the lineage, revert → superseded (not pending).
    const K = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const lineageKeyRedis = DispatchProposalKeys.lineage(K);
    const negativeAuthorizationKeys = this.negativeAuthorization.keysForProposal(proposal);
    const canonicalAdmissionKeys = canonicalAdmissionIndexKeysForProposal(proposal);
    const canonicalAdmissionFields = canonicalAdmissionStoredFields(this.redis, proposal);
    const blockingIndexKeys = [...negativeAuthorizationKeys, ...canonicalAdmissionKeys];

    const result = await this.redis.eval(
      CAS_REVERT_DISPATCH_PROPOSAL_PENDING_LUA,
      4 + blockingIndexKeys.length,
      key,
      pendingKey,
      settledKey,
      lineageKeyRedis,
      ...blockingIndexKeys,
      String(proposal.createdAt),
      proposalId,
      String(canonicalAdmissionKeys.length),
      ...canonicalAdmissionFields,
    );

    // 0 = not approved, 2 = superseded (successor holds lineage) — both return null
    if (result === 0 || result === 2) return null;

    return {
      ...proposal,
      status: 'pending',
      decidedAt: undefined,
      decidedBy: undefined,
    };
  }

  async reject(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_REJECT_DISPATCH_PROPOSAL_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      String(now),
      userId,
      proposalId,
    );

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'rejected',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]> {
    const settledKey = DispatchProposalKeys.userSettled(userId);
    // Reverse order: newest first (highest score = most recent decidedAt)
    const ids = await this.redis.zrevrange(settledKey, 0, limit - 1);
    if (!ids.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(DispatchProposalKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const proposals: DispatchProposal[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) continue;
      const p = hydrateDispatchProposal(raw as Record<string, string>);
      if (p.status === 'approved' || p.status === 'rejected') proposals.push(p);
    }
    return proposals;
  }

  async findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null> {
    const dedupKey = DispatchProposalKeys.clientMsg(sourceThreadId, clientMessageId);
    const proposalId = await this.redis.get(dedupKey);
    if (!proposalId) return null;
    return this.get(proposalId);
  }

  async findNegativeAuthorizationBlocks(
    input: DispatchNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findBlocks(input);
  }

  async findCanonicalAdmissionBlocks(
    input: DispatchCanonicalAdmissionLookup,
  ): Promise<DispatchCanonicalAdmissionBlock[]> {
    return this.canonicalAdmission.findBlocks(input);
  }

  async claimActionSuccessorWithCanonicalAdmission(input: CanonicalAdmissionClaimInput) {
    try {
      return await claimRedisActionSuccessorWithCanonicalAdmission(this.redis, input);
    } catch (error) {
      if (!(error instanceof RedisCanonicalAdmissionUnavailableError) || error.reason !== 'projection_not_ready') {
        throw error;
      }
    }
    try {
      await this.canonicalAdmission.ensureReady();
    } catch (error) {
      throw new RedisCanonicalAdmissionUnavailableError(
        `canonical admission projection rebuild failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return claimRedisActionSuccessorWithCanonicalAdmission(this.redis, input);
  }

  async findLegacyNegativeAuthorizationBlocks(
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findLegacyBlocks(input);
  }

  async getNegativeAuthorizationLegacyCutoverAt(): Promise<number | undefined> {
    return this.negativeAuthorization.getLegacyCutoverAt();
  }

  async establishNegativeAuthorizationLegacyCutoverAt(cutoverAt: number): Promise<number> {
    return this.negativeAuthorization.establishLegacyCutoverAt(cutoverAt);
  }

  async rebuildNegativeAuthorizationIndexes(): Promise<{ exactIndexed: number; legacyIndexed: number }> {
    return this.negativeAuthorization.rebuildIndexes();
  }

  // ---------------------------------------------------------------------------
  // ApprovalPublicationStore (Phase-I publication envelope)
  // ---------------------------------------------------------------------------

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.get(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, DispatchProposalKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    const K = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const lineageKeyRedis = DispatchProposalKeys.lineage(K);
    const conditionalDeleteKey = proposal.clientMessageId
      ? DispatchProposalKeys.clientMsg(proposal.sourceThreadId, proposal.clientMessageId)
      : undefined;
    await abortRedisDispatchStaged(this.redis, {
      detailKey: DispatchProposalKeys.detail(proposalId),
      pendingKey: DispatchProposalKeys.userPending(proposal.ownerUserId),
      lineageKey: lineageKeyRedis,
      proposalId,
      conditionalDeleteKey,
      negativeAuthorizationKeys: this.negativeAuthorization.keysForProposal(proposal),
    });
  }
}
