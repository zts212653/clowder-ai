/** The same message search request/response serves cats, concierge and the human UI. */
export interface MessageSearchInput {
  query: string;
  threadId?: string;
  sort?: 'time' | 'relevance';
  mode?: 'lexical' | 'semantic' | 'hybrid';
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
}

/** Coordinates and optional revision evidence; never a permission grant. */
export interface MessageNavigationReference {
  threadId: string;
  messageId?: string;
  contentRevision?: string;
}

/** A fresh read admission discloses no cached title or message body. */
export interface MessageNavigationAdmission {
  status: 'available';
  target: MessageNavigationReference;
  updated: boolean;
}

export interface MessageSearchResult {
  threadId: string;
  messageId: string;
  threadTitle: string;
  speaker: string;
  /** Bounded connector source/sender display text; never a member identity or authority. */
  speakerLabel?: string;
  timestamp: number;
  timelineOrderAt: number;
  snippet: { text: string; start: number; end: number; source: 'body' | 'attachment-text' };
  highlights: Array<{ start: number; end: number }>;
  match: 'lexical' | 'semantic' | 'hybrid';
  /** Revision evidence, never an authorization token. */
  contentRevision: string;
  publiclyQuotable: boolean;
}

export interface MessageSearchResponse {
  searchId: string;
  query: string;
  results: MessageSearchResult[];
  meta: {
    scope: 'thread' | 'global';
    threadId?: string;
    sort: 'time' | 'relevance';
    requestedMode: 'lexical' | 'semantic' | 'hybrid';
    effectiveMode: 'lexical' | 'semantic' | 'hybrid';
    degraded: boolean;
    degradeReason?: string;
    partial: boolean;
    hasMore: boolean;
    candidateLimit: number;
    semanticCandidatesLimited: boolean;
    sourceCoverage: 'unknown';
    freshness: 'unknown';
    /** Counts cover canonical rows examined in this request, not the entire history/index. */
    qualification?: {
      status: 'complete' | 'partial';
      examined: number;
      supported: number;
      rejected: number;
      indeterminate: number;
      unassessed: number;
    };
    response: { budgetChars: number; serializedChars: number; truncated: boolean; continuation: 'unavailable' };
  };
}
