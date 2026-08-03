import type { PawFeelDutyConfig } from '@cat-cafe/shared';
import type { TaskSpec_P1 } from '../../scheduler/types.js';
import {
  buildPawFeelDutyNotice,
  type IPawFeelDutyNoticeWatermarkStore,
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
}

function requireNow(now: () => string): { iso: string; ms: number } {
  const iso = now();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid duty task time: ${iso}`);
  return { iso, ms };
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
        const [items, duty] = await Promise.all([options.loadUndispositioned(), options.loadDutyConfig()]);
        if (items.length === 0) return { run: false, reason: 'paw-feel inbox has no undispositioned signals' };
        const current = requireNow(now);
        const notice = buildPawFeelDutyNotice(items, duty, current.ms, options.inboxHref);
        const claim = await options.watermarkStore.claim(notice.watermark, current.iso);
        if (claim.outcome === 'complete') {
          return { run: false, reason: 'duty notice watermark already complete' };
        }
        if (claim.outcome === 'claimed_elsewhere') {
          return { run: false, reason: 'duty notice watermark is already claimed' };
        }
        const signal: PawFeelDutySignal = {
          watermark: notice.watermark,
          content: notice.content,
          systemThreadId: notice.systemThreadId,
          rawSignalCount: notice.rawSignalCount,
          reviewBundleCount: notice.reviewBundleCount,
          ...(notice.targetCatId ? { targetCatId: notice.targetCatId } : {}),
          deliveryRequired: claim.outcome === 'claimed',
          ...(claim.outcome === 'resume_invocation' ? { messageId: claim.messageId } : {}),
        };
        return {
          run: true,
          workItems: [
            {
              subjectKey: notice.systemThreadId,
              dedupeKey: notice.watermark,
              signal,
            },
          ],
        };
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
          await options.watermarkStore.markComplete(signal.watermark, requireNow(now).iso);
          return;
        }
        if (!context.invokeTrigger) throw new Error('paw-feel duty invocation is unavailable');
        const reason =
          `F278 duty inbox has ${signal.reviewBundleCount} review bundle(s) / ` +
          `${signal.rawSignalCount} raw signal(s); open the bundle-first inbox and review original evidence; ` +
          'bounded pages or 10/20/50-item slices are execution limits, not a terminal condition; ' +
          'continue the same responsibility chain until active=0, or every actionable remainder has either a ' +
          'real task + named owner + active F167 lease or a durable proposal awaiting operator approval; owner, task, ' +
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
        await options.watermarkStore.markComplete(signal.watermark, requireNow(now).iso);
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
