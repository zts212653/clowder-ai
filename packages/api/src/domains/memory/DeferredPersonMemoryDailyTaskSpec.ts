import { randomUUID } from 'node:crypto';
import {
  type AsrPersonMemoryWriteOpportunityV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  type DeferredPersonMemoryReceipt,
  type WriteOpportunityReentryCarrierV1,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import {
  type DeferredPersonMemoryDailySignal,
  deferredPersonMemoryTriggerContent,
} from './DeferredPersonMemoryDailyPresentation.js';
import type { DeferredPersonMemoryReceiptStore } from './DeferredPersonMemoryReceiptStore.js';
import { AsrPersonMemoryContractTrial } from './people/AsrPersonMemoryContractTrial.js';
import { eligibleOwnerMessage } from './people/PersonMemorySourceBundleResolver.js';
import { observePersonMemoryStage } from './people/person-memory-telemetry.js';
import type { WriteOpportunityDeliveryStore } from './people/WriteOpportunityDeliveryStore.js';
import {
  terminalGenerationKeysFrom,
  type WriteOpportunityTerminalLedger,
} from './people/WriteOpportunityTerminalLedger.js';
import { resolveHouseholdTimeZone } from './SessionReflectionProducer.js';

const DAILY_BATCH_LIMIT = 8;
const CLAIM_LEASE_MS = 30 * 60 * 1_000;

type DailyStore = Pick<DeferredPersonMemoryReceiptStore, 'listReady' | 'claim' | 'release' | 'hardForget'>;

export interface DeferredPersonMemoryDailyTaskSpecDeps {
  receiptStore: DailyStore;
  messageStore: Pick<IMessageStore, 'getById'>;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  ownerUserId: string;
  householdTimeZone?: string;
  now?: () => number;
  randomId?: () => string;
}

type ReentryAuthorityDeps = DeferredPersonMemoryDailyTaskSpecDeps & {
  writeOpportunityTerminalLedger: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore: WriteOpportunityDeliveryStore;
};

function hasReentryAuthority(deps: DeferredPersonMemoryDailyTaskSpecDeps): deps is ReentryAuthorityDeps {
  return Boolean(deps.writeOpportunityTerminalLedger && deps.writeOpportunityDeliveryStore);
}

function dailySignal(receipt: DeferredPersonMemoryReceipt): DeferredPersonMemoryDailySignal {
  if (
    receipt.state !== 'claimed' ||
    !receipt.claimId ||
    receipt.claimUntil === undefined ||
    !receipt.originMessageRef ||
    !receipt.subject ||
    !receipt.registryBinding ||
    !receipt.sourceCoordinates
  ) {
    throw new Error(`deferred receipt ${receipt.receiptId} has no actionable claimed payload`);
  }
  return {
    ...(receipt.writeOpportunityLineage ? { writeOpportunityLineage: receipt.writeOpportunityLineage } : {}),
    receiptId: receipt.receiptId,
    ownerUserId: receipt.ownerUserId,
    requesterCatId: receipt.requesterCatId,
    originMessageRef: receipt.originMessageRef,
    subject: receipt.subject,
    registryBinding: receipt.registryBinding,
    sourceCoordinates: receipt.sourceCoordinates,
    state: 'claimed',
    claimId: receipt.claimId,
    claimUntil: receipt.claimUntil,
  };
}

async function invalidateDeferredLineage(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
  reason: 'source_corrected' | 'source_forgotten' | 'scope_revoked',
  now: number,
): Promise<void> {
  const lineage = receipt.writeOpportunityLineage;
  if (!lineage) return;
  await deps.writeOpportunityTerminalLedger?.recordInvalidated({
    ownerUserId: receipt.ownerUserId,
    dedupeLineage: lineage.dedupeLineage,
    reason,
    recordedAt: now,
  });
  await deps.writeOpportunityDeliveryStore?.purgeLineage(receipt.ownerUserId, lineage.dedupeLineage);
  await deps.receiptStore.hardForget(receipt.ownerUserId, receipt.receiptId);
}

async function terminalizeDeferredReceipt(
  receipt: DeferredPersonMemoryReceipt,
  deps: ReentryAuthorityDeps,
): Promise<void> {
  const lineage = receipt.writeOpportunityLineage;
  if (lineage) {
    await deps.writeOpportunityDeliveryStore.purgeLineage(receipt.ownerUserId, lineage.dedupeLineage);
  }
  await deps.receiptStore.hardForget(receipt.ownerUserId, receipt.receiptId);
}

async function resolveLiveOriginalOpportunity(
  receipt: DeferredPersonMemoryReceipt,
  deps: ReentryAuthorityDeps,
  now: number,
): Promise<AsrPersonMemoryWriteOpportunityV1 | 'terminal'> {
  const lineage = receipt.writeOpportunityLineage;
  const origin = receipt.originMessageRef;
  if (!lineage || !origin) return 'terminal';
  const source = await deps.messageStore.getById(origin.messageId);
  if (!source || source.deletedAt !== undefined || source._tombstone) {
    await invalidateDeferredLineage(receipt, deps, 'source_forgotten', now);
    return 'terminal';
  }
  if (!eligibleOwnerMessage(source, { ownerUserId: receipt.ownerUserId }) || source.threadId !== origin.threadId) {
    await invalidateDeferredLineage(receipt, deps, 'scope_revoked', now);
    return 'terminal';
  }
  const stableScene = (source.extra?.dynamicSceneEntries ?? [])
    .map((candidate) => asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate))
    .find(
      (candidate) =>
        candidate.success &&
        candidate.data.opportunity.reflexId === lineage.reflexId &&
        candidate.data.opportunity.reflexVersion === lineage.reflexVersion &&
        candidate.data.opportunity.dedupeLineage === lineage.dedupeLineage,
    );
  if (stableScene?.success) {
    const stable = stableScene.data.opportunity;
    const receiptOpportunity = receipt.writeOpportunityReceipt;
    if (
      receiptOpportunity &&
      lineage.opportunityId === writeOpportunityGenerationId(lineage.dedupeLineage, lineage.generation)
    ) {
      // The owner message intentionally retains only the mechanical generation-1 scene. Later
      // generations are transport state, so reconstruct the currently deferred generation from
      // that stable source plus the server-held content-free receipt before minting generation+1.
      return {
        ...stable,
        opportunityId: lineage.opportunityId,
        generation: lineage.generation,
        eligibleAt: receiptOpportunity.eligibleAt,
      };
    }
  }
  await invalidateDeferredLineage(receipt, deps, 'source_corrected', now);
  return 'terminal';
}

async function readReentryLineageStates(
  receipt: DeferredPersonMemoryReceipt,
  deps: ReentryAuthorityDeps,
): Promise<Awaited<ReturnType<WriteOpportunityTerminalLedger['readLineageStates']>> | 'retry_later' | 'terminal'> {
  const lineage = receipt.writeOpportunityLineage;
  if (!lineage) return 'terminal';
  const states = await deps.writeOpportunityTerminalLedger.readLineageStates(receipt.ownerUserId, [
    lineage.dedupeLineage,
  ]);
  const state = states.get(lineage.dedupeLineage);
  if (state?.invalidatedReason) {
    await terminalizeDeferredReceipt(receipt, deps);
    return 'terminal';
  }
  const currentOutcome = state?.terminalGenerations.get(lineage.generation);
  if (!currentOutcome) return 'retry_later';
  if (currentOutcome !== 'defer' || state?.terminalGenerations.has(lineage.generation + 1)) {
    await terminalizeDeferredReceipt(receipt, deps);
    return 'terminal';
  }
  return states;
}

async function prepareWriteOpportunityReentry(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
  now: number,
): Promise<WriteOpportunityReentryCarrierV1 | 'retry_later' | 'terminal'> {
  const lineage = receipt.writeOpportunityLineage;
  const reflexReceipt = receipt.writeOpportunityReceipt;
  if (!lineage || !reflexReceipt || !receipt.originMessageRef) return 'retry_later';
  if (!hasReentryAuthority(deps)) return 'retry_later';
  const original = await resolveLiveOriginalOpportunity(receipt, deps, now);
  if (original === 'terminal') return 'terminal';
  const states = await readReentryLineageStates(receipt, deps);
  if (states === 'retry_later' || states === 'terminal') return states;
  const reentry = new AsrPersonMemoryContractTrial().reenterDeferred(reflexReceipt, original, {
    now,
    reason: 'eligible_owner_context',
    aclAllowed: true,
    terminalGenerationKeys: terminalGenerationKeysFrom(states),
  });
  if (reentry.status === 'reentered') {
    return {
      v: 1,
      sourceMessageRef: receipt.originMessageRef,
      sourceOpportunityId: writeOpportunityGenerationId(lineage.dedupeLineage, 1),
      priorGeneration: lineage.generation,
      scene: reentry.scene,
    };
  }
  if (reentry.reason === 'not_yet_eligible') return 'retry_later';
  if (reentry.reason === 'expired') {
    await deps.writeOpportunityTerminalLedger.recordTerminal({
      ownerUserId: receipt.ownerUserId,
      dedupeLineage: lineage.dedupeLineage,
      generation: lineage.generation + 1,
      outcome: 'expired',
      recordedAt: now,
    });
    await deps.receiptStore.hardForget(receipt.ownerUserId, receipt.receiptId);
    return 'terminal';
  }
  if (reentry.reason === 'generation_exhausted') {
    await terminalizeDeferredReceipt(receipt, deps);
    return 'terminal';
  }
  return 'retry_later';
}

async function claimDailyWorkItem(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
  claimId: string,
  currentTime: number,
) {
  const claimed = await deps.receiptStore.claim({
    ownerUserId: receipt.ownerUserId,
    receiptId: receipt.receiptId,
    claimId,
    now: currentTime,
    leaseMs: CLAIM_LEASE_MS,
  });
  if (claimed.outcome !== 'claimed') return null;
  const signal = dailySignal(claimed.receipt);
  if (claimed.receipt.writeOpportunityLineage) {
    let reentry: Awaited<ReturnType<typeof prepareWriteOpportunityReentry>>;
    try {
      reentry = await prepareWriteOpportunityReentry(claimed.receipt, deps, currentTime);
    } catch (error) {
      await deps.receiptStore.release(receipt.ownerUserId, receipt.receiptId, signal.claimId, currentTime);
      throw error;
    }
    if (reentry === 'retry_later') {
      await deps.receiptStore.release(receipt.ownerUserId, receipt.receiptId, signal.claimId, currentTime);
      return null;
    }
    if (reentry === 'terminal') return null;
    signal.writeOpportunityReentry = reentry;
  }
  return {
    subjectKey: claimed.receipt.receiptId,
    dedupeKey: `${claimed.receipt.receiptId}:${claimId}`,
    signal,
  };
}

export function createDeferredPersonMemoryDailyTaskSpec(
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
): TaskSpec_P1<DeferredPersonMemoryDailySignal> {
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;
  return {
    id: 'f276-deferred-person-memory-daily-clerk',
    profile: 'awareness',
    trigger: {
      type: 'cron',
      expression: '30 4 * * *',
      timezone: resolveHouseholdTimeZone(deps.householdTimeZone),
    },
    admission: {
      async gate() {
        const ready = await observePersonMemoryStage(
          'deferred_daily',
          () => deps.receiptStore.listReady(deps.ownerUserId, DAILY_BATCH_LIMIT, now()),
          (receipts) => (receipts.length > 0 ? 'success' : 'not_available'),
        );
        const workItems = [];
        for (const receipt of ready) {
          const claimId = randomId();
          const workItem = await claimDailyWorkItem(receipt, deps, claimId, now());
          if (workItem) workItems.push(workItem);
        }
        return workItems.length > 0
          ? { run: true, workItems }
          : { run: false, reason: 'no confirmed deferred person-memory receipts' };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(signal, _subjectKey, context) {
        try {
          if (!context.deliver || !context.invokeTrigger) {
            throw new Error('deferred person-memory daily clerk execution ports unavailable');
          }
          const content = deferredPersonMemoryTriggerContent(signal);
          const messageId = await context.deliver({
            threadId: signal.originMessageRef.threadId,
            content,
            userId: 'scheduler',
            extra: {
              scheduler: { hiddenTrigger: true },
              ...(signal.writeOpportunityReentry ? { writeOpportunityReentry: signal.writeOpportunityReentry } : {}),
            },
          });
          await Promise.resolve(
            context.invokeTrigger.trigger(
              signal.originMessageRef.threadId,
              signal.requesterCatId,
              deps.ownerUserId,
              content,
              messageId,
              undefined,
              { sourceCategory: 'scheduled', reason: 'F276 deferred known-person delta clerk' },
            ),
          );
        } catch (error) {
          await deps.receiptStore.release(signal.ownerUserId, signal.receiptId, signal.claimId, now());
          throw error;
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    display: {
      label: 'F276 Deferred Person-Memory Clerk',
      category: 'system',
      description: 'Converts explicit source-bound known-person delta receipts into rejectable F276 proposals',
      subjectKind: 'none',
    },
  };
}
