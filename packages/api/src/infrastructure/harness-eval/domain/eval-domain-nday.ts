import type { TaskSpec_P1 } from '../../scheduler/types.js';
import { createRetiredAutomaticEvalSpec } from '../automatic-eval-retirement.js';
import type { EvalDomainScheduleOpts } from './eval-domain-daily.js';
import type { EvalDomainRegistryEntry } from './eval-domain-registry.js';

export function parseNDayFrequency(frequency: string): number | null {
  const match = /^every-(\d+)d$/.exec(frequency);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function createEvalDomainNDaySpec(_opts: EvalDomainScheduleOpts): TaskSpec_P1<EvalDomainRegistryEntry> {
  return createRetiredAutomaticEvalSpec({
    id: 'eval-domain-nday',
    profile: 'awareness',
    trigger: { type: 'cron', expression: '0 3 * * *', timezone: 'UTC' },
    label: 'N天周期 Harness Eval（自动运行已退役）',
  });
}
