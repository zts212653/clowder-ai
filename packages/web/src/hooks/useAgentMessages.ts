'use client';

import type { CliDiagnostics, ReplyPreview } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { deriveBubbleId, getBubbleInvocationId } from '@/debug/bubbleIdentity';
import { recordBubbleInvariantViolation } from '@/debug/bubbleInvariantDiagnostics';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import { adaptIncomingToBubbleEvent } from '@/hooks/bubble-event-adapter';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { deriveBubbleKindFromMessage } from '@/stores/bubble-invariants';
import { projectCanonicalBubbles } from '@/stores/bubble-projection';
import { applyBubbleEvent, type BubbleReducerInput, type BubbleReducerOutput } from '@/stores/bubble-reducer';
import type {
  CatInvocationInfo,
  CatStatusType,
  ChatMessage,
  ChatMessageMetadata,
  ChatMessagePatch,
  RichBlock,
  SystemInfoProjection,
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
import {
  formatAgyProgressDetail,
  formatSessionSealRequested,
  formatVisibleSystemInfo,
  isInternalSystemInfoTelemetry,
} from './system-info-visible';
import {
  type ActiveSeedSource,
  clearActiveBubble as clearActiveBubbleLedger,
  clearAllActiveBubblesForThread as clearAllActiveBubblesForThreadLedger,
  clearAllFinalizedForThread as clearAllFinalizedForThreadLedger,
  clearFinalized as clearFinalizedLedger,
  clearPendingTimeoutDiag as clearPendingTimeoutDiagLedger,
  clearStreamData as clearStreamDataLedger,
  decideTerminalEventTarget as decideTerminalEventTargetLedger,
  getActiveBoundTurnInvocationId as getActiveBoundTurnInvocationIdLedger,
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
const FRESH_PARENT_SEED_BOUNDARY_WINDOW_MS = DONE_TIMEOUT_MS;
const FRESH_PARENT_SEED_MAX_SEQ_GAP = 100;
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

export function applyBubbleEventWithRecovery(input: BubbleReducerInput): BubbleReducerOutput {
  const result = applyBubbleEvent(input);
  if (result.recoveryAction === 'catch-up') {
    useChatStore.getState().requestStreamCatchUp(input.threadId);
  }
  // F194 Phase Z8 AC-Z21 (KD-27 + 砚砚 R1 P1#2): writer boundary projection.
  // F194 Phase Z8 R2 P1 (砚砚) + cloud R2 P1 (codex): destructive reducer paths
  // (e.g. reduceCallbackFinal exact-key) overwrite existing stream content with
  // finalContent. To preserve stream raw facts AND keep Z7 dropLocalOnlyStreamSiblings
  // cleanup, baseline = result.nextMessages (which already has Z7 cleanup applied),
  // then append a synthetic raw-stream record so projection sees both stream content
  // and callback content. Projection groups by (catId, invocationId) — they collapse
  // into one canonical bubble with concat content. cloud R2 P1: bypassing reducer's
  // dropLocalOnlyStreamSiblings would re-introduce stale local-only stream siblings.
  // cloud R3 P1 (codex): match using stable invocation key (`getBubbleInvocationId`,
  // turn-priority) — event.canonicalInvocationId is turn id in Z3 dual-id case, but
  // stream row stores parent in extra.stream.invocationId. Direct invocationId compare
  // misses → no synthetic record → destructive overwrite drops stream content.
  if (input.event.type === 'callback_final' && input.event.canonicalInvocationId && input.event.actorId) {
    const matchInvId = input.event.canonicalInvocationId;
    const matchActorId = input.event.actorId;
    // Find pre-reducer stream record (raw stream content that reducer overwrote).
    const preReducerStream = input.currentMessages.find(
      (m) =>
        m.type === 'assistant' &&
        m.catId === matchActorId &&
        m.origin === 'stream' &&
        getBubbleInvocationId(m) === matchInvId,
    );
    let projectionInput = result.nextMessages;
    if (preReducerStream && preReducerStream.content && preReducerStream.content.length > 0) {
      // Synthesize a raw-stream record with a distinct id so projection sees it as a
      // separate raw fact in the same (catId, invocationId) group.
      const earlierTimestamp = (preReducerStream.timestamp ?? 0) - 1;
      const syntheticStream: ChatMessage = {
        ...preReducerStream,
        id: `${preReducerStream.id}::z8-raw-pre-callback`,
        timestamp: earlierTimestamp > 0 ? earlierTimestamp : (preReducerStream.timestamp ?? 0),
        origin: 'stream',
        isStreaming: false,
      };
      projectionInput = [...result.nextMessages, syntheticStream];
    }
    const projected = projectCanonicalBubbles({ records: projectionInput });
    return { ...result, nextMessages: projected.messages };
  }

  // Non-destructive events: reducer's nextMessages is safe to project directly.
  if (result.nextMessages === input.currentMessages) return result;
  const projected = projectCanonicalBubbles({ records: result.nextMessages });
  if (projected.messages === result.nextMessages) return result;
  return { ...result, nextMessages: projected.messages };
}

function shouldCatchUpEmptyFinalStreamBubble(message: ChatMessage | undefined): boolean {
  if (!message || message.type !== 'assistant' || message.origin !== 'stream') return false;
  if (message.content.trim().length > 0) return false;
  return (message.toolEvents?.length ?? 0) > 0 || (message.thinking?.trim().length ?? 0) > 0;
}

function isSameParentLocalToolOnlyResidue(
  message: ChatMessage,
  finalized: ChatMessage,
  parentInvocationId: string,
): boolean {
  if (message.id === finalized.id) return false;
  if (!message.id.startsWith('msg-')) return false;
  if (message.type !== 'assistant' || message.catId !== finalized.catId || message.origin !== 'stream') {
    return false;
  }
  if (message.extra?.stream?.invocationId !== parentInvocationId) return false;
  if (message.content.trim().length > 0) return false;
  return (message.toolEvents?.length ?? 0) > 0 || (message.thinking?.trim().length ?? 0) > 0;
}

function terminalizeSameParentLocalToolOnlyResidues(
  messages: ChatMessage[],
  finalized: ChatMessage | undefined,
  invocationId: string | undefined,
): { found: boolean; messages: ChatMessage[]; terminalized: boolean } {
  if (!finalized || finalized.type !== 'assistant' || finalized.origin !== 'stream' || !finalized.catId) {
    return { found: false, messages, terminalized: false };
  }
  const parentInvocationId = finalized.extra?.stream?.invocationId ?? invocationId;
  if (!parentInvocationId) return { found: false, messages, terminalized: false };
  let found = false;
  let terminalized = false;
  const nextMessages = messages.map((message) => {
    if (!isSameParentLocalToolOnlyResidue(message, finalized, parentInvocationId)) {
      return message;
    }
    found = true;
    if (message.isStreaming === false) return message;
    terminalized = true;
    return { ...message, isStreaming: false };
  });
  return { found, messages: terminalized ? nextMessages : messages, terminalized };
}

interface AgentMsg {
  type: string;
  catId: string;
  content?: string;
  textMode?: 'append' | 'replace';
  error?: string;
  /** Structured backend/provider error code. Some provider errors are recoverable mid-run. */
  errorCode?: string;
  isFinal?: boolean;
  metadata?: {
    provider: string;
    model: string;
    sessionId?: string;
    usage?: import('../stores/chat-types').TokenUsage;
    /** F212 Phase B: structured CLI error diagnostics stamped by api providers. */
    cliDiagnostics?: CliDiagnostics;
  };
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
  /** Machine-readable A2A target cat for handoff events. */
  targetCatId?: string;
  /** F67: Whether this message @mentions the co-creator */
  mentionsUser?: boolean;
  /** F52: Cross-thread origin metadata */
  extra?: {
    crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
    a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string };
    /** #814: True when message originated from an explicit post_message callback */
    isExplicitPost?: boolean;
    /** F098-C1: Explicit target cats from post_message (direction pills) */
    targetCats?: string[];
  };
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: ReplyPreview;
  /** F108: Invocation ID — distinguishes messages from concurrent invocations.
   *  F194 Phase Z3 dual id: parent/chain id (legacy SoT for liveness/queue/cancel). */
  invocationId?: string;
  /** F194 Phase Z3 (砚砚 R2): per-cat-turn invocation id from backend dual id broadcast.
   *  Frontend uses for bubble identity stable key (prevents same-parent multi-turn-same-cat merge). */
  turnInvocationId?: string;
  /** F173 Phase E (KD-1 handler unification): handleAgentMessage 现在是 single dispatch
   *  entry，需要 threadId 区分 active vs background。useSocket 一直传 msg.threadId。 */
  threadId?: string;
  /** F183 Phase C: optional thread-scoped monotonic sequence. */
  seq?: number;
}

function normalizeInvocationForCat(invocationId: string | undefined, catId: string): string | undefined {
  const suffix = `-${catId}`;
  return invocationId?.endsWith(suffix) ? invocationId.slice(0, -suffix.length) : invocationId;
}

type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;

function findTerminalActiveInvocationSlot(
  activeInvocations: ActiveInvocationSlots | undefined,
  catInvocations: Record<string, CatInvocationInfo> | undefined,
  catId: string,
  invocationId: string | undefined,
  turnInvocationId: string | undefined,
): string | undefined {
  const slots: ActiveInvocationSlots = activeInvocations === undefined ? {} : activeInvocations;
  const direct = catInvocations?.[catId];
  let terminalTurn = turnInvocationId;
  if (terminalTurn === undefined) {
    terminalTurn = invocationId;
  }

  const exactKeys = new Set<string>();
  if (invocationId) {
    exactKeys.add(invocationId);
    exactKeys.add(`${invocationId}-${catId}`);
  }
  if (turnInvocationId) {
    exactKeys.add(turnInvocationId);
    exactKeys.add(`${turnInvocationId}-${catId}`);
  }

  const entries = Object.entries(slots);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const [key, info] = entries[i]!;
    if (info.catId === catId && exactKeys.has(key)) return key;
  }

  // Z9 dual identity: activeInvocations is keyed by the parent liveness id from
  // intent_mode, while terminal stream events can carry the per-cat turn id.
  // If catInvocations confirms this terminal turn belongs to the parent slot,
  // remove that parent-key slot too. This stays safe for same-cat preemption:
  // a newer slot has a different parent key, so it won't match direct.invocationId.
  if (terminalTurn && direct?.turnInvocationId === terminalTurn && direct.invocationId) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, info] = entries[i]!;
      if (info.catId !== catId) continue;
      if (key.startsWith('hydrated-')) continue;
      if (normalizeInvocationForCat(key, catId) === direct.invocationId) return key;
    }
  }

  return undefined;
}

function sameInvocationForCat(candidate: string | undefined, expected: string, catId: string): boolean {
  return normalizeInvocationForCat(candidate, catId) === expected;
}

/**
 * F194 Phase Z3 R4 P1-3 (砚砚): dual-id-aware variant of sameInvocationForCat. Tries both stored
 * message's stable key (turn > parent) and direct parent, so same-parent multi-turn callback/done
 * matches against the right turn (not stuck on legacy parent-only comparison).
 */
function sameBubbleStableKey(message: ChatMessage | undefined, expected: string, catId: string): boolean {
  if (!message) return false;
  // #814: explicit post_message bubbles are standalone. They may retain stream
  // identity after hydration for correlation, but must never be recovered,
  // finalized, or replaced by stream stable-key paths.
  if (message.extra?.isExplicitPost) return false;
  const turn = message.extra?.stream?.turnInvocationId;
  // F194 Phase Z3 R5 P1-1 (砚砚): turn-bearing bubble matches ONLY against turn (parent reserved
  // for liveness/cancel; same-parent multi-turn must NOT cross-match via parent fallback).
  // Legacy bubble (no turn): fall back to parent direct match.
  if (turn) return sameInvocationForCat(turn, expected, catId);
  return sameInvocationForCat(message.extra?.stream?.invocationId, expected, catId);
}

function pendingCallbackKey(threadId: string | undefined, catId: string, invocationId: string): string {
  return `${threadId ?? 'active'}::${catId}::${invocationId}`;
}

type PendingCallbackMessage = AgentMsg | BackgroundAgentMessage;

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

// F194 cloud R3 (2026-06-15, 砚砚) ③: provisional bubble id source. A fresh seed created before
// the turn id is known must NOT collide with the deterministic `msg-{parent}-{cat}` id — an
// earlier same-parent residue may already own it, and addMessage no-ops on a duplicate id. The
// monotonic counter + timestamp guarantees a distinct id; it is rebound to the turn-derived id at
// the invocation_created boundary. The `msg-prov-` prefix can never collide with a deterministic
// `msg-{invocationId}-{cat}` id (invocation ids are never literally `prov-...`).
let provisionalBubbleSeq = 0;
function nextProvisionalBubbleId(catId: string): string {
  provisionalBubbleSeq += 1;
  return `msg-prov-${Date.now()}-${provisionalBubbleSeq}-${catId}`;
}

function isRecoverableInFlightError(msg: { type: string; errorCode?: string; isFinal?: boolean }): boolean {
  if (msg.type !== 'error' || msg.isFinal === true) return false;
  return msg.errorCode === 'upstream_error' || msg.errorCode === 'tool_error';
}

type FreshParentSeedProof = {
  freshParentSeedAt?: number;
  freshParentSeedSeq?: number;
};

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function freshParentSeedProof(
  seedSource: ActiveSeedSource | undefined,
  timestamp: number | undefined,
  seq: number | undefined,
): FreshParentSeedProof {
  if (seedSource !== 'fresh-parent-seed') return {};
  const freshParentSeedAt = finiteNumber(timestamp) ?? Date.now();
  const freshParentSeedSeq = finiteNumber(seq);
  return {
    freshParentSeedAt,
    ...(freshParentSeedSeq !== undefined ? { freshParentSeedSeq } : {}),
  };
}

function isCurrentFreshParentSeed(
  ref: { seedSource?: ActiveSeedSource; freshParentSeedAt?: number; freshParentSeedSeq?: number } | undefined,
  boundaryTimestamp: number | undefined,
  boundarySeq: number | undefined,
): boolean {
  if (ref?.seedSource !== 'fresh-parent-seed') return false;
  const seedAt = finiteNumber(ref.freshParentSeedAt);
  const eventAt = finiteNumber(boundaryTimestamp) ?? Date.now();
  if (seedAt === undefined) return false;
  const ageMs = eventAt - seedAt;
  if (ageMs < 0 || ageMs > FRESH_PARENT_SEED_BOUNDARY_WINDOW_MS) return false;

  const seedSeq = finiteNumber(ref.freshParentSeedSeq);
  const eventSeq = finiteNumber(boundarySeq);
  if (seedSeq !== undefined && eventSeq !== undefined) {
    const seqGap = eventSeq - seedSeq;
    if (seqGap <= 0 || seqGap > FRESH_PARENT_SEED_MAX_SEQ_GAP) return false;
  }
  return true;
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
  metadata?: {
    provider: string;
    model: string;
    sessionId?: string;
    usage?: TokenUsage;
    /** F212 Phase B: structured CLI error diagnostics stamped by api providers on __cliError/__cliTimeout.
     *  Travels as-is through `broadcastAgentMessage` spread; web error-path unpacks into `extra.cliDiagnostics`. */
    cliDiagnostics?: CliDiagnostics;
  };
  /** F52: Cross-thread origin metadata */
  extra?: {
    crossPost?: { sourceThreadId: string; sourceInvocationId?: string };
    /** #814: True when message originated from an explicit post_message callback */
    isExplicitPost?: boolean;
    /** F098-C1: Explicit target cats from post_message (direction pills) */
    targetCats?: string[];
  };
  /** F057-C2: Whether this message mentions the user (@user / @co-creator) */
  mentionsUser?: boolean;
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: { senderCatId: string | null; content: string; deleted?: true };
  /** F108: Invocation ID — distinguishes messages from concurrent invocations.
   *  F194 Phase Z3 dual id: this is the chain/parent invocation id (legacy SoT for liveness/queue/cancel).
   *  Per-cat-turn id is `turnInvocationId` below — frontend uses turn for bubble identity. */
  invocationId?: string;
  /** Machine-readable A2A target cat for handoff events. */
  targetCatId?: string;
  /** F194 Phase Z3 (砚砚 R P1-1): per-cat-turn invocation id for bubble identity stable key
   *  (prevents same-parent multi-turn-same-cat bubble merge). Backend `messages.ts` broadcastPayload
   *  sets this from inner invokeSingleCat invocation_created event. Frontend writes to
   *  `extra.stream.turnInvocationId` so bubble dedup uses the turn dimension. */
  turnInvocationId?: string;
  /**
   * F183 Phase C — thread-scoped monotonic sequence number (KD-9).
   * Client tracks `lastSeq` per thread; gap (incomingSeq > lastSeq + 1) triggers
   * `requestStreamCatchUp(threadId)` to fetch missed events.
   * Optional for backward compat — events without seq don't update lastSeq
   * (graceful degradation; legacy producers continue working without gap detection).
   */
  seq?: number;
  /**
   * F183 Phase C (砚砚 R1 P1 fix) — server seq epoch (sequencer instance UUID).
   * Set by `SocketManager.broadcastAgentMessage`. Client compares to
   * `lastSeqEpochByThread[threadId]`; mismatch = server restart → reset lastSeq
   * + trigger catch-up. Without epoch, restart silently breaks gap detection.
   */
  seqEpoch?: string;
  timestamp: number;
}

export interface BackgroundStreamRef {
  id: string;
  threadId: string;
  catId: string;
  seedSource?: ActiveSeedSource;
  freshParentSeedAt?: number;
  freshParentSeedSeq?: number;
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
  setThreadMessageStreamInvocation: (
    threadId: string,
    messageId: string,
    invocationId: string,
    turnInvocationId?: string,
  ) => void;
  setThreadMessageStreaming: (threadId: string, messageId: string, streaming: boolean) => void;
  setThreadLoading: (threadId: string, loading: boolean) => void;
  setThreadHasActiveInvocation: (threadId: string, active: boolean) => void;
  /** F108: Add an active invocation slot to a thread */
  addThreadActiveInvocation: (threadId: string, invocationId: string, catId: string, mode: string) => void;
  /** F108: Remove an active invocation slot from a thread */
  removeThreadActiveInvocation: (threadId: string, invocationId: string) => void;
  updateThreadCatStatus: (threadId: string, catId: string, status: CatStatusType, detail?: string) => void;
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
  /** F183 Phase B1.7 — thread-scoped reducer write entry. See chatStore.ts. */
  replaceThreadMessages: (threadId: string, msgs: ChatMessage[], hasMore?: boolean) => void;
  /** F183 Phase B1.7 — explicit unread bump for reducer paths that bypass
   *  addMessageToThread's auto-increment. Used by bg error reducer wire-up
   *  when creating a new system_status bubble for non-current thread. */
  incrementUnread: (threadId: string) => void;
}

export interface HandleBackgroundMessageOptions {
  store: BackgroundStoreLike;
  bgStreamRefs: Map<string, BackgroundStreamRef>;
  // F173 A.6 — `replacedInvocations` removed. It is now a shared module-level Map
  // (see `shared-replaced-invocations.ts`), accessed directly by both active and background
  // handlers, so suppression handoff works in both directions.
  nextBgSeq: () => number;
  addToast: (toast: BackgroundToastInput) => void;
  /** Human-facing projection only; stored events continue to retain stable catId facts. */
  resolveCatName?: (catId: string) => string;
  /** #80 fix-C: Clear the done-timeout guard when a background thread completes */
  clearDoneTimeout?: (threadId?: string) => void;
  /** #586 follow-up: Just-finalized stream bubble IDs keyed by streamKey */
  finalizedBgRefs: Map<string, string>;
  /** Callback text that arrived before the matching background stream finalized. */
  pendingCallbacks?: Map<string, PendingCallbackMessage>;
  /** Central pending-callback deferral hook; schedules the fallback drain. */
  deferPendingCallback?: (pending: PendingCallbackMessage, threadId: string | undefined) => void;
  /** Central pending-callback deletion hook; clears paired fallback timers. */
  deletePendingCallback?: (threadId: string | undefined, catId: string, invocationId: string) => void;
}

function resolveBackgroundCatName(options: HandleBackgroundMessageOptions, catId: string): string {
  return options.resolveCatName?.(catId) ?? catId;
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
  systemInfo?: SystemInfoProjection;
}

function retainSystemInfo(payload: Record<string, unknown>, fallbackCatId: string): SystemInfoProjection {
  return { v: 1, payload, fallbackCatId };
}

function recoverBackgroundStreamingMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const streamKey = `${msg.threadId}::${msg.catId}`;
  const activeRef = options.bgStreamRefs.get(streamKey);
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const message = threadMessages[i];
    if (message.type === 'assistant' && message.catId === msg.catId && message.isStreaming) {
      if (shouldSkipBackgroundParentOnlyResidueRecovery(message, msg, options, activeRef)) continue;
      options.bgStreamRefs.set(streamKey, {
        id: message.id,
        threadId: msg.threadId,
        catId: msg.catId,
        seedSource: 'recovered',
      });
      if (msg.metadata) {
        options.store.setThreadMessageMetadata(msg.threadId, message.id, msg.metadata);
      }
      return message.id;
    }
  }
  return undefined;
}

function getStreamStableInvocationKey(message: ChatMessage): string | undefined {
  // #814: explicit post_message is standalone — never match by stable key,
  // so stream events from the same invocation can't replace this bubble.
  // stream block is still preserved for #573 correlation after F5/hydration.
  if (message.extra?.isExplicitPost) return undefined;
  const invocationId = message.extra?.stream?.invocationId;
  if (typeof invocationId !== 'string' || invocationId.length === 0) return undefined;
  const turnInvocationId = message.extra?.stream?.turnInvocationId;
  return typeof turnInvocationId === 'string' && turnInvocationId.length > 0 ? turnInvocationId : invocationId;
}

function shouldSkipBackgroundParentOnlyResidueRecovery(
  message: ChatMessage,
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
  activeRef?: BackgroundStreamRef,
): boolean {
  if (msg.type !== 'tool_use' && msg.type !== 'tool_result') return false;
  const incomingInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
  if (!incomingInvocationId) return false;
  const incomingTurnInvocationId =
    msg.turnInvocationId ?? options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.turnInvocationId;
  if (incomingTurnInvocationId) return false;
  const boundInv = message.extra?.stream?.invocationId;
  const boundTurn = message.extra?.stream?.turnInvocationId;
  if (boundInv !== incomingInvocationId || boundTurn) return false;
  // Check 1: bgStreamRef tracks this message as the current fresh parent seed.
  if (activeRef?.id === message.id && isCurrentFreshParentSeed(activeRef, msg.timestamp, msg.seq)) return false;
  // Check 2 (F194 saga17+): runtime ledger bridge for active→background transition.
  // When the active path created a parent-only seed and the user switched threads,
  // bgStreamRefs is cleared (line 4100) but the runtime ledger still knows which
  // bubble is active. Allow recovery — same bridge pattern as invocation_created
  // handler (line 655-668). Z3-safe: the ledger holds ONE entry per (thread, cat);
  // finalized/done bubbles have been cleared, so stale residues cannot be recovered.
  const ledgerEntry = getActiveBubbleLedger(getThreadRuntimeLedger(), msg.threadId, msg.catId);
  if (
    ledgerEntry?.messageId === message.id &&
    ledgerEntry.seedSource === 'fresh-parent-seed' &&
    isCurrentFreshParentSeed(ledgerEntry, msg.timestamp, msg.seq)
  ) {
    return false;
  }
  return true;
}

function hasBackgroundParentOnlyResidue(
  msg: BackgroundAgentMessage,
  invocationId: string | undefined,
  activeRef: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): boolean {
  if (msg.type !== 'tool_use' && msg.type !== 'tool_result') return false;
  if (!invocationId) return false;
  const activeFreshSeedId = isCurrentFreshParentSeed(activeRef, msg.timestamp, msg.seq) ? activeRef?.id : undefined;
  return options.store
    .getThreadState(msg.threadId)
    .messages.some(
      (message) =>
        message.type === 'assistant' &&
        message.catId === msg.catId &&
        message.origin === 'stream' &&
        message.extra?.stream?.invocationId === invocationId &&
        !message.extra.stream.turnInvocationId &&
        message.id !== activeFreshSeedId,
    );
}

function isBackgroundStreamingAssistant(message: ChatMessage, catId: string): boolean {
  return message.type === 'assistant' && message.catId === catId && message.isStreaming === true;
}

function finalizeStaleBackgroundInvocationStreams(
  threadId: string,
  catId: string,
  incomingStableKey: string,
  options: HandleBackgroundMessageOptions,
  incomingInvocationId?: string,
  incomingTurnInvocationId?: string,
  incomingTimestamp?: number,
  incomingSeq?: number,
): void {
  const streamKey = `${threadId}::${catId}`;
  const activeRef = options.bgStreamRefs.get(streamKey);
  const runtimeLedger = getThreadRuntimeLedger();
  const activeLedgerRef = getActiveBubbleLedger(runtimeLedger, threadId, catId);
  const closedStableKeys = new Set<string>();
  const threadMessages = options.store.getThreadState(threadId).messages;
  for (const message of threadMessages) {
    if (!isBackgroundStreamingAssistant(message, catId)) continue;
    const stableKey = getStreamStableInvocationKey(message);
    if (!stableKey || stableKey === incomingStableKey) continue;
    // F194 follow-up (codex live-split, cloud P1 2026-06-15): mirror the active-path
    // boundary fix. A parent-ONLY seed of THIS incoming invocation (CLI tool_use built
    // the work-log bubble before invocation_created stamped the per-cat-turn id) is the
    // current turn's work-log, not a leftover stale stream. Finalizing it here (set
    // non-streaming + markReplaced) is exactly what splits the work-log bubble from the
    // later turn text. Upgrade it to the turn id + key (keep streaming) instead.
    const boundTurn = message.extra?.stream?.turnInvocationId;
    const boundInv = message.extra?.stream?.invocationId;
    // cloud P1#2 (2026-06-15): gate on the current seed — only the active/background
    // seed for this event window may be upgraded; a stale parent-only bubble from an
    // earlier turn of the same parent must finalize.
    // R18 recurrence: invocation_created can itself arrive on the background path
    // after the operator switches threads. In that case bgStreamRefs is still empty,
    // but the active path already recorded the parent-only seed in the per-thread
    // active ledger. Bridge that ledger entry here so background invocation_created
    // performs the same parent→turn upgrade the active path would have done.
    const ledgerRefForMessage =
      activeLedgerRef?.messageId === message.id &&
      activeLedgerRef.invocationId === incomingInvocationId &&
      activeLedgerRef.seedSource === 'fresh-parent-seed'
        ? {
            id: activeLedgerRef.messageId,
            threadId,
            catId,
            seedSource: activeLedgerRef.seedSource,
            freshParentSeedAt: activeLedgerRef.freshParentSeedAt,
            freshParentSeedSeq: activeLedgerRef.freshParentSeedSeq,
          }
        : undefined;
    const upgradeRef = activeRef?.id === message.id ? activeRef : ledgerRefForMessage;
    if (
      incomingTurnInvocationId &&
      incomingInvocationId &&
      boundInv === incomingInvocationId &&
      !boundTurn &&
      upgradeRef &&
      isCurrentFreshParentSeed(upgradeRef, incomingTimestamp, incomingSeq)
    ) {
      options.store.setThreadMessageStreamInvocation(
        threadId,
        message.id,
        incomingInvocationId,
        incomingTurnInvocationId,
      );
      const turnDerivedId = deriveBubbleId(incomingTurnInvocationId, catId, () => message.id);
      let shouldTrackBackgroundRef = true;
      if (turnDerivedId !== message.id) {
        const existingTurnMessage = threadMessages.find((candidate) => candidate.id === turnDerivedId);
        if (existingTurnMessage) {
          const collisionPatch = buildTurnBubbleCollisionPatch(
            message,
            existingTurnMessage,
            incomingInvocationId,
            incomingTurnInvocationId,
          );
          options.store.patchThreadMessage(threadId, turnDerivedId, collisionPatch);
          options.store.removeThreadMessage(threadId, message.id);
          shouldTrackBackgroundRef = collisionPatch.isStreaming !== false;
        } else {
          options.store.replaceThreadMessageId(threadId, message.id, turnDerivedId);
        }
      }
      if (shouldTrackBackgroundRef) {
        options.bgStreamRefs.set(streamKey, { id: turnDerivedId, threadId, catId, seedSource: 'bound' });
        setActiveBubbleLedger(runtimeLedger, threadId, catId, {
          messageId: turnDerivedId,
          invocationId: incomingInvocationId,
          seedSource: 'bound',
        });
      } else {
        options.bgStreamRefs.delete(streamKey);
        const ledgerMatchesSeed = activeLedgerRef?.messageId === message.id;
        const ledgerMatchesTurn = activeLedgerRef?.messageId === turnDerivedId;
        if (ledgerMatchesSeed ? true : ledgerMatchesTurn) {
          clearActiveBubbleLedger(runtimeLedger, threadId, catId);
        }
      }
      continue;
    }
    options.store.setThreadMessageStreaming(threadId, message.id, false);
    clearActiveBubbleLedgerForFinalizedMessage(threadId, catId, message.id);
    closedStableKeys.add(stableKey);
    if (activeRef?.id === message.id) {
      options.bgStreamRefs.delete(streamKey);
    }
  }
  for (const stableKey of closedStableKeys) {
    markReplacedInvocation(threadId, catId, stableKey);
  }
}

function mergeRichBlocksForUpgrade(
  seedBlocks: RichBlock[] = [],
  targetBlocks: RichBlock[] = [],
): RichBlock[] | undefined {
  const merged: RichBlock[] = [];
  const seen = new Set<string>();
  for (const block of [...seedBlocks, ...targetBlocks]) {
    if (seen.has(block.id)) continue;
    seen.add(block.id);
    merged.push(block);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeListById<T extends { id?: string }>(seedItems: T[] = [], targetItems: T[] = []): T[] | undefined {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const item of [...seedItems, ...targetItems]) {
    if (item.id) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    merged.push(item);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeContentBlocksForUpgrade(
  seedBlocks: ChatMessage['contentBlocks'] = [],
  targetBlocks: ChatMessage['contentBlocks'] = [],
): ChatMessage['contentBlocks'] {
  const merged: NonNullable<ChatMessage['contentBlocks']> = [];
  const seen = new Set<string>();
  for (const block of [...seedBlocks, ...targetBlocks]) {
    const key = JSON.stringify(block);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(block);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeTextForUpgrade(
  seedText: string | undefined,
  targetText: string | undefined,
  targetTextMode?: 'append' | 'replace',
): string {
  if (targetTextMode === 'replace') return targetText ? targetText : '';
  if (!seedText) return targetText ? targetText : '';
  if (!targetText) return seedText;
  return `${seedText}${targetText}`;
}

function mergeMetadataForUpgrade(
  seedMetadata: ChatMessageMetadata | undefined,
  targetMetadata: ChatMessageMetadata | undefined,
): ChatMessageMetadata | undefined {
  if (seedMetadata && targetMetadata) return { ...seedMetadata, ...targetMetadata };
  if (targetMetadata) return targetMetadata;
  return seedMetadata;
}

function buildTurnBubbleCollisionPatch(
  seed: ChatMessage,
  target: ChatMessage,
  invocationId: string,
  turnInvocationId: string,
): ChatMessagePatch {
  const extra: ChatMessage['extra'] = {
    ...seed.extra,
    ...target.extra,
    stream: {
      ...seed.extra?.stream,
      ...target.extra?.stream,
      invocationId,
      turnInvocationId,
    },
  };
  const richBlocks = mergeRichBlocksForUpgrade(seed.extra?.rich?.blocks, target.extra?.rich?.blocks);
  if (richBlocks) {
    extra.rich = { v: 1, blocks: richBlocks };
  } else {
    delete extra.rich;
  }
  const contentBlocks = mergeContentBlocksForUpgrade(seed.contentBlocks, target.contentBlocks);
  const toolEvents = mergeListById(seed.toolEvents, target.toolEvents);
  const metadata = mergeMetadataForUpgrade(seed.metadata, target.metadata);
  const deliveredAt = target.deliveredAt !== undefined ? target.deliveredAt : seed.deliveredAt;
  const replyTo = target.replyTo !== undefined ? target.replyTo : seed.replyTo;
  const replyPreview = target.replyPreview !== undefined ? target.replyPreview : seed.replyPreview;
  const thinking = mergeTextForUpgrade(seed.thinking, target.thinking);
  let isStreaming = target.isStreaming;
  if (target.isStreaming !== false && seed.isStreaming) {
    isStreaming = true;
  }
  const mentionsUser = seed.mentionsUser ? true : target.mentionsUser;

  return {
    content: mergeTextForUpgrade(seed.content, target.content, target.extra?.stream?.textMode),
    ...(contentBlocks ? { contentBlocks } : {}),
    ...(toolEvents ? { toolEvents } : {}),
    ...(metadata ? { metadata } : {}),
    ...(thinking ? { thinking } : {}),
    timestamp: Math.min(seed.timestamp, target.timestamp),
    isStreaming,
    extra,
    ...(mentionsUser ? { mentionsUser: true } : {}),
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    ...(replyTo !== undefined ? { replyTo } : {}),
    ...(replyPreview !== undefined ? { replyPreview } : {}),
  };
}

function findBackgroundInvocationCreatedTarget(
  msg: BackgroundAgentMessage,
  targetCatId: string,
  existingRef: BackgroundStreamRef | undefined,
  incomingStableKey: string,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const streamKey = `${msg.threadId}::${targetCatId}`;
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  const isEligible = (message: ChatMessage | undefined): message is ChatMessage => {
    if (!message || !isBackgroundStreamingAssistant(message, targetCatId)) return false;
    const stableKey = getStreamStableInvocationKey(message);
    return !stableKey || stableKey === incomingStableKey;
  };

  if (existingRef?.id) {
    const existing = threadMessages.find((message) => message.id === existingRef.id);
    if (isEligible(existing)) {
      options.bgStreamRefs.set(streamKey, {
        id: existing.id,
        threadId: msg.threadId,
        catId: targetCatId,
        seedSource: 'bound',
      });
      if (msg.metadata) {
        options.store.setThreadMessageMetadata(msg.threadId, existing.id, msg.metadata);
      }
      return existing.id;
    }
  }

  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const message = threadMessages[i];
    if (!isEligible(message)) continue;
    options.bgStreamRefs.set(streamKey, {
      id: message.id,
      threadId: msg.threadId,
      catId: targetCatId,
      seedSource: 'bound',
    });
    if (msg.metadata) {
      options.store.setThreadMessageMetadata(msg.threadId, message.id, msg.metadata);
    }
    return message.id;
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
  let systemInfo: SystemInfoProjection | undefined;

  try {
    const parsed = JSON.parse(sysContent);
    const visible = formatVisibleSystemInfo(parsed, options.resolveCatName, msg.catId);
    if (visible) {
      sysContent = visible.content;
      sysVariant = visible.variant;
      systemInfo = retainSystemInfo(parsed, msg.catId);
    } else if (parsed?.type === 'invocation_created') {
      const targetCatId = parsed.catId ?? msg.catId;
      // Identity canonicalization (砚砚 GPT-5.5 2026-04-26): outer wrapper invocationId
      // is the user-turn parent; parsed JSON content invocationId is inner auth child.
      // Prefer outer to keep bubble identity stable across stream/callback/done events
      // (otherwise active path gets `msg-outer-cat` and bg path gets `msg-inner-cat` →
      // dup bubble). thread_mogj6kvwp3l80x56 case.
      const invocationId =
        msg.invocationId ?? (typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined);
      // F194 Phase Z3 P1-1 (砚砚 R): turn id (per-cat-turn invocation) for bubble identity SoT.
      // Priority: msg.turnInvocationId (Z3 broadcast) > parsed.invocationId (raw inner child id)
      // > undefined. invocationId stays parent (legacy chain SoT for liveness/queue/cancel).
      const turnInvocationId =
        msg.turnInvocationId ??
        (typeof parsed.invocationId === 'string' && parsed.invocationId !== invocationId
          ? parsed.invocationId
          : undefined);
      // #586: Clear stale finalizedBgRef so previous invocation's finalized bubble
      // can't be overwritten by the next invocation's callback.
      const bgStreamKey = `${msg.threadId}::${targetCatId}`;
      options.finalizedBgRefs.delete(bgStreamKey);
      if (targetCatId && invocationId) {
        const incomingStableKey = turnInvocationId ?? invocationId;
        finalizeStaleBackgroundInvocationStreams(
          msg.threadId,
          targetCatId,
          incomingStableKey,
          options,
          invocationId,
          turnInvocationId,
          msg.timestamp,
          msg.seq,
        );
        options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
          invocationId,
          ...(turnInvocationId ? { turnInvocationId } : {}),
          startedAt: Date.now(),
          taskProgress: {
            tasks: [],
            lastUpdate: Date.now(),
            snapshotStatus: 'running',
            lastInvocationId: invocationId,
          },
        });
        const targetId = findBackgroundInvocationCreatedTarget(
          msg,
          targetCatId,
          existingRef,
          incomingStableKey,
          options,
        );
        if (targetId) {
          // F194 Phase Z3 R12 P1: forward turnInvocationId so background bind preserves dual id
          options.store.setThreadMessageStreamInvocation(msg.threadId, targetId, invocationId, turnInvocationId);
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
        // F230: write model/provider FIRST so setThreadMessageMetadata creates the
        // metadata object when absent (PTY text events carry no metadata).
        // setThreadMessageUsage is a no-op when metadata is absent — ordering matters.
        if (parsed.model && parsed.provider) {
          options.store.setThreadMessageMetadata(msg.threadId, existingRef.id, {
            model: parsed.model as string,
            provider: parsed.provider as string,
          });
        }
        options.store.setThreadMessageUsage(msg.threadId, existingRef.id, parsed.usage);
      }
      consumed = true;
    } else if (parsed?.type === 'context_briefing') {
      // Suppress: internal routing context for cats, not user-facing timeline.
      // The briefing is already persisted in messageStore for cat context assembly.
      consumed = true;
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
        const threadState = options.store.getThreadState(msg.threadId);
        const invocationId = msg.invocationId ?? threadState.catInvocations[msg.catId]?.invocationId;
        const turnInvocationId = msg.turnInvocationId ?? threadState.catInvocations[msg.catId]?.turnInvocationId;
        setBackgroundPlaceholderStreamRef(
          options,
          streamKey,
          targetId,
          msg.threadId,
          msg.catId,
          invocationId,
          turnInvocationId,
          msg.timestamp,
          msg.seq,
        );
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId
            ? {
                extra: {
                  stream: {
                    invocationId,
                    ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
                  },
                },
              }
            : {}),
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
      const richBlockHasExplicitInvocation = Boolean(
        msg.invocationId ?? msg.turnInvocationId ?? parsed.invocationId ?? parsed.turnInvocationId,
      );
      if (!targetId && !richBlockHasExplicitInvocation) {
        // F194 Phase Z6: rich/audio blocks can arrive just after `done` finalized the stream
        // bubble and cleared bgStreamRefs. Reuse the exact finalized stream bubble so live
        // state self-heals before F5 instead of creating a transient bg-rich small bubble.
        // Cloud P1 (PR #1623): this fallback is only safe for invocationless late events.
        // If the rich block already carries a new invocation/turn id, using the previous
        // finalized ref would splice the next turn's media into the old bubble.
        const streamKey = `${msg.threadId}::${msg.catId}`;
        const finalizedId = options.finalizedBgRefs.get(streamKey);
        const finalized = finalizedId
          ? options.store
              .getThreadState(msg.threadId)
              .messages.find(
                (m) => m.id === finalizedId && m.type === 'assistant' && m.catId === msg.catId && m.origin === 'stream',
              )
          : undefined;
        if (finalized) targetId = finalized.id;
      }
      if (!targetId) {
        // No existing bubble — create placeholder (mirrors foreground ensureActiveAssistantMessage)
        const streamKey = `${msg.threadId}::${msg.catId}`;
        targetId = `bg-rich-${Date.now()}-${msg.catId}-${options.nextBgSeq()}`;
        const threadState = options.store.getThreadState(msg.threadId);
        const invocationId = msg.invocationId ?? threadState.catInvocations[msg.catId]?.invocationId;
        const turnInvocationId = msg.turnInvocationId ?? threadState.catInvocations[msg.catId]?.turnInvocationId;
        setBackgroundPlaceholderStreamRef(
          options,
          streamKey,
          targetId,
          msg.threadId,
          msg.catId,
          invocationId,
          turnInvocationId,
          msg.timestamp,
          msg.seq,
        );
        options.store.addMessageToThread(msg.threadId, {
          id: targetId,
          type: 'assistant',
          catId: msg.catId,
          content: '',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId
            ? {
                extra: {
                  stream: {
                    invocationId,
                    ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
                  },
                },
              }
            : {}),
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
    } else if (parsed?.type === 'agy_trajectory_progress') {
      // F210-H3: 累积进度到 thread 级 catStatusDetails（折叠单行 "AGY working · N steps · latest"），
      // 由 ThreadCatStatus 显示；不渲染 system bubble（承接 H1-hotfix 避免 per-step 刷屏）。
      if (msg.catId && msg.threadId) {
        options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming', formatAgyProgressDetail(parsed));
      }
      consumed = true;
    } else if (parsed?.type === 'provider_capability') {
      // #939 part A (kimi auth dual-path): capability telemetry from provider backends
      // (kimi emits `thinking: unavailable` / `image_input: limited`, etc.). Mirror of the
      // foreground branch (~line 5123) but using the background chain `options.store.*` API.
      // F210-H1 dual-handler pattern: BOTH foreground and background chains must handle the
      // same telemetry type — otherwise kimi running in a background thread still surfaces
      // raw JSON bubbles (the original #939 bug). Caught by [宪宪/opus-4.6] review of #2352.
      // Note: || (not ??) so empty-string parsed.catId falls through to msg.catId.
      const targetCatId = (parsed.catId || msg.catId) as string | undefined;
      const capability = typeof parsed.capability === 'string' ? parsed.capability : 'unknown';
      const status =
        parsed.status === 'available' || parsed.status === 'limited' || parsed.status === 'unavailable'
          ? parsed.status
          : 'unavailable';
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
      const provider = typeof parsed.provider === 'string' ? parsed.provider : 'unknown';
      if (targetCatId && msg.threadId) {
        // Read-merge-write so multiple capabilities coexist on the same cat invocation
        // (setThreadCatInvocation is shallow-merged, so passing a fresh object would clobber).
        const existing =
          options.store.getThreadState(msg.threadId).catInvocations?.[targetCatId]?.providerCapabilities ?? {};
        options.store.setThreadCatInvocation(msg.threadId, targetCatId, {
          providerCapabilities: {
            ...existing,
            [capability]: { status, reason, provider, receivedAt: Date.now() },
          },
        });
      }
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
    } else if (isInternalSystemInfoTelemetry(parsed)) {
      // Internal telemetry — suppress to avoid raw JSON bubbles in background threads
      consumed = true;
    } else if (parsed?.type === 'session_seal_requested') {
      if (parsed.catId) {
        options.store.setThreadCatInvocation(msg.threadId, parsed.catId, {
          sessionSeq: parsed.sessionSeq,
          sessionSealed: true,
        });
        const visibleSessionSeal = formatSessionSealRequested(parsed, options.resolveCatName);
        if (visibleSessionSeal) {
          sysContent = visibleSessionSeal.content;
          systemInfo = retainSystemInfo(parsed, msg.catId);
        }
      }
    } else if (parsed?.type === 'mode_switch_proposal') {
      const by = parsed.proposedBy ?? '猫猫';
      sysContent = `${resolveBackgroundCatName(options, by)} 提议切换到 ${parsed.proposedMode} 模式。`;
    } else if (parsed?.type === 'silent_completion') {
      // Bugfix: silent-exit — cat ran tools but produced no text response
      const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
      sysContent = detail || `${resolveBackgroundCatName(options, msg.catId)} completed without a text response.`;
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
          const threadState = options.store.getThreadState(msg.threadId);
          const invocationId = msg.invocationId ?? threadState.catInvocations[msg.catId]?.invocationId;
          const turnInvocationId = msg.turnInvocationId ?? threadState.catInvocations[msg.catId]?.turnInvocationId;
          setBackgroundPlaceholderStreamRef(
            options,
            streamKey,
            targetId,
            msg.threadId,
            msg.catId,
            invocationId,
            turnInvocationId,
            msg.timestamp,
            msg.seq,
          );
          options.store.addMessageToThread(msg.threadId, {
            id: targetId,
            type: 'assistant',
            catId: msg.catId,
            content: '',
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(invocationId
              ? {
                  extra: {
                    stream: {
                      invocationId,
                      ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
                    },
                  },
                }
              : {}),
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

  return { consumed, content: sysContent, variant: sysVariant, systemInfo };
}

const BACKGROUND_STATUS_MAP: Record<string, CatStatusType> = {
  streaming: 'streaming',
  thinking: 'pending',
  done: 'done',
};

function getStreamKey(msg: Pick<BackgroundAgentMessage, 'threadId' | 'catId'>): string {
  return `${msg.threadId}::${msg.catId}`;
}

/**
 * F183 Phase C — thread-scoped sequence number tracking + gap detection (KD-9).
 *
 * Pure function over chatStore — extracted for unit testability without React harness.
 * Caller passes the live store; we read `lastSeqByThread` + `lastSeqEpochByThread`,
 * decide action, write back.
 *
 * Behavior:
 * - msg.seq undefined / 0 → no-op (legacy producer, graceful degradation)
 * - msg.seqEpoch differs from lastSeqEpoch (and lastSeq>0) → epoch-change (server
 *   restart, sequencer instance changed) → reset lastSeq + trigger catchup +
 *   seed with new (epoch, seq). 砚砚 R1 P1 fix: without this, server restart
 *   silently breaks gap detection until server's new seq exceeds client's stale
 *   high-water mark (potentially many "late" rejections during catch-up window).
 * - msg.seq present, lastSeq=0 → first event for this thread, seed lastSeq + epoch
 * - msg.seq <= lastSeq → late event (out-of-order or duplicate); record debug, don't update
 * - msg.seq === lastSeq+1 → monotonic advance, update lastSeq
 * - msg.seq > lastSeq+1 → GAP. record `pendingCatchUpTargetSeq=incomingSeq`,
 *   fire `requestStreamCatchUp(threadId)`, do **NOT** advance lastSeq (cloud
 *   P1 watermark preservation — failed/canceled fetch must keep retrying).
 *   useChatHistory's fetchHistory.then() captures pending at fetch START and
 *   calls `acknowledgeCatchUp(threadId, capturedTarget)` on success — that
 *   advances lastSeq to capturedTarget and clears pending only if pending
 *   still equals capturedTarget (砚砚 R6 P1 stale-fetch race fix).
 *
 * Returns the action taken for diagnostics / test assertion.
 */
export type ThreadSeqAction = 'no-op' | 'seed' | 'advance' | 'late' | 'gap' | 'epoch-change';

interface ThreadSeqStore {
  readonly lastSeqByThread: Record<string, number>;
  readonly lastSeqEpochByThread: Record<string, string>;
  /** Cloud R2 P1-B fix — pending lookup needed in seed branch to detect ongoing recovery. */
  readonly pendingCatchUpTargetSeqByThread: Record<string, number>;
  setLastSeq: (threadId: string, seq: number) => void;
  setLastSeqEpoch: (threadId: string, epoch: string) => void;
  /** 砚砚 R5 P1 fix — record pending target so acknowledgeCatchUp can advance lastSeq on success. */
  setPendingCatchUpTargetSeq: (threadId: string, seq: number) => void;
  requestStreamCatchUp: (threadId: string) => void;
}

export function processThreadSeq(
  msg: { threadId?: string; seq?: number; seqEpoch?: string },
  store: ThreadSeqStore,
): ThreadSeqAction {
  if (!msg.threadId) return 'no-op';
  const incomingSeq = msg.seq;
  if (typeof incomingSeq !== 'number' || incomingSeq <= 0) return 'no-op';

  const lastSeq = store.lastSeqByThread[msg.threadId] ?? 0;
  const lastEpoch = store.lastSeqEpochByThread[msg.threadId] ?? '';
  const incomingEpoch = msg.seqEpoch ?? '';
  const pendingTarget = store.pendingCatchUpTargetSeqByThread[msg.threadId] ?? 0;

  // Epoch change detection (砚砚 R1 P1 fix). Only fires when:
  //   - we have a tracked lastEpoch (i.e. we've seen at least one seq before)
  //   - incoming msg carries a different epoch
  // Skip when lastEpoch=='' (no prior tracking) — that's a fresh seed, handled
  // below by the seq=0 branch. Skip when incomingEpoch=='' (legacy emitter that
  // doesn't include epoch) — fall through to seq-only logic to preserve bw-compat.
  if (lastSeq > 0 && lastEpoch && incomingEpoch && lastEpoch !== incomingEpoch) {
    // Server restarted — sequencer instance changed.
    //
    // Cloud R2 P1-B fix (2026-05-02): DO NOT advance lastSeq to incomingSeq
    // immediately before catch-up confirms. If first post-restart packet has
    // seq>1 (server already missed seqs 1..incomingSeq-1 from client) and
    // catch-up fails, subsequent live events at incomingSeq+1, +2 would route
    // as 'advance' (normal monotonic) — never retriggering recovery. Missing
    // early range stays missing forever.
    //
    // Fix: setEpoch (so next event doesn't re-trigger epoch-change) +
    // reset lastSeq=0 (new epoch space, old watermark meaningless) +
    // record pending=incomingSeq + fire catchup. Subsequent live events
    // hit the lastSeq=0 + pending>0 path in seed branch below — re-route as
    // 'gap' (refresh pending, refire catchup) until ack closes the loop.
    store.setLastSeqEpoch(msg.threadId, incomingEpoch);
    store.setLastSeq(msg.threadId, 0);
    store.setPendingCatchUpTargetSeq(msg.threadId, incomingSeq);
    store.requestStreamCatchUp(msg.threadId);
    return 'epoch-change';
  }

  if (lastSeq === 0) {
    // Cloud R2 P1-B fix: if pending recovery from prior gap/epoch-change
    // is in flight (pendingTarget > 0), DON'T seed — that would advance
    // lastSeq past the missing range and lose the retry trigger. Instead,
    // treat as continuing 'gap' state: refresh pending if higher, refire
    // catchup. Recovery only closes via acknowledgeCatchUp (HTTP success).
    if (pendingTarget > 0) {
      if (incomingSeq > pendingTarget) {
        store.setPendingCatchUpTargetSeq(msg.threadId, incomingSeq);
      }
      store.requestStreamCatchUp(msg.threadId);
      return 'gap';
    }
    // Seed: first seq-bearing event for this thread; no gap can be detected
    // because we don't know prior history. Capture epoch alongside seed.
    store.setLastSeq(msg.threadId, incomingSeq);
    if (incomingEpoch) store.setLastSeqEpoch(msg.threadId, incomingEpoch);
    return 'seed';
  }

  if (incomingSeq <= lastSeq) {
    // Late event by seq (out-of-order or duplicate). Don't drop here — downstream
    // stable-key dedup handles content; dropping by seq alone could mask real
    // out-of-order delivery for diagnosis. Caller decides drop semantics.
    return 'late';
  }

  if (incomingSeq > lastSeq + 1) {
    // Gap detected. Fire full catchup (HTTP fetch + reducer dedup reconciles content).
    //
    // Cloud P1 fix (2026-05-02): DO NOT advance lastSeq on gap.
    // Optimistically advancing puts the missing range "behind the watermark"
    // — if the subsequent HTTP fetchHistory fails or is canceled, future
    // in-order events become 'advance' and the gap silently never retriggers
    // catch-up; dropped messages remain missing for the rest of the session.
    //
    // 砚砚 R5 P1 fix (2026-05-02): record pending catch-up target so
    // acknowledgeCatchUp can advance lastSeq once fetchHistory succeeds.
    // Without this ack mechanism, fetchHistory success would NOT clear the
    // gap state — `lastSeq=5` stays stuck while server emits 9/10/11, all
    // routed as 'gap', perpetual catchup storm. Phase C goal is "no F5
    // needed"; relying on F5 to reset lastSeq violates that.
    //
    // Pending target = current incomingSeq (monotonic within epoch — each
    // gap event has a higher seq than the prior, so simple assignment is
    // safe; no need for max() over prior pending). On fetch failure:
    // pending stays, lastSeq stays at watermark, subsequent events keep
    // firing 'gap' with refreshed pending — eventual fetch success advances
    // lastSeq to latest pending target.
    store.setPendingCatchUpTargetSeq(msg.threadId, incomingSeq);
    store.requestStreamCatchUp(msg.threadId);
    return 'gap';
  }

  // incomingSeq === lastSeq + 1: monotonic advance
  store.setLastSeq(msg.threadId, incomingSeq);
  return 'advance';
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

function getBackgroundPlaceholderSeedSource(
  invocationId: string | undefined,
  turnInvocationId: string | undefined,
): ActiveSeedSource | undefined {
  // System-info placeholders are current-turn seeds when only the parent id is known.
  if (turnInvocationId) return 'bound';
  return invocationId ? 'fresh-parent-seed' : undefined;
}

function setBackgroundPlaceholderStreamRef(
  options: HandleBackgroundMessageOptions,
  streamKey: string,
  id: string,
  threadId: string,
  catId: string,
  invocationId: string | undefined,
  turnInvocationId: string | undefined,
  timestamp: number | undefined,
  seq: number | undefined,
): void {
  const seedSource = getBackgroundPlaceholderSeedSource(invocationId, turnInvocationId);
  const ref: BackgroundStreamRef = { id, threadId, catId };
  if (seedSource) ref.seedSource = seedSource;
  Object.assign(ref, freshParentSeedProof(seedSource, timestamp, seq));
  options.bgStreamRefs.set(streamKey, ref);
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
  clearActiveBubbleLedgerForFinalizedMessage(msg.threadId, msg.catId, existing.id);
  return existing;
}

function clearActiveBubbleLedgerForFinalizedMessage(threadId: string, catId: string, messageId: string): void {
  const ledger = getThreadRuntimeLedger();
  const activeEntry = getActiveBubbleLedger(ledger, threadId, catId);
  if (activeEntry?.messageId === messageId) {
    clearActiveBubbleLedger(ledger, threadId, catId);
  }
}

function addBackgroundSystemMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
  content: string,
  variant: 'info' | 'a2a_followup' = 'info',
  extra?: ChatMessage['extra'],
): void {
  const id =
    extra?.systemKind === 'a2a_routing' && msg.messageId
      ? msg.messageId
      : `bg-sys-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`;
  options.store.addMessageToThread(msg.threadId, {
    id,
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
  const activeRef = options.bgStreamRefs.get(streamKey);
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const m = threadMessages[i];
    if (m.type === 'assistant' && m.catId === msg.catId && m.isStreaming) {
      if (shouldSkipBackgroundParentOnlyResidueRecovery(m, msg, options, activeRef)) continue;
      options.bgStreamRefs.set(streamKey, {
        id: m.id,
        threadId: msg.threadId,
        catId: msg.catId,
        seedSource: 'recovered',
      });
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
): { id: string; invocationId: string | null; suppressionKey: string | null } | null {
  const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
  // F194 Phase Z3 R4 P1-2 (砚砚): replacement target match must use stable key (turn > parent)
  // so same-parent multi-turn callback doesn't bind to wrong turn's stream bubble.
  const incomingStableKey = msg.turnInvocationId ?? invocationId;

  const threadMessages = options.store.getThreadState(msg.threadId).messages;

  // Try invocationId-based match first (using turn-priority stable key)
  if (incomingStableKey) {
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (
        m?.type === 'assistant' &&
        m.catId === msg.catId &&
        m.origin === 'stream' &&
        getBubbleInvocationId(m) === incomingStableKey
      ) {
        // F194 Phase Z3 R16 (cloud Codex P1): suppressionKey is per-turn (turn > parent)
        // so same-parent multi-turn doesn't cross-kill sibling turns via parent set entry.
        return { id: m.id, invocationId: invocationId ?? null, suppressionKey: incomingStableKey };
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
      // F194 Phase Z3 R21 (cloud Codex P1): invocationless placeholder fallback —
      // suppression key prefers incoming msg's turn id (msg.turnInvocationId) when
      // present so subsequent late chunks (which check via turn-priority key per R16)
      // hit the suppression set. Falls back to parent invocationId for legacy.
      const suppressionKey = msg.turnInvocationId ?? invocationId ?? null;
      return { id: m.id, invocationId: invocationId ?? null, suppressionKey };
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
      // Finalized fallback — read turn key from the stored bubble's extra.stream
      // so suppression keys per-turn (consistent with primary-path replacement target).
      const finalizedTurn = finalized.extra?.stream?.turnInvocationId;
      const suppressionKey = finalizedTurn ?? finalized.extra?.stream?.invocationId ?? invocationId ?? null;
      return { id: finalized.id, invocationId: invocationId ?? null, suppressionKey };
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
  // F194 Phase Z3 R16 (cloud Codex P1): suppression key prefers turn id when present so
  // siblings under same parent chain don't get cross-suppressed by parent-keyed entry.
  const suppressionKey = msg.turnInvocationId ?? msg.invocationId;
  if (suppressionKey) {
    if (isInvocationReplaced(msg.threadId, msg.catId, suppressionKey)) {
      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: msg.threadId,
        timestamp: msg.timestamp,
        action: 'drop',
        reason: 'late_stream_after_callback_replace',
        catId: msg.catId,
        invocationId: suppressionKey,
        origin: 'stream',
      });
      return true;
    }
    // Cloud P1#6 (PR#1352): fresh explicit invocationId — clean stale catInvocations
    // entry from replaced set so subsequent invocationless follow-ups aren't mis-suppressed.
    const stale = getThreadInvocationId(msg, options);
    if (stale && stale !== suppressionKey && isInvocationReplaced(msg.threadId, msg.catId, stale)) {
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

function isBackgroundCallbackStillStreaming(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): boolean {
  if (!msg.invocationId) return false;
  return options.store
    .getThreadState(msg.threadId)
    .messages.some(
      (m) =>
        m.type === 'assistant' &&
        m.catId === msg.catId &&
        m.origin === 'stream' &&
        m.isStreaming === true &&
        sameBubbleStableKey(m, (msg.turnInvocationId ?? msg.invocationId)!, msg.catId),
    );
}

function deferBackgroundCallbackIfStreamOpen(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): boolean {
  if (!msg.invocationId || !options.pendingCallbacks) return false;
  if (!isBackgroundCallbackStillStreaming(msg, options)) return false;
  if (options.deferPendingCallback) {
    options.deferPendingCallback(msg, msg.threadId);
  } else {
    options.pendingCallbacks.set(pendingCallbackKey(msg.threadId, msg.catId, msg.invocationId), msg);
  }
  return true;
}

function drainPendingBackgroundCallback(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions): void {
  if (!msg.invocationId || !options.pendingCallbacks) return;
  const key = pendingCallbackKey(msg.threadId, msg.catId, msg.invocationId);
  const pending = options.pendingCallbacks.get(key) as BackgroundAgentMessage | undefined;
  if (!pending) return;
  if (options.deletePendingCallback) {
    options.deletePendingCallback(msg.threadId, msg.catId, msg.invocationId);
  } else {
    options.pendingCallbacks.delete(key);
  }
  for (const message of options.store.getThreadState(msg.threadId).messages) {
    if (
      message.type === 'assistant' &&
      message.catId === msg.catId &&
      message.origin === 'stream' &&
      message.isStreaming === true &&
      sameBubbleStableKey(message, msg.turnInvocationId ?? msg.invocationId, msg.catId)
    ) {
      options.store.setThreadMessageStreaming(msg.threadId, message.id, false);
      clearActiveBubbleLedgerForFinalizedMessage(msg.threadId, msg.catId, message.id);
    }
  }
  handleBackgroundAgentMessage(pending, options);
}

function ensureBackgroundAssistantMessage(
  msg: BackgroundAgentMessage,
  streamKey: string,
  existing: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): string {
  const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
  // F194 dual-path thread-switch fix (saga round 17): when a codex reply's events
  // straddle a mid-reply currentThreadId switch, the trailing tool/work-log events
  // (which carry NO msg.turnInvocationId) arrive on the background path. Resolving
  // the turn from catInvocations alone can pick up a DIFFERENT (shadow) turn left by
  // a newer invocation context → a second, empty work-log bubble (split). Recover
  // the turn the ACTIVE path already bound for THIS reply's thread (msg.threadId —
  // NOT the now-current thread) from the runtime ledger first, so both paths resolve
  // the same turn → one bubble. Genuinely different invocation_created turns each
  // own a distinct bound ledger bubble → still resolve distinct turns (Z3-safe).
  const turnInvocationId =
    msg.turnInvocationId ??
    getActiveBoundTurnInvocationIdLedger(getThreadRuntimeLedger(), msg.threadId, msg.catId) ??
    options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.turnInvocationId;
  const forceFreshParentSeed =
    (msg.type === 'tool_use' || msg.type === 'tool_result') && turnInvocationId === undefined;
  const canReuseExisting =
    !!existing?.id && (!forceFreshParentSeed || isCurrentFreshParentSeed(existing, msg.timestamp, msg.seq));

  if (canReuseExisting) {
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

  const hasResidue = !turnInvocationId && hasBackgroundParentOnlyResidue(msg, invocationId, existing, options);
  // F194 Phase Z3 R17 (cloud Codex P1#3): bubble id seeded with turn-priority key so
  // same-parent multi-turn from one cat produces distinct bubbles (otherwise dedup
  // by parent-only id collapses sibling turns under same chain).
  const messageId = deriveBubbleId(turnInvocationId ?? (hasResidue ? undefined : invocationId), msg.catId, () =>
    nextProvisionalBubbleId(msg.catId),
  );
  const seedSource: ActiveSeedSource = turnInvocationId ? 'bound' : 'fresh-parent-seed';
  options.bgStreamRefs.set(streamKey, {
    id: messageId,
    threadId: msg.threadId,
    catId: msg.catId,
    seedSource,
    ...freshParentSeedProof(seedSource, msg.timestamp, msg.seq),
  });
  options.store.addMessageToThread(msg.threadId, {
    id: messageId,
    type: 'assistant',
    catId: msg.catId,
    content: '',
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
    ...(invocationId && (turnInvocationId || !hasResidue)
      ? {
          extra: {
            stream: {
              invocationId,
              ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
            },
          },
        }
      : {}),
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
      // #814 P2: explicit post_message must bypass stream-open deferral. The deferral
      // stores callbacks keyed by thread/cat/invocation (no messageId), so multiple
      // explicit posts from the same invocation overwrite each other and are delayed
      // until stream end. Explicit posts are standalone — apply them immediately.
      if (!msg.extra?.isExplicitPost && deferBackgroundCallbackIfStreamOpen(msg, options)) {
        return;
      }
      // #814: explicit post_message is a standalone message — skip replacement target
      // lookup to avoid replacing existing stream bubble or marking the invocation as
      // replaced, which would kill subsequent stream chunks (symmetric with active path).
      const replacementTarget = msg.extra?.isExplicitPost
        ? null
        : findBackgroundCallbackReplacementTarget(msg, options);
      if (replacementTarget) {
        const cbId = msg.messageId ?? replacementTarget.id;
        if (cbId !== replacementTarget.id) {
          options.store.replaceThreadMessageId(msg.threadId, replacementTarget.id, cbId);
        }

        // F183 Phase B1.8 — bg callback (with replacementTarget) wire-up via reducer.
        // canonical invocationId 走 reducer 的 reduceCallbackFinal stable-key match
        // 或 invocationless+messageId hint (caller 已经 replaceThreadMessageId 把
        // existing bubble 改名成 cbId)。reducer 命中后就地 patch (content/origin/
        // isStreaming)；reducer no-op (event undefined / recoveryAction !== none) 时
        // fallback legacy patchThreadMessage 保 content。side-fields (metadata /
        // extra.crossPost / mentionsUser / replyTo / replyPreview) reducer 不 model，
        // 单独 patchThreadMessage 写。
        let bgCallbackHandled = false;
        if (msg.invocationId) {
          const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
          if (event) {
            const eventWithMsgId = { ...event, messageId: cbId };
            const threadState = options.store.getThreadState(msg.threadId);
            const result = applyBubbleEventWithRecovery({
              threadId: msg.threadId,
              event: eventWithMsgId,
              currentMessages: threadState.messages,
            });
            if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
              options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
              bgCallbackHandled = true;
            }
            if (result.violations.length > 0) {
              for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
            }
          }
        }

        const sidePatch: Partial<ChatMessage> = {
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.extra?.crossPost || msg.extra?.isExplicitPost
            ? {
                extra: {
                  ...(msg.extra.crossPost ? { crossPost: msg.extra.crossPost } : {}),
                  ...(msg.extra.isExplicitPost ? { isExplicitPost: true as const } : {}),
                },
              }
            : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
        };
        if (!bgCallbackHandled) {
          options.store.patchThreadMessage(msg.threadId, cbId, {
            content: msg.content,
            origin: 'callback',
            isStreaming: false,
            ...sidePatch,
          });
        } else if (Object.keys(sidePatch).length > 0) {
          options.store.patchThreadMessage(msg.threadId, cbId, sidePatch);
        }
        options.bgStreamRefs.delete(streamKey);
        // Consume finalized ref — callback successfully replaced
        options.finalizedBgRefs.delete(streamKey);
        // #586 P1-2 fix: Only set replacedInvocations when we have a real invocationId.
        // Fallback matches return null — writing a pseudo ID would permanently suppress
        // future invocationless stream chunks via shouldSuppressLateBackgroundStreamChunk.
        if (replacementTarget.suppressionKey) {
          // F173 A.6 — write to shared module so active handler also sees suppression on switch back.
          // F194 Phase Z3 R16 (cloud Codex P1): suppressionKey is per-turn (turn > parent) so
          // same-parent multi-turn doesn't cross-suppress sibling turns under same chain.
          markReplacedInvocation(msg.threadId, msg.catId, replacementTarget.suppressionKey);
        }
        finalMsgId = cbId;
      } else {
        // F173 A.3 — server-issued messageId wins; otherwise derive from invocationId.
        // F194 Phase Z3 R17 (cloud Codex P1#2): bg callback bubble id seeded with
        // turn-priority key so same-parent multi-turn callbacks from one cat
        // produce distinct bubbles instead of dedup-collapsing onto first turn.
        const cbInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
        const cbBubbleSeed = msg.turnInvocationId ?? cbInvocationId;
        const cbId =
          msg.messageId ??
          deriveBubbleId(cbBubbleSeed, msg.catId, () => `bg-cb-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`);

        // F183 Phase B1.8 — bg callback (no replacementTarget) wire-up via reducer。
        // canonical invocationId 走 reducer 的 reduceCallbackFinal — 没 existing 时
        // makePlaceholder 创建新 bubble，origin=callback + isStreaming=false +
        // extra.stream.invocationId（缺这条会让 hydration 丢 identity binding，F5
        // 后 ghost bubble 复活，砚砚 R1 P1 见 F183 B1.7）。reducer no-op 时 fallback
        // legacy addMessageToThread。bg thread 新 bubble 必须 +1 unread badge
        // （replaceThreadMessages 不像 addMessageToThread 自动 +unread）。
        let bgCallbackHandled = false;
        if (msg.invocationId) {
          const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
          if (event) {
            const eventWithMsgId = { ...event, messageId: cbId };
            const threadState = options.store.getThreadState(msg.threadId);
            const prevLen = threadState.messages.length;
            const result = applyBubbleEventWithRecovery({
              threadId: msg.threadId,
              event: eventWithMsgId,
              currentMessages: threadState.messages,
            });
            if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
              options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
              bgCallbackHandled = true;
              if (result.nextMessages.length > prevLen) {
                options.store.incrementUnread(msg.threadId);
              }
            }
            if (result.violations.length > 0) {
              for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
            }
          }
        }

        if (!bgCallbackHandled) {
          options.store.addMessageToThread(msg.threadId, {
            id: cbId,
            type: 'assistant',
            catId: msg.catId,
            content: msg.content,
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(msg.extra?.crossPost || msg.extra?.isExplicitPost || msg.extra?.targetCats
              ? {
                  extra: {
                    ...(msg.extra.crossPost ? { crossPost: msg.extra.crossPost } : {}),
                    ...(msg.extra.isExplicitPost ? { isExplicitPost: true as const } : {}),
                    ...(msg.extra.targetCats ? { targetCats: msg.extra.targetCats } : {}),
                  },
                }
              : {}),
            ...(msg.mentionsUser ? { mentionsUser: true } : {}),
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
            timestamp: msg.timestamp,
            origin: 'callback',
          });
        } else {
          // Side-fields after reducer success (reducer 不 model 这些)
          const sidePatch: Partial<ChatMessage> = {
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(msg.extra?.crossPost || msg.extra?.isExplicitPost || msg.extra?.targetCats
              ? {
                  extra: {
                    ...(msg.extra.crossPost ? { crossPost: msg.extra.crossPost } : {}),
                    ...(msg.extra.isExplicitPost ? { isExplicitPost: true as const } : {}),
                    ...(msg.extra.targetCats ? { targetCats: msg.extra.targetCats } : {}),
                  },
                }
              : {}),
            ...(msg.mentionsUser ? { mentionsUser: true } : {}),
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          };
          if (Object.keys(sidePatch).length > 0) {
            options.store.patchThreadMessage(msg.threadId, cbId, sidePatch);
          }
        }
        // #586 Bug 1 (TD112): Callback created new bubble without finding a stream
        // placeholder. Mark invocation as replaced so late background stream chunks
        // are suppressed instead of spawning a duplicate bubble.
        // #814: explicit post_message is standalone — must NOT mark invocation as
        // replaced, otherwise subsequent stream chunks from the same invocation get
        // killed (symmetric with active-path guard in applyActiveExplicitCallbackNow).
        // F194 Phase Z3 R16 (cloud Codex P1): suppression key prefers turn id when
        // present so siblings under same parent chain don't cross-suppress.
        if (!msg.extra?.isExplicitPost) {
          const bgInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
          const bgSuppressionKey = msg.turnInvocationId ?? bgInvocationId;
          if (bgSuppressionKey) {
            // F173 A.6 — shared module Map.
            markReplacedInvocation(msg.threadId, msg.catId, bgSuppressionKey);
          }
        }
        finalMsgId = cbId;
      }
    } else {
      if (shouldSuppressLateBackgroundStreamChunk(msg, streamKey, options)) {
        return;
      }
      // F183 Phase B1.8 — bg stream chunk wire-up via reducer (single-writer)。
      // canonical invocationId 走 reducer 的 reduceStreamChunk — existing bubble
      // append/replace content；no existing 时 makePlaceholder 创建新 bubble (origin=
      // stream + isStreaming=true + extra.stream.invocationId)。reducer 不 model
      // isStreaming 翻转和 catStatus，必须 caller 显式调 setThreadMessageStreaming +
      // updateThreadCatStatus（msg.isFinal 时 false/done，否则保持 streaming）。
      // reducer no-op 时 fallback legacy hot path (batchStreamChunkUpdate 单 set
      // 优化 + addMessageToThread 新 bubble 路径)。
      let bgStreamHandled = false;
      let reducerMessageId: string | undefined;
      if (msg.invocationId) {
        const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
        if (event) {
          // F183 B1.8 (cross-thread-handoff invariant): bg canonical bubble id
          // 必须跟 legacy `deriveBubbleId(invocationId, catId, ...)` 同格式 — 不带
          // bubbleKind 后缀 — 否则 active path / legacy bg path 创建的同 invocation
          // bubble 跟 reducer 创建的会用不同 id，破坏 AC-E3 single-bubble 不变量。
          // 把预 derive 的 id 通过 event.messageId 传给 reducer 的 ensureMessageId
          // (优先返回 event.messageId)。stable-key match (existing) 时 event.messageId
          // 不影响 lookup（lookup 走 invocationId+catId+kind），所以 append 路径不变。
          // F194 Phase Z3 R3 P1-2 (砚砚): pre-derived id MUST use turn-priority bubble identity
          // (turnInvocationId ?? invocationId), 否则同 parent 同 cat 多 turn 仍复用第一轮 id。
          const preDerivedId = deriveBubbleId(
            msg.turnInvocationId ?? msg.invocationId,
            msg.catId,
            () => `bg-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
          );
          const eventWithId = { ...event, messageId: msg.messageId ?? preDerivedId };
          const threadState = options.store.getThreadState(msg.threadId);
          const result = applyBubbleEventWithRecovery({
            threadId: msg.threadId,
            event: eventWithId,
            currentMessages: threadState.messages,
          });
          if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
            options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
            bgStreamHandled = true;
            // 找出 reducer 写入/创建的 bubble id（last canonical bubble for this catId+invocation）。
            // F183 B1.8 (砚砚 R1 P1): 必须 kind filter 'assistant_text'。ADR-033 允许同
            // invocation 多 kind 共存 (thinking + assistant_text)；如果 thinking bubble 排
            // 在 text 前面，find 不带 kind filter 会先命中 thinking → bgStreamRefs 指错 +
            // setThreadMessageStreaming(false) finalize 错气泡 (thinking 被 finalize，text
            // 仍 streaming)。同 B1.6 cloud P1 教训 (reduceToolEvent kind filter)。
            const target = result.nextMessages.find(
              (m) =>
                m.type === 'assistant' &&
                m.catId === msg.catId &&
                sameBubbleStableKey(m, (msg.turnInvocationId ?? msg.invocationId)!, msg.catId) &&
                deriveBubbleKindFromMessage(m) === 'assistant_text',
            );
            reducerMessageId = target?.id;
            // bgStreamRefs ledger: 维持跟 legacy 同步语义（非 final 写 ref，final
            // 走下方统一 delete 逻辑）。recoverStreamingMessage 在 active→bg
            // transition 时也用这个 ref 找 bubble。
            if (reducerMessageId && !msg.isFinal) {
              const seedSource: ActiveSeedSource = msg.turnInvocationId ? 'bound' : 'fresh-parent-seed';
              options.bgStreamRefs.set(streamKey, {
                id: reducerMessageId,
                threadId: msg.threadId,
                catId: msg.catId,
                seedSource,
                ...freshParentSeedProof(seedSource, msg.timestamp, msg.seq),
              });
            }
          }
          if (result.violations.length > 0) {
            for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
          }
        }
      }

      let messageId: string | undefined;
      if (bgStreamHandled && reducerMessageId) {
        messageId = reducerMessageId;
        // Side-effects: metadata / replyTo / replyPreview reducer 不 model；isStreaming
        // 翻转 + catStatus 也是 caller 责任。msg.isFinal=true 时 streaming=false +
        // catStatus=done；非 final 保持 streaming（reducer 在 makePlaceholder 已置
        // isStreaming=true，append 不动 isStreaming）。
        const sidePatch: Partial<ChatMessage> = {
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
        };
        if (Object.keys(sidePatch).length > 0) {
          options.store.patchThreadMessage(msg.threadId, messageId, sidePatch);
        }
        if (msg.isFinal) {
          options.store.setThreadMessageStreaming(msg.threadId, messageId, false);
        }
        options.store.updateThreadCatStatus(msg.threadId, msg.catId, msg.isFinal ? 'done' : 'streaming');
        if (msg.isFinal) {
          options.bgStreamRefs.delete(streamKey);
          clearActiveBubbleLedgerForFinalizedMessage(msg.threadId, msg.catId, messageId);
        }
      } else {
        // Legacy hot path — invocationless 走这里，reducer no-op 也走这里
        messageId = existing?.id;
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
            clearActiveBubbleLedgerForFinalizedMessage(msg.threadId, msg.catId, messageId);
          }
        } else {
          // F173 A.3 — invocationId from event payload first (eliminates stale-state ghost).
          const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
          // F194 Phase Z3 P1-1: turnInvocationId from msg (broadcast Z3 dual id) or store fallback
          const turnInvocationId =
            msg.turnInvocationId ??
            options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.turnInvocationId;
          const hasResidue = !turnInvocationId && hasBackgroundParentOnlyResidue(msg, invocationId, existing, options);
          // F194 Phase Z3 R17 (cloud Codex P1#2): bubble id seeded with turn-priority key.
          messageId = deriveBubbleId(turnInvocationId ?? (hasResidue ? undefined : invocationId), msg.catId, () =>
            nextProvisionalBubbleId(msg.catId),
          );
          const seedSource: ActiveSeedSource = turnInvocationId ? 'bound' : 'fresh-parent-seed';
          options.bgStreamRefs.set(streamKey, {
            id: messageId,
            threadId: msg.threadId,
            catId: msg.catId,
            seedSource,
            ...freshParentSeedProof(seedSource, msg.timestamp, msg.seq),
          });
          options.store.addMessageToThread(msg.threadId, {
            id: messageId,
            type: 'assistant',
            catId: msg.catId,
            content: msg.content,
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
            ...(invocationId && (turnInvocationId || !hasResidue)
              ? {
                  extra: {
                    stream: {
                      invocationId,
                      ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
                    },
                  },
                }
              : {}),
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
            clearActiveBubbleLedgerForFinalizedMessage(msg.threadId, msg.catId, messageId);
          }
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
      drainPendingBackgroundCallback(msg, options);
      options.addToast({
        type: 'success',
        title: `${resolveBackgroundCatName(options, msg.catId)} 完成`,
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
      if (msg.invocationId) {
        if (options.deletePendingCallback) {
          options.deletePendingCallback(msg.threadId, msg.catId, msg.invocationId);
        } else {
          options.pendingCallbacks?.delete(pendingCallbackKey(msg.threadId, msg.catId, msg.invocationId));
        }
      }
    }

    // F183 Phase B1.7 — bg error wire-up via reducer reduceErrorEvent.
    // canonical event 走 stable-key dedup；invocationless 仍 legacy addMessageToThread
    // 用 deterministic bg-err id 避免冲突。pattern 跟 B1.5 active error 同源。
    const errorContent = `Error: ${msg.error ?? 'Unknown error'}`;
    // F212 Phase B (云端 codex P2-4 2026-05-27): mirror active-path cliDiagnostics
    // wire-up so background-thread errors also get the folded panel — without this,
    // a CLI failure in a non-foreground thread loses the structured diagnostic and
    // falls back to the legacy red-pill bubble.
    const bgCliDiag = msg.metadata?.cliDiagnostics;
    const bgErrorExtra: ChatMessage['extra'] | undefined = bgCliDiag ? { cliDiagnostics: bgCliDiag } : undefined;
    let bgErrorReducerHandled = false;
    if (msg.invocationId) {
      const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
      if (event) {
        const eventWithEnrichment = {
          ...event,
          payload: {
            ...(event.payload ?? {}),
            content: errorContent,
            ...(bgErrorExtra ? { extra: bgErrorExtra } : {}),
          },
        };
        const threadState = options.store.getThreadState(msg.threadId);
        const prevLen = threadState.messages.length;
        const result = applyBubbleEventWithRecovery({
          threadId: msg.threadId,
          event: eventWithEnrichment,
          currentMessages: threadState.messages,
        });
        if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
          options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
          bgErrorReducerHandled = true;
          // F183 Phase B1.7 (砚砚 R1 P1): replaceThreadMessages 不像 addMessageToThread
          // 那样自动 +1 unread。reducer 创建新 system_status bubble 时（length 增加）
          // 必须手动补 unread badge，否则后台 thread 收到 canonical error 但 sidebar
          // unread 还是 0 = 用户可见回归。stable-key dedup（length 不变）不重复 +1。
          if (result.nextMessages.length > prevLen) {
            options.store.incrementUnread(msg.threadId);
          }
        }
        if (result.violations.length > 0) {
          for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
        }
      }
    }
    if (!bgErrorReducerHandled) {
      options.store.addMessageToThread(msg.threadId, {
        id: `bg-err-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
        type: 'system',
        variant: 'error',
        catId: msg.catId,
        content: errorContent,
        timestamp: msg.timestamp,
        ...(bgErrorExtra ? { extra: bgErrorExtra } : {}),
      });
    }
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
      title: `${resolveBackgroundCatName(options, msg.catId)} 出错`,
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
        title: `${resolveBackgroundCatName(options, msg.catId)} 完成`,
        message: `${resolveBackgroundCatName(options, msg.catId)} 已完成处理`,
        threadId: msg.threadId,
        duration: 5000,
      });
    }
    drainPendingBackgroundCallback(msg, options);
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard so it doesn't fire a false "timed out" message
      options.clearDoneTimeout?.(msg.threadId);
      markThreadInvocationComplete(msg, options);
    }
    return;
  }

  if (msg.type === 'status') {
    const mapped = BACKGROUND_STATUS_MAP[msg.content ?? ''] ?? 'streaming';
    const detail = msg.content && !BACKGROUND_STATUS_MAP[msg.content] ? msg.content : undefined;
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, mapped, detail);
    return;
  }

  if (msg.type === 'tool_use') {
    markThreadInvocationActive(msg, options);
    const toolName = msg.toolName ?? 'unknown';
    const detail = msg.toolInput ? safeJsonPreview(msg.toolInput, 200) : undefined;
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    const bgTurnInvocationId =
      msg.turnInvocationId ?? options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.turnInvocationId;
    const bgActiveRef = options.bgStreamRefs.get(streamKey);
    const useFreshParentSeedDirectly =
      !bgTurnInvocationId &&
      bgActiveRef?.id === messageId &&
      isCurrentFreshParentSeed(bgActiveRef, msg.timestamp, msg.seq);
    const toolUseEventData: ToolEvent = {
      id: `bg-tool-use-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_use',
      label: `${msg.catId} → ${toolName}`,
      ...(detail ? { detail } : {}),
      timestamp: msg.timestamp,
    };

    // F183 Phase B1.7 — bg tool_use wire-up via reducer (single-writer)。
    // ensureBackgroundAssistantMessage 仍跑（管 bgStreamRefs ledger）。reducer
    // 的 reduceToolEvent append toolEvent 到对应 invocation 的 assistant_text
    // bubble.toolEvents（kind filter 同 active path B1.6 cloud P1）。
    // recoveryAction !== 'none' 或 reducer no-op (no existing kind=assistant_text
    // bubble) 时回退 legacy appendToolEventToThread。
    let bgToolUseHandled = false;
    if (msg.invocationId && !useFreshParentSeedDirectly) {
      const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
      if (event) {
        const eventWithToolEvent = {
          ...event,
          payload: { ...(event.payload ?? {}), toolEvent: toolUseEventData },
        };
        const threadState = options.store.getThreadState(msg.threadId);
        const result = applyBubbleEventWithRecovery({
          threadId: msg.threadId,
          event: eventWithToolEvent,
          currentMessages: threadState.messages,
        });
        if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
          options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
          bgToolUseHandled = true;
        }
        if (result.violations.length > 0) {
          for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
        }
      }
    }
    if (!bgToolUseHandled) {
      options.store.appendToolEventToThread(msg.threadId, messageId, toolUseEventData);
    }
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'tool_result') {
    markThreadInvocationActive(msg, options);
    const detail = compactToolResultDetail(msg.content ?? '');
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    const bgTurnInvocationId =
      msg.turnInvocationId ?? options.store.getThreadState(msg.threadId).catInvocations[msg.catId]?.turnInvocationId;
    const bgActiveRef = options.bgStreamRefs.get(streamKey);
    const useFreshParentSeedDirectly =
      !bgTurnInvocationId &&
      bgActiveRef?.id === messageId &&
      isCurrentFreshParentSeed(bgActiveRef, msg.timestamp, msg.seq);
    const toolResultEventData: ToolEvent = {
      id: `bg-tool-result-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_result',
      label: `${msg.catId} ← result`,
      detail,
      timestamp: msg.timestamp,
    };

    // F183 Phase B1.7 — bg tool_result wire-up via reducer (same pattern as tool_use)。
    let bgToolResultHandled = false;
    if (msg.invocationId && !useFreshParentSeedDirectly) {
      const event = adaptIncomingToBubbleEvent(msg, { sourcePath: 'background' });
      if (event) {
        const eventWithToolEvent = {
          ...event,
          payload: { ...(event.payload ?? {}), toolEvent: toolResultEventData },
        };
        const threadState = options.store.getThreadState(msg.threadId);
        const result = applyBubbleEventWithRecovery({
          threadId: msg.threadId,
          event: eventWithToolEvent,
          currentMessages: threadState.messages,
        });
        if (result.recoveryAction === 'none' && result.nextMessages !== threadState.messages) {
          options.store.replaceThreadMessages(msg.threadId, result.nextMessages, threadState.hasMore);
          bgToolResultHandled = true;
        }
        if (result.violations.length > 0) {
          for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
        }
      }
    }
    if (!bgToolResultHandled) {
      options.store.appendToolEventToThread(msg.threadId, messageId, toolResultEventData);
    }
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'system_info' || msg.type === 'a2a_handoff') {
    if (!msg.content) return;
    if (msg.type === 'a2a_handoff') {
      // F173 bug fix: routing pill needs systemKind marker so chatStore
      // inserts it at the right position vs. next cat's stream bubble.
      addBackgroundSystemMessage(msg, options, msg.content, 'info', {
        systemKind: 'a2a_routing',
        a2aRouting: {
          fromCatId: msg.catId,
          targetCatId: msg.targetCatId,
          invocationId: msg.invocationId,
        },
      });
      return;
    }

    const result = consumeBackgroundSystemInfo(msg, existing, options);
    if (!result.consumed) {
      const bgCliDiag = msg.metadata?.cliDiagnostics;
      const extra =
        result.systemInfo || bgCliDiag
          ? {
              ...(result.systemInfo ? { systemInfo: result.systemInfo } : {}),
              ...(bgCliDiag ? { cliDiagnostics: bgCliDiag } : {}),
            }
          : undefined;
      addBackgroundSystemMessage(msg, options, result.content, result.variant, extra);
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
  const resolveCatName = useCatNameResolver();
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
  } = useChatStore(
    useShallow((s) => ({
      addMessage: s.addMessage,
      appendToMessage: s.appendToMessage,
      appendToolEvent: s.appendToolEvent,
      appendRichBlock: s.appendRichBlock,
      replaceMessageId: s.replaceMessageId,
      patchMessage: s.patchMessage,
      removeMessage: s.removeMessage,
      setStreaming: s.setStreaming,
      setLoading: s.setLoading,
      setHasActiveInvocation: s.setHasActiveInvocation,
      removeActiveInvocation: s.removeActiveInvocation,
      addActiveInvocation: s.addActiveInvocation,
      clearAllActiveInvocations: s.clearAllActiveInvocations,
      setIntentMode: s.setIntentMode,
      setCatStatus: s.setCatStatus,
      clearCatStatuses: s.clearCatStatuses,
      setCatInvocation: s.setCatInvocation,
      setMessageUsage: s.setMessageUsage,
      setMessageMetadata: s.setMessageMetadata,
      setMessageThinking: s.setMessageThinking,
      setMessageStreamInvocation: s.setMessageStreamInvocation,
      requestStreamCatchUp: s.requestStreamCatchUp,
      replaceThreadTargetCats: s.replaceThreadTargetCats,
    })),
  );

  // F173 Phase E: bg-message processing refs (moved from useSocket).
  // useAgentMessages 现在是 single dispatch entry — 这些 refs 给 background-thread
  // delegation 用（handleBackgroundAgentMessage 内部的 stream key 追踪 / monotonic seq）。
  const bgStreamRefsRef = useRef<Map<string, BackgroundStreamRef>>(new Map());
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
  const setActive = useCallback(
    (
      catId: string,
      messageId: string,
      invocationId?: string,
      seedSource?: ActiveSeedSource,
      proof?: FreshParentSeedProof,
    ) => {
      const tid = useChatStore.getState().currentThreadId;
      if (!tid) return;
      setActiveBubbleLedger(getThreadRuntimeLedger(), tid, catId, {
        messageId,
        ...(invocationId ? { invocationId } : {}),
        ...(seedSource ? { seedSource } : {}),
        ...(proof?.freshParentSeedAt !== undefined ? { freshParentSeedAt: proof.freshParentSeedAt } : {}),
        ...(proof?.freshParentSeedSeq !== undefined ? { freshParentSeedSeq: proof.freshParentSeedSeq } : {}),
      });
    },
    [],
  );
  const getActive = useCallback(
    (
      catId: string,
    ):
      | {
          id: string;
          catId: string;
          seedSource?: ActiveSeedSource;
          freshParentSeedAt?: number;
          freshParentSeedSeq?: number;
        }
      | undefined => {
      const tid = useChatStore.getState().currentThreadId;
      if (!tid) return undefined;
      const entry = getActiveBubbleLedger(getThreadRuntimeLedger(), tid, catId);
      return entry
        ? {
            id: entry.messageId,
            catId,
            ...(entry.seedSource ? { seedSource: entry.seedSource } : {}),
            ...(entry.freshParentSeedAt !== undefined ? { freshParentSeedAt: entry.freshParentSeedAt } : {}),
            ...(entry.freshParentSeedSeq !== undefined ? { freshParentSeedSeq: entry.freshParentSeedSeq } : {}),
          }
        : undefined;
    },
    [],
  );
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
  /** Callback text that arrived before stream done; applied once the invocation finalizes. */
  const pendingCallbacksRef = useRef<Map<string, PendingCallbackMessage>>(new Map());
  /** Fallback drains for pending callbacks whose terminal event is lost. */
  const pendingCallbackFallbackTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const drainPendingCallbacksForThreadRef = useRef<(threadId: string | undefined) => void>(() => {});

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
        drainPendingCallbacksForThreadRef.current(timeoutThreadId);
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
      drainPendingCallbacksForThreadRef.current(timeoutThreadId);
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
      for (const timeout of pendingCallbackFallbackTimeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      pendingCallbackFallbackTimeoutsRef.current.clear();
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

  const resolveCurrentTurnInvocationIdForCat = useCallback(
    (catId: string, parentInvocationId: string | undefined): string | undefined => {
      if (!parentInvocationId) return undefined;
      const direct = useChatStore.getState().catInvocations?.[catId];
      if (direct?.invocationId !== parentInvocationId) return undefined;
      return direct.turnInvocationId;
    },
    [],
  );

  const resolveEffectiveTurnInvocationIdForCat = useCallback(
    (catId: string, parentInvocationId: string | undefined, explicitTurnInvocationId?: string): string | undefined => {
      if (explicitTurnInvocationId) return explicitTurnInvocationId;
      return resolveCurrentTurnInvocationIdForCat(catId, parentInvocationId);
    },
    [resolveCurrentTurnInvocationIdForCat],
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
  const isStaleTerminalEvent = useCallback(
    (catId: string, msgInvocationId: string | undefined): boolean => {
      if (!msgInvocationId) return false;
      const state = useChatStore.getState();
      const suffix = `-${catId}`;
      const normalize = (k: string | undefined): string | undefined =>
        k?.endsWith(suffix) ? k.slice(0, -suffix.length) : k;

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

      const directState = state.catInvocations?.[catId];
      if (
        directState?.turnInvocationId === msgInvocationId &&
        directState.invocationId &&
        latestRealSlot === directState.invocationId
      ) {
        return false;
      }

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

      if (directState?.turnInvocationId !== undefined) {
        if (directState.turnInvocationId === msgInvocationId) return false;
      }

      if (directState?.invocationId !== undefined) {
        return directState.invocationId !== msgInvocationId;
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
    },
    [getActive],
  );

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
      if (primarySlot?.catId === nextCatId) return;

      const hasExplicitNextCatSlot =
        Boolean(activeInvocations[`${invocationId}-${nextCatId}`]) ||
        Object.values(activeInvocations).some((slot) => slot.catId === nextCatId);
      if (hasExplicitNextCatSlot) return;

      // Serial handoff reuses the parent invocationId for follow-up cats. If the
      // previous cat's done(isFinal=false) is lost, the old primary slot would
      // stay pinned to the first cat forever. Conversely, if that done event has
      // already cleared the slot, the handoff gap would briefly hide cancel state.
      // Rebind or recreate the parent slot as soon as the next cat is announced.
      if (primarySlot) {
        removeActiveInvocation(invocationId);
        addActiveInvocation(invocationId, nextCatId, primarySlot.mode, primarySlot.startedAt);
      } else {
        addActiveInvocation(invocationId, nextCatId, store.intentMode ?? 'execute');
      }

      const currentTargets = Array.isArray(store.targetCats) ? store.targetCats : [];
      if (store.currentThreadId && currentTargets.length === 1 && currentTargets[0] !== nextCatId) {
        replaceThreadTargetCats(store.currentThreadId, [nextCatId]);
      }

      const currentStatus = store.catStatuses?.[nextCatId];
      if (
        currentStatus !== 'spawning' &&
        currentStatus !== 'streaming' &&
        currentStatus !== 'alive_but_silent' &&
        currentStatus !== 'suspected_stall'
      ) {
        setCatStatus(nextCatId, 'spawning');
      }
    },
    [addActiveInvocation, removeActiveInvocation, replaceThreadTargetCats, setCatStatus],
  );

  const resolveSequentialHandoffInvocationId = useCallback((fromCatId?: string, explicitInvocationId?: string) => {
    if (explicitInvocationId) return explicitInvocationId;

    const store = useChatStore.getState();
    const activeEntries = Object.entries(store.activeInvocations);
    if (fromCatId) {
      const fromCatSlot = activeEntries.find(([, slot]) => slot.catId === fromCatId);
      if (fromCatSlot) return fromCatSlot[0];

      const fromCatInvocationId = store.catInvocations?.[fromCatId]?.invocationId;
      if (fromCatInvocationId) return fromCatInvocationId;
    }

    return activeEntries.length === 1 ? activeEntries[0]?.[0] : undefined;
  }, []);

  const findRecoverableAssistantMessage = useCallback(
    (
      catId: string,
      explicitInvocationId?: string,
      options?: {
        requireStreamOrigin?: boolean;
        avoidParentOnlyResidueRecovery?: boolean;
        currentEventTimestamp?: number;
        currentEventSeq?: number;
      },
    ) => {
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
      let stableLookupId = invocationId;
      const currentTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(catId, invocationId);
      if (currentTurnInvocationId) stableLookupId = currentTurnInvocationId;

      // F194 cloud R3 (2026-06-15, 砚砚): recovery guard. When the turn id is unknown,
      // stableLookupId falls back to the PARENT — which also matches an earlier same-parent
      // parent-only residue (reconnect/hydration). Adopting it lets the current turn's tool_use
      // pollute the residue BEFORE invocation_created can finalize it (the R3 split→merge bug).
      // Only adopt a parent-only bound bubble when the runtime ledger marks it as THIS turn's
      // fresh seed; otherwise skip so the caller creates a new current seed (provisional id) and
      // the residue stays isolated. Turn-known recovery is unaffected (turn keys never match a
      // parent-only residue). The unbound fallback below already rejects bound bubbles.
      const turnUnknownForRecovery = options?.avoidParentOnlyResidueRecovery === true;
      const shouldSkipParentOnlyResidue = (m: ChatMessage): boolean => {
        if (!turnUnknownForRecovery) return false;
        const boundInv = m.extra?.stream?.invocationId;
        const boundTurn = m.extra?.stream?.turnInvocationId;
        if (!boundInv || boundTurn) return false; // not a parent-only bound bubble
        const active = getActive(catId);
        return !(
          active?.id === m.id &&
          isCurrentFreshParentSeed(active, options?.currentEventTimestamp, options?.currentEventSeq)
        );
      };

      if (stableLookupId) {
        const lastFinalizedIdForCat = getFinalized(catId);
        // Cloud P1#4 (PR#1352): streaming-first preference. With explicit invocationId,
        // a newest→oldest scan could pick a non-streaming callback bubble before the
        // still-streaming placeholder for the same invocation, leaving the real bubble
        // open in done/error paths. Two passes — streaming match wins, non-streaming
        // is fallback (preserves hydration recovery from "replace hydration swaps" test).
        // F194 Phase Z3 R4 P1-3 (砚砚): use stable-key match (turn > parent) so terminal/recovery
        // path doesn't bind to wrong turn (parent-only match would close newer turn's bubble).
        // F194 Phase Z3 R7 P1-3 (砚砚): turn-only matching for dual-id bubbles, parent fallback only for legacy.
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg.type !== 'assistant' || msg.catId !== catId) continue;
          if (options?.requireStreamOrigin && msg.origin && msg.origin !== 'stream') continue;
          if (!sameBubbleStableKey(msg, stableLookupId, catId)) continue;
          if (shouldSkipParentOnlyResidue(msg)) continue; // F194 R3 (砚砚): recovery guard
          if (!msg.isStreaming) continue;
          return { id: msg.id, needsStreamingRestore: false };
        }
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (msg.type !== 'assistant' || msg.catId !== catId) continue;
          if (options?.requireStreamOrigin && msg.origin && msg.origin !== 'stream') continue;
          if (!sameBubbleStableKey(msg, stableLookupId, catId)) continue;
          if (shouldSkipParentOnlyResidue(msg)) continue; // F194 R3 (砚砚): recovery guard
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
        if (options?.requireStreamOrigin && msg.origin && msg.origin !== 'stream') continue;
        if (!msg.isStreaming) continue;
        if (msg.extra?.stream?.invocationId) continue; // bound to some invocation — never adopt
        return { id: msg.id, needsStreamingRestore: false };
      }

      return null;
    },
    [getActive, getCurrentInvocationIdForCat, getFinalized, resolveEffectiveTurnInvocationIdForCat],
  );

  const findCallbackReplacementTarget = useCallback((catId: string, invocationId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    // Strict match only: exact invocationId. Do NOT adopt unbound placeholders —
    // per clowder-ai#305 absorb (2026-04-01) the placeholder may belong to a newer
    // invocation, and silently merging callback into it risks content mixing.
    // invocation_created's rebind step handles the unbound → bound transition.
    // F194 Phase Z3 R4 P1-2 (砚砚): use stable-key match (turn > parent) so same-parent
    // multi-turn callback doesn't bind to wrong turn's stream bubble.
    // F194 Phase Z3 R8 P1-1 (砚砚): turn-only matching for dual-id bubbles via sameBubbleStableKey
    // (legacy bubble parent fallback inside helper). Caller passes turn-priority expected.
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (msg?.type !== 'assistant' || msg.catId !== catId || msg.origin !== 'stream') continue;
      if (sameBubbleStableKey(msg, invocationId, catId)) {
        return { id: msg.id };
      }
    }
    return null;
  }, []);

  const findInvocationlessStreamPlaceholder = useCallback(
    (catId: string): { id: string } | null => {
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
    },
    [getActive, getFinalized],
  );

  /**
   * Only reclaim rich/tool-only placeholders that have not started streaming text.
   *
   * Do not relax these guards:
   * - Drop `content.trim() === 0` and a stale callback can steal a newer live run's
   *   invocationless placeholder after real text already started streaming (#586-style regression).
   * - Drop the rich/tool guard and empty placeholders created by ensureActiveAssistantMessage
   *   can be reclaimed before their real callback lands, reintroducing split bubbles.
   */
  const findInvocationlessRichPlaceholder = useCallback(
    (catId: string): { id: string } | null => {
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
    },
    [getActive],
  );

  const isActiveCallbackStillStreaming = useCallback((catId: string, invocationId: string): boolean => {
    return useChatStore
      .getState()
      .messages.some(
        (m) =>
          m.type === 'assistant' &&
          m.catId === catId &&
          m.origin === 'stream' &&
          m.isStreaming === true &&
          sameBubbleStableKey(m, invocationId, catId),
      );
  }, []);

  const applyActiveExplicitCallbackNow = useCallback(
    (msg: AgentMsg): void => {
      if (!msg.invocationId) return;
      const invocationId = msg.invocationId;
      const isExplicitPost = msg.extra?.isExplicitPost === true;
      // #814: explicit post_message is a standalone message — it doesn't replace
      // any existing stream bubble, so skip replacement target lookup entirely.
      // Finding a target would cause deleteActive/clearFinalized/markReplacedInvocation
      // which would kill subsequent stream chunks from the same invocation.
      const replacementTarget = isExplicitPost
        ? null
        : (findCallbackReplacementTarget(msg.catId, msg.turnInvocationId ?? invocationId) ??
          findInvocationlessRichPlaceholder(msg.catId));
      // F194 Phase Z3 R3 P1-2: callback bubble id 用 turn-priority (turnInvocationId ?? invocationId)
      const bubbleIdSeed = msg.turnInvocationId ?? invocationId;
      const finalId =
        msg.messageId ?? deriveBubbleId(bubbleIdSeed, msg.catId, () => `msg-${Date.now()}-${msg.catId}-cb-${++cbSeq}`);
      const threadIdForCallback = msg.threadId ?? useChatStore.getState().currentThreadId;
      const event = adaptIncomingToBubbleEvent({ ...msg, threadId: threadIdForCallback } as BackgroundAgentMessage, {
        sourcePath: 'callback',
      });

      let reducerRejected = false;
      if (event) {
        const eventWithId = { ...event, messageId: finalId };
        const storeSnapshot = useChatStore.getState();
        const result = applyBubbleEventWithRecovery({
          threadId: threadIdForCallback,
          event: eventWithId,
          currentMessages: storeSnapshot.messages,
        });
        if (result.recoveryAction !== 'none') {
          reducerRejected = true;
          if (result.violations.length > 0) {
            for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
          }
        } else {
          storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
          if (result.violations.length > 0) {
            for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
          }
        }
      }

      if (reducerRejected) {
        const fallbackId = `msg-cb-fallback-${Date.now()}-${msg.catId}-${++cbSeq}`;
        // F194 Phase Z3 (砚砚 R2 P1-3): callback fallback also writes dual id so bubble identity
        // stays consistent (turn for stable key, parent for liveness).
        const turnInvocationIdForFallback = msg.turnInvocationId;
        const extraForAdd = {
          ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
          // #814: propagate isExplicitPost so chatStore.findAssistantDuplicate
          // skips merge for explicit post_message callbacks in fallback path.
          ...(msg.extra?.isExplicitPost ? { isExplicitPost: true } : {}),
          ...(msg.extra?.targetCats ? { targetCats: msg.extra.targetCats } : {}),
          stream: {
            invocationId,
            ...(turnInvocationIdForFallback && turnInvocationIdForFallback !== invocationId
              ? { turnInvocationId: turnInvocationIdForFallback }
              : {}),
          },
        };
        addMessage({
          id: fallbackId,
          type: 'assistant',
          catId: msg.catId,
          content: msg.content ?? '',
          origin: 'callback',
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          extra: extraForAdd,
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          timestamp: Date.now(),
        });
        return;
      }

      const extraForPatch = {
        ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
        ...(msg.extra?.isExplicitPost ? { isExplicitPost: true as const } : {}),
        ...(msg.extra?.targetCats ? { targetCats: msg.extra.targetCats } : {}),
      };
      if (
        msg.metadata ||
        Object.keys(extraForPatch).length > 0 ||
        msg.mentionsUser ||
        msg.replyTo ||
        msg.replyPreview
      ) {
        patchMessage(finalId, {
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(Object.keys(extraForPatch).length > 0 ? { extra: extraForPatch } : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
        });
      }
      if (replacementTarget) {
        deleteActive(msg.catId);
        clearFinalized(msg.catId);
      }
      // #814: explicit post_message is standalone — must NOT mark the invocation
      // as replaced, otherwise subsequent stream chunks from the same invocation
      // get dropped by isInvocationReplaced guard.
      if (!isExplicitPost) {
        // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present so
        // sibling turns under the same parent chain don't get cross-suppressed.
        markReplacedInvocation(threadIdForCallback, msg.catId, msg.turnInvocationId ?? invocationId);
      }
    },
    [
      addMessage,
      clearFinalized,
      deleteActive,
      findCallbackReplacementTarget,
      findInvocationlessRichPlaceholder,
      patchMessage,
    ],
  );

  const clearPendingCallbackFallback = useCallback((key: string): void => {
    const timeout = pendingCallbackFallbackTimeoutsRef.current.get(key);
    if (timeout) {
      clearTimeout(timeout);
    }
    pendingCallbackFallbackTimeoutsRef.current.delete(key);
  }, []);

  const deletePendingCallback = useCallback(
    (threadId: string | undefined, catId: string, invocationId: string): void => {
      const key = pendingCallbackKey(threadId, catId, invocationId);
      clearPendingCallbackFallback(key);
      pendingCallbacksRef.current.delete(key);
    },
    [clearPendingCallbackFallback],
  );

  const drainPendingActiveCallback = useCallback(
    (threadId: string | undefined, catId: string, invocationId: string | undefined): void => {
      if (!invocationId) return;
      const key = pendingCallbackKey(threadId, catId, invocationId);
      const pending = pendingCallbacksRef.current.get(key);
      if (!pending) return;
      clearPendingCallbackFallback(key);
      pendingCallbacksRef.current.delete(key);
      applyActiveExplicitCallbackNow({ ...(pending as AgentMsg), threadId });
    },
    [applyActiveExplicitCallbackNow, clearPendingCallbackFallback],
  );

  const settlePendingActiveCallbackOnTerminal = useCallback(
    (
      threadId: string | undefined,
      catId: string,
      invocationId: string | undefined,
      action: 'drain' | 'clear',
    ): void => {
      if (!invocationId) return;
      const resolvedThreadId = threadId ?? useChatStore.getState().currentThreadId;
      if (action === 'drain') {
        drainPendingActiveCallback(resolvedThreadId, catId, invocationId);
        return;
      }
      deletePendingCallback(resolvedThreadId, catId, invocationId);
    },
    [deletePendingCallback, drainPendingActiveCallback],
  );

  const settlePendingActiveTextFinalCallback = useCallback(
    (msg: AgentMsg, options?: { stale?: boolean }): void => {
      if (msg.type !== 'text' || msg.origin === 'callback' || !msg.isFinal || !msg.invocationId) return;
      const stale = options?.stale ?? decideTerminalEvent(msg.catId, msg.invocationId).stale;
      settlePendingActiveCallbackOnTerminal(
        msg.threadId ?? useChatStore.getState().currentThreadId,
        msg.catId,
        msg.invocationId,
        stale ? 'clear' : 'drain',
      );
    },
    [decideTerminalEvent, settlePendingActiveCallbackOnTerminal],
  );

  const markPendingBackgroundStreamFinished = useCallback(
    (store: ReturnType<typeof useChatStore.getState>, threadId: string, pending: PendingCallbackMessage): void => {
      const invocationId = pending.invocationId;
      if (!invocationId) return;

      for (const message of store.getThreadState(threadId).messages) {
        if (
          message.type === 'assistant' &&
          message.catId === pending.catId &&
          message.origin === 'stream' &&
          message.isStreaming === true &&
          sameBubbleStableKey(message, pending.turnInvocationId ?? invocationId, pending.catId)
        ) {
          store.setThreadMessageStreaming(threadId, message.id, false);
        }
      }
    },
    [],
  );

  const applyPendingCallbackForThread = useCallback(
    (
      store: ReturnType<typeof useChatStore.getState>,
      fallbackThreadId: string | undefined,
      pending: PendingCallbackMessage,
    ): void => {
      const pendingThreadId = pending.threadId ?? fallbackThreadId;
      if (!pendingThreadId || pendingThreadId === store.currentThreadId) {
        applyActiveExplicitCallbackNow({ ...(pending as AgentMsg), threadId: pendingThreadId });
        return;
      }

      markPendingBackgroundStreamFinished(store, pendingThreadId, pending);
      handleBackgroundAgentMessage(
        { ...(pending as BackgroundAgentMessage), threadId: pendingThreadId },
        {
          store,
          bgStreamRefs: bgStreamRefsRef.current,
          finalizedBgRefs: bgFinalizedRefsRef.current,
          nextBgSeq: () => bgSeqRef.current++,
          addToast: (toast) => useToastStore.getState().addToast(toast),
          resolveCatName,
          clearDoneTimeout,
          pendingCallbacks: pendingCallbacksRef.current,
          deletePendingCallback,
        },
      );
    },
    [
      applyActiveExplicitCallbackNow,
      clearDoneTimeout,
      deletePendingCallback,
      markPendingBackgroundStreamFinished,
      resolveCatName,
    ],
  );

  const deferPendingCallback = useCallback(
    (pending: PendingCallbackMessage, threadId: string | undefined): void => {
      if (!pending.invocationId) return;
      const pendingThreadId = pending.threadId ?? threadId;
      const key = pendingCallbackKey(pendingThreadId, pending.catId, pending.invocationId);
      clearPendingCallbackFallback(key);
      pendingCallbacksRef.current.set(key, {
        ...pending,
        threadId: pendingThreadId,
      });
      pendingCallbackFallbackTimeoutsRef.current.set(
        key,
        setTimeout(() => {
          pendingCallbackFallbackTimeoutsRef.current.delete(key);
          const latest = pendingCallbacksRef.current.get(key);
          if (!latest) return;
          pendingCallbacksRef.current.delete(key);

          const store = useChatStore.getState();
          applyPendingCallbackForThread(store, pendingThreadId, latest);

          const catchUpThreadId = latest.threadId ?? pendingThreadId ?? store.currentThreadId;
          if (catchUpThreadId) {
            store.requestStreamCatchUp(catchUpThreadId);
          }
        }, DONE_TIMEOUT_MS),
      );
    },
    [applyPendingCallbackForThread, clearPendingCallbackFallback],
  );

  const drainPendingCallbacksForThread = useCallback(
    (threadId: string | undefined): void => {
      const keyPrefix = `${threadId ?? 'active'}::`;
      const pendingEntries = Array.from(pendingCallbacksRef.current.entries()).filter(([key]) =>
        key.startsWith(keyPrefix),
      );
      if (pendingEntries.length === 0) return;

      const store = useChatStore.getState();
      for (const [key, pending] of pendingEntries) {
        clearPendingCallbackFallback(key);
        pendingCallbacksRef.current.delete(key);
        applyPendingCallbackForThread(store, threadId, pending);
      }
    },
    [applyPendingCallbackForThread, clearPendingCallbackFallback],
  );
  drainPendingCallbacksForThreadRef.current = drainPendingCallbacksForThread;

  const clearPendingCallbacksForThread = useCallback(
    (threadId: string | undefined): void => {
      const keyPrefix = `${threadId ?? 'active'}::`;
      for (const key of Array.from(pendingCallbacksRef.current.keys())) {
        if (key.startsWith(keyPrefix)) {
          clearPendingCallbackFallback(key);
          pendingCallbacksRef.current.delete(key);
        }
      }
    },
    [clearPendingCallbackFallback],
  );

  const getOrRecoverActiveAssistantMessageId = useCallback(
    (
      catId: string,
      metadata?: AgentMsg['metadata'],
      options?: {
        ensureStreaming?: boolean;
        invocationId?: string;
        turnInvocationId?: string;
        currentEventTimestamp?: number;
        currentEventSeq?: number;
      },
    ): string | null => {
      const currentMessages = useChatStore.getState().messages;
      const existing = getActive(catId);
      const effectiveTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(
        catId,
        options?.invocationId,
        options?.turnInvocationId,
      );
      if (existing?.id) {
        const found = currentMessages.find((msg) => msg.id === existing.id && msg.type === 'assistant');
        if (found) {
          // F173 hotfix (砚砚 4 件套 #2) — identity-aware sticky: if caller passed an
          // explicit invocationId AND the active ref is bound to a DIFFERENT invocation,
          // the active ref is stale (previous invocation's bubble whose done was lost).
          // Drop it and fall through to identity-aware recovery.
          // F194 Phase Z3 R9 P1-1 (砚砚): use stable-key match (turn > parent) so same-parent
          // multi-turn doesn't fall back to old turn's bubble via parent-only equality.
          const boundInv = found.extra?.stream?.invocationId;
          const boundTurnInv = found.extra?.stream?.turnInvocationId;
          let expectedKey = options?.invocationId;
          if (effectiveTurnInvocationId) expectedKey = effectiveTurnInvocationId;
          const shouldUpgradeParentOnlyActiveStream =
            found.origin === 'stream' &&
            found.isStreaming === true &&
            !!options?.invocationId &&
            !!effectiveTurnInvocationId &&
            boundInv === options.invocationId &&
            !boundTurnInv &&
            isCurrentFreshParentSeed(existing, options?.currentEventTimestamp, options?.currentEventSeq);
          const stale =
            (!!expectedKey &&
              !!boundInv &&
              !shouldUpgradeParentOnlyActiveStream &&
              !sameBubbleStableKey(found, expectedKey, catId)) ||
            (options?.ensureStreaming === true && found.origin === 'callback');
          if (stale) {
            deleteActive(catId);
          } else {
            if (shouldUpgradeParentOnlyActiveStream) {
              const upgradeInvocationId = options?.invocationId;
              const upgradeTurnInvocationId = effectiveTurnInvocationId;
              if (upgradeInvocationId && upgradeTurnInvocationId) {
                setMessageStreamInvocation(found.id, upgradeInvocationId, upgradeTurnInvocationId);
              }
            }
            if (expectedKey && !boundInv) {
              // F194 Phase Z3 R10 P1-1 (砚砚): write dual id — invocationId=parent (chain SoT), turn separate
              // R11 P1 (砚砚): setActive must use parent (AC-Z8: liveness/queue/cancel SoT). turn is bubble identity only.
              const parentBindId = options?.invocationId ?? expectedKey;
              const seedSource: ActiveSeedSource = effectiveTurnInvocationId ? 'bound' : 'fresh-parent-seed';
              setMessageStreamInvocation(found.id, parentBindId, effectiveTurnInvocationId);
              setActive(
                catId,
                found.id,
                parentBindId,
                seedSource,
                freshParentSeedProof(seedSource, options?.currentEventTimestamp, options?.currentEventSeq),
              );
            }
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

      let recoverKey = options?.invocationId;
      if (effectiveTurnInvocationId) recoverKey = effectiveTurnInvocationId;
      const recovered = findRecoverableAssistantMessage(catId, recoverKey, {
        requireStreamOrigin: options?.ensureStreaming === true,
        currentEventTimestamp: options?.currentEventTimestamp,
        currentEventSeq: options?.currentEventSeq,
      });
      if (!recovered) return null;

      setActive(catId, recovered.id, options?.invocationId, 'recovered');
      if (options?.invocationId) {
        const recoveredMessage = useChatStore
          .getState()
          .messages.find((msg) => msg.id === recovered.id && msg.type === 'assistant');
        if (recoveredMessage && !recoveredMessage.extra?.stream?.invocationId) {
          if (effectiveTurnInvocationId) {
            setMessageStreamInvocation(recovered.id, options.invocationId, effectiveTurnInvocationId);
          } else {
            setMessageStreamInvocation(recovered.id, options.invocationId);
          }
        }
      }
      if (options?.ensureStreaming && recovered.needsStreamingRestore) {
        setStreaming(recovered.id, true);
      }
      if (metadata) {
        setMessageMetadata(recovered.id, metadata);
      }
      return recovered.id;
    },
    [
      findRecoverableAssistantMessage,
      resolveEffectiveTurnInvocationIdForCat,
      setMessageMetadata,
      setMessageStreamInvocation,
      setStreaming,
      deleteActive,
      getActive,
      setActive,
    ],
  );

  const ensureActiveAssistantMessage = useCallback(
    (
      catId: string,
      metadata?: AgentMsg['metadata'],
      options?: {
        invocationId?: string;
        turnInvocationId?: string;
        avoidParentOnlyResidueRecovery?: boolean;
        currentEventTimestamp?: number;
        currentEventSeq?: number;
      },
    ): string => {
      const effectiveTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(
        catId,
        options?.invocationId,
        options?.turnInvocationId,
      );
      const forceFreshParentSeed =
        options?.avoidParentOnlyResidueRecovery === true && effectiveTurnInvocationId === undefined;
      // F194 Phase Z3 R8 P1-2 (砚砚): forward turnInvocationId so recovery uses turn-priority lookup
      const activeSeed = getActive(catId);
      const existingId =
        forceFreshParentSeed &&
        !isCurrentFreshParentSeed(activeSeed, options?.currentEventTimestamp, options?.currentEventSeq)
          ? null
          : getOrRecoverActiveAssistantMessageId(catId, metadata, {
              ensureStreaming: true,
              ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
              ...(effectiveTurnInvocationId ? { turnInvocationId: effectiveTurnInvocationId } : {}),
              ...(options?.avoidParentOnlyResidueRecovery ? { avoidParentOnlyResidueRecovery: true } : {}),
              currentEventTimestamp: options?.currentEventTimestamp,
              currentEventSeq: options?.currentEventSeq,
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
      // F194 Phase Z3 P1-1: this path can run before the turn id is resolvable. The parent id remains
      // in the runtime ledger for liveness/cancel, but a fresh message must stay unbound until
      // invocation_created writes the parent+turn pair; otherwise same-parent residues can TD112-merge.
      const turnInvocationId: string | undefined = resolveEffectiveTurnInvocationIdForCat(
        catId,
        invocationId,
        effectiveTurnInvocationId,
      );
      const activeFreshSeedId = isCurrentFreshParentSeed(
        activeSeed,
        options?.currentEventTimestamp,
        options?.currentEventSeq,
      )
        ? activeSeed?.id
        : undefined;
      const hasParentOnlyResidue =
        options?.avoidParentOnlyResidueRecovery === true &&
        !!invocationId &&
        !turnInvocationId &&
        useChatStore
          .getState()
          .messages.some(
            (m) =>
              m.type === 'assistant' &&
              m.catId === catId &&
              m.origin === 'stream' &&
              m.extra?.stream?.invocationId === invocationId &&
              !m.extra.stream.turnInvocationId &&
              m.id !== activeFreshSeedId,
          );
      // F194 Phase Z3 R8 P1-2: derive id from turn-priority key so same parent multi-turn produces
      // distinct bubbles even when speculative active path creates the placeholder.
      // F194 cloud R3 (砚砚) ③ provisional id: when the turn id is still unknown, do NOT seed the
      // id from the parent (`msg-{parent}-{cat}`) IF an earlier same-parent residue already owns it;
      // addMessage would otherwise no-op / TD112-merge and the current turn would silently collide
      // into the residue. No-residue parent-only seeds keep the legacy parent-derived id.
      const bubbleIdSeed = turnInvocationId ?? (hasParentOnlyResidue ? undefined : invocationId);
      const id = deriveBubbleId(bubbleIdSeed, catId, () => nextProvisionalBubbleId(catId));
      // Provenance: a parent-only fresh seed (turn unknown) is THIS turn's seed — mark it so the
      // recovery guard tells it apart from an earlier same-parent residue. Turn-bound → 'bound'.
      const seedSource: ActiveSeedSource = turnInvocationId ? 'bound' : 'fresh-parent-seed';
      setActive(
        catId,
        id,
        invocationId,
        seedSource,
        freshParentSeedProof(seedSource, options?.currentEventTimestamp, options?.currentEventSeq),
      );
      addMessage({
        id,
        type: 'assistant',
        catId,
        content: '',
        origin: 'stream',
        ...(metadata ? { metadata } : {}),
        ...(invocationId && (turnInvocationId || !hasParentOnlyResidue)
          ? {
              extra: {
                stream: {
                  invocationId,
                  ...(turnInvocationId && turnInvocationId !== invocationId ? { turnInvocationId } : {}),
                },
              },
            }
          : {}),
        timestamp: Date.now(),
        isStreaming: true,
      });
      if (invocationId) {
        recordLateBindBubbleCreate(catId, id, invocationId);
      }
      return id;
    },
    [
      addMessage,
      getActive,
      getOrRecoverActiveAssistantMessageId,
      recordLateBindBubbleCreate,
      resolveEffectiveTurnInvocationIdForCat,
      setActive,
    ],
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

      // F183 Phase C — thread-scoped sequence number gap detection (KD-9).
      // 在所有 dispatch 之前跑：每条 event 带 seq>0 时检查 monotonic 顺序 + 比对
      // sequencer epoch；发现 gap / epoch-change 立即 `requestStreamCatchUp(threadId)`
      // (unconditional full HTTP fetch — 复用 useChatHistory 消费者) 拉缺，不等
      // 5min DONE_TIMEOUT。legacy producers (无 seq) 不更新 lastSeq，graceful degradation。
      processThreadSeq(msg, store);

      if (msg.threadId && !isActiveThreadMessage) {
        // Background thread → delegate to handleBackgroundAgentMessage with bg refs.
        // Phase E Task 2-5 将把 bg 业务逻辑迁进来后删除此 import + 调用。
        handleBackgroundAgentMessage(msg as BackgroundAgentMessage, {
          store,
          bgStreamRefs: bgStreamRefsRef.current,
          finalizedBgRefs: bgFinalizedRefsRef.current,
          nextBgSeq: () => bgSeqRef.current++,
          addToast: (toast) => useToastStore.getState().addToast(toast),
          resolveCatName,
          clearDoneTimeout,
          pendingCallbacks: pendingCallbacksRef.current,
          deferPendingCallback,
          deletePendingCallback,
        });
        return;
      }

      // Active thread (or malformed missing threadId) — F173 A.5 + A.6 bidirectional
      // suppression handoff. After callback replace (in either direction), late stream
      // chunks for that invocation are dropped; without this guard, store's hard-merge
      // by (catId, invocationId) would overwrite authoritative callback content.
      // F194 Phase Z3 R16 (cloud Codex P1): suppression key prefers turn id when present so
      // siblings under same parent chain don't get cross-suppressed.
      const activePathSuppressionKey = msg.turnInvocationId ?? msg.invocationId;
      if (
        isActiveThreadMessage &&
        msg.type === 'text' &&
        msg.origin !== 'callback' &&
        activePathSuppressionKey &&
        msg.threadId &&
        isInvocationReplaced(msg.threadId, msg.catId, activePathSuppressionKey)
      ) {
        recordDebugEvent({
          event: 'agent_message',
          threadId: msg.threadId,
          action: 'drop_active_promotion_late_chunk',
          timestamp: Date.now(),
        });
        settlePendingActiveTextFinalCallback(msg, { stale: true });
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
        // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
        if (
          msg.origin !== 'callback' &&
          shouldSuppressLateStreamChunk(msg.catId, msg.turnInvocationId ?? msg.invocationId)
        ) {
          settlePendingActiveTextFinalCallback(msg, { stale: true });
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

          // F183 Phase B1.2.4 — callback path wire-up to reducer (single-writer)。
          // 仅 explicit msg.invocationId 路径走 reducer；invocationless callback 留 legacy
          // (reducer 没有 activeId / finalized ref / rich placeholder ref 等上下文，
          // 砚砚 verdict)。reducer 的 callback-specific 升级 policy（findUpgradableCallbackPlaceholder）
          // 严格于 stream 通用 upgrade：仅 rich/tool-only invocationless placeholder 可被
          // 升级，contentful invocationless live stream 绝不能 hijack。
          const hasExplicitInvocationId = !!msg.invocationId;
          if (hasExplicitInvocationId && msg.invocationId) {
            const callbackThreadId = msg.threadId ?? useChatStore.getState().currentThreadId;
            // #814 P2: explicit post_message must bypass stream-open deferral.
            // The pending map keys by thread/cat/invocation (no messageId), so multiple
            // explicit posts from the same invocation overwrite each other. Explicit
            // posts are standalone bubbles — apply them immediately even while streaming.
            if (
              !msg.extra?.isExplicitPost &&
              isActiveCallbackStillStreaming(msg.catId, msg.turnInvocationId ?? msg.invocationId)
            ) {
              deferPendingCallback(
                {
                  ...msg,
                  threadId: callbackThreadId,
                },
                callbackThreadId,
              );
              return;
            }
            applyActiveExplicitCallbackNow({ ...msg, threadId: callbackThreadId });
            return;
          } else if (replacementTarget) {
            const finalId = msg.messageId ?? replacementTarget.id;
            if (finalId !== replacementTarget.id) {
              replaceMessageId(replacementTarget.id, finalId);
            }

            // F183 Phase B1.4 — invocationless callback path wire-up to reducer
            // (single-writer). Pass finalId (= replacementTarget.id 或 msg.messageId
            // 覆盖) 作为 event.messageId hint，reduceCallbackFinal 的 invocationless
            // 分支命中现有 bubble → 就地 patch (content/origin/isStreaming)。
            // recoveryAction !== 'none' 时 fallback 到 legacy patchMessage 保 content。
            // 共存 side-effects (deleteActive / clearFinalized / markReplacedInvocation)
            // 跟 legacy 一致保留。
            const threadIdForCallback = msg.threadId ?? useChatStore.getState().currentThreadId;
            const event = adaptIncomingToBubbleEvent(
              { ...msg, threadId: threadIdForCallback } as BackgroundAgentMessage,
              { sourcePath: 'callback' },
            );
            let reducerHandled = false;
            if (event) {
              const eventWithHint = { ...event, messageId: finalId };
              const storeSnapshot = useChatStore.getState();
              const result = applyBubbleEventWithRecovery({
                threadId: threadIdForCallback,
                event: eventWithHint,
                currentMessages: storeSnapshot.messages,
              });
              if (result.recoveryAction === 'none') {
                storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
                reducerHandled = true;
              }
              if (result.violations.length > 0) {
                for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
              }
            }

            // metadata / extra.crossPost / mentionsUser / replyTo / replyPreview
            // 是 reducer 不 model 的 side fields —— reducer 命中后用 patchMessage
            // 单独写，保持 B1.2.4 active callback explicit 路径同款语义。
            // F194 Phase Z3 R3 P1-3 (砚砚): side patch 写完整 dual id stream 不擦掉 reducer
            // 已写好的 turnInvocationId（applyMessagePatch 是 shallow merge, stream 整块替换）。
            const extraForPatch = {
              ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
              ...(hasExplicitInvocationId && msg.invocationId
                ? {
                    stream: {
                      invocationId: msg.invocationId,
                      ...(msg.turnInvocationId && msg.turnInvocationId !== msg.invocationId
                        ? { turnInvocationId: msg.turnInvocationId }
                        : {}),
                    },
                  }
                : {}),
            };
            if (reducerHandled) {
              if (
                msg.metadata ||
                Object.keys(extraForPatch).length > 0 ||
                msg.mentionsUser ||
                msg.replyTo ||
                msg.replyPreview
              ) {
                patchMessage(finalId, {
                  ...(msg.metadata ? { metadata: msg.metadata } : {}),
                  ...(Object.keys(extraForPatch).length > 0 ? { extra: extraForPatch } : {}),
                  ...(msg.mentionsUser ? { mentionsUser: true } : {}),
                  ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
                  ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
                });
              }
            } else {
              // legacy fallback: reducer 拒绝（quarantine / sot-override），
              // 保持原本的 patchMessage 行为，content 一定要落到 store。
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
            }
            deleteActive(msg.catId);
            clearFinalized(msg.catId);
            if (invocationId) {
              // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
              markReplacedInvocation(
                useChatStore.getState().currentThreadId,
                msg.catId,
                msg.turnInvocationId ?? invocationId,
              );
            }
          } else {
            // F194 Phase Z3 R17 (cloud Codex P1#2): bubble id seeded with turn-priority key
            // so same-parent multi-turn callback creates distinct bubbles instead of dedup-collapsing.
            const id =
              msg.messageId ??
              deriveBubbleId(
                msg.turnInvocationId ?? invocationId,
                msg.catId,
                () => `msg-${Date.now()}-${msg.catId}-cb-${++cbSeq}`,
              );
            // F194 Phase Z3 R3 P1-3: invocationless callback add 也写完整 dual id
            const extraForAdd = {
              ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
              ...(msg.extra?.targetCats ? { targetCats: msg.extra.targetCats } : {}),
              ...(hasExplicitInvocationId && msg.invocationId
                ? {
                    stream: {
                      invocationId: msg.invocationId,
                      ...(msg.turnInvocationId && msg.turnInvocationId !== msg.invocationId
                        ? { turnInvocationId: msg.turnInvocationId }
                        : {}),
                    },
                  }
                : {}),
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
              // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
              markReplacedInvocation(
                useChatStore.getState().currentThreadId,
                msg.catId,
                msg.turnInvocationId ?? invocationId,
              );
            }
          }
        } else {
          // CLI stream message (thinking): append to active stream bubble
          const activeTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(
            msg.catId,
            msg.invocationId,
            msg.turnInvocationId,
          );
          const messageId = getOrRecoverActiveAssistantMessageId(msg.catId, msg.metadata, {
            ensureStreaming: true,
            ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
            ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
          });
          if (messageId) {
            // F183 Phase B1.2.2 — active text stream chunk into existing bubble
            // routes through BubbleReducer (single-writer) **only when msg has a
            // canonical invocationId**. Invocationless legacy chunks stay on the
            // direct-mutation path (reducer 的 stable-key 查重需要 canonicalInvocationId)。
            // New-bubble 创建仍走旧路径（B1.2.3 收口）。
            if (msg.invocationId) {
              const threadId = msg.threadId ?? useChatStore.getState().currentThreadId;
              const event = adaptIncomingToBubbleEvent(
                {
                  ...msg,
                  threadId,
                  ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
                } as BackgroundAgentMessage,
                {
                  sourcePath: 'active',
                },
              );
              if (event) {
                // Caller-provided id 优先于 reducer 自己 derive，保持与 deriveBubbleId
                // 的 `msg-${inv}-${cat}` 兼容（不带 bubbleKind 后缀），避免 callback
                // strict-match 用 deriveBubbleId 找不到。
                const eventWithId = event.messageId ? event : { ...event, messageId };
                // Round 1 P1 (云端 codex): replaceMessages 同时写 messages 和 hasMore；
                // 强制 false 会让 `useChatHistory` gate on hasMore 永远为 false，杀掉
                // 老历史 pagination。复用当前 store hasMore，保持 live chunk 不动 pagination。
                const storeSnapshot = useChatStore.getState();
                const result = applyBubbleEventWithRecovery({
                  threadId,
                  event: eventWithId,
                  currentMessages: storeSnapshot.messages,
                });
                storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
                // Round 1 P1 #2 (砚砚): forward reducer violations to invariant gate；
                // F183 plan 明确要求每条收口 callsite `result.violations.forEach(...)`，
                // 不接 = canonical-split / phase-regression / duplicate 在 hot path 静默。
                if (result.violations.length > 0) {
                  for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
                }
              }
            } else if (msg.textMode === 'replace') {
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
            // F183 Phase B1.2.3 — active stream NEW-bubble creation routes through
            // reducer (single-writer). Reducer 的 reduceStreamChunk 在无现有 bubble +
            // 无 upgradable placeholder 时调用 makePlaceholder 创建新 bubble。
            //
            // F173 hotfix (砚砚 4 件套 #2) — prefer explicit msg.invocationId from event.
            // Cloud P1#8 (PR#1352): fall back to activeInvocations (the FRESH signal, set
            // by intent_mode UPSTREAM of invocation_created) when msg.invocationId is missing.
            let invocationId = msg.invocationId;
            if (!invocationId) {
              const fallback = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
              if (fallback) invocationId = fallback;
            }
            const activeTurnInvocationIdForNew = resolveEffectiveTurnInvocationIdForCat(
              msg.catId,
              invocationId,
              activeTurnInvocationId,
            );
            // F194 Phase Z3 R3 P1-2: bubble id 用 turn-priority (turnInvocationId ?? invocationId)
            let bubbleIdSeed3 = invocationId;
            if (activeTurnInvocationIdForNew) bubbleIdSeed3 = activeTurnInvocationIdForNew;
            const id = bubbleIdSeed3
              ? deriveBubbleId(bubbleIdSeed3, msg.catId, () => `msg-${Date.now()}-${msg.catId}`)
              : `msg-${Date.now()}-${msg.catId}`;
            const seedSource: ActiveSeedSource = activeTurnInvocationIdForNew ? 'bound' : 'fresh-parent-seed';
            setActive(
              msg.catId,
              id,
              invocationId,
              seedSource,
              freshParentSeedProof(seedSource, msg.timestamp, msg.seq),
            );
            const threadId = msg.threadId ?? useChatStore.getState().currentThreadId;
            const event = adaptIncomingToBubbleEvent(
              {
                ...msg,
                threadId,
                invocationId,
                ...(activeTurnInvocationIdForNew ? { turnInvocationId: activeTurnInvocationIdForNew } : {}),
              } as BackgroundAgentMessage,
              {
                sourcePath: 'active',
              },
            );
            if (event) {
              const eventWithId = { ...event, messageId: id };
              const storeSnapshot = useChatStore.getState();
              const result = applyBubbleEventWithRecovery({
                threadId,
                event: eventWithId,
                currentMessages: storeSnapshot.messages,
              });
              storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
              if (result.violations.length > 0) {
                for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
              }
            }
            // Side-effect patches that reducer doesn't model (metadata / replyTo / replyPreview).
            // 这些 fields adapter 不透传 (msg.metadata 不在 adapter mapping 里)。
            if (msg.metadata || msg.replyTo || msg.replyPreview) {
              patchMessage(id, {
                ...(msg.metadata ? { metadata: msg.metadata } : {}),
                ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
                ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              });
            }
          }
          settlePendingActiveTextFinalCallback(msg);
        }
      } else if (msg.type === 'text') {
        settlePendingActiveTextFinalCallback(msg);
      } else if (msg.type === 'tool_use') {
        // Cloud P1#3 (PR#1352): suppress stale tool_use for completed invocation.
        // Done handler markReplacedInvocation for msg.invocationId; this check drops
        // reordered events before they can collide with the deterministic bubble id.
        // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
        if (shouldSuppressLateStreamChunk(msg.catId, msg.turnInvocationId ?? msg.invocationId)) return;
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

        const activeTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(
          msg.catId,
          msg.invocationId,
          msg.turnInvocationId,
        );
        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
          ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
          ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
          ...(!activeTurnInvocationId ? { avoidParentOnlyResidueRecovery: true } : {}),
          currentEventTimestamp: msg.timestamp,
          currentEventSeq: msg.seq,
        });
        const activeSeed = getActive(msg.catId);
        const useFreshParentSeedDirectly =
          !activeTurnInvocationId &&
          activeSeed?.id === messageId &&
          isCurrentFreshParentSeed(activeSeed, msg.timestamp, msg.seq);

        // F183 Phase B1.6 — tool_use wire-up via reducer (single-writer)。
        // ensureActiveAssistantMessage 仍跑，因为它管 activeRefs ledger。reducer
        // 的 reduceToolEvent 把 toolEvent append 到同 invocation 的 assistant
        // bubble.toolEvents（找的是 extra.stream.invocationId === canonical 的气泡，
        // 跟 ensureActiveAssistantMessage 创建的 id 无关）。recoveryAction !== 'none'
        // 或 invocationless 回退 legacy appendToolEvent。
        const toolUseEventData: ToolEvent = {
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_use',
          label: `${msg.catId} → ${toolName}`,
          ...(detail ? { detail } : {}),
          timestamp: Date.now(),
        };
        let toolUseReducerHandled = false;
        if (msg.invocationId && !useFreshParentSeedDirectly) {
          const threadIdForTool = msg.threadId ?? useChatStore.getState().currentThreadId;
          const event = adaptIncomingToBubbleEvent(
            {
              ...msg,
              threadId: threadIdForTool,
              ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
            } as BackgroundAgentMessage,
            {
              sourcePath: 'active',
            },
          );
          if (event) {
            const eventWithToolEvent = {
              ...event,
              payload: { ...(event.payload ?? {}), toolEvent: toolUseEventData },
            };
            const storeSnapshot = useChatStore.getState();
            const result = applyBubbleEventWithRecovery({
              threadId: threadIdForTool,
              event: eventWithToolEvent,
              currentMessages: storeSnapshot.messages,
            });
            // F183 Phase B1.6 (砚砚 R1 P1) — reducer 在没现成 bubble 时是 no-op
            // (返回 messages 原引用)，wire-up 用引用相等检测 reducer 是否真 mutated。
            // recoveryAction === 'none' 但 nextMessages === currentMessages 时
            // reducer 没添 toolEvent，回退 legacy appendToolEvent 兜底。
            if (result.recoveryAction === 'none' && result.nextMessages !== storeSnapshot.messages) {
              storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
              toolUseReducerHandled = true;
            }
            if (result.violations.length > 0) {
              for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
            }
          }
        }
        if (!toolUseReducerHandled) {
          appendToolEvent(messageId, toolUseEventData);
        }

        if (isFileChange) {
          console.info('[agent_message] file_change tool_use appended', {
            catId: msg.catId,
            messageId,
            activeRefCount: getActiveCount(),
          });
        }
      } else if (msg.type === 'tool_result') {
        // Cloud P1#3 (PR#1352): see tool_use note — suppress stale tool_result.
        // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
        if (shouldSuppressLateStreamChunk(msg.catId, msg.turnInvocationId ?? msg.invocationId)) return;
        setCatStatus(msg.catId, 'streaming');
        const activeTurnInvocationId = resolveEffectiveTurnInvocationIdForCat(
          msg.catId,
          msg.invocationId,
          msg.turnInvocationId,
        );
        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
          ...(msg.invocationId ? { invocationId: msg.invocationId } : {}),
          ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
          ...(!activeTurnInvocationId ? { avoidParentOnlyResidueRecovery: true } : {}),
          currentEventTimestamp: msg.timestamp,
          currentEventSeq: msg.seq,
        });
        const activeSeed = getActive(msg.catId);
        const useFreshParentSeedDirectly =
          !activeTurnInvocationId &&
          activeSeed?.id === messageId &&
          isCurrentFreshParentSeed(activeSeed, msg.timestamp, msg.seq);

        const detail = compactToolResultDetail(msg.content ?? '');
        // F183 Phase B1.6 — tool_result wire-up via reducer (same pattern as tool_use).
        const toolResultEventData: ToolEvent = {
          id: `toolr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_result',
          label: `${msg.catId} ← result`,
          detail,
          timestamp: Date.now(),
        };
        let toolResultReducerHandled = false;
        if (msg.invocationId && !useFreshParentSeedDirectly) {
          const threadIdForTool = msg.threadId ?? useChatStore.getState().currentThreadId;
          const event = adaptIncomingToBubbleEvent(
            {
              ...msg,
              threadId: threadIdForTool,
              ...(activeTurnInvocationId ? { turnInvocationId: activeTurnInvocationId } : {}),
            } as BackgroundAgentMessage,
            {
              sourcePath: 'active',
            },
          );
          if (event) {
            const eventWithToolEvent = {
              ...event,
              payload: { ...(event.payload ?? {}), toolEvent: toolResultEventData },
            };
            const storeSnapshot = useChatStore.getState();
            const result = applyBubbleEventWithRecovery({
              threadId: threadIdForTool,
              event: eventWithToolEvent,
              currentMessages: storeSnapshot.messages,
            });
            // 同 tool_use 路径 (砚砚 R1 P1)：no-op 引用相等检测 + 回退 legacy。
            if (result.recoveryAction === 'none' && result.nextMessages !== storeSnapshot.messages) {
              storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
              toolResultReducerHandled = true;
            }
            if (result.violations.length > 0) {
              for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
            }
          }
        }
        if (!toolResultReducerHandled) {
          appendToolEvent(messageId, toolResultEventData);
        }
      } else if (msg.type === 'done') {
        // Stale-terminal guard (Bug-G, shared with `error` via isStaleTerminalEvent):
        // A stale done must NOT touch cat-level or bubble-level state — doing so
        // terminates a newer invocation's bubble, clears its activeRef, and marks
        // the cat as done while the newer invocation is mid-flight. Only slot
        // cleanup for `msg.invocationId` is still safe (self-guarded below by
        // `primarySlot?.catId === msg.catId`).
        const doneDecision = decideTerminalEvent(msg.catId, msg.invocationId);
        const isStaleDone = doneDecision.stale;
        // Cloud R5 P1: stale terminal done is still terminal for its own
        // invocation. It must not mutate the current UI, but it must invalidate
        // any deferred callback so a later timeout/thread drain cannot replay it.
        if (isStaleDone && msg.invocationId) {
          settlePendingActiveCallbackOnTerminal(msg.threadId, msg.catId, msg.invocationId, 'clear');
        }
        const terminalActiveSlotKey = findTerminalActiveInvocationSlot(
          useChatStore.getState().activeInvocations,
          useChatStore.getState().catInvocations,
          msg.catId,
          msg.invocationId,
          msg.turnInvocationId,
        );

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
            ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
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
                k?.endsWith(suffix) ? k.slice(0, -suffix.length) : k;
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
              // F194 Phase Z3 R8 P1-3 (砚砚): turn-only matching for dual-id bubbles. Reject newer
              // turn (bound, with turn key, ≠ msg's turn?? parent). Allow unbound or matching key.
              const expected = msg.turnInvocationId ?? msg.invocationId;
              const bound = m.extra?.stream?.invocationId;
              if (!bound) return true; // unbound placeholder eligible
              if (!expected) return false;
              return sameBubbleStableKey(m, expected, msg.catId);
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
              // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
              markReplacedInvocation(
                useChatStore.getState().currentThreadId,
                msg.catId,
                msg.turnInvocationId ?? msg.invocationId,
              );
            }
          }
          // F183 Phase B1.3 — finalize cross-kind bubbles via reducer (single-writer).
          // ORDER MATTERS (cloud P1, R3 review): reducer must run AFTER legacy
          // recovery + setFinalized — reduceDoneEvent flips ALL {catId, invocationId,
          // isStreaming} matches to isStreaming=false, which would make
          // getOrRecoverActiveAssistantMessageId fall through to a non-streaming
          // callback bubble, then setFinalized records that callback id (origin=
          // 'callback'), then later invocationless callback's findInvocationless-
          // StreamPlaceholder rejects it (requires origin='stream') → split bubble.
          // Running reducer here means: legacy already finalized the recovered
          // assistant_text bubble (no-op match for that one), reducer additionally
          // finalizes any *other* same-invocation streaming bubbles (cross-kind
          // co-existence: tool_or_cli / thinking) per ADR-033.
          if (!isStaleDone && msg.invocationId) {
            const threadId = msg.threadId ?? useChatStore.getState().currentThreadId;
            const event = adaptIncomingToBubbleEvent({ ...msg, threadId } as BackgroundAgentMessage, {
              sourcePath: 'active',
            });
            if (event) {
              const storeSnapshot = useChatStore.getState();
              const result = applyBubbleEventWithRecovery({
                threadId,
                event,
                currentMessages: storeSnapshot.messages,
              });
              if (result.recoveryAction === 'none') {
                storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
              }
              if (result.violations.length > 0) {
                for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
              }
            }
          }

          if (msg.isFinal && messageId && !isStaleDone) {
            const stateAfterFinalize = useChatStore.getState();
            const finalized = stateAfterFinalize.messages.find((m) => m.id === messageId);
            if (shouldCatchUpEmptyFinalStreamBubble(finalized)) {
              const tid = msg.threadId ?? stateAfterFinalize.currentThreadId;
              console.warn('[stream-catchup] done(isFinal) with empty stream CLI bubble — requesting catch-up', {
                catId: msg.catId,
                threadId: tid,
                messageId,
                invocationId: msg.invocationId,
              });
              if (tid) {
                requestStreamCatchUp(tid);
              }
            } else {
              const residueTerminalization = terminalizeSameParentLocalToolOnlyResidues(
                stateAfterFinalize.messages,
                finalized,
                msg.invocationId,
              );
              if (residueTerminalization.found) {
                const tid = msg.threadId ?? stateAfterFinalize.currentThreadId;
                if (residueTerminalization.terminalized) {
                  stateAfterFinalize.replaceMessages(residueTerminalization.messages, stateAfterFinalize.hasMore);
                }
                console.warn(
                  '[stream-catchup] done(isFinal) with same-parent local tool residue — requesting catch-up',
                  {
                    catId: msg.catId,
                    threadId: tid,
                    messageId,
                    invocationId: msg.invocationId,
                    terminalizedResidue: residueTerminalization.terminalized,
                  },
                );
                if (tid) {
                  requestStreamCatchUp(tid);
                }
              }
            }
          }

          if (!isStaleDone && msg.invocationId) {
            settlePendingActiveCallbackOnTerminal(msg.threadId, msg.catId, msg.invocationId, 'drain');
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
          (useChatStore.getState().catInvocations?.[msg.catId]?.invocationId === msg.invocationId ||
            useChatStore.getState().catInvocations?.[msg.catId]?.turnInvocationId === msg.invocationId)
        ) {
          setCatInvocation(msg.catId, { invocationId: undefined, turnInvocationId: undefined });
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
          if (terminalActiveSlotKey) {
            removeActiveInvocation(terminalActiveSlotKey);
          }
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
        const handoffInvocationId = msg.targetCatId
          ? resolveSequentialHandoffInvocationId(msg.catId, msg.invocationId)
          : undefined;
        if (msg.targetCatId && handoffInvocationId) {
          maybeMigrateSequentialInvocationOwnership(msg.targetCatId, handoffInvocationId);
        }
        // F173 bug fix: use server timestamp + marker so chatStore inserts
        // this routing pill at the right position relative to the next cat's
        // stream bubble (WebSocket race could otherwise put it after).
        // Cloud Codex R2 P2-2: include monotonic suffix so two same-ms handoff
        // events from the same cat don't collide on `addMessage`'s id-based dedup
        // (background path already uses nextBgSeq for the same reason).
        const serverTs = msg.timestamp ?? Date.now();
        addMessage({
          id: msg.messageId ?? `a2a-${serverTs}-${msg.catId}-${nextActiveA2AHandoffSeq()}`,
          type: 'system',
          variant: 'info',
          content: msg.content ?? '',
          timestamp: serverTs,
          extra: {
            systemKind: 'a2a_routing',
            a2aRouting: {
              fromCatId: msg.catId,
              targetCatId: msg.targetCatId,
              invocationId: msg.invocationId,
            },
          },
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
          const visible = formatVisibleSystemInfo(parsed, resolveCatName, msg.catId);
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
        let systemInfo: SystemInfoProjection | undefined;
        try {
          const parsed = JSON.parse(sysContent);
          const visible = formatVisibleSystemInfo(parsed, resolveCatName, msg.catId);
          if (visible) {
            sysContent = visible.content;
            sysVariant = visible.variant;
            systemInfo = retainSystemInfo(parsed, msg.catId);
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
            // F194 Phase Z3 R18 (cloud Codex P1#3): extract turn id (mirror bg handler at line 382-386)
            // so active rebind writes dual id consistently. Otherwise found.extra.stream stores only
            // parent; subsequent chunk with turn fails sameBubbleStableKey → marks stale → split bubble.
            // Priority: msg.turnInvocationId (Z3 broadcast) > parsed.invocationId (raw inner child id
            // when distinct from outer parent) > undefined.
            const turnInvocationId =
              msg.turnInvocationId ??
              (typeof parsed.invocationId === 'string' && parsed.invocationId !== invocationId
                ? parsed.invocationId
                : undefined);
            if (targetCatId && invocationId) {
              setCatInvocation(targetCatId, {
                invocationId,
                ...(turnInvocationId ? { turnInvocationId } : {}),
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
              // F194 Phase Z3 R19 (cloud Codex P1): boundary cleanup compares TURN-aware stable keys,
              // not parent-only. Otherwise two turns from same cat share parent → old streaming bubble
              // (whose done was dropped) skips cleanup → stale streaming UI + late events keep mutating.
              const incomingStableKey = turnInvocationId ?? invocationId;
              for (const m of messagesSnapshot) {
                if (m.type !== 'assistant' || m.catId !== targetCatId || m.origin !== 'stream') continue;
                if (!m.isStreaming) continue;
                const boundInv = m.extra?.stream?.invocationId;
                if (!boundInv) continue;
                const boundTurn = m.extra?.stream?.turnInvocationId;
                // Stable key: turn (when stored) > parent. Old turn under same parent gets distinct key.
                const boundaryStableKey = boundTurn ?? boundInv;
                if (boundaryStableKey !== incomingStableKey) {
                  // F194 follow-up (codex live-split, cloud P1 2026-06-15 / 宪宪 opus-48):
                  // a parent-ONLY seed of THIS incoming invocation is NOT stale. When the
                  // CLI tool_use builds the work-log bubble before invocation_created stamps
                  // the per-cat-turn id, that bubble is bound to the parent (boundInv ===
                  // incoming invocationId, no turn). It is the current turn's work-log, not a
                  // leftover from a prior invocation. Finalizing it here (set non-streaming +
                  // markReplaced) is exactly what defeats the later turn-text merge and splits
                  // the bubble (the downstream getOrRecover upgrade is gated on isStreaming).
                  // Upgrade it to the turn id + key (keep streaming) instead of finalizing.
                  // Real-shape (tool already carried turn -> boundTurn set) and genuinely stale
                  // bubbles (boundInv !== invocationId) fall through to the finalize path.
                  // cloud P1#2/P1#5 (2026-06-15): gate on the active fresh seed. A stale
                  // parent-only bubble from an EARLIER turn of the SAME parent (lost done /
                  // reconnect — exactly what this boundary pass exists to finalize) also
                  // matches boundInv===invocationId && !boundTurn; only the current
                  // fresh-parent-seed may be upgraded, the stale/recovered one must still
                  // fall through to finalize.
                  const activeRefForBoundary = getActive(targetCatId);
                  if (
                    turnInvocationId &&
                    boundInv === invocationId &&
                    !boundTurn &&
                    activeRefForBoundary?.id === m.id &&
                    isCurrentFreshParentSeed(activeRefForBoundary, msg.timestamp, msg.seq)
                  ) {
                    setMessageStreamInvocation(m.id, invocationId, turnInvocationId);
                    const turnDerivedId = deriveBubbleId(turnInvocationId, targetCatId, () => m.id);
                    if (turnDerivedId !== m.id) replaceMessageId(m.id, turnDerivedId);
                    setActive(targetCatId, turnDerivedId, invocationId, 'bound');
                    continue;
                  }
                  setStreaming(m.id, false);
                  // R16: suppression set entry uses turn-aware key so siblings under same parent
                  // chain don't get cross-suppressed.
                  boundaryReplacedInvs.add(boundaryStableKey);
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
                // F194 Phase Z3 R18 (cloud Codex P1#3): bubble id seeded with turn-priority key + write dual id
                // so subsequent chunks (with both ids) match via sameBubbleStableKey instead of marking stale.
                const deterministicSeed = turnInvocationId ?? invocationId;
                const deterministicId = deriveBubbleId(deterministicSeed, targetCatId, () => unboundPlaceholderId!);
                if (deterministicId !== unboundPlaceholderId) {
                  replaceMessageId(unboundPlaceholderId, deterministicId);
                  setMessageStreamInvocation(deterministicId, invocationId, turnInvocationId);
                } else {
                  setMessageStreamInvocation(unboundPlaceholderId, invocationId, turnInvocationId);
                }
                // Cloud P1#9 (PR#1352): unconditionally point activeRefs at the rebound
                // bubble (even when it wasn't the prior activeRef target). Newest→oldest
                // scan picked the LIVE bubble for inv-new — leaving activeRefs on a stale
                // older bubble would let later invocationless chunks reuse it via
                // ensureStreaming and append into the previous invocation's bubble.
                const reboundId = deterministicId !== unboundPlaceholderId ? deterministicId : unboundPlaceholderId;
                setActive(targetCatId, reboundId, invocationId, 'bound');
              } else {
                // Legacy path: no unbound placeholder but there's some existing message we can
                // bind invocationId onto (preserves behavior for messages already matching newInv).
                // F194 Phase Z3 R18: forward turnInvocationId so recovery uses turn-priority lookup.
                const targetId = getOrRecoverActiveAssistantMessageId(targetCatId, undefined, {
                  invocationId,
                  ...(turnInvocationId ? { turnInvocationId } : {}),
                });
                if (targetId) {
                  setMessageStreamInvocation(targetId, invocationId, turnInvocationId);
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
              // F230: write model/provider FIRST so setMessageMetadata creates the metadata
              // object when absent (PTY text events carry no metadata).
              // setMessageUsage is a no-op when metadata is absent — ordering matters.
              // For -p/bg paths, setMessageMetadata is first-write-wins → no-op (idempotent).
              if (parsed.model && parsed.provider) {
                setMessageMetadata(ref.id, {
                  model: parsed.model as string,
                  provider: parsed.provider as string,
                });
              }
              setMessageUsage(ref.id, parsed.usage);
            }
            consumed = true;
          } else if (parsed?.type === 'context_briefing') {
            // Suppress: internal routing context for cats, not user-facing timeline.
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
            // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
            if (!shouldSuppressLateStreamChunk(msg.catId, msg.turnInvocationId ?? effectiveInv)) {
              setCatStatus(msg.catId, 'streaming');
              const count = typeof parsed.count === 'number' ? parsed.count : 1;
              const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
                ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
                currentEventTimestamp: msg.timestamp,
                currentEventSeq: msg.seq,
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
            // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
            if (thinkingText && !shouldSuppressLateStreamChunk(msg.catId, msg.turnInvocationId ?? effectiveInv)) {
              const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
                ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
                currentEventTimestamp: msg.timestamp,
                currentEventSeq: msg.seq,
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
          } else if (parsed?.type === 'agy_trajectory_progress') {
            // F210-H3: 累积进度到 thread 级 catStatusDetails（折叠单行 "AGY working · N steps · latest"），
            // 由 ThreadCatStatus 显示；不渲染 system bubble（承接 H1-hotfix 避免 per-step 刷屏）。
            if (msg.catId) {
              const tid = msg.threadId ?? useChatStore.getState().currentThreadId;
              if (tid) {
                useChatStore
                  .getState()
                  .updateThreadCatStatus(tid, msg.catId, 'streaming', formatAgyProgressDetail(parsed));
              }
            }
            consumed = true;
          } else if (parsed?.type === 'provider_capability') {
            // #939 part A (kimi auth dual-path): capability telemetry from provider backends
            // (kimi emits `thinking: unavailable` / `image_input: limited`, etc.). These are
            // capability status reports — NOT user-facing errors. Before this branch they
            // fell through to the default addMessage() path and surfaced as raw-JSON system
            // bubbles, which first-time users read as "thinking failed" (the bug). Pattern
            // mirrors F210-H1 agy_trajectory_progress + F045 rate_limit / compact_boundary:
            // store on the invocation snapshot for a future capability UI (tooltip / badge);
            // consumed silently here so the bubble layer never sees these.
            // Note: || (not ??) so empty-string parsed.catId falls through to msg.catId
            // (opus-46 nit from #2352 review — defensive against backend emitting empty string).
            const targetCatId = parsed.catId || msg.catId;
            const capability = typeof parsed.capability === 'string' ? parsed.capability : 'unknown';
            const status =
              parsed.status === 'available' || parsed.status === 'limited' || parsed.status === 'unavailable'
                ? parsed.status
                : 'unavailable';
            const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
            const provider = typeof parsed.provider === 'string' ? parsed.provider : 'unknown';
            if (targetCatId) {
              // Read-merge-write so multiple capabilities (thinking + image_input) coexist on
              // the same cat invocation. setCatInvocation is a shallow zustand merge, so
              // passing a fresh object would clobber other capabilities already stored.
              const existing = useChatStore.getState().catInvocations?.[targetCatId]?.providerCapabilities ?? {};
              setCatInvocation(targetCatId, {
                providerCapabilities: {
                  ...existing,
                  [capability]: { status, reason, provider, receivedAt: Date.now() },
                },
              });
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
          } else if (isInternalSystemInfoTelemetry(parsed)) {
            // Internal telemetry — suppress to avoid raw JSON bubbles
            consumed = true;
          } else if (parsed?.type === 'silent_completion') {
            // Bugfix: silent-exit — cat ran tools but produced no text response
            const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
            sysContent = detail || `${resolveCatName(msg.catId)} completed without a text response.`;
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

            // F194 Phase Z3 R16 (cloud Codex P1): suppression key uses turn id when present.
            const suppressedLateRichBlock = shouldSuppressLateStreamChunk(
              msg.catId,
              msg.turnInvocationId ?? effectiveInv,
            );
            const richBlockHasExplicitInvocation = Boolean(msg.turnInvocationId ?? effectiveInv);
            if (!targetId && !suppressedLateRichBlock && !richBlockHasExplicitInvocation) {
              // F194 Phase Z6: invocationless rich/audio events may arrive after done.
              // `findInvocationlessStreamPlaceholder` includes the just-finalized stream
              // bubble recorded by done, so late rich blocks attach to the existing
              // assistant container instead of spawning a second small bubble until F5.
              // Cloud P1 (PR #1623): keep this fallback invocationless-only. Rich blocks
              // with a fresh invocation/turn id must not patch the previous finalized turn.
              targetId = findInvocationlessStreamPlaceholder(msg.catId)?.id;
            }

            if (!targetId && !suppressedLateRichBlock) {
              // Final fallback: recover the active stream bubble before creating a placeholder.
              targetId = ensureActiveAssistantMessage(msg.catId, msg.metadata, {
                ...(effectiveInv ? { invocationId: effectiveInv as string } : {}),
                ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
                currentEventTimestamp: msg.timestamp,
                currentEventSeq: msg.seq,
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
            const visibleSessionSeal = formatSessionSealRequested(parsed, resolveCatName);
            if (visibleSessionSeal) {
              sysContent = visibleSessionSeal.content;
              systemInfo = retainSystemInfo(parsed, msg.catId);
            }
          }
        } catch {
          /* not JSON, use raw content */
        }
        if (!consumed) {
          const sysCliDiag = msg.metadata?.cliDiagnostics;
          const extra =
            systemInfo || sysCliDiag
              ? {
                  ...(systemInfo ? { systemInfo } : {}),
                  ...(sysCliDiag ? { cliDiagnostics: sysCliDiag } : {}),
                }
              : undefined;
          addMessage({
            id: `sysinfo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'system',
            variant: sysVariant,
            content: sysContent,
            timestamp: Date.now(),
            ...(extra ? { extra } : {}),
          });
        }
      } else if (msg.type === 'error') {
        // Stale-terminal guard (砚砚 R6, shared with `done`): late error(inv-1)
        // arriving after inv-2 has already started must NOT touch inv-2's bubble
        // or clear activeRefs for the newer invocation. See isStaleTerminalEvent
        // for the full resolver + normalization rationale.
        const errorDecision = decideTerminalEvent(msg.catId, msg.invocationId);
        const isStaleError = errorDecision.stale;
        const recoverableInFlightError = isRecoverableInFlightError(msg);

        // Cloud R9 P2: `pendingTimeoutDiagRef` is keyed by `catId` alone — if we
        // skip cleanup under the stale guard, the entry leaks and would wrongly
        // attach to a later non-stale error for the same cat on a different
        // invocation. Delete unconditionally on any error arrival; the only
        // read happens inside the `!isStaleError` branch below, so stale errors
        // correctly drop the diagnostics (rather than consuming them for wrong
        // invocation).
        const timeoutDiag = msg.catId ? getPendingTimeoutDiag(msg.catId) : null;
        if (msg.catId) clearPendingTimeoutDiag(msg.catId);

        // Cloud R4 P1: pending callback ownership is invocation-terminal.
        // A stale nonrecoverable error must not mutate the current UI, but it is
        // still the terminal event for its own invocation and must invalidate the
        // deferred callback so a later timeout/thread drain cannot replay it.
        if (!recoverableInFlightError && msg.invocationId) {
          settlePendingActiveCallbackOnTerminal(msg.threadId, msg.catId, msg.invocationId, 'clear');
        }

        if (!isStaleError) {
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
              ...(msg.turnInvocationId ? { turnInvocationId: msg.turnInvocationId } : {}),
            });
            // Cloud R15 + P1#1 + P1#7 permissive fallback (see done path for full rationale).
            if (!messageId && msg.invocationId) {
              const slotFreshConfirmed = ((): boolean => {
                const s = useChatStore.getState();
                const suffix = `-${msg.catId}`;
                const normalize = (k: string | undefined): string | undefined =>
                  k?.endsWith(suffix) ? k.slice(0, -suffix.length) : k;
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
                // F194 Phase Z3 R8 P1-3 (砚砚): mirror done path turn-only matching.
                const expected = msg.turnInvocationId ?? msg.invocationId;
                const bound = m.extra?.stream?.invocationId;
                if (!bound) return true;
                if (!expected) return false;
                return sameBubbleStableKey(m, expected, msg.catId);
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

          // F183 Phase B1.5 — active error wire-up via reducer (single-writer).
          // caller 拼好 display content（含 errorSubtype label）+ extra
          // (timeoutDiagnostics) 后透传给 reducer 的 reduceErrorEvent。canonical
          // event 走 stable-key dedup；invocationless event 落 standalone bubble。
          // recoveryAction !== 'none' 或缺 invocationId 时回退 legacy addMessage。
          const errorDisplayContent = (() => {
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
          })();
          // F212 Phase B: pick up structured CLI diagnostics that providers stamp on
          // `metadata.cliDiagnostics` (Phase A). Independent of the timeout-only pending ledger
          // — cliDiagnostics is one-shot on the error event itself, no precursor stash needed.
          const cliDiag = msg.metadata?.cliDiagnostics;
          const errorExtra: ChatMessage['extra'] | undefined =
            timeoutDiag || cliDiag
              ? {
                  ...(timeoutDiag
                    ? {
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
                      }
                    : {}),
                  ...(cliDiag ? { cliDiagnostics: cliDiag } : {}),
                }
              : undefined;

          let errorReducerHandled = false;
          if (msg.invocationId) {
            const threadIdForError = msg.threadId ?? useChatStore.getState().currentThreadId;
            const event = adaptIncomingToBubbleEvent({ ...msg, threadId: threadIdForError } as BackgroundAgentMessage, {
              sourcePath: 'active',
            });
            if (event) {
              const eventWithEnrichment = {
                ...event,
                payload: {
                  ...(event.payload ?? {}),
                  content: errorDisplayContent,
                  ...(errorExtra ? { extra: errorExtra } : {}),
                },
              };
              const storeSnapshot = useChatStore.getState();
              const result = applyBubbleEventWithRecovery({
                threadId: threadIdForError,
                event: eventWithEnrichment,
                currentMessages: storeSnapshot.messages,
              });
              if (result.recoveryAction === 'none') {
                storeSnapshot.replaceMessages(result.nextMessages, storeSnapshot.hasMore);
                errorReducerHandled = true;
              }
              if (result.violations.length > 0) {
                for (const v of result.violations) recordBubbleInvariantViolation(v, 'warn');
              }
            }
          }

          if (!errorReducerHandled) {
            addMessage({
              id: `err-${Date.now()}-${msg.catId}`,
              type: 'system',
              variant: 'error',
              catId: msg.catId,
              content: errorDisplayContent,
              timestamp: Date.now(),
              ...(errorExtra ? { extra: errorExtra as ChatMessage['extra'] } : {}),
            });
          }
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
      applyActiveExplicitCallbackNow,
      deferPendingCallback,
      deletePendingCallback,
      resetTimeout,
      clearDoneTimeout,
      settlePendingActiveCallbackOnTerminal,
      settlePendingActiveTextFinalCallback,
      findCallbackReplacementTarget,
      findInvocationlessRichPlaceholder,
      findInvocationlessStreamPlaceholder,
      getCurrentInvocationIdForCat,
      getOrRecoverActiveAssistantMessageId,
      isActiveCallbackStillStreaming,
      ensureActiveAssistantMessage,
      maybeMigrateSequentialInvocationOwnership,
      resolveEffectiveTurnInvocationIdForCat,
      resolveSequentialHandoffInvocationId,
      shouldSuppressLateStreamChunk,
      setHasActiveInvocation,
      setMessageUsage,
      requestStreamCatchUp,
      resolveCatName,
      removeMessage,
      clearAllActive,
      clearFinalized,
      clearPendingTimeoutDiag,
      clearSawStream,
      decideTerminalEvent,
      deleteActive,
      getActive,
      getActiveCount,
      getAllActiveValues,
      getPendingTimeoutDiag,
      hadSawStream,
      markSawStream,
      setActive, // #586 follow-up: Record the finalized bubble so callback can find it
      // even after isStreaming=false + activeRefs cleared. Unlike a greedy
      // scan, this is scoped to the exact just-finalized message only.
      setFinalized,
      setPendingTimeoutDiag,
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
      clearPendingCallbacksForThread(threadId);
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
    [
      setLoading,
      clearAllActiveInvocations,
      setStreaming,
      setIntentMode,
      clearCatStatuses,
      clearDoneTimeout,
      clearPendingCallbacksForThread,
      clearAllActive,
      getAllActiveValues,
    ],
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
    // Cloud R3 P1: pending callback lifetime is invocation-terminal, not
    // navigation/reset-terminal. ChatContainer switches currentThreadId before
    // resetRefs(), so any reset-time pending cleanup can drop callbacks for the
    // newly-current thread before its done/timeout drain.
    const tid = useChatStore.getState().currentThreadId;
    if (tid) clearAllFinalizedForThreadLedger(getThreadRuntimeLedger(), tid);
  }, [clearAllActive]);

  return { handleAgentMessage, handleStop, resetRefs, resetTimeout, clearDoneTimeout };
}
