/**
 * F139: SummaryCompactionTaskSpec — typed signal gate wrapper for SummaryCompactionTask.
 *
 * Gate returns per-thread workItems (with budget). Execute processes a single thread.
 * Uses TaskSpec_P1 typed signal gate pattern (F139).
 */
import type Database from 'better-sqlite3';
import type { ExecuteContext, TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import { processThread, type SummaryCompactionDeps } from './SummaryCompactionTask.js';
import { hasHighValueSignal, SUMMARY_CONFIG } from './summary-config.js';

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
}

interface ThreadLastActivity {
  threadId: string;
  lastMessageAt: number;
}

/** Signal type for summary compaction — per-thread state row */
type SummarySignal = SummaryStateRow;

function isEligible(
  state: SummaryStateRow,
  lastActivity: ThreadLastActivity | null,
  config: typeof SUMMARY_CONFIG,
): boolean {
  const now = Date.now();
  if (lastActivity) {
    const quietMs = now - lastActivity.lastMessageAt;
    if (quietMs < config.quietWindowMinutes * 60 * 1000) return false;
  }
  const highSignal = hasHighValueSignal(state.pending_signal_flags);
  const isCarryOver = state.carry_over === 1;
  const volumeOk =
    isCarryOver ||
    state.pending_message_count >= config.pendingMessageThreshold ||
    state.pending_token_count >= config.pendingTokenThreshold ||
    highSignal;
  if (!volumeOk) return false;
  const bypassCooldown = highSignal || isCarryOver;
  if (!bypassCooldown && state.last_abstractive_at) {
    const hoursSince = (now - new Date(state.last_abstractive_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < config.cooldownHours) return false;
  }
  return true;
}

function backfillSummaryState(db: Database.Database): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
       SELECT REPLACE(anchor, 'thread-', ''), 100, 5000, 7, 'concat'
       FROM evidence_docs
       WHERE kind = 'thread' AND anchor LIKE 'thread-%'
         AND REPLACE(anchor, 'thread-', '') NOT IN (SELECT thread_id FROM summary_state)`,
    ).run();
  } catch {
    // fail-open
  }
}

export function createSummaryCompactionTaskSpec(deps: SummaryCompactionDeps): TaskSpec_P1<SummarySignal> {
  const config = SUMMARY_CONFIG;

  return {
    id: 'summary-compact',
    profile: 'awareness',
    trigger: { type: 'interval', ms: config.schedulerIntervalMs },
    admission: {
      async gate() {
        backfillSummaryState(deps.db);

        const candidates = deps.db
          .prepare('SELECT * FROM summary_state WHERE pending_message_count > 0')
          .all() as SummaryStateRow[];

        if (candidates.length === 0) {
          return { run: false, reason: 'no threads with pending work' };
        }

        // Async eligibility check per-thread
        const eligible: SummaryStateRow[] = [];
        for (const state of candidates) {
          const lastActivity = await deps.getThreadLastActivity(state.thread_id);
          if (isEligible(state, lastActivity, config)) {
            eligible.push(state);
          }
        }

        if (eligible.length === 0) {
          return { run: false, reason: 'no eligible threads (quiet/volume/cooldown)' };
        }

        // Budget: cold-start = all, normal = perTickBudget
        const neverSummarized = deps.db
          .prepare(
            "SELECT count(*) as n FROM summary_state WHERE summary_type = 'concat' AND pending_message_count > 0",
          )
          .get() as { n: number };
        const isColdStart = neverSummarized.n > 20;
        const budget = isColdStart ? eligible.length : config.perTickBudget;

        const workItems = eligible.slice(0, budget).map((state) => ({
          signal: state,
          subjectKey: `thread-${state.thread_id}`,
        }));

        return { run: true, workItems };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(state: SummarySignal, _subjectKey: string, _ctx: ExecuteContext) {
        await processThread(state, deps, config);
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: deps.enabled,
    actor: { role: 'memory-curator', costTier: 'deep' },
  };
}
