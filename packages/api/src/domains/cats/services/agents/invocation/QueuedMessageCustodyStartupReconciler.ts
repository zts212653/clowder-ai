import { WaitContinuationCarrierError } from '../../../../ball-custody/wait-continuation-carrier.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { QueueEntry } from './InvocationQueue.js';
import { activeCarrierEntryIds, queuedCarrierEntryIds } from './QueuedMessageCustodyCarrierProjection.js';
import {
  createFanoutQueueEntriesFromAdmission,
  createInitialFanoutQueuedMessageCustody,
  sameFanoutCustodyIdentity,
} from './QueuedMessageCustodyCoordinator.js';
import {
  initializeLegacyCustody,
  reconcileStartupCustodyMessage,
  terminalizeLegacyUnfencedWait,
} from './QueuedMessageCustodyStartupMessageReconciler.js';
import {
  buildQueueEntry,
  groupActiveMessages,
  hasUnresolvedQueuedCarrierMember,
} from './QueuedMessageCustodyStartupQueueEntry.js';
import type {
  QueueCustodyResumeScope,
  QueueCustodyStartupResult,
  StartupCustodyDeps,
} from './QueuedMessageCustodyStartupTypes.js';

export type { QueueCustodyResumeScope, QueueCustodyStartupResult } from './QueuedMessageCustodyStartupTypes.js';

function emptyResult(): QueueCustodyStartupResult {
  return {
    entriesRestored: 0,
    messagesBackfilled: 0,
    messagesTerminalized: 0,
    messagesFailed: 0,
    handledTargets: 0,
    failedTargets: 0,
    resumeScopes: [],
    prestartRetirements: [],
    legacyVisibilityFallbackMessageIds: [],
  };
}

export class QueuedMessageCustodyStartupReconciler {
  private readonly now: () => number;

  constructor(private readonly deps: StartupCustodyDeps) {
    this.now = deps.now ?? Date.now;
  }

  async reconcile(): Promise<QueueCustodyStartupResult> {
    const scan = this.deps.messageStore.scanByDeliveryStatus;
    if (!scan) return emptyResult();

    const queuedMessageIds = await scan.call(this.deps.messageStore, 'queued');
    const activeMessages: StoredMessage[] = [];
    const deferredCarrierEntryIds = new Set<string>();
    const unresolvedQueuedMessageIds = new Set<string>();
    let messagesBackfilled = 0;
    let messagesTerminalized = 0;
    let messagesFailed = 0;
    let handledTargets = 0;
    let failedTargets = 0;
    const legacyVisibilityFallbackMessageIds: string[] = [];

    for (const messageId of queuedMessageIds) {
      let scannedMessage: StoredMessage | null = null;
      try {
        let message = await this.deps.messageStore.getById(messageId);
        scannedMessage = message;
        if (!message || message.deliveryStatus !== 'queued') continue;
        if (!message.queueCustody) {
          if (message.queueCustodyAdmission) {
            const recoveryEntries = createFanoutQueueEntriesFromAdmission(
              message as StoredMessage & { queueCustodyAdmission: NonNullable<StoredMessage['queueCustodyAdmission']> },
            );
            const admission = message.queueCustodyAdmission;
            const expectedCustody = createInitialFanoutQueuedMessageCustody(message.id, recoveryEntries, {
              requestedTargetCats: admission.requestedTargetCats ?? admission.targetCats,
              createdAt: admission.createdAt,
              ...(admission.receiptScope ? { receiptScope: admission.receiptScope } : {}),
              ...(admission.receiptScope === 'cross_thread_delivery'
                ? { custodyEntryId: `cross-thread:${message.id}` }
                : {}),
            });
            const initialized = await this.deps.messageStore.initializeQueueCustody(message.id, expectedCustody);
            if (
              (initialized.kind !== 'initialized' && initialized.kind !== 'existing') ||
              !sameFanoutCustodyIdentity(initialized.message.queueCustody, expectedCustody)
            ) {
              throw new Error(`fan-out Queue admission recovery failed: ${initialized.kind}`);
            }
            message = initialized.message;
            messagesBackfilled += 1;
          } else if (message.catId !== null) {
            legacyVisibilityFallbackMessageIds.push(message.id);
            continue;
          } else {
            const initialized = await initializeLegacyCustody(this.deps, message, this.now());
            if (!initialized) continue;
            message = initialized.message;
            if (initialized.backfilled) messagesBackfilled += 1;
          }
        }
        const reconciled = await reconcileStartupCustodyMessage(this.deps, message.id, this.now);
        if (!reconciled) continue;
        handledTargets += reconciled.handledTargets;
        failedTargets += reconciled.failedTargets;
        if (reconciled.terminalized) messagesTerminalized += 1;
        else if (reconciled.recoveryDeferred) {
          for (const entryId of activeCarrierEntryIds(reconciled.message)) deferredCarrierEntryIds.add(entryId);
        } else {
          const queuedEntryIds = new Set(queuedCarrierEntryIds(reconciled.message));
          if (queuedEntryIds.size > 0) activeMessages.push(reconciled.message);
          for (const entryId of activeCarrierEntryIds(reconciled.message)) {
            if (!queuedEntryIds.has(entryId)) deferredCarrierEntryIds.add(entryId);
          }
        }
      } catch (error) {
        messagesFailed += 1;
        const entryIds = scannedMessage ? activeCarrierEntryIds(scannedMessage) : [];
        if (entryIds.length > 0) {
          for (const entryId of entryIds) deferredCarrierEntryIds.add(entryId);
        } else unresolvedQueuedMessageIds.add(messageId);
        this.deps.log.warn(
          `[queue-custody-startup] isolated corrupt/racing message ${messageId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const groups = groupActiveMessages(activeMessages);
    const resumeScopes: QueueCustodyResumeScope[] = [];
    const builtEntries: QueueEntry[] = [];
    let entriesRestored = 0;
    for (const [entryId, messages] of groups) {
      const blockedByUnresolvedSource = await hasUnresolvedQueuedCarrierMember(
        this.deps,
        entryId,
        messages,
        unresolvedQueuedMessageIds,
      );
      if (deferredCarrierEntryIds.has(entryId) || blockedByUnresolvedSource) {
        this.deps.log.warn(
          `[queue-custody-startup] deferred Queue group ${entryId} after incomplete source reconciliation; ` +
            'preserving every coalesced source without provider recovery',
        );
        continue;
      }
      try {
        builtEntries.push(buildQueueEntry(messages, entryId));
      } catch (error) {
        if (error instanceof WaitContinuationCarrierError) {
          for (const message of messages) {
            try {
              const disposition = await terminalizeLegacyUnfencedWait(this.deps, message.id, this.now);
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
        } else messagesFailed += messages.length;
        this.deps.log.warn(
          `[queue-custody-startup] isolated non-restorable Queue group ${entryId} ` +
            `(${messages.map((message) => message.id).join(',')}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const retirementIntents = new Map(
      builtEntries.flatMap((entry) =>
        entry.prestartRetirement ? [[entry.prestartRetirement.id, entry.prestartRetirement] as const] : [],
      ),
    );
    const retirementGroups = new Map<string, QueueEntry[]>();
    for (const entry of builtEntries) {
      const inheritedIntent =
        entry.prestartRetirement ??
        [...retirementIntents.values()].find((intent) => intent.entryIds.includes(entry.id));
      const restoredEntry = inheritedIntent
        ? {
            ...entry,
            status: 'processing' as const,
            processingStartedAt: entry.processingStartedAt ?? inheritedIntent.startedAt,
            prestartRetirement: { ...inheritedIntent, entryIds: [...inheritedIntent.entryIds] },
          }
        : entry;
      const outcome = this.deps.invocationQueue.restoreDurableEntry(restoredEntry);
      if (outcome === 'restored') entriesRestored += 1;
      if (inheritedIntent) {
        const retirementGroup = retirementGroups.get(inheritedIntent.id) ?? [];
        retirementGroup.push(restoredEntry);
        retirementGroups.set(inheritedIntent.id, retirementGroup);
      } else if (outcome === 'restored') {
        resumeScopes.push({ threadId: entry.threadId, userId: entry.userId });
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
      prestartRetirements: [...retirementGroups.values()],
      legacyVisibilityFallbackMessageIds,
    };
  }
}
