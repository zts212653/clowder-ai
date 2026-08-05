#!/usr/bin/env node
/**
 * #1291 operator transition: shadow to required for unresolved legacy dispatch proposals.
 *
 * This is deliberately an explicit, two-step production operation:
 *   1. all dispatch producers must already write sourceInvocationId;
 *   2. run this script with a chosen, durable cutover epoch.
 *
 * It first rebuilds the derived exact/legacy denial projections from canonical
 * proposal hashes, then persists the cutover only after the rebuild succeeds.
 * A restart cannot change that epoch. Dry-run is the default.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6398/15 \
 *     node packages/api/src/scripts/enable-negative-authorization-legacy-cutover.mjs --cutover-at=1735689600000
 *   REDIS_URL=redis://localhost:6398/15 node packages/api/src/scripts/enable-negative-authorization-legacy-cutover.mjs \
 *     --cutover-at=1735689600000 --apply
 */

import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL;
const cutoverArg = process.argv.find((arg) => arg.startsWith('--cutover-at='));
const cutoverAt = cutoverArg ? Number(cutoverArg.slice('--cutover-at='.length)) : Number.NaN;
const apply = process.argv.includes('--apply');
const keyPrefix = process.env.REDIS_KEY_PREFIX ?? 'cat-cafe:';
const detailPrefix = `${keyPrefix}dispatch-proposal:`;
const cutoverKey = `${keyPrefix}dispatch-proposal-negative-authorization-legacy-cutover`;
const rebuildCompletedKey = `${keyPrefix}dispatch-proposal-negative-authorization-legacy-rebuild-completed-at`;

if (!redisUrl) throw new Error('REDIS_URL is required; this script never selects a Redis target by default.');
if (!Number.isFinite(cutoverAt) || cutoverAt <= 0) {
  throw new Error('--cutover-at=<epoch-ms> is required and must be a positive epoch millisecond value.');
}

function indexSuffix(parts) {
  return parts.map((part) => encodeURIComponent(part)).join(':');
}

function eventInvocationId(raw) {
  if (raw.sourceInvocationId) return raw.sourceInvocationId;
  const candidates = [];
  if (raw.approvalOriginRef) candidates.push(raw.approvalOriginRef);
  if (raw.publication) {
    try {
      const publication = JSON.parse(raw.publication);
      if (publication?.state === 'anchored') candidates.push(JSON.stringify(publication.envelope?.originRef));
    } catch {
      // A malformed historic publication stays unresolved and is treated conservatively after cutover.
    }
  }
  for (const encoded of candidates) {
    try {
      const origin = JSON.parse(encoded);
      const match = origin?.kind === 'event' ? /^invocation:([^\s:]+)$/.exec(origin.anchor ?? '') : null;
      if (match?.[1]) return match[1];
    } catch {
      // A malformed origin cannot prove an invocation identity.
    }
  }
  return undefined;
}

const BACKFILL_LUA = `
  local detailKey = KEYS[1]
  local sourceInvocationId = ARGV[1]
  local proposalId = ARGV[2]
  local createdAt = tonumber(ARGV[3])
  local status = redis.call('HGET', detailKey, 'status')
  if status ~= 'pending' and status ~= 'rejected' and status ~= 'superseded' then return 0 end
  if sourceInvocationId ~= '' and not redis.call('HGET', detailKey, 'sourceInvocationId') then
    redis.call('HSET', detailKey, 'sourceInvocationId', sourceInvocationId)
  end
  for index = 2, #KEYS do redis.call('ZADD', KEYS[index], createdAt, proposalId) end
  return 1
`;

function parseTargetCats(raw) {
  try {
    return JSON.parse(raw.targetCats ?? '[]');
  } catch {
    return [];
  }
}

function isCanonicalCandidate(raw, targetCats) {
  return (
    ['pending', 'rejected', 'superseded'].includes(raw.status) &&
    Boolean(raw.proposalId && raw.ownerUserId && raw.sourceThreadId && raw.senderCatId && raw.targetThreadId) &&
    Number.isFinite(Number(raw.createdAt)) &&
    Array.isArray(targetCats) &&
    targetCats.length > 0 &&
    targetCats.every((targetCat) => typeof targetCat === 'string' && targetCat.length > 0)
  );
}

function makeIndexKeys(raw, targetCats, sourceInvocationId) {
  return [...new Set(targetCats)].map((targetCat) => {
    const suffix = sourceInvocationId
      ? indexSuffix([raw.ownerUserId, sourceInvocationId, raw.targetThreadId, targetCat])
      : indexSuffix([raw.ownerUserId, raw.sourceThreadId, raw.senderCatId, raw.targetThreadId, targetCat]);
    return sourceInvocationId
      ? `${keyPrefix}dispatch-proposal-negative-authorization:${suffix}`
      : `${keyPrefix}dispatch-proposal-legacy-negative-authorization:${suffix}`;
  });
}

function makeCandidate(key, raw) {
  const targetCats = parseTargetCats(raw);
  if (!isCanonicalCandidate(raw, targetCats)) return undefined;
  const sourceInvocationId = eventInvocationId(raw);
  return { key, raw, sourceInvocationId, indexKeys: makeIndexKeys(raw, targetCats, sourceInvocationId) };
}

async function collectCandidates(redis) {
  const candidates = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${detailPrefix}*`, 'COUNT', 100);
    cursor = nextCursor;
    for (const key of keys) {
      const candidate = makeCandidate(key, await redis.hgetall(key));
      if (candidate) candidates.push(candidate);
      else console.warn(`Skipping malformed dispatch proposal ${key}`);
    }
  } while (cursor !== '0');
  return candidates;
}

async function applyCandidates(redis, candidates) {
  for (const candidate of candidates) {
    await redis.eval(
      BACKFILL_LUA,
      1 + candidate.indexKeys.length,
      candidate.key,
      ...candidate.indexKeys,
      candidate.sourceInvocationId ?? '',
      candidate.raw.proposalId,
      candidate.raw.createdAt,
    );
  }
}

async function main() {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  try {
    await redis.ping();
    const existingCutover = await redis.get(cutoverKey);
    if (existingCutover) {
      console.log(`Legacy cutover is already durable at ${existingCutover}; no transition performed.`);
      return;
    }
    const candidates = await collectCandidates(redis);
    const exact = candidates.filter((candidate) => candidate.sourceInvocationId).length;
    const unresolved = candidates.length - exact;
    console.log(
      `${apply ? 'Applying' : 'Dry run'}: ${exact} exact event/current records, ${unresolved} unresolved legacy records, cutover=${cutoverAt}.`,
    );
    if (!apply) return;
    await applyCandidates(redis, candidates);
    await redis.set(rebuildCompletedKey, String(Date.now()));
    const stored = await redis.set(cutoverKey, String(cutoverAt), 'NX');
    if (stored !== 'OK') {
      throw new Error('Cutover was concurrently established; inspect the stored epoch before retrying.');
    }
    console.log(`Cutover persisted at ${cutoverAt} after ${candidates.length} canonical proposals were indexed.`);
  } finally {
    await redis.quit();
  }
}

await main();
