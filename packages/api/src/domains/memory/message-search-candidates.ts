import type { MessageSearchInput, MessageSearchResult } from '@cat-cafe/shared';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import type { MessageSearchDiagnostics } from './message-search-diagnostics.js';

export interface CanonicalSearchCandidate {
  threadId: string;
  messageId: string;
  contentRevision: string;
  result: MessageSearchResult;
  candidate: MessagePassageCandidate;
}

/** ROOT's first measured window; this is coverage, never a relevance qualification. */
export const MESSAGE_SEARCH_TIME_WINDOW = 32;

/** Candidate collection never consumes indexed body text as a permission or qualification grant. */
export async function collectMessageSearchCandidates(input: {
  search: MessageSearchInput;
  candidates: MessagePassageCandidate[];
  threadIds: ReadonlySet<string>;
  source?: { threadId: string; messageId: string };
  project: (candidate: MessagePassageCandidate) => Promise<CanonicalSearchCandidate | null>;
  projectWave?: (candidates: MessagePassageCandidate[]) => Promise<Array<CanonicalSearchCandidate | null>>;
  beforeWave?: (
    read: () => Promise<Array<CanonicalSearchCandidate | null>>,
  ) => Promise<Array<CanonicalSearchCandidate | null> | undefined>;
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
  const limit = input.search.limit ?? 20;
  const admissionLimit = input.search.sort === 'relevance' ? limit + 1 : MESSAGE_SEARCH_TIME_WINDOW;
  for (let offset = 0; offset < input.candidates.length; ) {
    input.check();
    // Overlap only independent canonical reads, retaining retrieval order below.
    // Ordinary recall counts every admitted source, including semantic-only rows.
    const remaining = admissionLimit - rows.length;
    if (remaining <= 0) break;
    const width = Math.min(8, remaining);
    const wave = input.candidates.slice(offset, offset + width);
    const selected = wave.filter(
      (candidate) =>
        validReference(candidate, input.threadIds, input.source) &&
        !seen.has(JSON.stringify([candidate.threadId, candidate.messageId])),
    );
    const readWave = () =>
      input.projectWave
        ? input.projectWave(selected)
        : Promise.all(selected.map((candidate) => input.project(candidate)));
    const read = () => (input.diagnostics ? input.diagnostics.wave(wave.length, readWave) : readWave());
    const projected = await (input.beforeWave ? input.beforeWave(read) : read());
    if (!projected) break;
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
