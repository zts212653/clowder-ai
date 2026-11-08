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

export function messageDiscoverySource(input: {
  search: MessageSearchInput;
  read: (
    request: import('./knowledge-discovery.js').DiscoveryReadRequest,
  ) => Promise<{ candidates: MessagePassageCandidate[] }>;
  threadIds: ReadonlySet<string>;
  source?: { threadId: string; messageId: string };
  project: (candidate: MessagePassageCandidate) => Promise<CanonicalSearchCandidate | null>;
  projectWave?: (candidates: MessagePassageCandidate[]) => Promise<Array<CanonicalSearchCandidate | null>>;
  beforeWave?: (
    read: () => Promise<Array<CanonicalSearchCandidate | null>>,
  ) => Promise<Array<CanonicalSearchCandidate | null> | undefined>;
  diagnostics?: MessageSearchDiagnostics;
}): import('./knowledge-discovery.js').KnowledgeDiscoverySource<MessagePassageCandidate, CanonicalSearchCandidate> {
  const from = input.search.dateFrom ? Date.parse(input.search.dateFrom) : -Infinity;
  const to = input.search.dateTo
    ? Date.parse(input.search.dateTo.length === 10 ? `${input.search.dateTo}T23:59:59.999Z` : input.search.dateTo)
    : Infinity;
  const inWindow = (row: CanonicalSearchCandidate | null) =>
    row && row.result.timestamp >= from && row.result.timestamp <= to ? row : null;
  return {
    id: 'messages',
    read: input.read,
    eligible: (candidate) => validReference(candidate, input.threadIds, input.source),
    project: async (candidate) => inWindow(await input.project(candidate)),
    projectWave: async (candidates) => {
      const read = async () =>
        (await (input.projectWave ? input.projectWave(candidates) : Promise.all(candidates.map(input.project)))).map(
          inWindow,
        );
      return input.diagnostics ? input.diagnostics.wave(candidates.length, read) : read();
    },
    beforeWave: input.beforeWave,
    key: (row) => JSON.stringify([row.threadId, row.messageId]),
    candidateKey: (row) => JSON.stringify([row.threadId, row.messageId]),
    onCandidates: (count) => input.diagnostics?.candidates(count),
    onAccepted: () => input.diagnostics?.accepted(),
  };
}

export function compareCanonicalMessages(a: CanonicalSearchCandidate, b: CanonicalSearchCandidate): number {
  return (
    a.result.timestamp - b.result.timestamp ||
    a.threadId.localeCompare(b.threadId) ||
    a.messageId.localeCompare(b.messageId)
  );
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
