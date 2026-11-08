import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { attachDecisionSources, type MessageDecisionIndex, sameDeclaredDecision } from './message-decision-index.js';
import { boundMessageSearchResponse } from './message-search-budget.js';
import { checkSearchExecution, readBeforeSearchCutoff } from './message-search-lifetime.js';

interface SnapshotOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  decisionIndex: MessageDecisionIndex;
  project: (result: MessageSearchResult) => Promise<MessageSearchResult | null>;
  requireSource: () => Promise<void>;
}

/** Revalidate one existing bounded snapshot. Admission stays with MessageSearchService. */
export async function readMessageSearchAnswerSnapshot(response: MessageSearchResponse, options: SnapshotOptions) {
  const execution = {
    signal: options.signal,
    deadlineAt: Math.min(options.deadlineAt ?? Infinity, Date.now() + 15000),
  };
  const result = await readBeforeSearchCutoff(
    () => readSnapshot(response, { ...options, ...execution }),
    execution.deadlineAt - 250,
    execution,
  );
  if (!result.completed) throw new DOMException('Answer source verification deadline exceeded', 'TimeoutError');
  return result.value;
}

async function readSnapshot(response: MessageSearchResponse, options: SnapshotOptions & { deadlineAt: number }) {
  await options.requireSource();
  const current: MessageSearchResult[] = [];
  let changedSources = 0;
  for (const result of response.results) {
    checkSearchExecution(options);
    const admitted = await options.project(result);
    if (admitted) current.push({ ...admitted });
    else changedSources++;
  }
  const verified = current.map((row) => {
    const copy = { ...row };
    delete copy.decisionSources;
    return copy;
  });
  const cutoff = Math.min(options.deadlineAt - 1000, Date.now() + 750);
  const ledger = await readBeforeSearchCutoff(
    () =>
      attachDecisionSources(verified, options.decisionIndex, {
        signal: options.signal,
        deadlineAt: cutoff,
      }),
    cutoff,
    options,
  );
  let decisionUpdated = false;
  for (const [index, row] of current.entries()) {
    const original = row.decisionSources;
    const kept = original?.flatMap((fact) => {
      const current =
        ledger.completed &&
        verified[index]?.decisionSources?.find((candidate) => sameDeclaredDecision(fact, candidate));
      if (!current) return [];
      // Preserve the sole saved response. Only the admitted read projection
      // follows an unchanged decision to its current, verified file location.
      return [
        current.line === fact.line ? fact : { ...fact, line: current.line, documentRevision: current.documentRevision },
      ];
    });
    if (kept?.length !== original?.length) decisionUpdated = true;
    if (kept?.length) row.decisionSources = kept;
    else delete row.decisionSources;
  }
  // Ledger I/O may yield to a withdrawal. Re-admit before publishing any saved body.
  const results: MessageSearchResult[] = [];
  for (const row of current) {
    checkSearchExecution(options);
    const admitted = await options.project(row);
    if (admitted) results.push(admitted);
    else changedSources++;
  }
  await options.requireSource();
  checkSearchExecution(options);
  return {
    response: boundMessageSearchResponse(
      { ...response, results, meta: { ...response.meta, ...(changedSources ? { partial: true } : {}) } },
      response.meta.response.budgetChars,
    ),
    changedSources,
    decisionUpdated,
  };
}
