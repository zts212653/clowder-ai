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
export interface QueryBatchContext extends QualificationContext {
  /** Distinguish this batch's work deadline from cancellation by the caller. */
  deadlineSignal?: AbortSignal;
  requestSignal?: AbortSignal;
  /** Seal protocol-valid output before expiry; publication still waits for normal owned exit. */
  onResult?: (text: string) => boolean;
  /** Resolves only on owned OS close, even if the bounded request has already failed. */
  onTeardown?: (closed: Promise<void>) => void;
}
export type QueryBatchRunner = (batch: QualificationBatch, context: QueryBatchContext) => Promise<string>;
export type QualificationMeta = NonNullable<MessageSearchResponse['meta']['qualification']>;

export const QUALIFICATION_CLEANUP_RESERVE_MS = 2000;

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
          if (
            inFlight >= 2 ||
            Date.now() >= context.deadlineAt - QUALIFICATION_CLEANUP_RESERVE_MS ||
            context.signal?.aborted
          )
            return;
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
          let resultText: string | undefined;
          let resultOffered = false;
          let completed = false;
          let teardown: Promise<void> | undefined;
          const timer = setTimeout(
            () => controller.abort(new DOMException('Qualification deadline', 'TimeoutError')),
            Math.max(0, context.deadlineAt - Date.now() - QUALIFICATION_CLEANUP_RESERVE_MS),
          );
          try {
            const batch = qualificationBatch(query, rows);
            const text = await this.run(batch, {
              ...context,
              signal,
              deadlineSignal: controller.signal,
              requestSignal: context.signal,
              onTeardown: (closed) => {
                teardown = closed;
              },
              onResult: (text) => {
                const eligible =
                  !resultOffered &&
                  !signal.aborted &&
                  Date.now() < context.deadlineAt - QUALIFICATION_CLEANUP_RESERVE_MS;
                resultOffered = true;
                resultText = undefined;
                if (!eligible) return false;
                try {
                  parseQualification(text, batch);
                  resultText = text;
                  return true;
                } catch {
                  return false;
                }
              },
              onTrace: batchObservation.trace,
            });
            // A local work timeout cannot undo a result sealed before expiry
            // once the runner has proved normal teardown. External cancellation wins.
            if (!context.signal?.aborted && ((!resultOffered && !signal.aborted) || text === resultText)) {
              for (const [key, decision] of parseQualification(text, batch, evidence)) decisions.set(key, decision);
              completed = true;
            } else if (resultOffered && !signal.aborted) {
              throw new Error('Qualification result was not accepted before the work deadline');
            }
          } catch (error) {
            failed = true;
            batchObservation.trace({
              phase: 'qualification-unavailable',
              reason: error instanceof Error ? error.name : 'unknown',
            });
          } finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            batchObservation.finish(signal.aborted && !completed, failed);
            if (teardown)
              void teardown.then(() => {
                inFlight--;
              });
            else inFlight--;
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
    const lifecycle = observation.snapshot();
    const meta: QualificationMeta = {
      status: unassessed || counts.indeterminate ? 'partial' : 'complete',
      examined: candidates.length,
      ...counts,
      unassessed,
      batches: {
        started: lifecycle.runnerCalls,
        completed: lifecycle.batches.filter((batch) => batch.outcome === 'completed').length,
        cancelled: lifecycle.batches.filter((batch) => batch.outcome === 'aborted').length,
        failed: lifecycle.batches.filter((batch) => batch.outcome === 'failed').length,
      },
    };
    context.onTrace?.({ phase: 'qualification', nativeCalls, bodyChars: chars, ...meta, ...observation.snapshot() });
    return { decisions, evidence, meta, nativeCalls };
  }
}
