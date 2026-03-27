/**
 * Route Helpers
 * Shared types, interfaces, and helper functions for route-serial and route-parallel.
 */

import type { CatId, MessageContent, RichBlock, RichBlockBase } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import { formatMessage } from '../../context/ContextAssembler.js';
import { checkContextBudget, type DegradationResult } from '../../orchestration/DegradationPolicy.js';
import { DeliveryCursorStore } from '../../stores/ports/DeliveryCursorStore.js';
import type { IDraftStore } from '../../stores/ports/DraftStore.js';
import type { IMessageStore, StoredMessage, StoredToolEvent } from '../../stores/ports/MessageStore.js';
import { canViewMessage } from '../../stores/visibility.js';
import type { AgentMessage, AgentService } from '../../types.js';
import type { InvocationDeps } from '../invocation/invoke-single-cat.js';

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
    const detail = raw.length > 0 ? truncateDetail(raw, 220) : '(no output)';
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

export function sanitizeInjectedContent(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skippingHistoryEnvelope = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHistoryHeader = line.startsWith('[对话历史 - 最近 ') || line.startsWith('[对话历史增量 - 未发送过 ');

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

  return kept.join('\n').trim();
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
        // Even after dropping all but one message, the last message alone may exceed
        // maxContextTokens (e.g. a single huge message). We still keep it because
        // returning empty context is worse — the cat gets no context at all. The
        // degradation notice below will flag this situation so the cat knows the
        // context was force-trimmed.
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
