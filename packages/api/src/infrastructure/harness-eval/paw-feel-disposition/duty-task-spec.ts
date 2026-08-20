import type { PawFeelDutyConfig } from '@cat-cafe/shared';
import type { GateResult, TaskSpec_P1 } from '../../scheduler/types.js';
import {
  buildPawFeelDutyBatchSnapshot,
  buildPawFeelDutyNotice,
  type IPawFeelDutyNoticeWatermarkStore,
  type PawFeelDutyBatchRecord,
  type PawFeelDutyNoticeClaim,
  type PawFeelDutySignalSummary,
} from './duty-notice.js';

interface PawFeelDutySignal {
  watermark: string;
  content: string;
  systemThreadId: 'thread_eval_friction';
  rawSignalCount: number;
  reviewBundleCount: number;
  targetCatId?: string;
  deliveryRequired: boolean;
  messageId?: string;
}

export interface PawFeelDutyTaskSpecOptions {
  loadUndispositioned: () => Promise<PawFeelDutySignalSummary[]>;
  loadDutyConfig: () => Promise<PawFeelDutyConfig | null>;
  watermarkStore: IPawFeelDutyNoticeWatermarkStore;
  ownerUserId: string;
  inboxHref: string;
  now?: () => string;
  ensureSystemThread?: () => Promise<void>;
  receiptReconciler: {
    reconcile(actorCatId: string): Promise<unknown>;
  };
}

function requireNow(now: () => string): { iso: string; ms: number } {
  const iso = now();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid duty task time: ${iso}`);
  return { iso, ms };
}

function dutyClaimStopReason(claim: PawFeelDutyNoticeClaim): string | undefined {
  if (claim.outcome === 'complete') return 'duty notice watermark already complete';
  if (claim.outcome === 'claimed_elsewhere') return 'duty notice watermark is already claimed';
  return undefined;
}

async function readResumedBatch(
  claim: PawFeelDutyNoticeClaim,
  store: IPawFeelDutyNoticeWatermarkStore,
): Promise<PawFeelDutyBatchRecord | undefined> {
  if (claim.outcome !== 'resume_invocation') return undefined;
  const batch = await store.readCurrent();
  if (!batch || batch.watermark !== claim.watermark) {
    throw new Error('durable paw-feel duty batch changed before invocation resume');
  }
  return batch;
}

async function preparePawFeelDutyWork(
  options: PawFeelDutyTaskSpecOptions,
  now: () => string,
): Promise<GateResult<PawFeelDutySignal>> {
  const [items, duty] = await Promise.all([options.loadUndispositioned(), options.loadDutyConfig()]);
  if (items.length === 0) return { run: false, reason: 'paw-feel inbox has no undispositioned signals' };
  const current = requireNow(now);
  const notice = buildPawFeelDutyNotice(items, duty, current.ms, options.inboxHref);
  const claim = await options.watermarkStore.claim(notice.watermark, current.iso, buildPawFeelDutyBatchSnapshot(items));
  const stopReason = dutyClaimStopReason(claim);
  if (stopReason) return { run: false, reason: stopReason };
  if (claim.outcome === 'resume_invocation' && !notice.targetCatId) {
    return { run: false, reason: 'duty notice is delivered but no primary cat is configured' };
  }
  const resumedBatch = await readResumedBatch(claim, options.watermarkStore);
  const resumedRawCount = resumedBatch?.snapshot.bundles.reduce((count, bundle) => count + bundle.members.length, 0);
  const signal: PawFeelDutySignal = {
    watermark: resumedBatch?.watermark ?? notice.watermark,
    content: notice.content,
    systemThreadId: notice.systemThreadId,
    rawSignalCount: resumedRawCount ?? notice.rawSignalCount,
    reviewBundleCount: resumedBatch?.snapshot.bundles.length ?? notice.reviewBundleCount,
    ...(notice.targetCatId ? { targetCatId: notice.targetCatId } : {}),
    deliveryRequired: claim.outcome === 'claimed',
    ...(claim.outcome === 'resume_invocation' ? { messageId: claim.messageId } : {}),
  };
  return {
    run: true,
    workItems: [{ subjectKey: notice.systemThreadId, dedupeKey: signal.watermark, signal }],
  };
}

export { buildPawFeelDutyNotice } from './duty-notice.js';

export function createPawFeelDutyTaskSpec(options: PawFeelDutyTaskSpecOptions): TaskSpec_P1<PawFeelDutySignal> {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    id: 'paw-feel-disposition-duty',
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 0,12 * * *', timezone: 'UTC' },
    admission: {
      async gate() {
        return preparePawFeelDutyWork(options, now);
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 60_000,
      async execute(signal, _subjectKey, context) {
        let messageId = signal.messageId;
        if (signal.deliveryRequired) {
          if (!context.deliver) throw new Error('paw-feel duty delivery is unavailable');
          await options.ensureSystemThread?.();
          messageId = await context.deliver({
            threadId: signal.systemThreadId,
            content: signal.content,
            userId: options.ownerUserId,
          });
          await options.watermarkStore.markDelivered(signal.watermark, messageId, requireNow(now).iso);
        }
        if (!messageId) throw new Error('paw-feel duty notice has no durable message id');
        if (!signal.targetCatId) {
          return;
        }
        await options.watermarkStore.markAwaitingReceipt(signal.watermark, requireNow(now).iso);
        await options.receiptReconciler.reconcile('scheduler:paw-feel-disposition-duty');
        if (!context.invokeTrigger) throw new Error('paw-feel duty invocation is unavailable');
        const reason =
          `F278 duty inbox has ${signal.reviewBundleCount} review bundle(s) / ` +
          `${signal.rawSignalCount} raw signal(s); open the bundle-first inbox and review original evidence; ` +
          'bounded pages or 10/20/50-item slices are execution limits, not a terminal condition; ' +
          'continue the same responsibility chain until active=0, or every actionable remainder has either a ' +
          'real task + named owner + active F167 lease, a durable proposal awaiting operator approval, or an explicit ' +
          'blocker with evidence; signature-waiting must continue to an exact independent signature or blocker; owner, task, ' +
          'transport receipt, or chat prose alone is not a terminal condition; if the invocation budget is near, ' +
          'use a structured continuation instead of waiting for the next duty cron';
        await Promise.resolve(
          context.invokeTrigger.trigger(
            signal.systemThreadId,
            signal.targetCatId,
            options.ownerUserId,
            reason,
            messageId,
            undefined,
            { sourceCategory: 'scheduled', reason },
          ),
        );
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'record' },
    enabled: () => true,
    display: {
      label: 'Paw-Feel Disposition Duty',
      category: 'system',
      description: 'Routes the source-ref-only paw-feel inbox to the configured duty cat',
      subjectKind: 'thread',
    },
  };
}
