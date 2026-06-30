/**
 * F254 FreshnessNoticeService (Phase B — B1)
 *
 * Decides whether to attach a content-free "you have unseen messages" notice
 * to a read-only MCP tool response. Orchestrates the B0 infrastructure:
 * - FreshnessInvocationStateStore (hot path counters)
 * - FreshnessAttentionEventLog (cold path event recording)
 * - UnseenChecker (pluggable unseen-message detection, reuses Phase A messageFilter)
 *
 * Design constraints (spec §B1):
 * - Only read-only tools (readOnlyHint: true) get notices
 * - Frequency: MCP layer gates every N tool calls (server-toolsets.ts); API only checks max cap
 * - Max cap: M per invocation (M = MAX_NOTICES_PER_INVOCATION, default 3)
 * - Content-free: sender names + count, NO message content/previews
 * - Records notice_attached event for B3/B4 (re-invoke + eval)
 * - Scope: current thread only (KD-10)
 */

import type { CatId } from '@cat-cafe/shared';
import { freshnessNoticeAttached, freshnessNoticeDeferred } from '../../../../infrastructure/telemetry/instruments.js';
import type { FreshnessAttentionEvent, NoticeAttachedEvent } from './FreshnessAttentionEventLog.js';
import type { FreshnessInvocationState } from './FreshnessInvocationStateStore.js';
import type { RuntimeCapabilityDescriptor } from './RuntimeCapabilityDescriptor.js';

// --- Configuration (tunable parameters, spec M4) ---

// NOTE: Frequency gating (every N calls) is handled by MCP layer (server-toolsets.ts),
// not here. API only checks max cap + unseen. See P2-1 review fix.

/** Maximum notices per invocation (default 3, opus-47 suggestion) */
const MAX_NOTICES_PER_INVOCATION = 3;

// --- Dependency interfaces ---

/** What the service needs from FreshnessInvocationStateStore */
export interface NoticeStateStore {
  get(invocationId: string): Promise<FreshnessInvocationState | null>;
  incrementToolCallCount(invocationId: string): Promise<number>;
  recordNoticeDelivered(invocationId: string, toolCallNum: number): Promise<void>;
}

/** What the service needs from FreshnessAttentionEventLog */
export interface NoticeEventLog {
  append(event: FreshnessAttentionEvent): Promise<void>;
  /** B2: query unresolved notices for hold_ball reminder (notices delivered but not acked/deferred) */
  getUnresolvedNotices(invocationId: string): Promise<NoticeAttachedEvent[]>;
}

/** Pluggable unseen-message detection (decoupled from messageFilter/store wiring) */
export interface UnseenChecker {
  checkUnseen(params: { threadId: string; catId: CatId }): Promise<UnseenResult | null>;
}

export interface UnseenResult {
  count: number;
  senders: string[];
  maxMessageId: string;
}

// --- Output ---

export interface FreshnessNotice {
  text: string;
  noticeId: string;
}

// --- Service ---

export class FreshnessNoticeService {
  constructor(
    private readonly stateStore: NoticeStateStore,
    private readonly eventLog: NoticeEventLog,
    private readonly unseenChecker: UnseenChecker,
  ) {}

  /**
   * Check whether to attach a freshness notice to a tool response.
   *
   * Called after every MCP tool execution. Always increments toolCallCount.
   * Returns a notice (text + ID) if all gates pass, or null.
   *
   * Gate chain (API side — frequency pre-filtered by MCP layer):
   * 1. isReadOnly? → no → null
   * 2. max cap: noticeDeliveredCount < MAX_NOTICES_PER_INVOCATION?
   * 3. unseen check: are there unseen messages in the current thread?
   */
  async checkAndMaybeNotice(params: {
    invocationId: string;
    threadId: string;
    catId: CatId;
    toolName: string;
    isReadOnly: boolean;
    /**
     * AC-C3: Optional runtime capability descriptor. When provided and
     * `canReceiveContentFreeNotice` is false, the service skips notice
     * attachment entirely (the cat can't meaningfully act on notices in
     * this runtime mode). Without descriptor, service behaves as before.
     */
    descriptor?: RuntimeCapabilityDescriptor;
  }): Promise<FreshnessNotice | null> {
    const { invocationId, threadId, catId, toolName, isReadOnly } = params;

    // Increment for audit trail (actual count may differ from MCP-side count
    // because MCP pre-filters by frequency before calling API — P2-1 fix)
    await this.stateStore.incrementToolCallCount(invocationId);

    // AC-C3: Descriptor gate — skip notice entirely when runtime can't use it.
    // Checked before isReadOnly gate so toolCallCount is still incremented
    // (audit trail shouldn't be affected by descriptor).
    if (params.descriptor?.canReceiveContentFreeNotice === false) return null;

    // Gate 1: only read-only tools
    if (!isReadOnly) return null;

    // Gate 2: max cap (frequency gating is handled by MCP layer — single source of truth)
    const state = await this.stateStore.get(invocationId);
    const delivered = state?.noticeDeliveredCount ?? 0;
    if (delivered >= MAX_NOTICES_PER_INVOCATION) return null;

    // Gate 3: unseen messages in current thread
    const unseen = await this.unseenChecker.checkUnseen({ threadId, catId });
    if (!unseen || unseen.count === 0) return null;

    // All gates passed — deliver notice
    const toolCallCount = state?.toolCallCount ?? 1;
    const noticeId = `notice-${invocationId}-${toolCallCount}`;

    // Update hot path state
    await this.stateStore.recordNoticeDelivered(invocationId, toolCallCount);

    // Record cold path event
    await this.eventLog.append({
      kind: 'notice_attached',
      threadId,
      catId,
      invocationId,
      timestamp: Date.now(),
      toolName,
      unseenSenders: unseen.senders,
      noticeId,
      maxMessageId: unseen.maxMessageId,
    });

    // AC-B5: OTel counter
    freshnessNoticeAttached.add(1);

    // Format content-free notice text
    const text =
      `📬 提醒：你有 ${unseen.count} 条未读消息（当前 thread）\n` +
      `来自：${unseen.senders.join(', ')}\n` +
      `调 get_thread_context 查看完整内容`;

    return { text, noticeId };
  }

  /**
   * B2: Check for unresolved notices when cat calls hold_ball.
   *
   * If the cat has received notices (B1) that were NOT acked (seenCursor
   * didn't advance), returns a reminder text and records a notice_deferred
   * event. Does NOT block hold_ball.
   *
   * Returns null if no unresolved notices exist.
   */
  async checkHoldBallReminder(params: {
    invocationId: string;
    threadId: string;
    catId: CatId;
    /** Current seenCursor — notices with maxMessageId <= cursor are resolved */
    currentSeenCursor?: string | null;
  }): Promise<{ text: string } | null> {
    const { invocationId, threadId, catId, currentSeenCursor } = params;

    let unresolved = await this.eventLog.getUnresolvedNotices(invocationId);

    // P1-2 fix: filter out notices that the cat has already read past
    // (seenCursor advanced beyond notice.maxMessageId = implicitly resolved)
    //
    // Known limitation (P2-R4-1): message IDs embed creation timestamp
    // (generateSortableId), so lexicographic comparison matches creation
    // order. However, queued messages (F117) can have their sorted-set
    // score re-assigned via markDelivered() without changing the ID.
    // If a queued message is delivered late, its ID may be lexicographically
    // older than seenCursor even though it's unseen. This is acceptable
    // because: (a) B1 already delivered the original notice, (b) this is
    // an advisory reminder, (c) Phase B scope doesn't cover queued-message
    // delivery interactions. Fix if Phase C integrates queued messages.
    if (currentSeenCursor) {
      unresolved = unresolved.filter((n) => n.maxMessageId > currentSeenCursor);
    }

    if (unresolved.length === 0) return null;

    // Aggregate unique senders from all unresolved notices
    const senderSet = new Set<string>();
    for (const notice of unresolved) {
      for (const sender of notice.unseenSenders) {
        senderSet.add(sender);
      }
    }
    const senders = [...senderSet];
    const noticeIds = unresolved.map((n) => n.noticeId);

    // Record notice_deferred event (cat chose to hold despite unresolved notices)
    await this.eventLog.append({
      kind: 'notice_deferred',
      threadId,
      catId,
      invocationId,
      timestamp: Date.now(),
      noticeIds,
    });

    // AC-B5: OTel counter — increment per notice (not per hold_ball event) to match
    // freshnessNoticeAttached denominator granularity (cloud R1 P2).
    freshnessNoticeDeferred.add(unresolved.length);

    // Content-free reminder: sender names + count only
    const text =
      `⚠️ 你这轮有 ${unresolved.length} 条未读消息未查看\n` +
      `来自：${senders.join(', ')}\n` +
      `建议调 get_thread_context 先看看再退出`;

    return { text };
  }
}
