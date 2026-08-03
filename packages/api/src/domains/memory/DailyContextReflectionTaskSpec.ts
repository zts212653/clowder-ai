import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type {
  DailyContextReflectionProducer,
  DailyContextReflectionRunResult,
} from './DailyContextReflectionProducer.js';
import { resolveHouseholdTimeZone } from './SessionReflectionProducer.js';

export const DAILY_CONTEXT_REFLECTION_TASK_ID = 'f271-daily-context-reflection';
export const DAILY_CONTEXT_REFLECTION_CRON = '15 4 * * *';

export interface DailyContextReflectionTaskSpecDeps {
  producer: Pick<DailyContextReflectionProducer, 'run'>;
  householdTimeZone?: string;
  runTimeoutMs?: number;
  log?: {
    info?: (obj: unknown, msg: string) => void;
    warn?: (obj: unknown, msg: string) => void;
  };
}

export function createDailyContextReflectionTaskSpec(deps: DailyContextReflectionTaskSpecDeps): TaskSpec_P1<null> {
  const runTimeoutMs = deps.runTimeoutMs ?? 120_000;
  if (!Number.isInteger(runTimeoutMs) || runTimeoutMs <= 0) {
    throw new Error('daily context reflection runTimeoutMs must be a positive integer');
  }
  return {
    id: DAILY_CONTEXT_REFLECTION_TASK_ID,
    profile: 'poller',
    trigger: {
      type: 'cron',
      expression: DAILY_CONTEXT_REFLECTION_CRON,
      timezone: resolveHouseholdTimeZone(deps.householdTimeZone),
    },
    admission: {
      async gate() {
        return {
          run: true,
          workItems: [{ signal: null, subjectKey: 'daily-context-reflection' }],
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: runTimeoutMs,
      async execute() {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error(`daily context reflection timed out after ${runTimeoutMs}ms`));
        }, runTimeoutMs);
        try {
          const result = await deps.producer.run({ signal: controller.signal });
          logRun(deps, result);
        } finally {
          clearTimeout(timer);
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '每日功利记忆反射',
      category: 'system',
      description: '每日低频合并前一日 session 的 typed deltas；安静日不会制造摘要',
      subjectKind: 'none',
    },
  };
}

function logRun(deps: DailyContextReflectionTaskSpecDeps, result: DailyContextReflectionRunResult): void {
  if (result.quiet) {
    deps.log?.info?.({ result }, '[f271-daily-reflection] quiet day: no new reflection output');
    return;
  }
  if (result.rejected > 0) {
    deps.log?.warn?.({ result }, '[f271-daily-reflection] completed with budget-rejected outputs');
    return;
  }
  deps.log?.info?.({ result }, '[f271-daily-reflection] completed');
}
