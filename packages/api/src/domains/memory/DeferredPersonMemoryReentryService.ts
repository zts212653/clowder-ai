import {
  type AsrPersonMemoryWriteOpportunityV1,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  type CatId,
  type DeferredPersonMemoryReceipt,
  type WriteOpportunityReentryCarrierV1,
  writeOpportunityGenerationId,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { DeferredPersonMemoryReceiptStore } from './DeferredPersonMemoryReceiptStore.js';
import { AsrPersonMemoryContractTrial } from './people/AsrPersonMemoryContractTrial.js';
import { eligibleOwnerMessage } from './people/PersonMemorySourceBundleResolver.js';
import type { WriteOpportunityDeliveryStore } from './people/WriteOpportunityDeliveryStore.js';
import {
  terminalGenerationKeysFrom,
  type WriteOpportunityTerminalLedger,
} from './people/WriteOpportunityTerminalLedger.js';

export interface DeferredPersonMemoryReentryDeps {
  receiptStore: Pick<DeferredPersonMemoryReceiptStore, 'hardForget'>;
  messageStore: Pick<IMessageStore, 'getById'>;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
}

type ReentryAuthorityDeps = DeferredPersonMemoryReentryDeps & {
  writeOpportunityTerminalLedger: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore: WriteOpportunityDeliveryStore;
};

function hasReentryAuthority(deps: DeferredPersonMemoryReentryDeps): deps is ReentryAuthorityDeps {
  return Boolean(deps.writeOpportunityTerminalLedger && deps.writeOpportunityDeliveryStore);
}

async function invalidateDeferredLineage(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryReentryDeps,
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

export async function prepareDeferredPersonMemoryWriteOpportunityReentry(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryReentryDeps,
  now: number,
  processorCatId: CatId,
  processingThreadId: string,
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
    deliveryScope: { threadId: processingThreadId, consumerCatId: processorCatId },
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
