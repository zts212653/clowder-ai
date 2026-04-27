/**
 * F174 Phase D2b-1 — In-context callback auth failure surface.
 *
 * When callback auth fails with a "surface-able" reason (the cat's invocation
 * record is still queryable so we know who/where), post a system rich block
 * into the affected thread + broadcast via socket so the cat and the human
 * see the failure on the spot. Statistics live in HubObservabilityTab; this
 * is the "明厨亮灶" (transparent kitchen) layer — entity carries its own state,
 * surfaced where it happens.
 *
 * Surface decision (per `cat-cafe-skills/refs/in-context-observability-checklist.md`):
 *  - `expired` / `invalid_token` → surface (record still queryable for catId/threadId)
 *  - `stale_invocation` → skip (just got replaced by a newer invocation, no user action needed)
 *  - `unknown_invocation` → skip (record gone, no reliable metadata to attach)
 *  - `missing_creds` → skip (no invocationId means no thread context at all)
 *  - **Background heartbeat tools** (refresh-token, etc.) → skip regardless of reason
 *    — they fire on a timer not on user action, so user has no actionable
 *    response. Telemetry still counts (D2b-3 panel + HubButton badge), but
 *    no thread富块 noise. Source: alpha 验收 #5 — 铲屎官撞到 idle gemini 因后台
 *    refresh-token 心跳触发的"幽灵失败"。
 *
 * Dedup (anti-noise per checklist):
 *  - Same (reason, tool, catId, threadId, userId) within 5min → suppressed
 *  - "Hide similar" opt-out: 24h suppression for that key
 *  - Cloud Codex P1 #1397: dedup MUST include threadId/userId — process-global
 *    notifier without those would cross-suppress unrelated threads/tenants.
 */

import { randomUUID } from 'node:crypto';
import type { CatId, ConnectorSource } from '@cat-cafe/shared';
import type { AuthFailureReason } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';

/**
 * F174 D2b-1 — connector source for the in-context surface.
 *
 * Without `source`, messages.ts:1209 timeline classification falls through
 * to `'user'` because catId=null + no source ≠ system + no isSystemUserMessage.
 * That made the warning look like the human posted it (砚砚 P1 #1397 review).
 * With this source, the message is classified as 'connector' on reload.
 *
 * 🔴 NO `meta.presentation: 'system_notice'` — that flag would route ChatMessage
 * to SystemNoticeBar, which currently does NOT render `extra.rich.blocks`. The
 * whole point of D2b-1 is the dedicated CallbackAuthFailureBlock; it lives in
 * the rich block and only renders when the message goes through ConnectorBubble
 * (which DOES render RichBlocks at ConnectorBubble.tsx:151). 砚砚 P1
 * #1397 re-review caught this routing trap.
 */
export const CALLBACK_AUTH_SOURCE: ConnectorSource = {
  connector: 'callback-auth',
  label: 'Callback Auth',
  icon: '🔌',
};

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const HIDE_WINDOW_MS = 24 * 60 * 60 * 1000;

const SURFACEABLE_REASONS = new Set<AuthFailureReason | 'missing_creds'>(['expired', 'invalid_token']);

/**
 * F174 D2b-1 follow-up: tools that are SYSTEM-DRIVEN background heartbeats,
 * not user-triggered work. Their callback auth failures are noise to the
 * user — they happen automatically (timer-based), and the failure has no
 * user-visible action item ("nothing the user can do; next user task will
 * re-establish auth naturally"). Telemetry still records these for D2b-3
 * panel + HubButton badge counts; we just don't surface them in-context.
 *
 * Source: alpha 验收 #5 (2026-04-26 16:31) — 铲屎官「gemini 都一小时没说话了
 * 为什么会有这个奇怪的提醒？」 caused by refresh-token timer firing while
 * cat was idle. 现场可感知性 = "用户驱动 callback 失败"，不是 "system 心跳失败"。
 *
 * Related: post_message / register_pr_tracking / update_task / retain_memory
 * etc. ARE user-driven (cat invoked them as part of user task) — they remain
 * surfaceable.
 */
const BACKGROUND_HEARTBEAT_TOOLS = new Set<string>(['refresh-token']);

const REASON_DESCRIPTIONS: Record<AuthFailureReason | 'missing_creds', string> = {
  expired: 'callback token 已过期',
  invalid_token: 'callback token 不匹配',
  unknown_invocation: 'invocation 未找到（可能已过期清理）',
  stale_invocation: '已被新 invocation 顶替',
  missing_creds: '请求未携带 callback 凭证',
};

export interface NotifyParams {
  threadId: string;
  catId: CatId;
  userId: string;
  reason: AuthFailureReason | 'missing_creds';
  tool: string;
  fallbackOk?: boolean;
}

export interface HideSimilarParams {
  reason: AuthFailureReason | 'missing_creds';
  tool: string;
  catId: CatId;
  /** F174 D2b-1 cloud P1 #1397: scope hide to a specific thread (no cross-thread bleed). */
  threadId: string;
  /** F174 D2b-1 cloud P1 #1397: scope hide per user (multi-tenant isolation). */
  userId: string;
}

interface SocketBroadcaster {
  broadcastToRoom(room: string, event: string, payload: unknown): void;
}

export interface NotifierOptions {
  messageStore: IMessageStore;
  socketManager: SocketBroadcaster;
  now?: () => number;
}

interface DedupState {
  lastSentAt: number;
  hiddenAt?: number;
}

function dedupKey(p: { reason: string; tool: string; catId: string; threadId: string; userId: string }): string {
  // Cloud Codex P1 #1397: include threadId + userId so a hide/dedup in one
  // thread doesn't silently suppress the same (cat, tool, reason) tuple in
  // an unrelated thread or tenant.
  return `${p.reason}:${p.tool}:${p.catId}:${p.threadId}:${p.userId}`;
}

export class CallbackAuthSystemMessageNotifier {
  private readonly messageStore: IMessageStore;
  private readonly socketManager: SocketBroadcaster;
  private readonly now: () => number;
  private readonly dedup = new Map<string, DedupState>();

  constructor(options: NotifierOptions) {
    this.messageStore = options.messageStore;
    this.socketManager = options.socketManager;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Cloud Codex P2 #1397: opportunistically evict dedup entries whose
   * window has elapsed. Without this, `(reason, tool, catId, threadId, userId)`
   * tuples accumulate forever in long-lived API processes (multi-tenant + many
   * threads) — slow but real memory leak. Called on every notify(); cheap
   * because notifications are rare (5min dedup window) and the map is small
   * in steady state.
   */
  private pruneExpired(now: number): void {
    for (const [key, state] of this.dedup) {
      const expiresAt =
        state.hiddenAt !== undefined ? state.hiddenAt + HIDE_WINDOW_MS : state.lastSentAt + DEDUP_WINDOW_MS;
      if (now >= expiresAt) {
        this.dedup.delete(key);
      }
    }
  }

  /** Test seam — internal dedup map size for memory-bound regression tests. */
  __getDedupSizeForTest(): number {
    return this.dedup.size;
  }

  /**
   * Decide + (if surfaceable, not deduped, not hidden) post the in-context rich block.
   * Returns true if a message was actually sent.
   */
  async notify(params: NotifyParams): Promise<boolean> {
    // Cloud Codex P2 #1427: prune dedup cache BEFORE any early-return guard.
    // Otherwise a process that mainly sees suppressed heartbeat failures
    // (refresh-token, etc.) would never call pruneExpired → stale entries
    // accumulate, partially reintroducing the memory-retention class
    // pruneExpired was designed to fix.
    const now = this.now();
    this.pruneExpired(now);

    if (!SURFACEABLE_REASONS.has(params.reason)) return false;
    // D2b-1 follow-up: skip in-context surface for background heartbeat tools
    // (e.g. refresh-token). User has no actionable response to a heartbeat
    // failure when they're not currently driving the cat — telemetry still
    // counts toward D2b-3 panel + HubButton badge.
    if (BACKGROUND_HEARTBEAT_TOOLS.has(params.tool)) return false;

    const key = dedupKey({
      reason: params.reason,
      tool: params.tool,
      catId: params.catId,
      threadId: params.threadId,
      userId: params.userId,
    });
    const state = this.dedup.get(key);

    if (state?.hiddenAt !== undefined && now - state.hiddenAt < HIDE_WINDOW_MS) {
      return false;
    }
    if (state && state.hiddenAt === undefined && now - state.lastSentAt < DEDUP_WINDOW_MS) {
      return false;
    }

    // Cloud Codex P2 #1397: reserve the dedup slot SYNCHRONOUSLY before the
    // async append so two concurrent notify() calls for the same tuple both
    // see the slot and only one emits. Without this, both callers pass the
    // guard, both await, both emit duplicate cards (bursty 401s = thread spam).
    this.dedup.set(key, { lastSentAt: now });

    let stored;
    try {
      const block = buildAuthFailureBlock({ ...params, failedAt: now });
      stored = await this.messageStore.append({
        userId: params.userId,
        catId: null,
        content: `[callback-auth] ${params.tool} → ${params.reason}${params.fallbackOk ? ' (fallback ok)' : ''}`,
        mentions: [],
        timestamp: now,
        threadId: params.threadId,
        // F174 D2b-1 (砚砚 P1 #1397): without `source`, messages.ts timeline
        // classifies catId=null messages as `user` on reload, making the warning
        // appear as if the human posted it. Connector source fixes the type.
        source: CALLBACK_AUTH_SOURCE,
        extra: { rich: { v: 1 as const, blocks: [block] } },
      });
    } catch (err) {
      // Persistence failed — roll back the dedup slot so a retry within the
      // 5min window isn't silently suppressed. Only undo if we still own the
      // slot (a later concurrent caller may have overwritten it).
      const current = this.dedup.get(key);
      if (current && current.lastSentAt === now && current.hiddenAt === undefined) {
        this.dedup.delete(key);
      }
      throw err;
    }

    this.socketManager.broadcastToRoom(`thread:${params.threadId}`, 'connector_message', {
      threadId: params.threadId,
      message: {
        id: stored.id,
        type: 'connector',
        content: stored.content,
        source: CALLBACK_AUTH_SOURCE,
        timestamp: stored.timestamp,
        extra: stored.extra,
      },
    });

    return true;
  }

  /**
   * Hide subsequent in-context surfaces for the same
   * (reason, tool, catId, threadId, userId) tuple for 24h.
   */
  hideSimilar(params: HideSimilarParams): void {
    const key = dedupKey(params);
    const now = this.now();
    this.dedup.set(key, { lastSentAt: now, hiddenAt: now });
  }
}

interface BlockParams {
  reason: AuthFailureReason | 'missing_creds';
  tool: string;
  catId: CatId;
  threadId: string;
  userId: string;
  failedAt: number;
  fallbackOk?: boolean;
}

function buildAuthFailureBlock(params: BlockParams) {
  return {
    v: 1 as const,
    id: randomUUID(),
    kind: 'card' as const,
    title: 'Callback Auth Failure',
    bodyMarkdown: `\`${params.tool}\` callback auth 失败：${REASON_DESCRIPTIONS[params.reason]}${params.fallbackOk ? '（fallback 已成功）' : ''}`,
    tone: 'warning' as const,
    fields: [
      { label: 'Reason', value: params.reason },
      { label: 'Tool', value: params.tool },
      { label: 'Cat', value: params.catId },
      { label: 'Failed', value: new Date(params.failedAt).toISOString() },
    ],
    // Cloud Codex P1 #1397: meta carries threadId/userId so the frontend
    // hide-similar button posts the full scoped key — backend honors it.
    meta: {
      kind: 'callback_auth_failure',
      reason: params.reason,
      tool: params.tool,
      catId: params.catId,
      threadId: params.threadId,
      userId: params.userId,
      failedAt: params.failedAt,
      fallbackOk: params.fallbackOk ?? false,
    },
  };
}
