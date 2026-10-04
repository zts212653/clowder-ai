import type { CatId, InvocationTrajectorySummary } from '@cat-cafe/shared';
import { projectInvocationTrajectories } from '../InvocationTrajectoryProjector.js';
import type { TranscriptEvent } from '../TranscriptReader.js';
import type { IndexedSession } from './transcript-invocation-index-types.js';

const TERMINAL_PRIORITY = { running: 0, done: 1, error: 2, cancelled: 3, timeout: 4 };

/** Aggregate compact events without retaining the transcript's payload or an event array. */
export class InvocationSummaryAccumulator {
  private readonly summaries = new Map<string, InvocationTrajectorySummary>();
  private readonly tools = new Map<string, Set<string>>();

  constructor(private readonly session: IndexedSession) {}

  add(event: TranscriptEvent): void {
    if (!event.invocationId) return;
    const [next] = projectInvocationTrajectories([event], {
      ...this.session,
      catId: this.session.catId as CatId,
      sealReason: this.session.sealReason ?? undefined,
    });
    if (!next) return;
    const current = this.summaries.get(event.invocationId);
    if (!current) {
      this.summaries.set(event.invocationId, next);
      this.tools.set(event.invocationId, new Set(next.toolNames));
      return;
    }
    current.eventCount += next.eventCount;
    current.statusEventCount += next.statusEventCount;
    current.toolUseCount += next.toolUseCount;
    current.toolResultCount += next.toolResultCount;
    current.messageCount += next.messageCount;
    current.errorCount += next.errorCount;
    current.durationMs = Math.max(0, event.t - current.startedAt);
    if (TERMINAL_PRIORITY[next.status] > TERMINAL_PRIORITY[current.status]) {
      current.status = next.status;
      if (next.terminalReason) current.terminalReason = next.terminalReason;
    }
    if (current.status !== 'running') current.endedAt = event.t;
    if (next.tokens) current.tokens = next.tokens;
    for (const message of next.keyMessages) {
      if (current.keyMessages.length < 3) current.keyMessages.push(message);
    }
    const names = this.tools.get(event.invocationId);
    for (const name of next.toolNames) {
      if (!names?.has(name)) {
        names?.add(name);
        current.toolNames.push(name);
      }
    }
  }

  values(): IterableIterator<InvocationTrajectorySummary> {
    return this.summaries.values();
  }
}
