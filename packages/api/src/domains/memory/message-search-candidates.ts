import type { MessageSearchInput, MessageSearchResult } from '@cat-cafe/shared';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import { literalQueryEvidence, type QueryCandidate } from './message-query-protocol.js';
import type { MessageSearchDiagnostics } from './message-search-diagnostics.js';

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
  diagnostics?: MessageSearchDiagnostics;
}): Promise<CanonicalSearchCandidate[]> {
  input.diagnostics?.candidates(input.candidates.length);
  const rows: CanonicalSearchCandidate[] = [];
  const seen = new Set<string>();
  const from = input.search.dateFrom ? Date.parse(input.search.dateFrom) : -Infinity;
  const to = input.search.dateTo
    ? Date.parse(input.search.dateTo.length === 10 ? `${input.search.dateTo}T23:59:59.999Z` : input.search.dateTo)
    : Infinity;
  let literalWitnesses = 0;
  const limit = input.search.limit ?? 20;
  for (let offset = 0; offset < input.candidates.length; ) {
    input.check();
    // Overlap only independent canonical reads, retaining retrieval order below.
    // Never read beyond the remaining literal page/witness budget on the fast path.
    const width = input.search.sort === 'relevance' ? Math.min(8, limit + 1 - literalWitnesses) : 8;
    const wave = input.candidates.slice(offset, offset + width);
    const readWave = () =>
      Promise.all(
        wave.map(async (candidate) => {
          if (!validReference(candidate, input.threadIds, input.source)) return null;
          if (seen.has(JSON.stringify([candidate.threadId, candidate.messageId]))) return null;
          return input.project(candidate);
        }),
      );
    const projected = await (input.diagnostics ? input.diagnostics.wave(wave.length, readWave) : readWave());
    offset += width;
    for (const row of projected) {
      input.check();
      if (!row) continue;
      const key = JSON.stringify([row.threadId, row.messageId]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(row.result.timestamp >= from && row.result.timestamp <= to)) continue;
      rows.push(row);
      input.diagnostics?.accepted();
      if (literalQueryEvidence(input.search.query, row.content)) literalWitnesses++;
      // Pending semantic rows preceding these literal witnesses are still judged.
      if (input.search.sort === 'relevance' && literalWitnesses > limit) return rows;
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
