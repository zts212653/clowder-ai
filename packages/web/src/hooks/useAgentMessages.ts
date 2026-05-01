'use client';

import type { ReplyPreview } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import { deriveBubbleId } from '@/debug/bubbleIdentity';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import type {
  CatInvocationInfo,
  CatStatusType,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePatch,
  RichBlock,
  TaskProgressItem,
  ThreadState,
  TokenUsage,
  ToolEvent,
} from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { compactToolResultDetail } from '@/utils/toolPreview';
import {
  clearReplacedInvocationsForThread,
  isInvocationReplaced,
  markReplacedInvocation,
  removeReplacedInvocation,
} from './shared-replaced-invocations';
import { formatVisibleSystemInfo } from './system-info-visible';
import {
  clearActiveBubble as clearActiveBubbleLedger,
  clearAllActiveBubblesForThread as clearAllActiveBubblesForThreadLedger,
  clearAllFinalizedForThread as clearAllFinalizedForThreadLedger,
  clearFinalized as clearFinalizedLedger,
  clearPendingTimeoutDiag as clearPendingTimeoutDiagLedger,
  clearStreamData as clearStreamDataLedger,
  decideTerminalEventTarget as decideTerminalEventTargetLedger,
  getActiveBubbleCount as getActiveBubbleCountLedger,
  getActiveBubble as getActiveBubbleLedger,
  getAllActiveBubblesForThread as getAllActiveBubblesForThreadLedger,
  getFinalizedMessageId as getFinalizedMessageIdLedger,
  getLastObservedExplicit as getLastObservedExplicitLedger,
  getPendingTimeoutDiag as getPendingTimeoutDiagLedger,
  hadStreamData as hadStreamDataLedger,
  markExplicitInvocationObserved as markExplicitInvocationObservedLedger,
  markStreamData as markStreamDataLedger,
  setActiveBubble as setActiveBubbleLedger,
  setFinalizedBubble as setFinalizedBubbleLedger,
  setPendingTimeoutDiag as setPendingTimeoutDiagLedger,
  type TerminalDecision,
} from './thread-runtime-ledger';
import { getThreadRuntimeLedger } from './thread-runtime-singleton';

// F173 Phase E (KD-1 handler unification): handleAgentMessage is the single
// socket dispatch entry. Background event business logic is now module-local in
// useAgentMessages instead of living in a socket-layer background module.

/** F173 Phase B: callback merge window for finalized bubbles (5min). */
const FINALIZED_TTL_MS = 5 * 60 * 1000;

/** Timeout for done(isFinal) - 5 minutes */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;
/** Monotonic counter for collision-safe callback bubble IDs */
let cbSeq = 0;
// F173 a2a-handoff bug fix (cloud Codex R2 P2-2): monotonic suffix to prevent
// id collisions when two same-ms handoff events from the same cat arrive.
// Background path uses options.nextBgSeq for the same purpose.
let activeA2AHandoffSeq = 0;
function nextActiveA2AHandoffSeq(): number {
  activeA2AHandoffSeq = (activeA2AHandoffSeq + 1) % 1_000_000;
  return activeA2AHandoffSeq;
}
const DEBUG_SKIP_FILE_CHANGE_UI = process.env.NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI === '1';

interface AgentMsg {
  type: string;
  catId: string;
  content?: string;
  textMode?: 'append' | 'replace';
  error?: string;
  /** Structured backend/provider error code. Some provider errors are recoverable mid-run. */
  errorCode?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string; usage?: import('../stores/chat-types').TokenUsage };
  /** Tool name (for 'tool_use' events from backend) */
  toolName?: string;
  /** Tool input params (for 'tool_use' events from backend) */
  toolInput?: Record<string, unknown>;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** Backend stored-message ID (set for callback post-message, used for rich_block correlation) */
  messageId?: string;
  /** F173 a2a-handoff bug fix: server-side timestamp (epoch ms). Required for
   *  timestamp-ordered insert of a2a_handoff system messages. */
  timestamp?: number;
  /** F67: Whether this message @mentions the co-creator */
  mentionsUser?: boolean;
  /** F52: Cross-thread origin metadata */
  extra?: { crossPost?: { sourceThreadId: string; sourceInvocationId?: string } };
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: ReplyPreview;
  /** F108: Invocation ID — distinguishes messages from concurrent invocations */
  invocationId?: string;
  /** F173 Phase E (KD-1 handler unification): handleAgentMessage 现在是 single dispatch
   *  entry，需要 threadId 区分 active vs background。useSocket 一直传 msg.threadId。 */
  threadId?: string;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function safeJsonPreview(value: unknown, maxLength: number): string {
  try {
    const raw = JSON.stringify(value);
    return truncate(raw, maxLength);
  } catch {
    return '[unserializable input]';
  }
}

function findLatestActiveInvocationIdForCat(
  activeInvocations: Record<string, { catId: string; mode: string }> | undefined,
  catId: string,
): string | undefined {
  if (!activeInvocations) return undefined;
  const entries = Object.entries(activeInvocations);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [invocationId, info] = entries[i]!;
    if (info.catId === catId) return invocationId;
  }
  return undefined;
}

function isRecoverableInFlightError(msg: { type: string; errorCode?: string; isFinal?: boolean }): boolean {
  if (msg.type !== 'error' || msg.isFinal === true) return false;
  return msg.errorCode === 'upstream_error' || msg.errorCode === 'tool_error';
}

export interface BackgroundAgentMessage {
  type: string;
  catId: string;
  threadId: string;
  content?: string;
  textMode?: 'append' | 'replace';
  messageId?: string;
  origin?: 'stream' | 'callback';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  /** Structured backend/provider error code. Some provider errors are recoverable mid-run. */
  errorCode?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string; usage?: TokenUsage };
  /** F52: Cross-thread origin metadata */
  extra?: { crossPost?: { sourceThreadId: string; sourceInvocationId?: string } };
  /** F057-C2: Whether this message mentions the user (@user / @铲屎官) */
  mentionsUser?: boolean;
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: { senderCatId: string | null; content: string; deleted?: true };
  /** F108: Invocation ID — distinguishes messages from concurrent invocations */
  invocationId?: string;
  timestamp: number;
}

export interface BackgroundStreamRef {
  id: string;
  threadId: string;
  catId: string;
}

export interface BackgroundToastInput {
  type: 'success' | 'error';
  title: string;
  message: string;
  threadId: string;
  duration: number;
}

export interface BackgroundStoreLike {
  addMessageToThread: (threadId: string, msg: ChatMessage) => void;
  removeThreadMessage: (threadId: string, messageId: string) => void;
  appendToThreadMessage: (threadId: string, messageId: string, content: string) => void;
  appendToolEventToThread: (threadId: string, messageId: string, event: ToolEvent) => void;
  /** F22: Append a rich block to a message in a specific thread */
  appendRichBlockToThread: (threadId: string, messageId: string, block: RichBlock) => void;
  setThreadCatInvocation: (threadId: string, catId: string, info: Partial<CatInvocationInfo>) => void;
  setThreadMessageMetadata: (threadId: string, messageId: string, metadata: ChatMessageMetadata) => void;
  setThreadMessageUsage: (threadId: string, messageId: string, usage: TokenUsage) => void;
  /** F045: Set or append extended thinking on an assistant message in a background thread */
  setThreadMessageThinking: (threadId: string, messageId: string, thinking: string) => void;
  /** F081: Persist stream invocation identity on background assistant bubbles */
  setThreadMessageStreamInvocation: (threadId: string, messageId: string, invocationId: string) => void;
  setThreadMessageStreaming: (threadId: string, messageId: string, streaming: boolean) => void;
  setThreadLoading: (threadId: string, loading: boolean) => void;
  setThreadHasActiveInvocation: (threadId: string, active: boolean) => void;
  /** F108: Add an active invocation slot to a thread */
  addThreadActiveInvocation: (threadId: string, invocationId: string, catId: string, mode: string) => void;
  /** F108: Remove an active invocation slot from a thread */
  removeThreadActiveInvocation: (threadId: string, invocationId: string) => void;
  updateThreadCatStatus: (threadId: string, catId: string, status: CatStatusType) => void;
  /** Batch content-append + metadata + streaming + catStatus into one set(). */
  batchStreamChunkUpdate: (params: {
    threadId: string;
    messageId: string;
    catId: string;
    content: string;
    metadata?: ChatMessageMetadata;
    streaming: boolean;
    catStatus: CatStatusType;
  }) => void;
  clearThreadActiveInvocation: (threadId: string) => void;
  getThreadState: (threadId: string) => ThreadState;
  replaceThreadTargetCats: (threadId: string, cats: string[]) => void;
  replaceThreadMessageId: (threadId: string, fromId: string, toId: string) => void;
  patchThreadMessage: (threadId: string, messageId: string, patch: ChatMessagePatch) => void;
}

export interface HandleBackgroundMessageOptions {
  store: BackgroundStoreLike;
  bgStreamRefs: Map<string, BackgroundStreamRef>;
  // F173 A.6 — `replacedInvocations` removed. It is now a shared module-level Map
  // (see `shared-replaced-invocations.ts`), accessed directly by both active and background
  // handlers, so suppression handoff works in both directions.
  nextBgSeq: () => number;
  addToast: (toast: BackgroundToastInput) => void;
  /** #80 fix-C: Clear the done-timeout guard when a background thread completes */
  clearDoneTimeout?: (threadId?: string) => void;
  /** #586 follow-up: Just-finalized stream bubble IDs keyed by streamKey */
  finalizedBgRefs: Map<string, string>;
}

export type ActiveRoutedAgentMessage = {
  type: string;
  catId: string;
  threadId?: string;
  isFinal?: boolean;
};

interface SystemInfoConsumeResult {
  consumed: boolean;
  content: string;
  variant: 'info' | 'a2a_followup';
}

function recoverBackgroundStreamingMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const streamKey = `${msg.threadId}::${msg.catId}`;
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const message = threadMessages[i];
    if (message.type === 'assistant' && message.catId === msg.catId && message.isStreaming) {
      options.bgStreamRefs.set(streamKey, { id: message.id, threadId: msg.threadId, catId: msg.catId });
      if (msg.metadata) {
        options.store.setThreadMessageMetadata(msg.threadId, message.id, msg.metadata);
      }
      return message.id;
    }
  }
  return undefined;
}

export function consumeBackgroundSystemInfo(
  msg: BackgroundAgentMessage,
  existingRef: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): SystemInfoConsumeResult {
  let sysContent = msg.content ?? '';
  let sysVariant: 'info' | 'a2a_followup' = 'info';
  let consumed = false;

  try {
    const parsed = JSON.parse(sysContent);
    const visible = formatVisibleSystemInfo(parsed);
    if (visible) {
      sysContent = visible.content;
      sysVariant = visible.variant;
    } else if (parsed?.type === 'invocation_created') {
      const targetCatId = parsed.catId ?? msg.catId;
      // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper invocationId
      // is the user-turn parent; parsed JSON content invocationId is inner auth child.
      // Prefer outer to keep bubble identity stable across stream/callback/done events
      // (otherwise active path gets `msg-outer-cat` and bg path gets `msg-inner-cat` →
      // dup bubble). thread_mogj6kvwp3l80x56 case.
      const invocationId =
        msg.invocationId ?? (typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined);
      // #586: Clear stale finalizedBgRef so previous invocation's finalized bubble
      // can't be overwritten by the next invocation's callback.
      const bgStreamKey = `${msg.threadId}::${targetCatId}`;
      options.finalizedBgRefs.delete(bgStreamKey);
      if (targetCatId && invocationId) {
        options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
          invocationId,
          startedAt: Date.now(),
          taskProgress: {
            tasks: [],
            lastUpdate: Date.now(),
            snapshotStatus: 'running',
            lastInvocationId: invocationId,
          },
        });
        const targetId = existingRef?.id ?? recoverBackgroundStreamingMessage(msg, options);
        if (targetId) {
          options.store.setThreadMessageStreamInvocation(msg.threadId, targetId, invocationId);
        }
        consumed = true;
      }
    } else if (parsed?.type === 'invocation_metrics') {
      if (parsed.kind === 'session_started') {
        // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer first to keep
        // catInvocations[catId].invocationId aligned with bubble identity.
        const sessionInvocationId =
          msg.invocationId ?? (typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined);
        options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
          sessionId: parsed.sessionId,
          invocationId: sessionInvocationId,
          startedAt: Date.now(),
          taskProgress: { tasks: [], lastUpdate: 0 },
          ...(parsed.sessionSeq !== undefined ? { sessionSeq: parsed.sessionSeq, sessionSealed: false } : {}),
        });
      } else if (parsed.kind === 'invocation_complete') {
        options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
          durationMs: parsed.durationMs,
          sessionId: parsed.sessionId,
        });
      }
      consumed = true;
    } else if (parsed?.type === 'invocation_usage') {
      options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
        usage: parsed.usage,
      });
      if (existingRef?.id) {
        options.store.setThreadMessageUsage(msg.threadId, existingRef.id, parsed.usage);
      }
      consumed = true;
    } else if (parsed?.type === 'context_briefing') {
      const storedMessage = parsed.storedMessage as
        | { id: string; content: string; origin: string; timestamp: number; extra?: Record<string, unknown> }
        | undefined;
      if (storedMessage?.id) {
        options.store.addMessageToThread(msg.threadId, {
          id: storedMessage.id,
          type: 'system',
          content: storedMessage.content ?? '',
          origin: (storedMessage.origin as 'briefing') ?? 'briefing',
          timestamp: storedMessage.timestamp ?? Date.now(),
          ...(storedMessage.extra ? { extra: storedMessage.extra } : {}),
        });
        consumed = true;
      }
    } else if (parsed?.type === 'context_health') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        contextHealth: parsed.health,
      });
      consumed = true;
    } else if (parsed?.type === 'rate_limit') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        rateLimit: {
          ...(typeof parsed.utilization === 'number' ? { utilization: parsed.utilization } : {}),
          ...(typeof parsed.resetsAt === 'string' ? { resetsAt: parsed.resetsAt } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'compact_boundary') {
      const targetCatId = parsed.catId ?? msg.catId;
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        compactBoundary: {
          ...(typeof parsed.preTokens === 'number' ? { preTokens: parsed.preTokens } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'task_progress') {
      const targetCatId = parsed.catId ?? msg.catId;
      // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer first so
      // taskProgress.lastInvocationId stays consistent with bubble identity.
      const currentInvocationId =
        msg.invocationId ??
        (typeof parsed.invocationId === 'string'
          ? parsed.invocationId
          : options.store.getThreadState(msg.threadId).catInvocations[targetCatId]?.invocationId);
      const tasks = (parsed.tasks ?? []) as TaskProgressItem[];
      options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
        taskProgress: {
          tasks,
          lastUpdate: Date.now(),
          snapshotStatus: 'running',
          ...(currentInvocationId ? { lastInvocationId: currentInvocationId } : {}),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'web_search') {
      // F045: web_search tool event (privacy: no query, count only) — render as ToolEvent, not raw JSON
      const count = typeof parsed.count === 'number' ? parsed.count : 1;
      let targetId = existingRef?.id;
      if (!targetId) {
        targetId = recoverBackgroundStreamingMessage(msg, options);
      }
      if (!targetId) {
        // Create placeholder assistant bubble if needed (mirrors thinking path)
        const streamKey = `${msg.threadId}::${msg.catId}`;
        targetId = `bg-web-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
        const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
        options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          timestamp: msg.timestamp,
          isStreaming: true,
          origin: 'stream',
        });
      }

      options.store.appendToolEventToThread(msg.threadId, targetId, {
        id: `bg-web-search-${msg.timestamp}-${options.nextBgSeq()}`,
        type: 'tool_use',
        label: `${msg.catId} → web_search${count > 1 ? ` x${count}` : ''}`,
        timestamp: msg.timestamp,
      });
      consumed = true;
    } else if (parsed?.type === 'rich_block') {
      // F22: Append rich block — mirror foreground path (useAgentMessages.ts)
      let targetId: string | undefined;

      // Prefer messageId correlation from callback post-message path
      if (parsed.messageId) {
        const found = options.store
          .getThreadState(msg.threadId)
          .messages.find((m: { id: string }) => m.id === parsed.messageId);
        if (found) targetId = found.id;
      }

      // Fallback: most recent callback message from this cat
      if (!targetId) {
        const threadMessages = options.store.getThreadState(msg.threadId).messages;
        for (let i = threadMessages.length - 1; i >= 0; i--) {
          const m = threadMessages[i];
          if (m.type !== 'assistant' || m.catId !== msg.catId) continue;
          if (m.origin === 'stream' && m.isStreaming) break;
          if (m.origin === 'callback') {
            targetId = m.id;
            break;
          }
        }
      }

      // Final fallback: recover active stream bubble or create placeholder
      if (!targetId) {
        targetId = existingRef?.id ?? recoverBackgroundStreamingMessage(msg, options);
      }
      if (!targetId) {
        // No existing bubble — create placeholder (mirrors foreground ensureActiveAssistantMessage)
        const streamKey = `${msg.threadId}::${msg.catId}`;
        targetId = `bg-rich-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
        const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
        options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          timestamp: msg.timestamp,
          isStreaming: true,
          origin: 'stream',
        });
      }

      if (parsed.block) {
        options.store.appendRichBlockToThread(msg.threadId, targetId, parsed.block);
      }
      consumed = true;
    } else if (parsed?.type === 'liveness_warning') {
      // F118 Phase C: Liveness warning — update cat status + invocation snapshot (mirror foreground)
      const level = parsed.level as 'alive_but_silent' | 'suspected_stall';
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, level);
      options.store.setThreadCatInvocation(msg.threadId, msg.catId, {
        livenessWarning: {
          level,
          state: parsed.state as 'active' | 'busy-silent' | 'idle-silent' | 'dead',
          silenceDurationMs: parsed.silenceDurationMs as number,
          cpuTimeMs: typeof parsed.cpuTimeMs === 'number' ? parsed.cpuTimeMs : undefined,
          processAlive: parsed.processAlive as boolean,
          receivedAt: Date.now(),
        },
      });
      consumed = true;
    } else if (parsed?.type === 'timeout_diagnostics') {
      // F118 AC-C3: Timeout diagnostics — consume silently in background threads.
      // Foreground uses pendingTimeoutDiagRef (React ref) to attach to error messages;
      // background threads don't have that mechanism, so we just suppress the raw JSON.
      consumed = true;
    } else if (parsed?.type === 'governance_blocked') {
      const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
      const reasonKind = (parsed.reasonKind as string) ?? 'needs_bootstrap';
      const invId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
      const threadMessages = options.store.getThreadState(msg.threadId).messages;
      const existing = threadMessages.find(
        (m: { variant?: string; extra?: { governanceBlocked?: { projectPath?: string } } }) =>
          m.variant === 'governance_blocked' && m.extra?.governanceBlocked?.projectPath === projectPath,
      );
      if (existing) {
        options.store.removeThreadMessage(msg.threadId, existing.id);
      }
      options.store.addMessageToThread(msg.threadId, {
        id: `gov-blocked-${msg.timestamp}-${options.nextBgSeq()}`,
        type: 'system',
        variant: 'governance_blocked',
        content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
        timestamp: msg.timestamp,
        extra: {
          governanceBlocked: {
            projectPath,
            reasonKind: reasonKind as 'needs_bootstrap' | 'needs_confirmation' | 'files_missing',
            invocationId: invId,
          },
        },
      });
      consumed = true;
    } else if (parsed?.type === 'strategy_allow_compress' || parsed?.type === 'resume_failure_stats') {
      // Internal telemetry — suppress to avoid raw JSON bubbles in background threads
      consumed = true;
    } else if (parsed?.type === 'session_seal_requested') {
      if (parsed.catId) {
        options.store.setThreadCatInvocation(msg.threadId, parsed.catId, {
          sessionSeq: parsed.sessionSeq,
          sessionSealed: true,
        });
        const pct = parsed.healthSnapshot?.fillRatio ? Math.round(parsed.healthSnapshot.fillRatio * 100) : '?';
        sysContent = `${parsed.catId} 的会话 #${parsed.sessionSeq} 已封存（上下文 ${pct}%），下次调用将自动创建新会话`;
      }
    } else if (parsed?.type === 'mode_switch_proposal') {
      const by = parsed.proposedBy ?? '猫猫';
      sysContent = `${by} 提议切换到 ${parsed.proposedMode} 模式。`;
    } else if (parsed?.type === 'silent_completion') {
      // Bugfix: silent-exit — cat ran tools but produced no text response
      const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
      sysContent = detail || `${msg.catId} completed without a text response.`;
    } else if (parsed?.type === 'invocation_preempted') {
      // Bugfix: silent-exit — invocation was superseded by a newer request
      sysContent = 'This response was superseded by a newer request.';
    } else if (parsed?.type === 'thinking') {
      // F045: Embed thinking into the assistant bubble (matches foreground path)
      const thinkingText = parsed.text ?? '';
      if (thinkingText) {
        let targetId = existingRef?.id;
        if (!targetId) {
          targetId = recoverBackgroundStreamingMessage(msg, options);
        }
        if (!targetId) {
          // Thinking arrived before any text/tool chunk — create placeholder assistant bubble
          const streamKey = `${msg.threadId}::${msg.catId}`;
          targetId = `bg-think-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
          const invocationId = options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.invocationId;
          options.bgStreamRefs.set(streamKey, { id: targetId, threadId: msg.threadId, catId: msg.catId });
          options.store.addMessageToThread(msg.threadId, {
            id: targetId,
            type: 'assistant',
            catId: msg.catId,
            content: '',
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
            timestamp: msg.timestamp,
            isStreaming: true,
            origin: 'stream',
          });
        }
        options.store.setThreadMessageThinking(msg.threadId, targetId, thinkingText);
      }
      consumed = true;
    }
  } catch {
    // Not JSON; keep original content as user-facing system info.
  }

  return { consumed, content: sysContent, variant: sysVariant };
}

const BACKGROUND_STATUS_MAP: Record<string, CatStatusType> = {
  streaming: 'streaming',
  thinking: 'pending',
  done: 'done',
};

function getStreamKey(msg: Pick<BackgroundAgentMessage, 'threadId' | 'catId'>): string {
  return `${msg.threadId}::${msg.catId}`;
}

function shouldClearBackgroundRefOnActiveEvent(msg: ActiveRoutedAgentMessage): boolean {
  if (!msg.threadId) return false;
  if (msg.type === 'done') return true;
  if (msg.type === 'error') return msg.isFinal === true;
  if (msg.type === 'text' && msg.isFinal) return true;
  return false;
}

function getThreadInvocationId(
  msg: Pick<BackgroundAgentMessage, 'threadId' | 'catId'>,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const threadState = options.store.getThreadState(msg.threadId);
  return (
    threadState.catInvocations[msg.catId]?.invocationId ??
    findLatestActiveInvocationIdForCat(threadState.activeInvocations, msg.catId)
  );
}

export function clearBackgroundStreamRefForActiveEvent(
  msg: ActiveRoutedAgentMessage,
  bgStreamRefs: Map<string, BackgroundStreamRef>,
): void {
  if (!shouldClearBackgroundRefOnActiveEvent(msg) || !msg.threadId) return;
  bgStreamRefs.delete(`${msg.threadId}::${msg.catId}`);
}

function stopTrackedStream(
  streamKey: string,
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): BackgroundStreamRef | undefined {
  const existing = options.bgStreamRefs.get(streamKey);
  if (!existing) return undefined;
  options.store.setThreadMessageStreaming(msg.threadId, existing.id, false);
  // #586 follow-up: Record finalized bubble ID so callback can find it
  // after bgStreamRefs is cleared and isStreaming is false.
  options.finalizedBgRefs.set(streamKey, existing.id);
  options.bgStreamRefs.delete(streamKey);
  return existing;
}

function addBackgroundSystemMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
  content: string,
  variant: 'info' | 'a2a_followup' = 'info',
  extra?: { systemKind?: 'a2a_routing' },
): void {
  options.store.addMessageToThread(msg.threadId, {
    id: `bg-sys-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
    type: 'system',
    variant,
    catId: msg.catId,
    content,
    timestamp: msg.timestamp,
    ...(extra ? { extra } : {}),
  });
}

/**
 * Recover an existing streaming assistant message from the thread state.
 * This handles the active→background transition: when the user switches threads,
 * activeRefs are cleared but the streaming message still exists in the store.
 * Instead of creating a duplicate bubble, we adopt the existing one into bgStreamRefs.
 */
function recoverStreamingMessage(
  msg: BackgroundAgentMessage,
  streamKey: string,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const m = threadMessages[i];
    if (m.type === 'assistant' && m.catId === msg.catId && m.isStreaming) {
      options.bgStreamRefs.set(streamKey, { id: m.id, threadId: msg.threadId, catId: msg.catId });
      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: msg.threadId,
        timestamp: msg.timestamp,
        action: 'recover',
        reason: 'background_ref_lost',
        catId: msg.catId,
        messageId: m.id,
        invocationId: m.extra?.stream?.invocationId,
        origin: 'stream',
      });
      return m.id;
    }
  }
  return undefined;
}

function findBackgroundCallbackReplacementTarget(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): { id: string; invocationId: string | null } | null {
  const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);

  const threadMessages = options.store.getThreadState(msg.threadId).messages;

  // Try invocationId-based match first
  if (invocationId) {
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (
        m?.type === 'assistant' &&
        m.catId === msg.catId &&
        m.origin === 'stream' &&
        m.extra?.stream?.invocationId === invocationId
      ) {
        return { id: m.id, invocationId };
      }
    }
  }

  // #586 Bug 1: Fallback — find invocationless stream placeholder from the same cat.
  // Background system-info creates bg-rich/bg-think placeholders without invocationId;
  // without this fallback, callback creates a duplicate bubble alongside the placeholder.
  // #586 P1-2 fix: Return real invocationId (may be null) — callers must guard
  // against null before writing to replacedInvocations. Using a pseudo ID would
  // cause shouldSuppressLateBackgroundStreamChunk to permanently drop future
  // invocationless stream chunks.
  // First pass: actively-streaming invocationless placeholder
  for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
    const m = threadMessages[i];
    if (
      m?.type === 'assistant' &&
      m.catId === msg.catId &&
      m.origin === 'stream' &&
      m.isStreaming &&
      !m.extra?.stream?.invocationId
    ) {
      return { id: m.id, invocationId: invocationId ?? null };
    }
  }
  // #586 follow-up: Check finalizedBgRefs — the done handler records the exact
  // message ID of the just-finalized stream bubble. This avoids the greedy scan
  // that could match arbitrary historical messages (P1 from review).
  const streamKey = `${msg.threadId}::${msg.catId}`;
  const finalizedId = options.finalizedBgRefs.get(streamKey);
  if (finalizedId) {
    const finalized = threadMessages.find(
      (m) => m.id === finalizedId && m.type === 'assistant' && m.catId === msg.catId && m.origin === 'stream',
    );
    if (finalized) {
      return { id: finalized.id, invocationId: invocationId ?? null };
    }
  }

  return null;
}

function shouldSuppressLateBackgroundStreamChunk(
  msg: BackgroundAgentMessage,
  _streamKey: string,
  options: HandleBackgroundMessageOptions,
): boolean {
  // F173 A.6 — read shared module Map (cross-handler suppression source of truth).
  // Cloud P2 (PR#1352): membership check against replaced Set (multi-value).
  if (msg.invocationId) {
    if (isInvocationReplaced(msg.threadId, msg.catId, msg.invocationId)) {
      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: msg.threadId,
        timestamp: msg.timestamp,
        action: 'drop',
        reason: 'late_stream_after_callback_replace',
        catId: msg.catId,
        invocationId: msg.invocationId,
        origin: 'stream',
      });
      return true;
    }
    // Cloud P1#6 (PR#1352): fresh explicit invocationId — clean stale catInvocations
    // entry from replaced set so subsequent invocationless follow-ups aren't mis-suppressed.
    const stale = getThreadInvocationId(msg, options);
    if (stale && stale !== msg.invocationId && isInvocationReplaced(msg.threadId, msg.catId, stale)) {
      removeReplacedInvocation(msg.threadId, msg.catId, stale);
    }
    return false;
  }
  // Invocationless: fall back to thread-level inv (preserves drop-late-after-replace
  // semantics for fresh same-inv chunks). Fail-open if no signal.
  const fallbackInv = getThreadInvocationId(msg, options);
  if (!fallbackInv) return false;
  if (!isInvocationReplaced(msg.threadId, msg.catId, fallbackInv)) return false;

  recordDebugEvent({
    event: 'bubble_lifecycle',
    threadId: msg.threadId,
    timestamp: msg.timestamp,
    action: 'drop',
    reason: 'late_stream_after_callback_replace',
    catId: msg.catId,
    invocationId: fallbackInv,
    origin: 'stream',
  });
  return true;
}

function ensureBackgroundAssistantMessage(
  msg: BackgroundAgentMessage,
  streamKey: string,
  existing: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): string {
  if (existing?.id) {
    if (msg.metadata) {
      options.store.setThreadMessageMetadata(msg.threadId, existing.id, msg.metadata);
    }
    return existing.id;
  }

  // Active→background transition recovery: find existing streaming bubble
  const recoveredId = recoverStreamingMessage(msg, streamKey, options);
  if (recoveredId) {
    if (msg.metadata) {
      options.store.setThreadMessageMetadata(msg.threadId, recoveredId, msg.metadata);
    }
    return recoveredId;
  }

  // F173 A.3 — invocationId from event payload first; fallback to stale thread state.
  const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
  const messageId = deriveBubbleId(
    invocationId,
    msg.catId,
    () => `bg-tool-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
  );
  options.bgStreamRefs.set(streamKey, { id: messageId, threadId: msg.threadId, catId: msg.catId });
  options.store.addMessageToThread(msg.threadId, {
    id: messageId,
    type: 'assistant',
    catId: msg.catId,
    content: '',
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
    ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
    timestamp: msg.timestamp,
    isStreaming: true,
    origin: 'stream',
  });
  return messageId;
}

function markThreadInvocationActive(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions): void {
  const threadState = options.store.getThreadState(msg.threadId);
  if (!threadState.isLoading) {
    options.store.setThreadLoading(msg.threadId, true);
  }
  // F108: slot-aware — register specific invocation if ID available
  if (msg.invocationId) {
    options.store.addThreadActiveInvocation(msg.threadId, msg.invocationId, msg.catId, 'execute');
  } else if (!threadState.hasActiveInvocation) {
    options.store.setThreadHasActiveInvocation(msg.threadId, true);
  }
}

function markThreadInvocationComplete(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions): void {
  options.store.setThreadLoading(msg.threadId, false);
  options.store.setThreadCatInvocation(msg.threadId, msg.catId, { invocationId: undefined });

  // Snapshot slot count before removal to detect actual transition to zero.
  const stateBefore = options.store.getThreadState(msg.threadId);
  const slotsBefore = Object.keys(stateBefore.activeInvocations ?? {}).length;

  // F108: slot-aware — remove specific invocation if ID available.
  // Cancel fallback: find and remove only this cat's latest active slot to avoid
  // clearing other cats' slots during multi-cat concurrent dispatch.
  if (msg.invocationId) {
    // F869: Multi-cat slot-aware cleanup. Only remove the slot that belongs to
    // THIS cat (primary key or synthetic key), not another cat's slot.
    const primarySlot = stateBefore.activeInvocations[msg.invocationId];
    if (primarySlot?.catId === msg.catId) {
      options.store.removeThreadActiveInvocation(msg.threadId, msg.invocationId);
    }
    options.store.removeThreadActiveInvocation(msg.threadId, `${msg.invocationId}-${msg.catId}`);
    // Clean up hydrated-* placeholder slots from F5/reconnect.
    // Matches useAgentMessages.ts active-thread behavior: hydrated- slots are
    // always synthetic placeholders that should yield to real done events.
    const stateAfter = options.store.getThreadState(msg.threadId);
    const orphan = findLatestActiveInvocationIdForCat(stateAfter.activeInvocations, msg.catId);
    if (orphan?.startsWith('hydrated-')) {
      options.store.removeThreadActiveInvocation(msg.threadId, orphan);
    }
  } else {
    const catSlot = findLatestActiveInvocationIdForCat(stateBefore.activeInvocations, msg.catId);
    if (catSlot) {
      options.store.removeThreadActiveInvocation(msg.threadId, catSlot);
    } else {
      options.store.setThreadHasActiveInvocation(msg.threadId, false);
    }
  }

  // Fix: clear targetCats/catStatuses when the last tracked invocation ends.
  // Only fire when we actually transitioned from >0 to 0 slots — not when
  // there were never any tracked slots (e.g. legacy paths without activeInvocations).
  // Without this, stale cats accumulate via merge semantics in setThreadTargetCats,
  // causing the status panel to display the wrong cat after thread switch.
  if (slotsBefore > 0) {
    const slotsAfter = Object.keys(options.store.getThreadState(msg.threadId).activeInvocations ?? {}).length;
    if (slotsAfter === 0) {
      options.store.replaceThreadTargetCats(msg.threadId, []);
    }
  }
}

export function handleBackgroundAgentMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): void {
  const streamKey = getStreamKey(msg);
  const existing = options.bgStreamRefs.get(streamKey);

  if (msg.type === 'text' && msg.content) {
    const isCallbackText = msg.origin === 'callback';
    if (!isCallbackText) {
      markThreadInvocationActive(msg, options);
    }
    // Track the final message ID for toast preview (must capture before deleting bgStreamRefs)
    let finalMsgId: string | undefined;

    if (msg.origin === 'callback') {
      const replacementTarget = findBackgroundCallbackReplacementTarget(msg, options);
      if (replacementTarget) {
        const cbId = msg.messageId ?? replacementTarget.id;
        if (cbId !== replacementTarget.id) {
          options.store.replaceThreadMessageId(msg.threadId, replacementTarget.id, cbId);
        }
        options.store.patchThreadMessage(msg.threadId, cbId, {
          content: msg.content,
          origin: 'callback',
          isStreaming: false,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.extra?.crossPost ? { extra: { crossPost: msg.extra.crossPost } } : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
        });
        options.bgStreamRefs.delete(streamKey);
        // Consume finalized ref — callback successfully replaced
        options.finalizedBgRefs.delete(streamKey);
        // #586 P1-2 fix: Only set replacedInvocations when we have a real invocationId.
        // Fallback matches return null — writing a pseudo ID would permanently suppress
        // future invocationless stream chunks via shouldSuppressLateBackgroundStreamChunk.
        if (replacementTarget.invocationId) {
          // F173 A.6 — write to shared module so active handler also sees suppression on switch back.
          markReplacedInvocation(msg.threadId, msg.catId, replacementTarget.invocationId);
        }
        finalMsgId = cbId;
      } else {
        // F173 A.3 — server-issued messageId wins; otherwise derive from invocationId.
        const cbInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
        const cbId =
          msg.messageId ??
          deriveBubbleId(cbInvocationId, msg.catId, () => `bg-cb-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`);
        options.store.addMessageToThread(msg.threadId, {
          id: cbId,
          type: 'assistant',
          catId: msg.catId,
          content: msg.content,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.extra?.crossPost ? { extra: { crossPost: msg.extra.crossPost } } : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          timestamp: msg.timestamp,
          origin: 'callback',
        });
        // #586 Bug 1 (TD112): Callback created new bubble without finding a stream
        // placeholder. Mark invocation as replaced so late background stream chunks
        // are suppressed instead of spawning a duplicate bubble.
        const bgInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
        if (bgInvocationId) {
          // F173 A.6 — shared module Map.
          markReplacedInvocation(msg.threadId, msg.catId, bgInvocationId);
        }
        finalMsgId = cbId;
      }
    } else {
      if (shouldSuppressLateBackgroundStreamChunk(msg, streamKey, options)) {
        return;
      }
      // CLI stream text (thinking): merge into existing stream bubble
      let messageId = existing?.id;
      // Active→background transition recovery: find existing streaming bubble
      if (!messageId) {
        messageId = recoverStreamingMessage(msg, streamKey, options);
      }
      if (messageId) {
        if (msg.textMode === 'replace') {
          options.store.patchThreadMessage(msg.threadId, messageId, {
            content: msg.content,
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            isStreaming: !msg.isFinal,
          });
          options.store.updateThreadCatStatus(msg.threadId, msg.catId, msg.isFinal ? 'done' : 'streaming');
        } else {
          // HOT PATH: batch content + metadata + streaming + catStatus into ONE set()
          // to prevent React update-depth overflow during high-frequency streaming.
          options.store.batchStreamChunkUpdate({
            threadId: msg.threadId,
            messageId,
            catId: msg.catId,
            content: msg.content,
            metadata: msg.metadata,
            streaming: !msg.isFinal,
            catStatus: msg.isFinal ? 'done' : 'streaming',
          });
        }
        if (msg.replyTo || msg.replyPreview) {
          options.store.patchThreadMessage(msg.threadId, messageId, {
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          });
        }
        if (msg.isFinal) {
          options.bgStreamRefs.delete(streamKey);
        }
      } else {
        // F173 A.3 — invocationId from event payload first (eliminates stale-state ghost).
        const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
        messageId = deriveBubbleId(
          invocationId,
          msg.catId,
          () => `bg-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
        );
        options.bgStreamRefs.set(streamKey, { id: messageId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: messageId,
          type: 'assistant',
          catId: msg.catId,
          content: msg.content,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          timestamp: msg.timestamp,
          isStreaming: !msg.isFinal,
          origin: 'stream',
        });
        // Cat status for new message (not batched — fires once per stream start)
        options.store.updateThreadCatStatus(msg.threadId, msg.catId, msg.isFinal ? 'done' : 'streaming');
        if (msg.isFinal) {
          options.bgStreamRefs.delete(streamKey);
        }
      }

      finalMsgId = messageId;
    }

    // Callback-only: update cat status on isFinal (non-callback handled by batch/new-message above)
    if (isCallbackText && msg.isFinal) {
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
    }
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard for text(isFinal) path
      options.clearDoneTimeout?.(msg.threadId);
      const finalMessage = finalMsgId
        ? options.store.getThreadState(msg.threadId).messages.find((m) => m.id === finalMsgId)
        : undefined;
      const preview = finalMessage?.content ?? msg.content;
      markThreadInvocationComplete(msg, options);
      options.addToast({
        type: 'success',
        title: `${msg.catId} 完成`,
        message: preview.slice(0, 80) + (preview.length > 80 ? '...' : ''),
        threadId: msg.threadId,
        duration: 5000,
      });
    }
    return;
  }

  if (msg.type === 'error') {
    const recoverableInFlightError = isRecoverableInFlightError(msg);
    markThreadInvocationActive(msg, options);
    if (!recoverableInFlightError) {
      stopTrackedStream(streamKey, msg, options);
    }
    options.store.addMessageToThread(msg.threadId, {
      id: `bg-err-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
      type: 'system',
      variant: 'error',
      catId: msg.catId,
      content: `Error: ${msg.error ?? 'Unknown error'}`,
      timestamp: msg.timestamp,
    });
    if (!recoverableInFlightError) {
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'error');
    }
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard for error(isFinal) path
      options.clearDoneTimeout?.(msg.threadId);
      markThreadInvocationComplete(msg, options);
    }
    options.addToast({
      type: 'error',
      title: `${msg.catId} 出错`,
      message: msg.error ?? 'Unknown error',
      threadId: msg.threadId,
      duration: 8000,
    });
    return;
  }

  if (msg.type === 'done') {
    stopTrackedStream(streamKey, msg, options);
    const currentStatus = options.store.getThreadState(msg.threadId).catStatuses[msg.catId];
    if (currentStatus !== 'error') {
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
      options.addToast({
        type: 'success',
        title: `${msg.catId} 完成`,
        message: `${msg.catId} 已完成处理`,
        threadId: msg.threadId,
        duration: 5000,
      });
    }
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard so it doesn't fire a false "timed out" message
      options.clearDoneTimeout?.(msg.threadId);
      markThreadInvocationComplete(msg, options);
    }
    return;
  }

  if (msg.type === 'status') {
    const mapped = BACKGROUND_STATUS_MAP[msg.content ?? ''] ?? 'streaming';
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, mapped);
    return;
  }

  if (msg.type === 'tool_use') {
    markThreadInvocationActive(msg, options);
    const toolName = msg.toolName ?? 'unknown';
    const detail = msg.toolInput ? safeJsonPreview(msg.toolInput, 200) : undefined;
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    options.store.appendToolEventToThread(msg.threadId, messageId, {
      id: `bg-tool-use-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_use',
      label: `${msg.catId} → ${toolName}`,
      ...(detail ? { detail } : {}),
      timestamp: msg.timestamp,
    });
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'tool_result') {
    markThreadInvocationActive(msg, options);
    const detail = compactToolResultDetail(msg.content ?? '');
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    options.store.appendToolEventToThread(msg.threadId, messageId, {
      id: `bg-tool-result-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_result',
      label: `${msg.catId} ← result`,
      detail,
      timestamp: msg.timestamp,
    });
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'system_info' || msg.type === 'a2a_handoff') {
    if (!msg.content) return;
    if (msg.type === 'a2a_handoff') {
      // F173 bug fix: routing pill needs systemKind marker so chatStore
      // inserts it at the right position vs. next cat's stream bubble.
      addBackgroundSystemMessage(msg, options, msg.content, 'info', { systemKind: 'a2a_routing' });
      return;
    }

    const result = consumeBackgroundSystemInfo(msg, existing, options);
    if (!result.consumed) {
      addBackgroundSystemMessage(msg, options, result.content, result.variant);
    }
  }
}

/**
 * Hook for handling agent message streaming (parallel-aware).
 * Tracks active streams via Map<catId, ref> for simultaneous multi-cat output.
 *
 * Returns:
 * - handleAgentMessage: socket event handler
 * - handleStop: cancel handler for stop button
 * - resetRefs: cleanup for thread switching
 */
export function useAgentMessages() {
  const {
    addMessage,
    appendToMessage,
    appendToolEvent,
    appendRichBlock,
    replaceMessageId,
    patchMessage,
    removeMessage,
    setStreaming,
    setLoading,
    setHasActiveInvocation,
    removeActiveInvocation,
    addActiveInvocation,
    clearAllActiveInvocations,
    setIntentMode,
    setCatStatus,
    clearCatStatuses,
    setCatInvocation,
    setMessageUsage,
    setMessageMetadata,
    setMessageThinking,
    setMessageStreamInvocation,
    requestStreamCatchUp,
    replaceThreadTargetCats,
  } = useChatStore();

  // F173 Phase E: bg-message processing refs (moved from useSocket).
  // useAgentMessages 现在是 single dispatch entry — 这些 refs 给 background-thread
  // delegation 用（handleBackgroundAgentMessage 内部的 stream key 追踪 / monotonic seq）。
  const bgStreamRefsRef = useRef<Map<string, { id: string; threadId: string; catId: string }>>(new Map());
  const bgFinalizedRefsRef = useRef<Map<string, string>>(new Map());
  const bgSeqRef = useRef(0);

  /**
   * F173 Phase B AC-B1 (integration step 4): activeRefs migrated to ledger.
   * Old `Map<catId, {id, catId}>` ref → ledger setActiveBubble keyed by
   * (threadId, catId). The wrappers below resolve threadId via useChatStore
   * and delegate to the ledger.
   *
   * `id` field is renamed to `messageId` in the ledger schema; for callback
   * shape compat we preserve the old field name in the iterator helper.
   */
  const setActive = useCallback((catId: string, messageId: string, invocationId?: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    setActiveBubbleLedger(getThreadRuntimeLedger(), tid, catId, {
      messageId,
      ...(invocationId ? { invocationId } : {}),
    });
  }, []);
  const getActive = useCallback((catId: string): { id: string; catId: string } | undefined => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return undefined;
    const entry = getActiveBubbleLedger(getThreadRuntimeLedger(), tid, catId);
    return entry ? { id: entry.messageId, catId } : undefined;
  }, []);
  const deleteActive = useCallback((catId: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    clearActiveBubbleLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);
  const getAllActiveValues = useCallback((): Iterable<{ id: string; catId: string }> => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return [];
    const out: { id: string; catId: string }[] = [];
    for (const [catId, entry] of getAllActiveBubblesForThreadLedger(getThreadRuntimeLedger(), tid)) {
      out.push({ id: entry.messageId, catId });
    }
    return out;
  }, []);
  const getActiveCount = useCallback((): number => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return 0;
    return getActiveBubbleCountLedger(getThreadRuntimeLedger(), tid);
  }, []);
  const clearAllActive = useCallback(() => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    clearAllActiveBubblesForThreadLedger(getThreadRuntimeLedger(), tid);
  }, []);
  // F173 A.6 — replacedInvocations is now a shared module-level Map (`shared-replaced-invocations.ts`).
  // Both active (this hook) and background (`useAgentMessages.ts`) handlers read/write the SAME Map,
  // keyed by `${threadId}::${catId}`, so suppression handoff works in BOTH directions
  // (background→active was patched in A.5; A.6 closes the active→background gap that 砚砚 P1-1 round 2 found).

  /**
   * Bug C P2: Track whether stream data was received per cat (avoids false
   * catch-up on callback-only flows).
   *
   * F173 Phase B AC-B1: migrated to thread-runtime-ledger singleton — state
   * is now keyed by (threadId, catId) instead of a hook-local Set<catId>.
   * The helpers below resolve threadId from `useChatStore.getState()` and
   * delegate to the ledger so call sites stay short.
   */
  const markSawStream = useCallback((catId: string, invocationId?: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    markStreamDataLedger(getThreadRuntimeLedger(), tid, catId, invocationId);
    // AC-B9: also record explicit observation when invocationId is present so
    // shouldSuppressLateStreamChunk can fall back to ledger-local state instead
    // of the global catInvocations Map (which can drift on F5/thread switch).
    if (invocationId) {
      markExplicitInvocationObservedLedger(getThreadRuntimeLedger(), tid, catId, invocationId);
    }
  }, []);
  const hadSawStream = useCallback((catId: string): boolean => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return false;
    return hadStreamDataLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);
  const clearSawStream = useCallback((catId: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    clearStreamDataLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);

  /**
   * F173 Phase B AC-B5: finalized bubble lookup migrated to ledger.
   * Old `Map<catId, messageId>` ref → ledger setFinalizedBubble with TTL.
   * TTL = FINALIZED_TTL_MS (5min) — generous callback merge window so a late
   * callback can still bridge to an already-finalized stream bubble.
   */
  const setFinalized = useCallback((catId: string, messageId: string, invocationId?: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    setFinalizedBubbleLedger(
      getThreadRuntimeLedger(),
      tid,
      catId,
      { messageId, ...(invocationId ? { invocationId } : {}) },
      FINALIZED_TTL_MS,
    );
  }, []);
  const getFinalized = useCallback((catId: string): string | undefined => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return undefined;
    return getFinalizedMessageIdLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);
  const clearFinalized = useCallback((catId: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    clearFinalizedLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);

  /**
   * F118 AC-C3: Pending timeout diagnostics keyed by (thread, cat).
   * F173 Phase B: migrated to ledger — was previously a top-level Map<catId>
   * that risked cross-thread mismatch on rapid switches.
   */
  const setPendingTimeoutDiag = useCallback((catId: string, diag: Record<string, unknown>) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    setPendingTimeoutDiagLedger(getThreadRuntimeLedger(), tid, catId, diag);
  }, []);
  const getPendingTimeoutDiag = useCallback((catId: string): Record<string, unknown> | null => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return null;
    return getPendingTimeoutDiagLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);
  const clearPendingTimeoutDiag = useCallback((catId: string) => {
    const tid = useChatStore.getState().currentThreadId;
    if (!tid) return;
    clearPendingTimeoutDiagLedger(getThreadRuntimeLedger(), tid, catId);
  }, []);

  /** Timeout ref for done(isFinal) reachability */
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which thread the current timeout guard belongs to */
  const timeoutThreadRef = useRef<string | null>(null);

  /** Start or reset the done timeout */
  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    const timeoutThreadId = useChatStore.getState().currentThreadId;
    timeoutThreadRef.current = timeoutThreadId;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
      const store = useChatStore.getState();
      const isActiveThreadTimeout = store.currentThreadId === timeoutThreadId;

      if (!isActiveThreadTimeout) {
        const threadState = store.getThreadState(timeoutThreadId);
        for (const message of threadState.messages) {
          if (message.type === 'assistant' && message.isStreaming) {
            store.setThreadMessageStreaming(timeoutThreadId, message.id, false);
          }
        }
        store.resetThreadInvocationState(timeoutThreadId);
        store.addMessageToThread(timeoutThreadId, {
          id: `sysinfo-timeout-${Date.now()}`,
          type: 'system',
          variant: 'info',
          content: '⏱ Response timed out. The operation may still be running in the background.',
          timestamp: Date.now(),
        });
        if (timeoutThreadId) {
          store.requestStreamCatchUp(timeoutThreadId);
        }
        return;
      }

      // Timeout fired — stop loading and show system message
      setLoading(false);
      clearAllActiveInvocations();
      setIntentMode(null);
      clearCatStatuses();
      for (const ref of getAllActiveValues()) {
        setStreaming(ref.id, false);
      }
      clearAllActive();
      addMessage({
        id: `sysinfo-timeout-${Date.now()}`,
        type: 'system',
        variant: 'info',
        content: '⏱ Response timed out. The operation may still be running in the background.',
        timestamp: Date.now(),
      });
      if (timeoutThreadId) {
        store.requestStreamCatchUp(timeoutThreadId);
      }
    }, DONE_TIMEOUT_MS);
  }, [
    setLoading,
    clearAllActiveInvocations,
    setIntentMode,
    clearCatStatuses,
    getAllActiveValues,
    setStreaming,
    clearAllActive,
    addMessage,
  ]);

  /** Clear the timeout (called on done with isFinal) */
  const clearDoneTimeout = useCallback((threadId?: string) => {
    if (threadId && timeoutThreadRef.current && timeoutThreadRef.current !== threadId) {
      return;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      timeoutThreadRef.current = null;
    },
    [],
  );

  const getCurrentInvocationStateForCat = useCallback(
    (catId: string): { invocationId?: string; source: 'catInvocations' | 'activeInvocations' | 'none' } => {
      const state = useChatStore.getState();
      const direct = state.catInvocations?.[catId]?.invocationId;
      if (direct) {
        return { invocationId: direct, source: 'catInvocations' };
      }
      const active = findLatestActiveInvocationIdForCat(state.activeInvocations, catId);
      if (active) {
        return { invocationId: active, source: 'activeInvocations' };
      }
      return { source: 'none' };
    },
    [],
  );

  const recordLateBindBubbleCreate = useCallback((catId: string, messageId: string, invocationId?: string) => {
    if (!invocationId) return;
    recordDebugEvent({
      event: 'bubble_lifecycle',
      threadId: useChatStore.getState().currentThreadId,
      timestamp: Date.now(),
      action: 'create',
      reason: 'active_late_bind',
      catId,
      messageId,
      invocationId,
      origin: 'stream',
    });
  }, []);

  const getCurrentInvocationIdForCat = useCallback(
    (catId: string): string | undefined => {
      return getCurrentInvocationStateForCat(catId).invocationId;
    },
    [getCurrentInvocationStateForCat],
  );

  /**
   * Stale terminal event guard (Bug-G, shared by `done` + `error`):
   * Returns true when `msgInvocationId` identifies an older invocation than the
   * one this cat is currently executing. Used to skip bubble/cat side effects
   * for late arrivals that would otherwise terminate a newer invocation's bubble.
   *
   * Resolution order (latest real slot → catInvocations direct):
   * 1. `activeInvocations` latest slot for catId, EXCLUDING synthetic
   *    `hydrated-${threadId}-${catId}` keys from reconnect reconciliation
   *    (cloud R7: hydrated slots do not represent a real in-flight invocation
   *    and must yield to a concrete direct binding).
   * 2. `catInvocations[catId].invocationId` as fallback.
   *
   * We prefer activeSlot over direct because `intent_mode` registers fresh
   * `activeInvocations[inv-2]` BEFORE the new `invocation_created` clears the
   * previous `catInvocations=inv-1`. A late `done/error(inv-1)` needs the
   * freshest signal to be marked stale.
   *
   * Slot key normalization: non-primary cats are registered as
   * `${invocationId}-${catId}` in activeInvocations (useSocket.ts), while
   * terminal events broadcast the bare parent `invocationId`. Strip the
   * `-${catId}` suffix before comparison so both key forms accept equivalently.
   *
   * Returns false when `msgInvocationId` is absent (we can't judge).
   * Returns true when resolved signal is undefined (no authoritative source →
   * can't prove the terminal event is for the current invocation → treat as
   * stale to avoid touching a newer bubble whose events were also lost).
   */
  const isStaleTerminalEvent = useCallback((catId: string, msgInvocationId: string | undefined): boolean => {
    if (!msgInvocationId) return false;
    const state = useChatStore.getState();
    const suffix = `-${catId}`;
    const normalize = (k: string | undefined): string | undefined =>
      k && k.endsWith(suffix) ? k.slice(0, -suffix.length) : k;

    // Hierarchical resolver with slot-fresh override (cloud R15 fix):
    //
    // Order matters because signals have different freshness profiles:
    //  - activeSlot (intent_mode): updates eagerly on every user-triggered
    //    invocation — freshest.
    //  - activeBinding / direct: updated by invocation_created — can lag if
    //    that event is lost over a flaky WS.
    //  - latest same-cat streaming bubble binding: reconnect fallback.
    //
    // Cloud R15 pathway: previous done(inv-1) lost → bubble.extra.stream.invocationId
    // still inv-1; user starts inv-2 → activeInvocations[inv-2] set; invocation_created
    // for inv-2 lost → bubble binding not updated. Real done(inv-2) arrives. Using
    // bubble binding as primary says STALE (inv-1 ≠ inv-2) → legitimate terminal
    // skipped.
    //
    // Fix: if activeSlot POSITIVELY confirms msg.invocationId, short-circuit to
    // not-stale FIRST. Bubble binding is still consulted for contradictions when
    // slot doesn't confirm (cloud R8 scenario: orphan slot + fresh bubble binding).
    let latestRealSlot: string | undefined;
    const activeEntries = Object.entries(state.activeInvocations ?? {});
    for (let i = activeEntries.length - 1; i >= 0; i--) {
      const [key, info] = activeEntries[i]!;
      if (info.catId !== catId) continue;
      if (key.startsWith('hydrated-')) continue;
      latestRealSlot = normalize(key);
      break;
    }
    if (latestRealSlot === msgInvocationId) return false; // slot-fresh override

    const activeRefId = getActive(catId)?.id;
    if (activeRefId) {
      const activeBubble = state.messages.find((m) => m.id === activeRefId);
      if (activeBubble?.type === 'assistant' && activeBubble.catId === catId) {
        const activeBinding = activeBubble.extra?.stream?.invocationId;
        if (activeBinding !== undefined) {
          return activeBinding !== msgInvocationId;
        }
      }
    }

    if (latestRealSlot !== undefined) {
      return latestRealSlot !== msgInvocationId;
    }

    const direct = state.catInvocations?.[catId]?.invocationId;
    if (direct !== undefined) {
      return direct !== msgInvocationId;
    }

    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.type !== 'assistant' || m.catId !== catId) continue;
      if (!m.isStreaming) continue;
      const bound = m.extra?.stream?.invocationId;
      if (bound !== undefined) {
        return bound !== msgInvocationId;
      }
      break;
    }

    return false;
  }, []);

  /**
   * AC-B10 wired into production: returns the structured TerminalDecision so
   * callers see source attribution, not just a boolean. Consults ledger first
   * (active bubble + replaced markers on explicit invocation) — falls back to
   * legacy `isStaleTerminalEvent` when ledger source is 'none'.
   *
   * Source values surface to logging:
   *   - explicit / active → ledger had POSITIVE signal and decided
   *   - none → ledger silent, decision delegated to legacy 4-source resolver
   */
  const decideTerminalEvent = useCallback(
    (catId: string, msgInvocationId: string | undefined): TerminalDecision => {
      const tid = useChatStore.getState().currentThreadId;
      if (tid) {
        const ledgerDecision = decideTerminalEventTargetLedger(getThreadRuntimeLedger(), tid, catId, msgInvocationId);
        // If ledger has explicit signal (anything except 'none'), trust it.
        if (ledgerDecision.source !== 'none') return ledgerDecision;
      }
      // Ledger silent → legacy 4-source resolver. Wrap its boolean in a decision
      // object so callers always get the same shape.
      const legacyStale = isStaleTerminalEvent(catId, msgInvocationId);
      return { stale: legacyStale, source: 'none' };
    },
    [isStaleTerminalEvent],
  );

  const maybeMigrateSequentialInvocationOwnership = useCallback(
    (nextCatId: string, invocationId: string) => {
      const store = useChatStore.getState();

      const activeInvocations = store.activeInvocations ?? {};
      const primarySlot = activeInvocations[invocationId];
      if (!primarySlot || primarySlot.catId === nextCatId) return;

      const hasExplicitNextCatSlot =
        Boolean(activeInvocations[`${invocationId}-${nextCatId}`]) ||
        Object.values(activeInvocations).some((slot) => slot.catId === nextCatId);
      if (hasExplicitNextCatSlot) return;

      // Serial handoff reuses the parent invocationId for follow-up cats. If the
      // previous cat's done(isFinal=false) is lost, the old primary slot would
      // stay pinned to the first cat forever. Rebind the slot at the moment the
      // next cat announces its invocation boundary so the eventual final done can
      // still clear the UI state.
      removeActiveInvocation(invocationId);
      addActiveInvocation(invocationId, nextCatId, primarySlot.mode, primarySlot.startedAt);

      const currentTargets = Array.isArray(store.targetCats) ? store.targetCats : [];
      if (store.currentThreadId && currentTargets.length === 1 && currentTargets[0] === primarySlot.catId) {
        replaceThreadTargetCats(store.currentThreadId, [nextCatId]);
      }
    },
    [addActiveInvocation, removeActiveInvocation, replaceThreadTargetCats],
  );

  const findRecoverableAssistantMessage = useCallback(
    (catId: string, explicitInvocationId?: string) => {
      // F173 hotfix (砚砚 4 件套 #1) — recovery MUST be identity-aware.
      // Old behavior: first pass matched any isStreaming=true bubble of this cat, which
      // allowed new invocation's chunks to append onto a previous invocation's bubble
      // whose done event was lost (the "ea0973e7 ghost" case at 2026-04-23 06:48).
      // New behavior:
      //   1) If we know the target invocationId (from event payload or active slot),
      //      match it exactly via extra.stream.invocationId.
      //   2) Otherwise, only adopt an UNBOUND placeholder (same cat, origin=stream,
      //      isStreaming=true, NO stream.invocationId). Bound-to-old-invocation
      //      bubbles are NEVER adopted — they must be finalized by invocation_created's
      //      rebind step, not silently mutated by a newer invocation's stream chunk.
      const currentMessages = useChatStore.getState().messages;
      const invocationId = explicitInvocationId ?? getCurrentInvocationIdForCat(catId);

      if (invocationId) {
        const lastFinalizedIdForCat = getFinalized(catId);
        // Cloud P1#4 (PR#1352): streaming-first preference. With explicit invocationId,
        // a newest→oldest scan could pick a non-streaming callback bubble before the
        // still-streaming placeholder for the same invocation, leaving the real bubble
        // open in done/error paths. Two passes — streaming match wins, non-streaming
        // is fallback (preserves hydration recovery from "replace hydration swaps" test).
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg.type !== 'assistant' || msg.catId !== catId) continue;
          if (msg.extra?.stream?.invocationId !== invocationId) continue;
          if (!msg.isStreaming) continue;
          return { id: msg.id, needsStreamingRestore: false };
        }
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg.type !== 'assistant' || msg.catId !== catId) continue;
          if (msg.extra?.stream?.invocationId !== invocationId) continue;
          // Cloud P1#3 (PR#1352) — reject bubbles this session's `done` has already
          // finalized. Hydration-loaded non-streaming bubbles (no finalizedStreamRef
          // entry) remain recoverable for the "replace hydration swaps" test.
          if (lastFinalizedIdForCat === msg.id) continue;
          return { id: msg.id, needsStreamingRestore: true };
        }
      }

      // Fallback: same-cat streaming bubble that's NOT bound to a different invocation.
      // (Origin is not checked — tests/hydration paths may omit it; the binding check
      // is the real safety gate against the ea0973e7 merge ghost.)
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (msg.type !== 'assistant' || msg.catId !== catId) continue;
        if (!msg.isStreaming) continue;
        if (msg.extra?.stream?.invocationId) continue; // bound to some invocation — never adopt
        return { id: msg.id, needsStreamingRestore: false };
      }

      return null;
    },
    [getCurrentInvocationIdForCat],
  );

  const findCallbackReplacementTarget = useCallback((catId: string, invocationId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    // Strict match only: exact invocationId. Do NOT adopt unbound placeholders —
    // per clowder-ai#305 absorb (2026-04-01) the placeholder may belong to a newer
    // invocation, and silently merging callback into it risks content mixing.
    // invocation_created's rebind step handles the unbound → bound transition.
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (
        msg?.type === 'assistant' &&
        msg.catId === catId &&
        msg.origin === 'stream' &&
        msg.extra?.stream?.invocationId === invocationId
      ) {
        return { id: msg.id };
      }
    }
    return null;
  }, []);

  const findInvocationlessStreamPlaceholder = useCallback((catId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    const activeId = getActive(catId)?.id;

    if (activeId) {
      const activeMessage = currentMessages.find(
        (msg) =>
          msg.id === activeId &&
          msg.type === 'assistant' &&
          msg.catId === catId &&
          msg.origin === 'stream' &&
          !msg.extra?.stream?.invocationId,
      );
      if (activeMessage) {
        return { id: activeMessage.id };
      }
    }

    // First pass: find actively-streaming invocationless bubble
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (
        msg?.type === 'assistant' &&
        msg.catId === catId &&
        msg.origin === 'stream' &&
        msg.isStreaming &&
        !msg.extra?.stream?.invocationId
      ) {
        return { id: msg.id };
      }
    }

    // #586 follow-up: Check finalizedStreamRef — the done handler records the
    // exact message ID of the just-finalized stream bubble. This avoids the
    // greedy scan that could match arbitrary historical messages (P1 from review).
    const finalizedId = getFinalized(catId);
    if (finalizedId) {
      const finalized = currentMessages.find(
        (m) => m.id === finalizedId && m.type === 'assistant' && m.catId === catId && m.origin === 'stream',
      );
      if (finalized) {
        return { id: finalized.id };
      }
    }

    return null;
  }, []);

  /**
   * Only reclaim rich/tool-only placeholders that have not started streaming text.
   *
   * Do not relax these guards:
   * - Drop `content.trim() === 0` and a stale callback can steal a newer live run's
   *   invocationless placeholder after real text already started streaming (#586-style regression).
   * - Drop the rich/tool guard and empty placeholders created by ensureActiveAssistantMessage
   *   can be reclaimed before their real callback lands, reintroducing split bubbles.
   */
  const findInvocationlessRichPlaceholder = useCallback((catId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    const isRichOrToolOnlyPlaceholder = (
      msg: (typeof currentMessages)[number] | undefined,
    ): msg is NonNullable<typeof msg> =>
      !!msg &&
      msg.type === 'assistant' &&
      msg.catId === catId &&
      msg.origin === 'stream' &&
      !msg.extra?.stream?.invocationId &&
      msg.content.trim().length === 0 &&
      ((msg.extra?.rich?.blocks.length ?? 0) > 0 || (msg.toolEvents?.length ?? 0) > 0);

    const activeId = getActive(catId)?.id;
    if (activeId) {
      const activeMessage = currentMessages.find((msg) => msg.id === activeId);
      if (isRichOrToolOnlyPlaceholder(activeMessage)) {
        return { id: activeMessage.id };
      }
    }

    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (isRichOrToolOnlyPlaceholder(msg)) {
        return { id: msg.id };
      }
    }

    return null;
  }, []);

  const getOrRecoverActiveAssistantMessageId = useCallback(
    (
      catId: string,
      metadata?: AgentMsg['metadata'],
      options?: { ensureStreaming?: boolean; invocationId?: string },
    ): string | null => {
      const currentMessages = useChatStore.getState().messages;
      const existing = getActive(catId);
      if (existing?.id) {
        const found = currentMessages.find((msg) => msg.id === existing.id && msg.type === 'assistant');
        if (found) {
          // F173 hotfix (砚砚 4 件套 #2) — identity-aware sticky: if caller passed an
          // explicit invocationId AND the active ref is bound to a DIFFERENT invocation,
          // the active ref is stale (previous invocation's bubble whose done was lost).
          // Drop it and fall through to identity-aware recovery.
          const boundInv = found.extra?.stream?.invocationId;
          if (options?.invocationId && boundInv && boundInv !== options.invocationId) {
            deleteActive(catId);
          } else {
            if (options?.ensureStreaming && !found.isStreaming) {
              setStreaming(found.id, true);
            }
            if (metadata) {
              setMessageMetadata(found.id, metadata);
            }
            return found.id;
          }
        } else {
          deleteActive(catId);
        }
      }

      const recovered = findRecoverableAssistantMessage(catId, options?.invocationId);
      if (!recovered) return null;

      setActive(catId, recovered.id);
      if (options?.ensureStreaming && recovered.needsStreamingRestore) {
        setStreaming(recovered.id, true);
      }
      if (metadata) {
        setMessageMetadata(recovered.id, metadata);
      }
      return recovered.id;
    },
    [findRecoverableAssistantMessage, setMessageMetadata, setStreaming],
  );

  const ensureActiveAssistantMessage = useCallback(
    (catId: string, metadata?: AgentMsg['metadata'], options?: { invocationId?: string }): string => {
      const existingId = getOrRecoverActiveAssistantMessageId(catId, metadata, {
        ensureStreaming: true,
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      });
      if (existingId) {
        return existingId;
      }

      // F173 hotfix (砚砚 4 件套 #2) — prefer explicit invocationId from event payload.
      // Cloud P2#2 (PR#1352): when no explicit invocationId, fall back to activeInvocations
      // (the FRESH signal — set by intent_mode UPSTREAM of invocation_created). Do NOT
      // fall back to catInvocations (lags invocation_created — that's the original
      // ea0973e7 trap). With activeInvocations binding, callback strict-match can correlate
      // even when invocation_created was missed; without it, split bubbles result.
      let invocationId = options?.invocationId;
      if (!invocationId) {
        const fallback = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, catId);
        if (fallback) invocationId = fallback;
      }
      const id = deriveBubbleId(invocationId, catId, () => `msg-${Date.now()}-${catId}`);
      setActive(catId, id, invocationId);
      addMessage({
        id,
        type: 'assistant',
        catId,
        content: '',
        origin: 'stream',
        ...(metadata ? { metadata } : {}),
        ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
        timestamp: Date.now(),
        isStreaming: true,
      });
      if (invocationId) {
        recordLateBindBubbleCreate(catId, id, invocationId);
      }
      return id;
    },
    [addMessage, getOrRecoverActiveAssistantMessageId, recordLateBindBubbleCreate],
  );

  const shouldSuppressLateStreamChunk = useCallback(
    (catId: string, invocationId?: string): boolean => {
      const tid = useChatStore.getState().currentThreadId;
      // Cloud P2 (PR#1352): membership check against replaced Set (multi-value).
      if (invocationId) {
        if (isInvocationReplaced(tid, catId, invocationId)) return true;
        // Cloud P1#6 (PR#1352): observing a fresh explicit invocationId that's NOT in
        // the replaced set means the cat moved on. catInvocations may still be stale
        // (prior done lost) — surgically remove the stale catInvocations value from the
        // replaced set so subsequent invocationless follow-ups don't get mis-suppressed
        // by the legacy fallback path below. We DON'T clear other replaced entries —
        // they're independently in-flight stale invocations that may still get late chunks.
        const stale = getCurrentInvocationIdForCat(catId);
        if (stale && stale !== invocationId && isInvocationReplaced(tid, catId, stale)) {
          removeReplacedInvocation(tid, catId, stale);
        }
        return false;
      }
      // AC-B9: ledger `lastObservedExplicit` supplements but does NOT replace
      // catInvocations. Cloud Codex P1 (2026-04-24): if inv-A is callback-replaced
      // and inv-B starts running, `lastObservedExplicit` may still point to
      // (replaced) inv-A while `catInvocations` already moved to inv-B. We must
      // prefer the FRESHER signal — catInvocations is updated by `invocation_created`
      // and is the source of truth for "what invocation is currently active for
      // this cat". Ledger ledger fallback only kicks in when catInvocations is
      // genuinely empty (cold start / cleared after done).
      const fallbackInv =
        getCurrentInvocationIdForCat(catId) ?? getLastObservedExplicitLedger(getThreadRuntimeLedger(), tid, catId);
      if (!fallbackInv) return false;
      if (!isInvocationReplaced(tid, catId, fallbackInv)) return false;

      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: tid,
        timestamp: Date.now(),
        action: 'drop',
        reason: 'late_stream_after_callback_replace',
        catId,
        invocationId: invocationId ?? fallbackInv,
        origin: 'stream',
      });
      return true;
    },
    [getCurrentInvocationIdForCat],
  );

  const handleAgentMessage = useCallback(
    (msg: AgentMsg) => {
      // F173 Phase E (KD-1 handler unification): single dispatch entry.
      // useSocket.ts 不再做 active vs background 路由 — 所有 agent_message 进这里。
      // 之前 useSocket.ts:485-534 的三段分发逻辑（malformed / active / bg）合并到此。
      const store = useChatStore.getState();
      const storeThread = store.currentThreadId;
      const isActiveThreadMessage = Boolean(msg.threadId && storeThread && msg.threadId === storeThread);

      if (msg.threadId && !isActiveThreadMessage) {
        // Background thread → delegate to handleBackgroundAgentMessage with bg refs.
        // Phase E Task 2-5 将把 bg 业务逻辑迁进来后删除此 import + 调用。
        handleBackgroundAgentMessage(msg as BackgroundAgentMessage, {
          store,
          bgStreamRefs: bgStreamRefsRef.current,
          finalizedBgRefs: bgFinalizedRefsRef.current,
          nextBgSeq: () => bgSeqRef.current++,
          addToast: (toast) => useToastStore.getState().addToast(toast),
          clearDoneTimeout,
        });
        return;
      }

      // Active thread (or malformed missing threadId) — F173 A.5 + A.6 bidirectional
      // suppression handoff. After callback replace (in either direction), late stream
      // chunks for that invocation are dropped; without this guard, store's hard-merge
      // by (catId, invocationId) would overwrite authoritative callback content.
      if (
        isActiveThreadMessage &&
        msg.type === 'text' &&
        msg.origin !== 'callback' &&
        msg.invocationId &&
        msg.threadId &&
        isInvocationReplaced(msg.threadId, msg.catId, msg.invocationId)
      ) {
        recordDebugEvent({
          event: 'agent_message',
          threadId: msg.threadId,
          action: 'drop_active_promotion_late_chunk',
          timestamp: Date.now(),
        });
        // Codex review P1 — clear bgStreamRefs even on dropped chunk so a later
        // background-handler reactivation (after thread switch away) doesn't reuse
        // a stale ref to append into an old bubble.
        clearBackgroundStreamRefForActiveEvent(msg as BackgroundAgentMessage, bgStreamRefsRef.current);
        return;
      }
      // Active path runs handleBackgroundAgentMessage's clearBg defensive cleanup
      // (matches useSocket.ts pre-Phase E behavior at lines 496/522 — clears stale
      // bg ref entries left from prior bg activations of the same stream key).
      if (msg.threadId) {
        clearBackgroundStreamRefForActiveEvent(msg as BackgroundAgentMessage, bgStreamRefsRef.current);
      }

      // Reset timeout on any message (keeps timer alive during streaming)
      resetTimeout();

      if (msg.type === 'text' && msg.content) {
        if (msg.origin !== 'callback' && shouldSuppressLateStreamChunk(msg.catId, msg.invocationId)) {
          return;
        }
        setCatStatus(msg.catId, 'streaming');
        // F118: Clear liveness warning when cat resumes output
        setCatInvocation(msg.catId, { livenessWarning: undefined });
        if (msg.origin !== 'callback') {
          markSawStream(msg.catId, msg.invocationId);
        }

        if (msg.origin === 'callback') {
          const invocationId = msg.invocationId ?? getCurrentInvocationIdForCat(msg.catId);
          const hasExplicitInvocationId = !!msg.invocationId;
          // Callback broadcasts now reliably carry invocationId (callbacks.ts #454),
          // but rich-block-only runs can still start with an invocationless stream
          // placeholder before the stream identity is bound. Otherwise one logical
          // response splits into a ghost stream bubble + formal callback bubble, and
          // the finalized ghost can survive F5 via client-side snapshots / IDB restore.
          //
          // ⚠️ DO NOT TOUCH the narrow guards in findInvocationlessRichPlaceholder:
          // - Drop `content.trim() === 0` and a stale callback can eat a different
          //   in-flight invocation's placeholder after text already started streaming.
          // - Drop the rich/tool guard and empty placeholders created by stream setup
          //   get reclaimed before the real callback arrives, re-splitting bubbles.
          // - Drop the stream.invocationId write-back below and F5 hydration loses
          //   the identity binding, letting the ghost bubble come back after refresh.
          const replacementTarget = invocationId
            ? (findCallbackReplacementTarget(msg.catId, invocationId) ?? findInvocationlessRichPlaceholder(msg.catId))
            : findInvocationlessStreamPlaceholder(msg.catId);

          if (replacementTarget) {
            const finalId = msg.messageId ?? replacementTarget.id;
            if (finalId !== replacementTarget.id) {
              replaceMessageId(replacementTarget.id, finalId);
            }
            const extraForPatch = {
              ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
              ...(hasExplicitInvocationId && msg.invocationId ? { stream: { invocationId: msg.invocationId } } : {}),
            };
            patchMessage(finalId, {
              content: msg.content,
              origin: 'callback',
              isStreaming: false,
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(Object.keys(extraForPatch).length > 0 ? { extra: extraForPatch } : {}),
              ...(msg.mentionsUser ? { mentionsUser: true } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
            });
            deleteActive(msg.catId);
            // Consume the finalized ref — callback successfully replaced the bubble
            clearFinalized(msg.catId);
            if (invocationId) {
              // F173 A.6 — write to shared module so background handler also sees the suppression
              // when user switches away after callback replace.
              markReplacedInvocation(useChatStore.getState().currentThreadId, msg.catId, invocationId);
            }
          } else {
            // Use backend messageId when available for rich_block correlation (#83 P2)
            // F173 A.3 — fallback uses deterministic id from invocationId so a later stream
            // recovery (after switching back) finds the same bubble instead of duplicating.
            const id =
              msg.messageId ??
              deriveBubbleId(invocationId, msg.catId, () => `msg-${Date.now()}-${msg.catId}-cb-${++cbSeq}`);
            const extraForAdd = {
              ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
              ...(hasExplicitInvocationId && msg.invocationId ? { stream: { invocationId: msg.invocationId } } : {}),
            };
            addMessage({
              id,
              type: 'assistant',
              catId: msg.catId,
              content: msg.content,
              origin: 'callback',
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(Object.keys(extraForAdd).length > 0 ? { extra: extraForAdd } : {}),
              ...(msg.mentionsUser ? { mentionsUser: true } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              timestamp: Date.now(),
            });
            // #586 Bug 1 (TD112): Callback created a new bubble because no stream
            // placeholder existed yet. Mark the invocation as replaced so that
            // late-arriving stream chunks for the same invocation are suppressed
            // instead of spawning a second bubble.
            //
            // F173 hotfix round 5 (砚砚 non-blocking observation): the prior condition
            // `(!hasExplicitInvocationId || getCurrentInvocationIdForCat === msg.invocationId)`
            // only marked when catInvocations/activeInvocations confirmed the explicit
            // invocationId. That breaks the "callback first + invocation_created lost + no
            // active slot" branch: getCurrentInvocationIdForCat returns undefined, the
            // condition becomes false, no mark, and the subsequent stream chunk appends
            // onto the finalized callback bubble via identity-aware recovery. Stale-callback
            // safety is already provided by `shouldSuppressLateStreamChunk`'s
            // different-invocationId clear path, so unconditional mark-on-any-invocationId
            // is both correct and complete here.
            if (invocationId) {
              // F173 A.6 — shared module Map; both handlers see this suppression.
              markReplacedInvocation(useChatStore.getState().currentThreadId, msg.catId, invocationId);
            }
          }
        } else {
          // CLI stream message (thinking): append to active stream bubble
          const messageId = getOrRecoverActiveAssistantMessageId(msg.catId, msg.metadata, {
            ensureStreaming: true,
            ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
          });
          if (messageId) {
            if (msg.textMode === 'replace') {
              patchMessage(messageId, { content: msg.content });
            } else {
              appendToMessage(messageId, msg.content);
            }
            if (msg.replyTo || msg.replyPreview) {
              patchMessage(messageId, {
                ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
                ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              });
            }
          } else {
            // New stream message for this cat.
            // F173 hotfix (砚砚 4 件套 #2) — prefer explicit msg.invocationId from event.
            // Cloud P1#8 (PR#1352): fall back to activeInvocations (the FRESH signal, set
            // by intent_mode UPSTREAM of invocation_created) when msg.invocationId is missing.
            // Do NOT fall back to catInvocations (lags invocation_created — original ea0973e7
            // trap). With activeInvocations binding, callback strict-match can correlate;
            // without any binding, mixed-delivery races produce duplicate ghost pairs.
            let invocationId = msg.invocationId;
            if (!invocationId) {
              const fallback = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
              if (fallback) invocationId = fallback;
            }
            const id = invocationId
              ? deriveBubbleId(invocationId, msg.catId, () => `msg-${Date.now()}-${msg.catId}`)
              : `msg-${Date.now()}-${msg.catId}`;
            setActive(msg.catId, id, invocationId);
            addMessage({
              id,
              type: 'assistant',
              catId: msg.catId,
              content: msg.content,
              origin: 'stream',
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              timestamp: Date.now(),
              isStreaming: true,
            });
          }
        }
      } else if (msg.type === 'tool_use') {
        // Cloud P1#3 (PR#1352): suppress stale tool_use for completed invocation.
        // Done handler markReplacedInvocation for msg.invocationId; this check drops
        // reordered events before they can collide with the deterministic bubble id.
        if (shouldSuppressLateStreamChunk(msg.catId, msg.invocationId)) return;
        setCatStatus(msg.catId, 'streaming');
        markSawStream(msg.catId, msg.invocationId);
        const toolName = msg.toolName ?? 'unknown';
        const detail = msg.toolInput ? safeJsonPreview(msg.toolInput, 200) : undefined;
        const isFileChange = toolName === 'file_change';
        if (isFileChange) {
          console.info('[agent_message] file_change tool_use received', {
            catId: msg.catId,
            activeRefCount: getActiveCount(),
            skipUi: DEBUG_SKIP_FILE_CHANGE_UI,
            detail: detail ?? null,
          });
          if (DEBUG_SKIP_FILE_CHANGE_UI) {
            console.warn('[agent_message] file_change UI append skipped', {
              catId: msg.catId,
              reason: 'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI=1',
            });
            return;
          }
        }

        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
          ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
        });

        appendToolEvent(messageId, {
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_use',
          label: `${msg.catId} → ${toolName}`,
          ...(detail ? { detail } : {}),
          timestamp: Date.now(),
        });
        if (isFileChange) {
          console.info('[agent_message] file_change tool_use appended', {
            catId: msg.catId,
            messageId,
            activeRefCount: getActiveCount(),
          });
        }
      } else if (msg.type === 'tool_result') {
        // Cloud P1#3 (PR#1352): see tool_use note — suppress stale tool_result.
        if (shouldSuppressLateStreamChunk(msg.catId, msg.invocationId)) return;
        setCatStatus(msg.catId, 'streaming');
        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
          ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
        });

        const detail = compactToolResultDetail(msg.content ?? '');
        appendToolEvent(messageId, {
          id: `toolr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_result',
          label: `${msg.catId} ← result`,
          detail,
          timestamp: Date.now(),
        });
      } else if (msg.type === 'done') {
        // Stale-terminal guard (Bug-G, shared with `error` via isStaleTerminalEvent):
        // A stale done must NOT touch cat-level or bubble-level state — doing so
        // terminates a newer invocation's bubble, clears its activeRef, and marks
        // the cat as done while the newer invocation is mid-flight. Only slot
        // cleanup for `msg.invocationId` is still safe (self-guarded below by
        // `primarySlot?.catId === msg.catId`).
        const doneDecision = decideTerminalEvent(msg.catId, msg.invocationId);
        const isStaleDone = doneDecision.stale;

        let messageId: string | null = null;
        if (!isStaleDone) {
          setCatStatus(msg.catId, 'done');
          const currentProgress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
          if (currentProgress?.tasks?.length) {
            setCatInvocation(msg.catId, {
              taskProgress: {
                ...currentProgress,
                snapshotStatus: currentProgress.snapshotStatus === 'interrupted' ? 'interrupted' : 'completed',
                lastUpdate: Date.now(),
              },
            });
          }
          messageId = getOrRecoverActiveAssistantMessageId(msg.catId, undefined, {
            ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
          });
          // Cloud R15 permissive fallback for terminal events: when strict identity-
          // aware recovery can't find a match but slot-fresh override confirmed this
          // terminal is legitimate, finalize the same-cat streaming bubble.
          //
          // Cloud P1#1: gate on `msg.invocationId` presence (no invocationless reach).
          // Cloud P1#7 (PR#1352): bubble-binding policy depends on confirmation source:
          //   - SLOT-FRESH confirmed (activeInvocations[msg.invocationId] for this cat):
          //     bubble's stale binding is unreliable (R15 reused-bubble scenario) →
          //     finalize ANY same-cat streaming bubble.
          //   - Only catInvocations / weaker signal confirmed: respect bubble binding
          //     (only finalize bubbles bound to msg.invocationId or unbound) — protects
          //     against late done(inv-1) closing a real inv-2 bubble.
          if (!messageId && msg.invocationId) {
            const slotFreshConfirmed = ((): boolean => {
              const s = useChatStore.getState();
              const suffix = `-${msg.catId}`;
              const normalize = (k: string | undefined): string | undefined =>
                k && k.endsWith(suffix) ? k.slice(0, -suffix.length) : k;
              const entries = Object.entries(s.activeInvocations ?? {});
              for (let i = entries.length - 1; i >= 0; i--) {
                const [key, info] = entries[i]!;
                if (info.catId !== msg.catId || key.startsWith('hydrated-')) continue;
                return normalize(key) === msg.invocationId;
              }
              return false;
            })();
            const permissive = useChatStore.getState().messages.findLast((m) => {
              if (m.type !== 'assistant' || m.catId !== msg.catId || !m.isStreaming) return false;
              if (slotFreshConfirmed) return true;
              const bound = m.extra?.stream?.invocationId;
              return !bound || bound === msg.invocationId;
            });
            if (permissive) {
              messageId = permissive.id;
            }
          }
          if (messageId) {
            setStreaming(messageId, false);
            // Bug-G: back-fill invocationId on bubbles that somehow missed the
            // invocation_created binding path (the primary handler at :789-802
            // already back-fills if invocation_created arrives; this is the
            // rare-race net). Safety already holds via the outer !isStaleDone
            // guard, which requires resolved === msg.invocationId when provided.
            if (msg.invocationId) {
              const finalized = useChatStore.getState().messages.find((m) => m.id === messageId);
              if (finalized && !finalized.extra?.stream?.invocationId) {
                setMessageStreamInvocation(messageId, msg.invocationId);
              }
            }
            // #586 follow-up: Record the finalized bubble so callback can find it
            // even after isStreaming=false + activeRefs cleared. Unlike a greedy
            // scan, this is scoped to the exact just-finalized message only.
            setFinalized(msg.catId, messageId, msg.invocationId);
            deleteActive(msg.catId);
            // Cloud P1#3 (PR#1352): mark the just-closed invocation as replaced so
            // that reordered / late non-terminal events (text / tool_use / tool_result
            // / web_search / thinking / rich_block) for the SAME invocationId are
            // suppressed by shouldSuppressLateStreamChunk instead of colliding with
            // the deterministic bubble id and re-opening the finalized bubble.
            if (msg.invocationId) {
              markReplacedInvocation(useChatStore.getState().currentThreadId, msg.catId, msg.invocationId);
            }
          }
          // Bugfix: clear stale invocationId so findRecoverableAssistantMessage
          // can't match this finalized message when the next invocation starts.
          // Without this, a race (new text before invocation_created) appends to
          // the old bubble, causing messages to visually merge until page refresh.
          // Cloud review P2: Do NOT clear taskProgress here — lines 552-559 already
          // transition it to 'completed'/'interrupted'. Wiping it would remove the
          // cat from PlanBoardPanel and defeat clearCatStatuses' snapshot preservation.
          setCatInvocation(msg.catId, { invocationId: undefined });
        }
        // Stale-done direct cleanup (cloud R12 P1): even when the bubble-side
        // processing was skipped as stale, we MUST still clear `catInvocations
        // [msg.catId].invocationId` when it matches `msg.invocationId` —
        // otherwise a stale `inv-1` survives in direct binding while
        // `activeInvocations` already holds the fresh `inv-2` slot, and
        // downstream `getCurrentInvocationStateForCat` (catInvocations-first)
        // would return the stale `inv-1` and misbind inv-2's first stream
        // bubble. Conditional on `direct === msg.invocationId` so we never
        // clobber a newer direct value set by the new invocation_created.
        if (
          isStaleDone &&
          msg.invocationId &&
          useChatStore.getState().catInvocations?.[msg.catId]?.invocationId === msg.invocationId
        ) {
          setCatInvocation(msg.catId, { invocationId: undefined });
        }
        // Always remove the finishing cat's invocation slot, regardless of isFinal.
        // isFinal=false means "more cats coming" but THIS cat is done — its slot must go.
        // Without this, non-final cats (e.g. 缅因猫 in 缅因猫→布偶猫 sequence) leave
        // orphan slots that keep ThreadExecutionBar showing "执行中" until F5 refresh.
        if (msg.invocationId) {
          const slotState = useChatStore.getState();
          const primarySlot = slotState.activeInvocations[msg.invocationId];
          if (primarySlot?.catId === msg.catId) {
            removeActiveInvocation(msg.invocationId);
          }
          removeActiveInvocation(`${msg.invocationId}-${msg.catId}`);
          // Hydrated synthetic IDs (hydrated-${threadId}-${catId}) won't match the real
          // invocationId from the server. Only clean up hydrated- prefixed orphans to
          // avoid accidentally deleting a NEW invocation's slot during same-cat preempt
          // (where old done arrives after new invocation starts).
          //
          // Stale-done P1 (砚砚 R10): in reconnect hydration the hydrated slot IS
          // the representation of the current in-flight invocation — don't sweep it
          // away on stale done. Gate on !isStaleDone.
          if (!isStaleDone) {
            const stateAfter = useChatStore.getState();
            const orphan = findLatestActiveInvocationIdForCat(stateAfter.activeInvocations, msg.catId);
            if (orphan?.startsWith('hydrated-')) {
              removeActiveInvocation(orphan);
            }
          }
        } else {
          const catSlot = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
          if (catSlot) {
            removeActiveInvocation(catSlot);
          } else if (Object.keys(useChatStore.getState().activeInvocations ?? {}).length === 0) {
            // Only reset global flag when no active invocations remain.
            // Without this guard, a non-final cat with no slot would incorrectly
            // clear hasActiveInvocation while other cats are still running.
            setHasActiveInvocation(false);
          }
        }
        if (msg.isFinal) {
          // F108 P1 fix: Only clear global state when the LAST active invocation ends.
          // During concurrent multi-cat execution, cancelling one cat must not wipe
          // the execution state (loading/intentMode/catStatuses) of remaining cats.
          //
          // Stale-done guard (cloud R14 P1): a stale done with isFinal=true must not
          // trigger global teardown — in reconnect/loss windows the live invocation
          // can have no tracked slot while still streaming, so `remainingInvocations
          // === 0` spuriously fires and wipes `loading` / `intentMode` / `catStatuses`
          // mid-run. Mirror the error branch gate on !isStaleDone.
          const remainingInvocations = Object.keys(useChatStore.getState().activeInvocations ?? {}).length;
          if (remainingInvocations === 0 && !isStaleDone) {
            clearDoneTimeout();
            setLoading(false);
            setIntentMode(null);
            clearCatStatuses();
          }
          // Note: do NOT clear replacedInvocationsRef here. The suppression guard
          // is designed to persist until a *different* invocationId is observed
          // (F123 PR #465, symptom-fixture-matrix.md:23). Clearing on done(isFinal)
          // would allow reordered stale chunks to recreate ghost bubbles.
          // Bug C safety net: if done(isFinal) arrived but no streaming bubble
          // was ever created for this cat, events were lost (socket transport
          // drop, micro-disconnect, dual-pointer guard mismatch, etc.).
          // Request a history catch-up so the user sees the response without F5.
          // Unconditional: covers ghost-message scenario where ALL events
          // (stream + callback) were lost during disconnect (#266, #276).
          //
          // Stale-done guard (砚砚 R4): a stale done did not compute messageId
          // (we skipped phase-3 entirely), so `!messageId` would spuriously fire
          // catch-up even though inv-2 is alive and has its own bubble. Skip.
          if (!messageId && !isStaleDone) {
            const tid = useChatStore.getState().currentThreadId;
            console.warn('[stream-catchup] done(isFinal) with no active bubble — requesting catch-up', {
              catId: msg.catId,
              threadId: tid,
              hadStreamData: hadSawStream(msg.catId),
            });
            if (tid) {
              requestStreamCatchUp(tid);
            }
          }
          if (!isStaleDone) {
            clearSawStream(msg.catId);
          }
        }
      } else if (msg.type === 'a2a_handoff') {
        // F173 bug fix: use server timestamp + marker so chatStore inserts
        // this routing pill at the right position relative to the next cat's
        // stream bubble (WebSocket race could otherwise put it after).
        // Cloud Codex R2 P2-2: include monotonic suffix so two same-ms handoff
        // events from the same cat don't collide on `addMessage`'s id-based dedup
        // (background path already uses nextBgSeq for the same reason).
        const serverTs = msg.timestamp ?? Date.now();
        addMessage({
          id: `a2a-${serverTs}-${msg.catId}-${nextActiveA2AHandoffSeq()}`,
          type: 'system',
          variant: 'info',
          content: msg.content ?? '',
          timestamp: serverTs,
          extra: { systemKind: 'a2a_routing' },
        });
      } else if (msg.type === 'provider_signal') {
        // Bug-J: Surface provider-origin warnings (Antigravity capacity retries,
        // stream_error grace window notices, etc.) as visible system messages.
        // Before this handler the backend emitted provider_signal payloads that
        // carried capacity retry notices ("上游模型服务端容量不足..."), but the
        // frontend silently dropped them — the user saw the bubble just hang
        // without explanation. Route them through the same `formatVisibleSystemInfo`
        // pipeline as system_info so the warning text becomes a ⚠️ system bubble.
        markSawStream(msg.catId, msg.invocationId);
        let providerContent = msg.content ?? '';
        try {
          const parsed = JSON.parse(providerContent);
          const visible = formatVisibleSystemInfo(parsed);
          if (visible) providerContent = visible.content;
        } catch {
          /* non-JSON payload — display as-is */
        }
        if (providerContent) {
          addMessage({
            id: `provider-${Date.now()}-${msg.catId}`,
            type: 'system',
            variant: 'info',
            catId: msg.catId,
            content: providerContent,
            timestamp: Date.now(),
          });
        }
      } else if (msg.type === 'system_info') {
        markSawStream(msg.catId, msg.invocationId);
        // System notifications: budget warnings, cancel feedback, A2A follow-up hints, invocation metrics
        let sysContent = msg.content ?? '';
        let sysVariant: 'info' | 'a2a_followup' = 'info';
        let consumed = false;
        try {
          const parsed = JSON.parse(sysContent);
          const visible = formatVisibleSystemInfo(parsed);
          if (visible) {
            sysContent = visible.content;
            sysVariant = visible.variant;
          } else if (parsed?.type === 'invocation_created') {
            // New invocation boundary: clear stale task snapshot + finalized ref for this cat.
            // #586: Without clearing finalizedStreamRef here, a stale ref from the
            // previous invocation could cause the next callback to overwrite the old message.
            const targetCatId = parsed.catId ?? msg.catId;
            clearFinalized(targetCatId);
            // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper
            // invocationId is the user-turn parent; parsed JSON content invocationId
            // is inner auth child. Prefer outer to keep bubble identity stable across
            // active vs background streams (otherwise active path gets `msg-outer-cat`
            // and bg path gets `msg-inner-cat` → dup bubble). thread_mogj6kvwp3l80x56 case.
            const invocationId =
              msg.invocationId ?? (typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined);
            if (targetCatId && invocationId) {
              setCatInvocation(targetCatId, {
                invocationId,
                startedAt: Date.now(),
                taskProgress: {
                  tasks: [],
                  lastUpdate: Date.now(),
                  snapshotStatus: 'running',
                  lastInvocationId: invocationId,
                },
              });

              // F173 hotfix (砚砚 4 件套 #3) — invocation_created is a REBIND BOUNDARY for this cat:
              // (a) Finalize any same-cat streaming bubble bound to a DIFFERENT invocationId,
              //     so findRecoverableAssistantMessage no longer picks it up. This prevents
              //     the ghost-bubble race where a previous invocation's done event was lost
              //     and its streaming=true bubble got reused by the new invocation's chunks.
              // (b) Pick the rebind target: prefer activeRef if it points to an unbound
              //     streaming bubble (the live one we just created); otherwise take the
              //     MOST RECENT (newest-to-oldest) unbound streaming bubble. Cloud Codex P1
              //     on PR#1352 — the old oldest-to-newest loop would bind a stale historical
              //     bubble when reconnect/hydration left multiple unbound ones, leaving the
              //     live bubble unbound and reintroducing ghost/split behavior.
              const messagesSnapshot = useChatStore.getState().messages;
              // Pass (a): finalize any bubble bound to a different invocation.
              // Cloud P1#5 (PR#1352): also markReplacedInvocation(oldInv) so subsequent
              // late text/tool events for the closed invocation get suppressed via
              // shouldSuppressLateStreamChunk (otherwise Loop 1 non-streaming fallback
              // would resurrect the boundary-finalized bubble via ensureStreaming).
              const boundaryReplacedInvs = new Set<string>();
              for (const m of messagesSnapshot) {
                if (m.type !== 'assistant' || m.catId !== targetCatId || m.origin !== 'stream') continue;
                if (!m.isStreaming) continue;
                const boundInv = m.extra?.stream?.invocationId;
                if (boundInv && boundInv !== invocationId) {
                  setStreaming(m.id, false);
                  boundaryReplacedInvs.add(boundInv);
                }
              }
              const tidForBoundary = useChatStore.getState().currentThreadId;
              for (const oldInv of boundaryReplacedInvs) {
                markReplacedInvocation(tidForBoundary, targetCatId, oldInv);
              }
              // Pass (b): pick rebind target.
              let unboundPlaceholderId: string | undefined;
              const activeRefId = getActive(targetCatId)?.id;
              if (activeRefId) {
                const activeMsg = messagesSnapshot.find((m) => m.id === activeRefId);
                if (
                  activeMsg?.type === 'assistant' &&
                  activeMsg.catId === targetCatId &&
                  activeMsg.origin === 'stream' &&
                  activeMsg.isStreaming &&
                  !activeMsg.extra?.stream?.invocationId
                ) {
                  unboundPlaceholderId = activeMsg.id;
                }
              }
              if (!unboundPlaceholderId) {
                // Newest-to-oldest scan so historical unbound bubbles (e.g. hydrated) lose.
                for (let i = messagesSnapshot.length - 1; i >= 0; i -= 1) {
                  const m = messagesSnapshot[i];
                  if (!m || m.type !== 'assistant' || m.catId !== targetCatId || m.origin !== 'stream') continue;
                  if (!m.isStreaming) continue;
                  if (m.extra?.stream?.invocationId) continue;
                  unboundPlaceholderId = m.id;
                  break;
                }
              }
              if (unboundPlaceholderId) {
                const deterministicId = deriveBubbleId(invocationId, targetCatId, () => unboundPlaceholderId!);
                if (deterministicId !== unboundPlaceholderId) {
                  replaceMessageId(unboundPlaceholderId, deterministicId);
                  setMessageStreamInvocation(deterministicId, invocationId);
                } else {
                  setMessageStreamInvocation(unboundPlaceholderId, invocationId);
                }
                // Cloud P1#9 (PR#1352): unconditionally point activeRefs at the rebound
                // bubble (even when it wasn't the prior activeRef target). Newest→oldest
                // scan picked the LIVE bubble for inv-new — leaving activeRefs on a stale
                // older bubble would let later invocationless chunks reuse it via
                // ensureStreaming and append into the previous invocation's bubble.
                const reboundId = deterministicId !== unboundPlaceholderId ? deterministicId : unboundPlaceholderId;
                setActive(targetCatId, reboundId);
              } else {
                // Legacy path: no unbound placeholder but there's some existing message we can
                // bind invocationId onto (preserves behavior for messages already matching newInv).
                const targetId = getOrRecoverActiveAssistantMessageId(targetCatId, undefined, { invocationId });
                if (targetId) {
                  setMessageStreamInvocation(targetId, invocationId);
                }
              }

              maybeMigrateSequentialInvocationOwnership(targetCatId, invocationId);
              consumed = true;
            }
          } else if (parsed?.type === 'invocation_metrics') {
            // Store metrics silently — don't show as system message
            if (parsed.kind === 'session_started') {
              // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer first to keep
              // catInvocations[catId].invocationId aligned with bubble identity.
              const sessionInvocationId =
                msg.invocationId ?? (typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined);
              setCatInvocation(msg.catId, {
                sessionId: parsed.sessionId,
                invocationId: sessionInvocationId,
                startedAt: Date.now(),
                taskProgress: { tasks: [], lastUpdate: 0 },
                ...(parsed.sessionSeq !== undefined ? { sessionSeq: parsed.sessionSeq, sessionSealed: false } : {}),
              });
            } else if (parsed.kind === 'invocation_complete') {
              setCatInvocation(msg.catId, {
                durationMs: parsed.durationMs,
                sessionId: parsed.sessionId,
              });
            }
            consumed = true;
          } else if (parsed?.type === 'invocation_usage') {
            // F8: Store token usage silently — don't show as system message
            setCatInvocation(msg.catId, {
              usage: parsed.usage,
            });
            // Also persist usage on the cat's last assistant message (message-scoped)
            const ref = getActive(msg.catId);
            if (ref) {
              setMessageUsage(ref.id, parsed.usage);
            }
            consumed = true;
          } else if (parsed?.type === 'context_briefing') {
            // F148 Phase E: Insert briefing card into chat store for immediate display
            const sm = parsed.storedMessage as
              | { id: string; content: string; origin: string; timestamp: number; extra?: Record<string, unknown> }
              | undefined;
            if (sm?.id) {
              addMessage({
                id: sm.id,
                type: 'system',
                content: sm.content ?? '',
                origin: (sm.origin as 'briefing') ?? 'briefing',
                timestamp: sm.timestamp ?? Date.now(),
                ...(sm.extra ? { extra: sm.extra } : {}),
              });
            }
            consumed = true;
          } else if (parsed?.type === 'context_health') {
            // F24: Store context health silently
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                contextHealth: parsed.health,
              });
              consumed = true;
            }
          } else if (parsed?.type === 'rate_limit') {
            // F045: Telemetry only — don't show as chat bubble
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                rateLimit: {
                  ...(typeof parsed.utilization === 'number' ? { utilization: parsed.utilization } : {}),
                  ...(typeof parsed.resetsAt === 'string' ? { resetsAt: parsed.resetsAt } : {}),
                },
              });
            }
            consumed = true;
          } else if (parsed?.type === 'compact_boundary') {
            // F045: Telemetry only — don't show as chat bubble
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                compactBoundary: {
                  ...(typeof parsed.preTokens === 'number' ? { preTokens: parsed.preTokens } : {}),
                },
              });
            }
            consumed = true;
          } else if (parsed?.type === 'task_progress') {
            // F26: Store task progress silently
            const targetCatId = parsed.catId ?? msg.catId;
            // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer first so
            // taskProgress.lastInvocationId stays consistent with bubble identity.
            const currentInvocationId =
              msg.invocationId ??
              (typeof parsed.invocationId === 'string'
                ? parsed.invocationId
                : useChatStore.getState().catInvocations?.[targetCatId]?.invocationId);
            const tasks = (parsed.tasks ?? []) as import('../stores/chat-types').TaskProgressItem[];
            setCatInvocation(targetCatId, {
              taskProgress: {
                tasks,
                lastUpdate: Date.now(),
                snapshotStatus: 'running',
                ...(currentInvocationId ? { lastInvocationId: currentInvocationId } : {}),
              },
            });
            consumed = true;
          } else if (parsed?.type === 'web_search') {
            // F045: web_search tool event (privacy: no query, count only) — render as ToolEvent, not raw JSON
            // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper first
            // so tool event reuses the same bubble created by active path under outer id.
            const parsedInv = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            const effectiveInv = msg.invocationId ?? parsedInv;
            // Cloud P1#3 (PR#1352): suppress stale web_search for completed invocation.
            if (!shouldSuppressLateStreamChunk(msg.catId, effectiveInv)) {
              setCatStatus(msg.catId, 'streaming');
              const count = typeof parsed.count === 'number' ? parsed.count : 1;
              const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
              });

              appendToolEvent(messageId, {
                id: `toolws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'tool_use',
                label: `${msg.catId} → web_search${count > 1 ? ` x${count}` : ''}`,
                timestamp: Date.now(),
              });
            }
            consumed = true;
          } else if (parsed?.type === 'thinking') {
            // F045: Embed thinking into the current assistant bubble (like Claude Code)
            // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper first
            // so thinking attaches to the active-path bubble under outer id.
            const thinkingText = parsed.text ?? '';
            const parsedInv = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            const effectiveInv = msg.invocationId ?? parsedInv;
            // Cloud P1#3 (PR#1352): suppress stale thinking for completed invocation.
            if (thinkingText && !shouldSuppressLateStreamChunk(msg.catId, effectiveInv)) {
              const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
              });
              setMessageThinking(messageId, thinkingText);
            }
            consumed = true;
          } else if (parsed?.type === 'liveness_warning') {
            // F118 Phase C: Liveness warning — update cat status + invocation snapshot
            const level = parsed.level as 'alive_but_silent' | 'suspected_stall';
            setCatStatus(msg.catId, level);
            setCatInvocation(msg.catId, {
              livenessWarning: {
                level,
                state: parsed.state as 'active' | 'busy-silent' | 'idle-silent' | 'dead',
                silenceDurationMs: parsed.silenceDurationMs as number,
                cpuTimeMs: typeof parsed.cpuTimeMs === 'number' ? parsed.cpuTimeMs : undefined,
                processAlive: parsed.processAlive as boolean,
                receivedAt: Date.now(),
              },
            });
            consumed = true;
          } else if (parsed?.type === 'timeout_diagnostics') {
            // F118 AC-C3: Store diagnostics keyed by catId to prevent cross-cat mismatch
            if (msg.catId) {
              setPendingTimeoutDiag(msg.catId, parsed as Record<string, unknown>);
            }
            consumed = true;
          } else if (parsed?.type === 'governance_blocked') {
            const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
            const reasonKind = (parsed.reasonKind as string) ?? 'needs_bootstrap';
            const invId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            const existingBlocked = useChatStore
              .getState()
              .messages.find(
                (m) => m.variant === 'governance_blocked' && m.extra?.governanceBlocked?.projectPath === projectPath,
              );
            if (existingBlocked) {
              removeMessage(existingBlocked.id);
            }
            addMessage({
              id: `gov-blocked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              variant: 'governance_blocked',
              content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
              timestamp: Date.now(),
              extra: {
                governanceBlocked: {
                  projectPath,
                  reasonKind: reasonKind as 'needs_bootstrap' | 'needs_confirmation' | 'files_missing',
                  invocationId: invId,
                },
              },
            });
            consumed = true;
          } else if (parsed?.type === 'strategy_allow_compress' || parsed?.type === 'resume_failure_stats') {
            // Internal telemetry — suppress to avoid raw JSON bubbles
            consumed = true;
          } else if (parsed?.type === 'silent_completion') {
            // Bugfix: silent-exit — cat ran tools but produced no text response
            const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
            sysContent = detail || `${msg.catId} completed without a text response.`;
          } else if (parsed?.type === 'invocation_preempted') {
            // Bugfix: silent-exit — invocation was superseded by a newer request
            sysContent = 'This response was superseded by a newer request.';
          } else if (parsed?.type === 'rich_block') {
            // F22: Append rich block — prefer messageId correlation (#83 P2), fallback to activeRefs
            // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper first
            // so rich_block bubble fallback aligns with active-path identity.
            const parsedInv = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            const effectiveInv = msg.invocationId ?? parsedInv;
            // Cloud P1#3 (PR#1352): suppress stale rich_block for completed invocation —
            // explicit messageId correlation still wins (callback may be a re-emission
            // of a known message), so only the bubble-creation fallback path is gated.
            let targetId: string | undefined;

            // P2 fix: use messageId from callback post-message path for precise correlation
            if (parsed.messageId) {
              const found = useChatStore.getState().messages.find((m) => m.id === parsed.messageId);
              if (found) targetId = found.id;
            }

            // Bugfix: standalone create_rich_block (no messageId) — prefer most recent
            // callback message from this cat over the active streaming message.
            if (!targetId) {
              const currentMessages = useChatStore.getState().messages;
              for (let i = currentMessages.length - 1; i >= 0; i--) {
                const m = currentMessages[i];
                if (m.type !== 'assistant' || m.catId !== msg.catId) continue;
                if (m.origin === 'stream' && m.isStreaming) break;
                if (m.origin === 'callback') {
                  targetId = m.id;
                  break;
                }
              }
            }

            if (!targetId && !shouldSuppressLateStreamChunk(msg.catId, effectiveInv)) {
              // Final fallback: recover the active stream bubble before creating a placeholder.
              targetId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
              });
            }

            if (targetId && parsed.block) {
              appendRichBlock(targetId, parsed.block);
            }
            consumed = true;
          } else if (parsed?.type === 'session_seal_requested') {
            // F24 Phase B: Session sealed — update session info + show notification
            setCatInvocation(parsed.catId, {
              sessionSeq: parsed.sessionSeq,
              sessionSealed: true,
            });
            const pct = parsed.healthSnapshot?.fillRatio ? Math.round(parsed.healthSnapshot.fillRatio * 100) : '?';
            sysContent = `${parsed.catId} 的会话 #${parsed.sessionSeq} 已封存（上下文 ${pct}%），下次调用将自动创建新会话`;
          }
        } catch {
          /* not JSON, use raw content */
        }
        if (!consumed) {
          addMessage({
            id: `sysinfo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'system',
            variant: sysVariant,
            content: sysContent,
            timestamp: Date.now(),
          });
        }
      } else if (msg.type === 'error') {
        // Stale-terminal guard (砚砚 R6, shared with `done`): late error(inv-1)
        // arriving after inv-2 has already started must NOT touch inv-2's bubble
        // or clear activeRefs for the newer invocation. See isStaleTerminalEvent
        // for the full resolver + normalization rationale.
        const errorDecision = decideTerminalEvent(msg.catId, msg.invocationId);
        const isStaleError = errorDecision.stale;

        // Cloud R9 P2: `pendingTimeoutDiagRef` is keyed by `catId` alone — if we
        // skip cleanup under the stale guard, the entry leaks and would wrongly
        // attach to a later non-stale error for the same cat on a different
        // invocation. Delete unconditionally on any error arrival; the only
        // read happens inside the `!isStaleError` branch below, so stale errors
        // correctly drop the diagnostics (rather than consuming them for wrong
        // invocation).
        const timeoutDiag = msg.catId ? getPendingTimeoutDiag(msg.catId) : null;
        if (msg.catId) clearPendingTimeoutDiag(msg.catId);

        if (!isStaleError) {
          const recoverableInFlightError = isRecoverableInFlightError(msg);
          if (!recoverableInFlightError) {
            setCatStatus(msg.catId, 'error');
            const currentProgress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
            if (currentProgress?.tasks?.length) {
              setCatInvocation(msg.catId, {
                taskProgress: {
                  ...currentProgress,
                  snapshotStatus: 'interrupted',
                  interruptReason: msg.error ?? 'Unknown error',
                  lastUpdate: Date.now(),
                },
              });
            }
            let messageId = getOrRecoverActiveAssistantMessageId(msg.catId, undefined, {
              ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
            });
            // Cloud R15 + P1#1 + P1#7 permissive fallback (see done path for full rationale).
            if (!messageId && msg.invocationId) {
              const slotFreshConfirmed = ((): boolean => {
                const s = useChatStore.getState();
                const suffix = `-${msg.catId}`;
                const normalize = (k: string | undefined): string | undefined =>
                  k && k.endsWith(suffix) ? k.slice(0, -suffix.length) : k;
                const entries = Object.entries(s.activeInvocations ?? {});
                for (let i = entries.length - 1; i >= 0; i--) {
                  const [key, info] = entries[i]!;
                  if (info.catId !== msg.catId || key.startsWith('hydrated-')) continue;
                  return normalize(key) === msg.invocationId;
                }
                return false;
              })();
              const permissive = useChatStore.getState().messages.findLast((m) => {
                if (m.type !== 'assistant' || m.catId !== msg.catId || !m.isStreaming) return false;
                if (slotFreshConfirmed) return true;
                const bound = m.extra?.stream?.invocationId;
                return !bound || bound === msg.invocationId;
              });
              if (permissive) {
                messageId = permissive.id;
              }
            }
            if (messageId) {
              setStreaming(messageId, false);
              deleteActive(msg.catId);
            }
          }

          addMessage({
            id: `err-${Date.now()}-${msg.catId}`,
            type: 'system',
            variant: 'error',
            catId: msg.catId,
            content: (() => {
              const base = `Error: ${msg.error ?? 'Unknown error'}`;
              try {
                const meta = JSON.parse(msg.content ?? '{}');
                const subtype = meta?.errorSubtype;
                if (subtype) {
                  const labels: Record<string, string> = {
                    error_max_turns: '超出 turn 限制',
                    error_max_budget_usd: '预算用尽',
                    error_during_execution: '运行时错误',
                    error_max_structured_output_retries: '结构化输出重试超限',
                  };
                  return labels[subtype] ? `${base} (${labels[subtype]})` : base;
                }
              } catch {
                /* no subtype */
              }
              return base;
            })(),
            timestamp: Date.now(),
            ...(timeoutDiag
              ? {
                  extra: {
                    timeoutDiagnostics: {
                      silenceDurationMs: timeoutDiag.silenceDurationMs as number,
                      processAlive: timeoutDiag.processAlive as boolean,
                      lastEventType: timeoutDiag.lastEventType as string | undefined,
                      firstEventAt: timeoutDiag.firstEventAt as number | undefined,
                      lastEventAt: timeoutDiag.lastEventAt as number | undefined,
                      cliSessionId: timeoutDiag.cliSessionId as string | undefined,
                      invocationId: timeoutDiag.invocationId as string | undefined,
                      rawArchivePath: timeoutDiag.rawArchivePath as string | undefined,
                    },
                  },
                }
              : {}),
          });
        }
        // Only stop loading on isFinal; size===0 would false-positive in serial gaps.
        // Slot cleanup for `msg.invocationId` is always safe (self-guarded by
        // `primarySlot?.catId === msg.catId`) — the old inv-1 slot really should
        // be removed regardless of staleness. But global cleanup (catStatuses,
        // loading, intentMode, streaming refs) must NOT fire for stale error —
        // it would wipe inv-2's state.
        if (msg.isFinal) {
          // F108: clear this cat's invocation slot on terminal error
          if (msg.invocationId) {
            // F869: Same multi-cat slot-aware cleanup as the done(isFinal) path.
            const slotState = useChatStore.getState();
            const primarySlot = slotState.activeInvocations[msg.invocationId];
            if (primarySlot?.catId === msg.catId) {
              removeActiveInvocation(msg.invocationId);
            }
            removeActiveInvocation(`${msg.invocationId}-${msg.catId}`);
            // Hydrated-only orphan cleanup (same as done path).
            // Stale-error R10: gate on !isStaleError — hydrated slot may represent
            // the current in-flight invocation (reconnect hydration).
            if (!isStaleError) {
              const stateAfter = useChatStore.getState();
              const orphan = findLatestActiveInvocationIdForCat(stateAfter.activeInvocations, msg.catId);
              if (orphan?.startsWith('hydrated-')) {
                removeActiveInvocation(orphan);
              }
            }
          } else if (!isStaleError) {
            // No msg.invocationId: fall back to "latest slot for this cat" removal.
            // Skip under stale guard — without msg.invocationId we can't distinguish
            // stale from current, and this branch is the dangerous one (removes the
            // NEWER invocation's slot if it's the latest for this cat).
            const catSlot = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
            if (catSlot) {
              removeActiveInvocation(catSlot);
            } else {
              setHasActiveInvocation(false);
            }
          }
          // F108 P1 fix: Only clear global state when the LAST active invocation ends.
          // Gate on !isStaleError: a stale error must not wipe newer invocation's
          // streaming refs / catStatuses / loading flag.
          if (!isStaleError) {
            const remainingInvocations = Object.keys(useChatStore.getState().activeInvocations ?? {}).length;
            if (remainingInvocations === 0) {
              clearDoneTimeout();
              setLoading(false);
              setIntentMode(null);
              clearCatStatuses();
              // Clear ALL remaining streaming refs — global catch uses catId='opus' which may
              // not match the cat that was actually running (e.g. codex/gemini)
              for (const ref of getAllActiveValues()) {
                setStreaming(ref.id, false);
              }
              clearAllActive();
            }
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      addMessage,
      appendToMessage,
      appendToolEvent,
      appendRichBlock,
      setStreaming,
      setLoading,
      removeActiveInvocation,
      setIntentMode,
      setCatStatus,
      clearCatStatuses,
      setCatInvocation,
      setMessageThinking,
      setMessageStreamInvocation,
      replaceMessageId,
      patchMessage,
      resetTimeout,
      clearDoneTimeout,
      findCallbackReplacementTarget,
      findInvocationlessRichPlaceholder,
      findInvocationlessStreamPlaceholder,
      getCurrentInvocationIdForCat,
      getCurrentInvocationStateForCat,
      getOrRecoverActiveAssistantMessageId,
      isStaleTerminalEvent,
      ensureActiveAssistantMessage,
      maybeMigrateSequentialInvocationOwnership,
      recordLateBindBubbleCreate,
      shouldSuppressLateStreamChunk,
      setHasActiveInvocation,
      setMessageUsage,
      requestStreamCatchUp,
      removeMessage,
    ],
  );

  const handleStop = useCallback(
    (cancelFn: (threadId: string, catId?: string) => void, threadId: string) => {
      const store = useChatStore.getState();
      // When exactly one cat is active, cancel only that cat to avoid
      // thread-level cancelAll accidentally killing other cats.
      const activeSlots = Object.values(store.getThreadState(threadId).activeInvocations ?? {});
      const singleCatId = activeSlots.length === 1 ? activeSlots[0]?.catId : undefined;
      cancelFn(threadId, singleCatId);
      const isActiveThreadStop = threadId === store.currentThreadId;

      if (!isActiveThreadStop) {
        clearDoneTimeout(threadId);
        const threadState = store.getThreadState(threadId);
        for (const message of threadState.messages) {
          if (message.type === 'assistant' && message.isStreaming) {
            store.setThreadMessageStreaming(threadId, message.id, false);
          }
        }
        store.resetThreadInvocationState(threadId);
        // Codex review P2 — split-pane / background stop must also clear the stopped
        // thread's suppression markers; otherwise switching back later sees stale
        // replacement state and shouldSuppressLateStreamChunk drops legitimate text.
        clearReplacedInvocationsForThread(threadId);
        return;
      }

      clearDoneTimeout(threadId);
      setLoading(false);
      // F108: stop clears all invocation slots (user cancel-all)
      clearAllActiveInvocations();
      setIntentMode(null);
      clearCatStatuses();
      // Stop all active streams
      for (const ref of getAllActiveValues()) {
        setStreaming(ref.id, false);
      }
      clearAllActive();
      // F173 A.12 砚砚 round 5 — handleStop is an EXPLICIT cancel by the user, so it's
      // legitimate to clear suppression for the stopped thread. (Background-stop branch
      // above also clears for the same reason.) This is invocation-lifecycle aligned:
      // user's stop = invocation explicitly ended = suppression no longer relevant.
      clearReplacedInvocationsForThread(threadId);
    },
    [setLoading, clearAllActiveInvocations, setStreaming, setIntentMode, clearCatStatuses, clearDoneTimeout],
  );

  const resetRefs = useCallback(() => {
    clearAllActive();
    // F173 A.12 砚砚 round 5 — DO NOT clear suppression on thread switch / non-queue send.
    // resetRefs is navigation-driven (URL change, follow-up send), NOT invocation lifecycle.
    // Suppression cleanup must be invocation-driven only:
    //   1) Different invocationId observed → cleared inline in shouldSuppressLateStreamChunk
    //   2) Invocationless flow → fail-open, suppression doesn't drop legitimate output
    //   3) Explicit user stop → handleStop clears (legitimate cancel boundary)
    // Threading/navigation actions never invalidate an in-flight invocation's suppression.
    // clowder-ai#378: clear ALL ref maps so stale IDs from prior invocation
    // don't cause findInvocationlessStreamPlaceholder to match old bubbles.
    // Without this, scheduler callbacks (no invocationId) could patch a
    // finalized bubble from the previous invocation after thread switch.
    // F173 Phase B: sawStreamData is thread-scoped in the ledger; per-thread
    // isolation makes blanket clear unnecessary across threads. But within the
    // current thread, finalized bubbles must still be cleared on resetRefs to
    // preserve the "stale finalized must not patch new callback" semantic
    // (#266 Round 2 regression test).
    const tid = useChatStore.getState().currentThreadId;
    if (tid) clearAllFinalizedForThreadLedger(getThreadRuntimeLedger(), tid);
  }, []);

  return { handleAgentMessage, handleStop, resetRefs, resetTimeout, clearDoneTimeout };
}
