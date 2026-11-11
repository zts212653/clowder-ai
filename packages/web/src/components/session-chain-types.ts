import type { SessionRecord } from '@cat-cafe/shared';

/** Minimal session record from API GET /api/threads/:id/sessions */
export interface SessionSummary {
  id: string;
  cliSessionId?: string;
  catId: string;
  seq: number;
  status: 'active' | 'sealing' | 'sealed';
  messageCount: number;
  sealReason?: string;
  createdAt: number;
  sealedAt?: number;
  compressionCount?: number | null;
  contextHealth?: {
    usedTokens: number;
    windowTokens: number;
    fillRatio: number;
    source: 'exact' | 'approx';
  };
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  };
  runtimeSession?: RuntimeSessionSummary;
  scopedInvocation?: SessionRecord['scopedInvocation'];
}

interface RuntimeSessionSummary {
  runtime: string;
  runtimeSessionId: string;
  runtimeConversationId?: string;
  lifecycleState: string;
  lastObservedAt: number;
  retryFragment?: {
    kind: 'retry';
    retryReason: string;
    nextRuntimeSessionId?: string;
    detectedAt: number;
  };
  unexpectedRuntimeSessionSwitch?: {
    detectedAt: number;
    previousSessionId: string;
    previousRuntimeSessionId: string;
    currentRuntimeSessionId: string;
    declaredPreviousRuntimeSessionId?: string;
    reason: string;
  };
}
