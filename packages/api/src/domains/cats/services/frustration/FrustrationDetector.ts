/**
 * F222: Frustration Auto-Issue — Detection service.
 *
 * Evaluates post-invocation signals and creates auto-issue drafts when
 * frustration thresholds are met. Two Phase A triggers:
 *
 *  1. CLI error: classified reason codes (auth_failed, quota_exceeded, etc.)
 *  2. Cancel burst: ≥3 permission denials within 60s window
 *
 * Dedup: same (threadId, signalType) within DEDUP_WINDOW_MS → skip.
 */

import type { CliDiagnostics, FrustrationSignalType, RichBlock } from '@cat-cafe/shared';
import type { SocketManager } from '../../../../infrastructure/websocket/index.js';
import type { IFrustrationIssueStore } from '../stores/ports/FrustrationIssueStore.js';
import type { IMessageStore } from '../stores/ports/MessageStore.js';

import { buildFrustrationIssueCard } from './frustration-card-builder.js';
import { TEXT_FRUSTRATION_THRESHOLD } from './text-frustration-keywords.js';

// ── Constants ──────────────────────────────────────────────────

/** CLI error codes that trigger auto-issue (user-actionable errors). */
export const TRIGGERING_REASON_CODES = new Set([
  'auth_failed',
  'quota_exceeded',
  'network_error',
  'context_window_exceeded',
  'tool_call_parse_failed',
  'spawn_failed',
  'invalid_config',
]);

/** Transient/internal codes that should NOT trigger (not user-actionable). */
const EXCLUDED_REASON_CODES = new Set([
  'server_overloaded', // transient
  'invalid_thinking_signature', // internal
  'missing_rollout', // internal
]);

/** Minimum permission denials in CANCEL_WINDOW_MS to trigger cancel_burst. */
export const CANCEL_BURST_THRESHOLD = 3;

/** Minimum elapsed time (ms) for a2a_timeout to fire. Spec: "超过阈值（如 60s）". */
export const A2A_TIMEOUT_THRESHOLD_MS = 60_000;

/** Window for counting permission denials (ms). */
export const CANCEL_WINDOW_MS = 60_000;

/** Dedup: don't re-trigger same (thread, signalType) within this window. */
export const DEDUP_WINDOW_MS = 5 * 60_000; // 5 minutes

/** Max recent messages to include in auto-issue context. */
export const CONTEXT_MESSAGE_COUNT = 5;

// ── Signal evaluation ──────────────────────────────────────────

export interface CliErrorSignal {
  type: 'cli_error';
  diagnostics: CliDiagnostics;
}

export interface CancelBurstSignal {
  type: 'cancel_burst';
  /** Recent denied permission requests with timestamps. */
  recentDenials: Array<{ action: string; timestamp: number }>;
}

export interface TextFrustrationSignal {
  type: 'text_frustration';
  matchedKeywords: string[];
  matchCount: number;
  recentUserMessages: string[];
}

export interface A2ATimeoutSignal {
  type: 'a2a_timeout';
  /** Cat ID that was @'d but didn't respond */
  targetCatId: string;
  /** How long (ms) the invocation ran before timing out / producing no output */
  elapsedMs: number;
}

/** Minimum retry matches to trigger. */
export const RETRY_BURST_THRESHOLD = 3;
/** Prefix length for similarity matching (first N chars). */
export const RETRY_PREFIX_LENGTH = 30;

export interface RetryBurstSignal {
  type: 'retry_burst';
  /** Number of recent messages matching the current message */
  matchCount: number;
  /** The repeated message prefix */
  repeatedPrefix: string;
}

/**
 * UX-3: User clicked "取消并反馈" — direct report, no threshold.
 * The user explicitly wants to file a complaint alongside a permission denial.
 */
export interface UserReportSignal {
  type: 'user_report';
  /** The tool action that was denied */
  toolName: string;
  /** The structured cancel reason from the deny button */
  cancelReason?: string;
}

export type FrustrationSignal =
  | CliErrorSignal
  | CancelBurstSignal
  | TextFrustrationSignal
  | A2ATimeoutSignal
  | RetryBurstSignal
  | UserReportSignal;

/**
 * Evaluate whether a signal should trigger an auto-issue.
 * Pure function — no side effects.
 */
export function shouldTrigger(signal: FrustrationSignal): boolean {
  if (signal.type === 'cli_error') {
    const code = signal.diagnostics.reasonCode;
    if (!code) return false;
    if (EXCLUDED_REASON_CODES.has(code)) return false;
    return TRIGGERING_REASON_CODES.has(code);
  }

  if (signal.type === 'cancel_burst') {
    const now = Date.now();
    const recentCount = signal.recentDenials.filter((d) => now - d.timestamp <= CANCEL_WINDOW_MS).length;
    return recentCount >= CANCEL_BURST_THRESHOLD;
  }

  if (signal.type === 'text_frustration') {
    return signal.matchCount >= TEXT_FRUSTRATION_THRESHOLD;
  }

  if (signal.type === 'a2a_timeout') {
    // P1 fix: only trigger when elapsed >= threshold (spec: 60s).
    // Instant crashes/parse errors have low elapsedMs and should not be labeled "timeout".
    return signal.elapsedMs >= A2A_TIMEOUT_THRESHOLD_MS;
  }

  if (signal.type === 'retry_burst') {
    return signal.matchCount >= RETRY_BURST_THRESHOLD;
  }

  // UX-3: user_report always triggers — user explicitly clicked "取消并反馈"
  if (signal.type === 'user_report') {
    return true;
  }

  return false;
}

// ── Dedup ──────────────────────────────────────────────────────

/** In-memory dedup map: `${threadId}::${signalType}` → lastTriggeredAt. */
const dedupMap = new Map<string, number>();

function dedupKey(threadId: string, signalType: FrustrationSignalType): string {
  return `${threadId}::${signalType}`;
}

export function isDuplicate(threadId: string, signalType: FrustrationSignalType): boolean {
  const key = dedupKey(threadId, signalType);
  const lastTriggered = dedupMap.get(key);
  if (lastTriggered && Date.now() - lastTriggered < DEDUP_WINDOW_MS) {
    return true;
  }
  return false;
}

export function markTriggered(threadId: string, signalType: FrustrationSignalType): void {
  dedupMap.set(dedupKey(threadId, signalType), Date.now());
}

/** For testing: reset dedup state. */
export function resetDedup(): void {
  dedupMap.clear();
}

// ── Context collection ─────────────────────────────────────────

export interface FrustrationDetectorDeps {
  frustrationIssueStore: IFrustrationIssueStore;
  messageStore: IMessageStore;
  socketManager?: SocketManager;
}

export interface EvaluateInput {
  signal: FrustrationSignal;
  threadId: string;
  userId: string;
  catId: string;
  invocationId?: string;
}

/**
 * Full evaluation pipeline: check threshold → dedup → collect context →
 * create draft issue → emit card to user.
 *
 * Returns the created issue if triggered, null otherwise.
 */
export async function evaluate(
  input: EvaluateInput,
  deps: FrustrationDetectorDeps,
): Promise<import('@cat-cafe/shared').FrustrationIssue | null> {
  const { signal, threadId, userId, catId, invocationId } = input;

  // 1. Threshold check
  if (!shouldTrigger(signal)) return null;

  const signalType: FrustrationSignalType = signal.type;

  // 2. Dedup — skip for user_report: each explicit "取消并反馈" click is intentional
  if (signalType !== 'user_report' && isDuplicate(threadId, signalType)) return null;

  // 3. Build signal detail
  let signalDetail: Record<string, unknown>;
  if (signal.type === 'cli_error') {
    signalDetail = {
      reasonCode: signal.diagnostics.reasonCode,
      publicSummary: signal.diagnostics.publicSummary,
      publicHint: signal.diagnostics.publicHint,
    };
  } else if (signal.type === 'cancel_burst') {
    signalDetail = {
      cancelCount: signal.recentDenials.length,
      windowMs: CANCEL_WINDOW_MS,
    };
  } else if (signal.type === 'text_frustration') {
    signalDetail = {
      matchedKeywords: signal.matchedKeywords,
      matchCount: signal.matchCount,
    };
  } else if (signal.type === 'a2a_timeout') {
    signalDetail = {
      targetCatId: signal.targetCatId,
      elapsedMs: signal.elapsedMs,
    };
  } else if (signal.type === 'retry_burst') {
    signalDetail = {
      matchCount: signal.matchCount,
      repeatedPrefix: signal.repeatedPrefix,
    };
  } else {
    // user_report
    signalDetail = {
      toolName: signal.toolName,
      cancelReason: signal.cancelReason,
    };
  }

  // 4. Collect context — recent messages from thread
  let recentMessages: Array<{ role: 'user' | 'cat' | 'system'; content: string; timestamp: number }> = [];
  try {
    const messages = await deps.messageStore.getByThread(threadId, CONTEXT_MESSAGE_COUNT);
    recentMessages = (messages as Array<{ catId?: string; userId?: string; content?: string; timestamp: number }>).map(
      (m) => ({
        role: (m.catId ? 'cat' : m.userId === 'system' ? 'system' : 'user') as 'user' | 'cat' | 'system',
        content: typeof m.content === 'string' ? m.content.slice(0, 500) : '',
        timestamp: m.timestamp,
      }),
    );
  } catch {
    // Non-blocking: proceed without context if messageStore fails
  }

  // 5. Create draft issue
  const issue = await deps.frustrationIssueStore.create({
    threadId,
    userId,
    catId: catId as import('@cat-cafe/shared').CatId,
    invocationId,
    signalType,
    signalDetail,
    context: {
      recentMessages,
      errorLogs: signal.type === 'cli_error' ? signal.diagnostics.safeExcerpt : undefined,
    },
  });

  // 6. Build rich blocks — card only. FrustrationIssueCard.tsx handles confirm/skip
  // UI directly (with description input). Do NOT add a generic interactive block:
  // InteractiveBlock doesn't support customInput→callback, so userDescription would
  // be silently dropped (P2 fix).
  const cardBlock = buildFrustrationIssueCard(issue);
  const richBlocks: RichBlock[] = [cardBlock];

  // 7. Post as system message with rich blocks
  try {
    const stored = await deps.messageStore.append({
      userId: 'system',
      catId: null,
      threadId,
      content: `[${signalType === 'user_report' ? '用户反馈' : '自动检测'}] ${signalType === 'user_report' ? '你发起了问题反馈' : `检测到可能的问题（${signalType === 'cli_error' ? 'CLI 错误' : '操作中断'}）`}，已自动整理上下文。`,
      mentions: [],
      timestamp: Date.now(),
      source: {
        connector: 'frustration-auto-issue',
        label: '问题检测',
        icon: '🔍',
        // NOT system_notice — that path (SystemNoticeBar) only renders content text,
        // completely dropping extra.rich blocks. Use connector presentation so
        // ChatMessage renders rich blocks via RichBlocks component. (P1-1 fix)
      },
      extra: { rich: { v: 1, blocks: richBlocks } },
    });

    // 8. Set visibility marker
    await deps.frustrationIssueStore.setCardMessageId(issue.issueId, stored.id);

    // 9. Broadcast to frontend
    if (deps.socketManager) {
      deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
        threadId,
        message: {
          id: stored.id,
          type: 'connector',
          content: stored.content,
          source: stored.source,
          timestamp: stored.timestamp,
          extra: stored.extra,
        },
      });
    }
  } catch {
    // Non-blocking: issue created but card delivery failed.
    // The issue is still in the store and queryable.
  }

  // 10. Mark dedup (skip for user_report — no dedup for explicit user clicks)
  if (signalType !== 'user_report') {
    markTriggered(threadId, signalType);
  }

  return issue;
}
