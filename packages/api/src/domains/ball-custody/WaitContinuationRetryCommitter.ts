import type { RedisClient } from '@cat-cafe/shared/utils';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { assertQueueCustodyTransition } from '../cats/services/stores/ports/queued-message-custody.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import { hydrateTask } from '../cats/services/stores/redis/RedisTaskCodec.js';
import { parseConnectorSourceField } from '../cats/services/stores/redis/redis-message-parsers.js';
import { MessageKeys } from '../cats/services/stores/redis-keys/message-keys.js';
import { TaskKeys } from '../cats/services/stores/redis-keys/task-keys.js';
import type { ActionSuccessorLeaseStore, ActionSuccessorOutputPreflightResult } from './ActionSuccessorLeaseStore.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { parseActionSuccessorLease } from './action-successor-redis-codecs.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import {
  evaluateWaitRetryAuthoritySnapshot,
  type RetryAuthorityDecision,
  type RetryAuthorityFailureReason,
  resolveRetryAuthorityMessageSubject,
  type WaitContinuationRetryPreflightInput,
} from './WaitContinuationRetryPreflight.js';

export interface RetryCustodyTransition {
  readonly messageId: string;
  readonly current: QueuedMessageCustody;
  readonly next: QueuedMessageCustody;
}

export type RetryAuthorityCommitResult =
  | { readonly outcome: 'committed' }
  | { readonly outcome: 'custody_conflict' | 'unavailable' }
  | { readonly outcome: 'authority_stale'; readonly reason: RetryAuthorityFailureReason };

export type RetryAuthorityCommit = (
  transitions: readonly RetryCustodyTransition[],
) => Promise<RetryAuthorityCommitResult>;

interface WaitContinuationRetryCommitterDeps {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'transitionQueueCustody'>;
  readonly taskStore: Pick<ITaskStore, 'get'>;
  readonly actionSuccessorLeaseStore?: Pick<ActionSuccessorLeaseStore, 'preflightOutput'>;
  readonly redis?: RedisClient;
  /** Deterministic race-test seam immediately before the Redis Lua linearization point. */
  readonly beforeAtomicCommit?: () => void | Promise<void>;
}

export interface RetryAuthorityCommitInput {
  readonly authorityMessageId: string;
  readonly requestingUserId: string;
  readonly targetCatId: string;
  readonly transitions: readonly RetryCustodyTransition[];
}

type MaybePromise<T> = T | Promise<T>;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown })?.then === 'function';
}

function evaluateActionSuccessorSnapshot(
  lease: ActionSuccessorLease | null,
  subjectTerminal: boolean,
  generation: number,
  catId: string,
): ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' } {
  if (subjectTerminal) return { ok: false, reason: 'subject_terminal' };
  if (!lease) return { ok: false, reason: 'lease_missing' };
  if (lease.generation !== generation) return { ok: false, reason: 'stale_generation' };
  if (!lease.holderCatIds.includes(catId)) return { ok: false, reason: 'holder_not_assigned' };
  const holderOutcome = lease.holderOutcomes[catId];
  if (holderOutcome) {
    return holderOutcome.outcome === 'succeeded'
      ? { ok: true, reason: 'verified_success' }
      : { ok: false, reason: 'holder_terminal' };
  }
  if (lease.status !== 'active') return { ok: false, reason: 'lease_not_active' };
  return { ok: true, reason: 'active' };
}

function assertRetryCustodyTransitions(transitions: readonly RetryCustodyTransition[]): void {
  if (transitions.length === 0) throw new Error('retry custody commit requires at least one transition');
  const messageIds = new Set<string>();
  for (const transition of transitions) {
    if (!transition.messageId || messageIds.has(transition.messageId)) {
      throw new Error('retry custody commit requires unique non-empty message ids');
    }
    messageIds.add(transition.messageId);
    assertQueueCustodyTransition(transition.current, {
      expectedRevision: transition.current.revision,
      next: transition.next,
    });
    if (
      JSON.stringify(transition.current.bodyExposures ?? []) !== JSON.stringify(transition.next.bodyExposures ?? [])
    ) {
      throw new Error('retry custody commit cannot change prompt exposure history');
    }
  }
}

const COMMIT_RETRY_WITH_AUTHORITY_WITNESS_LUA = `
local function hashFieldEquals(key, field, expected)
  return (redis.call('HGET', key, field) or '') == expected
end

if not hashFieldEquals(KEYS[1], 'id', ARGV[1])
  or not hashFieldEquals(KEYS[1], 'threadId', ARGV[2])
  or not hashFieldEquals(KEYS[1], 'userId', ARGV[3])
  or not hashFieldEquals(KEYS[1], 'catId', ARGV[4]) then
  return 'authority_witness_changed'
end
local sourceExists = redis.call('HEXISTS', KEYS[1], 'source')
if sourceExists ~= tonumber(ARGV[6])
  or (sourceExists == 1 and not hashFieldEquals(KEYS[1], 'source', ARGV[5])) then
  return 'authority_witness_changed'
end

if ARGV[7] == 'wait' then
  if not hashFieldEquals(KEYS[2], 'id', ARGV[8])
    or not hashFieldEquals(KEYS[2], 'kind', ARGV[9])
    or not hashFieldEquals(KEYS[2], 'threadId', ARGV[10])
    or not hashFieldEquals(KEYS[2], 'userId', ARGV[11])
    or not hashFieldEquals(KEYS[2], 'ownerCatId', ARGV[12])
    or not hashFieldEquals(KEYS[2], 'automationState', ARGV[13]) then
    return 'authority_witness_changed'
  end
  if ARGV[14] ~= '' then
    if (redis.call('GET', KEYS[3]) or '') ~= ARGV[14] then return 'authority_witness_changed' end
    if (redis.call('GET', KEYS[4]) or '') ~= ARGV[15] then return 'authority_witness_changed' end
  end
end

local transitionCount = tonumber(ARGV[16])
if not transitionCount or transitionCount < 1 then return redis.error_reply('INVALID_RETRY_TRANSITION_COUNT') end
for index = 1, transitionCount do
  local messageKey = KEYS[4 + index]
  local expectedRevision = tonumber(ARGV[15 + index * 2])
  local nextRaw = ARGV[16 + index * 2]
  local messageId = redis.call('HGET', messageKey, 'id')
  local custody = redis.call('HGET', messageKey, 'queueCustody')
  local currentRevision = tonumber(redis.call('HGET', messageKey, 'queueCustodyRevision') or '0')
  if not messageId or not custody or currentRevision ~= expectedRevision then return 'custody_conflict' end
  if redis.call('HGET', messageKey, 'deliveryStatus') ~= 'queued' then return 'custody_conflict' end
  local okNext, nextCustody = pcall(cjson.decode, nextRaw)
  if not okNext or type(nextCustody) ~= 'table' then return redis.error_reply('INVALID_RETRY_QUEUE_CUSTODY') end
  if tonumber(nextCustody.revision) ~= expectedRevision + 1 then return redis.error_reply('INVALID_RETRY_REVISION') end
end

for index = 1, transitionCount do
  local messageKey = KEYS[4 + index]
  local nextRaw = ARGV[16 + index * 2]
  local nextCustody = cjson.decode(nextRaw)
  redis.call('HSET', messageKey, 'queueCustody', nextRaw, 'queueCustodyRevision', tostring(nextCustody.revision))
end
return 'committed'
`;

/**
 * Commits all custody attempt appends at the same linearization point that
 * verifies the canonical Task/ActionSuccessor witness. Redis uses one Lua
 * script across the authority and message keys; memory mode uses one
 * synchronous critical section with no await between validation and writes.
 */
export class WaitContinuationRetryCommitter {
  constructor(private readonly deps: WaitContinuationRetryCommitterDeps) {}

  async commit(input: RetryAuthorityCommitInput): Promise<RetryAuthorityCommitResult> {
    assertRetryCustodyTransitions(input.transitions);
    return this.deps.redis ? this.commitRedis(input, this.deps.redis) : this.commitMemory(input);
  }

  private commitMemory(input: RetryAuthorityCommitInput): RetryAuthorityCommitResult {
    const messageResult = this.deps.messageStore.getById(input.authorityMessageId);
    if (isPromiseLike(messageResult)) return { outcome: 'unavailable' };
    if (!messageResult) return { outcome: 'authority_stale', reason: 'message_missing' };
    const request: WaitContinuationRetryPreflightInput = {
      message: messageResult,
      requestingUserId: input.requestingUserId,
      targetCatId: input.targetCatId,
    };
    const subject = resolveRetryAuthorityMessageSubject(request);
    if (!subject.ok) return { outcome: 'authority_stale', reason: subject.reason };

    let decision: RetryAuthorityDecision;
    if (subject.kind === 'user') {
      decision = { ok: true, kind: 'user' };
    } else {
      const taskResult = this.deps.taskStore.get(subject.carrier.waitId);
      if (isPromiseLike(taskResult)) return { outcome: 'unavailable' };
      let lease: ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' } | undefined;
      if (subject.carrier.ownerFence.kind === 'action_successor') {
        const leaseResult = this.deps.actionSuccessorLeaseStore?.preflightOutput(
          subject.carrier.ownerFence.leaseId,
          subject.carrier.ownerFence.generation,
          input.targetCatId,
        );
        if (!leaseResult) lease = { ok: false, reason: 'lease_missing' };
        else if (isPromiseLike(leaseResult)) return { outcome: 'unavailable' };
        else lease = leaseResult;
      }
      decision = evaluateWaitRetryAuthoritySnapshot({ request, carrier: subject.carrier, task: taskResult, lease });
    }
    if (!decision.ok) return { outcome: 'authority_stale', reason: decision.reason };

    for (const transition of input.transitions) {
      const currentResult = this.deps.messageStore.getById(transition.messageId);
      if (isPromiseLike(currentResult)) return { outcome: 'unavailable' };
      if (
        !currentResult?.queueCustody ||
        currentResult.deliveryStatus !== 'queued' ||
        currentResult.queueCustody.revision !== transition.current.revision
      ) {
        return { outcome: 'custody_conflict' };
      }
    }
    for (const transition of input.transitions) {
      const result = this.deps.messageStore.transitionQueueCustody(transition.messageId, {
        expectedRevision: transition.current.revision,
        next: transition.next,
      });
      if (isPromiseLike(result)) return { outcome: 'unavailable' };
      if (result.kind !== 'updated') return { outcome: 'custody_conflict' };
    }
    return { outcome: 'committed' };
  }

  private async commitRedis(input: RetryAuthorityCommitInput, redis: RedisClient): Promise<RetryAuthorityCommitResult> {
    const authorityKey = MessageKeys.detail(input.authorityMessageId);
    const authorityRaw = await redis.hgetall(authorityKey);
    if (!authorityRaw.id) return { outcome: 'authority_stale', reason: 'message_missing' };
    const sourceField = parseConnectorSourceField(authorityRaw.source);
    if (sourceField.kind === 'invalid') {
      return { outcome: 'authority_stale', reason: 'legacy_unattributed' };
    }
    const source = sourceField.kind === 'valid' ? sourceField.source : undefined;
    const authorityMessage = {
      threadId: authorityRaw.threadId ?? '',
      userId: authorityRaw.userId ?? '',
      catId: (authorityRaw.catId || null) as StoredMessage['catId'],
      ...(source ? { source } : {}),
    };
    const request: WaitContinuationRetryPreflightInput = {
      message: authorityMessage,
      requestingUserId: input.requestingUserId,
      targetCatId: input.targetCatId,
    };
    const subject = resolveRetryAuthorityMessageSubject(request);
    if (!subject.ok) return { outcome: 'authority_stale', reason: subject.reason };

    let taskKey = authorityKey;
    let taskRaw: Record<string, string> = {};
    let leaseKey = authorityKey;
    let leaseRaw = '';
    let terminalKey = authorityKey;
    let terminalRaw = '';
    let decision: RetryAuthorityDecision;
    if (subject.kind === 'user') {
      decision = { ok: true, kind: 'user' };
    } else {
      taskKey = TaskKeys.detail(subject.carrier.waitId);
      taskRaw = await redis.hgetall(taskKey);
      const task = taskRaw.id ? hydrateTask(taskRaw) : null;
      let lease: ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' } | undefined;
      if (subject.carrier.ownerFence.kind === 'action_successor') {
        leaseKey = ActionSuccessorKeys.detail(subject.carrier.ownerFence.leaseId);
        leaseRaw = (await redis.get(leaseKey)) ?? '';
        const parsedLease = parseActionSuccessorLease(leaseRaw || null);
        if (parsedLease) {
          terminalKey = ActionSuccessorKeys.subjectTerminal(parsedLease.subjectRef);
          terminalRaw = (await redis.get(terminalKey)) ?? '';
        }
        lease = evaluateActionSuccessorSnapshot(
          parsedLease,
          terminalRaw.length > 0,
          subject.carrier.ownerFence.generation,
          input.targetCatId,
        );
      }
      decision = evaluateWaitRetryAuthoritySnapshot({ request, carrier: subject.carrier, task, lease });
    }
    if (!decision.ok) return { outcome: 'authority_stale', reason: decision.reason };

    await this.deps.beforeAtomicCommit?.();
    const keys = [
      authorityKey,
      taskKey,
      leaseKey,
      terminalKey,
      ...input.transitions.map((transition) => MessageKeys.detail(transition.messageId)),
    ];
    const args = [
      authorityRaw.id ?? '',
      authorityRaw.threadId ?? '',
      authorityRaw.userId ?? '',
      authorityRaw.catId ?? '',
      authorityRaw.source ?? '',
      sourceField.kind === 'absent' ? '0' : '1',
      subject.kind,
      taskRaw.id ?? '',
      taskRaw.kind ?? '',
      taskRaw.threadId ?? '',
      taskRaw.userId ?? '',
      taskRaw.ownerCatId ?? '',
      taskRaw.automationState ?? '',
      leaseRaw,
      terminalRaw,
      String(input.transitions.length),
      ...input.transitions.flatMap((transition) => [
        String(transition.current.revision),
        JSON.stringify(transition.next),
      ]),
    ];
    const outcome = String(await redis.eval(COMMIT_RETRY_WITH_AUTHORITY_WITNESS_LUA, keys.length, ...keys, ...args));
    if (outcome === 'committed') return { outcome };
    if (outcome === 'custody_conflict') return { outcome };
    if (outcome === 'authority_witness_changed') {
      return { outcome: 'authority_stale', reason: 'authority_witness_changed' };
    }
    throw new Error(`unexpected retry authority commit outcome: ${outcome}`);
  }
}
