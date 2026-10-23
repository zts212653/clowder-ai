import type { MessageSearchInput, MessageSearchResult } from '@cat-cafe/shared';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { literalQueryEvidence, type QueryCandidate } from './message-query-protocol.js';

export interface CanonicalSearchCandidate extends QueryCandidate {
  result: MessageSearchResult;
  candidate: MessagePassageCandidate;
}

/** Candidate collection never consumes indexed body text as a permission or qualification grant. */
export async function collectMessageSearchCandidates(input: {
  search: MessageSearchInput;
  candidates: MessagePassageCandidate[];
  threadIds: ReadonlySet<string>;
  source?: { threadId: string; messageId: string };
  project: (candidate: MessagePassageCandidate) => Promise<CanonicalSearchCandidate | null>;
  check: () => void;
}): Promise<CanonicalSearchCandidate[]> {
  const rows: CanonicalSearchCandidate[] = [];
  const seen = new Set<string>();
  const from = input.search.dateFrom ? Date.parse(input.search.dateFrom) : -Infinity;
  const to = input.search.dateTo
    ? Date.parse(input.search.dateTo.length === 10 ? `${input.search.dateTo}T23:59:59.999Z` : input.search.dateTo)
    : Infinity;
  let literalWitnesses = 0;
  const width = input.search.sort === 'relevance' ? 1 : 8;
  for (let offset = 0; offset < input.candidates.length; offset += width) {
    input.check();
    const projected = await Promise.all(
      input.candidates.slice(offset, offset + width).map(async (candidate) => {
        if (!validReference(candidate, input.threadIds, input.source)) return null;
        if (seen.has(JSON.stringify([candidate.threadId, candidate.messageId]))) return null;
        return input.project(candidate);
      }),
    );
    for (const row of projected) {
      input.check();
      if (!row) continue;
      const key = JSON.stringify([row.threadId, row.messageId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(row.result.timestamp >= from && row.result.timestamp <= to)) continue;
      rows.push(row);
      if (literalQueryEvidence(input.search.query, row.content)) literalWitnesses++;
      // Pending semantic rows preceding these literal witnesses are still judged.
      if (input.search.sort === 'relevance' && literalWitnesses > (input.search.limit ?? 20)) return rows;
    }
  }
  if (input.search.sort !== 'relevance')
    rows.sort(
      (a, b) =>
        a.result.timestamp - b.result.timestamp ||
        a.threadId.localeCompare(b.threadId) ||
        a.messageId.localeCompare(b.messageId),
    );
  return rows;
}

function validReference(
  candidate: MessagePassageCandidate,
  threadIds: ReadonlySet<string>,
  source?: { threadId: string; messageId: string },
): boolean {
  return (
    candidate.docAnchor === `thread-${candidate.threadId}` &&
    candidate.passageId === `msg-${candidate.messageId}` &&
    threadIds.has(candidate.threadId) &&
    !(source?.threadId === candidate.threadId && source.messageId === candidate.messageId)
  );
}
