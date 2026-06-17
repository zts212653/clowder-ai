/**
 * Message Store
 * 内存消息存储，供 MCP 回传工具 get_thread_context / get_pending_mentions 使用
 *
 * 有界数组实现，超过 MAX_MESSAGES 时丢弃最旧消息。
 */

import { randomUUID } from 'node:crypto';
import type {
  CatId,
  ConnectorSource,
  MessageContent,
  ReplyPreview,
  RichMessageExtra,
  SchedulerMessageExtra,
} from '@cat-cafe/shared';
import type { MessageMetadata } from '../../types.js';
import { isSystemUserMessage } from '../visibility.js';
// Single source of truth: ThreadStore.ts owns DEFAULT_THREAD_ID
import { DEFAULT_THREAD_ID } from './ThreadStore.js';
export { DEFAULT_THREAD_ID };

/**
 * F117: Check if a message should be visible in timeline/history/context.
 * Legacy messages (no deliveryStatus) are treated as delivered.
 */
export function isDelivered(msg: StoredMessage): boolean {
  return !msg.deliveryStatus || msg.deliveryStatus === 'delivered';
}

/**
 * A tool event recorded during agent invocation (tool_use / tool_result).
 * Persisted alongside the assistant message so history reload can display them.
 *
 * F153 Phase J Slice J-B AC-J7: extends StoredToolEvent with the four-piece
 * telemetry set (toolUseId / status / tracing / startTimeMs / endTimeMs) so
 * the cold-start `hydrate-traces.ts` path can synthesize real-duration
 * `cat_cafe.tool_use` child spans instead of degrading to flat
 * `cat_cafe.invocation.restored` markers (per KD-39 / AC-J8).
 *
 * NEW fields are all optional for backward compat: legacy messages without
 * Phase J wiring still load cleanly, hydrate just skips tool span synthesis
 * for those entries (per KD-41: no fake duration when source signal absent).
 */
export interface StoredToolEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  timestamp: number;
  /** F153 Phase J AC-J7: native provider tool id, used to pair tool_use ↔ tool_result
   *  and to key the synthesized span on hydrate. Set by provider transformer via
   *  AgentMessage.toolUseId (AC-J2). */
  toolUseId?: string;
  /** F153 Phase J AC-J7: structured execution outcome, set on tool_result events.
   *  Mapped from AgentMessage.toolResultStatus (AC-J2 execution edge); NEVER inferred
   *  from content text (KD-38 honesty). */
  status?: 'ok' | 'error' | 'unknown';
  /** F153 Phase J AC-J7: OTel span context for the tool span. Persisted so hydrate
   *  can re-parent the synthesized span under the invocation span (parentSpanId
   *  points at the invocation span context written into message.extra.tracing). */
  tracing?: { traceId: string; spanId: string; parentSpanId?: string };
  /** F153 Phase J AC-J7: span start Unix timestamp (ms). Set on tool_use events
   *  when the ToolSpanTracker opens the span. */
  startTimeMs?: number;
  /** F153 Phase J AC-J7: span end Unix timestamp (ms). Set on tool_result events
   *  when the ToolSpanTracker closes the span. Together with `startTimeMs` enables
   *  AC-J8 real-duration restore (vs flat `invocation.restored`). */
  endTimeMs?: number;
  /** R6 maintainer (Slice J-B): native tool name persisted as a separate data field
   *  (decoupled from the UI display `label`). Hydrate's `synthesizeToolSpansFromEvents`
   *  prefers this field for the synthesized span name; falls back to parsing `label`
   *  only for legacy stored events that predate this field. Set on `tool_use` events
   *  from `AgentMessage.toolName ?? 'unknown'`. Avoids silent degradation to `unknown`
   *  or wrong tool names if the label arrow format / catId prefix / localization changes. */
  toolName?: string;
}

/**
 * A stored message entry (after append — threadId always present)
 */
export interface StoredMessage {
  id: string;
  /** Thread this message belongs to (always set after append) */
  threadId: string;
  userId: string;
  /** null = user message, CatId = cat message */
  catId: CatId | null;
  content: string;
  /** Rich content blocks (text, images, code). When absent, use content string. */
  contentBlocks?: readonly MessageContent[];
  /** Tool events recorded during agent invocation (for history replay). */
  toolEvents?: readonly StoredToolEvent[];
  /** Provider/model metadata (for cat messages) */
  metadata?: MessageMetadata;
  /** F022+F052+F098-C1+F153-F: Extensible extra data (rich blocks, stream metadata, cross-post origin, explicit targets, tracing pointers) */
  extra?: {
    rich?: RichMessageExtra;
    /** #814/F224: explicit post_message callback bubble; history hydration must not merge it into stream output. */
    isExplicitPost?: boolean;
    /** F081 + F194 Phase Z3 dual id:
     *    - `invocationId` = parent/chain invocation (legacy field, liveness/queue/cancel SoT)
     *    - `turnInvocationId` = per-cat-turn invocation (Z3 new — bubble identity SoT for frontend
     *      hydrate/merge stable key; required so same-parent multi-turn-same-cat bubbles do NOT merge)
     *  Frontend prefers `turnInvocationId` (fallback `invocationId` for legacy messages). */
    stream?: { invocationId: string; turnInvocationId?: string };
    crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
    targetCats?: string[];
    scheduler?: SchedulerMessageExtra['scheduler'];
    tracing?: { traceId: string; spanId: string; parentSpanId?: string };
    systemKind?: 'a2a_routing' | 'context_briefing';
    a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string };
  };
  /** CatIds mentioned in this message */
  mentions: readonly CatId[];
  /** F057-C2: Whether this message mentions the user (@user / @co-creator) */
  mentionsUser?: boolean;
  timestamp: number;
  /** F045: Extended thinking content (accumulated from CLI thinking blocks). Persisted for F5 recovery. */
  thinking?: string;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech), briefing = F148 Phase E context briefing (non-routing) */
  origin?: 'stream' | 'callback' | 'briefing';
  /** F35: Message visibility. Default 'public' (undefined = public for backward compat) */
  visibility?: 'public' | 'whisper';
  /** F35: Whisper recipients. Only meaningful when visibility='whisper' */
  whisperTo?: readonly CatId[];
  /** F35: Timestamp when a whisper was revealed (made public). Present = revealed */
  revealedAt?: number;
  /** F097: External connector source. Present = connector message (not user/cat) */
  source?: ConnectorSource;
  /** F098-D: Timestamp when a queued message was actually dequeued and processed by a cat */
  deliveredAt?: number;
  /** F117: Delivery lifecycle status. undefined = legacy (treated as delivered) */
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
  /** F121: ID of the message this is replying to (same thread only) */
  replyTo?: string;
  /** ADR-008 D3: Soft delete timestamp (present = deleted) */
  deletedAt?: number;
  /** ADR-008 D3: Who deleted this message */
  deletedBy?: string;
  /** ADR-008 D3: Hard delete marker — content wiped, skeleton only */
  _tombstone?: true;
}

/**
 * Input for appending a message. threadId is optional (defaults to 'default').
 */
export type AppendMessageInput = Omit<StoredMessage, 'id' | 'threadId'> & {
  threadId?: string;
  /**
   * Optional idempotency token scoped to (userId + threadId + key).
   * Reusing the same token returns the original stored message.
   */
  idempotencyKey?: string;
};

/**
 * Stream-only metadata collected by route-serial after a callback message was
 * already persisted. It may augment the callback bubble, but must not replace
 * its canonical content/origin.
 */
export interface StreamMetadataAugmentInput {
  toolEvents?: readonly StoredToolEvent[];
  metadata?: MessageMetadata;
  thinking?: string;
  replyTo?: string;
  mentionsUser?: boolean;
  extra?: NonNullable<StoredMessage['extra']>;
}

function richBlockDedupeKey(block: unknown, index: number): string {
  if (block && typeof block === 'object' && 'id' in block) {
    const id = (block as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return `id:${id}`;
  }
  try {
    return `json:${JSON.stringify(block)}`;
  } catch {
    return `index:${index}`;
  }
}

function mergeRichExtra(existing?: RichMessageExtra, incoming?: RichMessageExtra): RichMessageExtra | undefined {
  if (!existing && !incoming) return undefined;
  const blocks = [...(existing?.blocks ?? [])];
  const seen = new Set(blocks.map((block, index) => richBlockDedupeKey(block, index)));
  for (const block of incoming?.blocks ?? []) {
    const key = richBlockDedupeKey(block, blocks.length);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }
  return { v: 1, blocks };
}

export function mergeMessageExtra(
  existing: StoredMessage['extra'] | undefined,
  incoming: StoredMessage['extra'] | undefined,
): StoredMessage['extra'] | undefined {
  if (!existing && !incoming) return undefined;
  const merged = { ...(existing ?? {}), ...(incoming ?? {}) };
  const rich = mergeRichExtra(existing?.rich, incoming?.rich);
  if (rich) merged.rich = rich;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeStoredToolEvents(
  existing: readonly StoredToolEvent[] | undefined,
  incoming: readonly StoredToolEvent[] | undefined,
): readonly StoredToolEvent[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  if (!existing || existing.length === 0) return [...incoming];
  const merged = [...existing];
  const seen = new Set(merged.map((event) => event.id));
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export function applyStreamMetadataAugment(msg: StoredMessage, patch: StreamMetadataAugmentInput): StoredMessage {
  if (patch.thinking && patch.thinking.trim().length > 0) {
    msg.thinking = patch.thinking;
  }
  if (patch.metadata) {
    msg.metadata = { ...(msg.metadata ?? {}), ...patch.metadata };
  }
  if (patch.toolEvents && patch.toolEvents.length > 0) {
    msg.toolEvents = mergeStoredToolEvents(msg.toolEvents, patch.toolEvents);
  }
  if (patch.replyTo && !msg.replyTo) {
    msg.replyTo = patch.replyTo;
  }
  if (patch.mentionsUser) {
    msg.mentionsUser = true;
  }
  if (patch.extra) {
    const mergedExtra = mergeMessageExtra(msg.extra, patch.extra);
    if (mergedExtra) msg.extra = mergedExtra;
  }
  return msg;
}

/**
 * Common interface for message stores (in-memory and Redis).
 * Methods that may hit Redis are async; in-memory returns immediately.
 */
export interface IMessageStore {
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
  append(msg: AppendMessageInput): StoredMessage | Promise<StoredMessage>;
  /** Get a single message by its ID. Returns null if not found. */
  getById(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  getRecent(limit?: number, userId?: string): StoredMessage[] | Promise<StoredMessage[]>;
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest). */
  getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getBefore(
    timestamp: number,
    limit?: number,
    userId?: string,
    beforeId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThread(threadId: string, limit?: number, userId?: string): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Delete all messages in a thread (cascade delete support) */
  deleteByThread(threadId: string): number | Promise<number>;
  /** ADR-008 D3: Soft delete — set deletedAt/deletedBy. Returns null if not found. */
  softDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Hard delete — wipe content, keep tombstone. Returns null if not found. */
  hardDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Restore a soft-deleted message. Rejects tombstones. Returns null if not found/not deleted. */
  restore(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** F35: Reveal whispers in a thread sent by userId (set revealedAt). Returns count revealed. */
  revealWhispers(threadId: string, userId: string): number | Promise<number>;
  /** F096: Update message extra data (for interactive block state persistence). Returns null if not found. */
  updateExtra(
    id: string,
    extra: NonNullable<StoredMessage['extra']>,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** #1462: augment callback-persisted messages with metadata collected only on the stream path. */
  augmentStreamMetadata(
    id: string,
    patch: StreamMetadataAugmentInput,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** F098-D: Mark a queued message as delivered (set deliveredAt). Returns null if not found. */
  markDelivered(id: string, deliveredAt: number): StoredMessage | null | Promise<StoredMessage | null>;
  /** F117: Mark a queued message as canceled (withdraw/clear). Returns null if not found. */
  markCanceled(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /**
   * Atomic content-dedup claim. Returns true if this fingerprint was newly claimed
   * (caller should proceed to append) or false if an identical claim is still live within
   * the window (caller must treat the post as a duplicate). Closes the check-then-act race
   * in the callback exact-duplicate scan: two concurrent byte-identical posts can both pass
   * the recent-message read before either appends, so the append decision needs an atomic
   * gate. In-memory: synchronous Map check+set (atomic within the event loop). Redis: SET NX PX.
   */
  claimContentDedupKey(key: string, ttlMs: number): boolean | Promise<boolean>;
  /** #697: Find message IDs with a given deliveryStatus. Used by StartupReconciler
   *  to recover orphaned queued messages after process restart. */
  scanByDeliveryStatus?(status: NonNullable<StoredMessage['deliveryStatus']>): string[] | Promise<string[]>;
}

/** Max messages to keep in memory */
const MAX_MESSAGES = 2000;

/** Default limit for queries */
const DEFAULT_LIMIT = 50;

/**
 * In-memory bounded message store.
 */
/**
 * Generate a sortable message ID: zero-padded timestamp + sequence + UUID suffix.
 * Lexicographic order matches insertion order even within the same millisecond.
 */
let _seq = 0;
export function generateSortableId(timestamp: number): string {
  const ts = String(timestamp).padStart(16, '0');
  const seq = String(_seq++).padStart(6, '0');
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${seq}-${suffix}`;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private readonly maxMessages: number;
  private readonly idempotencyIndex = new Map<string, string>();
  /** Content-dedup claims: fingerprint key → expiry timestamp (ms). Bounds the callback exact-duplicate race. */
  private readonly contentDedupIndex = new Map<string, number>();
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;

  constructor(options?: {
    maxMessages?: number;
    onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
  }) {
    this.maxMessages = options?.maxMessages ?? MAX_MESSAGES;
    this.onAppend = options?.onAppend;
  }

  private buildIdempotencyIndexKey(userId: string, threadId: string, idempotencyKey?: string): string | null {
    if (!idempotencyKey) return null;
    return `${userId}:${threadId}:${idempotencyKey}`;
  }

  private pruneIdempotencyIndexForMessageIds(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const removedIds = new Set(messageIds);
    for (const [key, value] of this.idempotencyIndex.entries()) {
      if (removedIds.has(value)) {
        this.idempotencyIndex.delete(key);
      }
    }
  }

  /**
   * Append a message to the store. Returns the stored message with generated id.
   */
  append(msg: AppendMessageInput): StoredMessage {
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(msg.userId, threadId, msg.idempotencyKey);
    if (idempotencyIndexKey) {
      const existingId = this.idempotencyIndex.get(idempotencyIndexKey);
      if (existingId) {
        const existing = this.getById(existingId);
        if (existing) {
          return existing;
        }
        this.idempotencyIndex.delete(idempotencyIndexKey);
      }
    }

    const { idempotencyKey, ...payload } = msg;
    void idempotencyKey;
    const stored: StoredMessage = {
      ...payload,
      id: generateSortableId(msg.timestamp),
      threadId,
    };
    this.messages.push(stored);
    if (idempotencyIndexKey) {
      this.idempotencyIndex.set(idempotencyIndexKey, stored.id);
    }

    // Trim oldest if over capacity
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.maxMessages);
      this.messages = this.messages.slice(-this.maxMessages);
      this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    }

    // F102 KD-34: fire-and-forget append listener for thread index updates
    // P2 fix: try-catch handles sync throws; Promise.resolve handles async rejections
    if (this.onAppend) {
      try {
        void Promise.resolve(this.onAppend(stored)).catch(() => {});
      } catch {
        /* best-effort */
      }
    }

    return stored;
  }

  /**
   * Get a single message by its ID. Returns null if not found.
   */
  getById(id: string): StoredMessage | null {
    return this.messages.find((m) => m.id === id) ?? null;
  }

  /**
   * Get the most recent N messages.
   * When userId is provided, only returns messages from that user's session.
   */
  getRecent(limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get mentions for a specific cat, ascending (oldest first after cursor).
   * When afterMessageId is provided, only returns mentions with id > afterMessageId.
   * Returns the oldest N matches (ascending) — R4 P1 contract.
   */
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk forward (ascending) to collect oldest-first after cursor
    for (let i = 0; i < this.messages.length && matches.length < n; i++) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (afterMessageId && msg.id <= afterMessageId) continue;
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches; // Already ascending
  }

  /**
   * Get mentions for a specific cat, taking the most recent N matches.
   * Returns ascending order (oldest→newest) within the returned window.
   */
  getRecentMentionsFor(catId: CatId, limit?: number, userId?: string, threadId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches.reverse();
  }

  /**
   * Get messages before a given cursor (cursor-based pagination).
   * When beforeId is provided, also excludes messages at the same timestamp
   * with id >= beforeId (composite cursor to handle same-millisecond messages).
   * Returns messages in chronological order (oldest first).
   */
  getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk backwards from most recent, collecting messages before the cursor
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (msg.timestamp > timestamp) continue;
      if (msg.timestamp === timestamp) {
        // Same timestamp: use id as tiebreaker (skip if id >= beforeId)
        if (!beforeId || msg.id >= beforeId) continue;
      }
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }

    // Reverse so oldest first
    return matches.reverse();
  }

  /**
   * Get the most recent N messages in a specific thread.
   */
  getByThread(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (msg.deliveryStatus === 'canceled') continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get messages in a thread after a specific message ID (exclusive), oldest first.
   * If afterId is undefined, returns messages from thread start.
   * If limit is undefined, returns all matches.
   */
  getByThreadAfter(threadId: string, afterId?: string, limit?: number, userId?: string): StoredMessage[] {
    const bounded = Number.isFinite(limit as number) && (limit as number) > 0;
    const max = bounded ? (limit as number) : Number.MAX_SAFE_INTEGER;
    const matches: StoredMessage[] = [];
    let cursorSeen = !afterId;

    for (let i = 0; i < this.messages.length && matches.length < max; i++) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (!cursorSeen) {
        if (msg.id === afterId) cursorSeen = true;
        continue;
      }
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (!isDelivered(msg)) continue;
      matches.push(msg);
    }

    if (!cursorSeen && afterId) {
      for (let i = 0; i < this.messages.length && matches.length < max; i++) {
        const msg = this.messages[i]!;
        if (msg.threadId !== threadId) continue;
        if (msg.id <= afterId) continue;
        if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
        if (!isDelivered(msg)) continue;
        matches.push(msg);
      }
    }

    return matches;
  }

  /**
   * Get messages in a thread before a given cursor (cursor-based pagination).
   */
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      // F232 P1 (cloud review): 游标按 effective order time（deliveredAt ?? timestamp）比较，
      // 与 RedisMessageStore 的 zset score 语义一致——queued 消息投递后 markDelivered 会把其
      // effective order time 推到 deliveredAt。若仍按 raw timestamp 比较，传入 deliveredAt 游标时
      // 游标消息自身（timestamp < deliveredAt）会被重复包含 → collectAllThreadMessages 同页无限循环。
      const effectiveTs = msg.deliveredAt ?? msg.timestamp;
      if (effectiveTs > timestamp) continue;
      if (effectiveTs === timestamp) {
        if (!beforeId || msg.id >= beforeId) continue;
      }
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  deleteByThread(threadId: string): number {
    const removed = this.messages.filter((m) => m.threadId === threadId);
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.threadId !== threadId);
    this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    return before - this.messages.length;
  }

  /**
   * ADR-008 D3: Soft delete — mark a message as deleted without removing it.
   * Returns the updated message or null if not found.
   */
  softDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   * Irreversible: content is permanently lost.
   */
  hardDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    this.pruneIdempotencyIndexForMessageIds([id]);
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message.
   * Rejects tombstones (hard-deleted) — those are irreversible.
   */
  restore(id: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    delete msg.deletedAt;
    delete msg.deletedBy;
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  revealWhispers(threadId: string, userId: string): number {
    const now = Date.now();
    let count = 0;
    for (const msg of this.messages) {
      if (msg.threadId !== threadId) continue;
      if (msg.userId !== userId) continue;
      if (msg.visibility === 'whisper' && !msg.revealedAt) {
        msg.revealedAt = now;
        count++;
      }
    }
    return count;
  }

  /**
   * F096: Update message extra data (for interactive block state persistence).
   */
  updateExtra(id: string, extra: NonNullable<StoredMessage['extra']>): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.extra = extra;
    return msg;
  }

  augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    return applyStreamMetadataAugment(msg, patch);
  }

  /**
   * F098-D: Mark a queued message as delivered (set deliveredAt timestamp).
   */
  markDelivered(id: string, deliveredAt: number): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return msg; // only transition queued → delivered
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    return msg;
  }

  /** F117: Mark a queued message as canceled (withdraw/clear). */
  markCanceled(id: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.deliveryStatus = 'canceled';
    return msg;
  }

  // #697: scanByDeliveryStatus intentionally NOT implemented for in-memory store.
  // In-memory store uses a bounded sliding window (MAX_MESSAGES) — messages
  // beyond the window would be silently ignored, masking real orphans visible
  // in production Redis. StartupReconciler's guard `if (!messageStore?.scanByDeliveryStatus)`
  // gracefully skips orphan recovery for in-memory mode. (LL-048 / PR #805 P2-2)

  /**
   * Atomic content-dedup claim (synchronous — atomic within the single-threaded event loop).
   * Returns true on first claim within the window, false if an identical claim is still live.
   */
  claimContentDedupKey(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.contentDedupIndex.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }
    this.contentDedupIndex.set(key, now + ttlMs);
    // Opportunistic prune so the index stays bounded under sustained traffic.
    if (this.contentDedupIndex.size > 2048) {
      for (const [k, exp] of this.contentDedupIndex) {
        if (exp <= now) this.contentDedupIndex.delete(k);
      }
    }
    return true;
  }

  /**
   * Current message count (for testing)
   */
  get size(): number {
    return this.messages.length;
  }
}

const PREVIEW_MAX_LENGTH = 80;

/**
 * F121: Hydrate a reply preview from message store.
 * Returns null if the referenced message doesn't exist.
 * Returns { deleted: true } if the parent was soft/hard-deleted.
 */
export async function hydrateReplyPreview(store: IMessageStore, replyToId: string): Promise<ReplyPreview | null> {
  const parent = await store.getById(replyToId);
  if (!parent) return null;

  if (parent.deletedAt || parent._tombstone) {
    return { senderCatId: parent.catId, content: '', deleted: true };
  }

  const truncated =
    parent.content.length > PREVIEW_MAX_LENGTH ? parent.content.slice(0, PREVIEW_MAX_LENGTH) : parent.content;

  return {
    senderCatId: parent.catId,
    content: truncated,
    ...(parent.extra?.scheduler?.hiddenTrigger ? { kind: 'scheduler_trigger' as const } : {}),
  };
}

/**
 * F193 AC-B2: Hydrate cross-thread reply hint from a trigger message.
 *
 * When a cat is invoked because someone cross-posted into their thread
 * (F052: source thread injected `extra.crossPost.sourceThreadId`),
 * the receiving cat needs structured guidance on how to reply:
 *   - sourceThreadId: where the message came from (full id, not slice(0,8))
 *   - senderCatId: who to @ on the reply (their handle)
 *
 * Caller provides triggerMessageId from worklist `a2aTriggerMessageId` Map
 * (route-serial) or callback-a2a-trigger queue backfill. We fetch the stored
 * message and return structured fields ONLY if it has cross-post metadata.
 *
 * Returns null when:
 *   - triggerMessageId not found (e.g. message expired / deleted)
 *   - parent has no extra.crossPost (same-thread post — not cross-thread relay)
 *
 * KD-1 boundary: agent-key target-thread writes don't inject crossPost
 * metadata at all (callbacks.ts:430 path), so this naturally returns null
 * for agent-key triggers — receiver gets no reply hint, which is correct.
 */
export async function hydrateCrossThreadReplyHint(
  store: IMessageStore,
  triggerMessageId: string,
): Promise<{ sourceThreadId: string; senderCatId: CatId } | null> {
  const trigger = await store.getById(triggerMessageId);
  if (!trigger) return null;
  const sourceThreadId = trigger.extra?.crossPost?.sourceThreadId;
  if (!sourceThreadId) return null;
  if (!trigger.catId) return null; // user-authored messages have no catId — not a cross-thread relay
  return {
    sourceThreadId,
    senderCatId: trigger.catId,
  };
}
