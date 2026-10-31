import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import {
  computeLegacyNegativeAuthorizationKey,
  computeNegativeAuthorizationKey,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  isNegativeAuthorizationProposalStatus,
} from '../ports/IDispatchProposalStore.js';
import {
  legacyNegativeAuthorizationRedisKeysForProposal,
  negativeAuthorizationRedisKeysForProposal,
} from './RedisDispatchProposalCreate.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

/**
 * Read the deny-only candidate sets and revalidate every result against its
 * canonical proposal hash in one Redis turn. It deliberately returns only
 * proposal ids/statuses: message content is never part of the admission path.
 */
const FIND_NEGATIVE_AUTHORIZATION_BLOCKS_LUA = `
  local detailPrefix = ARGV[1]
  local ownerUserId = ARGV[2]
  local sourceInvocationId = ARGV[3]
  local sourceThreadId = ARGV[4]
  local senderCatId = ARGV[5]
  local targetThreadId = ARGV[6]
  local blocks = {}

  for index = 1, #KEYS do
    local targetCat = ARGV[6 + index]
    local proposalIds = redis.call('ZRANGE', KEYS[index], 0, -1)
    for _, proposalId in ipairs(proposalIds) do
      local detailKey = detailPrefix .. proposalId
      local status = redis.call('HGET', detailKey, 'status')
      if (status == 'pending' or status == 'rejected' or status == 'superseded')
        and redis.call('HGET', detailKey, 'ownerUserId') == ownerUserId
        and redis.call('HGET', detailKey, 'sourceInvocationId') == sourceInvocationId
        and redis.call('HGET', detailKey, 'sourceThreadId') == sourceThreadId
        and redis.call('HGET', detailKey, 'senderCatId') == senderCatId
        and redis.call('HGET', detailKey, 'targetThreadId') == targetThreadId then
        local targetCatsRaw = redis.call('HGET', detailKey, 'targetCats')
        local decodedOk, targetCats = pcall(cjson.decode, targetCatsRaw or '[]')
        local targetMatches = false
        if decodedOk and type(targetCats) == 'table' then
          for _, candidate in ipairs(targetCats) do
            if candidate == targetCat then
              targetMatches = true
              break
            end
          end
        end
        if targetMatches then
          table.insert(blocks, proposalId)
          table.insert(blocks, status)
          table.insert(blocks, targetCat)
        end
      end
    end
  end

  return blocks
`;

/** Same candidate revalidation for legacy proposals with no exact invocation identity. */
const FIND_LEGACY_NEGATIVE_AUTHORIZATION_BLOCKS_LUA = `
  local detailPrefix = ARGV[1]
  local ownerUserId = ARGV[2]
  local sourceThreadId = ARGV[3]
  local senderCatId = ARGV[4]
  local targetThreadId = ARGV[5]
  local blocks = {}

  for index = 1, #KEYS do
    local targetCat = ARGV[5 + index]
    local proposalIds = redis.call('ZRANGE', KEYS[index], 0, -1)
    for _, proposalId in ipairs(proposalIds) do
      local detailKey = detailPrefix .. proposalId
      local status = redis.call('HGET', detailKey, 'status')
      if (status == 'pending' or status == 'rejected' or status == 'superseded')
        and not redis.call('HGET', detailKey, 'sourceInvocationId')
        and redis.call('HGET', detailKey, 'ownerUserId') == ownerUserId
        and redis.call('HGET', detailKey, 'sourceThreadId') == sourceThreadId
        and redis.call('HGET', detailKey, 'senderCatId') == senderCatId
        and redis.call('HGET', detailKey, 'targetThreadId') == targetThreadId then
        local targetCatsRaw = redis.call('HGET', detailKey, 'targetCats')
        local decodedOk, targetCats = pcall(cjson.decode, targetCatsRaw or '[]')
        local targetMatches = false
        if decodedOk and type(targetCats) == 'table' then
          for _, candidate in ipairs(targetCats) do
            if candidate == targetCat then
              targetMatches = true
              break
            end
          end
        end
        if targetMatches then
          table.insert(blocks, proposalId)
          table.insert(blocks, status)
          table.insert(blocks, targetCat)
        end
      end
    end
  end

  return blocks
`;

/** Atomically backfill a projection only while its canonical proposal still denies admission. */
const BACKFILL_NEGATIVE_AUTHORIZATION_INDEX_LUA = `
  local detailKey = KEYS[1]
  local sourceInvocationId = ARGV[1]
  local proposalId = ARGV[2]
  local createdAt = tonumber(ARGV[3])
  local status = redis.call('HGET', detailKey, 'status')
  if status ~= 'pending' and status ~= 'rejected' and status ~= 'superseded' then return 0 end
  if sourceInvocationId ~= '' and not redis.call('HGET', detailKey, 'sourceInvocationId') then
    redis.call('HSET', detailKey, 'sourceInvocationId', sourceInvocationId)
  end
  for index = 2, #KEYS do
    redis.call('ZADD', KEYS[index], createdAt, proposalId)
  end
  return 1
`;

function decodeNegativeAuthorizationBlocks(raw: unknown): DispatchNegativeAuthorizationBlock[] {
  if (!Array.isArray(raw) || raw.length % 3 !== 0) {
    throw new Error('negative authorization lookup returned an invalid Redis result');
  }
  const blocksByProposal = new Map<string, DispatchNegativeAuthorizationBlock>();
  for (let index = 0; index < raw.length; index += 3) {
    const proposalId = raw[index];
    const status = raw[index + 1];
    const targetCat = raw[index + 2];
    if (
      typeof proposalId !== 'string' ||
      typeof targetCat !== 'string' ||
      (status !== 'pending' && status !== 'rejected' && status !== 'superseded')
    ) {
      throw new Error('negative authorization lookup returned an invalid proposal block');
    }
    const existing = blocksByProposal.get(proposalId);
    if (existing) {
      if (!existing.targetCats.includes(targetCat)) existing.targetCats.push(targetCat);
    } else {
      blocksByProposal.set(proposalId, { proposalId, status, targetCats: [targetCat] });
    }
  }
  return [...blocksByProposal.values()]
    .map((block) => ({ ...block, targetCats: block.targetCats.sort() }))
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
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

/**
 * #1291's deny-only projection coordinator. It owns no custody state: the
 * canonical DispatchProposal hash remains the source of truth on every read.
 */
export class RedisDispatchProposalNegativeAuthorization {
  constructor(private readonly redis: RedisClient) {}

  keysForProposal(proposal: DispatchProposal): string[] {
    return [
      ...negativeAuthorizationRedisKeysForProposal(proposal),
      ...legacyNegativeAuthorizationRedisKeysForProposal(proposal),
    ];
  }

  async findBlocks(input: DispatchNegativeAuthorizationLookup): Promise<DispatchNegativeAuthorizationBlock[]> {
    const targetCats = [...new Set(input.targetCats)];
    if (targetCats.length === 0) return [];
    const indexKeys = targetCats.map((targetCat) =>
      DispatchProposalKeys.negativeAuthorization(
        computeNegativeAuthorizationKey(input.ownerUserId, input.sourceInvocationId, input.targetThreadId, targetCat),
      ),
    );
    const raw = await this.redis.eval(
      FIND_NEGATIVE_AUTHORIZATION_BLOCKS_LUA,
      indexKeys.length,
      ...indexKeys,
      `${this.redis.options.keyPrefix ?? ''}${DispatchProposalKeys.detailPrefix}`,
      input.ownerUserId,
      input.sourceInvocationId,
      input.sourceThreadId,
      input.senderCatId,
      input.targetThreadId,
      ...targetCats,
    );
    return decodeNegativeAuthorizationBlocks(raw);
  }

  async findLegacyBlocks(
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    if (input.invocationCreatedAt > input.cutoverAt) return [];
    const targetCats = [...new Set(input.targetCats)];
    if (targetCats.length === 0) return [];
    const indexKeys = targetCats.map((targetCat) =>
      DispatchProposalKeys.legacyNegativeAuthorization(
        computeLegacyNegativeAuthorizationKey(
          input.ownerUserId,
          input.sourceThreadId,
          input.senderCatId,
          input.targetThreadId,
          targetCat,
        ),
      ),
    );
    const raw = await this.redis.eval(
      FIND_LEGACY_NEGATIVE_AUTHORIZATION_BLOCKS_LUA,
      indexKeys.length,
      ...indexKeys,
      `${this.redis.options.keyPrefix ?? ''}${DispatchProposalKeys.detailPrefix}`,
      input.ownerUserId,
      input.sourceThreadId,
      input.senderCatId,
      input.targetThreadId,
      ...targetCats,
    );
    return decodeNegativeAuthorizationBlocks(raw);
  }

  async getLegacyCutoverAt(): Promise<number | undefined> {
    const raw = await this.redis.get(DispatchProposalKeys.negativeAuthorizationLegacyCutover);
    if (raw === null) return undefined;
    const cutoverAt = Number(raw);
    if (!Number.isFinite(cutoverAt) || cutoverAt <= 0) {
      throw new Error('negative authorization legacy cutover is invalid');
    }
    return cutoverAt;
  }

  async establishLegacyCutoverAt(cutoverAt: number): Promise<number> {
    if (!Number.isFinite(cutoverAt) || cutoverAt <= 0) {
      throw new Error('negative authorization cutoverAt must be positive');
    }
    const rebuildCompletedAt = await this.redis.get(DispatchProposalKeys.negativeAuthorizationLegacyRebuildCompletedAt);
    if (!rebuildCompletedAt) {
      throw new Error('negative authorization legacy cutover requires a completed canonical index rebuild');
    }
    const created = await this.redis.set(
      DispatchProposalKeys.negativeAuthorizationLegacyCutover,
      String(cutoverAt),
      'NX',
    );
    if (created === 'OK') return cutoverAt;
    const existing = await this.getLegacyCutoverAt();
    if (existing === undefined) throw new Error('negative authorization cutover disappeared while establishing');
    return existing;
  }

  private async readProposalHashes(detailKeys: readonly string[]): Promise<Array<Record<string, string> | undefined>> {
    const pipeline = this.redis.pipeline();
    for (const detailKey of detailKeys) pipeline.hgetall(detailKey);
    const rows = await pipeline.exec();
    return (rows ?? []).map(([error, raw]) => (error ? undefined : asProposalHash(raw)));
  }

  private async rebuildProposalIndex(
    detailKey: string,
    raw: Record<string, string> | undefined,
  ): Promise<'exact' | 'legacy' | undefined> {
    if (!raw) return undefined;
    const proposal = hydrateDispatchProposal(raw);
    if (!isNegativeAuthorizationProposalStatus(proposal.status)) return undefined;
    const indexKeys = proposal.sourceInvocationId
      ? negativeAuthorizationRedisKeysForProposal(proposal)
      : legacyNegativeAuthorizationRedisKeysForProposal(proposal);
    if (indexKeys.length === 0) return undefined;
    const rebuilt = await this.redis.eval(
      BACKFILL_NEGATIVE_AUTHORIZATION_INDEX_LUA,
      1 + indexKeys.length,
      detailKey,
      ...indexKeys,
      proposal.sourceInvocationId ?? '',
      proposal.proposalId,
      String(proposal.createdAt),
    );
    if (rebuilt !== 1) return undefined;
    return proposal.sourceInvocationId ? 'exact' : 'legacy';
  }

  async rebuildIndexes(): Promise<{ exactIndexed: number; legacyIndexed: number }> {
    const keyPrefix = this.redis.options.keyPrefix ?? '';
    const scanPattern = `${keyPrefix}${DispatchProposalKeys.detailPrefix}*`;
    let cursor = '0';
    let exactIndexed = 0;
    let legacyIndexed = 0;
    do {
      const [nextCursor, rawKeys] = await this.redis.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
      cursor = nextCursor;
      const detailKeys = detailKeysFromScan(rawKeys, keyPrefix);
      if (detailKeys.length === 0) continue;
      const hashes = await this.readProposalHashes(detailKeys);
      for (const [index, hash] of hashes.entries()) {
        const result = await this.rebuildProposalIndex(detailKeys[index], hash);
        if (result === 'exact') {
          exactIndexed += 1;
        } else if (result === 'legacy') {
          legacyIndexed += 1;
        }
      }
    } while (cursor !== '0');
    await this.redis.set(DispatchProposalKeys.negativeAuthorizationLegacyRebuildCompletedAt, String(Date.now()));
    return { exactIndexed, legacyIndexed };
  }
}
