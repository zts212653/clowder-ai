import type { CatId } from '@cat-cafe/shared';
import {
  WaitContinuationCarrierError,
  waitContinuationCarrierFromStoredMessage,
  waitContinuationCarriersMatch,
} from '../../../../ball-custody/wait-continuation-carrier.js';
import type { IInvocationRecordStore } from '../../stores/ports/InvocationRecordStore.js';
import type { IMessageStore, QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import { markReminderAttemptMissed, markReminderAttemptSeen } from '../../stores/ports/queued-message-receipt.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';
import type { InvocationQueue, QueueEntry } from './InvocationQueue.js';
import { normalizeOwnerAuthProvenance } from './owner-auth-provenance.js';
import { createCrossThreadQueueEntryFromCustody, projectQueuedAttemptIds } from './QueuedMessageCustodyCoordinator.js';
import {
  type QueueSourceResponseEvidence,
  resolveQueueSourceResponseEvidenceFromMessages,
} from './queue-source-response-evidence.js';

interface StartupCustodyLog {
  info(msg: string): void;
  warn(msg: string): void;
}

interface StartupCustodyDeps {
  messageStore: IMessageStore;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  invocationQueue: InvocationQueue;
  log: StartupCustodyLog;
  now?: () => number;
}

export interface QueueCustodyResumeScope {
  threadId: string;
  userId: string;
}

export interface QueueCustodyStartupResult {
  entriesRestored: number;
  messagesBackfilled: number;
  messagesTerminalized: number;
  messagesFailed: number;
  handledTargets: number;
  failedTargets: number;
  resumeScopes: QueueCustodyResumeScope[];
  /** Pre-custody agent handoffs retain their legacy visibility recovery path. */
  legacyVisibilityFallbackMessageIds: string[];
}

interface ReconciledMessage {
  message: StoredMessage;
  terminalized: boolean;
  handledTargets: number;
  failedTargets: number;
}

function uniqueCatIds(values: readonly string[]): CatId[] {
  return [...new Set(values.filter(Boolean))] as CatId[];
}

function activeProjection(custody: QueuedMessageCustody): Omit<QueuedMessageCustody, 'revision' | 'updatedAt'> {
  const { revision: _revision, updatedAt: _updatedAt, ...projection } = custody;
  return projection;
}

function sameActiveProjection(left: QueuedMessageCustody, right: QueuedMessageCustody): boolean {
  return JSON.stringify(activeProjection(left)) === JSON.stringify(activeProjection(right));
}

function resolveRestartReminderAttempts(current: QueuedMessageCustody, now: number): QueuedMessageCustody {
  let projection = current;
  for (const attempt of current.reminderAttempts ?? []) {
    if (attempt.state !== 'requested' && attempt.state !== 'delivered') continue;
    if (current.seenInvocationIdByCatId[attempt.targetCatId] !== attempt.invocationId) continue;
    projection = markReminderAttemptSeen(projection, attempt.targetCatId, attempt.invocationId, now);
  }
  for (const attempt of projection.reminderAttempts ?? []) {
    if (attempt.state !== 'requested' && attempt.state !== 'delivered') continue;
    projection = markReminderAttemptMissed(projection, attempt.invocationId, now);
  }
  return projection;
}

type SuccessfulRestartWitness = 'child_execution' | 'legacy_parent_aggregate';

async function resolveSuccessfulRestartWitness(
  message: StoredMessage,
  catId: string,
  invocationId: string,
  hasExactBodyExposure: boolean,
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>,
): Promise<SuccessfulRestartWitness | null> {
  if (turnExecutionStore) {
    const child = await turnExecutionStore.get(invocationId);
    if (child) {
      return child.status === 'succeeded' &&
        child.threadId === message.threadId &&
        child.userId === message.userId &&
        child.catId === catId
        ? 'child_execution'
        : null;
    }
  }
  // Once an exact child/body tuple exists, only the durable child ledger may
  // close it. The parent aggregate is retained solely as a rolling-migration
  // witness for pre-ledger custody that never recorded an exact exposure.
  if (hasExactBodyExposure) return null;
  const record = await invocationRecordStore.get(invocationId);
  return record?.status === 'succeeded' &&
    record.threadId === message.threadId &&
    record.userId === message.userId &&
    record.targetCats.includes(catId as CatId) &&
    record.successfulCatIds?.includes(catId as CatId) === true
    ? 'legacy_parent_aggregate'
    : null;
}

interface RestartTargetProjection {
  pending: Set<string>;
  handled: Set<string>;
  failed: Set<string>;
  notified: Set<string>;
  awakenedInvocationIdByCatId: Record<string, string>;
  awakenedAtByCatId: Record<string, number>;
  seenInvocationIdByCatId: Record<string, string>;
  targetOutcomeByCatId: NonNullable<QueuedMessageCustody['targetOutcomeByCatId']>;
  handledTargets: number;
  failedTargets: number;
}

interface RestartSourceResponse {
  exposure: NonNullable<QueuedMessageCustody['bodyExposures']>[number];
  witness: QueueSourceResponseEvidence['witness'];
}

function resolveRestartSourceResponse(
  message: StoredMessage,
  current: QueuedMessageCustody,
  catId: string,
  threadMessages: readonly StoredMessage[],
): RestartSourceResponse | null {
  const exposures = [...(current.bodyExposures ?? [])]
    .filter((candidate) => candidate.targetCatId === catId)
    .sort((left, right) => right.seenAt - left.seenAt);
  for (const exposure of exposures) {
    const sourceResponse = resolveQueueSourceResponseEvidenceFromMessages({
      messages: threadMessages,
      catId,
      invocationId: exposure.invocationId,
      sourceMessageIds: [message.id],
    })[0];
    if (sourceResponse) return { exposure, witness: sourceResponse.witness };
  }
  return null;
}

async function resolveRestartTargets(
  message: StoredMessage,
  current: QueuedMessageCustody,
  messageStore: IMessageStore,
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>,
  turnExecutionStore: Pick<ITurnExecutionStore, 'get'> | undefined,
  now: number,
): Promise<RestartTargetProjection> {
  const projection: RestartTargetProjection = {
    pending: new Set<string>(current.pendingTargetCats),
    handled: new Set<string>(current.handledByCatIds),
    failed: new Set<string>(current.failedByCatIds),
    notified: new Set<string>(current.notifiedByCatIds),
    awakenedInvocationIdByCatId: { ...(current.awakenedInvocationIdByCatId ?? {}) },
    awakenedAtByCatId: { ...(current.awakenedAtByCatId ?? {}) },
    seenInvocationIdByCatId: { ...current.seenInvocationIdByCatId },
    targetOutcomeByCatId: { ...(current.targetOutcomeByCatId ?? {}) },
    handledTargets: 0,
    failedTargets: 0,
  };

  const retainedExposureTargets = new Set(
    (current.bodyExposures ?? [])
      .filter((exposure) => projection.pending.has(exposure.targetCatId))
      .map((exposure) => exposure.targetCatId),
  );
  let threadMessages: readonly StoredMessage[] = [];
  if (retainedExposureTargets.size > 0) {
    const readThread = messageStore.getByThreadAfter?.bind(messageStore);
    if (readThread) {
      // Startup custody is server-internal reconciliation, not a viewer read.
      // Managed-command sources are scheduler-authored while their response
      // output belongs to the triggering user, so source userId must not scope
      // this scan. Exact cat/invocation/causal fences below provide authority.
      threadMessages = await readThread(message.threadId);
    }
  }

  // Failed bookkeeping clears the active seen-invocation map but deliberately
  // retains append-only body exposures. A crash between output persistence and
  // exact source settlement must therefore recover from the historical
  // exposure itself. Only a durable, user-visible response causally bound to
  // this exact source qualifies; a bare read or historical child result does
  // not reopen terminal truth.
  for (const catId of [...projection.pending]) {
    if (!retainedExposureTargets.has(catId)) continue;
    const sourceResponse = resolveRestartSourceResponse(message, current, catId, threadMessages);
    if (!sourceResponse) continue;
    const { exposure, witness } = sourceResponse;
    projection.pending.delete(catId);
    projection.handled.add(catId);
    projection.failed.delete(catId);
    projection.notified.delete(catId);
    delete projection.awakenedInvocationIdByCatId[catId];
    delete projection.awakenedAtByCatId[catId];
    delete projection.seenInvocationIdByCatId[catId];
    projection.targetOutcomeByCatId[catId] = {
      invocationId: exposure.invocationId,
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId: exposure.invocationId },
      handledAt: Math.max(now, exposure.seenAt + 1),
      consumption: witness,
    };
    projection.handledTargets += 1;
  }

  for (const [catId, invocationId] of Object.entries(current.seenInvocationIdByCatId)) {
    delete projection.seenInvocationIdByCatId[catId];
    if (!projection.pending.has(catId)) continue;
    const exposure = current.bodyExposures?.find(
      (candidate) => candidate.targetCatId === catId && candidate.invocationId === invocationId,
    );
    const witness = await resolveSuccessfulRestartWitness(
      message,
      catId,
      invocationId,
      exposure !== undefined,
      invocationRecordStore,
      turnExecutionStore,
    );
    if (witness) {
      projection.pending.delete(catId);
      projection.handled.add(catId);
      projection.failed.delete(catId);
      projection.notified.delete(catId);
      delete projection.awakenedInvocationIdByCatId[catId];
      delete projection.awakenedAtByCatId[catId];
      if (witness === 'child_execution' && exposure) {
        // Exact child success without a source-bound output still closes the
        // turn, but must not invent a response witness.
        projection.targetOutcomeByCatId[catId] = {
          invocationId,
          disposition: 'completed_with_turn',
          evidenceRef: { kind: 'invocation_lineage', invocationId },
          handledAt: Math.max(now, exposure.seenAt + 1),
        };
      }
      projection.handledTargets += 1;
    } else {
      projection.failed.add(catId);
      projection.failedTargets += 1;
    }
  }
  for (const catId of Object.keys(current.awakenedInvocationIdByCatId ?? {})) {
    if (current.seenInvocationIdByCatId[catId] || !projection.pending.has(catId)) continue;
    if (!projection.failed.has(catId)) projection.failedTargets += 1;
    projection.failed.add(catId);
  }
  return projection;
}

export class QueuedMessageCustodyStartupReconciler {
  private readonly now: () => number;

  constructor(private readonly deps: StartupCustodyDeps) {
    this.now = deps.now ?? Date.now;
  }

  async reconcile(): Promise<QueueCustodyStartupResult> {
    const scan = this.deps.messageStore.scanByDeliveryStatus;
    if (!scan) return this.emptyResult();

    const queuedMessageIds = await scan.call(this.deps.messageStore, 'queued');
    const activeMessages: StoredMessage[] = [];
    let messagesBackfilled = 0;
    let messagesTerminalized = 0;
    let messagesFailed = 0;
    let handledTargets = 0;
    let failedTargets = 0;
    const legacyVisibilityFallbackMessageIds: string[] = [];

    for (const messageId of queuedMessageIds) {
      try {
        let message = await this.deps.messageStore.getById(messageId);
        if (!message || message.deliveryStatus !== 'queued') continue;
        if (!message.queueCustody) {
          if (message.catId !== null) {
            legacyVisibilityFallbackMessageIds.push(message.id);
            continue;
          }
          const initialized = await this.initializeLegacyCustody(message);
          if (!initialized) continue;
          message = initialized.message;
          if (initialized.backfilled) messagesBackfilled += 1;
        }
        const reconciled = await this.reconcileMessage(message.id);
        if (!reconciled) continue;
        handledTargets += reconciled.handledTargets;
        failedTargets += reconciled.failedTargets;
        if (reconciled.terminalized) {
          messagesTerminalized += 1;
        } else {
          activeMessages.push(reconciled.message);
        }
      } catch (error) {
        messagesFailed += 1;
        this.deps.log.warn(
          `[queue-custody-startup] isolated corrupt/racing message ${messageId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const groups = this.groupActiveMessages(activeMessages);
    const resumeScopes: QueueCustodyResumeScope[] = [];
    let entriesRestored = 0;
    for (const [entryId, messages] of groups) {
      try {
        const entry = this.buildQueueEntry(messages, entryId);
        const outcome = this.deps.invocationQueue.restoreDurableEntry(entry);
        if (outcome !== 'restored') continue;
        entriesRestored += 1;
        resumeScopes.push({ threadId: entry.threadId, userId: entry.userId });
      } catch (error) {
        if (error instanceof WaitContinuationCarrierError) {
          for (const message of messages) {
            try {
              const disposition = await this.terminalizeLegacyUnfencedWait(message.id);
              if (disposition.terminalized) messagesTerminalized += 1;
              failedTargets += disposition.failedTargets;
            } catch (dispositionError) {
              messagesFailed += 1;
              this.deps.log.warn(
                `[queue-custody-startup] failed to terminalize legacy unfenced wait ${message.id}: ` +
                  `${dispositionError instanceof Error ? dispositionError.message : String(dispositionError)}`,
              );
            }
          }
        } else {
          messagesFailed += messages.length;
        }
        this.deps.log.warn(
          `[queue-custody-startup] isolated non-restorable Queue group ${entryId} ` +
            `(${messages.map((message) => message.id).join(',')}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (queuedMessageIds.length > 0) {
      this.deps.log.info(
        `[queue-custody-startup] reconciled ${queuedMessageIds.length} queued message(s), ` +
          `${entriesRestored} Queue owner(s) restored, ${messagesTerminalized} message(s) terminalized`,
      );
    }
    return {
      entriesRestored,
      messagesBackfilled,
      messagesTerminalized,
      messagesFailed,
      handledTargets,
      failedTargets,
      resumeScopes,
      legacyVisibilityFallbackMessageIds,
    };
  }

  private emptyResult(): QueueCustodyStartupResult {
    return {
      entriesRestored: 0,
      messagesBackfilled: 0,
      messagesTerminalized: 0,
      messagesFailed: 0,
      handledTargets: 0,
      failedTargets: 0,
      resumeScopes: [],
      legacyVisibilityFallbackMessageIds: [],
    };
  }

  private async initializeLegacyCustody(
    message: StoredMessage,
  ): Promise<{ message: StoredMessage; backfilled: boolean } | null> {
    const explicitTargets = message.extra?.targetCats?.filter((value): value is string => typeof value === 'string');
    const targets = uniqueCatIds(explicitTargets?.length ? explicitTargets : message.mentions);
    if (targets.length === 0) {
      this.deps.log.warn(
        `[queue-custody-startup] cannot restore legacy queued message without target identity: ${message.id}`,
      );
      return null;
    }
    const custody: QueuedMessageCustody = {
      version: 1,
      entryId: `legacy:${message.id}`,
      revision: 1,
      intent: 'execute',
      status: 'queued',
      allTargetCats: targets,
      pendingTargetCats: targets,
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: message.timestamp,
      updatedAt: this.now(),
    };
    const initialized = await this.deps.messageStore.initializeQueueCustody(message.id, custody);
    if (initialized.kind === 'not_found' || initialized.kind === 'not_queued') return null;
    return { message: initialized.message, backfilled: initialized.kind === 'initialized' };
  }

  private async reconcileMessage(messageId: string): Promise<ReconciledMessage | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const message = await this.deps.messageStore.getById(messageId);
      const current = message?.queueCustody;
      if (!message || message.deliveryStatus !== 'queued' || !current) return null;
      if (current.status === 'terminal' && (current.withdrawnByCatIds?.length ?? 0) > 0) {
        // Author withdrawal intentionally leaves deliveryStatus=queued so the
        // owner timeline keeps the authored body. It is terminal custody, not
        // an orphan to publish or restore after restart.
        return { message, terminalized: true, handledTargets: 0, failedTargets: 0 };
      }
      const built = await this.buildRestartProjection(message, current);
      if (sameActiveProjection(current, built.next)) {
        return { message, terminalized: false, handledTargets: 0, failedTargets: 0 };
      }
      const result = await this.deps.messageStore.transitionQueueCustody(messageId, {
        expectedRevision: current.revision,
        next: built.next,
        ...(built.next.status === 'terminal' ? { deliveredAt: this.now() } : {}),
      });
      if (result.kind === 'revision_mismatch') continue;
      if (result.kind === 'not_found') return null;
      return {
        message: result.message,
        terminalized: result.message.queueCustody?.status === 'terminal',
        handledTargets: built.handledTargets,
        failedTargets: built.failedTargets,
      };
    }
    throw new Error(`queue custody startup CAS retries exhausted for message ${messageId}`);
  }

  private async buildRestartProjection(
    message: StoredMessage,
    current: QueuedMessageCustody,
  ): Promise<{ next: QueuedMessageCustody; handledTargets: number; failedTargets: number }> {
    const now = this.now();
    const target = await resolveRestartTargets(
      message,
      current,
      this.deps.messageStore,
      this.deps.invocationRecordStore,
      this.deps.turnExecutionStore,
      now,
    );
    // A durable body-read witness is stronger than reminder transport state.
    // Resolve those first, then fail-close any other attempt whose old runtime
    // disappeared during restart. This prevents requested/delivered from
    // remaining active forever while never inventing a read.
    const reminderProjection = resolveRestartReminderAttempts(current, now);
    const authorIntentByCatId = current.authorIntentByCatId ? structuredClone(current.authorIntentByCatId) : undefined;
    if (authorIntentByCatId) {
      for (const catId of target.pending) {
        const authorIntent = authorIntentByCatId[catId];
        if (
          authorIntent?.requested !== 'continue_current' ||
          authorIntent.fallbackAt !== undefined ||
          !authorIntent.boundParentInvocationId
        ) {
          continue;
        }
        const hadExposure = (current.bodyExposures ?? []).some((exposure) => exposure.targetCatId === catId);
        authorIntentByCatId[catId] = {
          ...authorIntent,
          fallbackAt: now,
          fallbackReason: hadExposure ? 'parent_non_success_after_exposure' : 'parent_terminal_before_exposure',
        };
      }
    }

    for (const catId of current.steerRequestedByCatIds ?? []) {
      if (!target.pending.has(catId)) continue;
      target.failed.add(catId);
      target.failedTargets += 1;
    }

    const terminal = target.pending.size === 0;
    const {
      processingStartedAt: _processingStartedAt,
      awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
      awakenedAtByCatId: _awakenedAtByCatId,
      steerRequestedByCatIds: _steerRequestedByCatIds,
      steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
      carrierStateByTargetCatId: _carrierStateByTargetCatId,
      ...stableCurrent
    } = current;
    const carrierStateByTargetCatId = current.carrierStateByTargetCatId
      ? Object.fromEntries(
          [...target.pending]
            .filter((catId) => current.carrierByTargetCatId?.[catId])
            .map((catId) => [catId, { status: 'queued' as const }]),
        )
      : undefined;
    return {
      next: {
        ...stableCurrent,
        revision: current.revision + 1,
        status: terminal ? 'terminal' : 'queued',
        ...(authorIntentByCatId ? { authorIntentByCatId } : {}),
        pendingTargetCats: [...target.pending] as CatId[],
        notifiedByCatIds: [...target.notified] as CatId[],
        ...(Object.keys(target.awakenedInvocationIdByCatId).length > 0
          ? { awakenedInvocationIdByCatId: target.awakenedInvocationIdByCatId }
          : {}),
        ...(Object.keys(target.awakenedAtByCatId).length > 0 ? { awakenedAtByCatId: target.awakenedAtByCatId } : {}),
        seenInvocationIdByCatId: target.seenInvocationIdByCatId,
        failedByCatIds: [...target.failed] as CatId[],
        handledByCatIds: [...target.handled] as CatId[],
        targetOutcomeByCatId: target.targetOutcomeByCatId,
        ...(carrierStateByTargetCatId && Object.keys(carrierStateByTargetCatId).length > 0
          ? { carrierStateByTargetCatId }
          : {}),
        ...(reminderProjection.reminderAttempts ? { reminderAttempts: reminderProjection.reminderAttempts } : {}),
        updatedAt: now,
      },
      handledTargets: target.handledTargets,
      failedTargets: target.failedTargets,
    };
  }

  private groupActiveMessages(messages: StoredMessage[]): Map<string, StoredMessage[]> {
    const groups = new Map<string, StoredMessage[]>();
    for (const message of messages) {
      const custody = message.queueCustody;
      if (!custody) continue;
      const entryIds = custody.carrierByTargetCatId
        ? new Set(
            custody.pendingTargetCats.flatMap((catId) => {
              const entryId = custody.carrierByTargetCatId?.[catId]?.entryId;
              return entryId ? [entryId] : [];
            }),
          )
        : new Set([custody.entryId]);
      for (const entryId of entryIds) {
        const group = groups.get(entryId) ?? [];
        group.push(message);
        groups.set(entryId, group);
      }
    }
    return groups;
  }

  private async terminalizeLegacyUnfencedWait(
    messageId: string,
  ): Promise<{ terminalized: boolean; failedTargets: number }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const message = await this.deps.messageStore.getById(messageId);
      const current = message?.queueCustody;
      if (!message || message.deliveryStatus !== 'queued' || !current || current.status === 'terminal') {
        return { terminalized: false, failedTargets: 0 };
      }
      try {
        waitContinuationCarrierFromStoredMessage(message);
        return { terminalized: false, failedTargets: 0 };
      } catch (error) {
        if (!(error instanceof WaitContinuationCarrierError)) throw error;
      }
      const now = this.now();
      const failedTargetCats = uniqueCatIds([...current.failedByCatIds, ...current.pendingTargetCats]);
      const reminderProjection = resolveRestartReminderAttempts(current, now);
      const {
        processingStartedAt: _processingStartedAt,
        awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
        awakenedAtByCatId: _awakenedAtByCatId,
        steerRequestedByCatIds: _steerRequestedByCatIds,
        steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
        carrierStateByTargetCatId: _carrierStateByTargetCatId,
        reminderAttempts: _reminderAttempts,
        ...stableCurrent
      } = current;
      const result = await this.deps.messageStore.transitionQueueCustody(messageId, {
        expectedRevision: current.revision,
        next: {
          ...stableCurrent,
          revision: current.revision + 1,
          status: 'terminal',
          pendingTargetCats: [],
          failedByCatIds: failedTargetCats,
          ...(reminderProjection.reminderAttempts ? { reminderAttempts: reminderProjection.reminderAttempts } : {}),
          updatedAt: now,
        },
        deliveredAt: now,
      });
      if (result.kind === 'revision_mismatch') continue;
      if (result.kind === 'not_found') return { terminalized: false, failedTargets: 0 };
      return { terminalized: true, failedTargets: current.pendingTargetCats.length };
    }
    throw new Error(`legacy wait terminalization CAS retries exhausted for message ${messageId}`);
  }

  private buildQueueEntry(messages: StoredMessage[], entryId: string): QueueEntry {
    messages.sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    const primary = messages[0];
    const custody = primary?.queueCustody;
    if (!primary || !custody || custody.status !== 'queued' || custody.pendingTargetCats.length === 0) {
      throw new Error('active queue custody group is missing its primary projection');
    }
    if (custody.carrierByTargetCatId) {
      return createCrossThreadQueueEntryFromCustody(messages, entryId);
    }
    for (const sibling of messages.slice(1)) {
      const siblingCustody = sibling.queueCustody;
      if (
        !siblingCustody ||
        sibling.threadId !== primary.threadId ||
        sibling.userId !== primary.userId ||
        !sameActiveProjection(custody, siblingCustody)
      ) {
        throw new Error(`divergent queued message custody group: ${custody.entryId}`);
      }
    }
    const pendingTargets = [...custody.pendingTargetCats];
    if (pendingTargets.length === 0) {
      throw new Error(`active queue custody group has no target for carrier ${entryId}`);
    }
    const allTargets = [...custody.allTargetCats];
    const waitContinuationCarrier = waitContinuationCarrierFromStoredMessage(primary);
    for (const sibling of messages.slice(1)) {
      if (!waitContinuationCarriersMatch(waitContinuationCarrierFromStoredMessage(sibling), waitContinuationCarrier)) {
        throw new Error(`divergent wait continuation carriers for Queue entry ${entryId}`);
      }
    }
    const targetSet = new Set<string>(allTargets);
    const filterTargets = (values: readonly CatId[]): CatId[] => values.filter((catId) => targetSet.has(catId));
    const filterInvocationMap = (values: Readonly<Record<string, string>>): Record<string, string> =>
      Object.fromEntries(Object.entries(values).filter(([catId]) => targetSet.has(catId)));
    const filterTimestampMap = (values: Readonly<Record<string, number>>): Record<string, number> =>
      Object.fromEntries(Object.entries(values).filter(([catId]) => targetSet.has(catId)));
    const queuedAttemptIdByCatId = projectQueuedAttemptIds(custody, pendingTargets);
    return {
      id: entryId,
      threadId: primary.threadId,
      userId: primary.userId,
      ownerAuthProvenance: normalizeOwnerAuthProvenance(custody.ownerAuthProvenance),
      content: messages.map((message) => message.content).join('\n'),
      messageId: primary.id,
      mergedMessageIds: messages.slice(1).map((message) => message.id),
      source: waitContinuationCarrier ? 'connector' : 'user',
      ...(waitContinuationCarrier ? { waitContinuationCarrier } : {}),
      targetCats: pendingTargets,
      allTargetCats: allTargets,
      ...(custody.authorIntentByCatId ? { authorIntentByCatId: structuredClone(custody.authorIntentByCatId) } : {}),
      queuedNotifiedByCatIds: filterTargets(custody.notifiedByCatIds),
      queuedAwakenedInvocationIdByCatId: filterInvocationMap(custody.awakenedInvocationIdByCatId ?? {}),
      queuedAwakenedAtByCatId: filterTimestampMap(custody.awakenedAtByCatId ?? {}),
      queuedSeenByCatIds: filterTargets(custody.seenByCatIds),
      queuedSeenInvocationIdByCatId: filterInvocationMap(custody.seenInvocationIdByCatId),
      queuedBodyExposures: (custody.bodyExposures ?? [])
        .filter((exposure) => targetSet.has(exposure.targetCatId))
        .map((exposure) => ({ ...exposure })),
      queuedFailedByCatIds: filterTargets(custody.failedByCatIds),
      ...(Object.keys(queuedAttemptIdByCatId).length > 0 ? { queuedAttemptIdByCatId } : {}),
      queuedHandledByCatIds: filterTargets(custody.handledByCatIds),
      steerRequestedByCatIds: filterTargets(custody.steerRequestedByCatIds ?? []),
      steeredInvocationIdByCatId: filterInvocationMap(custody.steeredInvocationIdByCatId ?? {}),
      intent: custody.intent,
      status: 'queued',
      createdAt: custody.createdAt,
      autoExecute: false,
      priority: custody.priority,
      ...(custody.position !== undefined ? { position: custody.position } : {}),
    };
  }
}
