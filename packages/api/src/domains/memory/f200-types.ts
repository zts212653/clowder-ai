// F200: Memory Recall Eval — types + experiment flags

export type RecallToolName = 'search_evidence' | 'graph_resolve' | 'list_recent';

export type TargetRef =
  | { kind: 'doc'; sourcePath: string; anchor?: string }
  | { kind: 'thread'; threadId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'invocation'; sessionId: string; invocationId: string }
  | { kind: 'passage'; passageId: string; threadId?: string; sessionId?: string };

export type ConsumedMethod =
  | 'Read'
  | 'Grep'
  | 'graph_resolve'
  | 'read_session_events'
  | 'read_session_digest'
  | 'read_invocation_detail'
  | 'get_thread_context'
  // F200 HW-4 根因②a: Codex shell-read (`/bin/zsh -lc "sed ... FILE"`)
  | 'command_execution';

export interface RecallCandidate {
  anchor: string;
  /** @0-indexed — BM25/vector rank from retrieval pipeline. MRR uses rank+1 as position. */
  rank: number;
  score?: number;
  targetRef: TargetRef;
  docKind?: string;
  resultSetId?: string;
}

export interface ConsumedEntry {
  anchor: string;
  rank: number;
  method: ConsumedMethod;
  dwellProxy?: number;
  /** F200 HW-4 根因③: consuming event provenance (toolName@timestamp) +
   * its window distance — so a positive isn't an opaque proxy. */
  consumingEventId?: string;
  distance?: number;
}

export interface RecallEvent {
  recallId: string;
  catId: string;
  invocationId: string;
  toolName: RecallToolName;
  query: string;
  mode?: string;
  scope?: string;
  candidates: RecallCandidate[];
  consumed: ConsumedEntry[];
  reformulated: boolean;
  fellBackToGrep: boolean;
  abandoned: boolean;
  nextGraphResolveAfterRead: boolean;
  tokenCost: number;
  timestamp: number;
  shadowRankingJson?: string | null;
  /** F200 HW-4 根因③: same-invocation searches before the first downstream
   * read/graph/shell-read share one bundle id (砚砚 audit Result 3). */
  resultSetId?: string;
  /** F200 HW-4 根因③: 'clean' = unique single-search attribution;
   * 'ambiguous' = overlapping bundle candidate pool (not per-search truth). */
  attributionClarity?: 'clean' | 'ambiguous';
}

export interface TaskTrajectory {
  trajectoryId: string;
  invocationId: string;
  threadId: string;
  catId: string;
  taskContext: string | null;
  searchEventIds: string[];
  filesRead: string[];
  filesModified: string[];
  outputVerified: boolean;
  outputVerifiedSignals: string[];
  totalTokenCost: number;
  duration: number;
  createdAt: number;
  updatedAt: number;
}

export interface F200FlagSnapshot {
  consumptionRerank: 'off' | 'shadow' | 'on';
}

export function freezeF200Flags(): F200FlagSnapshot {
  return Object.freeze({
    consumptionRerank: (process.env.F200_CONSUMPTION_RERANK as 'off' | 'shadow' | 'on') ?? 'off',
  });
}
