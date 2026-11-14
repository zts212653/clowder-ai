/** Retired automatic task identities; on-demand domain interfaces remain available. */
import type { IThreadStore } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { TaskSpec_P1 } from '../../scheduler/types.js';
import { createRetiredAutomaticEvalSpec } from '../automatic-eval-retirement.js';
import type { LegacyScheduledTaskLike } from '../legacy-task-cleanup.js';
import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';
import type { IEvalDomainTriggerStore } from './eval-domain-trigger-store.js';

/** Transitional call shape retained until the F311 bridge migrates (PR3). */
export interface EvalDomainScheduleOpts {
  harnessFeedbackRoot: string;
  threadStore?: IThreadStore;
  defaultUserId?: string;
  listDynamicTasks?: () => LegacyScheduledTaskLike[];
  redis?: import('ioredis').Redis;
  triggerStore?: IEvalDomainTriggerStore;
  wiredPublishDomains?: ReadonlySet<EvalDomainRegistryEntry['domainId']>;
  publishPrereqProbe?: (domainId: EvalDomainRegistryEntry['domainId']) => boolean | Promise<boolean>;
}

/** @deprecated Use EvalDomainScheduleOpts — kept for backward compat. */
export type EvalDomainDailyOpts = EvalDomainScheduleOpts;

export function createEvalDomainDailySpec(_opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  return createRetiredAutomaticEvalSpec({
    id: 'eval-domain-daily',
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 3 * * *', timezone: 'UTC' },
    label: '每日 Harness Eval（自动运行已退役）',
  });
}

export function createEvalDomainWeeklySpec(_opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  return createRetiredAutomaticEvalSpec({
    id: 'eval-domain-weekly',
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 3 * * 0', timezone: 'UTC' },
    label: '每周 Harness Eval（自动运行已退役）',
  });
}
