import type { MessageSearchResponse } from '@cat-cafe/shared';
import { observeQueryQualification } from './message-query-observation.js';
import {
  candidateKey,
  literalQueryEvidence,
  parseQualification,
  type QualificationBatch,
  type QueryCandidate,
  type QueryDecision,
  qualificationBatch,
  qualificationSchedulingScore,
} from './message-query-protocol.js';

export interface QualificationContext {
  userId: string;
  signal?: AbortSignal;
  deadlineAt: number;
  resultLimit?: number;
  onTrace?: (trace: Record<string, unknown>) => void;
}
export type QueryBatchRunner = (batch: QualificationBatch, context: QualificationContext) => Promise<string>;
export type QualificationMeta = NonNullable<MessageSearchResponse['meta']['qualification']>;

// One Host-wide bound, shared by all UI/cat/concierge service instances; no retry queue.
let inFlight = 0;

function selectQualificationRows(query: string, pending: QueryCandidate[], resultLimit?: number) {
  const score = qualificationSchedulingScore(query);
  const ranked = pending.map((row) => ({ row, score: score(row.content) })).sort((a, b) => b.score - a.score);
  const rowBudget = resultLimit === undefined ? 128 : Math.min(128, Math.max(2, resultLimit + 1));
  // Literal neighbours cannot consume every opportunity. Reserve both a row
  // and its complete character budget for the earliest zero-clue candidate.
  const exploratory =
    resultLimit === undefined
      ? undefined
      : ranked.find((item) => item.score === 0 && item.row.content.length <= 64_000);
  if (exploratory) {
    const position = ranked.indexOf(exploratory);
    if (position >= rowBudget) {
      ranked.splice(position, 1);
      ranked.splice(rowBudget - 1, 0, exploratory);
    }
  }
  const selected: QueryCandidate[] = [];
  let chars = 0;
  for (const { row } of ranked) {
    const reserved =
      exploratory && row !== exploratory.row && !selected.includes(exploratory.row)
        ? exploratory.row.content.length
        : 0;
    if (chars + row.content.length + reserved > 64_000 || selected.length >= rowBudget) continue;
    chars += row.content.length;
    selected.push(row);
  }
  return { selected, chars };
}

export class MessageQueryQualifier {
  constructor(private readonly run: QueryBatchRunner) {}

  async qualify(query: string, candidates: readonly QueryCandidate[], context: QualificationContext) {
    const decisions = new Map<string, QueryDecision>();
    const evidence = new Map<string, string>();
    const pending = candidates.filter((row) => {
      const quote = literalQueryEvidence(query, row.content);
      if (!quote) return true;
      decisions.set(candidateKey(row), 'supported');
      evidence.set(candidateKey(row), quote);
      return false;
    });
    // Schedule finite inference work, not recall or result ordering. Literal
    // coverage is only a scheduling hint; it can neither grant nor deny support.
    const { selected, chars } = selectQualificationRows(query, pending, context.resultLimit);
    // The real 53-row / 64k parallel sample did not complete in the remaining
    // deadline. Schedule page-sized whole bodies; all unscheduled rows stay unknown.
    const batches: Array<{ rows: QueryCandidate[]; chars: number }> =
      selected.length > 1
        ? [
            { rows: [], chars: 0 },
            { rows: [], chars: 0 },
          ]
        : [{ rows: [], chars: 0 }];
    for (const row of selected) {
      const batch = [...batches].sort((a, b) => a.chars - b.chars).find((batch) => batch.rows.length < 64);
      if (!batch) break;
      batch.rows.push(row);
      batch.chars += row.content.length;
    }
    let nativeCalls = 0;
    const observation = observeQueryQualification();
    await Promise.all(
      batches
        .map((batch) => batch.rows)
        .filter((rows) => rows.length)
        .map(async (rows) => {
          if (inFlight >= 2 || Date.now() >= context.deadlineAt - 2000 || context.signal?.aborted) return;
          inFlight++;
          nativeCalls++;
          const controller = new AbortController();
          const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
          const batchObservation = observation.start(
            rows.length,
            rows.reduce((n, row) => n + row.content.length, 0),
            context.deadlineAt,
            context.onTrace,
          );
          const onAbort = () => batchObservation.abort();
          signal.addEventListener('abort', onAbort, { once: true });
          let failed = false;
          const timer = setTimeout(
            () => controller.abort(new DOMException('Qualification deadline', 'TimeoutError')),
            Math.max(0, context.deadlineAt - Date.now() - 2000),
          );
          try {
            const batch = qualificationBatch(query, rows);
            const text = await this.run(batch, {
              ...context,
              signal,
              onTrace: batchObservation.trace,
            });
            if (!signal.aborted)
              for (const [key, decision] of parseQualification(text, batch, evidence)) decisions.set(key, decision);
          } catch (error) {
            failed = true;
            context.onTrace?.({
              phase: 'qualification-unavailable',
              reason: error instanceof Error ? error.name : 'unknown',
            });
          } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            batchObservation.finish(signal.aborted, failed);
            inFlight--;
          }
        }),
    );
    try {
      context.signal?.throwIfAborted();
      if (Date.now() >= context.deadlineAt) throw new DOMException('Message search deadline exceeded', 'TimeoutError');
    } catch (error) {
      observation.attach(error);
      throw error;
    }
    const counts = { supported: 0, rejected: 0, indeterminate: 0 };
    for (const decision of decisions.values()) counts[decision]++;
    const unassessed = candidates.length - decisions.size;
    const meta: QualificationMeta = {
      status: unassessed || counts.indeterminate ? 'partial' : 'complete',
      examined: candidates.length,
      ...counts,
      unassessed,
    };
    context.onTrace?.({ phase: 'qualification', nativeCalls, bodyChars: chars, ...meta });
    return { decisions, evidence, meta, nativeCalls };
  }
}
