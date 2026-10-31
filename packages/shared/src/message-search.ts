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

/** A fresh read admission; canonical body/context is explicit opt-in for human read/quote. */
export interface MessageNavigationAdmission {
  status: 'available';
  target: MessageNavigationReference;
  updated: boolean;
  /** Explicit human read/quote request only; ordinary J5 admission returns no body. */
  message?: {
    threadId: string;
    messageId: string;
    /** Original visible text/quotes/comments, without model-facing attachment serialization. */
    content: string;
    speaker: string;
    speakerLabel?: string;
    timestamp: number;
    contentRevision: string;
    truncated: boolean;
  };
  following?: NonNullable<MessageNavigationAdmission['message']>[];
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
  /** A declared feature-table source, never a classification of the message text. */
  decisionSources?: Array<{
    status: 'decided' | 'not-adopted' | 'superseded';
    conclusion: string;
    featureId: string;
    documentPath: string;
    documentRevision: string;
    line: number;
    decidedBy?: string;
    decidedAt?: string;
    historical?: boolean;
  }>;
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
    decisionIndex?: { status: 'ready' | 'unavailable'; revision?: string };
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
