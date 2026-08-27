import type { CatId, QueueReminderAttempt, QueueTargetAttempt, QueueTargetOutcome } from '@cat-cafe/shared';
import { actionSuccessorFencesMatch } from '../../../../ball-custody/ActionSuccessorAdmissionContract.js';
import type {
  RetryAuthorityCommit,
  RetryCustodyTransition,
} from '../../../../ball-custody/WaitContinuationRetryCommitter.js';
import type { RetryAuthorityFailureReason } from '../../../../ball-custody/WaitContinuationRetryPreflight.js';
import type {
  IMessageStore,
  QueueCustodyAdmissionIntent,
  QueuedMessageCustody,
  RecallMessageToComposerDraftInput,
  RecallMessageToComposerDraftResult,
  StoredMessage,
} from '../../stores/ports/MessageStore.js';
import {
  cloneQueuedMessageCustody,
  type QueueBodyExposure,
  type QueueCustodyActionSuccessorRebindProof,
  type QueueCustodyReplacementProof,
  type QueueTargetCarrierBinding,
  settleQueueCustodyWithdrawal,
} from '../../stores/ports/queued-message-custody.js';
import {
  markReminderAttemptDelivered,
  markReminderAttemptMissed,
  markReminderAttemptSeen,
  requestReminderAttempt,
} from '../../stores/ports/queued-message-receipt.js';
import type { QueueEntry } from './InvocationQueue.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';

interface CoordinatorDeps {
  messageStore: IMessageStore;
  now?: () => number;
}

export interface RetireActionSuccessorQueueCustodyResult {
  changed: boolean;
  messageId: string;
  threadId: string;
  userId: string;
  entryIds: string[];
  targetCatIds: CatId[];
}

const QUEUE_CUSTODY_CAS_MAX_ATTEMPTS = 8;
const QUEUE_CUSTODY_CAS_BASE_DELAY_MS = 25;
const QUEUE_CUSTODY_CAS_MAX_DELAY_MS = 400;

function queueCustodyCasBackoffDelayMs(attempt: number): number {
  const ceiling = Math.min(QUEUE_CUSTODY_CAS_BASE_DELAY_MS * 2 ** attempt, QUEUE_CUSTODY_CAS_MAX_DELAY_MS);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

async function waitForQueueCustodyCasRetry(attempt: number): Promise<void> {
  if (attempt + 1 >= QUEUE_CUSTODY_CAS_MAX_ATTEMPTS) return;
  await new Promise<void>((resolve) => setTimeout(resolve, queueCustodyCasBackoffDelayMs(attempt)));
}

export function isManagedHoldWakeMessage(message: StoredMessage): boolean {
  const meta = message.source?.meta;
  return (
    message.source?.connector === 'hold-ball' &&
    meta?.wakeWhen === true &&
    typeof meta.taskId === 'string' &&
    meta.taskId.length > 0
  );
}

function assertExactDispatchContinuationWitness(
  messageId: string,
  successfulTargetCats: readonly string[],
  outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
): void {
  for (const catId of successfulTargetCats) {
    const consumption = outcomeByCatId?.[catId]?.consumption;
    if (consumption?.kind === 'dispatch_handled_continuation' && consumption.sourceMessageId !== messageId) {
      throw new Error('dispatch handled continuation receipt requires its exact source message');
    }
  }
}

export interface QueueCustodyCompletionResult {
  handledTargetCats: string[];
  pendingTargetCats: string[];
  fullyConsumed: boolean;
}

export interface QueueCustodyMessageCompletionResult extends QueueCustodyCompletionResult {
  messageId: string;
}

export interface QueueCustodySettlementResult {
  perMessage: QueueCustodyMessageCompletionResult[];
}

export type RetryTargetCustodyResult =
  | { outcome: 'retried'; attempt: QueueTargetAttempt }
  | { outcome: 'not_retryable' | 'unavailable' }
  | { outcome: 'authority_stale'; reason: RetryAuthorityFailureReason };

export type RecallMessageToComposerDraftCoordinatorResult =
  | RecallMessageToComposerDraftResult
  | { kind: 'carrier_changed' };

function catIds(values: readonly string[] | undefined): CatId[] {
  return [...(values ?? [])] as CatId[];
}

function targetAttemptId(entryId: string, targetCatId: string, sequence: number): string {
  return `${entryId}:${targetCatId}:${sequence}`;
}

function isTerminalTargetAttempt(attempt: QueueTargetAttempt): boolean {
  return (
    attempt.state === 'failed' ||
    attempt.state === 'interrupted' ||
    attempt.state === 'cancelled' ||
    attempt.state === 'handled'
  );
}

function targetReplayTerminalTruth(
  custody: QueuedMessageCustody,
  targetCatId: string,
): { terminalized: boolean; invocationId?: string } {
  const target = targetCatId as CatId;
  const outcome = custody.targetOutcomeByCatId?.[targetCatId];
  const terminalized =
    Boolean(outcome) ||
    custody.handledByCatIds.includes(target) ||
    custody.withdrawnByCatIds?.includes(target) === true ||
    (custody.status === 'terminal' && !custody.pendingTargetCats.includes(target));
  return {
    terminalized,
    ...(outcome?.invocationId ? { invocationId: outcome.invocationId } : {}),
  };
}

function initialTargetAttempt(
  entryId: string,
  targetCatId: string,
  createdAt: number,
  state: QueueTargetAttempt['state'] = 'queued',
): QueueTargetAttempt {
  return {
    id: targetAttemptId(entryId, targetCatId, 1),
    targetCatId,
    sequence: 1,
    state,
    createdAt,
    updatedAt: createdAt,
    ...(state === 'failed' ? { terminalReason: 'invocation_failed' as const } : {}),
  };
}

function latestTargetAttempt(
  attempts: readonly QueueTargetAttempt[],
  targetCatId: string,
): QueueTargetAttempt | undefined {
  return attempts
    .filter((attempt) => attempt.targetCatId === targetCatId)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
}

/** Pure in-memory projection; canonical attempt history remains in Message custody. */
export function projectQueuedAttemptIds(
  custody: QueuedMessageCustody,
  targetCats: readonly string[] = custody.pendingTargetCats,
): Record<string, string> {
  const projected: Record<string, string> = {};
  for (const targetCatId of targetCats) {
    const attempt = latestTargetAttempt(custody.targetAttempts ?? [], targetCatId);
    if (
      attempt &&
      attempt.sequence > 1 &&
      (attempt.state === 'queued' || attempt.state === 'starting' || attempt.state === 'appended')
    ) {
      projected[targetCatId] = attempt.id;
    }
  }
  return projected;
}

/** Older records gain one deterministic initial attempt on their next custody write. */
function ensureTargetAttempts(custody: QueuedMessageCustody): QueueTargetAttempt[] {
  const attempts = (custody.targetAttempts ?? []).map((attempt) => ({ ...attempt }));
  for (const targetCatId of custody.allTargetCats) {
    if (latestTargetAttempt(attempts, targetCatId)) continue;
    const outcome = custody.targetOutcomeByCatId?.[targetCatId];
    // Legacy handled records can lack child identity entirely. Preserve that
    // honest absence instead of inventing an invocation just to backfill UI.
    if (custody.handledByCatIds.includes(targetCatId) && !outcome?.invocationId) continue;
    const state: QueueTargetAttempt['state'] = custody.handledByCatIds.includes(targetCatId)
      ? 'handled'
      : custody.withdrawnByCatIds?.includes(targetCatId)
        ? 'cancelled'
        : custody.failedByCatIds.includes(targetCatId)
          ? 'failed'
          : 'queued';
    const attempt = initialTargetAttempt(custody.entryId, targetCatId, custody.createdAt, state);
    if (state === 'handled') {
      const exposure = custody.bodyExposures?.find(
        (candidate) => candidate.targetCatId === targetCatId && candidate.invocationId === outcome?.invocationId,
      );
      attempt.invocationId = outcome?.invocationId;
      attempt.seenAt = exposure?.seenAt;
      attempt.updatedAt = outcome?.handledAt ?? custody.updatedAt;
    }
    if (state === 'cancelled') {
      attempt.terminalReason = 'source_withdrawn';
      attempt.updatedAt = custody.withdrawnAtByCatId?.[targetCatId] ?? custody.updatedAt;
    }
    if (state === 'failed') attempt.updatedAt = custody.updatedAt;
    attempts.push(attempt);
  }
  return attempts;
}

function updateTargetAttempt(
  attempts: readonly QueueTargetAttempt[],
  targetCatId: string,
  update: (attempt: QueueTargetAttempt) => QueueTargetAttempt,
): QueueTargetAttempt[] {
  const current = latestTargetAttempt(attempts, targetCatId);
  if (!current || isTerminalTargetAttempt(current)) return attempts.map((attempt) => ({ ...attempt }));
  return attempts.map((attempt) => (attempt.id === current.id ? update(attempt) : { ...attempt }));
}

/**
 * A target can receive the same durable message body in more than one provider
 * turn without an author clicking Retry. Each exact body exposure is still a
 * distinct delivery attempt: rewriting an earlier attempt's invocation
 * identity would make the append-only custody proof reject the next write.
 */
function appendExposureAttempt(
  attempts: readonly QueueTargetAttempt[],
  entryId: string,
  active: QueueTargetAttempt,
  targetCatId: string,
  exposure: QueueBodyExposure,
  failureReason: QueueTargetAttempt['terminalReason'] | undefined,
  failedAt: number | undefined,
): QueueTargetAttempt[] {
  const attempt = initialTargetAttempt(entryId, targetCatId, exposure.seenAt);
  attempt.sequence = active.sequence + 1;
  attempt.id = targetAttemptId(entryId, targetCatId, attempt.sequence);
  attempt.invocationId = exposure.invocationId;
  attempt.seenAt = exposure.seenAt;
  attempt.updatedAt = Math.max(exposure.seenAt, failedAt ?? exposure.seenAt);
  if (failureReason) {
    attempt.state = failureReason === 'invocation_failed' ? 'failed' : 'cancelled';
    attempt.terminalReason = failureReason;
  } else {
    attempt.state = 'appended';
  }
  return [...attempts.map((attempt) => ({ ...attempt })), attempt];
}

function projectTargetAttemptsFromEntry(
  current: QueuedMessageCustody,
  entry: QueueEntry,
  targetCats: readonly string[],
  now: number,
): QueueTargetAttempt[] {
  let attempts = ensureTargetAttempts(current);
  for (const catId of targetCats) {
    const active = latestTargetAttempt(attempts, catId);
    if (!active || isTerminalTargetAttempt(active)) continue;
    const failureAt = entry.queuedFailureAtByCatId?.[catId];
    const failureReason = entry.queuedFailureReasonByCatId?.[catId] ?? 'invocation_failed';
    const bodyExposure = [...(entry.queuedBodyExposures ?? [])]
      .reverse()
      .find((candidate) => candidate.targetCatId === catId && candidate.seenAt >= active.createdAt);
    const awakenedAt = entry.queuedAwakenedAtByCatId?.[catId];
    const awakenedInvocationId = entry.queuedAwakenedInvocationIdByCatId?.[catId];
    const isFailed =
      entry.queuedFailedByCatIds?.includes(catId) && (failureAt === undefined || failureAt >= active.createdAt);
    if (bodyExposure && active.invocationId && active.invocationId !== bodyExposure.invocationId) {
      attempts = appendExposureAttempt(
        attempts,
        current.entryId,
        active,
        catId,
        bodyExposure,
        isFailed ? failureReason : undefined,
        failureAt,
      );
    } else if (entry.queuedHandledByCatIds?.includes(catId)) {
      attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
        ...attempt,
        state: 'handled',
        updatedAt: Math.max(attempt.updatedAt, now),
        ...(bodyExposure ? { invocationId: bodyExposure.invocationId, seenAt: bodyExposure.seenAt } : {}),
      }));
    } else if (isFailed) {
      attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
        ...attempt,
        state: failureReason === 'invocation_cancelled' ? 'cancelled' : 'failed',
        updatedAt: Math.max(attempt.updatedAt, failureAt ?? now),
        terminalReason: failureReason,
      }));
    } else if (bodyExposure) {
      attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
        ...attempt,
        state: 'appended',
        invocationId: bodyExposure.invocationId,
        seenAt: bodyExposure.seenAt,
        updatedAt: Math.max(attempt.updatedAt, bodyExposure.seenAt),
      }));
    } else if (awakenedInvocationId && awakenedAt !== undefined && awakenedAt >= active.createdAt) {
      attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
        ...attempt,
        state: 'starting',
        invocationId: awakenedInvocationId,
        updatedAt: Math.max(attempt.updatedAt, awakenedAt),
      }));
    }
  }
  return attempts;
}

function markTargetAttemptsHandled(
  current: QueuedMessageCustody,
  targetCats: readonly string[],
  invocationId: string,
  handledAt: number,
): QueueTargetAttempt[] {
  let attempts = ensureTargetAttempts(current);
  for (const catId of targetCats) {
    const active = latestTargetAttempt(attempts, catId);
    if (!active || isTerminalTargetAttempt(active)) continue;
    const exposure = current.bodyExposures?.find(
      (candidate) => candidate.targetCatId === catId && candidate.invocationId === invocationId,
    );
    attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
      ...attempt,
      state: 'handled',
      invocationId,
      ...(exposure ? { seenAt: exposure.seenAt } : {}),
      updatedAt: Math.max(attempt.updatedAt, handledAt),
    }));
  }
  return attempts;
}

function markTargetAttemptsCancelled(
  current: QueuedMessageCustody,
  targetCats: readonly string[],
  cancelledAt: number,
): QueueTargetAttempt[] {
  let attempts = ensureTargetAttempts(current);
  for (const catId of targetCats) {
    attempts = updateTargetAttempt(attempts, catId, (attempt) => ({
      ...attempt,
      state: 'cancelled',
      terminalReason: 'source_withdrawn',
      updatedAt: Math.max(attempt.updatedAt, cancelledAt),
    }));
  }
  return attempts;
}

/**
 * Rehydrate one immutable cross-thread Queue carrier from its durable message
 * custody. This is shared by startup recovery and exact action replay so both
 * paths preserve the original entryId/message bundle instead of minting a
 * second carrier.
 */
export function createCrossThreadQueueEntryFromCustody(
  messages: readonly StoredMessage[],
  entryId: string,
  options: { queuedTargetsOnly?: boolean } = {},
): QueueEntry {
  const ordered = [...messages].sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  const groupPrimary = ordered[0];
  if (!groupPrimary) {
    throw new Error('active cross-thread queue custody group is missing its primary projection');
  }
  const members = ordered.flatMap((message) => {
    const custody = message.queueCustody;
    if (
      !custody?.carrierByTargetCatId ||
      (custody.status !== 'queued' && custody.status !== 'processing') ||
      message.threadId !== groupPrimary.threadId ||
      message.userId !== groupPrimary.userId
    ) {
      throw new Error(`invalid queued message custody group for carrier ${entryId}`);
    }
    const ownsPendingTarget = custody.pendingTargetCats.some(
      (catId) =>
        custody.carrierByTargetCatId?.[catId]?.entryId === entryId &&
        (!options.queuedTargetsOnly || custody.carrierStateByTargetCatId?.[catId]?.status !== 'processing'),
    );
    return ownsPendingTarget ? [{ message, custody }] : [];
  });
  const primary = members[0]?.message;
  const custodies = members.map((member) => member.custody);
  if (!primary || custodies.length === 0) {
    throw new Error(`active queue custody group has no target for carrier ${entryId}`);
  }
  const allTargets = [
    ...new Set(
      custodies.flatMap((custody) =>
        custody.allTargetCats.filter((catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId),
      ),
    ),
  ];
  const pendingTargets = [
    ...new Set(
      custodies.flatMap((custody) =>
        custody.pendingTargetCats.filter(
          (catId) =>
            custody.carrierByTargetCatId?.[catId]?.entryId === entryId &&
            (!options.queuedTargetsOnly || custody.carrierStateByTargetCatId?.[catId]?.status !== 'processing'),
        ),
      ),
    ),
  ];
  if (pendingTargets.length === 0) throw new Error(`active queue custody group has no target for carrier ${entryId}`);
  const targetSet = new Set<string>(allTargets);
  const mergeTargets = (select: (custody: QueuedMessageCustody) => readonly CatId[]): CatId[] =>
    [...new Set(custodies.flatMap((custody) => select(custody).filter((catId) => targetSet.has(catId))))] as CatId[];
  const mergeMap = <T>(select: (custody: QueuedMessageCustody) => Readonly<Record<string, T>> | undefined) => {
    const merged: Record<string, T> = {};
    for (const custody of custodies) {
      for (const [catId, value] of Object.entries(select(custody) ?? {})) {
        if (!targetSet.has(catId)) continue;
        const current = merged[catId];
        if (current !== undefined && JSON.stringify(current) !== JSON.stringify(value)) {
          throw new Error(`divergent Queue carrier evidence for ${entryId}/${catId}`);
        }
        merged[catId] = value;
      }
    }
    return merged;
  };
  let bodyExposures: QueueBodyExposure[] = [];
  for (const custody of custodies) {
    bodyExposures = mergeBodyExposures(
      bodyExposures,
      custody.bodyExposures?.filter((exposure) => targetSet.has(exposure.targetCatId)),
    );
  }
  const bindings = custodies.flatMap((custody) =>
    allTargets.flatMap((catId) => {
      const binding = custody.carrierByTargetCatId?.[catId];
      return binding?.entryId === entryId ? [binding] : [];
    }),
  );
  const binding = bindings[0];
  if (!binding || bindings.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(binding))) {
    throw new Error(`divergent target bindings for Queue carrier ${entryId}`);
  }
  const custody = custodies[0];
  if (!custody) {
    throw new Error(`active cross-thread queue custody group is empty for carrier ${entryId}`);
  }
  if (
    custodies.some(
      (candidate) =>
        candidate.intent !== custody.intent ||
        normalizeOwnerAuthProvenance(candidate.ownerAuthProvenance) !==
          normalizeOwnerAuthProvenance(custody.ownerAuthProvenance) ||
        candidate.priority !== custody.priority ||
        candidate.position !== custody.position,
    )
  ) {
    throw new Error(`divergent Queue carrier scheduling projection for ${entryId}`);
  }
  const awakenedInvocationIdByCatId = mergeMap((candidate) => candidate.awakenedInvocationIdByCatId);
  const awakenedAtByCatId = mergeMap((candidate) => candidate.awakenedAtByCatId);
  const seenInvocationIdByCatId = mergeMap((candidate) => candidate.seenInvocationIdByCatId);
  const steeredInvocationIdByCatId = mergeMap((candidate) => candidate.steeredInvocationIdByCatId);
  const soleTargetCatId = allTargets.length === 1 ? allTargets[0] : undefined;
  const durableCarrierIdempotencyKey =
    binding.idempotencyKey ??
    (binding.sourceCategory === 'a2a' && binding.a2aTriggerMessageId && soleTargetCatId
      ? fanoutQueueCarrierIdempotencyKey(binding.a2aTriggerMessageId, soleTargetCatId)
      : undefined);
  return {
    ownerAuthProvenance: normalizeOwnerAuthProvenance(custody.ownerAuthProvenance),
    id: entryId,
    ...(durableCarrierIdempotencyKey ? { idempotencyKey: durableCarrierIdempotencyKey } : {}),
    ...(binding.actionSuccessorFence ? { actionSuccessorFence: { ...binding.actionSuccessorFence } } : {}),
    threadId: primary.threadId,
    userId: primary.userId,
    content: members.map(({ message }) => message.content).join('\n'),
    messageId: primary.id,
    mergedMessageIds: members.slice(1).map(({ message }) => message.id),
    source: binding.source,
    ...(binding.sourceCategory ? { sourceCategory: binding.sourceCategory } : {}),
    ...(binding.callerCatId ? { callerCatId: binding.callerCatId } : {}),
    ...(binding.a2aParentInvocationId ? { a2aParentInvocationId: binding.a2aParentInvocationId } : {}),
    ...(binding.a2aTriggerMessageId ? { a2aTriggerMessageId: binding.a2aTriggerMessageId } : {}),
    targetCats: pendingTargets,
    allTargetCats: allTargets,
    intent: custody.intent,
    status: 'queued',
    createdAt: binding.createdAt,
    autoExecute: binding.autoExecute,
    priority: custody.priority,
    ...(custody.position !== undefined ? { position: custody.position } : {}),
    queuedNotifiedByCatIds: mergeTargets((candidate) => candidate.notifiedByCatIds),
    ...(Object.keys(awakenedInvocationIdByCatId).length > 0
      ? { queuedAwakenedInvocationIdByCatId: awakenedInvocationIdByCatId }
      : {}),
    ...(Object.keys(awakenedAtByCatId).length > 0 ? { queuedAwakenedAtByCatId: awakenedAtByCatId } : {}),
    queuedSeenByCatIds: mergeTargets((candidate) => candidate.seenByCatIds),
    queuedSeenInvocationIdByCatId: seenInvocationIdByCatId,
    queuedBodyExposures: bodyExposures,
    queuedFailedByCatIds: mergeTargets((candidate) => candidate.failedByCatIds),
    queuedHandledByCatIds: mergeTargets((candidate) => candidate.handledByCatIds),
    steerRequestedByCatIds: mergeTargets((candidate) => candidate.steerRequestedByCatIds ?? []),
    steeredInvocationIdByCatId,
  };
}

/**
 * Load every active durable source bound to the requested Queue carriers.
 *
 * Carrier membership is custody state, not a recent-thread-history heuristic.
 * `getByThreadAfter` with no cursor/limit lets both Memory and Redis stores walk
 * the complete retained raw timeline (including queued authoring rows) before
 * we select exact `entryId` bindings.
 */
export async function readCompleteCrossThreadQueueCarrierGroups(
  messageStore: Pick<IMessageStore, 'getByThreadAfter'>,
  threadId: string,
  userId: string,
  entryIds: readonly string[],
): Promise<Map<string, StoredMessage[]>> {
  const requestedEntryIds = new Set(entryIds);
  const groups = new Map<string, StoredMessage[]>(entryIds.map((entryId) => [entryId, []]));
  if (requestedEntryIds.size === 0) return groups;

  const messages = await messageStore.getByThreadAfter(threadId, undefined, undefined, userId, {
    includeQueuedCatMessages: true,
    includeQueuedUserMessages: true,
  });
  for (const message of messages) {
    const custody = message.queueCustody;
    if (message.deliveryStatus !== 'queued' || custody?.status !== 'queued') continue;
    const matchingEntryIds = new Set(
      Object.values(custody.carrierByTargetCatId ?? {}).flatMap((binding) =>
        requestedEntryIds.has(binding.entryId) ? [binding.entryId] : [],
      ),
    );
    for (const entryId of matchingEntryIds) groups.get(entryId)?.push(message);
  }
  return groups;
}

function actionSuccessorCarrierKey(fence: NonNullable<QueueEntry['actionSuccessorFence']>, catId: string): string {
  return `action:${fence.leaseId}:${fence.generation}:${catId}`;
}

function targetBindingHasActionFence(
  binding: QueueTargetCarrierBinding,
  catId: string,
  fence: NonNullable<QueueEntry['actionSuccessorFence']>,
): boolean {
  return (
    JSON.stringify(binding.actionSuccessorFence) === JSON.stringify(fence) &&
    binding.idempotencyKey === actionSuccessorCarrierKey(fence, catId)
  );
}

function bindTargetCarrierActionFence(
  binding: QueueTargetCarrierBinding,
  catId: string,
  fence: NonNullable<QueueEntry['actionSuccessorFence']>,
): QueueTargetCarrierBinding {
  return {
    entryId: binding.entryId,
    idempotencyKey: actionSuccessorCarrierKey(fence, catId),
    actionSuccessorFence: { ...fence },
    source: binding.source,
    sourceCategory: binding.sourceCategory,
    ...(binding.callerCatId ? { callerCatId: binding.callerCatId } : {}),
    ...(binding.a2aParentInvocationId ? { a2aParentInvocationId: binding.a2aParentInvocationId } : {}),
    a2aTriggerMessageId: binding.a2aTriggerMessageId,
    autoExecute: binding.autoExecute,
    createdAt: binding.createdAt,
  };
}

/**
 * Persist a verified action generation onto every durable member of one
 * carrier before restoring it process-locally. A crash between members leaves
 * divergent custody fail-closed; replay idempotently completes the same CAS
 * rebind before provider admission.
 */
export async function rebindCrossThreadQueueCarrierActionFence(
  messageStore: IMessageStore,
  messages: readonly StoredMessage[],
  entryId: string,
  fence: NonNullable<QueueEntry['actionSuccessorFence']>,
  now: () => number = Date.now,
): Promise<StoredMessage[]> {
  return Promise.all(
    messages.map((source) => rebindActionSuccessorCarrierSource(messageStore, source, entryId, fence, now)),
  );
}

function buildActionSuccessorCarrierRebind(
  custody: QueuedMessageCustody,
  entryId: string,
  targetCatIds: CatId[],
  fence: NonNullable<QueueEntry['actionSuccessorFence']>,
  updatedAt: number,
): { next: QueuedMessageCustody; proof: QueueCustodyActionSuccessorRebindProof } {
  const next = cloneQueuedMessageCustody(custody);
  const bindings = next.carrierByTargetCatId;
  if (!bindings) throw new Error(`action-successor Queue carrier lost bindings: ${entryId}`);
  next.revision = custody.revision + 1;
  next.updatedAt = Math.max(custody.updatedAt, updatedAt);
  for (const catId of targetCatIds) {
    const binding = bindings[catId];
    if (!binding) throw new Error(`action-successor Queue carrier target lost binding: ${entryId}/${catId}`);
    bindings[catId] = bindTargetCarrierActionFence(binding, catId, fence);
  }
  return {
    next,
    proof: {
      kind: 'verified_action_successor',
      entryId,
      targetCatIds,
      fence: { ...fence },
    },
  };
}

async function rebindActionSuccessorCarrierSource(
  messageStore: IMessageStore,
  source: StoredMessage,
  entryId: string,
  fence: NonNullable<QueueEntry['actionSuccessorFence']>,
  now: () => number,
): Promise<StoredMessage> {
  for (let attempt = 0; attempt < QUEUE_CUSTODY_CAS_MAX_ATTEMPTS; attempt += 1) {
    const current = await messageStore.getById(source.id);
    const custody = current?.queueCustody;
    if (!current || !custody?.carrierByTargetCatId) {
      throw new Error(`action-successor Queue carrier source lost custody: ${source.id}`);
    }
    const targetCatIds = custody.pendingTargetCats.filter(
      (catId) => custody.carrierByTargetCatId?.[catId]?.entryId === entryId,
    );
    if (targetCatIds.length === 0) return current;
    const alreadyBound = targetCatIds.every((catId) => {
      const binding = custody.carrierByTargetCatId?.[catId];
      return !!binding && targetBindingHasActionFence(binding, catId, fence);
    });
    if (alreadyBound) return current;
    const { next, proof } = buildActionSuccessorCarrierRebind(custody, entryId, targetCatIds, fence, now());
    const result = await messageStore.transitionQueueCustody(source.id, {
      expectedRevision: custody.revision,
      next,
      actionSuccessorRebind: proof,
    });
    if (result.kind === 'updated') return result.message;
    if (result.kind === 'not_found') {
      throw new Error(`action-successor Queue carrier source disappeared: ${source.id}`);
    }
    await waitForQueueCustodyCasRetry(attempt);
  }
  throw new Error(`action-successor Queue carrier rebind did not converge: ${source.id}`);
}

function mergeBodyExposures(
  current: readonly QueueBodyExposure[] | undefined,
  incoming: readonly QueueBodyExposure[] | undefined,
): QueueBodyExposure[] {
  const merged = (current ?? []).map((exposure) => ({ ...exposure }));
  const byKey = new Map(merged.map((exposure) => [`${exposure.targetCatId}\u0000${exposure.invocationId}`, exposure]));
  for (const exposure of incoming ?? []) {
    const key = `${exposure.targetCatId}\u0000${exposure.invocationId}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.seenAt !== exposure.seenAt) throw new Error('queue body exposure timestamp is immutable');
      continue;
    }
    const copy = { ...exposure };
    merged.push(copy);
    byKey.set(key, copy);
  }
  return merged;
}

export function createInitialQueuedMessageCustody(entry: QueueEntry): QueuedMessageCustody {
  const allTargetCats = catIds(entry.allTargetCats ?? entry.targetCats);
  return {
    version: 1,
    entryId: entry.id,
    revision: 1,
    ownerUserId: entry.userId,
    ownerAuthProvenance: entry.ownerAuthProvenance,
    ...(entry.authorIntentByCatId ? { authorIntentByCatId: structuredClone(entry.authorIntentByCatId) } : {}),
    intent: entry.intent,
    status: 'queued',
    allTargetCats,
    pendingTargetCats: catIds(entry.targetCats),
    notifiedByCatIds: catIds(entry.queuedNotifiedByCatIds),
    ...(entry.queuedAwakenedInvocationIdByCatId && Object.keys(entry.queuedAwakenedInvocationIdByCatId).length > 0
      ? { awakenedInvocationIdByCatId: { ...entry.queuedAwakenedInvocationIdByCatId } }
      : {}),
    ...(entry.queuedAwakenedAtByCatId && Object.keys(entry.queuedAwakenedAtByCatId).length > 0
      ? { awakenedAtByCatId: { ...entry.queuedAwakenedAtByCatId } }
      : {}),
    seenByCatIds: catIds(entry.queuedSeenByCatIds),
    seenInvocationIdByCatId: { ...(entry.queuedSeenInvocationIdByCatId ?? {}) },
    ...(entry.queuedBodyExposures?.length
      ? { bodyExposures: entry.queuedBodyExposures.map((exposure) => ({ ...exposure })) }
      : {}),
    targetAttempts: allTargetCats.map((catId) => initialTargetAttempt(entry.id, catId, entry.createdAt)),
    failedByCatIds: catIds(entry.queuedFailedByCatIds),
    handledByCatIds: catIds(entry.queuedHandledByCatIds),
    ...(entry.steerRequestedByCatIds?.length ? { steerRequestedByCatIds: catIds(entry.steerRequestedByCatIds) } : {}),
    ...(entry.prestartRetirement
      ? {
          prestartRetirement: {
            ...entry.prestartRetirement,
            entryIds: [...entry.prestartRetirement.entryIds],
          },
        }
      : {}),
    ...(entry.steeredInvocationIdByCatId && Object.keys(entry.steeredInvocationIdByCatId).length > 0
      ? { steeredInvocationIdByCatId: { ...entry.steeredInvocationIdByCatId } }
      : {}),
    priority: entry.priority,
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

export function fanoutQueueCustodyAdmissionId(messageId: string): string {
  return `queue-custody:${messageId}`;
}

export function fanoutQueueCarrierIdempotencyKey(messageId: string, targetCatId: string): string {
  return `${fanoutQueueCustodyAdmissionId(messageId)}:${targetCatId}`;
}

export function createFanoutQueueCustodyAdmission(
  messageId: string,
  input: {
    ownerUserId: string;
    ownerAuthProvenance: QueueEntry['ownerAuthProvenance'];
    /** Targets already accepted by enqueue policy and safe for restart reconstruction. */
    targetCats: readonly CatId[];
    /** Complete requested group, including targets rejected before carrier staging. */
    requestedTargetCats?: readonly CatId[];
    intent: string;
    callerCatId?: CatId;
    a2aParentInvocationId?: string;
    receiptScope?: QueueCustodyAdmissionIntent['receiptScope'];
    actionSuccessorFence?: QueueEntry['actionSuccessorFence'];
    createdAt: number;
  },
): QueueCustodyAdmissionIntent {
  return {
    version: 1,
    admissionId: fanoutQueueCustodyAdmissionId(messageId),
    ownerUserId: input.ownerUserId,
    ownerAuthProvenance: normalizeOwnerAuthProvenance(input.ownerAuthProvenance),
    intent: input.intent,
    targetCats: [...input.targetCats],
    ...(input.requestedTargetCats ? { requestedTargetCats: [...input.requestedTargetCats] } : {}),
    ...(input.callerCatId ? { callerCatId: input.callerCatId } : {}),
    ...(input.a2aParentInvocationId ? { a2aParentInvocationId: input.a2aParentInvocationId } : {}),
    ...(input.receiptScope ? { receiptScope: input.receiptScope } : {}),
    ...(input.actionSuccessorFence ? { actionSuccessorFence: { ...input.actionSuccessorFence } } : {}),
    priority: 'normal',
    createdAt: input.createdAt,
  };
}

/** Rebuild one independent process-local carrier per durably accepted target. */
export function createFanoutQueueEntriesFromAdmission(
  message: StoredMessage & { queueCustodyAdmission: QueueCustodyAdmissionIntent },
): QueueEntry[] {
  const admission = message.queueCustodyAdmission;
  return admission.targetCats.map((targetCatId) => {
    const entryId = fanoutQueueCarrierIdempotencyKey(message.id, targetCatId);
    return {
      id: entryId,
      threadId: message.threadId,
      userId: admission.ownerUserId,
      ownerAuthProvenance: normalizeOwnerAuthProvenance(admission.ownerAuthProvenance),
      ...(admission.actionSuccessorFence
        ? {
            idempotencyKey: `action:${admission.actionSuccessorFence.leaseId}:${admission.actionSuccessorFence.generation}:${targetCatId}`,
            actionSuccessorFence: { ...admission.actionSuccessorFence },
          }
        : { idempotencyKey: entryId }),
      content: message.content,
      messageId: message.id,
      mergedMessageIds: [],
      source: 'agent' as const,
      sourceCategory: 'a2a' as const,
      targetCats: [targetCatId],
      allTargetCats: [targetCatId],
      intent: admission.intent,
      status: 'queued' as const,
      createdAt: admission.createdAt,
      autoExecute: true,
      queueCustodyAdmissionId: admission.admissionId,
      priority: admission.priority,
      ...(admission.callerCatId ? { callerCatId: admission.callerCatId } : {}),
      ...(admission.a2aParentInvocationId ? { a2aParentInvocationId: admission.a2aParentInvocationId } : {}),
      a2aTriggerMessageId: message.id,
    };
  });
}

interface FanoutQueueCarrierIdentity {
  intent: QueueEntry['intent'] | undefined;
  threadId: string | undefined;
  userId: string | undefined;
  ownerAuthProvenance: ReturnType<typeof normalizeOwnerAuthProvenance>;
  actionSuccessorFence: QueueEntry['actionSuccessorFence'];
}

interface FanoutQueueCarriers {
  carrierByTargetCatId: Record<string, QueueTargetCarrierBinding>;
  carrierStateByTargetCatId: NonNullable<QueuedMessageCustody['carrierStateByTargetCatId']>;
  targetCats: CatId[];
}

function hasFanoutQueueCarrierIdentity(entry: QueueEntry, identity: FanoutQueueCarrierIdentity): boolean {
  return (
    entry.intent === identity.intent &&
    entry.threadId === identity.threadId &&
    entry.userId === identity.userId &&
    normalizeOwnerAuthProvenance(entry.ownerAuthProvenance) === identity.ownerAuthProvenance &&
    JSON.stringify(entry.actionSuccessorFence) === JSON.stringify(identity.actionSuccessorFence) &&
    entry.source === 'agent' &&
    entry.sourceCategory === 'a2a'
  );
}

function appendFanoutQueueCarriers(messageId: string, entry: QueueEntry, carriers: FanoutQueueCarriers): void {
  for (const targetCatId of entry.targetCats) {
    if (carriers.carrierByTargetCatId[targetCatId]) {
      throw new Error(`fan-out Queue target has multiple carriers: ${targetCatId}`);
    }
    if (
      entry.actionSuccessorFence &&
      entry.idempotencyKey !== actionSuccessorCarrierKey(entry.actionSuccessorFence, targetCatId)
    ) {
      throw new Error(`action-successor Queue carrier has mismatched idempotency: ${entry.id}/${targetCatId}`);
    }
    carriers.targetCats.push(targetCatId as CatId);
    carriers.carrierByTargetCatId[targetCatId] = {
      entryId: entry.id,
      ...(entry.actionSuccessorFence
        ? {
            idempotencyKey: actionSuccessorCarrierKey(entry.actionSuccessorFence, targetCatId),
            actionSuccessorFence: { ...entry.actionSuccessorFence },
          }
        : {}),
      source: 'agent',
      sourceCategory: 'a2a',
      ...(entry.callerCatId ? { callerCatId: entry.callerCatId } : {}),
      ...(entry.a2aParentInvocationId ? { a2aParentInvocationId: entry.a2aParentInvocationId } : {}),
      a2aTriggerMessageId: entry.a2aTriggerMessageId ?? messageId,
      autoExecute: true,
      createdAt: entry.createdAt,
    };
    carriers.carrierStateByTargetCatId[targetCatId] = {
      status: entry.status,
      ...(entry.processingStartedAt !== undefined ? { processingStartedAt: entry.processingStartedAt } : {}),
    };
  }
}

export function createInitialFanoutQueuedMessageCustody(
  messageId: string,
  entries: readonly QueueEntry[],
  options: {
    requestedTargetCats?: readonly CatId[];
    createdAt?: number;
    receiptScope?: QueuedMessageCustody['receiptScope'];
    custodyEntryId?: string;
  } = {},
): QueuedMessageCustody {
  const intent = entries[0]?.intent;
  const threadId = entries[0]?.threadId;
  const userId = entries[0]?.userId;
  const ownerAuthProvenance = normalizeOwnerAuthProvenance(entries[0]?.ownerAuthProvenance);
  const actionSuccessorFence = entries[0]?.actionSuccessorFence;
  const identity: FanoutQueueCarrierIdentity = {
    intent,
    threadId,
    userId,
    ownerAuthProvenance,
    actionSuccessorFence,
  };
  const carriers: FanoutQueueCarriers = {
    carrierByTargetCatId: {},
    carrierStateByTargetCatId: {},
    targetCats: [],
  };

  for (const entry of entries) {
    if (!hasFanoutQueueCarrierIdentity(entry, identity)) {
      throw new Error('fan-out Queue carriers must share one A2A message identity');
    }
    appendFanoutQueueCarriers(messageId, entry, carriers);
  }

  const allTargetCats = [...new Set(options.requestedTargetCats ?? carriers.targetCats)] as CatId[];
  if (allTargetCats.length === 0) throw new Error('fan-out Queue custody requires at least one target');
  if (carriers.targetCats.some((catId) => !allTargetCats.includes(catId))) {
    throw new Error('fan-out Queue carrier target must belong to requested targets');
  }
  const pendingTargetCats = allTargetCats.filter((catId) => !!carriers.carrierByTargetCatId[catId]);
  const failedTargetCats = allTargetCats.filter((catId) => !carriers.carrierByTargetCatId[catId]);
  const createdAt = options.createdAt ?? Math.min(...entries.map((entry) => entry.createdAt));
  if (!Number.isFinite(createdAt)) throw new Error('fan-out Queue custody requires a finite createdAt');
  const custodyEntryId = options.custodyEntryId ?? `fanout:${messageId}`;
  return {
    version: 1,
    entryId: custodyEntryId,
    revision: 1,
    ownerUserId: userId,
    ownerAuthProvenance,
    ...(options.receiptScope ? { receiptScope: options.receiptScope } : {}),
    carrierByTargetCatId: carriers.carrierByTargetCatId,
    ...(Object.keys(carriers.carrierStateByTargetCatId).length > 0
      ? { carrierStateByTargetCatId: carriers.carrierStateByTargetCatId }
      : {}),
    intent: intent ?? 'execute',
    status: pendingTargetCats.length > 0 ? 'queued' : 'terminal',
    allTargetCats,
    pendingTargetCats,
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: failedTargetCats,
    targetAttempts: allTargetCats.map((catId) =>
      initialTargetAttempt(custodyEntryId, catId, createdAt, failedTargetCats.includes(catId) ? 'failed' : 'queued'),
    ),
    handledByCatIds: [],
    priority: 'normal',
    createdAt,
    updatedAt: createdAt,
  };
}

export function createInitialCrossThreadQueuedMessageCustody(
  messageId: string,
  entries: readonly QueueEntry[],
  options: {
    requestedTargetCats?: readonly CatId[];
    createdAt?: number;
  } = {},
): QueuedMessageCustody {
  return createInitialFanoutQueuedMessageCustody(messageId, entries, {
    ...options,
    receiptScope: 'cross_thread_delivery',
    custodyEntryId: `cross-thread:${messageId}`,
  });
}

export function sameFanoutCustodyIdentity(
  actual: QueuedMessageCustody | undefined,
  expected: QueuedMessageCustody,
): boolean {
  return (
    !!actual &&
    actual.receiptScope === expected.receiptScope &&
    actual.entryId === expected.entryId &&
    actual.intent === expected.intent &&
    normalizeOwnerAuthProvenance(actual.ownerAuthProvenance) ===
      normalizeOwnerAuthProvenance(expected.ownerAuthProvenance) &&
    JSON.stringify(actual.allTargetCats) === JSON.stringify(expected.allTargetCats) &&
    JSON.stringify(actual.carrierByTargetCatId) === JSON.stringify(expected.carrierByTargetCatId)
  );
}

function activeCustodyFromEntry(entry: QueueEntry, current: QueuedMessageCustody, now: number): QueuedMessageCustody {
  if (current.ownerUserId !== undefined && current.ownerUserId !== entry.userId) {
    throw new Error(`Queue entry ${entry.id} owner principal is immutable`);
  }
  if (normalizeOwnerAuthProvenance(current.ownerAuthProvenance) !== entry.ownerAuthProvenance) {
    throw new Error(`Queue entry ${entry.id} owner authentication provenance is immutable`);
  }
  if (current.carrierByTargetCatId || current.carrierStateByTargetCatId) {
    const ownedTargets = current.allTargetCats.filter((catId) => entry.targetCats.includes(catId));
    const ownsTarget = (catId: string) =>
      !current.carrierByTargetCatId || current.carrierByTargetCatId[catId]?.entryId === entry.id;
    if (
      ownedTargets.length === 0 ||
      entry.targetCats.some((catId) => !ownedTargets.includes(catId as CatId) || !ownsTarget(catId))
    ) {
      throw new Error(`Queue entry ${entry.id} does not own this message custody`);
    }
    const owned = new Set<string>(ownedTargets);
    const mergeTargetSet = (existing: readonly CatId[], incoming: readonly string[] | undefined): CatId[] => {
      const next = new Set(existing.filter((catId) => !owned.has(catId)));
      for (const catId of incoming ?? []) {
        if (owned.has(catId)) next.add(catId as CatId);
      }
      return current.allTargetCats.filter((catId) => next.has(catId));
    };
    const mergeTargetMap = <T>(
      existing: Readonly<Record<string, T>> | undefined,
      incoming: Readonly<Record<string, T>> | undefined,
    ): Record<string, T> => {
      const next = { ...(existing ?? {}) };
      for (const catId of owned) delete next[catId];
      for (const [catId, value] of Object.entries(incoming ?? {})) {
        if (owned.has(catId)) next[catId] = value;
      }
      return next;
    };
    const bodyExposures = mergeBodyExposures(current.bodyExposures, entry.queuedBodyExposures);
    const targetAttempts = projectTargetAttemptsFromEntry(current, entry, ownedTargets, now);
    const carrierStateByTargetCatId = { ...(current.carrierStateByTargetCatId ?? {}) };
    for (const catId of ownedTargets) {
      carrierStateByTargetCatId[catId] = {
        status: entry.status,
        ...(entry.status === 'processing' && entry.processingStartedAt !== undefined
          ? { processingStartedAt: entry.processingStartedAt }
          : {}),
      };
    }
    const status = Object.values(carrierStateByTargetCatId).some((state) => state.status === 'processing')
      ? 'processing'
      : 'queued';
    const seenInvocationIdByCatId = mergeTargetMap(
      current.seenInvocationIdByCatId,
      entry.queuedSeenInvocationIdByCatId,
    );
    const awakenedInvocationIdByCatId = mergeTargetMap(
      current.awakenedInvocationIdByCatId,
      entry.queuedAwakenedInvocationIdByCatId,
    );
    const awakenedAtByCatId = mergeTargetMap(current.awakenedAtByCatId, entry.queuedAwakenedAtByCatId);
    const steeredInvocationIdByCatId = mergeTargetMap(
      current.steeredInvocationIdByCatId,
      entry.steeredInvocationIdByCatId,
    );
    const steerRequestedByCatIds = mergeTargetSet(current.steerRequestedByCatIds ?? [], entry.steerRequestedByCatIds);
    const {
      awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
      awakenedAtByCatId: _awakenedAtByCatId,
      ...stableCurrent
    } = current;
    return {
      ...stableCurrent,
      revision: current.revision + 1,
      status,
      carrierStateByTargetCatId,
      pendingTargetCats: mergeTargetSet(current.pendingTargetCats, entry.targetCats),
      notifiedByCatIds: mergeTargetSet(current.notifiedByCatIds, entry.queuedNotifiedByCatIds),
      ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
      ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
      seenByCatIds: mergeTargetSet(current.seenByCatIds, entry.queuedSeenByCatIds),
      seenInvocationIdByCatId,
      ...(bodyExposures.length > 0 ? { bodyExposures } : {}),
      ...(targetAttempts.length > 0 ? { targetAttempts } : {}),
      failedByCatIds: mergeTargetSet(current.failedByCatIds, entry.queuedFailedByCatIds),
      handledByCatIds: mergeTargetSet(current.handledByCatIds, entry.queuedHandledByCatIds),
      ...(steerRequestedByCatIds.length > 0 ? { steerRequestedByCatIds } : {}),
      ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
      ...(entry.prestartRetirement
        ? {
            prestartRetirement: {
              ...entry.prestartRetirement,
              entryIds: [...entry.prestartRetirement.entryIds],
            },
          }
        : {}),
      updatedAt: now,
    };
  }

  const {
    position: _position,
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    ...stableCurrent
  } = current;
  const bodyExposures = mergeBodyExposures(current.bodyExposures, entry.queuedBodyExposures);
  const targetAttempts = projectTargetAttemptsFromEntry(current, entry, current.allTargetCats, now);
  return {
    ...stableCurrent,
    revision: current.revision + 1,
    status: entry.status,
    ...(entry.authorIntentByCatId ? { authorIntentByCatId: structuredClone(entry.authorIntentByCatId) } : {}),
    pendingTargetCats: catIds(entry.targetCats),
    notifiedByCatIds: catIds(entry.queuedNotifiedByCatIds),
    ...(entry.queuedAwakenedInvocationIdByCatId && Object.keys(entry.queuedAwakenedInvocationIdByCatId).length > 0
      ? { awakenedInvocationIdByCatId: { ...entry.queuedAwakenedInvocationIdByCatId } }
      : {}),
    ...(entry.queuedAwakenedAtByCatId && Object.keys(entry.queuedAwakenedAtByCatId).length > 0
      ? { awakenedAtByCatId: { ...entry.queuedAwakenedAtByCatId } }
      : {}),
    seenByCatIds: catIds(entry.queuedSeenByCatIds),
    seenInvocationIdByCatId: { ...(entry.queuedSeenInvocationIdByCatId ?? {}) },
    ...(bodyExposures.length > 0 ? { bodyExposures } : {}),
    ...(targetAttempts.length > 0 ? { targetAttempts } : {}),
    failedByCatIds: catIds(entry.queuedFailedByCatIds),
    handledByCatIds: catIds(entry.queuedHandledByCatIds),
    ...(entry.steerRequestedByCatIds?.length ? { steerRequestedByCatIds: catIds(entry.steerRequestedByCatIds) } : {}),
    ...(entry.steeredInvocationIdByCatId && Object.keys(entry.steeredInvocationIdByCatId).length > 0
      ? { steeredInvocationIdByCatId: { ...entry.steeredInvocationIdByCatId } }
      : {}),
    ...(entry.prestartRetirement
      ? {
          prestartRetirement: {
            ...entry.prestartRetirement,
            entryIds: [...entry.prestartRetirement.entryIds],
          },
        }
      : {}),
    priority: entry.priority,
    ...(entry.position !== undefined ? { position: entry.position } : {}),
    ...(entry.status === 'processing' && entry.processingStartedAt !== undefined
      ? { processingStartedAt: entry.processingStartedAt }
      : {}),
    updatedAt: now,
  };
}

function comparableCustody(custody: QueuedMessageCustody): Omit<QueuedMessageCustody, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...comparable } = custody;
  return comparable;
}

function sameProjection(left: QueuedMessageCustody, right: QueuedMessageCustody): boolean {
  return JSON.stringify(comparableCustody(left)) === JSON.stringify(comparableCustody(right));
}

function targetOutcome(
  catId: string,
  invocationId: string,
  handledAt: number,
  outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
): QueueTargetOutcome {
  const supplied = outcomeByCatId?.[catId];
  if (supplied && supplied.invocationId !== invocationId) {
    throw new Error(`queue target outcome invocation mismatch for ${catId}`);
  }
  return supplied
    ? { ...supplied, handledAt: Math.max(supplied.handledAt, handledAt) }
    : {
        invocationId,
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId },
        handledAt,
      };
}

function buildSuccessfulTargetTransition(input: {
  current: QueuedMessageCustody;
  successfulTargetCats: readonly string[];
  invocationId: string;
  deliveredAt: number;
  updatedAt: number;
  outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>;
}): { next: QueuedMessageCustody; completion: QueueCustodyCompletionResult } {
  const successful = new Set(input.successfulTargetCats);
  const pendingHandledTargetCats = input.current.pendingTargetCats.filter(
    (catId) => successful.has(catId) && input.current.seenInvocationIdByCatId[catId] === input.invocationId,
  );
  const withdrawnHandledTargetCats = (input.current.withdrawnByCatIds ?? []).filter(
    (catId) =>
      successful.has(catId) &&
      input.current.status === 'terminal' &&
      input.current.bodyExposures?.some(
        (exposure) => exposure.targetCatId === catId && exposure.invocationId === input.invocationId,
      ),
  );
  const handledTargetCats = [...new Set([...pendingHandledTargetCats, ...withdrawnHandledTargetCats])] as CatId[];
  const pendingTargetCats = input.current.pendingTargetCats.filter((catId) => !handledTargetCats.includes(catId));
  const completion = {
    handledTargetCats,
    pendingTargetCats,
    fullyConsumed: pendingTargetCats.length === 0,
  };
  if (handledTargetCats.length === 0) return { next: input.current, completion };

  const handled = new Set(input.current.handledByCatIds);
  const seenInvocationIdByCatId = { ...input.current.seenInvocationIdByCatId };
  const awakenedInvocationIdByCatId = { ...(input.current.awakenedInvocationIdByCatId ?? {}) };
  const awakenedAtByCatId = { ...(input.current.awakenedAtByCatId ?? {}) };
  const steeredInvocationIdByCatId = { ...(input.current.steeredInvocationIdByCatId ?? {}) };
  const carrierStateByTargetCatId = { ...(input.current.carrierStateByTargetCatId ?? {}) };
  const targetOutcomeByCatId = { ...(input.current.targetOutcomeByCatId ?? {}) };
  const withdrawnByCatIds = (input.current.withdrawnByCatIds ?? []).filter(
    (catId) => !handledTargetCats.includes(catId),
  );
  const withdrawnAtByCatId = { ...(input.current.withdrawnAtByCatId ?? {}) };
  for (const catId of handledTargetCats) {
    handled.add(catId);
    delete awakenedInvocationIdByCatId[catId];
    delete awakenedAtByCatId[catId];
    delete seenInvocationIdByCatId[catId];
    delete steeredInvocationIdByCatId[catId];
    delete carrierStateByTargetCatId[catId];
    delete withdrawnAtByCatId[catId];
    const exposure = input.current.bodyExposures?.find(
      (candidate) => candidate.targetCatId === catId && candidate.invocationId === input.invocationId,
    );
    const handledAt = exposure ? Math.max(input.deliveredAt, exposure.seenAt + 1) : input.deliveredAt;
    targetOutcomeByCatId[catId] = targetOutcome(catId, input.invocationId, handledAt, input.outcomeByCatId);
  }

  const remainingSteerRequests = (input.current.steerRequestedByCatIds ?? []).filter(
    (catId) => !handledTargetCats.includes(catId),
  );
  const {
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    carrierStateByTargetCatId: _carrierStateByTargetCatId,
    withdrawnByCatIds: _withdrawnByCatIds,
    withdrawnAtByCatId: _withdrawnAtByCatId,
    ...stableCurrent
  } = input.current;
  return {
    completion,
    next: {
      ...stableCurrent,
      revision: input.current.revision + 1,
      status: completion.fullyConsumed ? 'terminal' : 'queued',
      pendingTargetCats,
      notifiedByCatIds: input.current.notifiedByCatIds.filter((catId) => !handledTargetCats.includes(catId)),
      ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
      ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
      seenInvocationIdByCatId,
      ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
      ...(remainingSteerRequests.length > 0 ? { steerRequestedByCatIds: remainingSteerRequests } : {}),
      ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
      failedByCatIds: input.current.failedByCatIds.filter((catId) => !handledTargetCats.includes(catId)),
      ...(withdrawnByCatIds.length > 0 ? { withdrawnByCatIds } : {}),
      ...(Object.keys(withdrawnAtByCatId).length > 0 ? { withdrawnAtByCatId } : {}),
      handledByCatIds: [...handled],
      targetOutcomeByCatId,
      targetAttempts: markTargetAttemptsHandled(
        input.current,
        handledTargetCats,
        input.invocationId,
        input.deliveredAt,
      ),
      updatedAt: input.updatedAt,
    },
  };
}

function buildRetryTargetTransition(
  current: QueuedMessageCustody,
  targetCatId: string,
  expectedAttemptId: string,
  retriedAt: number,
): { next: QueuedMessageCustody; attempt?: QueueTargetAttempt } {
  if (!current.pendingTargetCats.includes(targetCatId as CatId)) return { next: current };
  const attempts = ensureTargetAttempts(current);
  const previous = latestTargetAttempt(attempts, targetCatId);
  const retryableCancellation = previous?.state === 'cancelled' && previous.terminalReason === 'invocation_cancelled';
  if (!previous || previous.id !== expectedAttemptId || (previous.state !== 'failed' && !retryableCancellation)) {
    return { next: current };
  }
  const sequence = previous.sequence + 1;
  const attempt = initialTargetAttempt(current.entryId, targetCatId, retriedAt);
  attempt.sequence = sequence;
  attempt.id = targetAttemptId(current.entryId, targetCatId, sequence);
  const seenInvocationIdByCatId = { ...current.seenInvocationIdByCatId };
  const awakenedInvocationIdByCatId = { ...(current.awakenedInvocationIdByCatId ?? {}) };
  const awakenedAtByCatId = { ...(current.awakenedAtByCatId ?? {}) };
  delete seenInvocationIdByCatId[targetCatId];
  delete awakenedInvocationIdByCatId[targetCatId];
  delete awakenedAtByCatId[targetCatId];
  const {
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    ...stableCurrent
  } = current;
  return {
    attempt,
    next: {
      ...stableCurrent,
      revision: current.revision + 1,
      notifiedByCatIds: current.notifiedByCatIds.filter((catId) => catId !== targetCatId),
      seenByCatIds: current.seenByCatIds.filter((catId) => catId !== targetCatId),
      seenInvocationIdByCatId,
      ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
      ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
      failedByCatIds: current.failedByCatIds.filter((catId) => catId !== targetCatId),
      targetAttempts: [...attempts, attempt],
      updatedAt: retriedAt,
    },
  };
}
export class QueuedMessageCustodyCoordinator {
  private readonly messageStore: IMessageStore;
  private readonly now: () => number;
  private readonly entryLocks = new Map<string, Promise<void>>();

  constructor(deps: CoordinatorDeps) {
    this.messageStore = deps.messageStore;
    this.now = deps.now ?? Date.now;
  }

  async persistEntry(entry: QueueEntry): Promise<string[]> {
    return this.withEntryLock(entry.id, async () => {
      const managedMessageIds: string[] = [];
      for (const messageId of this.messageIds(entry)) {
        const result = await this.transitionManaged(messageId, (current) =>
          activeCustodyFromEntry(entry, current, this.now()),
        );
        if (result.managed) managedMessageIds.push(messageId);
      }
      return managedMessageIds;
    });
  }

  /**
   * Rebind one exact queued source after recovery proved that its old in-memory
   * carrier is absent. The MessageStore CAS is the linearization point; a crash
   * after it is recoverable from the replacement entryId already in custody.
   */
  async transferEntryCustody(replacement: QueueEntry, proof: QueueCustodyReplacementProof): Promise<boolean> {
    if (proof.replacementEntryId !== replacement.id || proof.previousEntryId === replacement.id) {
      throw new Error('Queue replacement proof does not bind the supplied successor');
    }
    const messageIds = this.messageIds(replacement);
    if (messageIds.length !== 1 || messageIds[0] !== proof.sourceMessageId) {
      throw new Error('Queue replacement must bind one exact source message');
    }

    return this.withEntryLock(proof.previousEntryId, async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const message = await this.messageStore.getById(proof.sourceMessageId);
        const current = message?.queueCustody;
        if (!message || message.threadId !== replacement.threadId || !current) {
          throw new Error('Queue replacement source custody is missing or out of scope');
        }
        if (current.entryId === replacement.id) return false;
        if (current.entryId !== proof.previousEntryId || current.status === 'terminal') {
          throw new Error('Queue replacement no longer owns the expected custody generation');
        }
        const sameTargets =
          current.pendingTargetCats.length === replacement.targetCats.length &&
          current.pendingTargetCats.every((catId) => replacement.targetCats.includes(catId));
        if (
          current.carrierByTargetCatId ||
          !sameTargets ||
          current.intent !== replacement.intent ||
          normalizeOwnerAuthProvenance(current.ownerAuthProvenance) !== replacement.ownerAuthProvenance
        ) {
          throw new Error('Queue replacement custody target, intent, or owner mismatch');
        }
        const { processingStartedAt: _processingStartedAt, position: _position, ...stableCurrent } = current;
        const next: QueuedMessageCustody = {
          ...stableCurrent,
          entryId: replacement.id,
          revision: current.revision + 1,
          status: 'queued',
          priority: replacement.priority,
          ...(replacement.position !== undefined ? { position: replacement.position } : {}),
          updatedAt: this.now(),
        };
        const result = await this.messageStore.transitionQueueCustody(proof.sourceMessageId, {
          expectedRevision: current.revision,
          next,
          replacement: proof,
        });
        if (result.kind === 'updated') return true;
        if (result.kind === 'not_found') throw new Error('Queue replacement custody disappeared during transfer');
      }
      throw new Error(`Queue replacement custody CAS retries exhausted for ${proof.sourceMessageId}`);
    });
  }

  /**
   * Linearize a true-recall body transfer against prompt-exposure persistence
   * for the same Queue carrier. If exposure owns the lock first, its exact
   * witness is present when recall classifies the message; if recall wins,
   * later exposure persistence observes terminal custody and cannot invent a
   * read receipt for the tombstoned body.
   */
  async recallMessageToComposerDraft(
    entryId: string,
    messageId: string,
    input: RecallMessageToComposerDraftInput,
    carrierFence?: { freeze: () => boolean; restore: () => void },
  ): Promise<RecallMessageToComposerDraftCoordinatorResult> {
    return this.withEntryLock(entryId, async () => {
      if (carrierFence && !carrierFence.freeze()) return { kind: 'carrier_changed' as const };
      try {
        const result = await this.messageStore.recallMessageToComposerDraft(messageId, input);
        if (carrierFence && result.kind !== 'recalled' && result.kind !== 'already_recalled') carrierFence.restore();
        return result;
      } catch (error) {
        carrierFence?.restore();
        throw error;
      }
    });
  }

  /** Fail before provider startup unless every queued body has an exact durable exposure witness. */
  async assertPromptExposurePersisted(
    messageIds: readonly string[],
    targetCatId: string,
    invocationId: string,
  ): Promise<void> {
    for (const messageId of messageIds) {
      const message = await this.messageStore.getById(messageId);
      if (!message?.queueCustody) throw new Error(`queued_prompt_exposure_rejected:${messageId}`);
      const witnessed = message.queueCustody.bodyExposures?.some(
        (exposure) => exposure.targetCatId === targetCatId && exposure.invocationId === invocationId,
      );
      if (!witnessed) throw new Error(`queued_prompt_exposure_rejected:${messageId}`);
    }
  }

  /**
   * A recall that wins after prompt construction must still stop provider
   * startup. This barrier is intentionally separate from the witness-set
   * assertion above: active foreign-target custody is not evidence that this
   * invocation was expected to persist a receipt.
   */
  async assertPromptBodiesNotRecalled(
    messageIds: readonly string[],
    targetCatId: string,
    invocationId: string,
  ): Promise<void> {
    for (const messageId of messageIds) {
      const message = await this.messageStore.getById(messageId);
      if (!message?.recall || !message.queueCustody) continue;
      const witnessed = message.queueCustody.bodyExposures?.some(
        (exposure) => exposure.targetCatId === targetCatId && exposure.invocationId === invocationId,
      );
      if (!witnessed) throw new Error(`queued_prompt_exposure_rejected:${messageId}`);
    }
  }

  /**
   * Mechanical no-reentry fence for an exact Queue target.
   *
   * A carrier can be restored after a multi-message success settlement failed
   * midway. If any exact source already contains durable terminal target truth,
   * the provider has crossed the side-effect boundary and the carrier may only
   * be terminalized/reconciled — never executed again.
   */
  async inspectTargetReplayFence(input: {
    entry: QueueEntry;
    targetCatId: string;
  }): Promise<
    | { disposition: 'dispatchable'; sourceMessageIds: string[] }
    | { disposition: 'terminalized'; invocationId?: string; sourceMessageIds: string[] }
  > {
    const sourceMessageIds = this.messageIds(input.entry);
    for (const messageId of sourceMessageIds) {
      const message = await this.messageStore.getById(messageId);
      const custody = message?.queueCustody;
      // Missing and legacy-unbound custody are canonical attempt-classifier
      // states, not process-reader failures. The downstream classifier owns
      // their dispatchability; only an actual store read exception is unknown.
      if (!custody) continue;
      const carrier = custody.carrierByTargetCatId?.[input.targetCatId];
      if (carrier && carrier.entryId !== input.entry.id) {
        return { disposition: 'terminalized', sourceMessageIds };
      }
      if (!carrier && custody.entryId !== input.entry.id) {
        throw new Error(`Queue replay fence entry mismatch for ${messageId}`);
      }
      const terminal = targetReplayTerminalTruth(custody, input.targetCatId);
      if (terminal.terminalized) {
        return {
          disposition: 'terminalized',
          ...(terminal.invocationId ? { invocationId: terminal.invocationId } : {}),
          sourceMessageIds,
        };
      }
    }
    return { disposition: 'dispatchable', sourceMessageIds };
  }

  /**
   * Carrier-independent retirement fence.
   *
   * Pre-start retirement is a Queue lifecycle transition rather than an A2A
   * property. It cancels every durable source and then clears custody, so an
   * old coroutine must stop before provider creation regardless of carrier
   * category. A partially retired batch stays fail-closed for reconciliation;
   * it must not withdraw live siblings or replay the canceled source.
   */
  async inspectCarrierRetirementFence(input: {
    entries: readonly QueueEntry[];
  }): Promise<
    | { disposition: 'dispatchable'; sourceMessageIds: string[] }
    | { disposition: 'terminalized'; sourceMessageIds: string[] }
  > {
    const sourceMessageIds = [...new Set(input.entries.flatMap((entry) => this.messageIds(entry)))];
    let retiredSources = 0;
    for (const messageId of sourceMessageIds) {
      const message = await this.messageStore.getById(messageId);
      if (!message?.queueCustody && message?.deliveryStatus === 'canceled') retiredSources += 1;
    }
    if (retiredSources === 0) return { disposition: 'dispatchable', sourceMessageIds };
    if (retiredSources !== sourceMessageIds.length) {
      throw new Error('Queue carrier retirement is only partially terminalized');
    }
    return { disposition: 'terminalized', sourceMessageIds };
  }

  /**
   * Append one retry attempt only if the caller still names the exact latest
   * failed or stopped-invocation attempt. This is the durable idempotency fence
   * for retry clicks; author withdrawals remain terminal.
   */
  async retryFailedTarget(
    entry: QueueEntry,
    targetCatId: string,
    expectedAttemptId: string,
    commitAuthority: RetryAuthorityCommit,
  ): Promise<RetryTargetCustodyResult> {
    return this.withEntryLock(entry.id, async () => {
      let retriedAttempt: QueueTargetAttempt | undefined;
      const transitions: RetryCustodyTransition[] = [];
      for (const messageId of this.messageIds(entry)) {
        const message = await this.messageStore.getById(messageId);
        const current = message?.queueCustody;
        if (!current || message.deliveryStatus !== 'queued') continue;
        const result = buildRetryTargetTransition(current, targetCatId, expectedAttemptId, this.now());
        if (!result.attempt || result.next === current) continue;
        retriedAttempt = result.attempt;
        transitions.push({ messageId, current, next: result.next });
      }
      if (!retriedAttempt || transitions.length === 0) return { outcome: 'not_retryable' };
      const committed = await commitAuthority(transitions);
      if (committed.outcome === 'authority_stale') return committed;
      if (committed.outcome === 'unavailable') return { outcome: 'unavailable' };
      return committed.outcome === 'committed'
        ? { outcome: 'retried', attempt: retriedAttempt }
        : { outcome: 'not_retryable' };
    });
  }

  /**
   * Remove this carrier's pending targets from actionable custody while
   * retaining the original queued message and an exact owner-visible receipt.
   */
  async withdrawEntry(entry: QueueEntry): Promise<boolean> {
    return this.withEntryLock(entry.id, async () => {
      let changed = false;
      for (const messageId of this.messageIds(entry)) {
        changed =
          (await this.transition(messageId, (current) =>
            settleQueueCustodyWithdrawal(current, entry.targetCats, this.now()),
          )) || changed;
      }
      return changed;
    });
  }

  /**
   * Terminalize the exact durable Queue targets bound to one completed action
   * fence. Immutable carrier bindings remain as receipt provenance.
   */
  async retireActionSuccessorFence(
    messageId: string,
    fence: NonNullable<QueueEntry['actionSuccessorFence']>,
  ): Promise<RetireActionSuccessorQueueCustodyResult | null> {
    const observed = await this.messageStore.getById(messageId);
    const observedCustody = observed?.queueCustody;
    if (!observed || !observedCustody) return null;
    const observedBindings = Object.entries(observedCustody.carrierByTargetCatId ?? {}).filter(([, binding]) =>
      actionSuccessorFencesMatch(binding.actionSuccessorFence, fence),
    );
    if (observedBindings.length === 0) return null;
    const lockKey = `action:${fence.leaseId}:${fence.generation}`;
    return this.withEntryLock(lockKey, async () => {
      let targetCatIds = observedBindings.map(([catId]) => catId as CatId);
      let entryIds = [...new Set(observedBindings.map(([, binding]) => binding.entryId))];
      const changed = await this.transition(
        messageId,
        (current) => {
          const matchingBindings = Object.entries(current.carrierByTargetCatId ?? {}).filter(([, binding]) =>
            actionSuccessorFencesMatch(binding.actionSuccessorFence, fence),
          );
          targetCatIds = matchingBindings.map(([catId]) => catId as CatId);
          entryIds = [...new Set(matchingBindings.map(([, binding]) => binding.entryId))];
          return settleQueueCustodyWithdrawal(current, targetCatIds, this.now(), {
            actionSuccessorTerminalFence: fence,
          });
        },
        undefined,
        true,
      );
      return {
        changed,
        messageId,
        threadId: observed.threadId,
        userId: observed.userId,
        entryIds,
        targetCatIds,
      };
    });
  }

  /**
   * Preserve durable custody for the Queue entry that starts an invocation while
   * preventing that trigger from masquerading as a work-period read receipt.
   */
  async markPrimaryTrigger(entry: QueueEntry): Promise<boolean> {
    return this.withEntryLock(entry.id, async () => {
      let changed = false;
      for (const messageId of this.messageIds(entry)) {
        const messageChanged = await this.transition(messageId, (current) =>
          current.receiptScope === 'primary_trigger'
            ? current
            : {
                ...current,
                revision: current.revision + 1,
                receiptScope: 'primary_trigger',
                updatedAt: this.now(),
              },
        );
        if (messageChanged) changed = true;
      }
      return changed;
    });
  }

  async commitSuccessfulTargets(
    entry: QueueEntry,
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
  ): Promise<QueueCustodySettlementResult> {
    return this.withEntryLock(entry.id, async () => {
      const perMessage: QueueCustodyMessageCompletionResult[] = [];
      for (const messageId of this.messageIds(entry)) {
        const result = await this.commitMessageSuccessfulTargets(
          messageId,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          outcomeByCatId,
        );
        perMessage.push({ messageId, ...result });
      }
      return { perMessage };
    });
  }

  /**
   * Settle only the Queue source messages named by durable response evidence.
   * One operational carrier may contain sources with intentionally different
   * target projections, so source-response settlement must never assume the
   * complete carrier shares one completion result.
   */
  async commitSuccessfulTargetsForMessages(
    entry: QueueEntry,
    messageIds: readonly string[],
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByMessageId: Readonly<Record<string, Readonly<Record<string, QueueTargetOutcome>>>>,
  ): Promise<QueueCustodySettlementResult> {
    const carrierMessageIds = new Set(this.messageIds(entry));
    const selectedMessageIds = [...new Set(messageIds)];
    if (selectedMessageIds.length === 0 || selectedMessageIds.some((messageId) => !carrierMessageIds.has(messageId))) {
      throw new Error('source response settlement must select messages from the exact Queue carrier');
    }
    return this.withEntryLock(entry.id, async () => {
      const perMessage: QueueCustodyMessageCompletionResult[] = [];
      for (const messageId of selectedMessageIds) {
        const result = await this.commitMessageSuccessfulTargets(
          messageId,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          outcomeByMessageId[messageId],
        );
        perMessage.push({ messageId, ...result });
      }
      return { perMessage };
    });
  }

  /**
   * Settle one exact source after its operational Queue carrier has already
   * disappeared (for example, exposed true recall). The durable entryId still
   * owns the lock, so this linearizes with both recall and prompt exposure.
   */
  async commitSuccessfulTargetForMessage(
    entryId: string,
    messageId: string,
    successfulTargetCat: string,
    invocationId: string,
    handledAt: number,
    outcome: QueueTargetOutcome,
    isCarrierDetached?: () => boolean,
  ): Promise<QueueCustodyCompletionResult> {
    return this.withEntryLock(entryId, async () => {
      const message = await this.messageStore.getById(messageId);
      if (!message?.queueCustody || message.queueCustody.entryId !== entryId) {
        throw new Error(`exact Queue custody binding missing for ${messageId}`);
      }
      if (message.queueCustody.status !== 'terminal' && isCarrierDetached?.() !== true) {
        return {
          handledTargetCats: [],
          pendingTargetCats: [...message.queueCustody.pendingTargetCats],
          fullyConsumed: false,
        };
      }
      return this.commitMessageSuccessfulTargets(messageId, [successfulTargetCat], invocationId, handledAt, {
        [successfulTargetCat]: outcome,
      });
    });
  }

  private async commitMessageSuccessfulTargets(
    messageId: string,
    successfulTargetCats: readonly string[],
    invocationId: string,
    deliveredAt: number,
    outcomeByCatId?: Readonly<Record<string, QueueTargetOutcome>>,
  ): Promise<QueueCustodyCompletionResult> {
    const message = await this.messageStore.getById(messageId);
    assertExactDispatchContinuationWitness(messageId, successfulTargetCats, outcomeByCatId);
    if (message && isManagedHoldWakeMessage(message)) {
      for (const catId of successfulTargetCats) {
        const outcome = outcomeByCatId?.[catId];
        const continuation = outcome?.consumption?.kind === 'managed_hold_continued' ? outcome.consumption : undefined;
        if (
          outcome?.disposition !== 'managed_hold_disposition' ||
          (continuation !== undefined &&
            (continuation.sourceMessageId !== messageId || continuation.taskId !== message.source?.meta?.taskId))
        ) {
          throw new Error('managed hold receipt requires its invocation-bound disposition');
        }
      }
    }
    let completion: QueueCustodyCompletionResult = {
      handledTargetCats: [],
      pendingTargetCats: [],
      fullyConsumed: false,
    };
    await this.transition(
      messageId,
      (current) => {
        const transition = buildSuccessfulTargetTransition({
          current,
          successfulTargetCats,
          invocationId,
          deliveredAt,
          updatedAt: this.now(),
          outcomeByCatId,
        });
        completion = transition.completion;
        return transition.next;
      },
      deliveredAt,
      true,
    );
    return completion;
  }

  async requestReminder(
    entry: QueueEntry,
    targetCatId: string,
    invocationId: string,
    reminderId: string,
  ): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      requestReminderAttempt(current, {
        id: reminderId,
        targetCatId,
        invocationId,
        requestedAt: now,
      }),
    );
  }

  async findReminderAttempt(
    entry: QueueEntry,
    targetCatId: string,
    invocationId: string,
  ): Promise<QueueReminderAttempt | undefined> {
    for (const messageId of this.messageIds(entry)) {
      const message = await this.messageStore.getById(messageId);
      const attempt = message?.queueCustody?.reminderAttempts?.find(
        (candidate) => candidate.targetCatId === targetCatId && candidate.invocationId === invocationId,
      );
      if (attempt) return { ...attempt };
    }
    return undefined;
  }

  async markReminderDelivered(entry: QueueEntry, targetCatId: string, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      markReminderAttemptDelivered(current, targetCatId, invocationId, now),
    );
  }

  async markReminderSeen(entry: QueueEntry, targetCatId: string, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) =>
      markReminderAttemptSeen(current, targetCatId, invocationId, now),
    );
  }

  async markReminderMissed(entry: QueueEntry, invocationId: string): Promise<boolean> {
    return this.mutateReminder(entry, (current, now) => markReminderAttemptMissed(current, invocationId, now));
  }

  private async mutateReminder(
    entry: QueueEntry,
    mutate: (current: QueuedMessageCustody, now: number) => QueuedMessageCustody,
  ): Promise<boolean> {
    return this.withEntryLock(entry.id, async () => {
      let changed = false;
      for (const messageId of this.messageIds(entry)) {
        changed =
          (await this.transition(messageId, (current) => {
            const now = this.now();
            const mutated = mutate(current, now);
            if (mutated === current) return current;
            return { ...mutated, revision: current.revision + 1, updatedAt: now };
          })) || changed;
      }
      return changed;
    });
  }

  private async transition(
    messageId: string,
    buildNext: (current: QueuedMessageCustody) => QueuedMessageCustody,
    deliveredAt?: number,
    allowTerminalCurrent = false,
  ): Promise<boolean> {
    return (await this.transitionManaged(messageId, buildNext, deliveredAt, allowTerminalCurrent)).changed;
  }

  private async transitionManaged(
    messageId: string,
    buildNext: (current: QueuedMessageCustody) => QueuedMessageCustody,
    deliveredAt?: number,
    allowTerminalCurrent = false,
  ): Promise<{ managed: boolean; changed: boolean }> {
    for (let attempt = 0; attempt < QUEUE_CUSTODY_CAS_MAX_ATTEMPTS; attempt += 1) {
      const message = await this.messageStore.getById(messageId);
      const current = message?.queueCustody;
      if (!current || (current.status === 'terminal' && !allowTerminalCurrent)) {
        return { managed: false, changed: false };
      }
      const next = buildNext(current);
      if (sameProjection(current, next)) return { managed: true, changed: false };
      const result = await this.messageStore.transitionQueueCustody(messageId, {
        expectedRevision: current.revision,
        next,
        ...(current.status !== 'terminal' && next.status === 'terminal' && deliveredAt !== undefined
          ? { deliveredAt }
          : {}),
      });
      if (result.kind === 'updated') return { managed: true, changed: true };
      if (result.kind === 'not_found') return { managed: false, changed: false };
      await waitForQueueCustodyCasRetry(attempt);
    }
    throw new Error(`queue custody CAS retries exhausted for message ${messageId}`);
  }

  private messageIds(entry: Pick<QueueEntry, 'messageId' | 'mergedMessageIds'>): string[] {
    return [entry.messageId ?? '', ...entry.mergedMessageIds].filter(Boolean);
  }

  private async withEntryLock<T>(entryId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.entryLocks.get(entryId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.entryLocks.set(entryId, settled);
    try {
      return await run;
    } finally {
      if (this.entryLocks.get(entryId) === settled) this.entryLocks.delete(entryId);
    }
  }
}
