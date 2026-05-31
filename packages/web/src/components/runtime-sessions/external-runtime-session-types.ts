export type ExternalRuntimeSessionLifecycleState =
  | 'active'
  | 'runtime_seal_pending'
  | 'runtime_conflict_pending'
  | 'sealed'
  | string;

export interface ExternalRuntimeSessionLifecycle {
  state: ExternalRuntimeSessionLifecycleState;
  startedAt: number;
  lastObservedAt: number;
  sealReason?: string;
  drainResult?: string;
  pendingSince?: number;
  retryCount?: number;
  lastRetryAt?: number;
  lastFailureReason?: string;
}

export interface ExternalRuntimeIdentityHistoryEntry {
  catId: string;
  model?: string;
  modelVerified?: boolean;
  provider?: string;
  from?: number;
  observedAt?: number;
  to?: number;
  source?: string;
}

export type ExternalRuntimeSessionBinding =
  | { mode: 'orphan_anchor'; anchorThreadId: string }
  | { mode: 'thread'; threadId: string; requestedBy?: 'agent_key' | string };

export interface ExternalRuntimeSessionDrilldown {
  sessionRecord: string;
  events: string;
  digest: string;
}

export interface ExternalRuntimeSessionListItem {
  sessionId: string;
  threadId: string;
  runtime: 'antigravity-desktop' | string;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  catId: string;
  surface?: 'cat-cafe-dispatch' | 'ide-direct' | string;
  model?: string;
  identityHistory?: ExternalRuntimeIdentityHistoryEntry[];
  title?: string;
  lastObservedAt: number;
  lifecycle: ExternalRuntimeSessionLifecycle;
  binding: ExternalRuntimeSessionBinding;
  provenance?: Record<string, unknown>;
  drilldown: ExternalRuntimeSessionDrilldown;
}

export interface ExternalRuntimeSessionsListResponse {
  sessions: ExternalRuntimeSessionListItem[];
}
