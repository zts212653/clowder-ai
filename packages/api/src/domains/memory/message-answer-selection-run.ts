import { randomUUID } from 'node:crypto';
import {
  type MessageSearchResponse,
  type MessageSearchResult,
  type SelectedMessageSource,
  selectedMessageSourcesSchema,
} from '@cat-cafe/shared';
import { attachDecisionSources, type MessageDecisionIndex } from './message-decision-index.js';
import { boundMessageSearchResponse, MESSAGE_SEARCH_RESPONSE_BUDGET } from './message-search-budget.js';
import {
  checkSearchExecution,
  type MessageSearchExecutionContext,
  readBeforeSearchCutoff,
} from './message-search-lifetime.js';
import {
  MessageSelectionError,
  type SelectedSourceReader,
  verifySelectedMessageQuote,
} from './message-selected-quote.js';

/** Materialize the cat's selected coordinates through the existing canonical admission, without retrieval. */
export async function runMessageAnswerSelection(
  query: string,
  selections: SelectedMessageSource[],
  catId: string,
  options: {
    read: SelectedSourceReader;
    revalidateAll: (
      results: MessageSearchResult[],
      lifetime: MessageSearchExecutionContext,
    ) => Promise<MessageSearchResult[]>;
    requireSource: () => Promise<void>;
    decisionIndex: MessageDecisionIndex;
    context: MessageSearchExecutionContext;
  },
): Promise<MessageSearchResponse> {
  if (!query.trim() || query.length > 2000 || !catId) throw new MessageSelectionError('Invalid answer selection');
  const chosen = selectedMessageSourcesSchema.parse(selections);
  const deadlineAt = Math.min(options.context.deadlineAt ?? Infinity, Date.now() + 15000);
  const context = { ...options.context, deadlineAt };
  const read: SelectedSourceReader = async (ref) => {
    const result = await readBeforeSearchCutoff(() => options.read(ref), deadlineAt - 750, context);
    if (!result.completed) throw new DOMException('Selected source verification deadline exceeded', 'TimeoutError');
    return result.value;
  };
  const authorize = async () => {
    const result = await readBeforeSearchCutoff(options.requireSource, deadlineAt - 250, context);
    if (!result.completed) throw new DOMException('Answer source authorization deadline exceeded', 'TimeoutError');
  };
  await authorize();
  const results: MessageSearchResult[] = [];
  for (const input of chosen) {
    const admitted = await read(input);
    if (!admitted) throw new MessageSelectionError('Selected source is not accessible or current');
    const selection = await verifySelectedMessageQuote(input, admitted, read);
    const { matchEvidence: _matchEvidence, ...row } = admitted.result;
    results.push({ ...row, match: 'selected', highlights: [], selection });
  }
  // Ledger facts remain declarations about actual coordinates, never the cat's reason.
  const labelled = results.map((row) => ({ ...row }));
  const ledgerCutoff = Math.min(deadlineAt - 2000, Date.now() + 750);
  const ledger = await readBeforeSearchCutoff(
    () =>
      attachDecisionSources(labelled, options.decisionIndex, {
        signal: context.signal,
        deadlineAt: ledgerCutoff,
      }),
    ledgerCutoff,
    context,
  );
  const decisionIndex = ledger.completed ? ledger.value : { status: 'unavailable' as const };
  if (ledger.completed)
    results.forEach((row, index) => {
      if (labelled[index].decisionSources) row.decisionSources = labelled[index].decisionSources;
    });
  const work = await readBeforeSearchCutoff(
    (lifetime) => options.revalidateAll(results, lifetime),
    deadlineAt - 750,
    context,
  );
  if (!work.completed) throw new DOMException('Selected source verification deadline exceeded', 'TimeoutError');
  const current = work.value;
  checkSearchExecution(context);
  if (!current.length) throw new MessageSelectionError('Selected sources changed before preparation');
  const response: MessageSearchResponse = {
    searchId: randomUUID(),
    query,
    results: current,
    meta: {
      scope: 'global',
      sort: 'selected',
      requestedMode: 'selected',
      effectiveMode: 'selected',
      degraded: false,
      partial: current.length !== chosen.length,
      hasMore: current.length !== chosen.length,
      candidateLimit: chosen.length,
      semanticCandidatesLimited: false,
      sourceCoverage: 'unknown',
      freshness: 'unknown',
      resultKind: 'selected-answer',
      answerSelection: { v: 1, catId, requested: chosen.length },
      ...(decisionIndex ? { decisionIndex } : {}),
      response: {
        budgetChars: MESSAGE_SEARCH_RESPONSE_BUDGET,
        serializedChars: 0,
        truncated: false,
        continuation: 'unavailable',
      },
    },
  };
  return boundMessageSearchResponse(response);
}
