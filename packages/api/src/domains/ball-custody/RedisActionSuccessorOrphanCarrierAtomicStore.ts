import type { RedisClient } from '@cat-cafe/shared/utils';
import { assertQueueLedgerEntry } from '../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { QueueLedgerKeys } from '../cats/services/agents/invocation/queue-ledger/queue-ledger-keys.js';
import { InvocationKeys } from '../cats/services/stores/redis-keys/invocation-keys.js';
import { MessageKeys } from '../cats/services/stores/redis-keys/message-keys.js';
import { TaskKeys } from '../cats/services/stores/redis-keys/task-keys.js';
import type {
  ActionSuccessorOrphanCarrierAtomicCommitInput,
  ActionSuccessorOrphanCarrierAtomicCommitResult,
  ActionSuccessorOrphanCarrierAtomicStore,
} from './ActionSuccessorOrphanCarrierAtomicStore.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { parseActionSuccessorLease } from './action-successor-redis-codecs.js';

const COMMIT_ORPHAN_TASK_CARRIER_LUA = `
local function keyType(key)
  local value = redis.call('TYPE', key)
  if type(value) == 'table' then return value.ok end
  return value
end
local function typeIs(key, expected, allowNone)
  local actual = keyType(key)
  return actual == expected or (allowNone and actual == 'none')
end
local function absentOrEmpty(value)
  return value == nil or (type(value) == 'table' and next(value) == nil)
end
local function storedTruthy(value)
  return value and value ~= '' and value ~= 'false' and value ~= '0'
end

if not typeIs(KEYS[1], 'string', false) or not typeIs(KEYS[2], 'string', false) or
   not typeIs(KEYS[3], 'string', true) or not typeIs(KEYS[4], 'hash', false) or
   not typeIs(KEYS[5], 'hash', false) or not typeIs(KEYS[6], 'hash', true) or
   not typeIs(KEYS[7], 'list', true) or not typeIs(KEYS[8], 'hash', true) or
   not typeIs(KEYS[9], 'string', true) or not typeIs(KEYS[10], 'string', true) or
   not typeIs(KEYS[11], 'string', true) then
  return {-9, ''}
end
if redis.call('EXISTS', KEYS[3]) == 1 then return {-7, ''} end

local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return {-6, ''} end
local currentOk, current = pcall(cjson.decode, currentRaw)
local nextOk, nextLease = pcall(cjson.decode, ARGV[4])
if not currentOk or type(current) ~= 'table' or not nextOk or type(nextLease) ~= 'table' then
  return {-9, ''}
end
if redis.call('GET', KEYS[2]) ~= KEYS[1] then return {-8, currentRaw} end

-- Exact replay of the complete transaction. A retired Queue row is no longer a replayable recovery.
if tonumber(current.generation) == tonumber(nextLease.generation) and
   tonumber(current.revision) == tonumber(nextLease.revision) and
   current.dispatchId == nextLease.dispatchId then
  if redis.call('GET', KEYS[11]) == ARGV[10] and
     redis.call('HGET', KEYS[6], ARGV[19]) == ARGV[18] and
     redis.call('HGET', KEYS[8], ARGV[10]) == cjson.encode({ARGV[19]}) and
     redis.call('HGET', KEYS[5], 'lifecycle') == ARGV[17] then
    return {2, currentRaw}
  end
  return {-3, currentRaw}
end

if tonumber(current.generation) ~= tonumber(ARGV[1]) or
   tonumber(current.revision) ~= tonumber(ARGV[2]) or current.dispatchId ~= ARGV[3] then
  return {0, currentRaw}
end
if current.leaseId ~= nextLease.leaseId or current.key ~= nextLease.key or
   current.tenantScope ~= ARGV[7] or current.tenantScope ~= nextLease.tenantScope or
   current.subjectRef ~= 'subject:task:' .. ARGV[5] or current.subjectRef ~= nextLease.subjectRef or
   current.actionFamily ~= 'implement' or current.actionFamily ~= nextLease.actionFamily or
   current.successorSlot ~= 'implementer' or current.successorSlot ~= nextLease.successorSlot or
   current.mode ~= 'single' or current.mode ~= nextLease.mode or current.status ~= 'active' or
   nextLease.status ~= 'active' or current.claimOrigin ~= 'structured_transfer' or
   current.claimOrigin ~= nextLease.claimOrigin or type(current.holderCatIds) ~= 'table' or
   #current.holderCatIds ~= 1 or current.holderCatIds[1] ~= ARGV[16] or
   type(nextLease.holderCatIds) ~= 'table' or #nextLease.holderCatIds ~= 1 or
   nextLease.holderCatIds[1] ~= ARGV[16] or current.holderThreadId ~= ARGV[12] or
   current.holderThreadId ~= nextLease.holderThreadId or current.predecessorCatId ~= ARGV[8] or
   current.predecessorCatId ~= nextLease.predecessorCatId or current.predecessorThreadId ~= ARGV[9] or
   current.predecessorThreadId ~= nextLease.predecessorThreadId or not current.terminalPredicate or
   current.terminalPredicate.kind ~= 'task_done' or current.terminalPredicate.subjectRef ~= current.subjectRef or
   not nextLease.terminalPredicate or nextLease.terminalPredicate.kind ~= 'task_done' or
   nextLease.terminalPredicate.subjectRef ~= current.subjectRef or
   nextLease.terminalPredicate.digest ~= current.terminalPredicate.digest or
   not absentOrEmpty(current.holderOutcomes) or not absentOrEmpty(current.completionCandidates) or
   not absentOrEmpty(nextLease.holderOutcomes) or not absentOrEmpty(nextLease.completionCandidates) or
   current.returnDeliveryState ~= nil or current.returnDeliveryEvidenceRef ~= nil or
   current.returnDeliverySlaUntil ~= nil or current.dispatchDeliveryState ~= nil or
   current.dispatchDeliveryReservation ~= nil or current.dispatchDeliveredMessageId ~= nil or
   current.dispatchFailureReason ~= nil or nextLease.returnDeliveryState ~= nil or
   nextLease.returnDeliveryEvidenceRef ~= nil or nextLease.returnDeliverySlaUntil ~= nil or
   nextLease.dispatchDeliveryState ~= nil or nextLease.dispatchDeliveryReservation ~= nil or
   nextLease.dispatchDeliveredMessageId ~= nil or nextLease.dispatchFailureReason ~= nil then
  return {-8, currentRaw}
end

local entrustedRaw = redis.call('HGET', KEYS[4], 'entrustedWork')
local entrustedOk, entrusted = pcall(cjson.decode, entrustedRaw or '')
local taskStatus = redis.call('HGET', KEYS[4], 'status')
if redis.call('HGET', KEYS[4], 'id') ~= ARGV[5] or
   redis.call('HGET', KEYS[4], 'kind') ~= 'work' or
   redis.call('HGET', KEYS[4], 'userId') ~= ARGV[7] or
   redis.call('HGET', KEYS[4], 'ownerCatId') ~= ARGV[8] or
   redis.call('HGET', KEYS[4], 'threadId') ~= ARGV[9] or
   (taskStatus ~= 'todo' and taskStatus ~= 'doing' and taskStatus ~= 'blocked') or
   not entrustedOk or type(entrusted) ~= 'table' or
   tonumber(entrusted.revision) ~= tonumber(ARGV[6]) or
   not entrusted.closure or entrusted.closure.state ~= 'open' or
   not entrusted.developmentScope or entrusted.developmentScope.featureRef ~= ARGV[20] or
   entrusted.developmentScope.phaseKey ~= ARGV[21] or
   entrusted.developmentScope.workUnitRef ~= ARGV[22] or
   entrusted.developmentScope.acceptedSourceRef ~= ARGV[23] or
   entrusted.developmentScope.acceptedRevision ~= ARGV[24] then
  return {-1, currentRaw}
end

local sourceDeliveryStatus = redis.call('HGET', KEYS[5], 'deliveryStatus')
local sourceExtraRaw = redis.call('HGET', KEYS[5], 'extra')
local sourceExtraOk, sourceExtra = pcall(cjson.decode, sourceExtraRaw or '{}')
local sourceIndexValue = redis.call('GET', KEYS[11])
local sourceIdentityKind = ARGV[25]
if sourceIdentityKind == 'indexed' then
  if sourceIndexValue ~= ARGV[10] then return {-2, currentRaw} end
elseif sourceIdentityKind == 'legacy_callback' then
  if sourceIndexValue and sourceIndexValue ~= ARGV[10] then return {-2, currentRaw} end
else
  return {-9, currentRaw}
end
if redis.call('HGET', KEYS[5], 'id') ~= ARGV[10] or
   redis.call('HGET', KEYS[5], 'userId') ~= ARGV[7] or
   redis.call('HGET', KEYS[5], 'threadId') ~= ARGV[12] or
   redis.call('HGET', KEYS[5], 'origin') ~= 'callback' or
   redis.call('HGET', KEYS[5], 'from') ~= ARGV[13] or
   redis.call('HGET', KEYS[5], 'mentions') ~= ARGV[14] or
   redis.call('HGET', KEYS[5], 'content') ~= ARGV[15] or
   (sourceDeliveryStatus and sourceDeliveryStatus ~= '' and sourceDeliveryStatus ~= 'delivered') or
   not redis.call('HGET', KEYS[5], 'deliveredAt') or
   storedTruthy(redis.call('HGET', KEYS[5], 'recall')) or
   storedTruthy(redis.call('HGET', KEYS[5], '_tombstone')) or
   redis.call('HGET', KEYS[5], 'deletedAt') or not sourceExtraOk or type(sourceExtra) ~= 'table' or
   (ARGV[9] ~= ARGV[12] and
     (not sourceExtra.crossPost or sourceExtra.crossPost.sourceThreadId ~= ARGV[9])) then
  return {-2, currentRaw}
end
local currentLifecycle = redis.call('HGET', KEYS[5], 'lifecycle')
if currentLifecycle and currentLifecycle ~= '' then return {-2, currentRaw} end
if sourceIdentityKind == 'legacy_callback' then
  local sourceTimestamp = tonumber(redis.call('HGET', KEYS[5], 'timestamp') or '')
  local currentUpdatedAt = tonumber(current.updatedAt)
  local sourceStream = sourceExtra.stream
  local sourceTurnExecution = sourceExtra.turnExecution
  local coordination = sourceExtra.coordination
  if not sourceTimestamp or not currentUpdatedAt or sourceTimestamp < currentUpdatedAt or
     type(sourceStream) ~= 'table' or sourceStream.turnInvocationId ~= ARGV[26] or
     type(sourceTurnExecution) ~= 'table' or sourceTurnExecution.invocationId ~= ARGV[26] or
     (ARGV[9] ~= ARGV[12] and sourceExtra.crossPost.sourceInvocationId ~= ARGV[26]) or
     (type(coordination) == 'table' and coordination.subjectRef and
       coordination.subjectRef ~= current.subjectRef) then
    return {-2, currentRaw}
  end
end

if redis.call('GET', KEYS[9]) or redis.call('GET', KEYS[10]) then return {-4, currentRaw} end
if redis.call('HEXISTS', KEYS[6], ARGV[19]) == 1 or
   redis.call('HEXISTS', KEYS[8], ARGV[10]) == 1 then return {-3, currentRaw} end
for _, queuedId in ipairs(redis.call('LRANGE', KEYS[7], 0, -1)) do
  if queuedId == ARGV[19] then return {-3, currentRaw} end
end
local rawRows = redis.call('HGETALL', KEYS[6])
for index = 2, #rawRows, 2 do
  local rowOk, row = pcall(cjson.decode, rawRows[index])
  if not rowOk or type(row) ~= 'table' then return {-9, currentRaw} end
  local fence = row.execution and row.execution.actionSuccessorFence
  if row.payload and row.payload.sourceRecordId == ARGV[10] then return {-3, currentRaw} end
  if fence and fence.leaseId == current.leaseId and tonumber(fence.generation) == tonumber(current.generation) then
    return {-3, currentRaw}
  end
end

local entryOk, entry = pcall(cjson.decode, ARGV[18])
local lifecycleOk, lifecycle = pcall(cjson.decode, ARGV[17])
local fence = entryOk and entry.execution and entry.execution.actionSuccessorFence
if not entryOk or type(entry) ~= 'table' or not lifecycleOk or type(lifecycle) ~= 'table' or
   entry.id ~= ARGV[19] or entry.threadId ~= ARGV[12] or entry.status ~= 'queued' or
   not entry.payload or entry.payload.sourceRecordId ~= ARGV[10] or entry.payload.messageId ~= ARGV[10] or
   not entry.owner or entry.owner.kind ~= 'user' or entry.owner.userId ~= ARGV[7] or
   not fence or fence.leaseId ~= nextLease.leaseId or
   tonumber(fence.generation) ~= tonumber(nextLease.generation) or fence.dispatchId ~= nextLease.dispatchId or
   not entry.targets or #entry.targets ~= 1 or entry.targets[1] ~= ARGV[16] then
  return {-5, currentRaw}
end
local transitions = nextLease.orphanCarrierRecoveryTransitions
local transition = transitions and transitions[#transitions]
if tonumber(nextLease.generation) ~= tonumber(current.generation) + 1 or
   tonumber(nextLease.revision) ~= tonumber(current.revision) + 1 or
   not transition or transition.kind ~= 'orphan_carrier_recovery' or
   tonumber(transition.fromGeneration) ~= tonumber(current.generation) or
   tonumber(transition.toGeneration) ~= tonumber(nextLease.generation) or
   transition.taskId ~= ARGV[5] or tonumber(transition.taskRevision) ~= tonumber(ARGV[6]) or
   transition.sourceMessageId ~= ARGV[10] or transition.predecessorCatId ~= current.predecessorCatId or
   transition.predecessorThreadId ~= current.predecessorThreadId or transition.holderCatId ~= ARGV[16] or
   transition.holderThreadId ~= current.holderThreadId or transition.fromDispatchId ~= current.dispatchId or
   transition.toDispatchId ~= nextLease.dispatchId or transition.evidenceRef ~= nextLease.issuerStandingEvidenceRef then
  return {-5, currentRaw}
end

-- All owner reads and execution/Queue absence checks passed. These writes are the one linearization point.
redis.call('SET', KEYS[1], ARGV[4])
-- Make the uniquely resolved pre-cutover Message replayable through the current durable identity.
if sourceIdentityKind == 'legacy_callback' then redis.call('SET', KEYS[11], ARGV[10]) end
redis.call('HSET', KEYS[5], 'lifecycle', ARGV[17])
redis.call('HSET', KEYS[6], ARGV[19], ARGV[18])
redis.call('RPUSH', KEYS[7], ARGV[19])
redis.call('HSET', KEYS[8], ARGV[10], cjson.encode({ARGV[19]}))
return {1, ARGV[4]}
`;

const REJECTION_BY_CODE: Record<
  number,
  Extract<ActionSuccessorOrphanCarrierAtomicCommitResult, { outcome: 'rejected' }>['reason']
> = {
  [-1]: 'task_changed',
  [-2]: 'source_changed',
  [-3]: 'carrier_state_present',
  [-4]: 'execution_present',
  [-5]: 'store_corrupt',
  [-6]: 'store_corrupt',
  [-7]: 'subject_terminal',
  [-8]: 'identity_mismatch',
  [-9]: 'store_corrupt',
};

export class RedisActionSuccessorOrphanCarrierAtomicStore implements ActionSuccessorOrphanCarrierAtomicStore {
  constructor(private readonly redis: RedisClient) {}

  async commit(
    input: ActionSuccessorOrphanCarrierAtomicCommitInput,
  ): Promise<ActionSuccessorOrphanCarrierAtomicCommitResult> {
    assertQueueLedgerEntry(input.entry);
    const { task, source } = input;
    const sourceFrom = source.from;
    if (!sourceFrom || !task.entrustedWork) return { outcome: 'rejected', reason: 'store_corrupt' };
    const raw = (await this.redis.eval(
      COMMIT_ORPHAN_TASK_CARRIER_LUA,
      11,
      ...orphanRecoveryRedisKeys(input),
      ...orphanRecoveryRedisArgs(input, sourceFrom),
    )) as unknown;
    return parseAtomicCommitReceipt(raw);
  }
}

function orphanRecoveryRedisKeys(input: ActionSuccessorOrphanCarrierAtomicCommitInput): string[] {
  const { expectedLease, task, source } = input;
  return [
    ActionSuccessorKeys.detail(expectedLease.leaseId),
    ActionSuccessorKeys.identity(expectedLease),
    ActionSuccessorKeys.subjectTerminal(expectedLease.subjectRef),
    TaskKeys.detail(task.id),
    MessageKeys.detail(source.id),
    QueueLedgerKeys.entries(source.threadId),
    QueueLedgerKeys.order(source.threadId),
    QueueLedgerKeys.messageIndex(source.threadId),
    InvocationKeys.idempotency(source.threadId, source.userId, input.canonicalInvocationKey),
    InvocationKeys.idempotency(source.threadId, source.userId, input.legacyInvocationKey),
    MessageKeys.idempotency(source.userId, source.threadId, input.sourceIdentity.idempotencyKey),
  ];
}

function orphanRecoveryRedisArgs(
  input: ActionSuccessorOrphanCarrierAtomicCommitInput,
  sourceFrom: NonNullable<ActionSuccessorOrphanCarrierAtomicCommitInput['source']['from']>,
): string[] {
  const { expectedLease, nextLease, task, source, entry } = input;
  const entrusted = task.entrustedWork;
  if (!entrusted?.developmentScope) throw new Error('orphan carrier Task lost its entrusted-work contract');
  return [
    String(expectedLease.generation),
    String(expectedLease.revision),
    expectedLease.dispatchId,
    JSON.stringify(nextLease),
    task.id,
    String(entrusted.revision),
    source.userId,
    task.ownerCatId ?? '',
    task.threadId,
    source.id,
    source.userId,
    source.threadId,
    JSON.stringify(sourceFrom),
    JSON.stringify(source.mentions),
    source.content,
    nextLease.holderCatIds[0] ?? '',
    JSON.stringify(input.sourceLifecycle),
    JSON.stringify(entry),
    entry.id,
    entrusted.developmentScope.featureRef,
    entrusted.developmentScope.phaseKey,
    entrusted.developmentScope.workUnitRef,
    entrusted.developmentScope.acceptedSourceRef,
    entrusted.developmentScope.acceptedRevision,
    input.sourceIdentity.kind,
    input.sourceIdentity.kind === 'legacy_callback' ? input.sourceIdentity.sourceInvocationId : '',
  ];
}

function parseAtomicCommitReceipt(raw: unknown): ActionSuccessorOrphanCarrierAtomicCommitResult {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('invalid orphan carrier commit receipt');
  const code = Number(raw[0]);
  const lease = parseActionSuccessorLease(typeof raw[1] === 'string' ? raw[1] : '');
  if (code === 1 || code === 2) {
    if (!lease) throw new Error('orphan carrier commit lost its lease');
    return { outcome: code === 1 ? 'committed' : 'replayed', lease };
  }
  if (code === 0) {
    if (!lease) throw new Error('stale orphan carrier commit lost its lease');
    return { outcome: 'stale', lease };
  }
  return { outcome: 'rejected', reason: REJECTION_BY_CODE[code] ?? 'store_corrupt' };
}
