/**
 * F139: SummaryCompactionTaskSpec — typed signal gate wrapper for SummaryCompactionTask.
 *
 * Gate returns per-thread workItems (with budget). Execute processes a single thread.
 * Uses TaskSpec_P1 typed signal gate pattern (F139).
 */
import type Database from 'better-sqlite3';
import type { ExecuteContext, TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import { processThread, type SummaryCompactionDeps } from './SummaryCompactionTask.js';
import { SUMMARY_CONFIG } from './summary-config.js';
import { dailyCurationDue, isSummaryEligible } from './summary-eligibility.js';

interface SummaryStateRow {
  thread_id: string;
  last_summarized_message_id: string | null;
  pending_message_count: number;
  pending_token_count: number;
  pending_signal_flags: number;
  summary_type: string;
  last_abstractive_at: string | null;
  abstractive_token_count: number | null;
  carry_over: number;
  daily?: boolean;
}

/** Per-thread state includes the daily fallback disposition of this tick. */
type SummarySignal = SummaryStateRow;

export function createSummaryCompactionTaskSpec(deps: SummaryCompactionDeps): TaskSpec_P1<SummarySignal> {
  const config = SUMMARY_CONFIG;

  return {
    id: 'summary-compact',
    profile: 'awareness',
    trigger: { type: 'interval', ms: config.schedulerIntervalMs },
    admission: {
      dependsOnThreadActivity: true,
      async gate() {
        const candidates = deps.db
          .prepare('SELECT * FROM summary_state WHERE pending_message_count > 0')
          .all() as SummaryStateRow[];

        if (candidates.length === 0) {
          return { run: false, reason: 'no threads with pending work' };
        }

        // Async eligibility check per-thread
        const eligible: SummaryStateRow[] = [];
        for (let state of candidates) {
          if (deps.curation?.shouldProcessThread && !(await deps.curation.shouldProcessThread(state.thread_id)))
            continue;
          if (deps.curation?.reconcilePendingInput) {
            if (!(await deps.curation.reconcilePendingInput(state.thread_id))) continue;
            state = deps.db
              .prepare('SELECT * FROM summary_state WHERE thread_id=?')
              .get(state.thread_id) as SummaryStateRow;
            if (state.pending_message_count === 0) continue;
          }
          const lastActivity = await deps.getThreadLastActivity(state.thread_id);
          const daily = deps.curation ? dailyCurationDue(state, deps.curation.timezone, deps.curation.now?.()) : false;
          if (isSummaryEligible(state, lastActivity, config, { daily, ...deps.curation })) {
            eligible.push({ ...state, daily });
          }
        }

        if (eligible.length === 0) {
          return { run: false, reason: 'no eligible threads (quiet/volume/cooldown)' };
        }

        // Keep the existing event budget; the one daily pass includes all small conversations.
        const eventItems = eligible.filter((state) => !state.daily).slice(0, config.perTickBudget);
        const workItems = [...eventItems, ...eligible.filter((state) => state.daily)].map((state) => ({
          signal: state,
          subjectKey: `thread-${state.thread_id}`,
        }));

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(state: SummarySignal, _subjectKey: string, ctx: ExecuteContext) {
        await processThread(state, deps, config, ctx.signal);
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: deps.enabled,
    display: {
      label: '记忆整理',
      category: 'thread',
      description: '整理判断的变化、值得回看的经历和可能相关的往事',
      subjectKind: 'thread',
    },
  };
}
