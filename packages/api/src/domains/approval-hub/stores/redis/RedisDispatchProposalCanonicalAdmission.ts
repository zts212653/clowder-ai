import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import {
  type DispatchCanonicalAdmissionBlock,
  type DispatchCanonicalAdmissionLookup,
  isCanonicalAdmissionProposalStatus,
  tryCanonicalizeDispatchAdmissionSubjectRef,
  tryComputeDispatchCanonicalActionKey,
} from '../ports/IDispatchProposalStore.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

interface CanonicalAdmissionProjection {
  canonicalActionKey: string;
  canonicalSubjectRef: string;
  actionIndexKey: string;
  subjectIndexKey: string;
}

function prefixedRedisKey(redis: RedisClient, key: string): string {
  return `${redis.options.keyPrefix ?? ''}${key}`;
}

/**
 * This is a derived projection of an existing DispatchProposal, never a new
 * custody record. The proposal hash remains the source of truth at lookup.
 */
export function canonicalAdmissionProjectionForProposal(
  proposal: DispatchProposal,
): CanonicalAdmissionProjection | undefined {
  if (!proposal.proposedAction) return undefined;
  const canonicalActionKey = tryComputeDispatchCanonicalActionKey(proposal.ownerUserId, proposal.proposedAction);
  const canonicalSubjectRef = tryCanonicalizeDispatchAdmissionSubjectRef(proposal.proposedAction.subjectRef);
  if (!canonicalActionKey || !canonicalSubjectRef) return undefined;
  return {
    canonicalActionKey,
    canonicalSubjectRef,
    actionIndexKey: DispatchProposalKeys.canonicalAdmissionAction(canonicalActionKey),
    subjectIndexKey: DispatchProposalKeys.canonicalAdmissionSubject(proposal.ownerUserId, canonicalSubjectRef),
  };
}

/** Redis keys are supplied to eval as normal client-prefixed KEYS. */
export function canonicalAdmissionIndexKeysForProposal(proposal: DispatchProposal): string[] {
  const projection = canonicalAdmissionProjectionForProposal(proposal);
  if (!projection) return [];
  return [projection.actionIndexKey, projection.subjectIndexKey];
}

/**
 * Cache the canonical identity and fully-prefixed derived keys on the proposal
 * hash so Lua lifecycle transitions can maintain projection membership without
 * parsing action JSON or creating a second truth store.
 */
export function canonicalAdmissionStoredFields(redis: RedisClient, proposal: DispatchProposal): string[] {
  const projection = canonicalAdmissionProjectionForProposal(proposal);
  if (!projection) return [];
  return [
    'canonicalAdmissionActionKey',
    projection.canonicalActionKey,
    'canonicalAdmissionSubjectRef',
    projection.canonicalSubjectRef,
    'canonicalAdmissionActionIndexKey',
    prefixedRedisKey(redis, projection.actionIndexKey),
    'canonicalAdmissionSubjectIndexKey',
    prefixedRedisKey(redis, projection.subjectIndexKey),
  ];
}

/** One newest active candidate is sufficient to deny; any stale winner fails closed. */
const FIND_CANONICAL_ADMISSION_BLOCK_LUA = `
-- canonical-admission-lookup
local proposalIds = redis.call('ZREVRANGE', KEYS[1], 0, 0)
if #proposalIds == 0 then return {} end
local proposalId = proposalIds[1]
local detailKey = ARGV[1] .. proposalId
local status = redis.call('HGET', detailKey, 'status')
if (status == 'pending' or status == 'rejected')
  and redis.call('HGET', detailKey, 'ownerUserId') == ARGV[2]
  and redis.call('HGET', detailKey, ARGV[3]) == ARGV[4] then
  return {proposalId, status}
end
return {'invalid', proposalId}
`;

/** Backfill is transactional per existing proposal and only writes a derived projection. */
const BACKFILL_CANONICAL_ADMISSION_INDEX_LUA = `
local detailKey = KEYS[1]
local status = redis.call('HGET', detailKey, 'status')
if status ~= 'pending' and status ~= 'rejected' then return 0 end
if redis.call('HGET', detailKey, 'ownerUserId') ~= ARGV[1] then return 0 end
redis.call('HSET', detailKey, unpack(ARGV, 4))
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
return 1
`;

function decodeCanonicalAdmissionBlocks(raw: unknown): DispatchCanonicalAdmissionBlock[] {
  if (!Array.isArray(raw)) {
    throw new Error('canonical admission lookup returned an invalid Redis result');
  }
  if (raw.length === 0) return [];
  if (raw.length !== 2 || typeof raw[0] !== 'string' || (raw[1] !== 'pending' && raw[1] !== 'rejected')) {
    throw new Error('canonical admission lookup returned an invalid proposal block');
  }
  return [{ proposalId: raw[0], status: raw[1] }];
}

function detailKeysFromScan(rawKeys: string[], keyPrefix: string): string[] {
  const detailPrefix = `${keyPrefix}${DispatchProposalKeys.detailPrefix}`;
  return rawKeys
    .filter((rawKey) => rawKey.startsWith(detailPrefix))
    .map((rawKey) => (keyPrefix ? rawKey.slice(keyPrefix.length) : rawKey));
}

function asProposalHash(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) return undefined;
  return raw as Record<string, string>;
}

async function readProposalHashes(
  redis: RedisClient,
  detailKeys: readonly string[],
): Promise<Array<Record<string, string> | undefined>> {
  if (detailKeys.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const detailKey of detailKeys) pipeline.hgetall(detailKey);
  const rows = await pipeline.exec();
  if (!rows) throw new Error('canonical admission index rebuild returned no Redis result');
  return rows.map(([error, raw]) => {
    if (error) throw error;
    return asProposalHash(raw);
  });
}

async function backfillProposalCanonicalAdmission(
  redis: RedisClient,
  detailKey: string,
  raw: Record<string, string> | undefined,
): Promise<void> {
  if (!raw) return;
  const proposal = hydrateDispatchProposal(raw);
  if (!isCanonicalAdmissionProposalStatus(proposal.status)) return;
  const projection = canonicalAdmissionProjectionForProposal(proposal);
  if (!projection) return;
  const rebuilt = await redis.eval(
    BACKFILL_CANONICAL_ADMISSION_INDEX_LUA,
    3,
    detailKey,
    projection.actionIndexKey,
    projection.subjectIndexKey,
    proposal.ownerUserId,
    proposal.proposalId,
    String(proposal.createdAt),
    ...canonicalAdmissionStoredFields(redis, proposal),
  );
  if (rebuilt !== 1 && rebuilt !== 0) {
    throw new Error('canonical admission index rebuild returned an invalid result');
  }
}

async function rebuildCanonicalAdmissionPage(redis: RedisClient, detailKeys: readonly string[]): Promise<void> {
  const hashes = await readProposalHashes(redis, detailKeys);
  for (const [index, hash] of hashes.entries()) {
    await backfillProposalCanonicalAdmission(redis, detailKeys[index], hash);
  }
}

/** Bounded canonical lookup plus one-time safe projection activation for historic proposal hashes. */
export class RedisDispatchProposalCanonicalAdmission {
  private readiness?: Promise<void>;

  constructor(private readonly redis: RedisClient) {}

  async findBlocks(input: DispatchCanonicalAdmissionLookup): Promise<DispatchCanonicalAdmissionBlock[]> {
    if (!input.canonicalActionKey && !input.canonicalSubjectRef) return [];
    await this.ensureReady();
    const byAction = Boolean(input.canonicalActionKey);
    const expectedValue = input.canonicalActionKey ?? input.canonicalSubjectRef;
    if (!expectedValue) return [];
    const indexKey = byAction
      ? DispatchProposalKeys.canonicalAdmissionAction(expectedValue)
      : DispatchProposalKeys.canonicalAdmissionSubject(input.ownerUserId, expectedValue);
    const raw = await this.redis.eval(
      FIND_CANONICAL_ADMISSION_BLOCK_LUA,
      1,
      indexKey,
      `${this.redis.options.keyPrefix ?? ''}${DispatchProposalKeys.detailPrefix}`,
      input.ownerUserId,
      byAction ? 'canonicalAdmissionActionKey' : 'canonicalAdmissionSubjectRef',
      expectedValue,
    );
    return decodeCanonicalAdmissionBlocks(raw);
  }

  async ensureReady(): Promise<void> {
    const marker = await this.redis.get(DispatchProposalKeys.canonicalAdmissionRebuildCompletedAt);
    if (marker) return;
    const readiness = this.readiness ?? this.rebuildIndexes();
    this.readiness = readiness;
    try {
      await readiness;
    } finally {
      if (this.readiness === readiness) this.readiness = undefined;
    }
  }

  private async rebuildIndexes(): Promise<void> {
    const keyPrefix = this.redis.options.keyPrefix ?? '';
    const scanPattern = `${keyPrefix}${DispatchProposalKeys.detailPrefix}*`;
    let cursor = '0';
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
      cursor = nextCursor;
      const detailKeys = detailKeysFromScan(rawKeys, keyPrefix);
      await rebuildCanonicalAdmissionPage(this.redis, detailKeys);
    } while (cursor !== '0');
    await this.redis.set(DispatchProposalKeys.canonicalAdmissionRebuildCompletedAt, String(Date.now()));
  }
}
