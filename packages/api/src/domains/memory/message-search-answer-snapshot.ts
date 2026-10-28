import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { attachDecisionSources, type MessageDecisionIndex, sameDeclaredDecision } from './message-decision-index.js';
import { boundMessageSearchResponse } from './message-search-budget.js';

/** Revalidate one existing bounded snapshot. Admission stays with MessageSearchService. */
export async function readMessageSearchAnswerSnapshot(
  response: MessageSearchResponse,
  options: {
    signal?: AbortSignal;
    decisionIndex: MessageDecisionIndex;
    admit: (result: MessageSearchResult) => Promise<boolean>;
  },
) {
  const current: MessageSearchResult[] = [];
  let changedSources = 0;
  for (const result of response.results) {
    options.signal?.throwIfAborted();
    const admitted = await options.admit(result);
    if (admitted) current.push({ ...result });
    else changedSources++;
  }
  const verified = current.map((row) => {
    const copy = { ...row };
    delete copy.decisionSources;
    return copy;
  });
  await attachDecisionSources(verified, options.decisionIndex, {
    signal: options.signal,
    deadlineAt: Date.now() + 750,
  });
  let decisionUpdated = false;
  for (const [index, row] of current.entries()) {
    const original = row.decisionSources;
    const kept = original?.flatMap((fact) => {
      const current = verified[index]?.decisionSources?.find((candidate) => sameDeclaredDecision(fact, candidate));
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
    options.signal?.throwIfAborted();
    const admitted = await options.admit(row);
    if (admitted) results.push(row);
    else changedSources++;
  }
  return {
    response: boundMessageSearchResponse(
      { ...response, results, meta: { ...response.meta, ...(changedSources ? { partial: true } : {}) } },
      response.meta.response.budgetChars,
    ),
    changedSources,
    decisionUpdated,
  };
}
