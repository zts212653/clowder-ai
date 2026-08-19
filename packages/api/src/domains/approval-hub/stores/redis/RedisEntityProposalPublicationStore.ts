import type { ApprovalEnvelope, ApprovalPublication, EntityProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  abortRedisStaged,
  commitRedisApprovalEnvelope,
} from '../../../cats/services/stores/redis/RedisApprovalPublication.js';
import { EntityProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/entity-proposal-keys.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';

/**
 * Atomically persist a staged proposal and promote its bounded reservation to
 * a durable retry identity. The reservation fence prevents a delayed creator
 * from publishing after another request has acquired the same client key.
 */
const CREATE_WITH_DEDUP_LUA = `
  if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], unpack(ARGV, 4))
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  redis.call('PERSIST', KEYS[3])
  return 1
`;

const RELEASE_DEDUP_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 0 then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

interface PersistStagedProposalInput {
  proposalId: string;
  ownerUserId: string;
  clientRequestId: string;
  createdAt: number;
  serializedFields: string[];
}

/**
 * F260 publication and retry-identity persistence.
 *
 * The lifecycle store delegates the Phase-I commit point and transport dedup
 * responsibilities here so its proposal CAS logic stays independently legible.
 */
export class RedisEntityProposalPublicationStore implements ApprovalPublicationStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly getProposal: (proposalId: string) => Promise<EntityProposal | null>,
  ) {}

  async persistStagedProposal(input: PersistStagedProposalInput): Promise<void> {
    const created = await this.redis.eval(
      CREATE_WITH_DEDUP_LUA,
      3,
      EntityProposalKeys.detail(input.proposalId),
      EntityProposalKeys.userPending(input.ownerUserId),
      EntityProposalKeys.dedup(input.ownerUserId, input.clientRequestId),
      input.proposalId,
      String(input.createdAt),
      input.proposalId,
      ...input.serializedFields,
    );
    if (created !== 1) {
      throw new Error(`entity proposal dedup reservation lost before create: ${input.proposalId}`);
    }
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.getProposal(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, EntityProposalKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.getProposal(proposalId);
    if (!proposal) return;
    await abortRedisStaged(
      this.redis,
      EntityProposalKeys.detail(proposalId),
      [EntityProposalKeys.userPending(proposal.ownerUserId)],
      proposalId,
      proposal.clientRequestId ? EntityProposalKeys.dedup(proposal.ownerUserId, proposal.clientRequestId) : undefined,
    );
  }

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    return this.redis.get(EntityProposalKeys.dedup(userId, clientRequestId));
  }

  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = EntityProposalKeys.dedup(userId, clientRequestId);
    const result = await this.redis.set(key, proposalId, 'EX', 300, 'NX');
    if (result === 'OK') return proposalId;
    return (await this.redis.get(key)) ?? proposalId;
  }

  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    await this.redis.eval(
      RELEASE_DEDUP_LUA,
      2,
      EntityProposalKeys.dedup(userId, clientRequestId),
      EntityProposalKeys.detail(expectedProposalId),
      expectedProposalId,
    );
  }
}
