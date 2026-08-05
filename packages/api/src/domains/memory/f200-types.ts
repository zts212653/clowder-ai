// F200: Memory Recall Eval — types + experiment flags

import type { ExpansionFunnelMeta, RecallResultStatus } from '@cat-cafe/shared';

export type RecallToolName = 'search_evidence' | 'graph_resolve' | 'list_recent' | 'session_bootstrap' | 'cold_context';

export type RecallSource = 'pull' | 'push';
export type PushRecallSurface = 'session_bootstrap' | 'cold_context';

export interface PushRecallPresentation {
  surface: PushRecallSurface;
  query: string;
  scope: string;
  timestamp: number;
  candidates: Array<{
    anchor: string;
    rank: number;
    sourcePath?: string;
    docKind?: string;
  }>;
}

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
  source: RecallSource;
  pushSurface?: PushRecallSurface;
  presented: boolean;
  inspected: boolean;
  outcome: 'used' | 'ignored';
  query: string;
  mode?: string;
  scope?: string;
  candidates: RecallCandidate[];
  /** Reported search hit count from tool_result text, distinct from parsed candidates. */
  resultCount?: number;
  /** Structured producer/search outcome; distinguishes true zero from telemetry unknown. */
  resultStatus?: RecallResultStatus;
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
  /** F263 P1: stable source event identity for retry idempotency.
   * Preferred: _toolUseId from provider. Fallback: invocationId:turnIndex. */
  sourceEventId?: string;
  /** F102 bugfix: thread association for RecallFeed history persistence. */
  threadId?: string;
  /** F256 Wave 1b: query-time health stages plus correlated downstream outcomes. */
  expansionFunnel?: ExpansionFunnelMeta & { followed: number; used: number };
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
