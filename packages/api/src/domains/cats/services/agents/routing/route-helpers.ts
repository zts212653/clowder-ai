/**
 * Route Helpers
 * Shared types, interfaces, and helper functions for route-serial and route-parallel.
 */

import type { CatId, MessageContent, RichBlock, RichBlockBase } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { DEFAULT_HIERARCHICAL_CONTEXT } from '../../../../../config/hierarchical-context-config.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';

const log = createModuleLogger('context-transport');

import { estimateTokens } from '../../../../../utils/token-counter.js';
import { formatMessage } from '../../context/ContextAssembler.js';
import { checkContextBudget, type DegradationResult } from '../../orchestration/DegradationPolicy.js';
import { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IMessageStore, StoredMessage, StoredToolEvent } from '../../stores/ports/MessageStore.js';
import { canViewMessage } from '../../stores/visibility.js';
import type { AgentMessage, AgentService } from '../../types.js';
import type { InvocationDeps } from '../invocation/invoke-single-cat.js';
import type { CoverageMap } from './context-transport.js';
import {
  buildCoverageMap,
  buildTombstone,
  detectRecentBurst,
  formatAnchors,
  formatTombstone,
  recallEvidence,
  scrubToolPayloads,
  selectAnchors,
} from './context-transport.js';

/** Minimal broadcast interface — avoids coupling routing layer to SocketManager concrete class */
export interface RouteBroadcaster {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

/** Dependencies shared across route strategies */
export interface RouteStrategyDeps {
  services: Record<string, AgentService>;
  invocationDeps: InvocationDeps;
  messageStore: IMessageStore;
  deliveryCursorStore?: DeliveryCursorStore;
  /** #80: Streaming draft persistence store */
  draftStore?: IDraftStore;
  /** F079 Bug 2: Optional broadcaster for real-time vote result delivery */
  socketManager?: RouteBroadcaster;
  /** F129: Pack store for loading active packs at invocation time */
  packStore?: import('../../../../packs/PackStore.js').PackStore;
  /** F148: Evidence store for context recall (optional, fail-open) */
  evidenceStore?: import('../../../../memory/interfaces.js').IEvidenceStore;
  /** F150: Tool usage counter (fire-and-forget INCR on tool_use events) */
  toolUsageCounter?: import('../../tool-usage/ToolUsageCounter.js').ToolUsageCounter;
}

/** Mutable context for tracking persistence failures across the generator boundary.
 *  Caller creates the object, passes it in RouteOptions, and checks after generator exhausts. */
export interface PersistenceContext {
  /** Set to true by route strategies when any messageStore.append() call fails */
  failed: boolean;
  /** Error details for diagnostics */
  errors: Array<{ catId: string; error: string }>;
  /** F088-P3: Rich blocks consumed during this invocation, for outbound delivery */
  richBlocks?: import('@cat-cafe/shared').RichBlock[];
}

/** Common options for both strategies */
export interface RouteOptions {
  contentBlocks?: readonly MessageContent[] | undefined;
  uploadDir?: string | undefined;
  signal?: AbortSignal | undefined;
  promptTags?: readonly string[] | undefined;
  /** Pre-assembled context (deprecated: use history for per-cat budget) */
  contextHistory?: string | undefined;
  /** Raw thread history for per-cat context assembly */
  history?: StoredMessage[] | undefined;
  /** Current user message ID (enables exact incremental context delivery path) */
  currentUserMessageId?: string | undefined;
  /** Max A2A chain depth for routeSerial (default: MAX_A2A_DEPTH env or 2) */
  maxA2ADepth?: number | undefined;
  /** Queue fairness hook: when true for current thread, routeSerial must stop extending A2A chain. */
  queueHasQueuedMessages?: ((threadId: string) => boolean) | undefined;
  /** A2A dedup hook: skip text-scan @mention if cat already dispatched via callback path. */
  hasQueuedOrActiveAgentForCat?: ((threadId: string, catId: string) => boolean) | undefined;
  /** ADR-008 S3: When provided, cursor boundaries are collected here instead of acking immediately.
   *  Caller acks after invocation succeeds. If absent, legacy immediate ack behavior. */
  cursorBoundaries?: Map<string, string>;
  /** P1-2: When provided, persistence failures are recorded here instead of silently swallowed.
   *  Caller checks after generator exhausts to determine invocation status. */
  persistenceContext?: PersistenceContext;
  /** F11: Mode-specific system prompt section (appended after identity prompt) */
  modeSystemPrompt?: string | undefined;
  /** F11: Per-cat mode prompt override (takes precedence over modeSystemPrompt) */
  modeSystemPromptByCat?: Record<string, string> | undefined;
  /** Thinking visibility: play = cats don't see each other's thinking, debug = cats share thinking. Default: play */
  thinkingMode?: 'debug' | 'play' | undefined;
  /** F108: Unique invocation ID for WorklistRegistry isolation in concurrent execution.
   *  When provided, worklist is keyed by this ID instead of threadId. */
  parentInvocationId?: string | undefined;
}

export interface IncrementalContextResult {
  contextText: string;
  boundaryId?: string;
  includesCurrentUserMessage: boolean;
  /** True when the current user message exists in unseen but was filtered out
   *  (e.g. whisper not intended for this cat). Callers must NOT inject the raw
   *  message text as fallback when this is true — doing so would leak whisper content. */
  currentMessageFilteredOut: boolean;
  /** GAP-1: User-facing message when incremental batch was truncated by budget cap */
  degradation?: string;
  /** Phase E: Coverage map for context briefing surface (only present when smart window triggered) */
  coverageMap?: CoverageMap;
  /** Phase E: Briefing context data for AC-E4 expanded view */
  briefingContext?: {
    threadMemorySummary?: string;
    anchorSummaries?: string[];
  };
}

/**
 * Decide whether the routing layer should append the raw current user message
 * outside the incremental context envelope.
 *
 * The normal path is:
 * - append when the current message is genuinely absent from unseen history
 * - do NOT append when the message was filtered out for privacy
 *
 * Defensive guard:
 * some smart-window / metadata paths can still surface the current message ID
 * inside `contextText` even when `includesCurrentUserMessage` is false.
 * In that case, appending the raw message would duplicate it in the same prompt.
 */
export function shouldAppendExplicitCurrentMessage(
  inc: Pick<IncrementalContextResult, 'contextText' | 'includesCurrentUserMessage' | 'currentMessageFilteredOut'>,
  currentUserMessageId: string | undefined,
): boolean {
  if (inc.includesCurrentUserMessage || inc.currentMessageFilteredOut) return false;
  if (currentUserMessageId && inc.contextText.includes(currentUserMessageId)) return false;
  return true;
}

/**
 * Keep cursor boundary monotonic within one invocation.
 * When the same cat is invoked multiple times (A2A re-entry), later passes may
 * observe fewer relevant messages and produce an older boundary; this helper
 * prevents regressing the deferred ack boundary.
 *
 * Assumes message IDs are lexicographically monotonic (timestamp+seq prefix).
 */
export function upsertMaxBoundary(cursorBoundaries: Map<string, string>, catId: string, boundaryId: string): void {
  const current = cursorBoundaries.get(catId);
  if (!current || boundaryId > current) {
    cursorBoundaries.set(catId, boundaryId);
  }
}

/** Get the agent service for a given cat ID */
export function getService(services: Record<string, AgentService>, catId: CatId): AgentService {
  const service = services[catId];
  if (!service) throw new Error(`Unknown cat ID: ${catId as string}`);
  return service;
}

export function shouldHandleCompletedGuide(
  guideCompletionOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallbackCatId: string | undefined,
  catId: string,
): boolean {
  if (!guideCompletionOwner) return true;
  if (guideCompletionOwner === catId) return true;
  if (!targetCatIds.has(guideCompletionOwner)) return fallbackCatId === catId;
  return false;
}

export function shouldHandleOfferedGuide(
  guideOfferOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallbackCatId: string | undefined,
  catId: string,
  hasUserSelection: boolean,
  allowOwnerMissingFallback = false,
): boolean {
  if (!guideOfferOwner) return true;
  if (guideOfferOwner === catId) return true;
  if ((hasUserSelection || allowOwnerMissingFallback) && !targetCatIds.has(guideOfferOwner)) {
    return fallbackCatId === catId;
  }
  return false;
}

export function detectContextDegradation(
  historyCount: number,
  includedCount: number,
  budget: ReturnType<typeof getCatContextBudget>,
): DegradationResult | null {
  // Existing count-based degradation logic
  const byCount = checkContextBudget(historyCount, budget);
  if (byCount.degraded) return byCount;

  // Additional char-budget degradation: history count is within budget, but content still got truncated.
  const maxCountCandidate = Math.min(historyCount, budget.maxMessages);
  if (includedCount < maxCountCandidate) {
    return {
      degraded: true,
      strategy: 'truncated',
      reason: `Token 预算限制，历史从 ${maxCountCandidate} 条截断到 ${includedCount} 条`,
      adjustedMaxMessages: includedCount,
    };
  }

  return null;
}

/** Truncate a string for tool event detail preview */
export function truncateDetail(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

/** Build a StoredToolEvent from a streaming AgentMessage */
export function toStoredToolEvent(msg: AgentMessage): StoredToolEvent | null {
  if (msg.type === 'tool_use') {
    const toolName = msg.toolName ?? 'unknown';
    let detail: string | undefined;
    if (msg.toolInput) {
      try {
        detail = truncateDetail(JSON.stringify(msg.toolInput), 200);
      } catch {
        detail = '[unserializable]';
      }
    }
    return {
      id: `tool-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'tool_use',
      label: `${msg.catId as string} → ${toolName}`,
      ...(detail ? { detail } : {}),
      timestamp: msg.timestamp,
    };
  }
  if (msg.type === 'tool_result') {
    const raw = (msg.content ?? '').trimEnd();
    const detail = raw.length > 0 ? truncateDetail(raw, 1500) : '(no output)';
    return {
      id: `toolr-${msg.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'tool_result',
      label: `${msg.catId as string} ← result`,
      detail,
      timestamp: msg.timestamp,
    };
  }
  return null;
}

const USER_FACING_SYSTEM_INFO_TYPES = new Set([
  'a2a_followup_available',
  'governance_blocked',
  'invocation_preempted',
  'mode_switch_proposal',
  'session_seal_requested',
  'silent_completion',
  'warning',
]);

/**
 * Return true when a system_info payload already produces a user-visible notice in the UI.
 * Route strategies use this to avoid appending a misleading silent_completion after an
 * actionable blocker/warning has already been surfaced.
 */
export function isUserFacingSystemInfoContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { type?: unknown };
    return typeof parsed.type === 'string' && USER_FACING_SYSTEM_INFO_TYPES.has(parsed.type);
  } catch {
    return true;
  }
}

function isInternalToolRecipientName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith('functions.') || value.startsWith('mcp__') || value.startsWith('multi_tool_use.'))
  );
}

function looksLikeLeakedToolCallPayload(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(trimmed) as {
      tool_uses?: Array<{ recipient_name?: unknown }>;
      recipient_name?: unknown;
    };
    if (Array.isArray(parsed.tool_uses)) {
      return parsed.tool_uses.some((item) => isInternalToolRecipientName(item?.recipient_name));
    }
    return isInternalToolRecipientName(parsed.recipient_name);
  } catch {
    return false;
  }
}

const LEAKED_TOOL_CALL_SIGNATURES = [
  '{"tool_uses":[{"recipient_name":"functions.',
  '{"tool_uses":[{"recipient_name":"mcp__',
  '{"tool_uses":[{"recipient_name":"multi_tool_use.',
  '{"recipient_name":"functions.',
  '{"recipient_name":"mcp__',
  '{"recipient_name":"multi_tool_use.',
];

const INTENTIONAL_JSON_EXAMPLE_LINE_RE =
  /^(?:(?:(?:文档|JSON)\s*)?示例|for\s+example|example|json\s+example|例如|比如)\s*(?:[:：]\s*)?$/i;

function looksLikePotentialLeakedToolCallPayloadPrefix(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{')) return false;

  const compact = trimmed.replace(/\s+/g, '');
  return LEAKED_TOOL_CALL_SIGNATURES.some(
    (signature) => signature.startsWith(compact) || compact.startsWith(signature),
  );
}

function findLineStartPayloadIndex(
  content: string,
  predicate: (candidate: string) => boolean,
): { index: number; candidate: string } | null {
  const lines = content.split('\n');
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('{')) {
      offset += line.length + 1;
      continue;
    }

    const leadingWhitespace = line.length - trimmed.length;
    const candidate = lines.slice(i).join('\n');
    if (predicate(candidate)) {
      return { index: offset + leadingWhitespace, candidate };
    }
    offset += line.length + 1;
  }

  return null;
}

function isIntentionalJsonExamplePrefix(prefix: string): boolean {
  const trimmed = prefix.trimEnd();
  if (!trimmed) return false;

  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    if (/^```(?:json)?$/i.test(line)) return true;
    return INTENTIONAL_JSON_EXAMPLE_LINE_RE.test(line);
  }

  return false;
}

export function stripLeakedToolCallPayload(content: string): string {
  if (!content) return content;

  const match = findLineStartPayloadIndex(content, looksLikeLeakedToolCallPayload);
  if (match) {
    const prefix = content.slice(0, match.index);
    if (isIntentionalJsonExamplePrefix(prefix)) {
      return content;
    }
    return prefix.replace(/\s+$/, '');
  }

  return content;
}

export interface RoutedMessageTransform {
  transform(msg: AgentMessage): AgentMessage[];
}

export interface LeakedToolCallStreamStripper {
  push(content: string): string;
  flush(): string;
}

export function createLeakedToolCallStreamStripper(): LeakedToolCallStreamStripper {
  let pending = '';
  let pendingEmittedLength = 0;

  return {
    push(content: string): string {
      if (!content) return content;

      const combined = pending + content;
      const alreadyEmittedLength = pendingEmittedLength;
      pending = '';
      pendingEmittedLength = 0;

      const stripped = stripLeakedToolCallPayload(combined);
      if (stripped !== combined) {
        return stripped.slice(alreadyEmittedLength);
      }

      const match = findLineStartPayloadIndex(combined, looksLikePotentialLeakedToolCallPayloadPrefix);
      if (!match) {
        return combined.slice(alreadyEmittedLength);
      }

      const emittedPrefix = combined.slice(0, match.index).replace(/\s+$/, '');
      pending = combined;
      pendingEmittedLength = emittedPrefix.length;
      return emittedPrefix.slice(alreadyEmittedLength);
    },
    flush(): string {
      if (!pending) return '';

      const remaining = pending;
      const alreadyEmittedLength = pendingEmittedLength;
      pending = '';
      pendingEmittedLength = 0;
      return stripLeakedToolCallPayload(remaining).slice(alreadyEmittedLength);
    },
  };
}

export function createRoutingMessageTransform(explicitCatId?: CatId): RoutedMessageTransform {
  const leakedPayloadStripper = createLeakedToolCallStreamStripper();

  return {
    transform(msg: AgentMessage): AgentMessage[] {
      if (msg.type === 'text') {
        const content = msg.content ? leakedPayloadStripper.push(msg.content) : msg.content;
        return content ? [{ ...msg, content }] : [];
      }

      if (msg.type === 'done') {
        const transformed: AgentMessage[] = [];
        const flushedText = leakedPayloadStripper.flush();
        if (flushedText) {
          transformed.push({
            type: 'text',
            catId: msg.catId ?? explicitCatId,
            content: flushedText,
            timestamp: msg.timestamp,
          });
        }
        transformed.push(msg);
        return transformed;
      }

      return [msg];
    },
  };
}

export function sanitizeInjectedContent(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skippingHistoryEnvelope = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHistoryHeader =
      line.startsWith('[对话历史 - 最近 ') ||
      line.startsWith('[对话历史增量 - 未发送过 ') ||
      line.startsWith('[对话历史增量 - 智能窗口');

    if (!skippingHistoryEnvelope && isHistoryHeader) {
      // Drop known injected history envelopes only.
      skippingHistoryEnvelope = true;
      continue;
    }

    if (skippingHistoryEnvelope) {
      // Use unique terminator to avoid false matches with markdown `---`
      if (trimmed === '[/对话历史]' || trimmed === '---') {
        skippingHistoryEnvelope = false;
      }
      continue;
    }

    kept.push(line);
  }

  return stripLeakedToolCallPayload(kept.join('\n')).trim();
}

/**
 * Route content blocks to the target cat.
 * All cats receive the full content blocks including images —
 * each AgentService (Claude/Codex/Gemini) handles image paths
 * via its own CLI bridge (--add-dir / --image / --include-directories).
 */
export function routeContentBlocksForCat(
  _catId: CatId,
  contentBlocks: readonly MessageContent[] | undefined,
): readonly MessageContent[] | undefined {
  return contentBlocks ?? undefined;
}

/**
 * F22: Summarize rich blocks for context injection.
 * Replaces verbose rich block JSON with compact digests so cats know
 * what was previously rendered without wasting tokens.
 */
function digestRichBlock(b: RichBlock): string {
  switch (b.kind) {
    case 'card':
      return `[卡片: ${b.title ?? '无标题'}]`;
    case 'diff':
      return `[代码 diff: ${b.filePath ?? '未知文件'}]`;
    case 'checklist':
      return `[清单: ${b.title ?? `${Array.isArray(b.items) ? b.items.length : 0} 项`}]`;
    case 'media_gallery':
      return `[图片: ${Array.isArray(b.items) ? b.items.length : 0} 张]`;
    default:
      return `[富块: ${(b as RichBlockBase).kind}]`;
  }
}

export function digestRichBlocks(msg: StoredMessage): string {
  if (!msg.extra?.rich?.blocks?.length) return msg.content;
  const digests = msg.extra.rich.blocks.map(digestRichBlock);
  return `${msg.content}\n${digests.join(' ')}`;
}

export async function fetchAfterCursor(
  messageStore: IMessageStore,
  threadId: string,
  afterId: string | undefined,
  userId: string,
): Promise<StoredMessage[]> {
  return messageStore.getByThreadAfter(threadId, afterId, undefined, userId);
}

/** Options for caller-specified budget overrides */
export interface IncrementalContextOptions {
  /**
   * When provided, overrides budget.maxContextTokens for the token-trim pass.
   * The routing layer should calculate this as:
   *   maxPromptTokens - systemPartsTokens - messageTokens - guard
   * so the assembled context + system parts never exceed the model's input limit.
   */
  effectiveMaxContextTokens?: number;
}

export async function assembleIncrementalContext(
  deps: RouteStrategyDeps,
  userId: string,
  threadId: string,
  catId: CatId,
  currentUserMessageId?: string,
  thinkingMode?: 'debug' | 'play',
  options?: IncrementalContextOptions,
): Promise<IncrementalContextResult> {
  if (!deps.deliveryCursorStore) {
    return { contextText: '', includesCurrentUserMessage: false, currentMessageFilteredOut: false };
  }

  const cursor = await deps.deliveryCursorStore.getCursor(userId, catId, threadId);
  const unseen = await fetchAfterCursor(deps.messageStore, threadId, cursor, userId);

  // Debug mode: cats see all whispers (full transparency). Play mode: cats only see their own whispers.
  const viewer = (thinkingMode ?? 'play') === 'play' ? { type: 'cat' as const, catId } : { type: 'user' as const };
  const relevant = unseen.filter((m) => {
    // System-generated messages (persisted error badges) are display-only — never enter prompt
    if (m.userId === 'system') return false;
    // F148 Phase E: briefing messages are non-routing — never enter incremental context (AC-E2)
    if (m.origin === 'briefing') return false;
    // F35: Exclude whispers not intended for this cat (play mode only)
    if (!canViewMessage(m, viewer)) return false;
    // Exclude own messages (only include user messages and other cats' messages)
    // F052 fix: exempt cross-posted messages — same catId from another thread must be visible
    if (!m.extra?.crossPost && m.catId !== null && m.catId === catId) return false;
    // In play mode, hide other cats' stream (thinking) messages.
    // Legacy messages (no origin) are visible for backward compatibility —
    // all new writes are tagged, so untagged = legacy callback data.
    if ((thinkingMode ?? 'play') === 'play' && m.catId !== null && m.origin === 'stream') return false;
    return true;
  });

  // F35 fix: detect when the current message was present but filtered out by visibility
  // (e.g. whisper not intended for this cat). Must NOT fallback-inject in that case.
  // Computed on `unseen` — independent of budget cap (砚砚 review: don't mix budget and visibility semantics).
  const currentMessageFilteredOut = Boolean(
    currentUserMessageId &&
      !relevant.some((m) => m.id === currentUserMessageId) &&
      unseen.some((m) => m.id === currentUserMessageId),
  );

  // F148: Smart window — cold mention detection
  // P1-review: short-circuit on count first — avoid O(n) tokenize when count already triggers
  const hcConfig = DEFAULT_HIERARCHICAL_CONTEXT;
  const countTrigger = relevant.length > hcConfig.coldMentionThreshold;
  // Gap-1: only estimate tokens when count doesn't trigger (the "few but fat" path)
  const tokenTrigger =
    !countTrigger &&
    relevant.reduce((sum, m) => sum + estimateTokens(m.content), 0) > hcConfig.coldMentionTokenThreshold;
  const isColdMention = countTrigger || tokenTrigger;

  // F148 OQ-3 telemetry: warm/cold path decision
  log.info({
    f148: 'path-decision',
    threadId,
    catId,
    messageCount: relevant.length,
    isColdMention,
    trigger: countTrigger ? 'count' : tokenTrigger ? 'token' : 'none',
    thresholds: { count: hcConfig.coldMentionThreshold, token: hcConfig.coldMentionTokenThreshold },
  });

  if (isColdMention) {
    return assembleSmartWindowContext(
      deps,
      relevant,
      catId,
      threadId,
      currentUserMessageId,
      currentMessageFilteredOut,
      hcConfig,
      cursor,
      options,
    );
  }

  // --- Warm path: existing behavior unchanged ---

  // GAP-1: Unconditional budget cap — protects both first-time cats (cursor=undefined)
  // and stale cursor scenarios where large unseen batches accumulate.
  const budget = getCatContextBudget(catId as string);
  const wasCapped = relevant.length > budget.maxMessages;
  const capped = wasCapped ? relevant.slice(-budget.maxMessages) : relevant;

  // Metadata must be based on the FINAL capped set, not pre-cap `relevant`
  const includesCurrentUserMessage = Boolean(currentUserMessageId && capped.some((m) => m.id === currentUserMessageId));

  if (capped.length === 0) {
    return cursor
      ? { contextText: '', boundaryId: cursor, includesCurrentUserMessage, currentMessageFilteredOut }
      : { contextText: '', includesCurrentUserMessage, currentMessageFilteredOut };
  }

  const truncateLimit = budget.maxContentLengthPerMsg;
  const lines = capped.map((m) => {
    // F22: Digest rich blocks into compact summaries for context
    const contentWithDigest = digestRichBlocks(m);
    const cleanContent = sanitizeInjectedContent(contentWithDigest);
    const normalized: StoredMessage = cleanContent === m.content ? m : { ...m, content: cleanContent };
    const rendered = formatMessage(normalized, { truncate: truncateLimit });
    return `[${m.id}] ${rendered}`;
  });

  // 第二刀: Aggregate token budget — trim oldest lines until within effective token limit.
  // A+ fix: routing layer can pass effectiveMaxContextTokens (= maxPromptTokens minus system parts)
  // to prevent the assembled context + system prompt from exceeding the model's input limit.
  const effectiveTokenBudget = options?.effectiveMaxContextTokens ?? budget.maxContextTokens;

  // effectiveMaxContextTokens === 0 means system parts already exhausted the entire prompt budget.
  // Return empty context with degradation rather than skipping the trim (old behavior of `> 0` guard).
  if (effectiveTokenBudget <= 0) {
    const zeroBudgetDegradation = `⚠️ 增量上下文预算耗尽: 系统提示已占满 prompt 预算，${capped.length} 条未读消息全部丢弃`;
    const zeroBoundaryId = capped[capped.length - 1]?.id;
    return {
      contextText: '',
      boundaryId: zeroBoundaryId,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: zeroBudgetDegradation,
    };
  }

  let tokenTrimmed = false;
  let tokenTrimStart = 0;
  if (effectiveTokenBudget > 0) {
    const perLineTokens = lines.map((l) => estimateTokens(l));
    const totalTokens = perLineTokens.reduce((a, b) => a + b, 0);
    if (totalTokens > effectiveTokenBudget) {
      tokenTrimmed = true;
      // Scan from oldest: accumulate tokens to drop until remainder fits budget
      let dropTokens = 0;
      for (let i = 0; i < perLineTokens.length - 1; i++) {
        dropTokens += perLineTokens[i];
        if (totalTokens - dropTokens <= effectiveTokenBudget) {
          tokenTrimStart = i + 1;
          break;
        }
      }
      if (totalTokens - dropTokens > effectiveTokenBudget) {
        tokenTrimStart = perLineTokens.length - 1;
      }
    }
  }

  const finalLines = tokenTrimmed ? lines.slice(tokenTrimStart) : lines;
  const finalCapped = tokenTrimmed ? capped.slice(tokenTrimStart) : capped;

  // Recompute metadata on FINAL post-token-trim set
  const finalIncludesCurrentUserMessage = tokenTrimmed
    ? Boolean(currentUserMessageId && finalCapped.some((m) => m.id === currentUserMessageId))
    : includesCurrentUserMessage;

  if (finalCapped.length === 0) {
    return cursor
      ? { contextText: '', boundaryId: cursor, includesCurrentUserMessage: false, currentMessageFilteredOut }
      : { contextText: '', includesCurrentUserMessage: false, currentMessageFilteredOut };
  }

  let degradation: string | undefined;
  if (wasCapped && tokenTrimmed) {
    degradation = `⚠️ 增量上下文已截断: 未读消息 ${relevant.length} 条经 maxMessages(${budget.maxMessages}) 和 token 预算(${effectiveTokenBudget}) 双重截断，已保留最近 ${finalCapped.length} 条`;
  } else if (wasCapped) {
    degradation = `⚠️ 增量上下文已截断: 未读消息 ${relevant.length} 条超出预算 ${budget.maxMessages}，已保留最近 ${finalCapped.length} 条`;
  } else if (tokenTrimmed) {
    degradation = `⚠️ 增量上下文 token 预算截断: ${capped.length} 条消息超出 token 预算(${effectiveTokenBudget})，已保留最近 ${finalCapped.length} 条`;
  }

  const boundaryId = finalCapped[finalCapped.length - 1]?.id;
  return {
    contextText: `[对话历史增量 - 未发送过 ${finalCapped.length} 条]\n${finalLines.join('\n')}\n[/对话历史]`,
    boundaryId,
    includesCurrentUserMessage: finalIncludesCurrentUserMessage,
    currentMessageFilteredOut,
    degradation,
  };
}

/**
 * F148: Smart window path for cold-mention context assembly.
 * Burst detection → tombstone → evidence recall → tool scrub → compact context.
 */
async function assembleSmartWindowContext(
  deps: RouteStrategyDeps,
  relevant: StoredMessage[],
  catId: CatId,
  threadId: string,
  currentUserMessageId: string | undefined,
  currentMessageFilteredOut: boolean,
  hcConfig: import('../../../../../config/hierarchical-context-config.js').HierarchicalContextConfig,
  _cursor: string | undefined,
  options: IncrementalContextOptions | undefined,
): Promise<IncrementalContextResult> {
  const budget = getCatContextBudget(catId as string);
  const truncateLimit = budget.maxContentLengthPerMsg;

  // 1. Burst detection
  const { burst, omitted } = detectRecentBurst(relevant, hcConfig);

  // F148 OQ-1 telemetry: burst detection stats
  const actualGapMs =
    burst.length > 0 && omitted.length > 0 ? burst[0].timestamp - omitted[omitted.length - 1].timestamp : null;
  log.info({
    f148: 'burst-stats',
    threadId,
    catId,
    totalMessages: relevant.length,
    burstCount: burst.length,
    omittedCount: omitted.length,
    actualGapMs,
    configuredGapMs: hcConfig.burstSilenceGapMs,
  });

  // 2. Thread title for tombstone + evidence (fail-open like recallEvidence)
  const threadStore = deps.invocationDeps.threadStore;
  let threadTitle = '';
  if (threadStore) {
    try {
      threadTitle = (await Promise.resolve(threadStore.get(threadId)))?.title ?? '';
    } catch {
      // fail-open: threadTitle stays empty, tombstone/evidence degrade gracefully
    }
  }

  // 3. Sanitize omitted content once (before tombstone keyword extraction + anchor formatting)
  const sanitizedOmitted = omitted.map((m) => ({
    ...m,
    content: sanitizeInjectedContent(m.content),
  }));

  // 3.1 Tombstone (uses sanitized content for keyword extraction)
  const tombstone = buildTombstone(sanitizedOmitted, threadTitle, hcConfig, threadId);
  const tombstoneText = tombstone ? formatTombstone(tombstone) : '';

  // 3.5 Phase C: Anchor extraction from omitted messages
  const currentMsgText = currentUserMessageId
    ? (burst.find((m) => m.id === currentUserMessageId)?.content.slice(0, 200) ?? '')
    : '';
  const compositeQueryTerms = [threadTitle, currentMsgText]
    .concat(
      burst
        .filter((m) => m.catId === null && m.userId !== 'system')
        .slice(-2)
        .map((m) => m.content.slice(0, 200)),
    )
    .join(' ')
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= 3);
  const anchors = selectAnchors(sanitizedOmitted, compositeQueryTerms, hcConfig.maxAnchors);
  const anchorLines = formatAnchors(anchors, truncateLimit);

  // 3.7 Phase D: Fetch thread memory (fail-open)
  let threadMemorySummary = '';
  let threadMemoryMeta: {
    available: boolean;
    sessionsIncorporated: number;
    decisions?: string[];
    openQuestions?: string[];
  } | null = null;
  if (threadStore) {
    try {
      const mem = await Promise.resolve(threadStore.getThreadMemory(threadId));
      if (mem) {
        let summary = sanitizeInjectedContent(mem.summary);
        // Trim to maxThreadMemoryTokens by dropping oldest lines
        const lines = summary.split('\n');
        while (lines.length > 1 && estimateTokens(lines.join('\n')) > hcConfig.maxThreadMemoryTokens) {
          lines.shift();
        }
        summary = lines.join('\n');
        // Hard-cap: if remaining text still exceeds budget, binary-search truncate by tokens
        if (estimateTokens(summary) > hcConfig.maxThreadMemoryTokens) {
          let lo = 0;
          let hi = summary.length;
          while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (estimateTokens(summary.slice(0, mid)) <= hcConfig.maxThreadMemoryTokens) lo = mid;
            else hi = mid - 1;
          }
          summary = summary.slice(0, lo) + '…';
        }
        threadMemorySummary = summary;
        threadMemoryMeta = {
          available: true,
          sessionsIncorporated: mem.sessionsIncorporated,
          ...(Array.isArray(mem.decisions) && mem.decisions.length ? { decisions: mem.decisions } : {}),
          ...(Array.isArray(mem.openQuestions) && mem.openQuestions.length ? { openQuestions: mem.openQuestions } : {}),
        };
      }
    } catch {
      // fail-open: threadMemory stays empty
    }
  }

  // 3.8 Evidence recall (fail-open) — must run before coverage map so hints are populated
  const currentMsg = currentUserMessageId ? burst.find((m) => m.id === currentUserMessageId) : undefined;
  const nonSystemRecent = burst.filter((m) => m.catId === null && m.userId !== 'system').slice(-2);
  const evidenceLines = await recallEvidence(
    deps.evidenceStore,
    threadTitle,
    currentMsg?.content ?? '',
    nonSystemRecent,
    hcConfig,
  );

  // 3.9 Phase D: Build coverage map (AC-D2) — VG-1: only evidence recall titles (not tombstone search hints)
  const participants = [...new Set(omitted.map((m) => m.catId ?? m.userId).filter(Boolean))] as string[];
  const retrievalHints = evidenceLines.map((line) => {
    const match = line.match(/^\[Evidence:\s*(.+?)\]/);
    return match ? match[1] : line.slice(0, 80);
  });
  const coverageMap = buildCoverageMap({
    omitted: {
      count: omitted.length,
      from: omitted[0]?.timestamp ?? 0,
      to: omitted[omitted.length - 1]?.timestamp ?? 0,
      participants,
    },
    burst: {
      count: burst.length,
      from: burst[0]?.timestamp ?? 0,
      to: burst[burst.length - 1]?.timestamp ?? 0,
    },
    anchorIds: anchors.map((a) => a.message.id),
    threadMemory: threadMemoryMeta,
    retrievalHints,
    searchSuggestions: tombstone?.retrievalHints ?? [],
  });
  const coverageMapText = `[Context Coverage Map]\n${JSON.stringify(coverageMap)}`;
  const threadMemoryText = threadMemorySummary
    ? `[Thread Memory: ${threadMemoryMeta?.sessionsIncorporated ?? 0} sessions]\n${threadMemorySummary}`
    : '';

  // 5. Tool payload scrub on burst
  const scrubbedBurst = scrubToolPayloads(burst);

  // 6. Format burst messages
  const burstLines = scrubbedBurst.map((m) => {
    const contentWithDigest = digestRichBlocks(m);
    const cleanContent = sanitizeInjectedContent(contentWithDigest);
    const normalized: StoredMessage = cleanContent === m.content ? m : { ...m, content: cleanContent };
    const rendered = formatMessage(normalized, { truncate: truncateLimit });
    return `[${m.id}] ${rendered}`;
  });

  // 7. Respect effectiveMaxContextTokens (same as warm path)
  const effectiveTokenBudget = options?.effectiveMaxContextTokens ?? budget.maxContextTokens;
  const boundaryId = relevant[relevant.length - 1]?.id;

  if (effectiveTokenBudget <= 0) {
    return {
      contextText: '',
      boundaryId,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: `⚠️ 增量上下文预算耗尽: 系统提示已占满 prompt 预算`,
    };
  }

  // Token trim with graduated degradation:
  // evidence → coverageMap+threadMemory → anchors → tombstone → burst
  let finalBurstLines = burstLines;
  let finalBurstMsgs = scrubbedBurst;
  const finalEvidenceLines = [...evidenceLines];
  const finalAnchorLines = [...anchorLines];
  const anchorScores = anchors.map((a) => a.score);
  let finalTombstoneText = tombstoneText;
  let finalCoverageMapText = coverageMapText;
  let finalThreadMemoryText = threadMemoryText;
  let tokenDegradation: string | undefined;

  const totalTokens = () =>
    estimateTokens(
      [
        finalCoverageMapText,
        finalThreadMemoryText,
        finalTombstoneText,
        ...finalAnchorLines,
        ...finalEvidenceLines,
        ...finalBurstLines,
      ]
        .filter(Boolean)
        .join('\n'),
    );

  if (totalTokens() > effectiveTokenBudget) {
    // Stage 1: Drop evidence lines from oldest
    while (finalEvidenceLines.length > 0 && totalTokens() > effectiveTokenBudget) {
      finalEvidenceLines.shift();
    }

    // Stage 1.3: Drop coverage map + thread memory together
    if (totalTokens() > effectiveTokenBudget) {
      finalCoverageMapText = '';
      finalThreadMemoryText = '';
    }

    // Stage 1.5: Drop anchors by lowest score
    while (finalAnchorLines.length > 0 && totalTokens() > effectiveTokenBudget) {
      let minIdx = 0;
      for (let i = 1; i < anchorScores.length; i++) {
        if (anchorScores[i] < anchorScores[minIdx]) minIdx = i;
      }
      finalAnchorLines.splice(minIdx, 1);
      anchorScores.splice(minIdx, 1);
    }

    // Stage 2: Drop tombstone
    if (totalTokens() > effectiveTokenBudget && finalTombstoneText) {
      finalTombstoneText = '';
    }

    // Stage 3: Trim burst from oldest
    let keep = finalBurstLines.length;
    while (keep > 1 && totalTokens() > effectiveTokenBudget) {
      finalBurstLines = burstLines.slice(-keep + 1);
      finalBurstMsgs = scrubbedBurst.slice(-keep + 1);
      keep--;
    }

    // Stage 4: Hard cap — if envelope + 1 burst still exceeds budget, return empty
    if (totalTokens() > effectiveTokenBudget) {
      return {
        contextText: '',
        boundaryId,
        includesCurrentUserMessage: false,
        currentMessageFilteredOut,
        degradation: `⚠️ 增量上下文 token 预算截断: 预算不足以容纳最小上下文 (${effectiveTokenBudget} tokens)`,
      };
    }

    tokenDegradation = `⚠️ 增量上下文 token 预算截断: evidence ${evidenceLines.length} → ${finalEvidenceLines.length}, anchors ${anchorLines.length} → ${finalAnchorLines.length}, burst ${burstLines.length} → ${finalBurstLines.length}`;
  }

  // 8. Assemble context packet
  const sections: string[] = [];
  if (finalCoverageMapText) sections.push(finalCoverageMapText);
  if (finalThreadMemoryText) sections.push(finalThreadMemoryText);
  if (finalTombstoneText) sections.push(finalTombstoneText);
  if (finalAnchorLines.length > 0) sections.push(...finalAnchorLines);
  if (finalEvidenceLines.length > 0) {
    sections.push(`[Related evidence]\n${finalEvidenceLines.join('\n')}\n[/Related evidence]`);
  }
  sections.push(...finalBurstLines);

  const includesCurrentUserMessage = Boolean(
    currentUserMessageId && finalBurstMsgs.some((m) => m.id === currentUserMessageId),
  );

  const contextText =
    sections.length > 0
      ? `[对话历史增量 - 智能窗口: ${omitted.length} 条已摘要, ${finalBurstMsgs.length} 条详细]\n${sections.join('\n')}\n[/对话历史]`
      : '';

  // Final hard cap: envelope overhead may push total over budget
  if (contextText && estimateTokens(contextText) > effectiveTokenBudget) {
    return {
      contextText: '',
      boundaryId,
      includesCurrentUserMessage: false,
      currentMessageFilteredOut,
      degradation: `⚠️ 增量上下文 token 预算截断: 预算不足以容纳最小上下文 (${effectiveTokenBudget} tokens)`,
    };
  }

  return {
    contextText,
    boundaryId,
    includesCurrentUserMessage,
    currentMessageFilteredOut,
    degradation: tokenDegradation,
    coverageMap,
    briefingContext: {
      ...(threadMemorySummary ? { threadMemorySummary } : {}),
      ...(finalAnchorLines.length > 0 ? { anchorSummaries: finalAnchorLines } : {}),
    },
  };
}
