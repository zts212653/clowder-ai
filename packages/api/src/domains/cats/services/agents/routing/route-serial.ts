/**
 * Serial Route Strategy
 * Cats respond one by one, each seeing previous responses.
 *
 * A2A support: after each cat completes, its response is checked for @mentions.
 * If a mention is detected and depth allows, the mentioned cat is appended to the
 * worklist — extending the chain within the SAME function call. This preserves
 * previousResponses continuity and correct isFinal semantics (缅因猫 P1-1, P1-2).
 *
 * A2A only triggers here in routeSerial; routeParallel never chains (MVP safety boundary).
 */

import {
  type CatConfig,
  type CatId,
  catRegistry,
  createCatId,
  type RichBlock,
  resolveWorkflowSopSkill,
} from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { getConfigSessionStrategy, isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { getCatVoice } from '../../../../../config/cat-voices.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  AGENT_ID,
  type CallerTraceContext,
  ROUTE_HAS_A2A_HANDOFF,
  ROUTE_TOTAL_CATS_INVOKED,
  ROUTE_TOTAL_TOKENS,
  THREAD_SYSTEM_KIND,
  TRIGGER,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  a2aDispatchCount,
  c2ExitChecked,
  c2VerdictHintEmitted,
  c2VerdictWithoutPassCount,
  c2VoidHoldChecked,
  c2VoidHoldHintEmitted,
  inlineActionChecked,
  inlineActionDetected,
  inlineActionFeedbackWriteFailed,
  inlineActionFeedbackWritten,
  inlineActionHintEmitFailed,
  inlineActionHintEmitted,
  inlineActionRoutedSetSkip,
  inlineActionShadowMiss,
  lineStartDetected,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { detectUserMention } from '../../../../../routes/user-mention.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import type { IBallCustodyIngest } from '../../../../ball-custody/BallCustodyIngest.js';
import {
  buildHandedCvoEvent,
  buildHandedEvent,
  buildInvocationHeartbeatEvent,
  buildInvocationStartedEvent,
  buildVoidPassEvent,
} from '../../../../ball-custody/ball-custody-events.js';
import { conciergeContextForCat, prepareConciergeContext } from '../../../../concierge/ConciergeRoutingInterceptor.js';
import {
  buildConciergeActions,
  extractTriagePlanIdsFromActions,
  stripTriagePlanMarkers,
  type TriagePlanExtractionDeps,
} from '../../../../concierge/concierge-reply-validator.js';
import { buildConciergeSearchContext } from '../../../../concierge/concierge-search-context.js';
import {
  ackGuideCompletion,
  guideContextForCat,
  prepareGuideContext,
} from '../../../../guides/GuideRoutingInterceptor.js';
import { triggerRecallCorrelation } from '../../../../memory/recall-correlation-hook.js';
import { assembleContext } from '../../context/ContextAssembler.js';
import {
  buildInvocationContext,
  buildStaticIdentity,
  buildStaticIdentityPackOnly,
  type InvocationContext,
} from '../../context/SystemPromptBuilder.js';
import { formatDegradationMessage } from '../../orchestration/DegradationPolicy.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { buildSessionBootstrap } from '../../session/SessionBootstrap.js';
import {
  hydrateCrossThreadReplyHint,
  hydrateReplyPreview,
  type StoredToolEvent,
  type StreamMetadataAugmentInput,
} from '../../stores/ports/MessageStore.js';
import type { Thread, ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import { classifyTool } from '../../tool-usage/classify.js';
import { deriveResultSummary } from '../../tool-usage/derive-result-summary.js';
import { normalizeMcpToolName } from '../../tool-usage/normalize-mcp-tool-name.js';
import { getStreamingTtsRegistry, StreamingTtsChunker } from '../../tts/StreamingTtsChunker.js';
import { getVoiceBlockSynthesizer } from '../../tts/VoiceBlockSynthesizer.js';
import type { AgentMessage, AgentMessageType, MessageMetadata } from '../../types.js';
import { buildCapsuleFromRouteState } from '../invocation/CollaborationContinuityCapsule.js';
import { invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { buildMcpCallbackInstructions, needsMcpInjection } from '../invocation/McpPromptInjector.js';
import { getRichBlockBuffer } from '../invocation/RichBlockBuffer.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { detectInlineActionMentionsWithShadow, getMaxA2ADepth, parseA2AMentions } from '../routing/a2a-mentions.js';
import {
  isSubstantiveTool,
  peekStreakOnPush,
  registerWorklist,
  unregisterWorklist,
  updateStreakOnPush,
} from '../routing/WorklistRegistry.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import { formatA2AHandoffContent } from './a2a-handoff-label.js';
import { extractContextEvalSignals } from './context-eval.js';
import { validateRoutingSyntax } from './final-routing-slot.js';
import { buildBriefingMessage } from './format-briefing.js';
import { buildRemedialPrompt, hasValidRoutingExit, shouldRemediateRouting } from './guards/routing-guard-remedial.js';
import { extractRichFromText, isValidRichBlock } from './rich-block-extract.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';
import {
  assembleIncrementalContext,
  createLeakedToolCallStreamStripper,
  detectContextDegradation,
  getService,
  getThreadBootcampMemberCount,
  isUserFacingSystemInfoContent,
  routeContentBlocksForCat,
  sanitizeInjectedContent,
  shouldAppendExplicitCurrentMessage,
  toStoredToolEvent,
  upsertMaxBoundary,
} from './route-helpers.js';
import { resolveRoutingDecisions } from './routing-decision.js';
import { appendThinkingChunk, renderThinkingChunks } from './thinking-chunks.js';
import { detectMatchedVerdictKeyword, shouldWarnVerdictWithoutPass } from './verdict-detect.js';
import { evaluateVoidHold } from './void-hold-detect.js';
import { buildVoteTally, checkVoteCompletion, extractVoteFromText, VOTE_RESULT_SOURCE } from './vote-intercept.js';

const log = createModuleLogger('route-serial');
const BALL_CUSTODY_INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/**
 * F233 Phase B (B2): fire-and-forget 旁路写 ball.handed（行首 @ 路由投递 → holder 变更，球继续）。
 * 紧贴现有 A2A_HANDOFF 审计旁路点调用；失败仅 log、不阻塞路由；无 messageId 则 skip
 * （best-effort observability，漏写由后续动作 / 简报 rebuild 兜底）。
 */
function emitBallHanded(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  fromCatId: string,
  toCatId: string,
  messageId: string | undefined,
): void {
  if (!ballCustody || !messageId) return;
  ballCustody
    .record(buildHandedEvent({ fromCatId, toCatId, threadId, messageId, at: Date.now() }))
    .catch((err) => log.warn({ threadId, toCat: toCatId, err }, 'ball.handed ingest failed'));
}

/**
 * F233 Phase B (B2): fire-and-forget 旁路写 ball.void_pass（声明持球但无 hold_ball / 无行首 @ / 无 structured 路由）。
 * 紧贴 void-hold-hint sample emit 调用（此时 storedMsgId 已绑定）。
 */
function emitBallVoidPass(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  messageId: string | undefined,
  matchedPattern: string | null,
): void {
  if (!ballCustody || !messageId) return;
  ballCustody
    .record(buildVoidPassEvent({ threadId, messageId, matchedPattern: matchedPattern ?? undefined, at: Date.now() }))
    .catch((err) => log.warn({ threadId, err }, 'ball.void_pass ingest failed'));
}

function emitBallHandedCvo(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  fromCatId: string,
  messageId: string | undefined,
): void {
  if (!ballCustody || !messageId) return;
  ballCustody
    .record(buildHandedCvoEvent({ fromCatId, threadId, messageId, intent: 'handoff', at: Date.now() }))
    .catch((err) => log.warn({ threadId, fromCatId, err }, 'ball.handed_cvo ingest failed'));
}

function emitBallInvocationStarted(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  invocationId: string | undefined,
  catId: string,
): void {
  if (!ballCustody || !invocationId) return;
  ballCustody
    .record(buildInvocationStartedEvent({ invocationId, threadId, catId, at: Date.now() }))
    .catch((err) => log.warn({ threadId, invocationId, catId, err }, 'invocation.started ingest failed'));
}

function emitBallInvocationHeartbeat(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  invocationId: string | undefined,
  catId: string,
  draftUpdatedAt: number,
): void {
  if (!ballCustody || !invocationId) return;
  ballCustody
    .record(buildInvocationHeartbeatEvent({ invocationId, threadId, catId, draftUpdatedAt }))
    .catch((err) => log.warn({ threadId, invocationId, catId, err }, 'invocation.heartbeat ingest failed'));
}
const routeSerialTracer = trace.getTracer('cat-cafe-api', '0.1.0');
const ROUTE_ONLY_REMEDIAL_TEXT_RE =
  /^@[\p{L}\p{N}_.-]+(?:[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]+)?$/u;

function stripMarkdownRoutePrefix(line: string): string {
  return line.replace(/^(?:[-*+]\s+|>\s*|\d+[.)]\s+)/, '').trim();
}

function normalizeRouteOnlyRemedialText(text: string): string | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => stripMarkdownRoutePrefix(line))
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  return ROUTE_ONLY_REMEDIAL_TEXT_RE.test(lines[0]) ? lines[0] : null;
}

function collectStructuredTargetCatsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];

  const parsed = input as { targetCats?: unknown; targets?: unknown };
  const values = Array.isArray(parsed.targetCats)
    ? parsed.targetCats
    : Array.isArray(parsed.targets)
      ? parsed.targets
      : [];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function readToolInputContent(input: unknown): string | undefined {
  if (!input) return undefined;
  if (typeof input === 'object') {
    const content = (input as { content?: unknown }).content;
    return typeof content === 'string' && content.length > 0 ? content : undefined;
  }
  if (typeof input !== 'string') return undefined;

  try {
    const parsed = JSON.parse(input) as { content?: unknown };
    return typeof parsed.content === 'string' && parsed.content.length > 0 ? parsed.content : undefined;
  } catch {
    return undefined;
  }
}

function isPostMessageToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (toolName.endsWith('cat_cafe_post_message')) return true;
  return toolName === 'mcp:cat-cafe/post_message' || toolName === 'cat_cafe_post_message';
}

function isCrossPostMessageToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (toolName.endsWith('cat_cafe_cross_post_message')) return true;
  return toolName === 'mcp:cat-cafe/cross_post_message' || toolName === 'cat_cafe_cross_post_message';
}

function isCallbackContentRoutingToolName(toolName: string | undefined): boolean {
  return isPostMessageToolName(toolName) || isCrossPostMessageToolName(toolName);
}

export type CallbackContentRoutingState = {
  scope: 'local' | 'target';
  guardLineStartMentions: CatId[];
  localLineStartMentions: CatId[];
  hasGuardCoCreatorLineStartMention: boolean;
  hasLocalCoCreatorLineStartMention: boolean;
  hasTargetCoCreatorLineStartMention: boolean;
};

type CallbackContentRoutingExit = CallbackContentRoutingState & {
  toolName: string;
  toolUseId?: string;
};

export function classifyCallbackContentRoutingState(
  toolName: string | undefined,
  content: string | undefined,
  currentCatId: CatId,
): CallbackContentRoutingState | null {
  if (!isCallbackContentRoutingToolName(toolName)) return null;
  const scope = isCrossPostMessageToolName(toolName) ? 'target' : 'local';
  if (!content) {
    return {
      scope,
      guardLineStartMentions: [],
      localLineStartMentions: [],
      hasGuardCoCreatorLineStartMention: false,
      hasLocalCoCreatorLineStartMention: false,
      hasTargetCoCreatorLineStartMention: false,
    };
  }

  // Cross-post content belongs to the target thread. It can satisfy the current turn's guard,
  // but it must not become current-thread A2A routing state.
  const parserCurrentCatId = scope === 'target' ? undefined : currentCatId;
  const guardLineStartMentions = parseA2AMentions(content, parserCurrentCatId);
  const hasCoCreatorLineStartMention = detectUserMention(content);
  return {
    scope,
    guardLineStartMentions,
    localLineStartMentions: scope === 'local' ? guardLineStartMentions : [],
    hasGuardCoCreatorLineStartMention: hasCoCreatorLineStartMention,
    hasLocalCoCreatorLineStartMention: scope === 'local' && hasCoCreatorLineStartMention,
    hasTargetCoCreatorLineStartMention: scope === 'target' && hasCoCreatorLineStartMention,
  };
}

function collectCallbackContentRoutingExit(
  toolName: string,
  toolInput: unknown,
  currentCatId: CatId,
  toolUseId?: string,
): CallbackContentRoutingExit | null {
  const content = readToolInputContent(toolInput);
  const state = classifyCallbackContentRoutingState(toolName, content, currentCatId);
  if (!state) return null;
  return { toolName, ...(toolUseId ? { toolUseId } : {}), ...state };
}

type CallbackPostResult = {
  confirmed: boolean;
  messageId?: string;
  threadId?: string;
};

function collectCallbackPostResultCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const trimmed = content.trim();
  if (trimmed) candidates.add(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) candidates.add(candidate);
  }
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart > 0) candidates.add(trimmed.slice(jsonStart));
  return [...candidates];
}

function callbackPostResultFromPayload(parsed: {
  status?: unknown;
  messageId?: unknown;
  threadId?: unknown;
}): CallbackPostResult | null {
  const confirmed = parsed.status === 'ok' || parsed.status === 'duplicate';
  if (!confirmed && parsed.status === undefined) return null;
  return {
    confirmed,
    ...(typeof parsed.messageId === 'string' && parsed.messageId.length > 0 ? { messageId: parsed.messageId } : {}),
    ...(typeof parsed.threadId === 'string' && parsed.threadId.length > 0 ? { threadId: parsed.threadId } : {}),
  };
}

function parseCallbackPostResult(content: string | undefined): {
  confirmed: boolean;
  messageId?: string;
  threadId?: string;
} {
  if (!content) return { confirmed: false };
  for (const candidate of collectCallbackPostResultCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as { status?: unknown; messageId?: unknown; threadId?: unknown };
      const result = callbackPostResultFromPayload(parsed);
      if (result) return result;
    } catch {
      // Try the next candidate shape.
    }
  }

  return {
    confirmed: /"status"\s*:\s*"(ok|duplicate)"/.test(content),
  };
}

function inferToolResultName(msg: AgentMessage): string | undefined {
  if (msg.toolName) return msg.toolName;
  const firstLine = msg.content?.trimStart().split('\n', 1)[0]?.trim();
  if (!firstLine) return undefined;
  const mcpLabel = firstLine.match(/^(mcp:[^\s]+)\s+\(/);
  if (mcpLabel?.[1]) return mcpLabel[1];
  if (firstLine.startsWith('command: ')) return 'command_execution';
  return undefined;
}

function toolNamesMatch(a: string, b: string): boolean {
  return (
    a === b ||
    (isPostMessageToolName(a) && isPostMessageToolName(b)) ||
    (isCrossPostMessageToolName(a) && isCrossPostMessageToolName(b))
  );
}

type PendingToolResult = {
  toolName: string;
  toolUseId?: string;
};

function consumePendingToolResult(
  pendingToolResults: PendingToolResult[],
  msg: AgentMessage,
  hasConfirmingContent: boolean,
  hasCallbackPostEvidence: boolean,
): PendingToolResult | undefined {
  if (msg.toolUseId) {
    const pendingIndex = pendingToolResults.findIndex((entry) => entry.toolUseId === msg.toolUseId);
    if (pendingIndex === -1) return undefined;
    return pendingToolResults.splice(pendingIndex, 1)[0];
  }

  const resultToolName = inferToolResultName(msg);
  if (resultToolName) {
    const pendingIndex = pendingToolResults.findIndex((entry) => toolNamesMatch(entry.toolName, resultToolName));
    if (pendingIndex === -1) return undefined;
    return pendingToolResults.splice(pendingIndex, 1)[0];
  }

  const firstPending = pendingToolResults[0];
  if (!firstPending) return undefined;

  if (!isPostMessageToolName(firstPending.toolName)) {
    return pendingToolResults.shift();
  }

  if (hasConfirmingContent && hasCallbackPostEvidence) {
    return pendingToolResults.shift();
  }

  if (hasConfirmingContent && pendingToolResults.length === 1) {
    return pendingToolResults.shift();
  }

  return undefined;
}

function hasStreamMetadataPatch(patch: StreamMetadataAugmentInput): boolean {
  return Boolean(
    patch.thinking || patch.metadata || patch.toolEvents?.length || patch.replyTo || patch.mentionsUser || patch.extra,
  );
}

export async function* routeSerial(
  deps: RouteStrategyDeps,
  targetCats: CatId[],
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions = {},
): AsyncIterable<AgentMessage> {
  const {
    contentBlocks,
    uploadDir,
    signal,
    signalForCat,
    promptTags,
    contextHistory,
    history,
    currentUserMessageId,
    a2aTriggerMessageId,
    modeSystemPrompt,
    modeSystemPromptByCat,
    queueHasQueuedMessages,
    hasQueuedOrActiveAgentForCat,
    deferA2AEnqueue,
  } = options;
  const previousResponses: { catId: CatId; content: string }[] = [];
  const thinkingMode = options.thinkingMode ?? 'play';
  // P2-3 fix: also consider default MCP server path (ClaudeAgentService has fallback resolution)
  const mcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
  const incrementalMode = Boolean(currentUserMessageId && deps.deliveryCursorStore);

  // Worklist pattern: starts with targetCats, may grow via A2A mentions
  // F27: Register worklist so callback A2A can push targets here
  // F108: Key by parentInvocationId for concurrent isolation
  const worklist = [...targetCats];
  const maxDepth = options.maxA2ADepth ?? getMaxA2ADepth();
  const worklistEntry = registerWorklist(threadId, worklist, maxDepth, options.parentInvocationId);

  let index = 0;
  // done-guarantee: Track whether we yielded a done(isFinal=true) so the finally block can
  // synthesize one if the loop exits early (e.g. signal.aborted break at top of while).
  let yieldedFinalDone = false;
  // F27: Track how many worklist entries have had a2a_handoff emitted
  let handoffEmitted = targetCats.length; // Original targets don't get handoff events
  const activeTrackedA2ASlots = new Set<CatId>();
  // F042 Wave 3: Fetch thread participant activity once before loop (threadId doesn't change).
  let activeParticipants: { catId: CatId; lastMessageAt: number; messageCount: number }[] = [];
  if (deps.invocationDeps.threadStore) {
    try {
      activeParticipants = await deps.invocationDeps.threadStore.getParticipantsWithActivity(threadId);
    } catch {
      /* best-effort: activity fetch failure does not block invocation */
    }
  }
  // F042: Fetch thread routingPolicy once before loop (threadId doesn't change).
  let routingPolicy: ThreadRoutingPolicyV1 | undefined;
  // F073 P4: SOP stage hint from workflow-sop (告示牌 — info only, cats decide actions)
  let sopStageHint:
    | { stage: string; suggestedSkill: string; suggestedSkillSource: string; featureId: string }
    | undefined;
  // F092: Voice companion mode
  let voiceMode: boolean | undefined;
  // F087: Bootcamp state for operator onboarding
  let bootcampState: InvocationContext['bootcampState'];
  const targetCatIds = new Set<string>(targetCats);
  // Thread read: shared across routingPolicy, voiceMode, bootcamp, SOP, and guide interceptor
  let routeThread: Thread | null = null;
  if (deps.invocationDeps.threadStore) {
    try {
      routeThread = (await deps.invocationDeps.threadStore.get(threadId)) ?? null;
      routingPolicy = routeThread?.routingPolicy;
      voiceMode = routeThread?.voiceMode;
      bootcampState = routeThread?.bootcampState;
      // F073 P4: Read workflow-sop if thread is linked to a backlog item
      if (routeThread?.backlogItemId && deps.invocationDeps.workflowSopStore) {
        try {
          const sop = await deps.invocationDeps.workflowSopStore.get(routeThread.backlogItemId);
          if (sop) {
            const skill = resolveWorkflowSopSkill(sop);
            sopStageHint = {
              stage: sop.stage,
              suggestedSkill: skill.skill,
              suggestedSkillSource: skill.source,
              featureId: sop.featureId,
            };
          }
        } catch {
          /* best-effort: SOP hint failure does not block invocation */
        }
      }
    } catch {
      /* best-effort */
    }
  }
  const bootcampMemberCount = getThreadBootcampMemberCount(routeThread);

  // F153: Trace propagation — track per-invocation spans and route-level token totals
  const catInvocationSpans = new Map<number, Span>();
  const mentionParentSpan = new Map<number, Span>();
  const pendingDispatchSpans: { span: Span; lastChildIndex: number }[] = [];
  let routeTotalTokens = 0;

  // F155: Guide interceptor — resume existing guide state only
  const guideCtx = await prepareGuideContext({
    thread: routeThread,
    guideSessionStore: deps.invocationDeps.guideSessionStore,
    targetCats,
    message,
    userId,
    threadId,
    log,
    dismissTracker: deps.invocationDeps.dismissTracker,
  });

  // F229: Concierge interceptor — load duty-cat 岗位 context for concierge threads
  const conciergeCtx = await prepareConciergeContext(routeThread, userId, deps.invocationDeps.conciergeConfigStore);

  // F229 KD-17: Pre-fetch search context for concierge threads → HandleMap + prompt context
  let conciergeSearchContextString = '';
  if ('conciergeConfig' in conciergeCtx && deps.invocationDeps.conciergeHandleMapStore) {
    try {
      const searchResult = await buildConciergeSearchContext({
        userMessage: message,
        threadId,
        handleMapStore: deps.invocationDeps.conciergeHandleMapStore,
        evidenceStore: deps.evidenceStore,
      });
      conciergeSearchContextString = searchResult.contextString;
    } catch {
      // Fail-open: search context failure → no context injection, no crash
    }
  }

  const completedCatInvocationIds: Array<[string, string]> = [];

  try {
    while (index < worklist.length) {
      const catId = worklist[index]!;
      let routingGuardAttempted = false;
      let routingGuardRemediated = false;
      // F-parallel-cancel: per-cat signal — canceling one cat skips ONLY that cat, not the
      // whole worklist. force-reset/cancelAll aborts every cat's controller, so all entries
      // skip = equivalent to stopping. Using the shared primaryController.signal made
      // "cancel the first cat" break the entire worklist (并发取消误伤根因：serial 路径).
      const catSignal = signalForCat?.(catId) ?? signal;
      if (catSignal?.aborted) {
        index++;
        continue;
      }
      // F148 OQ-2: briefing→invocation link + context eval
      let briefingMessageId: string | undefined;
      let briefingCoverageMap: import('./context-transport.js').CoverageMap | undefined;

      // Only pass images/uploads for the first cat (user's original target)
      const isOriginalTarget = index < targetCats.length;
      const targetContentBlocks = isOriginalTarget ? routeContentBlocksForCat(catId, contentBlocks) : undefined;
      const targetUploadDir = targetContentBlocks ? uploadDir : undefined;

      let prompt = message;
      if (!incrementalMode && previousResponses.length > 0) {
        const contextParts = previousResponses.map((r) => `[${r.catId} responded: ${r.content}]`);
        prompt = `${message}\n\n${contextParts.join('\n')}`;
      }

      // F229 KD-17: Inject search context into duty cat prompt
      if (conciergeSearchContextString && conciergeContextForCat(conciergeCtx, catId as string)?.conciergeConfig) {
        prompt = `${prompt}\n${conciergeSearchContextString}`;
      }

      // Build identity: static goes in -p content (+ systemPrompt as defense-in-depth), dynamic in -p only
      const catConfig: CatConfig | undefined = catRegistry.tryGet(catId as string)?.config;
      const teammates = [...new Set(worklist.filter((id) => id !== catId))];
      const directMessageFrom = worklistEntry.a2aFrom.get(catId);
      // F167 L1: ping-pong warning — inject when this cat just received the ball
      // in a same-pair streak >= 2 (streak=4 already blocked upstream, so max is 3 here).
      const pingPongWarning =
        worklistEntry.streakPair && worklistEntry.streakPair.to === catId && worklistEntry.streakPair.count >= 2
          ? {
              pairedWith: worklistEntry.streakPair.from,
              count: worklistEntry.streakPair.count,
            }
          : undefined;
      const queueTriggerReplyTo = isOriginalTarget ? a2aTriggerMessageId : undefined;
      const streamReplyTo = worklistEntry.a2aTriggerMessageId.get(catId) ?? queueTriggerReplyTo;
      const streamReplyPreview = streamReplyTo
        ? await hydrateReplyPreview(deps.messageStore, streamReplyTo)
        : undefined;
      // F193 AC-B2: structured cross-thread reply hint hydrated from trigger message.
      // Closes Codex review P1 (砚砚 2026-05-08): worklist `a2aTriggerMessageId` map
      // only has entries for downstream A2A targets — initial target via the modern
      // InvocationQueue path doesn't register in the map. Queue path's trigger id
      // arrives via `routeOptions.currentUserMessageId` (QueueProcessor → routeExecution).
      // Fallback chain ensures queue path also gets the hint without changing
      // streamReplyTo/auto-replyTo behavior (those have different semantics).
      // Same-thread triggers / agent-key path naturally return null inside the helper.
      const crossThreadReplyHintTriggerId = worklistEntry.a2aTriggerMessageId.get(catId) ?? currentUserMessageId;
      const crossThreadReplyHintRaw = crossThreadReplyHintTriggerId
        ? await hydrateCrossThreadReplyHint(deps.messageStore, crossThreadReplyHintTriggerId)
        : null;
      const crossThreadReplyHint = crossThreadReplyHintRaw
        ? {
            sourceThreadId: crossThreadReplyHintRaw.sourceThreadId,
            senderCatId: createCatId(crossThreadReplyHintRaw.senderCatId),
            // F246 Phase B: carry effectClass to SystemPromptBuilder for behavior constraints
            ...(crossThreadReplyHintRaw.effectClass ? { effectClass: crossThreadReplyHintRaw.effectClass } : {}),
          }
        : undefined;
      let mentionRoutingFeedback = null;
      if (deps.invocationDeps.threadStore) {
        try {
          mentionRoutingFeedback = await deps.invocationDeps.threadStore.consumeMentionRoutingFeedback(threadId, catId);
        } catch (feedbackErr) {
          log.warn({ catId: catId as string, err: feedbackErr }, 'consumeMentionRoutingFeedback failed');
        }
      }
      // mcpAvailable still gates the per-message HTTP callback fallback below
      // (needsMcpInjection). F203 Phase C: the non-pack identity/家规/MCP docs
      // travel via the compression-immune native system role
      // (--system-prompt-file / -c) ONLY for providers that inject L0 natively
      // (ClaudeAgentService -p, ClaudeBgCarrierService, CodexAgent). Other
      // providers (Gemini, Antigravity, CatAgent, A2A, OpenCode, Dare, Kimi…)
      // have no native L0 channel, so they MUST still receive the full static
      // identity via the user-message systemPrompt prepend — otherwise they
      // lose identity/家规 entirely (云端 Codex P1-cloud-1, 2026-05-16).
      const mcpAvailable = (catConfig?.mcpSupport ?? false) && !!mcpServerPath;
      // F129: Load active pack blocks (best-effort, failure does not block invocation)
      let packBlocks: import('@cat-cafe/shared').CompiledPackBlocks | null = null;
      if (deps.packStore) {
        const { getActivePackBlocks } = await import('../../../../packs/getActivePackBlocks.js');
        packBlocks = await getActivePackBlocks(deps.packStore);
      }
      const service = getService(deps.services, catId);
      const needsServerRoutingGuard = service.needsServerRoutingGuard?.() ?? false;
      const hasNativeL0 = service.injectsL0Natively?.() ?? false;
      const staticIdentity = hasNativeL0
        ? buildStaticIdentityPackOnly(catId, { packBlocks })
        : buildStaticIdentity(catId, { mcpAvailable, packBlocks });
      // L0-budget-defense PR-B-impl (ADR-038 件套 ④): staging is NOT prepended
      // to staticIdentity here. Cloud R2 P1 #2237 L1099: folding staging into
      // staticIdentity breaks ADR-038 "每轮注入生效" contract on resumed
      // session-chain turns, because invoke-single-cat skips systemPrompt
      // injection on those resumes. Staging is now injected in invoke-single-cat
      // independently (mirrors F225 contextHintPrefix pattern).
      // F041: inject HTTP callback only when MCP is NOT actually available (fallback)
      const mcpInstructions = needsMcpInjection(mcpAvailable, catConfig?.clientId)
        ? buildMcpCallbackInstructions({
            currentCatId: catId as string,
            teammates: teammates.map((id) => id as string),
          })
        : '';
      // F091: Inject linked signal articles into context
      let activeSignals:
        | readonly {
            id: string;
            title: string;
            source: string;
            tier: number;
            contentSnippet: string;
            note?: string | undefined;
            relatedDiscussions?: readonly { sessionId: string; snippet: string; score: number }[] | undefined;
          }[]
        | undefined;
      if (deps.invocationDeps.signalArticleLookup) {
        try {
          const signals = await deps.invocationDeps.signalArticleLookup(threadId);
          if (signals.length > 0) activeSignals = signals;
        } catch {
          /* best-effort: signal lookup failure does not block invocation */
        }
      }

      // F163 AC-A3: always_on constitutional docs injection (fail-open, flag-gated)
      // shadow: query but do NOT inject into prompt (record-only for experiment diff)
      // on: query AND inject into prompt
      // off: skip entirely
      let alwaysOnDocs: readonly { anchor: string; title: string; summary: string }[] | undefined;
      let alwaysOnInjectionMode: 'off' | 'shadow' | 'on' = 'off';
      if (deps.evidenceStore) {
        try {
          const { freezeFlags } = await import('../../../../../domains/memory/f163-types.js');
          const f163Flags = freezeFlags();
          alwaysOnInjectionMode = f163Flags.alwaysOnInjection;
          if (alwaysOnInjectionMode !== 'off') {
            const evStore = deps.evidenceStore as {
              queryAlwaysOn?: () => Array<{ anchor: string; title: string; summary: string }>;
            };
            if (typeof evStore.queryAlwaysOn === 'function') {
              const docs = evStore.queryAlwaysOn();
              if (docs.length > 0) alwaysOnDocs = docs;
            }
          }
        } catch {
          /* fail-open: always_on lookup failure does not block invocation */
        }
      }

      // F093: Resolve world context for thread (fail-open)
      let worldContext: import('@cat-cafe/shared').WorldContextEnvelope | undefined;
      if (deps.worldStore && deps.worldContextProvider) {
        try {
          const activeWorld = await deps.worldStore.getWorldForThread(threadId);
          if (activeWorld) {
            const scenes = await deps.worldStore.getScenesByWorld(activeWorld.worldId);
            const activeScene = scenes.find((s) => s.status === 'active');
            if (activeScene) {
              const envelope = await deps.worldContextProvider.assemble(activeWorld.worldId, activeScene.sceneId);
              if (envelope) worldContext = envelope;
            }
          }
        } catch {
          /* fail-open: world context lookup failure does not block invocation */
        }
      }

      const invocationMode = worklist.length > 1 ? 'serial' : 'independent';
      const a2aEnabled = worklistEntry.a2aCount < maxDepth;
      const invocationContext = buildInvocationContext({
        catId,
        mode: invocationMode,
        chainIndex: index + 1,
        chainTotal: worklist.length,
        teammates,
        mcpAvailable,
        ...(promptTags && promptTags.length > 0 ? { promptTags } : {}),
        a2aEnabled,
        ...(directMessageFrom ? { directMessageFrom } : {}),
        ...(pingPongWarning ? { pingPongWarning } : {}),
        ...(crossThreadReplyHint ? { crossThreadReplyHint } : {}),
        ...(mentionRoutingFeedback ? { mentionRoutingFeedback } : {}),
        ...(activeParticipants.length > 0 ? { activeParticipants } : {}),
        ...(routingPolicy ? { routingPolicy } : {}),
        ...(sopStageHint ? { sopStageHint } : {}),
        ...(activeSignals ? { activeSignals } : {}),
        ...(voiceMode ? { voiceMode } : {}),
        ...(bootcampState ? { bootcampState, threadId, bootcampMemberCount } : {}),
        ...(alwaysOnDocs && alwaysOnInjectionMode === 'on' ? { alwaysOnDocs } : {}),
        ...guideContextForCat(guideCtx, catId, targetCatIds, threadId),
        ...(worldContext ? { worldContext } : {}),
        ...conciergeContextForCat(conciergeCtx, catId as string),
      });
      const continuityCapsule = buildCapsuleFromRouteState({
        threadId,
        catId: catId as string,
        ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
        mode: invocationMode,
        chainIndex: index + 1,
        chainTotal: worklist.length,
        ...(directMessageFrom ? { directMessageFrom: directMessageFrom as string } : {}),
        ...(streamReplyTo ? { a2aTriggerMessageId: streamReplyTo } : {}),
        a2aEnabled,
        a2aDepth: worklistEntry.a2aCount,
        maxA2ADepth: maxDepth,
      });

      // F24 Phase E: Bootstrap context for Session #2+
      // #836: Reborn cats skip bootstrap — every invocation starts with zero prior context.
      // Uses store lookup (not thread field) — Redis memberSS:* fields aren't hydrated by get().
      let bootstrapContext = '';
      // #836: Reborn check is best-effort — transient Redis failure must not
      // abort the invocation before bootstrap/routing. Default to non-reborn.
      let isSerialReborn = false;
      try {
        isSerialReborn = deps.invocationDeps.threadStore?.isRebornSession
          ? await Promise.resolve(deps.invocationDeps.threadStore.isRebornSession(threadId, catId as string))
          : false;
      } catch (rebornErr) {
        log.warn(
          { threadId, catId },
          '[routeSerial] #836: isRebornSession lookup failed pre-bootstrap, defaulting to non-reborn',
        );
      }
      if (
        !isSerialReborn &&
        isSessionChainEnabled(catId) &&
        deps.invocationDeps.sessionChainStore &&
        deps.invocationDeps.transcriptReader
      ) {
        try {
          const bootstrapDepth = getConfigSessionStrategy(catId)?.handoff?.bootstrapDepth;
          const bootstrap = await buildSessionBootstrap(
            {
              sessionChainStore: deps.invocationDeps.sessionChainStore,
              transcriptReader: deps.invocationDeps.transcriptReader,
              ...(deps.invocationDeps.taskStore ? { taskStore: deps.invocationDeps.taskStore } : {}),
              ...(deps.invocationDeps.threadStore ? { threadStore: deps.invocationDeps.threadStore } : {}),
              ...(bootstrapDepth ? { bootstrapDepth } : {}),
            },
            catId,
            threadId,
          );
          if (bootstrap) {
            bootstrapContext = bootstrap.text;
          }
        } catch {
          // Best-effort: bootstrap failure doesn't block invocation
        }
      }

      let deliveryBoundaryId: string | undefined;
      if (incrementalMode) {
        // Serial incremental mode depends on AgentRouter having appended current user message first.
        // We still explicitly include `message` when that message is not present in unseen rows.

        // A+ fix: calculate effective context budget by deducting ALL system parts from maxPromptTokens.
        // Without this, context (up to maxContextTokens=160k) + system parts (~15-20k) can exceed maxPromptTokens.
        const catModePromptForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const incBudget = getCatContextBudget(catId as string);
        const incSystemTokens = estimateTokens(
          [staticIdentity, invocationContext, catModePromptForBudget, bootstrapContext, mcpInstructions]
            .filter(Boolean)
            .join('\n'),
        );
        const incMessageTokens = estimateTokens(message);
        const effectiveContextBudget = Math.min(
          Math.max(0, incBudget.maxPromptTokens - incSystemTokens - incMessageTokens - 200),
          incBudget.maxContextTokens,
        );

        const inc = await assembleIncrementalContext(
          deps,
          userId,
          threadId,
          catId,
          currentUserMessageId,
          thinkingMode,
          {
            effectiveMaxContextTokens: effectiveContextBudget,
            canonicalFeatureId: sopStageHint?.featureId,
            threadTitle: routeThread?.title ?? undefined,
          },
        );
        deliveryBoundaryId = inc.boundaryId;
        if (inc.degradation) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: inc.degradation,
            timestamp: Date.now(),
          } as AgentMessage;
        }

        // F148 Phase E: Auto-insert context briefing when smart window triggered (AC-E1)
        if (inc.coverageMap) {
          const briefingInput = buildBriefingMessage(inc.coverageMap, threadId, inc.briefingContext);
          try {
            const stored = await deps.messageStore.append(briefingInput);
            briefingMessageId = stored.id;
            briefingCoverageMap = inc.coverageMap;
            // P1-3: Include full stored message in payload so frontend can addMessage directly
            yield {
              type: 'system_info' as AgentMessageType,
              catId,
              content: JSON.stringify({
                type: 'context_briefing',
                messageId: stored.id,
                storedMessage: {
                  id: stored.id,
                  content: stored.content,
                  origin: stored.origin,
                  timestamp: stored.timestamp,
                  extra: stored.extra,
                },
              }),
              timestamp: stored.timestamp,
            } as AgentMessage;
          } catch {
            // fail-open: briefing is non-critical UI enhancement
          }
        }

        /* @segment R1 — Mode System Prompt */
        /* @segment R2 — Mode System Prompt (per-cat) */
        const catModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const parts = [invocationContext, catModePrompt, bootstrapContext, mcpInstructions].filter(Boolean);
        if (inc.contextText) parts.push(inc.contextText);
        // F35 fix: only inject raw message when it was genuinely absent from unseen rows.
        // Defensive guard: if the current message ID is already present anywhere in
        // the assembled context text, do not append the raw message again.
        if (shouldAppendExplicitCurrentMessage(inc, currentUserMessageId)) parts.push(message);
        prompt = parts.join('\n\n---\n\n');
      } else {
        // Per-cat context budget (Phase 4.0): assemble context with cat-specific limits
        let catContextHistory = contextHistory; // fallback to legacy pre-assembled
        if (history && history.length > 0 && !contextHistory) {
          const budget = getCatContextBudget(catId as string);
          // F8: token-based budget — estimate non-context tokens, remainder goes to context
          // A+ fix: include catModePrompt + bootstrapContext in system parts estimate (P2-1)
          const catModePromptLegacyForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
          const systemPartsTokens = estimateTokens(
            [staticIdentity, invocationContext, catModePromptLegacyForBudget, bootstrapContext, mcpInstructions]
              .filter(Boolean)
              .join('\n'),
          );
          const promptTokens = estimateTokens(prompt);
          const budgetForContext = Math.max(0, budget.maxPromptTokens - systemPartsTokens - promptTokens - 200);
          const { contextText, messageCount } = assembleContext(history, {
            maxMessages: budget.maxMessages,
            maxContentLength: budget.maxContentLengthPerMsg,
            maxTotalTokens: Math.min(budgetForContext, budget.maxContextTokens),
          });
          catContextHistory = contextText || undefined;

          // Degradation check: notify user if context was truncated (count budget or char budget)
          const degradation = detectContextDegradation(history.length, messageCount, budget);
          if (degradation?.degraded) {
            yield {
              type: 'system_info' as AgentMessageType,
              catId,
              content: formatDegradationMessage(degradation),
              timestamp: Date.now(),
            } as AgentMessage;
          }
        }

        const catModePromptLegacy = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        if (invocationContext || catModePromptLegacy || mcpInstructions || bootstrapContext) {
          const parts = [invocationContext, catModePromptLegacy, bootstrapContext, mcpInstructions].filter(Boolean);
          if (catContextHistory) parts.push(catContextHistory);
          prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
        } else if (catContextHistory) {
          prompt = `${catContextHistory}\n\n---\n\n${prompt}`;
        }
      }

      let textContent = '';
      const thinkingChunks: string[] = [];
      let firstMetadata: MessageMetadata | undefined;
      let doneMsg: AgentMessage | undefined;
      let hadError = false;
      /** F155: tracks whether cat produced user-visible output (for guide completion ack). */
      let catProducedOutput = false;
      let sawUserFacingSystemInfo = false;
      // #267: track errors that happened BEFORE abort — only these are real provider failures
      let hadProviderError = false;
      // Collect error text separately for system-message persistence (F5 reload)
      let collectedErrorText = '';
      // F212 Phase B (云端 codex P2-8 2026-05-27): persist Phase A's structured
      // cliDiagnostics alongside the error text so cold hydration (F5 reload) can
      // restore the folded panel — without this, only the legacy red-pill survives.
      let collectedCliDiagnostics: import('@cat-cafe/shared').CliDiagnostics | undefined;
      const collectedToolEvents: StoredToolEvent[] = [];
      // F148 OQ-2: Collect tool names for context eval signals
      const collectedToolNames: string[] = [];
      // #573: Track confirmed cat_cafe_post_message callback persistence
      let callbackPostConfirmed = false;
      let callbackPostMessageId: string | undefined;
      let awaitingCallbackResult = false;
      const pendingToolResults: PendingToolResult[] = [];
      const pendingCallbackRoutingExits: CallbackContentRoutingExit[] = [];
      const confirmedCallbackRoutingGuardMentions = new Set<CatId>();
      const confirmedLocalCallbackRoutingMentions = new Set<CatId>();
      let confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = false;
      let confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = false;
      const emittedBallHandedCvoMessageIds = new Set<string>();
      const structuredTargetCats = new Set<string>();
      // F060: Collect rich blocks emitted inline via system_info (not MCP buffer)
      const streamRichBlocks: import('@cat-cafe/shared').RichBlock[] = [];
      // F22 R2 P1-1: Capture own invocationId from stream (not getLatestId)
      let ownInvocationId: string | undefined;
      // F111 Phase B: Streaming TTS chunker for real-time voice (voiceMode only)
      let voiceChunker: StreamingTtsChunker | undefined;
      let deferredVoiceInvocationId: string | undefined;
      const deferredVoiceTextChunks: string[] = [];

      // #80: Draft flush state — periodic persistence for F5 recovery
      let lastFlushTime = Date.now();
      let lastFlushLen = 0;
      let lastFlushToolLen = 0;
      const FLUSH_INTERVAL_MS = 2000;
      const FLUSH_CHAR_DELTA = 2000;
      const noop = () => {};

      // Issue #83: Independent keepalive timer — touch draft every 60s during long tool calls.
      // Stream events alone can't keep draft alive when tools execute silently for >300s.
      const KEEPALIVE_INTERVAL_MS = 60_000;
      let lastBallCustodyHeartbeatAt: number | null = null;
      let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
      const emitThrottledBallInvocationHeartbeat = (draftUpdatedAt: number): void => {
        if (
          lastBallCustodyHeartbeatAt !== null &&
          draftUpdatedAt - lastBallCustodyHeartbeatAt < BALL_CUSTODY_INVOCATION_HEARTBEAT_MIN_INTERVAL_MS
        ) {
          return;
        }
        lastBallCustodyHeartbeatAt = draftUpdatedAt;
        emitBallInvocationHeartbeat(deps.ballCustody, threadId, ownInvocationId, catId as string, draftUpdatedAt);
      };

      // Always pass isLastCat:false — we set isFinal AFTER A2A detection
      log.debug(
        { catId: catId as string, threadId, promptLength: prompt.length, index, worklistSize: worklist.length },
        'Invoking cat via invokeSingleCat',
      );
      const leakedPayloadStripper = createLeakedToolCallStreamStripper();
      const invocationSpanRef: { current?: Span } = {};
      const invocationStartedAt = Date.now();
      // F215 AC-C3: flag set when invokeSingleCat emits malformed_toolcall_relay_46 signal
      let malformedRelayPending = false;
      // F177-H: guard-enabled cats buffer first-pass text events until routing validation.
      // This avoids a ghost invalid bubble if a remedial turn replaces the response; Codex exec is effectively
      // batch-oriented today, but a future true-streaming provider should revisit this latency tradeoff.
      const initialTextStreamEvents: AgentMessage[] = [];
      const createVoiceChunker = (invocationId: string): StreamingTtsChunker | undefined => {
        if (!voiceMode || !deps.socketManager) return undefined;
        const ttsRegistry = getStreamingTtsRegistry();
        if (!ttsRegistry) return undefined;
        return new StreamingTtsChunker({
          catId: catId as string,
          invocationId,
          threadId,
          voiceConfig: getCatVoice(catId as string),
          broadcaster: deps.socketManager,
          ttsRegistry,
          signal: catSignal,
        });
      };
      const flushVoiceChunker = async (
        chunker: StreamingTtsChunker | undefined,
        invocationId: string | undefined,
      ): Promise<void> => {
        if (!chunker) return;
        let voiceTotalChunks = 0;
        try {
          voiceTotalChunks = await chunker.flush();
        } catch (err) {
          log.error({ err }, 'Voice chunker flush failed');
        }
        if (deps.socketManager && chunker.hasStarted()) {
          const aborted = catSignal?.aborted ?? false;
          deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'voice_stream_end', {
            type: 'voice_stream_end',
            catId: catId as string,
            invocationId: invocationId ?? '',
            threadId,
            totalChunks: aborted ? -1 : voiceTotalChunks,
          });
        }
      };
      const resetDeferredVoice = () => {
        deferredVoiceInvocationId = undefined;
        deferredVoiceTextChunks.splice(0, deferredVoiceTextChunks.length);
      };
      const settleCallbackRoutingExit = (
        completedTool: PendingToolResult,
        confirmed: boolean,
      ): CallbackContentRoutingExit | undefined => {
        const exitIndex = completedTool.toolUseId
          ? pendingCallbackRoutingExits.findIndex((candidate) => candidate.toolUseId === completedTool.toolUseId)
          : pendingCallbackRoutingExits.findIndex((candidate) =>
              toolNamesMatch(candidate.toolName, completedTool.toolName),
            );
        if (exitIndex === -1) return undefined;

        const [exit] = pendingCallbackRoutingExits.splice(exitIndex, 1);
        if (!confirmed || !exit) return undefined;
        for (const mention of exit.guardLineStartMentions) confirmedCallbackRoutingGuardMentions.add(mention);
        for (const mention of exit.localLineStartMentions) confirmedLocalCallbackRoutingMentions.add(mention);
        if (exit.hasGuardCoCreatorLineStartMention) confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = true;
        if (exit.hasLocalCoCreatorLineStartMention) confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = true;
        return exit;
      };
      const getRoutingExitLineStartMentions = (textMentions: readonly CatId[] = []): CatId[] => [
        ...new Set<CatId>([...textMentions, ...confirmedCallbackRoutingGuardMentions]),
      ];
      const getLocalRoutingLineStartMentions = (textMentions: readonly CatId[] = []): CatId[] => [
        ...new Set<CatId>([...textMentions, ...confirmedLocalCallbackRoutingMentions]),
      ];
      const hasRoutingExitCoCreatorLineStartMention = (content: string): boolean =>
        Boolean(
          (content ? detectUserMention(content) : false) || confirmedCallbackRoutingGuardHasCoCreatorLineStartMention,
        );
      const hasLocalCoCreatorLineStartMention = (content: string): boolean => {
        if (content && detectUserMention(content)) return true;
        return confirmedLocalCallbackRoutingHasCoCreatorLineStartMention;
      };
      const emitBallHandedCvoOnce = (
        messageId: string | undefined,
        eventThreadId: string | undefined = threadId,
      ): void => {
        if (!messageId || !eventThreadId) return;
        const eventKey = `${eventThreadId}:${messageId}`;
        if (emittedBallHandedCvoMessageIds.has(eventKey)) return;
        emittedBallHandedCvoMessageIds.add(eventKey);
        emitBallHandedCvo(deps.ballCustody, eventThreadId, catId as string, messageId);
      };
      const emitConfirmedCallbackBallHandedCvo = (
        confirmed: boolean,
        settledExit: CallbackContentRoutingExit | undefined,
        messageId: string | undefined,
        resultThreadId: string | undefined,
      ): void => {
        if (!confirmed || !settledExit) return;
        if (settledExit.hasLocalCoCreatorLineStartMention) {
          emitBallHandedCvoOnce(messageId, resultThreadId ?? threadId);
        }
        if (settledExit.hasTargetCoCreatorLineStartMention) {
          emitBallHandedCvoOnce(messageId, resultThreadId);
        }
      };
      const flushDeferredVoice = async (): Promise<void> => {
        if (!deferredVoiceInvocationId || deferredVoiceTextChunks.length === 0) {
          resetDeferredVoice();
          return;
        }
        const deferredChunker = createVoiceChunker(deferredVoiceInvocationId);
        for (const chunk of deferredVoiceTextChunks) {
          deferredChunker?.feed(chunk);
        }
        await flushVoiceChunker(deferredChunker, deferredVoiceInvocationId);
        resetDeferredVoice();
      };
      const toStreamEvent = (effectiveMsg: AgentMessage): AgentMessage | null => {
        if (effectiveMsg.type === 'text' && !effectiveMsg.content) return null;
        // F194 Phase Z9 砚砚 R1 P1-1: stamp ownInvocationId on yielded stream events
        // so downstream broadcaster (messages.ts) doesn't fall back to parent when
        // assigning turnInvocationId. CLI text/done/tool events don't carry
        // invocationId; only system_info=invocation_created does. Without explicit
        // stamping, multi-turn same-cat under shared parent collapses to one bubble.
        const ownStampedMsg =
          ownInvocationId && !effectiveMsg.invocationId
            ? { ...effectiveMsg, invocationId: ownInvocationId }
            : effectiveMsg;
        // Tag CLI stdout text with origin: 'stream' (thinking/internal).
        return ownStampedMsg.type === 'text'
          ? {
              ...ownStampedMsg,
              origin: 'stream' as const,
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              ...(streamReplyPreview ? { replyPreview: streamReplyPreview } : {}),
            }
          : ownStampedMsg;
      };
      // F233 P1 (云端 review): 球到此 cat 手上（接球时刻）→ ball.handed。统一覆盖 original routing
      // (user→cat，directMessageFrom=undefined) 与 A2A (cat→cat，directMessageFrom=前手猫)。这是球真正
      // 抵达持有者的时刻，取代原先只在 A2A handoff 发射点 emit（那里 `wi<targetCats.length` continue 会
      // skip original targets，导致 initial routing 的 ball.handed 漏记，projection 空/stale 到后续 handoff）。
      emitBallHanded(
        deps.ballCustody,
        threadId,
        directMessageFrom ?? '',
        catId as string,
        streamReplyTo ?? currentUserMessageId,
      );
      for await (const msg of invokeSingleCat(deps.invocationDeps, {
        catId,
        service,
        prompt,
        userId,
        threadId,
        ...(targetContentBlocks ? { contentBlocks: targetContentBlocks } : {}),
        ...(targetUploadDir ? { uploadDir: targetUploadDir } : {}),
        ...(catSignal ? { signal: catSignal } : {}),
        ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
        ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
        continuityCapsule,
        // F121: Pass A2A trigger message ID for auto-replyTo threading
        ...(worklistEntry.a2aTriggerMessageId.get(catId)
          ? { a2aTriggerMessageId: worklistEntry.a2aTriggerMessageId.get(catId) }
          : {}),
        ...((mentionParentSpan.get(index) ?? options.routeSpan)
          ? { routeSpan: mentionParentSpan.get(index) ?? options.routeSpan }
          : {}),
        invocationSpanRef,
        isLastCat: false,
      })) {
        // F39 bugfix: stop yielding after cancel (pipe buffer may still drain)
        if (catSignal?.aborted) break;

        const effectiveMsgs: AgentMessage[] = [];
        if (msg.type === 'text' && msg.content) {
          effectiveMsgs.push({ ...msg, content: leakedPayloadStripper.push(msg.content) });
        } else if (msg.type === 'done') {
          const flushedText = leakedPayloadStripper.flush();
          if (flushedText) {
            effectiveMsgs.push({
              type: 'text',
              catId,
              content: flushedText,
              timestamp: msg.timestamp,
            });
          }
          effectiveMsgs.push(msg);
        } else {
          effectiveMsgs.push(msg);
        }

        for (const effectiveMsg of effectiveMsgs) {
          // F22 R2 P1-1: Capture invocationId from the initial system_info.
          // Keep forwarding this boundary event so frontend can reset stale task progress.
          if (effectiveMsg.type === 'system_info' && effectiveMsg.content && !ownInvocationId) {
            try {
              const parsed = JSON.parse(effectiveMsg.content);
              if (parsed.type === 'invocation_created') {
                ownInvocationId = parsed.invocationId;
                emitBallInvocationStarted(deps.ballCustody, threadId, ownInvocationId, catId as string);
                // F111 Phase B: Start streaming TTS when we have an invocationId.
                // F177-H guard-enabled turns defer first-pass voice text because it may
                // be replaced by a remedial turn and must not be spoken early.
                if (voiceMode) {
                  if (needsServerRoutingGuard) {
                    deferredVoiceInvocationId = ownInvocationId!;
                  } else {
                    voiceChunker = createVoiceChunker(ownInvocationId!);
                  }
                }
                // Issue #83: Start keepalive timer once we have an invocationId.
                // This ensures draft TTL is renewed even during long silent tool calls.
                if (deps.draftStore && !keepaliveTimer) {
                  const keepInvId = ownInvocationId!;
                  keepaliveTimer = setInterval(() => {
                    const now = Date.now();
                    deps.draftStore!.touch(userId, threadId, keepInvId)?.catch?.(noop);
                    emitThrottledBallInvocationHeartbeat(now);
                  }, KEEPALIVE_INTERVAL_MS);
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          if (effectiveMsg.type === 'text' && effectiveMsg.content) {
            textContent = accumulateTextAggregate(
              textContent,
              effectiveMsg.content,
              (effectiveMsg as { textMode?: 'append' | 'replace' }).textMode,
            );
            if (voiceMode && needsServerRoutingGuard) {
              deferredVoiceTextChunks.push(effectiveMsg.content);
            } else {
              voiceChunker?.feed(effectiveMsg.content);
            }
          }
          // F045: Accumulate thinking blocks for persistence (F5 recovery)
          if (effectiveMsg.type === 'system_info' && effectiveMsg.content) {
            if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
              sawUserFacingSystemInfo = true;
            }
            try {
              const parsed = JSON.parse(effectiveMsg.content);
              if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
                thinkingChunks.splice(0, thinkingChunks.length, ...appendThinkingChunk(thinkingChunks, parsed.text));
              }
              // F060: Collect inline rich_block for persistence (P1 fix)
              if (parsed.type === 'rich_block' && parsed.block && isValidRichBlock(parsed.block)) {
                streamRichBlocks.push(parsed.block);
              }
              // F153: Accumulate invocation tokens for route aggregate
              if (parsed.type === 'invocation_usage' && parsed.usage) {
                routeTotalTokens += (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0);
              }
              // F215 AC-C3: detect 46-接力 relay signal — set flag to push opus-4.6 after loop.
              // This is an internal routing signal; must be consumed here and NOT yielded to the frontend.
              if (parsed.type === 'malformed_toolcall_relay_46') {
                const relay46CatId = createCatId('opus');
                if (catId !== relay46CatId && Object.hasOwn(deps.services, relay46CatId as string)) {
                  malformedRelayPending = true;
                  log.info(
                    { catId: catId as string, threadId, relay46CatId },
                    '[F215] malformed_toolcall_relay_46 signal received — will push opus-4.6 after loop',
                  );
                }
                continue; // consume routing signal — never surfaces to user as raw JSON
              }
            } catch {
              /* ignore parse errors */
            }
          }
          // F215 AC-C3: suppress malformed error when relay to 46 is already queued
          if (
            malformedRelayPending &&
            effectiveMsg.type === 'error' &&
            typeof effectiveMsg.error === 'string' &&
            effectiveMsg.error.startsWith('malformed_toolcall:')
          ) {
            continue; // 46 will take over — don't surface error to user
          }
          // Accumulate tool events for persistence (before draft flush so current event is available)
          const toolEvt = toStoredToolEvent(effectiveMsg);
          if (toolEvt) {
            collectedToolEvents.push(toolEvt);
          }

          if (effectiveMsg.type === 'tool_use') {
            for (const target of collectStructuredTargetCatsFromInput(effectiveMsg.toolInput)) {
              structuredTargetCats.add(target);
            }
          }

          // F148 OQ-2: Collect tool names for context eval
          if (effectiveMsg.type === 'tool_use' && effectiveMsg.toolName) {
            collectedToolNames.push(effectiveMsg.toolName);
            pendingToolResults.push({
              toolName: effectiveMsg.toolName,
              ...(effectiveMsg.toolUseId ? { toolUseId: effectiveMsg.toolUseId } : {}),
            });
            const callbackExit = collectCallbackContentRoutingExit(
              effectiveMsg.toolName,
              effectiveMsg.toolInput,
              catId,
              effectiveMsg.toolUseId,
            );
            if (callbackExit) pendingCallbackRoutingExits.push(callbackExit);
            if (isPostMessageToolName(effectiveMsg.toolName)) awaitingCallbackResult = true;
          }
          // #573: Confirm callback persistence via tool_result success
          if (effectiveMsg.type === 'tool_result') {
            const callbackResult = parseCallbackPostResult(effectiveMsg.content);
            const completedToolName = consumePendingToolResult(
              pendingToolResults,
              effectiveMsg,
              callbackResult.confirmed,
              Boolean(callbackResult.messageId && callbackResult.threadId),
            );
            if (
              awaitingCallbackResult &&
              completedToolName &&
              isPostMessageToolName(completedToolName.toolName) &&
              callbackResult.confirmed
            ) {
              callbackPostConfirmed = true;
              awaitingCallbackResult = false;
              if (callbackResult.messageId) callbackPostMessageId = callbackResult.messageId;
            }
            if (completedToolName) {
              const settledExit = settleCallbackRoutingExit(completedToolName, callbackResult.confirmed);
              emitConfirmedCallbackBallHandedCvo(
                callbackResult.confirmed,
                settledExit,
                callbackResult.messageId,
                callbackResult.threadId,
              );
            }
            // F188 Phase F AC-F10 (砚砚 六审 P1-B: also scope by catId for serial route consistency).
            // 砚砚 cloud-3 P1: also pass toolUseId for exact match when available;
            // otherwise FIFO toolName+catId match handles same-name parallel calls.
            if (deps.toolEventLog && completedToolName) {
              const normalizedName = normalizeMcpToolName(completedToolName.toolName);
              const resultSummary = deriveResultSummary(normalizedName, effectiveMsg.content);
              if (Object.keys(resultSummary).length > 0) {
                const resultMsg = effectiveMsg as { catId?: string; toolUseId?: string };
                const matcher: { toolUseId?: string; toolName?: string; catId?: string } = resultMsg.toolUseId
                  ? { toolUseId: resultMsg.toolUseId }
                  : resultMsg.catId
                    ? { toolName: normalizedName, catId: resultMsg.catId }
                    : { toolName: normalizedName };
                deps.toolEventLog.updateSummary(threadId, matcher, resultSummary).catch(() => {});
              }
            }
          }

          // F150: Fire-and-forget tool usage counter
          if (effectiveMsg.type === 'tool_use' && deps.toolUsageCounter && effectiveMsg.catId) {
            deps.toolUsageCounter.recordToolUse(
              effectiveMsg.catId as string,
              effectiveMsg.toolName ?? 'unknown',
              effectiveMsg.toolInput as Record<string, unknown> | undefined,
            );
          }
          // F188 Phase F AC-F10: append-only tool event log (砚砚 三审 P1 wiring)
          if (effectiveMsg.type === 'tool_use' && deps.toolEventLog && effectiveMsg.catId) {
            const msg = effectiveMsg as {
              catId?: string;
              toolName?: string;
              toolInput?: Record<string, unknown>;
              toolUseId?: string;
              invocationId?: string;
              sessionId?: string;
              threadId?: string;
              turnIndex?: number;
            };
            // 砚砚 四审 P1-1: normalizeMcpToolName handles mcp__/mcp:/cat_cafe_ child extraction
            const rawToolName = msg.toolName ?? 'unknown';
            const classification = classifyTool(rawToolName, msg.toolInput);
            const normalizedToolName =
              classification.category === 'skill' ? classification.toolName : normalizeMcpToolName(rawToolName);
            // 砚砚 cloud-3 P1: propagate toolUseId into summary (as _toolUseId) so
            // updateSummary can do exact match when provider emits it on tool_result.
            const baseSummary = (msg.toolInput ?? {}) as Record<string, unknown>;
            const summary: Record<string, unknown> = msg.toolUseId
              ? { ...baseSummary, _toolUseId: msg.toolUseId }
              : baseSummary;
            deps.toolEventLog
              .append({
                invocationId: msg.invocationId ?? ownInvocationId ?? 'unknown',
                sessionId: msg.sessionId ?? ownInvocationId ?? 'unknown',
                threadId: msg.threadId ?? threadId ?? 'unknown',
                catId: msg.catId ?? 'unknown',
                toolName: normalizedToolName,
                timestamp: Date.now(),
                turnIndex: msg.turnIndex ?? 0,
                status: 'success',
                summary,
              })
              .catch(() => {});
            // 砚砚 二审 P1-4: detect Skill tool_use → SkillLoadEventLog (AS-4 producer path)
            if (rawToolName === 'Skill' && deps.skillLoadEventLog) {
              const skillName =
                msg.toolInput && typeof msg.toolInput['skill'] === 'string'
                  ? (msg.toolInput['skill'] as string)
                  : 'unknown';
              deps.skillLoadEventLog
                .append({
                  invocationId: msg.invocationId ?? ownInvocationId ?? 'unknown',
                  sessionId: msg.sessionId ?? ownInvocationId ?? 'unknown',
                  skillId: skillName,
                  loadTrigger: 'explicit_call',
                  timestamp: Date.now(),
                })
                .catch(() => {});
            }
          }

          // #80: Draft flush — fire-and-forget periodic persistence for F5 recovery
          if (deps.draftStore && ownInvocationId) {
            const now = Date.now();
            const charDelta = textContent.length - lastFlushLen;
            const isReplaceText = (effectiveMsg as { textMode?: 'append' | 'replace' }).textMode === 'replace';
            const neverFlushed = lastFlushLen === 0 && lastFlushToolLen === 0;
            if (
              effectiveMsg.type === 'text' &&
              charDelta !== 0 &&
              (neverFlushed ||
                isReplaceText ||
                now - lastFlushTime >= FLUSH_INTERVAL_MS ||
                charDelta >= FLUSH_CHAR_DELTA)
            ) {
              deps.draftStore
                .upsert({
                  userId,
                  threadId,
                  invocationId: ownInvocationId,
                  catId,
                  content: textContent,
                  ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                  ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                  updatedAt: now,
                })
                ?.catch?.(noop);
              emitThrottledBallInvocationHeartbeat(now);
              lastFlushTime = now;
              lastFlushLen = textContent.length;
              lastFlushToolLen = collectedToolEvents.length;
            } else if (
              (effectiveMsg.type === 'tool_use' || effectiveMsg.type === 'tool_result') &&
              // Cloud R7 P1: bypass interval for the very first flush — tool-first invocations
              // must create a draft immediately, not wait 2s for the interval gate.
              (neverFlushed || now - lastFlushTime >= FLUSH_INTERVAL_MS)
            ) {
              // Heartbeat for non-text events: keep draft alive during long tool calls.
              // Cloud R6 P1: upsert when there's unsaved text OR new tool events —
              // tool-first invocations (no text yet) must still create a draft record.
              if (textContent.length > lastFlushLen || collectedToolEvents.length > lastFlushToolLen) {
                deps.draftStore
                  .upsert({
                    userId,
                    threadId,
                    invocationId: ownInvocationId,
                    catId,
                    content: textContent,
                    ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                    ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                    updatedAt: now,
                  })
                  ?.catch?.(noop);
                emitThrottledBallInvocationHeartbeat(now);
                lastFlushLen = textContent.length;
                lastFlushToolLen = collectedToolEvents.length;
              } else {
                deps.draftStore.touch(userId, threadId, ownInvocationId)?.catch?.(noop);
                emitThrottledBallInvocationHeartbeat(now);
              }
              lastFlushTime = now;
            }
          }

          if (effectiveMsg.type === 'error') {
            hadError = true;
            // #267: errors before abort are real provider failures; errors after abort are cleanup
            if (!catSignal?.aborted) hadProviderError = true;
            if (effectiveMsg.error) {
              collectedErrorText += `${collectedErrorText ? '\n' : ''}${effectiveMsg.error}`;
            }
            // F212 Phase B (云端 codex P2-8): capture structured cliDiagnostics from
            // metadata; keep the first one seen (canonical for this invocation).
            const meta = effectiveMsg.metadata as
              | { cliDiagnostics?: import('@cat-cafe/shared').CliDiagnostics }
              | undefined;
            if (meta?.cliDiagnostics && !collectedCliDiagnostics) {
              collectedCliDiagnostics = meta.cliDiagnostics;
            }
          }
          if (effectiveMsg.metadata && !firstMetadata) {
            firstMetadata = effectiveMsg.metadata;
          }
          if (effectiveMsg.type === 'done') {
            doneMsg = effectiveMsg; // Buffer — yield after A2A detection
          } else {
            const streamEvent = toStreamEvent(effectiveMsg);
            if (!streamEvent) continue;
            if (needsServerRoutingGuard && streamEvent.type === 'text') {
              initialTextStreamEvents.push(streamEvent);
            } else {
              yield streamEvent;
            }
          }
        }
      }

      // Issue #83: Stop keepalive timer — streaming loop has exited.
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }

      // F215 AC-C3: push opus-4.6 to worklist as relay when 48 炸毛 + fresh retry also failed
      if (malformedRelayPending) {
        const relay46CatId = createCatId('opus');
        if (
          catId !== relay46CatId &&
          Object.hasOwn(deps.services, relay46CatId as string) &&
          // P2 fix + P1 #1 fix: only check PENDING entries (worklist[index+1..]) not the full
          // worklist. worklist[0..index] are already executed; including them would silently skip
          // a legitimate relay when opus ran first in the route (e.g. [opus, opus-48]).
          !worklist.slice(index + 1).includes(relay46CatId)
        ) {
          worklist.push(relay46CatId);
          worklistEntry.a2aCount++;
          worklistEntry.a2aFrom.set(relay46CatId, catId);
          log.info(
            { catId: catId as string, relay46CatId, threadId, a2aCount: worklistEntry.a2aCount },
            '[F215] Pushed opus-4.6 to worklist for malformed tool-call relay (AC-C3)',
          );
        } else if (worklist.slice(index + 1).includes(relay46CatId)) {
          log.info(
            { catId: catId as string, relay46CatId, threadId },
            '[F215] opus-4.6 already pending in worklist — skipping duplicate relay push (P2 dedup)',
          );
        }
        malformedRelayPending = false;
      }

      if (voiceChunker) {
        // F111 Phase B: Flush remaining buffered text and send voice_stream_end.
        // Guard-enabled turns do not create this first-pass chunker; their voice is flushed
        // only after routing validation below.
        await flushVoiceChunker(voiceChunker, ownInvocationId);
        voiceChunker = undefined;
      }

      let a2aMentions: CatId[] = [];

      // F22: Consume MCP-buffered rich blocks BEFORE the text/empty branch —
      // blocks must be persisted even when the cat emits no text (cloud Codex P1).
      const bufferedBlocks = getRichBlockBuffer().consume(threadId, catId as string, ownInvocationId);

      // F061: Detect @co-creator mentions in agent response for browser notification
      let mentionsUser = false;

      const appendRoutingGuardFailureNotice = async () => {
        try {
          const failureSource = {
            connector: 'routing-guard-failure',
            label: '路由守卫失败',
            icon: '🏓',
            meta: { presentation: 'system_notice', noticeTone: 'warning' },
          };
          const stored = await deps.messageStore.append({
            userId: 'system',
            catId: null,
            threadId,
            content: '[路由守卫]: 补救失败，第二次回复仍没有合法的路由出口；已停止自动重试以避免重复调用。',
            mentions: [],
            timestamp: Date.now(),
            source: failureSource,
          });
          if (deps.socketManager) {
            deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
              threadId,
              message: {
                id: stored.id,
                type: 'connector',
                content: stored.content,
                source: failureSource,
                timestamp: stored.timestamp,
              },
            });
          }
        } catch {
          /* non-blocking guard failure notice */
        }
      };

      const runRoutingGuardRemedial = async (
        originalStoredContentBeforeRemedial: string,
        originalRichBlocksBeforeRemedial: RichBlock[],
        originalToolEventsBeforeRemedial: StoredToolEvent[],
      ): Promise<{
        storedContent: string;
        allRichBlocks: RichBlock[];
        a2aMentions: CatId[];
        hasCoCreatorLineStartMention: boolean;
        hasLocalCoCreatorLineStartMention: boolean;
        streamEvents: AgentMessage[];
      }> => {
        routingGuardAttempted = true;
        routingGuardRemediated = true;
        const originalTextStreamEventsBeforeRemedial = [...initialTextStreamEvents];
        const originalDeferredVoiceInvocationIdBeforeRemedial = deferredVoiceInvocationId;
        const originalDeferredVoiceTextChunksBeforeRemedial = [...deferredVoiceTextChunks];
        initialTextStreamEvents.splice(0, initialTextStreamEvents.length);
        resetDeferredVoice();

        if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }

        textContent = '';
        thinkingChunks.splice(0, thinkingChunks.length);
        firstMetadata = undefined;
        doneMsg = undefined;
        collectedToolEvents.splice(0, collectedToolEvents.length);
        collectedToolNames.splice(0, collectedToolNames.length);
        structuredTargetCats.clear();
        streamRichBlocks.splice(0, streamRichBlocks.length);
        pendingToolResults.splice(0, pendingToolResults.length);
        pendingCallbackRoutingExits.splice(0, pendingCallbackRoutingExits.length);
        confirmedCallbackRoutingGuardMentions.clear();
        confirmedLocalCallbackRoutingMentions.clear();
        confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = false;
        confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = false;
        callbackPostConfirmed = false;
        callbackPostMessageId = undefined;
        awaitingCallbackResult = false;
        ownInvocationId = undefined;

        const remedialStreamEvents: AgentMessage[] = [];
        const remedialStripper = createLeakedToolCallStreamStripper();
        for await (const remedialMsg of invokeSingleCat(deps.invocationDeps, {
          catId,
          service,
          prompt: buildRemedialPrompt(),
          userId,
          threadId,
          ...(catSignal ? { signal: catSignal } : {}),
          ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
          ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
          continuityCapsule,
          ...(streamReplyTo ? { a2aTriggerMessageId: streamReplyTo } : {}),
          ...((mentionParentSpan.get(index) ?? options.routeSpan)
            ? { routeSpan: mentionParentSpan.get(index) ?? options.routeSpan }
            : {}),
          invocationSpanRef,
          isLastCat: false,
        })) {
          if (catSignal?.aborted) break;

          const remedialMsgs: AgentMessage[] = [];
          if (remedialMsg.type === 'text' && remedialMsg.content) {
            remedialMsgs.push({ ...remedialMsg, content: remedialStripper.push(remedialMsg.content) });
          } else if (remedialMsg.type === 'done') {
            const flushedText = remedialStripper.flush();
            if (flushedText) {
              remedialMsgs.push({
                type: 'text',
                catId,
                content: flushedText,
                timestamp: remedialMsg.timestamp,
              });
            }
            remedialMsgs.push(remedialMsg);
          } else {
            remedialMsgs.push(remedialMsg);
          }

          for (const effectiveMsg of remedialMsgs) {
            if (effectiveMsg.type === 'system_info' && effectiveMsg.content && !ownInvocationId) {
              try {
                const parsed = JSON.parse(effectiveMsg.content);
                if (parsed.type === 'invocation_created') {
                  ownInvocationId = parsed.invocationId;
                  emitBallInvocationStarted(deps.ballCustody, threadId, ownInvocationId, catId as string);
                  if (voiceMode) {
                    deferredVoiceInvocationId = ownInvocationId;
                  }
                }
              } catch {
                /* ignore parse errors */
              }
            }

            if (effectiveMsg.type === 'text' && effectiveMsg.content) {
              textContent = accumulateTextAggregate(
                textContent,
                effectiveMsg.content,
                (effectiveMsg as { textMode?: 'append' | 'replace' }).textMode,
              );
              if (voiceMode) {
                deferredVoiceTextChunks.push(effectiveMsg.content);
              }
            }

            if (effectiveMsg.type === 'system_info' && effectiveMsg.content) {
              if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
                sawUserFacingSystemInfo = true;
              }
              try {
                const parsed = JSON.parse(effectiveMsg.content);
                if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
                  thinkingChunks.splice(0, thinkingChunks.length, ...appendThinkingChunk(thinkingChunks, parsed.text));
                }
                if (parsed.type === 'rich_block' && parsed.block && isValidRichBlock(parsed.block)) {
                  streamRichBlocks.push(parsed.block);
                }
                if (parsed.type === 'invocation_usage' && parsed.usage) {
                  routeTotalTokens += (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0);
                }
              } catch {
                /* ignore parse errors */
              }
            }

            const toolEvt = toStoredToolEvent(effectiveMsg);
            if (toolEvt) {
              collectedToolEvents.push(toolEvt);
            }

            if (effectiveMsg.type === 'tool_use') {
              for (const target of collectStructuredTargetCatsFromInput(effectiveMsg.toolInput)) {
                structuredTargetCats.add(target);
              }
            }
            if (effectiveMsg.type === 'tool_use' && effectiveMsg.toolName) {
              collectedToolNames.push(effectiveMsg.toolName);
              pendingToolResults.push({
                toolName: effectiveMsg.toolName,
                ...(effectiveMsg.toolUseId ? { toolUseId: effectiveMsg.toolUseId } : {}),
              });
              const callbackExit = collectCallbackContentRoutingExit(
                effectiveMsg.toolName,
                effectiveMsg.toolInput,
                catId,
                effectiveMsg.toolUseId,
              );
              if (callbackExit) pendingCallbackRoutingExits.push(callbackExit);
              if (isPostMessageToolName(effectiveMsg.toolName)) awaitingCallbackResult = true;
            }
            if (effectiveMsg.type === 'tool_result') {
              const callbackResult = parseCallbackPostResult(effectiveMsg.content);
              const completedToolName = consumePendingToolResult(
                pendingToolResults,
                effectiveMsg,
                callbackResult.confirmed,
                Boolean(callbackResult.messageId && callbackResult.threadId),
              );
              if (
                awaitingCallbackResult &&
                completedToolName &&
                isPostMessageToolName(completedToolName.toolName) &&
                callbackResult.confirmed
              ) {
                callbackPostConfirmed = true;
                awaitingCallbackResult = false;
                if (callbackResult.messageId) callbackPostMessageId = callbackResult.messageId;
              }
              if (completedToolName) {
                const settledExit = settleCallbackRoutingExit(completedToolName, callbackResult.confirmed);
                emitConfirmedCallbackBallHandedCvo(
                  callbackResult.confirmed,
                  settledExit,
                  callbackResult.messageId,
                  callbackResult.threadId,
                );
              }
            }

            if (effectiveMsg.metadata && !firstMetadata) {
              firstMetadata = effectiveMsg.metadata;
            }
            if (effectiveMsg.type === 'done') {
              doneMsg = effectiveMsg;
            } else {
              const streamEvent = toStreamEvent(effectiveMsg);
              if (streamEvent) remedialStreamEvents.push(streamEvent);
            }
          }
        }

        const remedialSanitized = sanitizeInjectedContent(textContent);
        const remedialExtracted = extractRichFromText(remedialSanitized);
        const remedialCleanText = remedialExtracted.cleanText;
        const remedialRouteOnlyContent = remedialCleanText ? normalizeRouteOnlyRemedialText(remedialCleanText) : null;
        const remedialIsRouteOnly = remedialRouteOnlyContent !== null;
        // Route-only remedial text (`@cat` / `@co-creator`) is an exit patch, not a replacement artifact.
        // Use it for routing validation, but keep first-pass visible content so F5/history hydration
        // does not replace generated work with a bare route outlet.
        const preservesOriginalVisibleContent =
          (!remedialCleanText || remedialIsRouteOnly) && originalStoredContentBeforeRemedial.length > 0;
        const remedialStoredContent = preservesOriginalVisibleContent
          ? originalStoredContentBeforeRemedial
          : remedialCleanText;
        const remedialRoutingContent = remedialRouteOnlyContent ?? (remedialCleanText || remedialStoredContent);
        const baseRichBlocks = !remedialCleanText || remedialIsRouteOnly ? originalRichBlocksBeforeRemedial : [];
        let remedialAllRichBlocks = [...baseRichBlocks, ...remedialExtracted.blocks, ...streamRichBlocks];
        // Replacement text becomes a new persisted message and discards invalid first-pass evidence.
        // Exit-only remedials keep the original visible content, so preserve original tool evidence too.
        if (preservesOriginalVisibleContent && originalToolEventsBeforeRemedial.length > 0) {
          const remedialToolEvents = [...collectedToolEvents];
          collectedToolEvents.splice(
            0,
            collectedToolEvents.length,
            ...originalToolEventsBeforeRemedial,
            ...remedialToolEvents,
          );
        }
        textContent = remedialStoredContent;
        if (preservesOriginalVisibleContent && originalDeferredVoiceTextChunksBeforeRemedial.length > 0) {
          resetDeferredVoice();
          deferredVoiceInvocationId = originalDeferredVoiceInvocationIdBeforeRemedial;
          deferredVoiceTextChunks.push(...originalDeferredVoiceTextChunksBeforeRemedial);
        }

        if (!voiceMode) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && remedialAllRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              remedialAllRichBlocks = await voiceSynth.resolveVoiceBlocks(remedialAllRichBlocks, catId as string);
            } catch (err) {
              log.error({ catId: catId as string, err }, 'Voice block synthesis failed for routing guard remedial');
            }
          }
        }

        const remedialA2aMentions = parseA2AMentions(remedialRoutingContent, catId);
        if (remedialA2aMentions.length > 0) {
          lineStartDetected.add(remedialA2aMentions.length, { 'agent.id': catId as string });
        }
        const remedialHasCoCreatorLineStartMention = hasRoutingExitCoCreatorLineStartMention(remedialRoutingContent);
        const remedialHasLocalCoCreatorLineStartMention = hasLocalCoCreatorLineStartMention(remedialRoutingContent);
        const visibleRemedialStreamEvents = remedialIsRouteOnly
          ? remedialStreamEvents.filter((event) => event.type !== 'text')
          : remedialStreamEvents;
        const originalVisibleStreamEventsForRemedialTurn = ownInvocationId
          ? originalTextStreamEventsBeforeRemedial.map((event) => ({ ...event, invocationId: ownInvocationId }))
          : originalTextStreamEventsBeforeRemedial;

        return {
          storedContent: remedialStoredContent,
          allRichBlocks: remedialAllRichBlocks,
          a2aMentions: remedialA2aMentions,
          hasCoCreatorLineStartMention: remedialHasCoCreatorLineStartMention,
          hasLocalCoCreatorLineStartMention: remedialHasLocalCoCreatorLineStartMention,
          // Exit-only remedials validate the original text instead of replacing it; surface it after validation.
          streamEvents: preservesOriginalVisibleContent
            ? [...visibleRemedialStreamEvents, ...originalVisibleStreamEventsForRemedialTurn]
            : remedialStreamEvents,
        };
      };

      let noTextBlocksOverride: RichBlock[] | undefined;

      if (
        !textContent &&
        !hadError &&
        shouldRemediateRouting({
          needsGuard: needsServerRoutingGuard,
          attempted: routingGuardAttempted,
          lineStartMentions: getRoutingExitLineStartMentions(),
          toolNames: collectedToolNames,
          structuredTargetCats: [...structuredTargetCats],
          hasCoCreatorLineStartMention: hasRoutingExitCoCreatorLineStartMention(''),
        })
      ) {
        const result = await runRoutingGuardRemedial(
          '',
          [...bufferedBlocks, ...streamRichBlocks],
          [...collectedToolEvents],
        );
        for (const event of result.streamEvents) yield event;
        await flushDeferredVoice();
        noTextBlocksOverride = result.allRichBlocks;
        if (
          !hasValidRoutingExit({
            lineStartMentions: getRoutingExitLineStartMentions(result.a2aMentions),
            toolNames: collectedToolNames,
            structuredTargetCats: [...structuredTargetCats],
            hasCoCreatorLineStartMention: result.hasCoCreatorLineStartMention,
          })
        ) {
          await appendRoutingGuardFailureNotice();
        }
      }

      if (textContent) {
        catProducedOutput = true;
        const sanitized = sanitizeInjectedContent(textContent);

        // F22: Extract cc_rich blocks from text (Route B fallback for non-MCP cats)
        const { cleanText, blocks: textBlocks } = extractRichFromText(sanitized);
        let storedContent = cleanText;
        let allRichBlocks = [...bufferedBlocks, ...textBlocks, ...streamRichBlocks];

        // F34-b: Resolve voice blocks (audio with text, no url) — Route B path.
        // Route A blocks were already resolved in the callback handler.
        // F111: When voiceMode is active, skip full synthesis so audio blocks
        // arrive at the frontend with text but no url — the frontend will use
        // /api/tts/stream for chunked streaming playback (<2s first-audio).
        if (!voiceMode) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && allRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              allRichBlocks = await voiceSynth.resolveVoiceBlocks(allRichBlocks, catId as string);
            } catch (err) {
              log.error({ catId: catId as string, err }, 'Voice block synthesis failed');
            }
          }
        }

        // A2A mention detection (缅因猫 P1-3: only after full text accumulated)
        // Line-start @mention = always actionable (no keyword gate)
        a2aMentions = parseA2AMentions(storedContent, catId);

        // clowder-ai#489: baseline counter — line-start mentions
        if (a2aMentions.length > 0) {
          lineStartDetected.add(a2aMentions.length, { 'agent.id': catId as string });
        }

        let routingExitLineStartMentions = getRoutingExitLineStartMentions(a2aMentions);
        let routingExitHasCoCreatorLineStartMention = hasRoutingExitCoCreatorLineStartMention(storedContent);
        let localCvoHasCoCreatorLineStartMention = hasLocalCoCreatorLineStartMention(storedContent);

        if (
          shouldRemediateRouting({
            needsGuard: needsServerRoutingGuard,
            attempted: routingGuardAttempted,
            lineStartMentions: routingExitLineStartMentions,
            toolNames: collectedToolNames,
            structuredTargetCats: [...structuredTargetCats],
            hasCoCreatorLineStartMention: routingExitHasCoCreatorLineStartMention,
          })
        ) {
          const result = await runRoutingGuardRemedial(storedContent, allRichBlocks, [...collectedToolEvents]);
          for (const event of result.streamEvents) yield event;
          await flushDeferredVoice();
          storedContent = result.storedContent;
          allRichBlocks = result.allRichBlocks;
          a2aMentions = result.a2aMentions;
          routingExitLineStartMentions = getRoutingExitLineStartMentions(a2aMentions);
          routingExitHasCoCreatorLineStartMention = result.hasCoCreatorLineStartMention;
          localCvoHasCoCreatorLineStartMention = result.hasLocalCoCreatorLineStartMention;

          if (
            !hasValidRoutingExit({
              lineStartMentions: routingExitLineStartMentions,
              toolNames: collectedToolNames,
              structuredTargetCats: [...structuredTargetCats],
              hasCoCreatorLineStartMention: routingExitHasCoCreatorLineStartMention,
            })
          ) {
            await appendRoutingGuardFailureNotice();
          }
        }
        a2aMentions = getLocalRoutingLineStartMentions(a2aMentions);

        // In play mode, CLI stream output (thinking) is hidden from other cats.
        // Only share previousResponses in debug mode, after guard remediation
        // finalizes storedContent for stream, persistence, and A2A prompts.
        if (!incrementalMode && thinkingMode === 'debug') {
          previousResponses.push({ catId, content: storedContent });
        }

        if (!routingGuardRemediated && initialTextStreamEvents.length > 0) {
          for (const event of initialTextStreamEvents) yield event;
          await flushDeferredVoice();
          initialTextStreamEvents.splice(0, initialTextStreamEvents.length);
        }

        // F167 Phase H AC-H3/H5 (KD-24): final routing slot validator.
        // Mechanical slot check with zero intent classifier. Runs BEFORE #417
        // inline-mention-hint and AC-C7 verdict warn; hit suppresses the system_info
        // emit on both (but keeps setMentionRoutingFeedback for next-turn correction).
        const phaseHRosterHandles: string[] = [];
        {
          const allCfg = catRegistry.getAllConfigs();
          for (const cfg of Object.values(allCfg) as CatConfig[]) {
            for (const pattern of cfg.mentionPatterns) phaseHRosterHandles.push(pattern);
          }
        }
        const phaseHResult = validateRoutingSyntax({
          text: storedContent,
          lineStartMentions: routingExitLineStartMentions,
          toolNames: collectedToolNames,
          structuredTargetCats: [...structuredTargetCats],
          rosterHandles: phaseHRosterHandles,
        });
        const phaseHHit = phaseHResult.kind === 'invalid_route_syntax';
        if (phaseHHit && phaseHResult.kind === 'invalid_route_syntax') {
          try {
            const inlineList = phaseHResult.inlineMentions.map((h) => `@${h}`).join(' ');
            const hintSource = {
              connector: 'routing-syntax-hint',
              label: '路由语法提醒',
              icon: '⚠️',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            };
            const stored = await deps.messageStore.append({
              userId: 'system',
              catId: null,
              threadId,
              content: `[路由语法]: ${inlineList} 写在行中不会触发路由 — 把 @句柄 移到最后一行行首独立一行即可。`,
              mentions: [],
              timestamp: Date.now(),
              source: hintSource,
            });
            if (deps.socketManager) {
              deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                threadId,
                message: {
                  id: stored.id,
                  type: 'connector',
                  content: stored.content,
                  source: hintSource,
                  timestamp: stored.timestamp,
                },
              });
            }
          } catch {
            /* non-blocking hint */
          }
        }

        // #417 / F064 AC-B3: Write-side feedback for inline action-like @mentions
        // clowder-ai#489: counters for detection, shadow, feedback, hint
        if (deps.invocationDeps.threadStore) {
          const {
            strictHits: inlineHits,
            shadowMisses,
            routedSetSkips,
          } = detectInlineActionMentionsWithShadow(storedContent, catId, a2aMentions);
          const agentAttr = { 'agent.id': catId as string };
          inlineActionChecked.add(1, agentAttr);
          if (inlineHits.length > 0) inlineActionDetected.add(inlineHits.length, agentAttr);
          if (shadowMisses.length > 0) inlineActionShadowMiss.add(shadowMisses.length, agentAttr);
          if (routedSetSkips > 0) inlineActionRoutedSetSkip.add(routedSetSkips, agentAttr);

          if (inlineHits.length > 0) {
            try {
              await deps.invocationDeps.threadStore.setMentionRoutingFeedback(threadId, catId, {
                sourceTimestamp: Date.now(),
                items: inlineHits.map((m) => ({ targetCatId: m.catId, reason: 'inline_action' as const })),
              });
              inlineActionFeedbackWritten.add(1, agentAttr);
              log.info(
                { catId: catId as string, threadId, targets: inlineHits.map((h) => h.catId) },
                'Inline action @mention detected — wrote routing feedback',
              );
            } catch {
              inlineActionFeedbackWriteFailed.add(1, agentAttr);
            }
            // #1062: User-visible system message when chain would break
            // (inline action detected but no line-start @ = no routing will happen)
            // F167 Phase H AC-H5: suppress this legacy hint when Phase H already emitted
            // routing-syntax-hint for the same turn (dedupe, single authoritative message).
            if (a2aMentions.length === 0 && !phaseHHit) {
              try {
                const targets = inlineHits.map((h) => `@${h.catId}`).join(', ');
                const hintSource = {
                  connector: 'inline-mention-hint',
                  label: '路由提示',
                  icon: '💡',
                  meta: { presentation: 'system_notice', noticeTone: 'info' },
                };
                const stored = await deps.messageStore.append({
                  userId: 'system',
                  catId: null,
                  threadId,
                  content: `想交接给 ${targets}？把它单独放到新起一行开头，才能触发交接。`,
                  mentions: [],
                  timestamp: Date.now(),
                  source: hintSource,
                });
                inlineActionHintEmitted.add(1, agentAttr);
                // Broadcast so frontend sees it in real-time (same pattern as vote result)
                if (deps.socketManager) {
                  deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                    threadId,
                    message: {
                      id: stored.id,
                      type: 'connector',
                      content: stored.content,
                      source: hintSource,
                      timestamp: stored.timestamp,
                    },
                  });
                }
              } catch {
                inlineActionHintEmitFailed.add(1, agentAttr);
              }
            }
          }
        }

        // F167 Phase H AC-H5: suppress AC-C7 verdict-without-pass when Phase H hit
        // (format error is the root cause; verdict-without-pass is the consequence).
        // 2026-04-25 fix (砚砚 GPT-5.5): pass hasCoCreatorLineStartMention so summary
        // reports ending with `@co-creator` / `@co-creator` (legitimate escalation to co-creator)
        // don't trigger the verdict-no-pass-hint false-positive. parseA2AMentions only
        // returns cat handles, never co-creator ones.
        //
        // C2 denominator (F192 2026-05-29): count every turn the verdict-without-pass
        // exit-check actually evaluates, so attribution can grade verdict_without_pass_count
        // against a real `c2.checked` base instead of fabricating a 100% ratio. phaseHHit
        // turns are excluded — a format error short-circuits the check (AC-H5), so they
        // were never evaluated.
        // C2 telemetry labels (F192 2026-06-03 build verdict): every C2 counter carries
        // `thread.system_kind` (the OTel label value behind `THREAD_SYSTEM_KIND`) so
        // attribution can distinguish eval-domain noise from real product-thread friction.
        // The verdict fire counters additionally carry `trigger` (`TRIGGER` semconv,
        // reusing the existing key — values are instrument-scoped) to spot keyword
        // overload — e.g. a `p1p2`-driven spike (review-discussion vocab) vs a `放行`-driven
        // one (real verdict-without-pass). All emitted attribute keys are in F152
        // metric-allowlist or the OTel SDK silently drops them (砚砚 PR #2058 R1 catch).
        const c2BaseAttr: Record<string, string> = {
          [AGENT_ID]: catId as string,
          [THREAD_SYSTEM_KIND]: routeThread?.systemKind ?? 'product',
        };
        if (!phaseHHit) {
          c2ExitChecked.add(1, c2BaseAttr);
        }
        // F192 Phase D — local R1 review P1-1 fix: capture trigger here, defer addEvent
        // emission until `storedMsgId` is bound to the CAT's verdict-bearing message
        // (line ~1625 / ~1680). The hint message appended below is NOT the original
        // verdict source — using its id as sample.messageId would land drilldown on
        // the hint text, not the cat's output that triggered detection.
        let pendingC2SampleTrigger: string | null = null;
        if (
          !phaseHHit &&
          // #949 P2: Use dedicated verdictPassWarningEnabled flag (not frustrationAutoIssueEligible)
          // to suppress verdict-without-pass warning ONLY for connector-sourced flows
          // (MR reviews, CI notifications). A2A/multi-mention callbacks set
          // frustrationAutoIssueEligible=false but still need verdict-pass handoff guards.
          options.verdictPassWarningEnabled !== false &&
          shouldWarnVerdictWithoutPass({
            text: storedContent,
            lineStartMentions: routingExitLineStartMentions,
            toolNames: collectedToolNames,
            structuredTargetCats: [...structuredTargetCats],
            hasCoCreatorLineStartMention: routingExitHasCoCreatorLineStartMention,
          })
        ) {
          try {
            const hintSource = {
              connector: 'verdict-no-pass-hint',
              label: '球权提醒',
              icon: '🏓',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            };
            const stored = await deps.messageStore.append({
              userId: 'system',
              catId: null,
              threadId,
              content: '[球权提醒]: 结论后直接传球，不要停在结论 — 末尾加一行行首 @句柄 或调用 `cat_cafe_hold_ball`。',
              mentions: [],
              timestamp: Date.now(),
              source: hintSource,
            });
            const verdictFireAttr: Record<string, string> = {
              ...c2BaseAttr,
              [TRIGGER]: detectMatchedVerdictKeyword(storedContent) ?? 'unknown',
            };
            c2VerdictHintEmitted.add(1, verdictFireAttr);
            c2VerdictWithoutPassCount.add(1, verdictFireAttr);
            // F192 Phase D — capture trigger for deferred sample emission. The actual
            // addEvent fires after `storedMsgId` is bound to the cat's verdict message
            // (post-storage block) so drilldown lands on real content, not on this hint.
            pendingC2SampleTrigger = verdictFireAttr[TRIGGER] as string;
            if (deps.socketManager) {
              deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                threadId,
                message: {
                  id: stored.id,
                  type: 'connector',
                  content: stored.content,
                  source: hintSource,
                  timestamp: stored.timestamp,
                },
              });
            }
          } catch {
            /* non-blocking hint */
          }
        }

        // F167 Phase I AC-I1 (KD-25): void hold detection — text says "持球" but
        // no cat_cafe_hold_ball tool call this turn.声明-动作一致性 check.
        // C2 void-hold denominator (PR #1941 P2): count every void-hold evaluation so
        // attribution grades void_hold_hint against c2.void_hold_checked, NOT the
        // verdict-check count c2.checked (different guard → wrong ratio / suppression).
        c2VoidHoldChecked.add(1, c2BaseAttr);
        // F192 Phase D — eval:a2a 2026-06-10 build verdict: capture matched HOLD_PATTERN
        // id as trigger for deferred sample emission. Same pattern as verdict-without-pass:
        // addEvent fires in the post-storage block once `storedMsgId` is bound to the cat's
        // hold-claim message, so drilldown lands on the original content, not on the hint.
        let pendingC2VoidHoldSampleTrigger: string | null = null;
        const voidHoldEval = evaluateVoidHold({
          text: storedContent,
          toolNames: collectedToolNames,
          lineStartMentions: routingExitLineStartMentions,
          structuredTargetCats: [...structuredTargetCats],
          hasCoCreatorLineStartMention: routingExitHasCoCreatorLineStartMention,
        });
        if (voidHoldEval.shouldEmit) {
          try {
            const hintSource = {
              connector: 'void-hold-hint',
              label: '持球提醒',
              icon: '🏓',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            };
            const voidStored = await deps.messageStore.append({
              userId: 'system',
              catId: null,
              threadId,
              content:
                '[持球提醒]: 检测到持球声明但未调用 hold_ball MCP — ' +
                '文字声明不会设定唤醒计时器，请调用 `cat_cafe_hold_ball` 完成持球或改为传球。',
              mentions: [],
              timestamp: Date.now(),
              source: hintSource,
            });
            const voidHoldFireAttr: Record<string, string> = {
              ...c2BaseAttr,
              [TRIGGER]: voidHoldEval.matchedPattern ?? 'unknown',
            };
            c2VoidHoldHintEmitted.add(1, voidHoldFireAttr);
            // F192 Phase D — capture trigger for deferred sample event emission.
            pendingC2VoidHoldSampleTrigger = voidHoldFireAttr[TRIGGER] as string;
            if (deps.socketManager) {
              deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                threadId,
                message: {
                  id: voidStored.id,
                  type: 'connector',
                  content: voidStored.content,
                  source: hintSource,
                  timestamp: voidStored.timestamp,
                },
              });
            }
          } catch {
            /* non-blocking hint */
          }
        }

        // F079 Phase 2: Vote interception — extract [VOTE:xxx] from cat response
        const votedOption = extractVoteFromText(storedContent);
        if (votedOption && deps.invocationDeps.threadStore) {
          try {
            const voteState = await deps.invocationDeps.threadStore.getVotingState(threadId);
            if (voteState && voteState.status === 'active' && voteState.options.includes(votedOption)) {
              // Deadline enforcement (parity with HTTP cast path)
              if (Date.now() > voteState.deadline) {
                log.info({ threadId, votedOption }, 'Vote expired, ignoring');
              } else if (
                voteState.voters &&
                voteState.voters.length > 0 &&
                !voteState.voters.includes(catId as string) &&
                (catId as string) !== voteState.initiatedByCat
              ) {
                log.info({ catId: catId as string, threadId }, 'Not in voters list, ignoring vote');
              } else {
                voteState.votes[catId as string] = votedOption;
                await deps.invocationDeps.threadStore.updateVotingState(threadId, voteState);
                log.info({ catId: catId as string, votedOption, threadId }, 'Vote cast');

                // Auto-close if all designated voters have voted
                if (checkVoteCompletion(voteState)) {
                  const tally = buildVoteTally(voteState.options, voteState.votes);
                  const totalVotes = Object.values(voteState.votes).length;
                  const fields = voteState.options.map((opt) => ({
                    label: opt,
                    value: `${tally[opt] ?? 0} 票 (${totalVotes > 0 ? Math.round(((tally[opt] ?? 0) / totalVotes) * 100) : 0}%)`,
                  }));
                  const richBlock = {
                    id: `vote-${Date.now()}`,
                    kind: 'card' as const,
                    v: 1 as const,
                    title: `投票结果: ${voteState.question}`,
                    bodyMarkdown: voteState.anonymous ? `匿名投票 · ${totalVotes} 票` : `实名投票 · ${totalVotes} 票`,
                    tone: 'info' as const,
                    fields,
                  };
                  await deps.invocationDeps.threadStore.updateVotingState(threadId, null);
                  // F079 Bug 1 fix: do NOT push richBlock into allRichBlocks — that
                  // embeds the result in the cat's own message, causing duplication.
                  // Only the standalone connector message below should carry the result.
                  // Gap 3: persist separate connector message for ConnectorBubble rendering
                  try {
                    const stored = await deps.messageStore.append({
                      userId,
                      catId: null,
                      content: `投票结果: ${voteState.question}`,
                      mentions: [],
                      timestamp: Date.now(),
                      threadId,
                      source: VOTE_RESULT_SOURCE,
                      extra: { rich: { v: 1 as const, blocks: [richBlock] } },
                    });
                    // F079 Bug 2 fix: broadcast connector_message so frontend updates without F5
                    if (deps.socketManager) {
                      deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                        threadId,
                        message: {
                          id: stored.id,
                          type: 'connector',
                          content: stored.content,
                          source: VOTE_RESULT_SOURCE,
                          timestamp: stored.timestamp,
                          extra: stored.extra,
                        },
                      });
                    }
                  } catch (persistErr) {
                    log.warn({ threadId, err: persistErr }, 'Failed to persist vote connector message');
                  }
                  log.info({ threadId }, 'Vote auto-closed');
                }
              }
            }
          } catch (voteErr) {
            log.warn({ catId: catId as string, err: voteErr }, 'Vote interception failed');
          }
        }

        const storedTimestamp = invocationStartedAt;

        // F061: Detect local @co-creator mentions for browser/unread notification.
        // Cross-post callbacks can satisfy the guard and emit target-thread operator, but must not
        // create a source-thread unread/user notification.
        mentionsUser = Boolean(
          (storedContent ? detectUserMention(storedContent) : false) || localCvoHasCoCreatorLineStartMention,
        );

        // #573: skip stream store only when callback confirmed persistence (not just invocation)
        const callbackAlreadyStored = callbackPostConfirmed;

        // Store with actual mentions — degrade on failure to ensure done reaches frontend
        // (缅因猫 review P1-2: Redis failure must not block done yield)
        let storedMsgId: string | undefined;
        let triagePlanIdsToLink: string[] = [];
        try {
          // #573: persist with the OUTER cat-cafe parentInvocationId (set by QueueProcessor)
          const persistedInvocationId = options.parentInvocationId ?? ownInvocationId;
          // F229 KD-17: Post-process concierge reply — inject CardBlock actions from HandleMap markers
          if (
            'conciergeConfig' in conciergeCtx &&
            conciergeContextForCat(conciergeCtx, catId as string)?.conciergeConfig &&
            deps.invocationDeps.conciergeHandleMapStore &&
            storedContent
          ) {
            try {
              // Phase B: pass triageDeps if TriagePlanStore is available
              const triageDeps: TriagePlanExtractionDeps | undefined = deps.invocationDeps.conciergeTriagePlanStore
                ? {
                    triagePlanStore: deps.invocationDeps.conciergeTriagePlanStore,
                    userId,
                    sourceMessageId: currentUserMessageId ?? `triage-${Date.now()}`,
                    ...(deps.invocationDeps.threadStore
                      ? {
                          targetCatsResolverDeps: {
                            messageStore: deps.messageStore,
                            threadStore: deps.invocationDeps.threadStore,
                          },
                        }
                      : {}),
                  }
                : undefined;
              const conciergeActions = await buildConciergeActions(
                storedContent,
                threadId,
                deps.invocationDeps.conciergeHandleMapStore,
                triageDeps,
              );
              triagePlanIdsToLink = extractTriagePlanIdsFromActions(conciergeActions);
              if (conciergeActions.length > 0) {
                allRichBlocks = [
                  ...allRichBlocks,
                  {
                    kind: 'card' as const,
                    v: 1 as const,
                    id: `concierge-actions-${Date.now()}`,
                    title: '',
                    actions: conciergeActions,
                  },
                ];
                // Strip <!-- triage-plan --> markers from stored content (cloud P2 fix).
                // Users should not see raw HTML comment markers in the concierge panel.
                if (triagePlanIdsToLink.length > 0) {
                  storedContent = stripTriagePlanMarkers(storedContent);
                }
              }
            } catch {
              // Fail-open: action extraction failure → no actions, no crash
            }
          }

          if (!callbackAlreadyStored) {
            const storedMsg = await deps.messageStore.append({
              userId,
              catId,
              content: storedContent,
              mentions: a2aMentions,
              origin: 'stream',
              timestamp: storedTimestamp,
              threadId,
              ...(mentionsUser ? { mentionsUser } : {}),
              ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
              ...(firstMetadata ? { metadata: firstMetadata } : {}),
              ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              extra: {
                ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
                // F194 Phase Z3: dual id — invocationId=parent (legacy SoT for liveness/queue/cancel),
                // turnInvocationId=own (Z3 new SoT for frontend bubble identity stable key, prevents
                // same-parent multi-turn-same-cat bubble merge).
                // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId.
                // First-in-chain (ownInvocationId === parent) still gets explicit
                // turn stamp so frontend bubble identity never falls back to parent
                // (which would let multi-turn same-cat under same parent collapse).
                ...(persistedInvocationId
                  ? {
                      stream: {
                        invocationId: persistedInvocationId,
                        turnInvocationId: ownInvocationId ?? persistedInvocationId,
                      },
                    }
                  : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              },
            });
            storedMsgId = storedMsg.id;
            const triagePlanStore = deps.invocationDeps.conciergeTriagePlanStore;
            if (triagePlanStore && triagePlanIdsToLink.length > 0) {
              try {
                await Promise.all(
                  triagePlanIdsToLink.map((planId) => triagePlanStore.setConfirmationMessageId(planId, storedMsg.id)),
                );
              } catch (err) {
                log.warn({ err, threadId, messageId: storedMsg.id }, 'Failed to link triage plan confirmation message');
              }
            }
            // F088-P3: Stash rich blocks for outbound delivery
            if (options.persistenceContext && allRichBlocks.length > 0) {
              options.persistenceContext.richBlocks = allRichBlocks;
            }
          } else {
            log.info(
              { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId },
              'Stream store skipped — cat_cafe_post_message callback already persisted',
            );
            const callbackTriagePlanStore = deps.invocationDeps.conciergeTriagePlanStore;
            const linkedCallbackMessageId = callbackPostMessageId;
            if (linkedCallbackMessageId && callbackTriagePlanStore && triagePlanIdsToLink.length > 0) {
              try {
                await Promise.all(
                  triagePlanIdsToLink.map((planId) =>
                    callbackTriagePlanStore.setConfirmationMessageId(planId, linkedCallbackMessageId),
                  ),
                );
              } catch (err) {
                log.warn(
                  { err, threadId, messageId: linkedCallbackMessageId },
                  'Failed to link callback triage plan confirmation message',
                );
              }
            }
            if (callbackPostMessageId) {
              // F192 Phase D: bind sample anchor in callback path so post-storage
              // emission uses the actual cat-stored message id (via callback).
              storedMsgId = callbackPostMessageId;
              const metadataPatch: StreamMetadataAugmentInput = {
                ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                ...(firstMetadata ? { metadata: firstMetadata } : {}),
                ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
                ...(mentionsUser ? { mentionsUser } : {}),
              };
              const extraParts = {
                ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
                // F194 Phase Z3: dual id — invocationId=parent (legacy SoT for liveness/queue/cancel),
                // turnInvocationId=own (Z3 new SoT for frontend bubble identity stable key, prevents
                // same-parent multi-turn-same-cat bubble merge).
                // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId.
                // First-in-chain (ownInvocationId === parent) still gets explicit
                // turn stamp so frontend bubble identity never falls back to parent
                // (which would let multi-turn same-cat under same parent collapse).
                ...(persistedInvocationId
                  ? {
                      stream: {
                        invocationId: persistedInvocationId,
                        turnInvocationId: ownInvocationId ?? persistedInvocationId,
                      },
                    }
                  : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              };
              if (Object.keys(extraParts).length > 0) metadataPatch.extra = extraParts;

              if (hasStreamMetadataPatch(metadataPatch)) {
                try {
                  const augmented = await deps.messageStore.augmentStreamMetadata(callbackPostMessageId, metadataPatch);
                  if (!augmented) {
                    log.warn(
                      { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId },
                      'Callback message metadata augment skipped: message not found',
                    );
                  }
                } catch (augmentErr) {
                  log.warn(
                    { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId, err: augmentErr },
                    'Callback message metadata augment failed; continuing without duplicate stream append',
                  );
                }
              }
            }
          }
          // #80: Clean up draft after message is persisted (either via append or callback)
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
          // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
          if (deps.invocationDeps.threadStore) {
            try {
              await deps.invocationDeps.threadStore.updateParticipantActivity(
                threadId,
                catId,
                // #267: only errors before abort are provider failures
                !hadProviderError,
              );
            } catch (activityErr) {
              log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
            }
          }
          if (!callbackAlreadyStored && localCvoHasCoCreatorLineStartMention && storedMsgId) {
            emitBallHandedCvoOnce(storedMsgId);
          }
          // F192 Phase D — deferred per-fire sample emission (local R1 P1-1 fix +
          // cloud R1 P1 fix: use dedicated sample span instead of getActiveSpan).
          //
          // Why a fresh span and not `invocationSpanRef.current.addEvent(...)`:
          // invokeSingleCat ends the cat invocation span in its `finally` once the
          // generator closes. By the time control reaches here (post-storage, outside
          // the for-await loop), the cat invocation span is ended — `.addEvent()` on
          // an ended span is a silent no-op in the OTel JS SDK and the sample would
          // be dropped despite the counter incrementing. A short-lived marker span
          // parented to a still-open span (route span first, falling back to the
          // ended invocation span as parent ref only) guarantees the event reaches
          // LocalTraceStore via RedactingSpanProcessor (which HMACs IDs per the
          // 782b346d0 events-redaction fix).
          if (pendingC2SampleTrigger !== null && storedMsgId) {
            try {
              const parentSpan = options.routeSpan ?? invocationSpanRef.current;
              const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
              const sampleSpan = trace
                .getTracer('cat-cafe-api', '0.1.0')
                .startSpan('cat_cafe.a2a.c2.verdict_without_pass_sample', undefined, parentCtx);
              sampleSpan.addEvent('c2.verdict_without_pass_fired', {
                messageId: storedMsgId,
                invocationId: ownInvocationId ?? 'unknown',
                threadId,
                [AGENT_ID]: catId as string,
                [THREAD_SYSTEM_KIND]: routeThread?.systemKind ?? 'product',
                [TRIGGER]: pendingC2SampleTrigger,
              });
              sampleSpan.end();
            } catch {
              /* best-effort sample emission */
            }
          }
          // F192 Phase D — eval:a2a 2026-06-10 build verdict: parallel per-fire sample
          // for void_hold_hint fires. Same span/event discipline as verdict-without-pass:
          // marker span parented to still-open route/invocation span so RedactingSpanProcessor
          // HMACs the raw IDs (Class C) before they reach LocalTraceStore.
          // Independent of the verdict sample emission above — both can fire on the same
          // turn if the cat both gave a verdict AND text-claimed a hold without tool call.
          if (pendingC2VoidHoldSampleTrigger !== null && storedMsgId) {
            try {
              const parentSpan = options.routeSpan ?? invocationSpanRef.current;
              const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
              const sampleSpan = trace
                .getTracer('cat-cafe-api', '0.1.0')
                .startSpan('cat_cafe.a2a.c2.void_hold_sample', undefined, parentCtx);
              sampleSpan.addEvent('c2.void_hold_fired', {
                messageId: storedMsgId,
                invocationId: ownInvocationId ?? 'unknown',
                threadId,
                [AGENT_ID]: catId as string,
                [THREAD_SYSTEM_KIND]: routeThread?.systemKind ?? 'product',
                [TRIGGER]: pendingC2VoidHoldSampleTrigger,
              });
              sampleSpan.end();
            } catch {
              /* best-effort sample emission */
            }
            // F233 Phase B (B2): 同一虚空传球旁路写 ball.void_pass（storedMsgId 此时已绑定）
            emitBallVoidPass(deps.ballCustody, threadId, storedMsgId, pendingC2VoidHoldSampleTrigger);
          }
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append failed, degrading');
          if (options.persistenceContext) {
            options.persistenceContext.failed = true;
            options.persistenceContext.errors.push({
              catId: catId as string,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (invocationSpanRef.current) catInvocationSpans.set(index, invocationSpanRef.current);

        // A2A: extend worklist if mention found + depth allows + queue fairness gate
        // F27: dedup only against pending (not-yet-executed) tail — cats that already ran
        // can be re-enqueued for another round (e.g. A→B→A review ping-pong).
        let queuedMessagesPending = false;
        if (queueHasQueuedMessages) {
          try {
            queuedMessagesPending = queueHasQueuedMessages(threadId);
          } catch {
            queuedMessagesPending = false;
          }
        }

        // Diagnostic: log when A2A text-scan gate blocks
        if (a2aMentions.length > 0) {
          if (queuedMessagesPending) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount },
              'A2A text-scan blocked: non-agent messages pending in queue (fairness gate)',
            );
          } else if (worklistEntry.a2aCount >= maxDepth) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount, maxDepth },
              'A2A text-scan blocked: depth limit reached',
            );
          } else if (catSignal?.aborted) {
            log.info({ threadId, catId, a2aMentions }, 'A2A text-scan blocked: signal aborted');
          }
        }

        if (
          a2aMentions.length > 0 &&
          worklistEntry.a2aCount < maxDepth &&
          !catSignal?.aborted &&
          !queuedMessagesPending
        ) {
          // F153: mention_dispatch span — tracks the causal link between mentioner and dispatched targets
          let dispatchSpan: Span | undefined;
          const pendingTail = worklist.slice(index + 1);
          const pendingOriginalTargets = targetCats.slice(index + 1);
          // F216 c1.3 + P1-2 (砚砚 review): route each mentioned cat through the pure
          // resolveRoutingDecisions function (unifies the depth/dedup/pendingTail/streak/fairness guards
          // that used to be inline here + duplicated in the relay path). Resolve+apply ONE cat at a time
          // so each target's decision observes the prior targets' mutations (a2aCount++ and streak
          // update) — matching the original sequential semantics. A single batch resolve would freeze
          // every target's streak peek against the pre-loop streakPair: e.g. "@gemini @codex" with a hot
          // opus<->codex streak would wrongly block @codex even though processing @gemini first resets
          // the pair. The decision layer PEEKS streak read-only; this execution layer does the real
          // updateStreakOnPush mutation + worklist.push + span + yield (砚砚 OQ3: side effects stay here).
          // callerActivity is loop-invariant (same for every target this turn) → hoist once.
          const hadSubstantiveToolCall = collectedToolNames.some((n) => isSubstantiveTool(n));
          for (const nextCat of a2aMentions) {
            const [decision] = resolveRoutingDecisions(
              { type: 'inline_mention', cats: [nextCat], content: storedContent, callerCatId: catId },
              {
                a2aCount: worklistEntry.a2aCount,
                maxDepth,
                aborted: Boolean(catSignal?.aborted),
                queuedMessagesPending,
                pendingTail,
                pendingOriginalTargets,
                hasActiveAgent: (c) => Boolean(hasQueuedOrActiveAgentForCat?.(threadId, c)),
                peekStreak: (target) =>
                  peekStreakOnPush(worklistEntry, catId, target, {
                    hadSubstantiveToolCall,
                    outputLength: storedContent.length,
                  }),
              },
            );
            if (!decision) continue; // pending original target → replies to user, no decision emitted
            if (decision.action === 'skip') {
              if (decision.reason === 'dedup_active') {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId },
                  'A2A text-scan dedup: cat actively processing in InvocationQueue, skipping',
                );
              }
              continue;
            }
            if (decision.action === 'mark_replyto') {
              // pendingTail hit (non-original target): bind reply metadata, don't push again.
              worklistEntry.a2aFrom.set(nextCat, catId);
              // F121: response-text path — set trigger message for auto-replyTo
              if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
              continue;
            }
            // enqueue_worklist | block_pingpong both reached the streak gate in the legacy code, so the
            // real (mutating) updateStreakOnPush must run exactly once here for either — peek above was
            // read-only prediction; this is the canonical mutation point (parity guaranteed by c1.1).
            // F167 L1 + Phase D: callerActivity gates streak accumulation; streak>=4 inertia → block.
            const streak = updateStreakOnPush(worklistEntry, catId, nextCat, {
              hadSubstantiveToolCall,
              outputLength: storedContent.length,
            });
            if (decision.action === 'block_pingpong') {
              log.info(
                { threadId, catId: nextCat, fromCat: catId, count: streak.count },
                'F167 L1: A2A ping-pong terminated (streak >= 4)',
              );
              yield {
                type: 'system_info' as AgentMessageType,
                catId,
                content: JSON.stringify({
                  type: 'a2a_pingpong_terminated',
                  fromCatId: catId,
                  targetCatId: nextCat,
                  pairCount: streak.count,
                }),
                timestamp: Date.now(),
              } as AgentMessage;
              continue;
            }

            // decision.action === 'enqueue_worklist'
            // F153: lazily create mention_dispatch span on first actual push
            if (!dispatchSpan) {
              const mentionerSpan = catInvocationSpans.get(index);
              if (mentionerSpan) {
                const parentCtx = trace.setSpan(context.active(), mentionerSpan);
                dispatchSpan = routeSerialTracer.startSpan(
                  'cat_cafe.mention_dispatch',
                  {
                    attributes: { [AGENT_ID]: catId as string, 'dispatch.target_count': a2aMentions.length },
                  },
                  parentCtx,
                );
                // F153 Phase I: counter for Step Summary aggregate; only AGENT_ID attribute (mentioner cat).
                a2aDispatchCount.add(1, { [AGENT_ID]: catId as string });
              }
            }

            worklist.push(nextCat);
            worklistEntry.a2aCount++;
            pendingTail.push(nextCat); // Keep dedup view in sync
            worklistEntry.a2aFrom.set(nextCat, catId);
            // F121: response-text path — set trigger message for auto-replyTo
            if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
            // F153: record mention parent span for dispatched target
            if (dispatchSpan) mentionParentSpan.set(worklist.length - 1, dispatchSpan);
          }
          // F153: end or defer dispatch span based on child execution
          if (dispatchSpan) {
            let maxChildIdx = -1;
            for (const [idx, s] of mentionParentSpan) {
              if (s === dispatchSpan && idx > maxChildIdx) maxChildIdx = idx;
            }
            if (maxChildIdx > index) {
              pendingDispatchSpans.push({ span: dispatchSpan, lastChildIndex: maxChildIdx });
            } else {
              dispatchSpan.end();
            }
          }
        } else if (a2aMentions.length > 0 && catSignal?.aborted && deferA2AEnqueue) {
          // #813 fix: When invocation is aborted (e.g., after context seal), defer @mentions
          // to the queue instead of silently dropping them. This ensures handoff continuity
          // even when the cat's invocation was interrupted after writing a line-start @mention.
          //
          // P2 gate: Do NOT recover for user-initiated cancellations (user_cancel / cancel_all).
          // The user explicitly stopped the flow — enqueueing autoExecute A2A work afterward
          // would contradict their intent and run work they tried to stop.
          const abortReason = catSignal.reason;
          const isUserInitiatedAbort = abortReason === 'user_cancel' || abortReason === 'cancel_all';
          if (isUserInitiatedAbort) {
            log.info(
              { threadId, catId, abortReason, mentionCount: a2aMentions.length },
              '#813: A2A abort-recovery suppressed — user-initiated cancellation',
            );
          } else {
            for (const nextCat of a2aMentions) {
              if (worklistEntry.a2aCount >= maxDepth) {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId, a2aCount: worklistEntry.a2aCount, maxDepth },
                  'A2A abort-recovery blocked: depth limit reached',
                );
                continue;
              }
              // P2: dedup — skip if target cat already has queued/active work
              // (same guard the inline and fairness-gate paths apply via
              // resolveRoutingDecisions → hasActiveAgent). Without this, a
              // seal-recovery enqueue could duplicate an earlier same-turn handoff.
              if (hasQueuedOrActiveAgentForCat?.(threadId, nextCat)) {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId },
                  '#813: A2A abort-recovery skipped — target already queued/active',
                );
                continue;
              }
              deferA2AEnqueue({
                threadId,
                userId,
                content: storedContent,
                source: 'agent',
                sourceCategory: 'a2a',
                targetCats: [nextCat],
                callerCatId: catId,
                messageId: storedMsgId,
                a2aTriggerMessageId: storedMsgId,
                autoExecute: true,
                priority: 'normal',
                intent: 'execute',
              });
              worklistEntry.a2aCount++;
              log.info(
                { threadId, catId: nextCat, fromCat: catId },
                '#813: A2A mention recovered after signal abort — deferred to queue',
              );
            }
          }
        } else if (a2aMentions.length > 0 && queuedMessagesPending && deferA2AEnqueue && !catSignal?.aborted) {
          // F216 c2: deferred enqueue via the unified resolveRoutingDecisions decision layer.
          // Same guard chain as inline (depth/dedup/pendingTail/streak) but ctx.queuedMessagesPending=true
          // makes the LAST gate return defer_queue instead of enqueue_worklist. Resolve+apply ONE cat at a
          // time (NOT batch) so each target's decision observes prior targets' a2aCount++ and streak
          // mutations — same per-target ordering fix as the inline path (砚砚 P1-2: a batch resolve would
          // freeze every peekStreak against the pre-loop streakPair and mis-block later targets).
          // F185 Phase B: deferred enqueue preserves A2A handoff behind non-agent entries.
          const pendingTailDeferred = worklist.slice(index + 1);
          const pendingOriginalTargetsDeferred = targetCats.slice(index + 1);
          const hadSubstantiveToolCallDeferred = collectedToolNames.some((n) => isSubstantiveTool(n));
          // F153 Phase I: lazy mention_dispatch span for deferred path. End span immediately because the
          // child route runs through QueueProcessor in a separate loop; the captured trace context is
          // propagated via entry.callerTraceContext so the dispatched route parents under this span.
          let deferredDispatchCtx: CallerTraceContext | undefined;
          for (const nextCat of a2aMentions) {
            const [decision] = resolveRoutingDecisions(
              { type: 'deferred', cats: [nextCat], content: storedContent, callerCatId: catId },
              {
                a2aCount: worklistEntry.a2aCount,
                maxDepth,
                aborted: Boolean(catSignal?.aborted),
                queuedMessagesPending: true,
                pendingTail: pendingTailDeferred,
                pendingOriginalTargets: pendingOriginalTargetsDeferred,
                hasActiveAgent: (c) => Boolean(hasQueuedOrActiveAgentForCat?.(threadId, c)),
                peekStreak: (target) =>
                  peekStreakOnPush(worklistEntry, catId, target, {
                    hadSubstantiveToolCall: hadSubstantiveToolCallDeferred,
                    outputLength: storedContent.length,
                  }),
              },
            );
            if (!decision) continue; // pending original target → replies to user, no decision
            if (decision.action === 'skip') {
              if (decision.reason === 'dedup_active') {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId },
                  'A2A text-scan dedup (deferred): cat actively processing, skipping',
                );
              }
              continue;
            }
            if (decision.action === 'mark_replyto') {
              // pendingTail hit (non-original target): rebind reply metadata, don't enqueue again.
              worklistEntry.a2aFrom.set(nextCat, catId);
              if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
              continue;
            }
            // defer_queue | block_pingpong both passed the peek gate, so the real (mutating)
            // updateStreakOnPush runs exactly once here for either (parity with inline c1.3 + c1.1).
            const streakDeferred = updateStreakOnPush(worklistEntry, catId, nextCat, {
              hadSubstantiveToolCall: hadSubstantiveToolCallDeferred,
              outputLength: storedContent.length,
            });
            if (decision.action === 'block_pingpong') {
              log.info(
                { threadId, catId: nextCat, fromCat: catId, count: streakDeferred.count },
                'F167 L1: A2A ping-pong terminated in deferred path (streak >= 4)',
              );
              yield {
                type: 'system_info' as AgentMessageType,
                catId,
                content: JSON.stringify({
                  type: 'a2a_pingpong_terminated',
                  fromCatId: catId,
                  targetCatId: nextCat,
                  pairCount: streakDeferred.count,
                }),
                timestamp: Date.now(),
              } as AgentMessage;
              continue;
            }
            // decision.action === 'defer_queue'
            // F153 Phase I: create dispatch span on first real enqueue and capture its trace
            // context for cross-route causality.
            if (!deferredDispatchCtx) {
              const mentionerSpan = catInvocationSpans.get(index);
              if (mentionerSpan) {
                const parentCtx = trace.setSpan(context.active(), mentionerSpan);
                const dSpan = routeSerialTracer.startSpan(
                  'cat_cafe.mention_dispatch',
                  {
                    attributes: {
                      [AGENT_ID]: catId as string,
                      'dispatch.target_count': a2aMentions.length,
                      'dispatch.source': 'text-scan-deferred',
                    },
                  },
                  parentCtx,
                );
                a2aDispatchCount.add(1, { [AGENT_ID]: catId as string });
                const sc = dSpan.spanContext();
                dSpan.end();
                deferredDispatchCtx = {
                  traceId: sc.traceId,
                  spanId: sc.spanId,
                  traceFlags: sc.traceFlags,
                };
              }
            }
            deferA2AEnqueue({
              threadId,
              userId,
              content: storedContent,
              source: 'agent',
              sourceCategory: 'a2a',
              targetCats: [nextCat],
              callerCatId: catId,
              messageId: storedMsgId,
              a2aTriggerMessageId: storedMsgId,
              autoExecute: true,
              priority: 'normal',
              intent: 'execute',
              ...(deferredDispatchCtx ? { callerTraceContext: deferredDispatchCtx } : {}),
            });
            worklistEntry.a2aCount++;
            log.info(
              { threadId, catId: nextCat, fromCat: catId },
              'A2A text-scan deferred: enqueued behind non-agent entries (F185-B)',
            );
          }
        }

        // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
        // We track which targets have already been announced to avoid duplicate handoff events.
        for (let wi = handoffEmitted; wi < worklist.length; wi++) {
          const pendingCat = worklist[wi]!;
          if (wi < targetCats.length) continue; // Skip original targets — not A2A

          // === A2A_HANDOFF 审计 (fire-and-forget, 缅因猫 review P2-3) ===
          const auditLog = getEventAuditLog();
          auditLog
            .append({
              type: AuditEventTypes.A2A_HANDOFF,
              threadId,
              data: {
                fromCat: catId,
                toCat: pendingCat,
                userId,
                a2aDepth: worklistEntry.a2aCount,
                maxDepth,
              },
            })
            .catch((err) => {
              log.warn({ threadId, fromCat: catId, toCat: pendingCat, err }, 'A2A_HANDOFF audit write failed');
            });

          // F233 P1 (云端 review): ball.handed 已移到 worklist 主循环接球时刻统一 emit（覆盖 original +
          // A2A），此处不再 emit——这里只是 A2A handoff 发射点（球离开前手），A2A target 真正接球在主循环。
          const nextConfig: CatConfig | undefined = catRegistry.tryGet(pendingCat as string)?.config;
          if (options.invocationController && options.trackA2ASlot && !activeTrackedA2ASlots.has(pendingCat)) {
            options.trackA2ASlot(threadId, pendingCat, userId, options.invocationController);
            activeTrackedA2ASlots.add(pendingCat);
          }
          yield {
            type: 'a2a_handoff' as AgentMessageType,
            catId,
            content: formatA2AHandoffContent(catId, pendingCat, catConfig, nextConfig),
            invocationId: ownInvocationId,
            targetCatId: pendingCat,
            timestamp: Date.now(),
          } as AgentMessage;
        }
        handoffEmitted = worklist.length;
      } else if (!hadError) {
        // No text content and no error.
        // Persist only when we have non-text payload (tool/thinking/rich).
        // Purely empty turns should not create blank chat bubbles.
        if (!routingGuardRemediated && initialTextStreamEvents.length > 0) {
          for (const event of initialTextStreamEvents) yield event;
          initialTextStreamEvents.splice(0, initialTextStreamEvents.length);
        }

        const noTextBlocks = noTextBlocksOverride ?? [...bufferedBlocks, ...streamRichBlocks];
        const hasRichBlocks = noTextBlocks.length > 0;
        const shouldPersistNoTextMessage =
          hasRichBlocks ||
          collectedToolEvents.length > 0 ||
          Boolean(renderThinkingChunks(thinkingChunks).trim().length > 0);
        const shouldEmitSilentCompletion = collectedToolEvents.length > 0 && !hasRichBlocks && !sawUserFacingSystemInfo;

        log.debug(
          {
            catId: catId as string,
            threadId,
            hasRichBlocks,
            sawUserFacingSystemInfo,
            toolCount: collectedToolEvents.length,
            shouldPersist: shouldPersistNoTextMessage,
            thinkingLen: renderThinkingChunks(thinkingChunks).length,
          },
          'Cat produced no text — evaluating silent_completion',
        );
        // Diagnostic: if cat ran tools but produced no text, emit a system_info so the
        // user sees *something* instead of a silent vanish (bugfix: silent-exit P1).
        if (shouldEmitSilentCompletion) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: JSON.stringify({
              type: 'silent_completion',
              detail: `${catConfig?.displayName ?? (catId as string)} completed with tool calls but no text response.`,
              toolCount: collectedToolEvents.length,
            }),
            timestamp: Date.now(),
          } as AgentMessage;
        }
        if (shouldPersistNoTextMessage || sawUserFacingSystemInfo || shouldEmitSilentCompletion) {
          catProducedOutput = true;
        }

        if (shouldPersistNoTextMessage) {
          try {
            await deps.messageStore.append({
              userId,
              catId,
              content: '',
              mentions: [],
              origin: 'stream',
              timestamp: invocationStartedAt,
              threadId,
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
              ...(firstMetadata ? { metadata: firstMetadata } : {}),
              ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
              extra: {
                ...(noTextBlocks.length > 0 ? { rich: { v: 1 as const, blocks: noTextBlocks } } : {}),
                // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId
                // (= ownInvocationId, else parent fallback).
                ...((options.parentInvocationId ?? ownInvocationId)
                  ? {
                      stream: {
                        invocationId: (options.parentInvocationId ?? ownInvocationId) as string,
                        turnInvocationId: (ownInvocationId ?? options.parentInvocationId) as string,
                      },
                    }
                  : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              },
            });
            // F088-P3: Stash rich blocks for outbound delivery (no-text branch)
            if (options.persistenceContext && noTextBlocks.length > 0) {
              options.persistenceContext.richBlocks = [
                ...(options.persistenceContext.richBlocks ?? []),
                ...noTextBlocks,
              ];
            }
            // #80: Clean up draft only after successful append
            if (deps.draftStore && ownInvocationId) {
              deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
            }
            // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
            if (deps.invocationDeps.threadStore) {
              try {
                await deps.invocationDeps.threadStore.updateParticipantActivity(
                  threadId,
                  catId,
                  // #267: only errors before abort are provider failures
                  !hadProviderError,
                );
              } catch (activityErr) {
                log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
              }
            }
          } catch (err) {
            log.error({ catId: catId as string, err }, 'messageStore.append failed, degrading');
            if (options.persistenceContext) {
              options.persistenceContext.failed = true;
              options.persistenceContext.errors.push({
                catId: catId as string,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else if (!sawUserFacingSystemInfo) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: JSON.stringify({
              type: 'silent_completion',
              detail: `${catConfig?.displayName ?? (catId as string)} completed without textual output.`,
              toolCount: collectedToolEvents.length,
              provider: firstMetadata?.provider,
              model: firstMetadata?.model,
              invocationId: ownInvocationId,
            }),
            timestamp: Date.now(),
          } as AgentMessage;
          // No persisted message for fully silent turns.
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
        } else if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }
      } else if (collectedToolEvents.length > 0) {
        // hadError && textContent === '' but toolEvents exist — persist tool record so
        // refreshing the page still shows what the cat attempted before the error.
        try {
          await deps.messageStore.append({
            userId,
            catId,
            content: '',
            mentions: [],
            origin: 'stream',
            timestamp: invocationStartedAt,
            threadId,
            ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
            ...(firstMetadata ? { metadata: firstMetadata } : {}),
            toolEvents: collectedToolEvents,
            ...((options.parentInvocationId ?? ownInvocationId) || doneMsg?.tracing
              ? {
                  extra: {
                    // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId
                    // for error+toolEvents records too.
                    ...((options.parentInvocationId ?? ownInvocationId)
                      ? {
                          stream: {
                            invocationId: (options.parentInvocationId ?? ownInvocationId) as string,
                            turnInvocationId: (ownInvocationId ?? options.parentInvocationId) as string,
                          },
                        }
                      : {}),
                    ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
                  },
                }
              : {}),
          });
          // #80: Clean up draft only after successful append
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
          // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
          if (deps.invocationDeps.threadStore) {
            try {
              await deps.invocationDeps.threadStore.updateParticipantActivity(
                threadId,
                catId,
                // #267: only errors before abort are provider failures
                !hadProviderError,
              );
            } catch (activityErr) {
              log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
            }
          }
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append (error+tools) failed, degrading');
          if (options.persistenceContext) {
            options.persistenceContext.failed = true;
            options.persistenceContext.errors.push({
              catId: catId as string,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        // hadError && textContent === '' && no toolEvents → clean up draft only
        if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }
        // Update activity for error-only responses (no text/tools branch handles it)
        if (deps.invocationDeps.threadStore) {
          try {
            await deps.invocationDeps.threadStore.updateParticipantActivity(threadId, catId, !hadProviderError);
          } catch (activityErr) {
            log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
          }
        }
      }

      if (!routingGuardRemediated && initialTextStreamEvents.length > 0) {
        for (const event of initialTextStreamEvents) yield event;
        initialTextStreamEvents.splice(0, initialTextStreamEvents.length);
      }
      a2aMentions = getLocalRoutingLineStartMentions(a2aMentions);

      // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
      // Keep this outside the text branch: callback/tool-only turns can push worklist entries
      // without producing text, but their child slots still must be tracked before parent done.
      // We track which targets have already been announced to avoid duplicate handoff events.
      for (let wi = handoffEmitted; wi < worklist.length; wi++) {
        const pendingCat = worklist[wi]!;
        if (wi < targetCats.length) continue; // Skip original targets — not A2A

        // === A2A_HANDOFF 审计 (fire-and-forget, 缅因猫 review P2-3) ===
        const auditLog = getEventAuditLog();
        auditLog
          .append({
            type: AuditEventTypes.A2A_HANDOFF,
            threadId,
            data: {
              fromCat: catId,
              toCat: pendingCat,
              userId,
              a2aDepth: worklistEntry.a2aCount,
              maxDepth,
            },
          })
          .catch((err) => {
            log.warn({ threadId, fromCat: catId, toCat: pendingCat, err }, 'A2A_HANDOFF audit write failed');
          });

        // F233 P1 (云端 review): ball.handed 已移到 worklist 主循环接球时刻统一 emit（覆盖 original +
        // A2A），此处不再 emit——这里只是 A2A handoff 发射点（球离开前手），A2A target 真正接球在主循环。
        const nextConfig: CatConfig | undefined = catRegistry.tryGet(pendingCat as string)?.config;
        if (options.invocationController && options.trackA2ASlot && !activeTrackedA2ASlots.has(pendingCat)) {
          options.trackA2ASlot(threadId, pendingCat, userId, options.invocationController);
          activeTrackedA2ASlots.add(pendingCat);
        }
        yield {
          type: 'a2a_handoff' as AgentMessageType,
          catId,
          content: formatA2AHandoffContent(catId, pendingCat, catConfig, nextConfig),
          invocationId: ownInvocationId,
          targetCatId: pendingCat,
          timestamp: Date.now(),
        } as AgentMessage;
      }
      handoffEmitted = worklist.length;

      // Persist error as system message so it survives F5 reload.
      // During streaming, errors render as red badges via ephemeral frontend state.
      // Without persistence, they vanish on page refresh.
      if (collectedErrorText) {
        try {
          await deps.messageStore.append({
            userId: 'system',
            catId: null,
            content: `Error: ${collectedErrorText}`,
            mentions: [],
            origin: 'stream',
            timestamp: Date.now(),
            threadId,
            // F212 Phase B (云端 codex P2-8): carry cliDiagnostics through to persistence
            // so cold hydration / F5 reload can re-render the folded panel.
            ...(collectedCliDiagnostics
              ? { metadata: { provider: '', model: '', cliDiagnostics: collectedCliDiagnostics } }
              : {}),
          });
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append (error system msg) failed');
        }
      }

      // F222: Frustration auto-issue — detect CLI error + cancel burst signals.
      // Non-blocking: errors in frustration detection must not interrupt the route pipeline.
      // F222 P1: Skip for A2A/connector origins — only detect frustration on user-driven routes.
      if (deps.frustrationIssueStore && options.frustrationAutoIssueEligible !== false) {
        const frustrationDeps = {
          frustrationIssueStore: deps.frustrationIssueStore,
          messageStore: deps.messageStore,
          socketManager: deps.socketManager as
            | import('../../../../../infrastructure/websocket/index.js').SocketManager
            | undefined,
        };
        try {
          const { evaluate } = await import('../../frustration/FrustrationDetector.js');

          // Signal 1: CLI error (P1-1 original implementation)
          if (collectedCliDiagnostics?.reasonCode) {
            await evaluate(
              {
                signal: { type: 'cli_error', diagnostics: collectedCliDiagnostics },
                threadId,
                userId,
                catId: catId as string,
                invocationId: ownInvocationId,
              },
              frustrationDeps,
            );
          }

          // Signal 2: Cancel burst — query PendingRequestStore for recent denied
          // permission requests. This is the precise "user actively cancelled" signal,
          // distinct from generic tool execution errors. (R2 P1 fix: tool_result.status
          // === 'error' was too broad — included MCP failures, stream interrupts, etc.)
          if (deps.pendingRequestStore) {
            const { CANCEL_WINDOW_MS } = await import('../../frustration/FrustrationDetector.js');
            const recentDenied = await deps.pendingRequestStore.listRecentDenied(
              threadId,
              Date.now() - CANCEL_WINDOW_MS,
            );
            if (recentDenied.length >= 3) {
              await evaluate(
                {
                  signal: {
                    type: 'cancel_burst',
                    recentDenials: recentDenied.map((r) => ({
                      action: r.action,
                      timestamp: r.respondedAt ?? r.createdAt,
                    })),
                  },
                  threadId,
                  userId,
                  catId: catId as string,
                  invocationId: ownInvocationId,
                },
                frustrationDeps,
              );
            }
          }

          // Signal 3: A2A timeout — cat invoked but produced no visible output AND
          // elapsed > threshold. Spec AC-C1: "超过阈值（如 60s）未响应".
          // P1 fix: exclude instant crashes/parse errors — only genuine timeouts.
          const A2A_TIMEOUT_THRESHOLD_MS = 60_000;
          const elapsedMs = Date.now() - invocationStartedAt;
          if (!catProducedOutput && hadProviderError && elapsedMs >= A2A_TIMEOUT_THRESHOLD_MS) {
            await evaluate(
              {
                signal: {
                  type: 'a2a_timeout',
                  targetCatId: catId as string,
                  elapsedMs,
                },
                threadId,
                userId,
                catId: catId as string,
                invocationId: ownInvocationId,
              },
              frustrationDeps,
            );
          }
        } catch {
          // Non-blocking: frustration detection failure must not break routing
        }
      }

      // Ack cursor regardless of hadError: messages were assembled into the prompt
      // and delivered to the cat. Not acking causes infinite re-delivery on subsequent
      // rounds (bug: "砚砚每次都疯狂回之前的消息").
      if (incrementalMode && deliveryBoundaryId) {
        if (options.cursorBoundaries) {
          // ADR-008 S3: defer ack — caller acks after completion (or on abort/exception)
          upsertMaxBoundary(options.cursorBoundaries, catId, deliveryBoundaryId);
        } else if (deps.deliveryCursorStore) {
          // Legacy: ack immediately (deprecated route() path)
          try {
            await deps.deliveryCursorStore.ackCursor(userId, catId, threadId, deliveryBoundaryId);
          } catch (err) {
            log.error({ catId: catId as string, err }, 'ackCursor failed');
          }
        }
      }

      // F148 OQ-2: Log briefing→invocation link + context eval signals
      if (briefingMessageId && ownInvocationId) {
        const evalSignals = briefingCoverageMap
          ? extractContextEvalSignals({
              coverageMap: briefingCoverageMap,
              toolNames: collectedToolNames,
              responseTokenEstimate: estimateTokens(textContent),
            })
          : undefined;
        log.info({
          f148: 'briefing-invocation-link',
          briefingMessageId,
          invocationId: ownInvocationId,
          catId,
          threadId,
          hadError: hadProviderError,
          ...(evalSignals ? { eval: evalSignals } : {}),
        });
      }

      // F155: Ack guide completion only after cat produced visible output.
      if (deps.invocationDeps.threadStore) {
        const { createGuideStoreBridge } = await import('../../../../guides/GuideSessionRepository.js');
        const sessionStore = deps.invocationDeps.guideSessionStore!;
        await ackGuideCompletion({
          ctx: guideCtx,
          catId,
          catProducedOutput,
          targetCatIds,
          threadId,
          userId,
          guideStore: createGuideStoreBridge(sessionStore),
          threadStore: deps.invocationDeps.threadStore!,
        });
      }

      // Yield buffered done with correct isFinal (evaluated AFTER worklist may have grown)
      // MUST always reach here regardless of append success (缅因猫 review P1-2)
      // F194 Phase Z9 砚砚 R1 P1-1: stamp ownInvocationId on done if not already set.
      if (doneMsg) {
        const isFinal = index === worklist.length - 1;
        const ownStampedDone =
          ownInvocationId && !doneMsg.invocationId ? { ...doneMsg, invocationId: ownInvocationId } : doneMsg;
        yield { ...ownStampedDone, ...(mentionsUser ? { mentionsUser } : {}), isFinal };
        activeTrackedA2ASlots.delete(catId);
        if (isFinal) yieldedFinalDone = true;
        if (ownInvocationId) completedCatInvocationIds.push([catId, ownInvocationId]);
      }

      // F27: Advance executedIndex so pushToWorklist knows which cats are done
      worklistEntry.executedIndex = index + 1;
      index++;
    }
  } finally {
    // F153: Set route aggregate attributes on the parent route span
    if (options.routeSpan) {
      options.routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED, index);
      options.routeSpan.setAttribute(ROUTE_TOTAL_TOKENS, routeTotalTokens);
      options.routeSpan.setAttribute(ROUTE_HAS_A2A_HANDOFF, worklist.length > targetCats.length);
    }
    // F153: End all pending dispatch spans (unconditional — covers abort/throw)
    for (const entry of pendingDispatchSpans) {
      entry.span.end();
    }

    if (options.invocationController && options.completeA2ASlots && activeTrackedA2ASlots.size > 0) {
      options.completeA2ASlots(threadId, [...activeTrackedA2ASlots], options.invocationController);
    }

    // F200 AC-A1: fire-and-forget recall correlation after all cats complete
    if (deps.toolEventLog && deps.evidenceStore && completedCatInvocationIds.length > 0) {
      const evidenceDb = (deps.evidenceStore as { getDb?: () => import('better-sqlite3').Database }).getDb?.();
      if (evidenceDb) {
        deps.toolEventLog
          .readByThread(threadId)
          .then((events) => {
            const raw = events as unknown as Parameters<typeof triggerRecallCorrelation>[1];
            for (const [catId, invId] of completedCatInvocationIds) {
              triggerRecallCorrelation(evidenceDb, raw, invId, catId).catch(() => {});
            }
          })
          .catch(() => {});
      }
    }

    // F27: Always unregister worklist, even on error/abort.
    // Pass owner ref so preempting new invocation's worklist is not deleted (缅因猫 R1 P1-1)
    unregisterWorklist(threadId, worklistEntry, options.parentInvocationId);

    // done-guarantee safety net: If loop exited without yielding a final done
    // (e.g. signal.aborted break at top of while, or provider threw before done),
    // synthesize one so the frontend always receives isFinal=true and clears its timer.
    if (!yieldedFinalDone && worklist.length > 0) {
      const lastCatId = worklist[Math.min(index, worklist.length - 1)]!;
      yield {
        type: 'done' as AgentMessageType,
        catId: lastCatId,
        isFinal: true,
        timestamp: Date.now(),
      } as AgentMessage;
    }
  }
}
