import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { BallCustodyProbeScheduler } from './BallCustodyProbeScheduler.js';

export const BALL_CUSTODY_PROBE_TASK_ID = 'f233-ball-custody-probe';
export const DEFAULT_BALL_CUSTODY_PROBE_INTERVAL_MS = 60_000;
export const MAX_BALL_CUSTODY_HTTP_PROBE_TIMEOUT_MS = 30_000;
export const BALL_CUSTODY_PROBE_RUN_TIMEOUT_MS = 120_000;

export interface BallCustodyProbeTaskSpecOptions {
  readonly scheduler: BallCustodyProbeScheduler;
  readonly intervalMs?: number;
  readonly log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export function createBallCustodyProbeTaskSpec(opts: BallCustodyProbeTaskSpecOptions): TaskSpec_P1 {
  return {
    id: BALL_CUSTODY_PROBE_TASK_ID,
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.intervalMs ?? DEFAULT_BALL_CUSTODY_PROBE_INTERVAL_MS },
    admission: {
      async gate() {
        return { run: true, workItems: [{ signal: null, subjectKey: 'ball-custody-probe' }] };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: BALL_CUSTODY_PROBE_RUN_TIMEOUT_MS,
      async execute() {
        const result = await opts.scheduler.tick();
        if (result.failed > 0) {
          opts.log?.warn?.({ result }, '[ball-custody-probe] completed with failures');
        } else if (result.completed > 0 || result.woken > 0) {
          opts.log?.info?.({ result }, '[ball-custody-probe] resolved blocked task(s)');
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
    display: {
      label: '球权条件探针',
      category: 'system',
      description: '扫描 blocked task 的 probe，满足后完成任务或唤醒 owner',
      subjectKind: 'none',
    },
  };
}
