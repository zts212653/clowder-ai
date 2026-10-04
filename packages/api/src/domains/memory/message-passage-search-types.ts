import type { SearchExecutionMeta, SearchOptions } from './interfaces.js';

/** Internal index admission. These grants/source coordinates come from the server. */
export interface MessagePassageSearchOptions
  extends Pick<SearchOptions, 'mode' | 'threadId' | 'dateFrom' | 'dateTo' | 'signal' | 'deadlineAt'> {
  visibleThreadIds: readonly string[];
  sort?: 'time' | 'relevance';
  candidateLimit?: number;
  excludeSource?: { threadId: string; messageId: string };
}

/** An index candidate; canonical Thread/Message validation is still required. */
export interface MessagePassageCandidate {
  docAnchor: string;
  passageId: string;
  threadId: string;
  messageId: string;
  content: string;
  speaker?: string;
  createdAt?: string;
  match: 'lexical' | 'semantic' | 'hybrid';
}

export interface MessagePassageIndexState {
  current: boolean;
  suppressThreadTitle: boolean;
}

export interface MessagePassageSearchExecution {
  passages: MessagePassageCandidate[];
  meta: SearchExecutionMeta & {
    effectiveMode: 'lexical' | 'semantic' | 'hybrid';
    sort: 'time' | 'relevance';
    candidateLimit: number;
    truncated: boolean;
    semanticCandidatesLimited: boolean;
    sourceCoverage: 'unknown';
    freshness: 'unknown';
  };
}
