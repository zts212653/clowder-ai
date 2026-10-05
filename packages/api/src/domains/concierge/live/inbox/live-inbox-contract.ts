import type { CatId } from '@cat-cafe/shared';

/** Host-admitted identity. A new call/generation constructs a new consumer. */
export interface LiveInboxScope {
  userId: string;
  threadId: string;
  catId: CatId;
  invocationId: string;
  parentInvocationId?: string;
  callId: string;
  generation: number;
}

export interface LiveInboxReference {
  messageId: string;
  /** Canonical per-target carrier, for the ordinary Queue owner to revalidate/reselect. */
  queueEntryId: string;
  threadId: string;
  sourceThreadId: string;
  authorCatId: string | null;
  targetCatId: CatId;
  priority: 'urgent' | 'normal' | 'fyi';
  /** Canonical order, independent of the producer's timestamp and arrival replay order. */
  order: string;
  /** The current full-read route cannot expose this source; only ordinary Queue succession may admit it. */
  nextWork: boolean;
  facts: {
    persisted: true;
    notified: boolean;
    readByInvocationIds: readonly string[];
    /** Separate Host continuity evidence; a historical read alone cannot establish retained context. */
    readInCurrentContext: boolean;
    handled: boolean;
    /** Playback needs a separate provider/source witness; Queue read is never that witness. */
    playback: 'unknown';
  };
}

/** Read-only projection. Durable Message/Queue owners alone advance receipt/terminal truth. */
export interface LiveInboxSource {
  page(
    scope: LiveInboxScope,
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    items: LiveInboxReference[];
    nextCursor?: string;
    hasMore: boolean;
  }>;
  read(scope: LiveInboxScope, messageId: string): Promise<LiveInboxReference | null>;
}

export interface LiveInboxBoundary {
  kind: 'idle' | 'tool_complete' | 'turn_complete';
  generation: number;
  userSpeaking: boolean;
}

export type LiveInboxResult = {
  /** Resident notification candidates only, never the total count of unfinished work. */
  pending: number;
  hasMore: boolean;
} & (
  | {
      kind:
        | 'idle'
        | 'closed'
        | 'busy'
        | 'cancelled'
        | 'accepted'
        | 'backpressure'
        | 'user_speaking'
        | 'stale_generation';
    }
  | { kind: 'successor_required'; successorSources: readonly LiveInboxReference[] }
);

export interface LiveInboxBatch {
  scope: LiveInboxScope;
  references: readonly LiveInboxReference[];
  notice: string;
  /** Host must fence the final provider write with this signal and exact call generation. */
  signal: AbortSignal;
}

export interface LiveInboxOptions {
  scope: LiveInboxScope;
  source: LiveInboxSource;
  /** Content-free event wake. Host decides when a safe boundary is available. */
  wake(): void;
  deliver(batch: LiveInboxBatch): Promise<'accepted' | 'busy'>;
  capacity?: number;
  batchSize?: number;
  pageSize?: number;
  maxPagesPerBoundary?: number;
}
