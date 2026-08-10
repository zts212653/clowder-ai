import { randomUUID } from 'node:crypto';
import type { DeferredPersonMemoryReceipt, DeferredPersonMemoryResolvedSource } from '@cat-cafe/shared';
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { DeferredPersonMemoryReceiptStore } from './DeferredPersonMemoryReceiptStore.js';
import { observePersonMemoryStage } from './people/person-memory-telemetry.js';
import { resolveHouseholdTimeZone } from './SessionReflectionProducer.js';

const DAILY_BATCH_LIMIT = 8;
const CLAIM_LEASE_MS = 30 * 60 * 1_000;

interface DeferredPersonMemoryDailySignal {
  receiptId: string;
  ownerUserId: string;
  requesterCatId: string;
  originMessageRef: { kind: 'message'; threadId: string; messageId: string };
  subject: string;
  registryBinding: NonNullable<DeferredPersonMemoryReceipt['registryBinding']>;
  sourceCoordinates: DeferredPersonMemoryResolvedSource[];
  state: 'claimed';
  claimId: string;
  claimUntil: number;
}

type DailyStore = Pick<DeferredPersonMemoryReceiptStore, 'listReady' | 'claim' | 'release'>;

export interface DeferredPersonMemoryDailyTaskSpecDeps {
  receiptStore: DailyStore;
  ownerUserId: string;
  householdTimeZone?: string;
  now?: () => number;
  randomId?: () => string;
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

function coordinateText(source: DeferredPersonMemoryResolvedSource): string {
  const base = `${source.sourceRef.threadId}#${source.sourceRef.messageId}`;
  if (source.kind === 'message') return `message ${base}`;
  const confirmation = source.confirmationSourceRef
    ? ` confirmed-by ${source.confirmationSourceRef.threadId}#${source.confirmationSourceRef.messageId}`
    : ' unconfirmed';
  return `attachment ${base} ${source.attachmentLocator.surface}[${source.attachmentLocator.index}]${confirmation}`;
}

function triggerContent(signal: DeferredPersonMemoryDailySignal): string {
  const coordinates = signal.sourceCoordinates.map(coordinateText).join('\n- ');
  return (
    '[F276 deferred person-memory daily clerk]\n' +
    `receiptId=${signal.receiptId}\n` +
    `claimId=${signal.claimId}\n` +
    `subject=${JSON.stringify(signal.subject)}\n` +
    `registry=${signal.registryBinding.kind}:${signal.registryBinding.ref}\n` +
    `exact sources:\n- ${coordinates}\n\n` +
    'Read only these exact owner-visible sources. Do not scan thread history or all conversations. ' +
    'If they support a useful known-person delta, create one ordinary rejectable F276 proposal with a complete typed sourceBundle, ' +
    `deferredReceipt={receiptId:${signal.receiptId},claimId:${signal.claimId}}, and clientRequestId=${signal.receiptId}. ` +
    'Never materialize memory directly. Never turn the correction/capture itself into an interaction event. ' +
    'If evidence is insufficient or an attachment/ASR lacks explicit owner confirmation, do not propose; let the claim expire for later resolution.'
  );
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
          const claimed = await deps.receiptStore.claim({
            ownerUserId: receipt.ownerUserId,
            receiptId: receipt.receiptId,
            claimId,
            now: now(),
            leaseMs: CLAIM_LEASE_MS,
          });
          if (claimed.outcome !== 'claimed') continue;
          workItems.push({
            subjectKey: claimed.receipt.receiptId,
            dedupeKey: `${claimed.receipt.receiptId}:${claimId}`,
            signal: dailySignal(claimed.receipt),
          });
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
          const content = triggerContent(signal);
          const messageId = await context.deliver({
            threadId: signal.originMessageRef.threadId,
            content,
            userId: 'scheduler',
            extra: { scheduler: { hiddenTrigger: true } },
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
