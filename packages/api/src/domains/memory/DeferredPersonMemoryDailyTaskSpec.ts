import { randomUUID } from 'node:crypto';
import { type CatId, type DeferredPersonMemoryReceipt } from '@cat-cafe/shared';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { RoutingDispatchPreflightPort } from '../routing-context/RoutingDispatchPreflightPort.js';
import { preflightRoutingDispatch } from '../routing-context/RoutingDispatchPreflightPort.js';
import {
  type DeferredPersonMemoryDailyBatchSignal,
  type DeferredPersonMemoryDailyItem,
  deferredPersonMemoryTriggerContent,
} from './DeferredPersonMemoryDailyPresentation.js';
import type { DeferredPersonMemoryReceiptStore } from './DeferredPersonMemoryReceiptStore.js';
import { prepareDeferredPersonMemoryWriteOpportunityReentry } from './DeferredPersonMemoryReentryService.js';
import { observePersonMemoryStage } from './people/person-memory-telemetry.js';
import type { WriteOpportunityDeliveryStore } from './people/WriteOpportunityDeliveryStore.js';
import type { WriteOpportunityTerminalLedger } from './people/WriteOpportunityTerminalLedger.js';
import { resolveHouseholdTimeZone } from './SessionReflectionProducer.js';

const DAILY_BATCH_LIMIT = 8;
const CLAIM_LEASE_MS = 30 * 60 * 1_000;

type DailyStore = Pick<
  DeferredPersonMemoryReceiptStore,
  'get' | 'listReady' | 'claim' | 'bindProcessingMessage' | 'release' | 'disposeClaim' | 'expireClaim' | 'hardForget'
>;

export interface DeferredPersonMemoryDailyTaskSpecDeps {
  receiptStore: DailyStore;
  messageStore: Pick<IMessageStore, 'getById'>;
  writeOpportunityTerminalLedger?: WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore?: WriteOpportunityDeliveryStore;
  ownerUserId: string;
  householdTimeZone?: string;
  now?: () => number;
  randomId?: () => string;
  ensureSystemThread: () => Promise<string>;
  routingDispatchPreflight: RoutingDispatchPreflightPort;
}

function dailyItem(receipt: DeferredPersonMemoryReceipt): DeferredPersonMemoryDailyItem {
  if (
    receipt.state !== 'claimed' ||
    !receipt.claimId ||
    receipt.claimUntil === undefined ||
    !receipt.originMessageRef ||
    !receipt.subject ||
    !receipt.registryBinding ||
    !receipt.sourceCoordinates ||
    !receipt.processorCatId ||
    !receipt.processingThreadId
  ) {
    throw new Error(`deferred receipt ${receipt.receiptId} has no actionable claimed payload`);
  }
  return {
    ...(receipt.writeOpportunityLineage ? { writeOpportunityLineage: receipt.writeOpportunityLineage } : {}),
    receiptId: receipt.receiptId,
    ownerUserId: receipt.ownerUserId,
    originMessageRef: receipt.originMessageRef,
    subject: receipt.subject,
    registryBinding: receipt.registryBinding,
    sourceCoordinates: receipt.sourceCoordinates,
    state: 'claimed',
    claimId: receipt.claimId,
    claimUntil: receipt.claimUntil,
    processorCatId: receipt.processorCatId,
    processingThreadId: receipt.processingThreadId,
  };
}

async function claimDailyWorkItem(
  receipt: DeferredPersonMemoryReceipt,
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
  claimId: string,
  currentTime: number,
  processorCatId: CatId,
  processingThreadId: string,
) {
  const claimed = await deps.receiptStore.claim({
    ownerUserId: receipt.ownerUserId,
    receiptId: receipt.receiptId,
    claimId,
    now: currentTime,
    leaseMs: CLAIM_LEASE_MS,
    processorCatId,
    processingThreadId,
  });
  if (claimed.outcome !== 'claimed') return null;
  const signal = dailyItem(claimed.receipt);
  if (claimed.receipt.writeOpportunityLineage) {
    let reentry: Awaited<ReturnType<typeof prepareDeferredPersonMemoryWriteOpportunityReentry>>;
    try {
      reentry = await prepareDeferredPersonMemoryWriteOpportunityReentry(
        claimed.receipt,
        deps,
        currentTime,
        processorCatId,
        processingThreadId,
      );
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
  return signal;
}

export function createDeferredPersonMemoryDailyTaskSpec(
  deps: DeferredPersonMemoryDailyTaskSpecDeps,
): TaskSpec_P1<DeferredPersonMemoryDailyBatchSignal> {
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
    actor: { role: 'memory-curator', costTier: 'cheap' },
    admission: {
      async gate() {
        const ready = await observePersonMemoryStage(
          'deferred_daily',
          () => deps.receiptStore.listReady(deps.ownerUserId, DAILY_BATCH_LIMIT, now()),
          (receipts) => (receipts.length > 0 ? 'success' : 'not_available'),
        );
        const receiptIds: string[] = [];
        for (const receipt of ready) {
          if (
            receipt.state === 'claimed' &&
            receipt.claimId &&
            (receipt.claimUntil ?? Number.POSITIVE_INFINITY) <= now()
          ) {
            await deps.receiptStore.expireClaim({
              ownerUserId: receipt.ownerUserId,
              receiptId: receipt.receiptId,
              claimId: receipt.claimId,
              now: now(),
            });
            continue;
          }
          if (receipt.state === 'deferred') receiptIds.push(receipt.receiptId);
        }
        return receiptIds.length > 0
          ? {
              run: true,
              workItems: [
                {
                  subjectKey: 'memory-operations',
                  dedupeKey: receiptIds.join(':'),
                  signal: { ownerUserId: deps.ownerUserId, receiptIds },
                },
              ],
            }
          : { run: false, reason: 'no confirmed deferred person-memory receipts' };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(signal, _subjectKey, context) {
        const processorCatId = context.assignedCatId as CatId | undefined;
        if (!processorCatId) return;
        const routing = await preflightRoutingDispatch(deps.routingDispatchPreflight, {
          ownerId: signal.ownerUserId,
          targetCatIds: [processorCatId],
        });
        if (routing.targets[0]?.disposition !== 'allowed') return;
        const processingThreadId = await deps.ensureSystemThread();
        const items: DeferredPersonMemoryDailyItem[] = [];
        try {
          if (!context.deliver || !context.invokeTrigger) {
            throw new Error('deferred person-memory daily clerk execution ports unavailable');
          }
          for (const receiptId of signal.receiptIds) {
            const receipt = await deps.receiptStore.get(signal.ownerUserId, receiptId);
            if (receipt?.state !== 'deferred') continue;
            const item = await claimDailyWorkItem(receipt, deps, randomId(), now(), processorCatId, processingThreadId);
            if (item) items.push(item);
          }
          if (items.length === 0) return;
          const content = deferredPersonMemoryTriggerContent(items);
          const writeOpportunityReentries = items.flatMap((item) =>
            item.writeOpportunityReentry ? [item.writeOpportunityReentry] : [],
          );
          const messageId = await context.deliver({
            threadId: processingThreadId,
            content,
            userId: 'scheduler',
            extra: {
              scheduler: { hiddenTrigger: true },
              ...(writeOpportunityReentries.length > 0 ? { writeOpportunityReentries } : {}),
            },
          });
          for (const item of items) {
            const bound = await deps.receiptStore.bindProcessingMessage({
              ownerUserId: item.ownerUserId,
              receiptId: item.receiptId,
              claimId: item.claimId,
              processorCatId,
              processingThreadId,
              processingMessageId: messageId,
              now: now(),
            });
            if (bound.outcome !== 'bound' && bound.outcome !== 'replayed') {
              throw new Error(`deferred receipt ${item.receiptId} could not bind its processing message`);
            }
          }
          const outcome = await context.invokeTrigger.trigger(
            processingThreadId,
            processorCatId,
            deps.ownerUserId,
            content,
            messageId,
            undefined,
            { sourceCategory: 'scheduled', reason: 'F276 deferred known-person delta clerk' },
          );
          if (outcome === 'full') throw new Error('deferred person-memory processor queue is full');
        } catch (error) {
          await Promise.all(
            items.map((item) => deps.receiptStore.release(item.ownerUserId, item.receiptId, item.claimId, now())),
          );
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
