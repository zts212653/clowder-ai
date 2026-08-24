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

import crypto from 'node:crypto';
import {
  A2A_INLINE_MENTION_MODE,
  type A2ARoutingProjection,
  type CatConfig,
  type CatId,
  catRegistry,
  createCatId,
  type OutputCommitDecision,
  type QueueTerminalConsumptionWitness,
  type RichBlock,
  resolveWorkflowSopSkill,
} from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';
import { getCatVoice } from '../../../../../config/cat-voices.js';
import {
  deriveHistoryContextTokenCeiling,
  resolvePromptInputCeilingTokens,
} from '../../../../../config/context-capacity.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  AGENT_ID,
  type CallerTraceContext,
  ROUTE_HAS_A2A_HANDOFF,
  ROUTE_TOTAL_CATS_INVOKED,
  ROUTE_TOTAL_TOKENS,
  ROUTING_EVENT_WAIT_REASON,
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
  conciergeVerifiedToolActions,
  conciergeVerifiedToolTargetsPerReply,
  inlineActionChecked,
  inlineActionDetected,
  inlineActionFeedbackWriteFailed,
  inlineActionFeedbackWritten,
  inlineActionHintEmitFailed,
  inlineActionHintEmitted,
  inlineActionRoutedSetSkip,
  inlineActionShadowMiss,
  legacyGuardWithoutActiveCustodyTotal,
  lineStartDetected,
  routingEventWaitBypassTotal,
  routingEventWaitFalseBypassTotal,
  routingEventWaitRedundantHoldPreventedTotal,
  routingEventWaitRejectedTotal,
  routingTerminalReleaseCleanStopTotal,
  turnCustodyProjectionTotal,
  turnCustodyShadowComparisonTotal,
  turnCustodyShadowNewBlockTotal,
  turnCustodyShadowOldBlockTotal,
} from '../../../../../infrastructure/telemetry/instruments.js';
import {
  boundedTurnCustodySourceCategory,
  boundedTurnCustodySourceSemantic,
  classifyTurnCustodyNewOnlyBlock,
  observesLegacyRoutingBlock,
  TURN_CUSTODY_CLOSE_CHECKPOINT_ATTR,
  TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR,
  TURN_CUSTODY_METRIC_COMPARISON_ATTR,
  TURN_CUSTODY_METRIC_STATE_ATTR,
  TURN_CUSTODY_PROJECTION_REASON_ATTR,
  TURN_CUSTODY_PROJECTION_STATE_ATTR,
  TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME,
  TURN_CUSTODY_SHADOW_SAMPLE_SPAN,
  TURN_CUSTODY_SOURCE_CATEGORY_ATTR,
  TURN_CUSTODY_SOURCE_SEMANTIC_ATTR,
  TURN_CUSTODY_TRANSITION_OBSERVED_ATTR,
  TURN_CUSTODY_UNKNOWN_AGREE_BLOCK_EVENT_NAME,
  TURN_CUSTODY_WAKE_PROVENANCE_ATTR,
  turnCustodyProjectionReason,
  turnCustodySourceSemantic,
} from '../../../../../infrastructure/telemetry/turn-custody-shadow-telemetry.js';
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
import { turnCustodyAdoptionRegistry } from '../../../../ball-custody/TurnCustodyAdoptionRegistry.js';
import {
  compareTurnCustodyShadow,
  type TurnCustodyProjection,
  type TurnCustodyWakeProvenance,
} from '../../../../ball-custody/TurnCustodyProjectionService.js';
import {
  buildA2ADispatchTurnCustodyWake,
  buildCrossThreadNoObligationWake,
  turnCustodyWakeSourceCategory,
} from '../../../../ball-custody/turn-custody-wake-provenance.js';
import { conciergeContextForCat, prepareConciergeContext } from '../../../../concierge/ConciergeRoutingInterceptor.js';
import {
  buildConciergeActions,
  extractTriagePlanIdsFromActions,
  stripTriagePlanMarkers,
  type TriagePlanExtractionDeps,
} from '../../../../concierge/concierge-reply-validator.js';
import { buildConciergeSearchContext, type HandleEntry } from '../../../../concierge/concierge-search-context.js';
import {
  resolveVerifiedConciergeToolAnchor,
  VerifiedConciergeToolTargetCollector,
} from '../../../../concierge/concierge-verified-tool-target.js';
import {
  ackGuideCompletion,
  guideContextForCat,
  prepareGuideContext,
} from '../../../../guides/GuideRoutingInterceptor.js';
import type { MemoryCueOpportunitySeed } from '../../../../memory/cue/MemoryCueInvocationPromptService.js';
// F260 AC-B8: Entity nudge — scan human input for already-registered entity references.
import { EntityNudgeService } from '../../../../memory/EntityNudgeService.js';
import { sharedEventStore, sharedNudgeCooldown } from '../../../../memory/entity-nudge-state.js';
import type { PushRecallPresentation } from '../../../../memory/f200-types.js';
import type { PreparedProactiveMemoryNudge } from '../../../../memory/ProactiveMemoryNudgeService.js';
import { mergePushRecallPresentations, triggerRecallCorrelation } from '../../../../memory/recall-correlation-hook.js';
import { drainCapturedTraces } from '../../../../prompt-hooks/PipelinePromptBuilder.js';
import { getTraceStore } from '../../../../prompt-hooks/trace-bootstrap.js';
// F237: Injection trace (v0 — fire-and-forget observability)
import { buildTraceDetail, buildTraceSummary, collectTrace } from '../../../../prompt-hooks/trace-collector.js';
import { assembleContext } from '../../context/ContextAssembler.js';
import {
  buildInvocationContext,
  buildStaticIdentity,
  buildStaticIdentityPackOnly,
  type InvocationContext,
} from '../../context/SystemPromptBuilder.js';
import { checkStreamOutputFreshness, type StreamFreshnessResult } from '../../freshness/checkStreamOutputFreshness.js';
import { buildFreshnessReinvokePrompt } from '../../freshness/createFreshnessReinvokeCheck.js';
import { mayDeleteDraft } from '../../freshness/FreshnessDraftCustody.js';
import type { FreshnessEvaluation } from '../../freshness/glass-box/FreshnessOutputCommitCoordinator.js';
import { findReplayUnsafeToolNames } from '../../freshness/tool-replay-safety.js';
import { formatDegradationMessage } from '../../orchestration/DegradationPolicy.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { mergePresentationCounts, type PresentationCounts } from '../../session/context-surface-projection.js';
import { buildSessionBootstrap, MAX_SESSION_BOOTSTRAP_TOKENS } from '../../session/SessionBootstrap.js';
import {
  type AppendMessageInput,
  hydrateCrossThreadReplyHint,
  hydrateReplyPreview,
  type StoredToolEvent,
} from '../../stores/ports/MessageStore.js';
import type { Thread, ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import {
  projectTurnExecutionMessage,
  type TurnExecutionKind,
  type TurnExecutionMessageProjection,
} from '../../stores/ports/TurnExecutionStore.js';
import { canViewMessage } from '../../stores/visibility.js';
import { classifyTool } from '../../tool-usage/classify.js';
import { deriveResultSummary } from '../../tool-usage/derive-result-summary.js';
import { normalizeMcpToolName } from '../../tool-usage/normalize-mcp-tool-name.js';
import { RECALL_CORRELATION_EVENT_WINDOW } from '../../tool-usage/ToolEventLog.js';
import { getStreamingTtsRegistry, StreamingTtsChunker } from '../../tts/StreamingTtsChunker.js';
import { getVoiceBlockSynthesizer } from '../../tts/VoiceBlockSynthesizer.js';
import type { AgentMessage, AgentMessageType, MessageMetadata } from '../../types.js';
import { buildCapsuleFromRouteState } from '../invocation/CollaborationContinuityCapsule.js';
import { resolveInvocationOrigin } from '../invocation/context-continuity.js';
import {
  applyActiveSessionCapacityPin,
  resolveInvocationCapacitySnapshot,
  sealBeforeInvocationIfNeeded,
} from '../invocation/invocation-capacity-snapshot.js';
import { type InvocationParams, invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { buildMcpCallbackInstructions, needsMcpInjection } from '../invocation/McpPromptInjector.js';
import { getRichBlockBuffer } from '../invocation/RichBlockBuffer.js';
import { resolveManagedSessionPolicySnapshot } from '../invocation/session-policy-snapshot.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { detectInlineActionMentionsWithShadow, getMaxA2ADepth, parseA2AMentions } from '../routing/a2a-mentions.js';
import {
  isSubstantiveTool,
  peekStreakOnPush,
  registerWorklist,
  setWorklistCallerAdmissionOpen,
  unregisterWorklist,
  updateStreakOnPush,
} from '../routing/WorklistRegistry.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import { formatA2AHandoffContent, formatSerialMultiTargetNotice } from './a2a-handoff-label.js';
import {
  buildCallbackFinalReplacementMetadataPatch,
  CallbackFinalReplacementTracker,
  type CallbackStreamDisposition,
  hasCallbackFinalReplacementMetadata,
  parseCallbackPostResult,
  readCallbackStreamDisposition,
} from './callback-final-replacement.js';
import { extractContextEvalSignals } from './context-eval.js';
import { validateRoutingSyntax } from './final-routing-slot.js';
import { buildBriefingMessage } from './format-briefing.js';
import {
  isEventBackedRoutingBypassProofValid,
  resolveEventBackedRoutingExit,
} from './guards/event-backed-routing-exit.js';
import { isDirectOwnerDispositionOrigin } from './human-disposition-invocation-origin.js';
import { persistUserFacingSystemInfoNotices } from './persist-system-info-warnings.js';
import { extractRichFromText, isValidRichBlock } from './rich-block-extract.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';
import {
  assembleIncrementalContext,
  collectExactPromptMessageIds,
  computeContextBudget,
  contextProjectionFromEpochDecision,
  createIdempotentPendingProjectionQueue,
  createLeakedToolCallStreamStripper,
  detectContextDegradation,
  explicitPromptForIncrementalContext,
  getService,
  getThreadBootcampMemberCount,
  hydrateVisibleA2ATriggerPromptMessage,
  isFinalGenerationBriefingBoundary,
  isUserFacingSystemInfoContent,
  judgmentSurfaceCueSeeds,
  mergePersistedPromptMessages,
  routeContentBlocksForCat,
  sanitizeInjectedContent,
  shouldPersistContextBriefing,
  subjectSeenCueSeeds,
  toStoredToolEvent,
  upsertMaxBoundary,
} from './route-helpers.js';
import { resolveRoutingDecisions } from './routing-decision.js';
import { appendThinkingChunk, renderThinkingChunks } from './thinking-chunks.js';
import { detectMatchedVerdictKeyword, shouldWarnVerdictWithoutPass } from './verdict-detect.js';
import { evaluateVoidHold } from './void-hold-detect.js';
import { buildVoteTally, checkVoteCompletion, extractVoteFromText, VOTE_RESULT_SOURCE } from './vote-intercept.js';

const log = createModuleLogger('route-serial');

// F260 P1-2 R2 fix: Nudge singletons moved to entity-nudge-state.ts
// (shared across serial + parallel strategies — see sharedCandidateTracker/sharedNudgeCooldown)

const BALL_CUSTODY_INVOCATION_HEARTBEAT_MIN_INTERVAL_MS = 30_000;

/**
 * F086/F216: single builder for the serial-normalization notice payload.
 *
 * `message` is the human-readable line — it is what `formatVisibleSystemInfo` renders live and what
 * `persistUserFacingSystemInfoNotices` writes for F5 hydration. `mode`/`order` stay machine-readable.
 * Emitting a payload with no registered visible/persistent consumer would ship a raw JSON blob that
 * vanishes on refresh (砚砚 R1 P1) — the notice must be wired end to end or it is not a notice.
 */
function buildSerialMultiTargetNoticePayload(
  fromCatId: CatId,
  legs: Array<{ catId: CatId; config?: CatConfig }>,
): string {
  return JSON.stringify({
    type: 'a2a_multi_target_serialized',
    fromCatId,
    mode: A2A_INLINE_MENTION_MODE,
    order: legs.map((leg) => leg.catId),
    message: formatSerialMultiTargetNotice(legs),
  });
}

export function buildTurnCustodyStopGateRemedialPrompt(wake: TurnCustodyWakeProvenance): string {
  if (wake.kind === 'structured' && wake.protocol === 'hold') {
    return (
      '[F167 球权停止门] 当前 managed hold wake 尚未发生可验证状态迁移。\n' +
      '若本次 wake 工作已经处理完成，只调用 cat_cafe_complete_managed_hold，并选择 handled 或 completed；工具会从当前 invocation 自动绑定 source message 与 task，不能手填 subject。\n' +
      '若工作尚未结束，只使用与下一条件匹配的 hold_ball、已注册 eventWait 或结构化传球。不要用纯文本 @、礼貌 ACK、command exit、测试/merge truth 代替 disposition。'
    );
  }
  if (wake.kind === 'structured' && wake.protocol === 'dispatch') {
    return (
      '[F167 球权停止门] 当前普通 A2A dispatch 尚未发生可验证状态迁移。\n' +
      '若本次 A2A 工作已经处理完成，只调用 cat_cafe_complete_a2a_dispatch，并选择 handled 或 completed；工具会从当前 invocation 自动绑定 source message、前手与当前 holder，不能手填 subject。\n' +
      '若工作尚未结束，只使用与下一条件匹配的 hold_ball、已注册 eventWait 或结构化传球。不要用纯文本 @、礼貌 ACK、command exit、测试/merge truth 代替 disposition。'
    );
  }
  return (
    '[F167 球权停止门] 本次唤醒携带的协议球尚未发生可验证状态迁移。\n' +
    '请只完成一次与当前协议球匹配的结构化动作，不要重做或改写刚才的工作：完成候选、结构化传球、returnToPredecessor、hold_ball 或已注册的 eventWait。\n' +
    '必须调用现有结构化工具；不要用纯文本 @、口头“持球”或礼貌 ACK 代替状态迁移。'
  );
}

/**
 * F233 Phase B (B2): persist ball.handed at the receiver boundary.
 * Phase T opens a dispatch projection from this exact event, so the write must
 * settle before its baseline is sampled. Failure stays fail-closed through an
 * unknown projection rather than blocking the underlying route.
 */
async function recordBallHanded(
  ballCustody: IBallCustodyIngest | undefined,
  threadId: string,
  fromCatId: string | undefined,
  toCatId: string,
  messageId: string | undefined,
): Promise<void> {
  if (!ballCustody || !messageId) return;
  try {
    await ballCustody.record(buildHandedEvent({ fromCatId, toCatId, threadId, messageId, at: Date.now() }));
  } catch (err) {
    log.warn({ threadId, toCat: toCatId, err }, 'ball.handed ingest failed');
  }
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
): Promise<void> {
  if (!ballCustody || !messageId) return Promise.resolve();
  return ballCustody
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
  targetCatIds: CatId[];
  createsCustodyHandoff: boolean;
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
  const targetCatIds = [
    ...new Set([...collectStructuredTargetCatsFromInput(toolInput), ...state.guardLineStartMentions]),
  ].map(createCatId);
  const createsCustodyHandoff = state.scope === 'target' && buildCrossThreadNoObligationWake(toolInput) === undefined;
  return {
    toolName,
    ...(toolUseId ? { toolUseId } : {}),
    targetCatIds,
    createsCustodyHandoff,
    ...state,
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
  streamDisposition?: CallbackStreamDisposition;
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

function isSubstantivePostDispositionProgress(msg: AgentMessage): boolean {
  if (msg.type === 'text') return Boolean(msg.content?.trim());
  return msg.type === 'tool_use' || msg.type === 'tool_result' || msg.type === 'a2a_handoff';
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
    getQueuedFreshnessMessagesForCat,
    hasQueuedOrActiveAgentForCat,
    deferA2AEnqueue,
    freshnessReinvokeEnqueue,
  } = options;
  const ownerAuthProvenance = options.ownerAuthProvenance ?? 'unknown';
  const previousResponses: { catId: CatId; content: string }[] = [];
  const sameRouteOutputMessageIds = new Set<string>();
  const thinkingMode = options.thinkingMode ?? 'play';
  // P2-3 fix: also consider default MCP server path (ClaudeAgentService has fallback resolution)
  const mcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
  const incrementalMode = Boolean(currentUserMessageId && deps.deliveryCursorStore);
  const isFreshnessSupplement = Boolean(options.freshnessSupplementId);

  const enqueueFreshnessSupplement = async (
    decision: Extract<OutputCommitDecision, { kind: 'published_with_unseen' }>,
    catId: string,
  ): Promise<void> => {
    if (!deps.freshnessOutputCommitCoordinator) return;
    const supplement = await deps.freshnessOutputCommitCoordinator.getSupplement(decision.offeredSupplementId);
    if (!supplement || supplement.status !== 'pending') return;
    if (!freshnessReinvokeEnqueue) {
      await deps.freshnessOutputCommitCoordinator.failSupplement(supplement.id, 'scheduler_unavailable');
      return;
    }
    try {
      const enqueueResult = freshnessReinvokeEnqueue({
        threadId,
        userId,
        ownerAuthProvenance,
        content: `[Freshness Supplement ${supplement.id}]`,
        source: 'agent',
        sourceCategory: 'freshness',
        targetCats: [catId],
        callerCatId: catId,
        autoExecute: true,
        priority: 'normal',
        intent: 'execute',
        idempotencyKey: supplement.id,
        freshnessSupplementId: supplement.id,
        freshnessSupplementLineageId: supplement.lineageId,
        freshnessSupplementSeq: supplement.seq,
        readOnlyToolPolicy: {
          mode: 'read_only',
          replayDeniedToolNames: supplement.replayUnsafeToolNames,
        },
        freshnessContext: {
          sourceNoticeIds: [],
          senders: [],
          reason: 'published_with_unseen',
        },
      });
      if (enqueueResult?.outcome === 'full') {
        await deps.freshnessOutputCommitCoordinator.failSupplement(supplement.id, 'queue_full');
      }
    } catch (err) {
      try {
        await deps.freshnessOutputCommitCoordinator.failSupplement(supplement.id, 'scheduler_unavailable');
      } catch (terminalErr) {
        log.error(
          { err, terminalErr, supplementId: supplement.id },
          '[F254] supplement enqueue and terminal persistence both failed',
        );
      }
    }
  };

  // Worklist pattern: starts with targetCats, may grow via A2A mentions
  // F27: Register worklist so callback A2A can push targets here
  // F108: Key by parentInvocationId for concurrent isolation
  const worklist = [...targetCats];
  const maxDepth = options.maxA2ADepth ?? getMaxA2ADepth();
  const worklistEntry = registerWorklist(threadId, worklist, maxDepth, options.parentInvocationId);
  // No callback caller is active while route-level setup is still running. Each turn opens
  // this window only after its abort gate, then the final admission drain closes it.
  setWorklistCallerAdmissionOpen(worklistEntry, false);

  let index = 0;
  // done-guarantee: Track whether we yielded a done(isFinal=true) so the finally block can
  // synthesize one if the loop exits early (e.g. signal.aborted break at top of while).
  let yieldedFinalDone = false;
  // F27: Track how many worklist entries have had a2a_handoff emitted
  let handoffEmitted = targetCats.length; // Original targets don't get handoff events
  const activeTrackedA2ASlots = new Set<CatId>();
  const claimOrDeferA2ATarget = async (
    pendingCat: CatId,
    fromCat: CatId,
    fallbackContent?: string,
    fallbackTriggerMessageId?: string,
    onDurablyDeferred?: (targetCatId: CatId, triggerMessageId: string) => void,
  ): Promise<boolean> => {
    if (activeTrackedA2ASlots.has(pendingCat)) {
      return true;
    }
    if (!options.invocationController || !options.trackA2ASlot) {
      throw new Error('A2A slot admission unavailable: route bridge missing');
    }

    const claimed = options.trackA2ASlot(threadId, pendingCat, userId, options.invocationController);
    if (claimed !== false) {
      activeTrackedA2ASlots.add(pendingCat);
      return true;
    }

    const triggerMessageId = fallbackTriggerMessageId ?? worklistEntry.a2aTriggerMessageId.get(pendingCat);
    let content = fallbackContent;
    if (content === undefined && triggerMessageId) {
      try {
        content = (await deps.messageStore.getById(triggerMessageId))?.content;
      } catch (err) {
        log.warn(
          { threadId, fromCat, toCat: pendingCat, triggerMessageId, err },
          'A2A occupied-slot trigger hydration failed',
        );
      }
    }

    if (!deferA2AEnqueue || content === undefined) {
      log.error(
        {
          threadId,
          fromCat,
          toCat: pendingCat,
          triggerMessageId,
          hasDeferredQueue: Boolean(deferA2AEnqueue),
          hasContent: content !== undefined,
        },
        'A2A target owned by another active route; inline invocation blocked without deferred custody',
      );
      throw new Error(
        `durable A2A custody unavailable for ${pendingCat}: ${
          deferA2AEnqueue ? 'trigger content missing' : 'InvocationQueue unavailable'
        }`,
      );
    }

    const enqueueResult = deferA2AEnqueue({
      threadId,
      userId,
      ownerAuthProvenance,
      content,
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: [pendingCat],
      callerCatId: fromCat,
      ...(triggerMessageId ? { messageId: triggerMessageId, a2aTriggerMessageId: triggerMessageId } : {}),
      autoExecute: true,
      priority: 'normal',
      intent: 'execute',
    });
    if (enqueueResult?.outcome !== 'enqueued') {
      log.error(
        {
          threadId,
          fromCat,
          toCat: pendingCat,
          triggerMessageId,
          enqueueOutcome: enqueueResult?.outcome ?? 'missing',
        },
        'A2A target owned by another active route; durable enqueue was not accepted',
      );
      throw new Error(
        `durable A2A custody unavailable for ${pendingCat}: enqueue outcome ${enqueueResult?.outcome ?? 'missing'}`,
      );
    }

    log.info(
      { threadId, fromCat, toCat: pendingCat, triggerMessageId },
      'A2A target owned by another active route; deferred to InvocationQueue',
    );
    if (triggerMessageId) onDurablyDeferred?.(pendingCat, triggerMessageId);
    return false;
  };
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

  // F229 KD-23: Pre-fetch search context → per-invocation handle table + prompt context.
  // Handle table flows from here to buildConciergeActions (same function scope).
  // No shared storage — cross-turn overwrites impossible by construction.
  let conciergeSearchContextString = '';
  let conciergeHandles: HandleEntry[] = [];
  if ('conciergeConfig' in conciergeCtx) {
    try {
      const searchResult = await buildConciergeSearchContext({
        userMessage: message,
        threadId,
        evidenceStore: deps.evidenceStore,
      });
      conciergeSearchContextString = searchResult.contextString;
      conciergeHandles = searchResult.handles;
    } catch {
      // Fail-open: search context failure → no context injection, no crash
    }
  }

  // F260 AC-B8: Entity nudge — scan HUMAN input only.
  // P1-1 R2 fix: Gate on frustrationAutoIssueEligible (typed user-origin flag plumbed
  // through routeExecution). This excludes A2A, connector, callback multi-mention, and
  // queue-replayed messages — not just those with a2aTriggerMessageId.
  // P1-2 R2 fix: Use shared singletons from entity-nudge-state.ts (cross-strategy state).
  const cueOccurredAt = Date.now();
  const memoryCueOpportunitySeeds = [...(options.memoryCueOpportunitySeeds ?? [])];
  const memoryCueLegacyFallbacks: Array<{
    seed: MemoryCueOpportunitySeed;
    promptContext: string;
  }> = [];
  let entityNudgePromptContext = '';
  let preparedProactiveMemoryNudge: PreparedProactiveMemoryNudge | null = null;
  if (deps.evidenceStore && options.frustrationAutoIssueEligible !== false) {
    try {
      const evidenceDb = (deps.evidenceStore as { getDb?: () => import('better-sqlite3').Database }).getDb?.();
      if (evidenceDb) {
        const nudgeService = new EntityNudgeService(evidenceDb, sharedNudgeCooldown(), sharedEventStore(evidenceDb));
        const nudgeResult = nudgeService.processInput({
          text: message,
          threadId,
          ownerUserId: userId,
        });
        const subjectCueSeeds = deps.invocationDeps.memoryCuePromptService
          ? subjectSeenCueSeeds({
              result: nudgeResult,
              sourceMessageId: currentUserMessageId,
              occurredAt: cueOccurredAt,
            })
          : [];
        memoryCueOpportunitySeeds.push(...subjectCueSeeds);
        for (const seed of subjectCueSeeds) {
          const nudge = nudgeResult.nudges.find(
            (candidate) =>
              candidate.entityId === seed.payload.entityId && candidate.matchedAlias === seed.payload.matchedAlias,
          );
          if (nudge) {
            memoryCueLegacyFallbacks.push({
              seed,
              promptContext: EntityNudgeService.formatForPrompt({ ...nudgeResult, nudges: [nudge] }),
            });
          }
        }
        const cueEntityIds = new Set(subjectCueSeeds.map((seed) => seed.payload.entityId));
        entityNudgePromptContext = EntityNudgeService.formatForPrompt({
          ...nudgeResult,
          nudges: nudgeResult.nudges.filter((nudge) => !nudge.entityId || !cueEntityIds.has(nudge.entityId)),
        });
      }
    } catch (nudgeErr) {
      log.warn({ err: nudgeErr, threadId }, '[F260] entity nudge hook failed — fail-open, no nudges this invocation');
    }
  }
  if (deps.proactiveMemoryNudgeService && currentUserMessageId && options.frustrationAutoIssueEligible !== false) {
    preparedProactiveMemoryNudge = await deps.proactiveMemoryNudgeService.prepare({
      ownerUserId: userId,
      currentUserMessageId,
    });
    entityNudgePromptContext += preparedProactiveMemoryNudge.context;
  }
  let humanDispositionFeedbackPromptContext = '';
  if (
    deps.humanDispositionFeedbackContextService &&
    isDirectOwnerDispositionOrigin(options.humanDispositionInvocationOrigin)
  ) {
    try {
      humanDispositionFeedbackPromptContext = await deps.humanDispositionFeedbackContextService.prepare({
        ownerUserId: userId,
        text: message,
      });
    } catch (feedbackErr) {
      log.warn({ err: feedbackErr, threadId }, '[F281] exact-subject feedback context failed closed for serial route');
    }
  }
  if (deps.invocationDeps.memoryCuePromptService) {
    memoryCueOpportunitySeeds.push(
      ...judgmentSurfaceCueSeeds({
        sopStageHint,
        promptTags: options.frustrationAutoIssueEligible !== false ? promptTags : undefined,
        occurredAt: cueOccurredAt,
      }),
    );
  }
  const routeLevelNudgePromptContext = entityNudgePromptContext + humanDispositionFeedbackPromptContext;

  const completedCatInvocationIds: Array<[string, string]> = [];
  const pushRecallPresentationsByInvocation = new Map<string, PushRecallPresentation[]>();
  const pendingTurnCustodyTransitionWrites: Promise<void>[] = [];
  const pendingTurnCustodyShadowCloses: Array<(checkpoint: 'next_turn_boundary' | 'route_settled') => Promise<void>> =
    [];
  let unregisterTurnCustodyAdoption: (() => Promise<void>) | undefined;
  const releaseTurnCustodyAdoption = async (): Promise<void> => {
    const unregister = unregisterTurnCustodyAdoption;
    unregisterTurnCustodyAdoption = undefined;
    await unregister?.();
  };
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  const flushTurnCustodyShadowCloses = async (checkpoint: 'next_turn_boundary' | 'route_settled'): Promise<void> => {
    const transitionWrites = pendingTurnCustodyTransitionWrites.splice(0);
    if (transitionWrites.length > 0) await Promise.allSettled(transitionWrites);

    const closes = pendingTurnCustodyShadowCloses.splice(0);
    for (const close of closes) {
      try {
        await close(checkpoint);
      } catch (err) {
        log.warn({ threadId, err }, 'F167 Phase T turn-custody stop-gate close failed');
      }
    }
  };

  try {
    while (index < worklist.length) {
      const catId = worklist[index]!;
      let stopGateRemedialAttempted = false;
      let structuredDispositionMissingCode: string | undefined;
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
      const currentPushRecallPresentations: PushRecallPresentation[] = [];

      // Only pass images/uploads for the first cat (user's original target)
      const isOriginalTarget = index < targetCats.length;
      const targetContentBlocks = isOriginalTarget ? routeContentBlocksForCat(catId, contentBlocks) : undefined;
      const targetUploadDir = targetContentBlocks ? uploadDir : undefined;
      const catConciergeContext = conciergeContextForCat(conciergeCtx, catId as string);
      const conciergeSearchContextForCat =
        conciergeSearchContextString && 'conciergeConfig' in catConciergeContext ? conciergeSearchContextString : '';

      let prompt = message;
      if (!incrementalMode && previousResponses.length > 0) {
        const contextParts = previousResponses.map((r) => `[${r.catId} responded: ${r.content}]`);
        prompt = `${message}\n\n${contextParts.join('\n')}`;
      }

      // F260 AC-B8 and F229 KD-24 inject their prompt additions only after
      // incremental/legacy assembly reaches its final shape (see below).
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
      const activeA2ATriggerMessageId = worklistEntry.a2aTriggerMessageId.get(catId);
      const streamReplyTo = activeA2ATriggerMessageId ?? queueTriggerReplyTo;
      const turnTriggerMessageId = streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId;
      const streamReplyPreview = streamReplyTo
        ? await hydrateReplyPreview(deps.messageStore, streamReplyTo)
        : undefined;
      const activeA2ATriggerMessage = activeA2ATriggerMessageId
        ? await deps.messageStore.getById(activeA2ATriggerMessageId)
        : null;
      const activeA2ATriggerContent =
        activeA2ATriggerMessage && !activeA2ATriggerMessage.deletedAt && !activeA2ATriggerMessage._tombstone
          ? activeA2ATriggerMessage.content
          : undefined;
      const exactA2ATriggerPromptMessage = incrementalMode
        ? await hydrateVisibleA2ATriggerPromptMessage(deps, streamReplyTo, threadId, catId, thinkingMode)
        : undefined;
      const persistedPromptMessagesForCat = mergePersistedPromptMessages(
        options.persistedPromptMessages,
        exactA2ATriggerPromptMessage,
      );
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
            ...(crossThreadReplyHintRaw.coordination ? { coordination: crossThreadReplyHintRaw.coordination } : {}),
          }
        : undefined;
      const hasTerminalCoordinationExit = crossThreadReplyHint?.coordination?.phase === 'terminal';
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
      // providers (Gemini, Antigravity, CatAgent, A2A, OpenCode, Kimi…)
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
      const resolvedCapacitySnapshot = await resolveInvocationCapacitySnapshot({
        catId,
        service,
      });
      let capacitySnapshot = resolvedCapacitySnapshot;
      capacitySnapshot = await applyActiveSessionCapacityPin({
        snapshot: capacitySnapshot,
        catId,
        threadId,
        userId,
        sessionChainStore: deps.invocationDeps.sessionChainStore,
      });
      const sessionPolicySnapshot = resolveManagedSessionPolicySnapshot({
        catId: catId as string,
        evidence: {
          capacitySnapshot,
          // A carrier declaration is not this invocation's usage evidence.
          authoritativeUsage: false,
          sessionRotation: Boolean(deps.invocationDeps.sessionChainStore && deps.invocationDeps.sessionSealer),
          continuityBootstrap: Boolean(deps.invocationDeps.sessionChainStore && deps.invocationDeps.transcriptReader),
        },
      });
      const sealedForCapacity = await sealBeforeInvocationIfNeeded({
        snapshot: capacitySnapshot,
        catId,
        threadId,
        userId,
        sessionChainStore: deps.invocationDeps.sessionChainStore,
        sessionSealer: deps.invocationDeps.sessionSealer,
        policySnapshot: sessionPolicySnapshot,
        clearProviderSession: () => deps.invocationDeps.sessionManager.delete(userId, catId, threadId),
      });
      if (sealedForCapacity) capacitySnapshot = resolvedCapacitySnapshot;
      const declaredTurnCustodyWake =
        options.turnCustodyWakeForCat?.(catId) ??
        options.turnCustodyWake ??
        ({ kind: 'legacy', reason: 'source_missing' } as const);
      const turnCustodyWake =
        declaredTurnCustodyWake.kind === 'action_successor'
          ? declaredTurnCustodyWake
          : (buildCrossThreadNoObligationWake(crossThreadReplyHint) ??
            (directMessageFrom
              ? buildA2ADispatchTurnCustodyWake({
                  threadId,
                  targetCatId: catId as string,
                  messageId: streamReplyTo,
                  fromCatId: directMessageFrom,
                })
              : declaredTurnCustodyWake));
      if (!isFreshnessSupplement && turnCustodyWake.kind !== 'non_obligation') {
        const dispatchHandoff =
          turnCustodyWake.kind === 'structured' && turnCustodyWake.protocol === 'dispatch'
            ? turnCustodyWake.handoff
            : undefined;
        const handoffWrite = recordBallHanded(
          deps.ballCustody,
          threadId,
          dispatchHandoff?.fromCatId ?? directMessageFrom,
          catId as string,
          dispatchHandoff?.messageId ?? streamReplyTo ?? currentUserMessageId,
        );
        if (deps.turnCustodyProjectionService && turnCustodyWake.kind === 'structured') {
          await handoffWrite;
        } else {
          void handoffWrite;
        }
      }
      // Settle the preceding turn at the earliest boundary that can contain its
      // receiver-side handoff. Closing here prevents a later ping-pong turn by
      // the same cat from being misattributed to the earlier projection.
      await flushTurnCustodyShadowCloses('next_turn_boundary');
      let turnCustodyProjection: TurnCustodyProjection | undefined;
      if (deps.turnCustodyProjectionService) {
        turnCustodyProjection = await deps.turnCustodyProjectionService.open(turnCustodyWake);
      }
      const adoptedTurnCustodyProjections: Array<{
        wake: Extract<TurnCustodyWakeProvenance, { kind: 'structured'; protocol: 'hold' }>;
        projection: TurnCustodyProjection;
      }> = [];
      const structuredDispositionPrompt =
        turnCustodyWake.kind === 'structured' &&
        (turnCustodyWake.protocol === 'hold' || turnCustodyWake.protocol === 'dispatch') &&
        turnCustodyProjection?.state !== 'covered_empty'
          ? buildTurnCustodyStopGateRemedialPrompt(turnCustodyWake)
          : undefined;
      let turnCustodyShadowRecorded = false;
      const turnCustodyTerminalWitnesses: QueueTerminalConsumptionWitness[] = [];
      const recordTurnCustodyTerminalWitness = (witness: QueueTerminalConsumptionWitness): void => {
        const witnessKey =
          witness.kind === 'terminal_silent'
            ? witness.kind
            : witness.kind === 'source_response'
              ? `${witness.kind}:${witness.outputMessageIds.join(',')}`
              : `${witness.kind}:${witness.sourceMessageId}`;
        const duplicate = turnCustodyTerminalWitnesses.some((candidate) => {
          const candidateKey =
            candidate.kind === 'terminal_silent'
              ? candidate.kind
              : candidate.kind === 'source_response'
                ? `${candidate.kind}:${candidate.outputMessageIds.join(',')}`
                : `${candidate.kind}:${candidate.sourceMessageId}`;
          return candidateKey === witnessKey;
        });
        if (!duplicate) turnCustodyTerminalWitnesses.push(witness);
      };
      const adoptTurnCustodyWakes = async (wakes: readonly TurnCustodyWakeProvenance[]): Promise<void> => {
        if (!deps.turnCustodyProjectionService) return;
        for (const wake of wakes) {
          // Prompt/tool adoption currently applies only to command-backed hold
          // receipts. Dispatch custody still requires its own routed child.
          if (wake.kind !== 'structured' || wake.protocol !== 'hold') continue;
          const duplicatesPrimary =
            turnCustodyWake.kind === 'structured' &&
            turnCustodyWake.protocol === 'hold' &&
            turnCustodyWake.sourceMessageId === wake.sourceMessageId &&
            turnCustodyWake.taskId === wake.taskId;
          const alreadyAdopted = adoptedTurnCustodyProjections.some(
            (candidate) =>
              candidate.wake.sourceMessageId === wake.sourceMessageId && candidate.wake.taskId === wake.taskId,
          );
          if (duplicatesPrimary || alreadyAdopted) continue;
          adoptedTurnCustodyProjections.push({
            wake,
            projection: await deps.turnCustodyProjectionService.open(wake),
          });
        }
      };
      const hasNativeL0 = service.injectsL0Natively?.() ?? false;
      const staticIdentity = hasNativeL0
        ? buildStaticIdentityPackOnly(catId, { packBlocks })
        : buildStaticIdentity(catId, { mcpAvailable, packBlocks });
      // F237: drain session trace synchronously — before any await between
      // buildStaticIdentity and buildInvocationContext (race-safety for parallel reuse).
      drainCapturedTraces();
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
      const personMemoryProposalStatusRequest =
        activeA2ATriggerContent && activeA2ATriggerContent !== message
          ? `${activeA2ATriggerContent}\n\n${message}`
          : message;
      const personMemoryProposalStatusContext = deps.personMemoryProposalStatusContextResolver
        ? await deps.personMemoryProposalStatusContextResolver.resolve(
            userId,
            threadId,
            personMemoryProposalStatusRequest,
          )
        : '';
      const invocationContext = [
        buildInvocationContext({
          catId,
          mode: invocationMode,
          chainIndex: index + 1,
          chainTotal: worklist.length,
          teammates,
          mcpAvailable,
          nativeL0Injected: hasNativeL0,
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
          ...(bootcampState ? { bootcampState, bootcampMemberCount } : {}),
          ...(alwaysOnDocs && alwaysOnInjectionMode === 'on' ? { alwaysOnDocs } : {}),
          ...guideContextForCat(guideCtx, catId, targetCatIds, threadId),
          threadId,
          ...(worldContext ? { worldContext } : {}),
          ...catConciergeContext,
        }),
        personMemoryProposalStatusContext,
      ]
        .filter(Boolean)
        .join('\n\n');
      // F237: drain turn trace synchronously — no yield between build and drain.
      drainCapturedTraces();
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

      // F237 Phase 2: Pipeline trace capture is drained above (lines 698, 804)
      // to prevent stale module-global buffer. Persistence is handled by the v0
      // trace path below (after all route-level content is assembled), avoiding
      // duplicate records. Phase 2 will take over persistence when migration completes.

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
      const bootstrapSessionChainStore = deps.invocationDeps.sessionChainStore;
      const bootstrapTranscriptReader = deps.invocationDeps.transcriptReader;
      const defersProjection =
        incrementalMode &&
        Boolean(deps.invocationDeps.contextEpochOwner) &&
        catConfig?.provider !== 'openai-chatgpt-pro';
      const rebuildSessionBootstrap =
        !isSerialReborn && bootstrapSessionChainStore && bootstrapTranscriptReader
          ? async (contextProjection?: Parameters<typeof buildSessionBootstrap>[0]['contextProjection']) => {
              const bootstrapDepth = sessionPolicySnapshot.config.handoff?.bootstrapDepth;
              return buildSessionBootstrap(
                {
                  sessionChainStore: bootstrapSessionChainStore,
                  transcriptReader: bootstrapTranscriptReader,
                  ownerUserId: userId,
                  ...(deps.invocationDeps.taskStore ? { taskStore: deps.invocationDeps.taskStore } : {}),
                  ...(deps.invocationDeps.threadStore ? { threadStore: deps.invocationDeps.threadStore } : {}),
                  ...(bootstrapDepth ? { bootstrapDepth } : {}),
                  ...(contextProjection ? { contextProjection } : {}),
                },
                catId,
                threadId,
              );
            }
          : undefined;
      if (rebuildSessionBootstrap && !defersProjection) {
        try {
          const bootstrap = await rebuildSessionBootstrap();
          if (bootstrap) {
            bootstrapContext = bootstrap.text;
            if (bootstrap.pushRecallPresentations?.length) {
              currentPushRecallPresentations.push(...bootstrap.pushRecallPresentations);
            }
          }
        } catch {
          // Best-effort: bootstrap failure doesn't block invocation
        }
      }

      // F237: fire-and-forget injection trace persist (v0 — observability only)
      // Placed after bootstrapContext so per-turn trace covers ALL route-level
      // injected system/control content (invocation + mode prompt + bootstrap + MCP).
      try {
        const traceStore = getTraceStore();
        if (traceStore) {
          const traceTurnId = crypto.randomUUID();
          const traceModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt ?? '';
          const traceTurnContent = [invocationContext, traceModePrompt, bootstrapContext, mcpInstructions]
            .filter(Boolean)
            .join('\n\n---\n\n');
          const trace = collectTrace(catId as string, staticIdentity, traceTurnContent, hasNativeL0, {
            mcpAvailable,
            packBlocks,
          });
          const traceMeta = { turnId: traceTurnId, threadId, catId: catId as string };
          const summary = buildTraceSummary(trace, traceMeta);
          const detail = buildTraceDetail(trace, traceMeta);
          traceStore.persist(summary, detail).catch((err) => {
            log.warn({ err, threadId, catId }, '[F237] injection trace persist failed (fire-and-forget)');
          });
        }
        // v0 collectTrace → buildStaticIdentity(annotateSegments: true) re-populates
        // the module-global capturedSessionTrace without draining. Clear it so the next
        // invocation (especially native-L0 pack-only) doesn't persist stale session traces.
        if (deps.injectionTraceStore) drainCapturedTraces();
      } catch {
        /* F237: trace collection must never break invocation */
      }

      let deliveryBoundaryId: string | undefined;
      let incrementallyExposedMessageIds: string[] = [];
      const invocationMessagePrompt = prompt;
      let rebuildPromptWithBootstrap: ((bootstrap: string) => string) | undefined;
      let explicitlyExposedMessageIds: string[] = [];
      let contextPromptFactory: InvocationParams['contextPromptFactory'];
      let exactPromptMessageIds: string[] = [];
      const pendingContextProjectionMessages = createIdempotentPendingProjectionQueue<AgentMessage>();
      let briefingProjectionMessage: AgentMessage | undefined;
      let pendingBriefingInput: AppendMessageInput | undefined;
      let bootstrapPresentationCounts: PresentationCounts | undefined;
      let proactiveMemoryNudgeFinalized = false;
      const appendRoutePromptAdditions = (basePrompt: string): string => {
        let projectedPrompt = basePrompt;
        if (conciergeSearchContextForCat) projectedPrompt = `${projectedPrompt}\n${conciergeSearchContextForCat}`;
        if (routeLevelNudgePromptContext) {
          projectedPrompt = `${projectedPrompt}\n${routeLevelNudgePromptContext}`;
          if (preparedProactiveMemoryNudge && !proactiveMemoryNudgeFinalized) {
            deps.proactiveMemoryNudgeService?.finalize(preparedProactiveMemoryNudge);
            proactiveMemoryNudgeFinalized = true;
          }
        }
        if (structuredDispositionPrompt) {
          projectedPrompt = `${projectedPrompt}\n\n---\n\n${structuredDispositionPrompt}`;
        }
        return projectedPrompt;
      };
      const materializeFinalGenerationBriefing = async (): Promise<void> => {
        if (!pendingBriefingInput || briefingProjectionMessage) return;
        try {
          const stored = await deps.messageStore.append(pendingBriefingInput);
          briefingMessageId = stored.id;
          briefingProjectionMessage = {
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
          pendingContextProjectionMessages.enqueue(`briefing:${stored.id}`, briefingProjectionMessage);
        } catch {
          // fail-open: briefing is a non-critical UI projection
        }
      };
      if (incrementalMode) {
        // Serial incremental mode depends on AgentRouter having appended current user message first.
        // We still explicitly include `message` when that message is not present in unseen rows.

        // Deduct fixed prompt parts from the invocation-owned input ceiling.
        const catModePromptForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const inputCeilingTokens = resolvePromptInputCeilingTokens(capacitySnapshot.capacity);
        const incSystemTokens =
          estimateTokens(
            [staticIdentity, invocationContext, catModePromptForBudget, mcpInstructions].filter(Boolean).join('\n'),
          ) + (rebuildSessionBootstrap ? MAX_SESSION_BOOTSTRAP_TOKENS : estimateTokens(bootstrapContext));
        const incMessageTokens = estimateTokens([message, conciergeSearchContextForCat].filter(Boolean).join('\n'));
        // P1 R7 fix: use shared budget helper (serial/parallel × incremental/legacy unified)
        const incNudgeTokens = routeLevelNudgePromptContext ? estimateTokens(routeLevelNudgePromptContext) : 0;
        const effectiveContextBudget = computeContextBudget({
          inputCeilingTokens,
          historyTokenCeiling: deriveHistoryContextTokenCeiling(inputCeilingTokens),
          systemPartsTokens: incSystemTokens,
          promptTokens: incMessageTokens,
          nudgeTokens: incNudgeTokens,
        });

        const catModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const buildIncrementalProjection = async (
          epochInput?: Parameters<NonNullable<InvocationParams['contextPromptFactory']>>[0],
        ) => {
          // The factory may rerun after provider-generation replacement. Only
          // the final run owns the pending UI projection; durable briefing
          // creation is separately guarded below.
          pendingContextProjectionMessages.reset();
          const contextProjection = epochInput
            ? contextProjectionFromEpochDecision(epochInput.decision, epochInput.handshake.coordinate)
            : undefined;
          if (contextProjection && rebuildSessionBootstrap) {
            try {
              const bootstrap = await rebuildSessionBootstrap(contextProjection);
              bootstrapContext = bootstrap?.text ?? '';
              bootstrapPresentationCounts = bootstrap?.presentationCounts;
              if (bootstrap?.pushRecallPresentations?.length) {
                currentPushRecallPresentations.push(...bootstrap.pushRecallPresentations);
              }
            } catch {
              bootstrapContext = '';
              bootstrapPresentationCounts = undefined;
            }
          }
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
              projectPath: routeThread?.projectPath,
              cursorOverlay: options.cursorBoundaries?.get(catId as string),
              sameRouteOutputMessageIds,
              exactA2ATriggerMessageId: streamReplyTo,
              ...(contextProjection ? { contextProjection } : {}),
            },
          );
          deliveryBoundaryId = inc.boundaryId;
          incrementallyExposedMessageIds = inc.exposedMessageIds;
          if (inc.pushRecallPresentations?.length) {
            currentPushRecallPresentations.push(...inc.pushRecallPresentations);
          }
          if (deliveryBoundaryId && deps.deliveryCursorStore) {
            try {
              await deps.deliveryCursorStore.ackSeenCursor(userId, catId, threadId, deliveryBoundaryId);
            } catch (err) {
              log.warn({ catId: catId as string, err }, '[F254] seenCursor seed failed');
            }
          }
          if (inc.degradation) {
            pendingContextProjectionMessages.enqueue(`degradation:${inc.degradation}`, {
              type: 'system_info' as AgentMessageType,
              catId,
              content: inc.degradation,
              timestamp: Date.now(),
            } as AgentMessage);
          }
          if (shouldPersistContextBriefing(inc)) {
            briefingCoverageMap = inc.coverageMap;
            const contextSurfaceProjection = inc.surfaceProjection
              ? {
                  ...inc.surfaceProjection,
                  presentationCounts: mergePresentationCounts(
                    inc.surfaceProjection.presentationCounts,
                    ...(bootstrapPresentationCounts ? [bootstrapPresentationCounts] : []),
                  ),
                }
              : undefined;
            pendingBriefingInput = buildBriefingMessage(inc.coverageMap, threadId, {
              ...inc.briefingContext,
              ...(contextSurfaceProjection ? { contextSurfaceProjection } : {}),
            });
          } else {
            pendingBriefingInput = undefined;
          }
          const explicitProjection = explicitPromptForIncrementalContext(
            inc,
            message,
            currentUserMessageId,
            persistedPromptMessagesForCat,
          );
          explicitlyExposedMessageIds = explicitProjection.exposedMessageIds;
          rebuildPromptWithBootstrap = (bootstrap) => {
            const parts = [invocationContext, catModePrompt, bootstrap, mcpInstructions].filter(Boolean);
            if (inc.contextText) parts.push(inc.contextText);
            if (explicitProjection.text) parts.push(explicitProjection.text);
            return parts.join('\n\n---\n\n');
          };
          const projectedPrompt = appendRoutePromptAdditions(rebuildPromptWithBootstrap(bootstrapContext));
          exactPromptMessageIds = collectExactPromptMessageIds(
            incrementallyExposedMessageIds,
            explicitlyExposedMessageIds,
            options.freshnessSupplementRequiredMessageIds ?? [],
            options.freshnessClosureRequiredMessageIds ?? [],
          );
          return {
            prompt: projectedPrompt,
            promptMessageIds: exactPromptMessageIds,
            ...(inc.surfaceProjection ? { deltaSize: inc.surfaceProjection.deltaSize } : {}),
          };
        };
        // Once the epoch owner is composed, every local carrier crosses the
        // same fail-closed pre-provider seam. Unsupported or undeclared
        // carriers resolve to unknown+cold inside invocation. Cloud-only cats
        // use a different bounded Host transport before that seam.
        if (defersProjection) {
          contextPromptFactory = async (epochInput) => buildIncrementalProjection(epochInput);
          prompt = '[F296 context projection pending provider preflight]';
        } else {
          const projection = await buildIncrementalProjection();
          prompt = projection.prompt;
          exactPromptMessageIds = [...(projection.promptMessageIds ?? [])];
        }
      } else {
        // Per-cat context budget (Phase 4.0): assemble context with cat-specific limits
        let catContextHistory = contextHistory; // fallback to legacy pre-assembled
        if (history && history.length > 0 && !contextHistory) {
          const inputCeilingTokens = resolvePromptInputCeilingTokens(capacitySnapshot.capacity);
          // F8: token-based budget — estimate non-context tokens, remainder goes to context
          // A+ fix: include catModePrompt + bootstrapContext in system parts estimate (P2-1)
          const catModePromptLegacyForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
          const systemPartsTokens =
            estimateTokens(
              [staticIdentity, invocationContext, catModePromptLegacyForBudget, mcpInstructions]
                .filter(Boolean)
                .join('\n'),
            ) + (rebuildSessionBootstrap ? MAX_SESSION_BOOTSTRAP_TOKENS : estimateTokens(bootstrapContext));
          const promptTokens = estimateTokens([prompt, conciergeSearchContextForCat].filter(Boolean).join('\n'));
          // P1 R7 fix: use shared budget helper (legacy path)
          const legacyNudgeTokens = routeLevelNudgePromptContext ? estimateTokens(routeLevelNudgePromptContext) : 0;
          const budgetForContext = computeContextBudget({
            inputCeilingTokens,
            historyTokenCeiling: deriveHistoryContextTokenCeiling(inputCeilingTokens),
            systemPartsTokens,
            promptTokens,
            nudgeTokens: legacyNudgeTokens,
          });
          const { contextText, messageCount } = assembleContext(history, {
            maxTotalTokens: budgetForContext,
          });
          catContextHistory = contextText || undefined;

          // Degradation check: notify user if context was truncated (count budget or char budget)
          const degradation = detectContextDegradation(history.length, messageCount);
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
        rebuildPromptWithBootstrap = (bootstrap) => {
          if (invocationContext || catModePromptLegacy || mcpInstructions || bootstrap) {
            const parts = [invocationContext, catModePromptLegacy, bootstrap, mcpInstructions].filter(Boolean);
            if (catContextHistory) parts.push(catContextHistory);
            return `${parts.join('\n\n---\n\n')}\n\n---\n\n${invocationMessagePrompt}`;
          }
          return catContextHistory
            ? `${catContextHistory}\n\n---\n\n${invocationMessagePrompt}`
            : invocationMessagePrompt;
        };
        prompt = rebuildPromptWithBootstrap(bootstrapContext);
      }

      if (!incrementalMode) prompt = appendRoutePromptAdditions(prompt);
      const rebuildPromptAfterSessionSeal =
        !defersProjection && rebuildSessionBootstrap && (rebuildPromptWithBootstrap || contextPromptFactory)
          ? async () => {
              const refreshed = await rebuildSessionBootstrap();
              if (!refreshed) {
                log.warn(
                  { catId, threadId },
                  '[routeSerial] session bootstrap rebuild returned no sealed prior; degrading to initial bootstrap context',
                );
              } else {
                bootstrapContext = refreshed.text;
                if (refreshed.pushRecallPresentations?.length) {
                  currentPushRecallPresentations.push(...refreshed.pushRecallPresentations);
                }
              }
              return rebuildPromptWithBootstrap
                ? appendRoutePromptAdditions(rebuildPromptWithBootstrap(bootstrapContext))
                : prompt;
            }
          : undefined;

      if (!incrementalMode) {
        exactPromptMessageIds = collectExactPromptMessageIds(
          options.persistedPromptMessageIds ?? [],
          [currentUserMessageId, a2aTriggerMessageId, streamReplyTo],
          options.freshnessSupplementRequiredMessageIds ?? [],
          options.freshnessClosureRequiredMessageIds ?? [],
        );
      }

      let textContent = '';
      const thinkingChunks: string[] = [];
      let firstMetadata: MessageMetadata | undefined;
      let doneMsg: AgentMessage | undefined;
      let hadError = false;
      /** F155: tracks whether cat produced user-visible output (for guide completion ack). */
      let catProducedOutput = false;
      let turnStoredMessageId: string | undefined;
      let sawUserFacingSystemInfo = false;
      // Issue #1208 P2: collect user-facing system_info payloads so they can be
      // persisted to messageStore even when the cat produces no text/tools/rich.
      // Without this, warnings yielded in the live stream disappear on refresh.
      const userFacingSystemInfoContents: string[] = [];
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
      const pendingToolResults: PendingToolResult[] = [];
      const recordPersistedOutputMessageId = (messageId: string): void => {
        sameRouteOutputMessageIds.add(messageId);
        const persistenceContext = options.persistenceContext;
        if (!persistenceContext) return;
        const existing = persistenceContext.persistedOutputMessageIds ?? [];
        if (existing.includes(messageId)) return;
        persistenceContext.persistedOutputMessageIds = [...existing, messageId];
      };
      // #573/#1332: Keep callback replacement state behind one focused boundary.
      const callbackFinalReplacement = new CallbackFinalReplacementTracker(recordPersistedOutputMessageId);
      let dispatchDispositionToolSettled = false;
      let postDispatchDispositionProgress = false;
      const observePostDispositionProgress = (msg: AgentMessage): void => {
        if (dispatchDispositionToolSettled && isSubstantivePostDispositionProgress(msg)) {
          postDispatchDispositionProgress = true;
        }
      };
      const observeSettledTool = (tool: PendingToolResult | undefined): void => {
        if (tool && normalizeMcpToolName(tool.toolName) === 'complete_a2a_dispatch') {
          dispatchDispositionToolSettled = true;
        }
      };
      const verifiedConciergeToolTargets = new VerifiedConciergeToolTargetCollector();
      const pendingCallbackRoutingExits: CallbackContentRoutingExit[] = [];
      const confirmedCallbackRoutingGuardMentions = new Set<CatId>();
      const confirmedLocalCallbackRoutingMentions = new Set<CatId>();
      const confirmedLocalCallbackRoutedTargets = new Set<CatId>();
      let confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = false;
      let confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = false;
      const emittedBallHandedCvoMessageIds = new Set<string>();
      const acceptedTurnCustodyHandoffs = new Map<string, { targetCatId: CatId; messageId: string }>();
      const noteAcceptedTurnCustodyHandoff = (targetCatId: CatId, messageId: string): void => {
        acceptedTurnCustodyHandoffs.set(`${messageId}:${targetCatId}`, { targetCatId, messageId });
      };
      const emitSingleAcceptedTurnCustodyHandoff = (): void => {
        if (acceptedTurnCustodyHandoffs.size !== 1 || isFreshnessSupplement) return;
        const accepted = [...acceptedTurnCustodyHandoffs.values()][0];
        if (!accepted) return;
        pendingTurnCustodyTransitionWrites.push(
          recordBallHanded(
            deps.ballCustody,
            threadId,
            catId as string,
            accepted.targetCatId as string,
            accepted.messageId,
          ),
        );
      };
      const structuredTargetCats = new Set<string>();
      // F060: Collect rich blocks emitted inline via system_info (not MCP buffer)
      const streamRichBlocks: import('@cat-cafe/shared').RichBlock[] = [];
      // F22 R2 P1-1: Capture own invocationId from stream (not getLatestId)
      let ownInvocationId: string | undefined;
      const initialExecutionKind: TurnExecutionKind = isFreshnessSupplement ? 'freshness_supplement' : 'ordinary';
      const turnExecutionProjectionByInvocation = new Map<string, TurnExecutionMessageProjection>();
      const rememberTurnExecutionProjection = (invocationId: string, executionKind: TurnExecutionKind): void => {
        if (!deps.invocationDeps.turnExecutionStore) return;
        turnExecutionProjectionByInvocation.set(invocationId, {
          invocationId,
          parentInvocationId: options.parentInvocationId ?? invocationId,
          executionKind,
        });
      };
      const collectAuxiliaryTurnExecutions = (
        visibleInvocationId: string | undefined,
        existing: readonly TurnExecutionMessageProjection[] = [],
      ): TurnExecutionMessageProjection[] => {
        const auxiliaryByInvocationId = new Map<string, TurnExecutionMessageProjection>();
        for (const projection of existing) {
          if (projection.invocationId !== visibleInvocationId) {
            auxiliaryByInvocationId.set(projection.invocationId, projection);
          }
        }
        for (const projection of turnExecutionProjectionByInvocation.values()) {
          if (projection.invocationId !== visibleInvocationId) {
            auxiliaryByInvocationId.set(projection.invocationId, projection);
          }
        }
        return [...auxiliaryByInvocationId.values()];
      };
      const projectLiveTurnExecution = (event: AgentMessage): AgentMessage => {
        if (!deps.invocationDeps.turnExecutionStore || !event.invocationId) return event;
        const turnExecution = turnExecutionProjectionByInvocation.get(event.invocationId);
        const auxiliaryTurnExecutions = collectAuxiliaryTurnExecutions(
          event.invocationId,
          event.extra?.auxiliaryTurnExecutions,
        );
        if (!turnExecution && auxiliaryTurnExecutions.length === 0) return event;
        return {
          ...event,
          extra: {
            ...event.extra,
            ...(turnExecution ? { turnExecution } : {}),
            ...(auxiliaryTurnExecutions.length > 0 ? { auxiliaryTurnExecutions } : {}),
          },
        };
      };
      const readTurnExecution = async (invocationId: string | undefined) => {
        if (!invocationId || !deps.invocationDeps.turnExecutionStore) return undefined;
        const emittedProjection = turnExecutionProjectionByInvocation.get(invocationId);
        if (emittedProjection) return emittedProjection;
        try {
          const record = await deps.invocationDeps.turnExecutionStore.get(invocationId);
          return record ? projectTurnExecutionMessage(record) : undefined;
        } catch (error) {
          log.warn(
            { threadId, catId: catId as string, invocationId, err: error },
            'Turn execution projection read failed; preserving visible output without badge metadata',
          );
          return undefined;
        }
      };
      const readTurnExecutionProjections = async (visibleInvocationId: string | undefined) => {
        const turnExecution = await readTurnExecution(visibleInvocationId);
        const auxiliaryTurnExecutions = collectAuxiliaryTurnExecutions(visibleInvocationId);
        if (
          ownInvocationId &&
          ownInvocationId !== visibleInvocationId &&
          !auxiliaryTurnExecutions.some((projection) => projection.invocationId === ownInvocationId)
        ) {
          const ownExecution = await readTurnExecution(ownInvocationId);
          if (ownExecution) auxiliaryTurnExecutions.push(ownExecution);
        }
        return {
          ...(turnExecution ? { turnExecution } : {}),
          ...(auxiliaryTurnExecutions.length > 0 ? { auxiliaryTurnExecutions } : {}),
        };
      };
      const augmentFinalReplacementMessage = async (
        messageId: string,
        visibleTurnInvocationId: string | undefined,
        richBlocks: readonly import('@cat-cafe/shared').RichBlock[],
        replacementMentionsUser: boolean,
      ): Promise<void> => {
        const metadataPatch = buildCallbackFinalReplacementMetadataPatch({
          thinkingChunks,
          ...(firstMetadata ? { metadata: firstMetadata } : {}),
          toolEvents: collectedToolEvents,
          ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
          mentionsUser: replacementMentionsUser,
          richBlocks,
          ...(visibleTurnInvocationId ? { visibleTurnInvocationId } : {}),
          ...((options.parentInvocationId ?? visibleTurnInvocationId)
            ? { persistedInvocationId: options.parentInvocationId ?? visibleTurnInvocationId }
            : {}),
          ...(turnTriggerMessageId ? { turnTriggerMessageId } : {}),
          ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
          executionProjections: await readTurnExecutionProjections(visibleTurnInvocationId),
        });
        if (!hasCallbackFinalReplacementMetadata(metadataPatch)) return;
        try {
          const augmented = await deps.messageStore.augmentStreamMetadata(messageId, metadataPatch);
          if (!augmented) {
            log.warn(
              { threadId, catId: catId as string, callbackMessageId: messageId },
              'Callback message metadata augment skipped: message not found',
            );
          }
        } catch (augmentErr) {
          log.warn(
            { threadId, catId: catId as string, callbackMessageId: messageId, err: augmentErr },
            'Callback message metadata augment failed; continuing without duplicate stream append',
          );
        }
      };
      let eventBackedRoutingExitPromise: ReturnType<typeof resolveEventBackedRoutingExit> | undefined;
      let verifiedEventBackedRoutingExit = false;
      const hasVerifiedEventBackedRoutingExit = async (): Promise<boolean> => {
        eventBackedRoutingExitPromise ??= resolveEventBackedRoutingExit({
          taskStore: deps.taskStore,
          threadId,
          catId: catId as string,
          invocationId: ownInvocationId,
        });
        const resolution = await eventBackedRoutingExitPromise;
        if (resolution.kind === 'reject') {
          routingEventWaitRejectedTotal.add(1, { [ROUTING_EVENT_WAIT_REASON]: resolution.reason });
          return false;
        }
        if (
          !isEventBackedRoutingBypassProofValid(resolution, {
            threadId,
            catId: catId as string,
            invocationId: ownInvocationId,
          })
        ) {
          routingEventWaitFalseBypassTotal.add(1);
          routingEventWaitRejectedTotal.add(1, { [ROUTING_EVENT_WAIT_REASON]: 'proof_invalid' });
          return false;
        }
        routingEventWaitBypassTotal.add(1);
        routingEventWaitRedundantHoldPreventedTotal.add(1);
        verifiedEventBackedRoutingExit = true;
        return true;
      };
      let visibleContentInvocationIdOverride: string | undefined;
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
      const emitThrottledBallInvocationHeartbeat = (draftUpdatedAt: number): void => {
        if (isFreshnessSupplement) return;
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
        if (exit.scope === 'local') {
          // The callback already admitted this source/target through InvocationQueue or the
          // legacy worklist. Never reinterpret the same persisted callback body as a fresh
          // serial handoff after that carrier has already completed and disappeared from the
          // live queue: that callback+text-scan fork caused the exact A→B duplicate dogfood.
          for (const targetCatId of exit.targetCatIds) confirmedLocalCallbackRoutedTargets.add(targetCatId);
        }
        if (exit.hasGuardCoCreatorLineStartMention) confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = true;
        if (exit.hasLocalCoCreatorLineStartMention) confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = true;
        return exit;
      };
      const getRoutingExitLineStartMentions = (textMentions: readonly CatId[] = []): CatId[] => [
        ...new Set<CatId>([...textMentions, ...confirmedCallbackRoutingGuardMentions]),
      ];
      const getLocalRoutingLineStartMentions = (textMentions: readonly CatId[] = []): CatId[] =>
        [...new Set<CatId>([...textMentions, ...confirmedLocalCallbackRoutingMentions])].filter(
          (targetCatId) => !confirmedLocalCallbackRoutedTargets.has(targetCatId),
        );
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
        if (isFreshnessSupplement) return;
        if (!messageId || !eventThreadId) return;
        const eventKey = `${eventThreadId}:${messageId}`;
        if (emittedBallHandedCvoMessageIds.has(eventKey)) return;
        emittedBallHandedCvoMessageIds.add(eventKey);
        pendingTurnCustodyTransitionWrites.push(
          emitBallHandedCvo(deps.ballCustody, eventThreadId, catId as string, messageId),
        );
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
        const projectedMsg = projectLiveTurnExecution(ownStampedMsg);
        return projectedMsg.type === 'text'
          ? {
              ...projectedMsg,
              origin: 'stream' as const,
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              ...(streamReplyPreview ? { replyPreview: streamReplyPreview } : {}),
            }
          : projectedMsg;
      };
      // The caller may extend this worklist only while its route turn is live. Keeping the
      // window closed through prompt/session setup also rejects stale callbacks from an earlier
      // occurrence of the same cat in this parent chain.
      setWorklistCallerAdmissionOpen(worklistEntry, true);
      for await (const msg of invokeSingleCat(deps.invocationDeps, {
        catId,
        service,
        capacitySnapshot,
        sessionPolicySnapshot,
        prompt,
        ...(contextPromptFactory ? { contextPromptFactory } : {}),
        ...(rebuildPromptAfterSessionSeal ? { rebuildPromptAfterSessionSeal } : {}),
        userId,
        ownerAuthProvenance,
        threadId,
        invocationOrigin: resolveInvocationOrigin(options.humanDispositionInvocationOrigin),
        routeTopology: 'serial',
        ...(targetContentBlocks ? { contentBlocks: targetContentBlocks } : {}),
        ...(targetUploadDir ? { uploadDir: targetUploadDir } : {}),
        ...(catSignal ? { signal: catSignal } : {}),
        ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
        ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
        continuityCapsule,
        ...(memoryCueOpportunitySeeds.length > 0 ? { memoryCueOpportunitySeeds } : {}),
        ...(options.asrPersonMemoryScenes?.length ? { asrPersonMemoryScenes: options.asrPersonMemoryScenes } : {}),
        ...(memoryCueLegacyFallbacks.length > 0 ? { memoryCueLegacyFallbacks } : {}),
        ...(options.toolExecutionPolicy ? { toolExecutionPolicy: options.toolExecutionPolicy } : {}),
        executionKind: initialExecutionKind,
        executionCausal: {
          ...((streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId)
            ? { triggerMessageId: streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId }
            : {}),
          ...(options.freshnessSupplementId ? { freshnessSupplementId: options.freshnessSupplementId } : {}),
        },
        promptMessageIds: exactPromptMessageIds,
        ...(options.onPromptMessagesExposed
          ? {
              onPromptMessagesExposed: async (input) => {
                const adoptedWakes = await options.onPromptMessagesExposed!(input);
                if (adoptedWakes) await adoptTurnCustodyWakes(adoptedWakes);
                return adoptedWakes;
              },
            }
          : {}),
        // F247 AC-B1c-3 PR-C: Plumb raw mention text + mentioning cat for cloud bridge dispatch.
        // - mentionContent: the raw user/cat message (NOT the orchestrated prompt with system context)
        // - mentioningCatId: A2A → the cat that @ mentioned; user-initiated → userId as fallback
        //   so the cloud cat knows "who called" (gpt52 R1 P1-2 contract: calledBy ≠ thread owner)
        mentionContent: message,
        mentioningCatId: (directMessageFrom ?? userId) as import('@cat-cafe/shared').CatId,
        // F121/F167: Keep stream threading and callback auth provenance on the same trigger.
        ...(streamReplyTo ? { a2aTriggerMessageId: streamReplyTo } : {}),
        ...((mentionParentSpan.get(index) ?? options.routeSpan)
          ? { routeSpan: mentionParentSpan.get(index) ?? options.routeSpan }
          : {}),
        invocationSpanRef,
        isLastCat: false,
      })) {
        // F39 bugfix: stop yielding after cancel (pipe buffer may still drain)
        if (catSignal?.aborted) break;
        if (isFinalGenerationBriefingBoundary(msg)) await materializeFinalGenerationBriefing();
        while (pendingContextProjectionMessages.length > 0) {
          const pendingMessage = pendingContextProjectionMessages.shift();
          if (pendingMessage) yield pendingMessage;
        }

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
          observePostDispositionProgress(effectiveMsg);
          // F22 R2 P1-1: Capture invocationId from the initial system_info.
          // Keep forwarding this boundary event so frontend can reset stale task progress.
          if (effectiveMsg.type === 'system_info' && effectiveMsg.content && !ownInvocationId) {
            try {
              const parsed = JSON.parse(effectiveMsg.content);
              if (
                parsed.type === 'invocation_created' &&
                typeof parsed.invocationId === 'string' &&
                parsed.invocationId.length > 0
              ) {
                ownInvocationId = parsed.invocationId;
                unregisterTurnCustodyAdoption = turnCustodyAdoptionRegistry.register(
                  parsed.invocationId,
                  adoptTurnCustodyWakes,
                );
                rememberTurnExecutionProjection(parsed.invocationId, initialExecutionKind);
                if (!isFreshnessSupplement) {
                  emitBallInvocationStarted(deps.ballCustody, threadId, ownInvocationId, catId as string);
                }
                // F111 Phase B: Start streaming TTS when we have an invocationId.
                if (voiceMode) {
                  voiceChunker = createVoiceChunker(ownInvocationId!);
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
            voiceChunker?.feed(effectiveMsg.content);
          }
          // F045: Accumulate thinking blocks for persistence (F5 recovery)
          if (effectiveMsg.type === 'system_info' && effectiveMsg.content) {
            if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
              sawUserFacingSystemInfo = true;
              userFacingSystemInfoContents.push(effectiveMsg.content);
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
          verifiedConciergeToolTargets.observe(effectiveMsg);

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
              ...(isPostMessageToolName(effectiveMsg.toolName)
                ? { streamDisposition: readCallbackStreamDisposition(effectiveMsg.toolInput) }
                : {}),
            });
            const callbackExit = collectCallbackContentRoutingExit(
              effectiveMsg.toolName,
              effectiveMsg.toolInput,
              catId,
              effectiveMsg.toolUseId,
            );
            if (callbackExit) pendingCallbackRoutingExits.push(callbackExit);
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
            observeSettledTool(completedToolName);
            if (completedToolName && isPostMessageToolName(completedToolName.toolName) && callbackResult.confirmed) {
              callbackFinalReplacement.recordConfirmedPost(
                completedToolName.streamDisposition ?? 'independent',
                callbackResult,
              );
            }
            if (completedToolName) {
              const settledExit = settleCallbackRoutingExit(completedToolName, callbackResult.confirmed);
              emitConfirmedCallbackBallHandedCvo(
                callbackResult.confirmed,
                settledExit,
                callbackResult.messageId,
                callbackResult.threadId,
              );
              if (
                callbackResult.confirmed &&
                callbackResult.messageId &&
                settledExit?.scope === 'target' &&
                settledExit.createsCustodyHandoff &&
                settledExit.targetCatIds.length === 1
              ) {
                noteAcceptedTurnCustodyHandoff(settledExit.targetCatIds[0]!, callbackResult.messageId);
              }
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
            yield streamEvent;
          }
        }
      }

      // Issue #83: Stop keepalive timer — streaming loop has exited.
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }

      // F167 Phase S: this is the single route-side visibility barrier. The
      // callback records the holder outcome with the durable CAS; nothing below
      // may enqueue, persist, mutate thread state, synthesize visible output, or
      // broadcast until it succeeds.
      const actionOutputCommitAllowed = options.beforeOutputCommit ? await options.beforeOutputCommit(catId) : true;

      // F215 AC-C3: push opus-4.6 to worklist as relay when 48 炸毛 + fresh retry also failed
      if (actionOutputCommitAllowed && malformedRelayPending) {
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
      } else if (malformedRelayPending) {
        malformedRelayPending = false;
      }

      if (voiceChunker) {
        // F111 Phase B: Flush remaining buffered text and send voice_stream_end.
        // Guard-enabled turns do not create this first-pass chunker; their voice is flushed
        // only after routing validation below.
        if (actionOutputCommitAllowed) await flushVoiceChunker(voiceChunker, ownInvocationId);
        voiceChunker = undefined;
      }

      let a2aMentions: CatId[] = [];

      // F22: Consume MCP-buffered rich blocks BEFORE the text/empty branch —
      // blocks must be persisted even when the cat emits no text (cloud Codex P1).
      const bufferedBlocks = getRichBlockBuffer().consume(threadId, catId as string, ownInvocationId);

      // F061: Detect @co-creator mentions in agent response for browser notification
      let mentionsUser = false;

      const appendStopGateFailureNotice = async () => {
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
            content:
              '[F167 球权停止门]: 结构化补救后，当前协议球仍没有可验证状态迁移；已停止自动重试并保留原球权真相。',
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
          /* non-blocking stop-gate failure notice */
        }
      };

      const observeLegacyRoutingBlock = (input: Parameters<typeof observesLegacyRoutingBlock>[0]): boolean => {
        if (
          hasTerminalCoordinationExit &&
          observesLegacyRoutingBlock({ ...input, hasTerminalCoordinationExit: false })
        ) {
          routingTerminalReleaseCleanStopTotal.add(1);
        }
        return observesLegacyRoutingBlock({ ...input, hasTerminalCoordinationExit });
      };

      const scheduleTurnCustodyStopGate = async (legacyObservedBlock: boolean): Promise<void> => {
        if (turnCustodyShadowRecorded || !turnCustodyProjection || !deps.turnCustodyProjectionService) return;
        turnCustodyShadowRecorded = true;
        const projection = turnCustodyProjection;
        const sampleMessageId = turnTriggerMessageId ?? options.currentUserMessageId;
        const wakeProvenance =
          turnCustodyWake.kind === 'structured'
            ? `structured:${turnCustodyWake.protocol}`
            : turnCustodyWake.kind === 'unstructured'
              ? `unstructured:${turnCustodyWake.source}`
              : turnCustodyWake.kind === 'non_obligation'
                ? `non_obligation:${turnCustodyWake.source}`
                : turnCustodyWake.kind === 'legacy'
                  ? `legacy:${turnCustodyWake.reason}`
                  : 'action_successor';
        const sourceSemantic = turnCustodySourceSemantic({
          terminalCoordination: hasTerminalCoordinationExit,
          ...(crossThreadReplyHint?.effectClass ? { effectClass: crossThreadReplyHint.effectClass } : {}),
        });
        pendingTurnCustodyShadowCloses.push(async (closeCheckpoint) => {
          const verifiedEventWait =
            projection.state === 'covered_active' ? await hasVerifiedEventBackedRoutingExit() : false;
          const rawDecision = await deps.turnCustodyProjectionService!.close(projection);
          const newDecision =
            verifiedEventWait && rawDecision.state === 'covered_active'
              ? {
                  ...rawDecision,
                  shouldBlock: false,
                  transitionObserved: true,
                  evidenceRefs: [...rawDecision.evidenceRefs, 'event_wait:verified'],
                }
              : rawDecision;
          if (
            turnCustodyWake.kind === 'structured' &&
            turnCustodyWake.protocol === 'hold' &&
            newDecision.transitionObserved &&
            newDecision.structuredTransitionKind !== 'hold_dispositioned'
          ) {
            const transition = verifiedEventWait
              ? 'event_wait'
              : newDecision.structuredTransitionKind === 'held'
                ? 'reheld'
                : newDecision.structuredTransitionKind === 'handed'
                  ? 'transferred'
                  : undefined;
            if (transition) {
              recordTurnCustodyTerminalWitness({
                kind: 'managed_hold_continued',
                sourceMessageId: turnCustodyWake.sourceMessageId,
                taskId: turnCustodyWake.taskId,
                transition,
              });
            }
          }
          if (
            turnCustodyWake.kind === 'structured' &&
            turnCustodyWake.protocol === 'dispatch' &&
            newDecision.transitionObserved &&
            newDecision.structuredTransitionKind === 'dispatch_dispositioned' &&
            newDecision.dispatchDisposition === 'handled' &&
            dispatchDispositionToolSettled &&
            !postDispatchDispositionProgress &&
            newDecision.dispatchDispositionEventId &&
            newDecision.dispatchDispositionAt !== undefined
          ) {
            recordTurnCustodyTerminalWitness({
              kind: 'dispatch_handled_continuation',
              sourceMessageId: turnCustodyWake.handoff.messageId,
              dispositionEventId: newDecision.dispatchDispositionEventId,
              dispositionAt: newDecision.dispatchDispositionAt,
            });
          }
          if (
            newDecision.state === 'covered_empty' &&
            turnCustodyWake.kind === 'non_obligation' &&
            turnCustodyWake.source === 'coordination_terminal'
          ) {
            recordTurnCustodyTerminalWitness({
              kind: 'terminal_silent',
              projectionState: 'covered_empty',
              wake: 'coordination_terminal',
            });
          }
          const comparison = compareTurnCustodyShadow(legacyObservedBlock, newDecision.shouldBlock);
          const projectionReason = turnCustodyProjectionReason(newDecision.evidenceRefs);
          const sourceCategory = boundedTurnCustodySourceCategory(turnCustodyWakeSourceCategory(turnCustodyWake));
          const boundedSourceSemantic = boundedTurnCustodySourceSemantic(sourceSemantic);
          const classification = classifyTurnCustodyNewOnlyBlock({
            comparison,
            state: newDecision.state,
            projectionReason,
            sourceCategory,
            sourceSemantic: boundedSourceSemantic,
            wakeProvenance,
            closeCheckpoint,
            transitionObserved: newDecision.transitionObserved,
          });
          turnCustodyProjectionTotal.add(1, { [TURN_CUSTODY_METRIC_STATE_ATTR]: newDecision.state });
          turnCustodyShadowComparisonTotal.add(1, {
            [TURN_CUSTODY_METRIC_COMPARISON_ATTR]: comparison,
            [TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR]: classification,
          });
          if (legacyObservedBlock) turnCustodyShadowOldBlockTotal.add(1);
          if (newDecision.shouldBlock) turnCustodyShadowNewBlockTotal.add(1);
          if (legacyObservedBlock && newDecision.state === 'covered_empty') {
            legacyGuardWithoutActiveCustodyTotal.add(1);
          }
          const traceEventName =
            comparison === 'old_only_block' || comparison === 'new_only_block'
              ? TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME
              : comparison === 'agree_block' && newDecision.state === 'unknown_legacy'
                ? TURN_CUSTODY_UNKNOWN_AGREE_BLOCK_EVENT_NAME
                : undefined;
          if (traceEventName && sampleMessageId) {
            try {
              const parentSpan = options.routeSpan ?? invocationSpanRef.current;
              const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : context.active();
              const sampleSpan = trace
                .getTracer('cat-cafe-api', '0.1.0')
                .startSpan(TURN_CUSTODY_SHADOW_SAMPLE_SPAN, undefined, parentCtx);
              sampleSpan.addEvent(traceEventName, {
                messageId: sampleMessageId,
                invocationId: ownInvocationId ?? 'unknown',
                threadId,
                [AGENT_ID]: catId as string,
                [THREAD_SYSTEM_KIND]: routeThread?.systemKind ?? 'product',
                [TRIGGER]: comparison,
                [TURN_CUSTODY_PROJECTION_STATE_ATTR]: newDecision.state,
                [TURN_CUSTODY_CLOSE_CHECKPOINT_ATTR]: closeCheckpoint,
                [TURN_CUSTODY_WAKE_PROVENANCE_ATTR]: wakeProvenance,
                [TURN_CUSTODY_TRANSITION_OBSERVED_ATTR]: String(newDecision.transitionObserved),
                [TURN_CUSTODY_PROJECTION_REASON_ATTR]: projectionReason,
                [TURN_CUSTODY_SOURCE_CATEGORY_ATTR]: sourceCategory,
                [TURN_CUSTODY_SOURCE_SEMANTIC_ATTR]: boundedSourceSemantic,
              });
              sampleSpan.end();
            } catch {
              /* best-effort sample emission */
            }
          }
          log.info(
            {
              threadId,
              catId: catId as string,
              state: newDecision.state,
              comparison,
              closeCheckpoint,
              wakeProvenance,
              transitionObserved: newDecision.transitionObserved,
              projectionReason,
              sourceCategory,
              sourceSemantic: boundedSourceSemantic,
              classification,
              evidenceRefs: newDecision.evidenceRefs,
            },
            'F167 Phase T turn-custody stop-gate verdict',
          );

          let adoptedStructuredDispositionBlocked = false;
          for (const adopted of adoptedTurnCustodyProjections) {
            const adoptedDecision = await deps.turnCustodyProjectionService!.close(adopted.projection);
            const transition =
              adoptedDecision.structuredTransitionKind === 'held'
                ? 'reheld'
                : adoptedDecision.structuredTransitionKind === 'handed'
                  ? 'transferred'
                  : undefined;
            if (adoptedDecision.transitionObserved && transition) {
              recordTurnCustodyTerminalWitness({
                kind: 'managed_hold_continued',
                sourceMessageId: adopted.wake.sourceMessageId,
                taskId: adopted.wake.taskId,
                transition,
              });
            }
            adoptedStructuredDispositionBlocked = adoptedDecision.shouldBlock || adoptedStructuredDispositionBlocked;
            log.info(
              {
                threadId,
                catId: catId as string,
                sourceMessageId: adopted.wake.sourceMessageId,
                taskId: adopted.wake.taskId,
                state: adoptedDecision.state,
                closeCheckpoint,
                transitionObserved: adoptedDecision.transitionObserved,
                evidenceRefs: adoptedDecision.evidenceRefs,
              },
              'F167 adopted managed-hold stop-gate verdict',
            );
          }

          if (
            (!newDecision.shouldBlock && !adoptedStructuredDispositionBlocked) ||
            hadError ||
            !actionOutputCommitAllowed ||
            isFreshnessSupplement ||
            stopGateRemedialAttempted
          ) {
            return;
          }

          // The exact F254 body exposure belongs to the invocation that just
          // finished. A routing-guard child has different callback credentials,
          // so omission must fail this attempt and restore the same Queue carrier
          // instead of letting a second invocation impersonate its disposition.
          if (
            turnCustodyWake.kind === 'structured' &&
            (turnCustodyWake.protocol === 'hold' || turnCustodyWake.protocol === 'dispatch')
          ) {
            stopGateRemedialAttempted = true;
            structuredDispositionMissingCode =
              turnCustodyWake.protocol === 'hold'
                ? 'managed_hold_disposition_missing'
                : 'a2a_dispatch_disposition_missing';
            await appendStopGateFailureNotice();
            return;
          }

          if (adoptedStructuredDispositionBlocked) {
            stopGateRemedialAttempted = true;
            structuredDispositionMissingCode = 'managed_hold_disposition_missing';
            await appendStopGateFailureNotice();
            return;
          }

          const originalOwnInvocationId = ownInvocationId;
          const originalDoneMsg = doneMsg;
          const originalTextContent = textContent;
          const originalFirstMetadata = firstMetadata;
          try {
            await runTurnCustodyStopGateRemedial('', [], []);
            emitSingleAcceptedTurnCustodyHandoff();
            const remedialTransitionWrites = pendingTurnCustodyTransitionWrites.splice(0);
            if (remedialTransitionWrites.length > 0) {
              await Promise.allSettled(remedialTransitionWrites);
            }
            const remediatedDecision = await deps.turnCustodyProjectionService!.close(projection);
            if (remediatedDecision.shouldBlock) {
              await appendStopGateFailureNotice();
            }
            if (turnStoredMessageId && deps.invocationDeps.turnExecutionStore) {
              const projections = await readTurnExecutionProjections(originalOwnInvocationId);
              if (Object.keys(projections).length > 0) {
                await deps.messageStore.augmentStreamMetadata(turnStoredMessageId, { extra: projections });
              }
            }
          } finally {
            ownInvocationId = originalOwnInvocationId;
            doneMsg = originalDoneMsg;
            textContent = originalTextContent;
            firstMetadata = originalFirstMetadata;
          }
        });
      };

      const runTurnCustodyStopGateRemedial = async (
        originalStoredContentBeforeRemedial: string,
        originalRichBlocksBeforeRemedial: RichBlock[],
        originalToolEventsBeforeRemedial: StoredToolEvent[],
      ): Promise<{
        storedContent: string;
        routingContent: string;
        allRichBlocks: RichBlock[];
        a2aMentions: CatId[];
        hasCoCreatorLineStartMention: boolean;
        hasLocalCoCreatorLineStartMention: boolean;
        streamEvents: AgentMessage[];
      }> => {
        stopGateRemedialAttempted = true;
        const originalVisibleInvocationIdBeforeRemedial = ownInvocationId;
        const originalDeferredVoiceInvocationIdBeforeRemedial = deferredVoiceInvocationId;
        const originalDeferredVoiceTextChunksBeforeRemedial = [...deferredVoiceTextChunks];
        const originalToolNamesBeforeRemedial = [...collectedToolNames];
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
        verifiedConciergeToolTargets.reset();
        pendingCallbackRoutingExits.splice(0, pendingCallbackRoutingExits.length);
        confirmedCallbackRoutingGuardMentions.clear();
        confirmedLocalCallbackRoutingMentions.clear();
        confirmedCallbackRoutingGuardHasCoCreatorLineStartMention = false;
        confirmedLocalCallbackRoutingHasCoCreatorLineStartMention = false;
        callbackFinalReplacement.reset();
        ownInvocationId = undefined;

        const remedialStreamEvents: AgentMessage[] = [];
        const remedialStripper = createLeakedToolCallStreamStripper();
        const remedialService = getService(deps.services, catId);
        const resolvedRemedialCapacitySnapshot = await resolveInvocationCapacitySnapshot({
          catId,
          service: remedialService,
        });
        let remedialCapacitySnapshot = resolvedRemedialCapacitySnapshot;
        const turnCustodyRemedialPrompt = buildTurnCustodyStopGateRemedialPrompt(turnCustodyWake);
        const rebuildRemedialPromptAfterSessionSeal = rebuildSessionBootstrap
          ? async () => {
              const refreshed = await rebuildSessionBootstrap();
              if (!refreshed) {
                log.warn(
                  { catId, threadId },
                  '[routeSerial] remedial session bootstrap rebuild returned no sealed prior; degrading to bare remedial prompt',
                );
                return turnCustodyRemedialPrompt;
              }
              if (refreshed.pushRecallPresentations?.length) {
                currentPushRecallPresentations.push(...refreshed.pushRecallPresentations);
              }
              return `${refreshed.text}\n\n---\n\n${turnCustodyRemedialPrompt}`;
            }
          : undefined;
        let remedialPrompt = turnCustodyRemedialPrompt;
        remedialCapacitySnapshot = await applyActiveSessionCapacityPin({
          snapshot: remedialCapacitySnapshot,
          catId,
          threadId,
          userId,
          sessionChainStore: deps.invocationDeps.sessionChainStore,
        });
        const remedialSessionPolicySnapshot = resolveManagedSessionPolicySnapshot({
          catId: catId as string,
          evidence: {
            capacitySnapshot: remedialCapacitySnapshot,
            // Remedial invocations own a fresh evidence epoch too.
            authoritativeUsage: false,
            sessionRotation: Boolean(deps.invocationDeps.sessionChainStore && deps.invocationDeps.sessionSealer),
            continuityBootstrap: Boolean(rebuildRemedialPromptAfterSessionSeal),
          },
        });
        const sealed = await sealBeforeInvocationIfNeeded({
          snapshot: remedialCapacitySnapshot,
          catId,
          threadId,
          userId,
          sessionChainStore: deps.invocationDeps.sessionChainStore,
          sessionSealer: deps.invocationDeps.sessionSealer,
          policySnapshot: remedialSessionPolicySnapshot,
          clearProviderSession: () => deps.invocationDeps.sessionManager.delete(userId, catId, threadId),
        });
        if (sealed) {
          remedialCapacitySnapshot = resolvedRemedialCapacitySnapshot;
          if (!rebuildRemedialPromptAfterSessionSeal) {
            throw new Error('pre_invocation_capacity_seal_requires_prompt_rebuild');
          }
          remedialPrompt = await rebuildRemedialPromptAfterSessionSeal();
        }
        for await (const remedialMsg of invokeSingleCat(deps.invocationDeps, {
          catId,
          service: remedialService,
          capacitySnapshot: remedialCapacitySnapshot,
          sessionPolicySnapshot: remedialSessionPolicySnapshot,
          prompt: remedialPrompt,
          ...(rebuildRemedialPromptAfterSessionSeal
            ? { rebuildPromptAfterSessionSeal: rebuildRemedialPromptAfterSessionSeal }
            : {}),
          userId,
          ownerAuthProvenance,
          threadId,
          invocationOrigin: resolveInvocationOrigin(options.humanDispositionInvocationOrigin),
          routeTopology: 'serial',
          ...(catSignal ? { signal: catSignal } : {}),
          ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
          ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
          continuityCapsule,
          ...(streamReplyTo ? { a2aTriggerMessageId: streamReplyTo } : {}),
          ...((mentionParentSpan.get(index) ?? options.routeSpan)
            ? { routeSpan: mentionParentSpan.get(index) ?? options.routeSpan }
            : {}),
          invocationSpanRef,
          ...(options.toolExecutionPolicy ? { toolExecutionPolicy: options.toolExecutionPolicy } : {}),
          executionKind: 'routing_guard',
          executionCausal: {
            ...((streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId)
              ? { triggerMessageId: streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId }
              : {}),
            routingGuardReason: 'missing_routing_exit',
          },
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
            observePostDispositionProgress(effectiveMsg);
            if (effectiveMsg.type === 'system_info' && effectiveMsg.content && !ownInvocationId) {
              try {
                const parsed = JSON.parse(effectiveMsg.content);
                if (
                  parsed.type === 'invocation_created' &&
                  typeof parsed.invocationId === 'string' &&
                  parsed.invocationId.length > 0
                ) {
                  ownInvocationId = parsed.invocationId;
                  rememberTurnExecutionProjection(parsed.invocationId, 'routing_guard');
                  if (!isFreshnessSupplement) {
                    emitBallInvocationStarted(deps.ballCustody, threadId, ownInvocationId, catId as string);
                  }
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
                userFacingSystemInfoContents.push(effectiveMsg.content);
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
            verifiedConciergeToolTargets.observe(effectiveMsg);

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
                ...(isPostMessageToolName(effectiveMsg.toolName)
                  ? { streamDisposition: readCallbackStreamDisposition(effectiveMsg.toolInput) }
                  : {}),
              });
              const callbackExit = collectCallbackContentRoutingExit(
                effectiveMsg.toolName,
                effectiveMsg.toolInput,
                catId,
                effectiveMsg.toolUseId,
              );
              if (callbackExit) pendingCallbackRoutingExits.push(callbackExit);
            }
            if (effectiveMsg.type === 'tool_result') {
              const callbackResult = parseCallbackPostResult(effectiveMsg.content);
              const completedToolName = consumePendingToolResult(
                pendingToolResults,
                effectiveMsg,
                callbackResult.confirmed,
                Boolean(callbackResult.messageId && callbackResult.threadId),
              );
              observeSettledTool(completedToolName);
              if (completedToolName && isPostMessageToolName(completedToolName.toolName) && callbackResult.confirmed) {
                callbackFinalReplacement.recordConfirmedPost(
                  completedToolName.streamDisposition ?? 'independent',
                  callbackResult,
                );
              }
              if (completedToolName) {
                const settledExit = settleCallbackRoutingExit(completedToolName, callbackResult.confirmed);
                emitConfirmedCallbackBallHandedCvo(
                  callbackResult.confirmed,
                  settledExit,
                  callbackResult.messageId,
                  callbackResult.threadId,
                );
                if (
                  callbackResult.confirmed &&
                  callbackResult.messageId &&
                  settledExit?.scope === 'target' &&
                  settledExit.createsCustodyHandoff &&
                  settledExit.targetCatIds.length === 1
                ) {
                  noteAcceptedTurnCustodyHandoff(settledExit.targetCatIds[0]!, callbackResult.messageId);
                }
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
        // The structured stop gate never treats remedial prose as custody truth or user-visible
        // replacement content. Only confirmed tool results may close the projection.
        const preservesOriginalVisibleContent =
          originalStoredContentBeforeRemedial.length > 0 ||
          originalToolEventsBeforeRemedial.length > 0 ||
          originalRichBlocksBeforeRemedial.length > 0;
        visibleContentInvocationIdOverride = preservesOriginalVisibleContent
          ? originalVisibleInvocationIdBeforeRemedial
          : undefined;
        const remedialStoredContent = preservesOriginalVisibleContent
          ? originalStoredContentBeforeRemedial
          : remedialCleanText;
        const remedialRoutingContent = '';
        const baseRichBlocks = preservesOriginalVisibleContent ? originalRichBlocksBeforeRemedial : [];
        // When preserving first-pass content, drop ALL remedial-produced rich blocks.
        // streamRichBlocks was cleared before remedial (line ~1875) and re-populated only
        // from remedial streaming; remedialExtracted.blocks come from remedial text.
        // Both are orphaned context from hidden remedial prose — the remedial turn is
        // an exit patch, not a revised answer.
        let remedialAllRichBlocks = preservesOriginalVisibleContent
          ? [...baseRichBlocks]
          : [...baseRichBlocks, ...remedialExtracted.blocks, ...streamRichBlocks];
        // Replacement text becomes a new persisted message and discards invalid first-pass evidence.
        // Exit-only remedials keep the original visible content, so preserve original tool evidence too.
        if (preservesOriginalVisibleContent && originalToolEventsBeforeRemedial.length > 0) {
          const remedialToolEvents = [...collectedToolEvents];
          const remedialToolNames = [...collectedToolNames];
          collectedToolEvents.splice(
            0,
            collectedToolEvents.length,
            ...originalToolEventsBeforeRemedial,
            ...remedialToolEvents,
          );
          collectedToolNames.splice(
            0,
            collectedToolNames.length,
            ...originalToolNamesBeforeRemedial,
            ...remedialToolNames,
          );
        }
        textContent = remedialStoredContent;
        // When preserving first-pass content, always clear remedial voice chunks so
        // hidden remedial prose (e.g. "好的，我来传球") is never spoken. Then restore
        // original voice chunks if the first pass had any text to speak.
        if (preservesOriginalVisibleContent) {
          resetDeferredVoice();
          if (originalDeferredVoiceTextChunksBeforeRemedial.length > 0) {
            deferredVoiceInvocationId = originalDeferredVoiceInvocationIdBeforeRemedial;
            deferredVoiceTextChunks.push(...originalDeferredVoiceTextChunksBeforeRemedial);
          }
        }

        if (!voiceMode) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && remedialAllRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              remedialAllRichBlocks = await voiceSynth.resolveVoiceBlocks(remedialAllRichBlocks, catId as string);
            } catch (err) {
              log.error({ catId: catId as string, err }, 'Voice block synthesis failed for custody stop-gate remedial');
            }
          }
        }

        const remedialA2aMentions: CatId[] = [];
        const remedialHasCoCreatorLineStartMention = false;
        const remedialHasLocalCoCreatorLineStartMention = false;
        const isRemedialLifecycleBoundary = (event: AgentMessage): boolean => {
          if (event.type !== 'system_info' || !event.content) return false;
          try {
            const parsed = JSON.parse(event.content);
            return parsed.type === 'invocation_created';
          } catch {
            return false;
          }
        };
        // Structured remediation is hidden auxiliary execution. Its lifecycle/tool evidence remains
        // inspectable, while prose and rich output never become a second visible answer.
        const isRemedialRichBlockStreamEvent = (event: AgentMessage): boolean => {
          if (event.type !== 'system_info' || !event.content) return false;
          try {
            return JSON.parse(event.content).type === 'rich_block';
          } catch {
            return false;
          }
        };
        const visibleRemedialSourceStreamEvents = remedialStreamEvents.filter(
          (event) => event.type !== 'text' && !isRemedialRichBlockStreamEvent(event),
        );
        const visibleRemedialEvidenceStreamEvents: AgentMessage[] = [];
        const remedialLifecycleStreamEvents: AgentMessage[] = [];
        for (const event of visibleRemedialSourceStreamEvents) {
          if (
            preservesOriginalVisibleContent &&
            originalVisibleInvocationIdBeforeRemedial &&
            isRemedialLifecycleBoundary(event)
          ) {
            remedialLifecycleStreamEvents.push(event);
            continue;
          }
          visibleRemedialEvidenceStreamEvents.push(
            preservesOriginalVisibleContent && originalVisibleInvocationIdBeforeRemedial
              ? { ...event, invocationId: originalVisibleInvocationIdBeforeRemedial }
              : event,
          );
        }
        // Stream replay for preserved content: use the STORED (post-extraction) content rather than
        // raw buffered text events, so Route B cc_rich fences don't leak into the live stream.
        // For tool-only or rich-only first passes where stored content is '', emit no text events.
        const originalVisibleStreamEventsForRemedialTurn = preservesOriginalVisibleContent
          ? originalStoredContentBeforeRemedial
            ? [
                {
                  type: 'text' as AgentMessageType,
                  catId,
                  content: originalStoredContentBeforeRemedial,
                  invocationId: originalVisibleInvocationIdBeforeRemedial ?? undefined,
                  timestamp: Date.now(),
                } as AgentMessage,
              ]
            : []
          : [];

        const streamEvents = preservesOriginalVisibleContent
          ? [
              ...originalVisibleStreamEventsForRemedialTurn,
              ...visibleRemedialEvidenceStreamEvents,
              ...remedialLifecycleStreamEvents,
            ]
          : remedialStreamEvents;

        return {
          storedContent: remedialStoredContent,
          routingContent: remedialRoutingContent,
          allRichBlocks: remedialAllRichBlocks,
          a2aMentions: remedialA2aMentions,
          hasCoCreatorLineStartMention: remedialHasCoCreatorLineStartMention,
          hasLocalCoCreatorLineStartMention: remedialHasLocalCoCreatorLineStartMention,
          // Exit-only remedials validate preserved content instead of replacing it; replay the visible
          // text and routing-exit evidence before the remedial boundary can replace that turn.
          streamEvents: streamEvents.map(projectLiveTurnExecution),
        };
      };

      const noTextLegacyObservedBlock = Boolean(
        actionOutputCommitAllowed &&
          !isFreshnessSupplement &&
          !textContent &&
          !hadError &&
          observeLegacyRoutingBlock({
            lineStartMentions: getRoutingExitLineStartMentions(),
            toolNames: collectedToolNames,
            structuredTargetCats: [...structuredTargetCats],
            hasCoCreatorLineStartMention: hasRoutingExitCoCreatorLineStartMention(''),
          }),
      );
      if (!textContent) await scheduleTurnCustodyStopGate(noTextLegacyObservedBlock);

      // F254 Phase D: declared at for-loop level so both textContent branch
      // (stream store) and post-B3 forced re-invoke can access it
      let streamFreshnessResult: StreamFreshnessResult | undefined;
      let outputCommitDecision: OutputCommitDecision | undefined;
      const evaluateCurrentStreamFreshness = async (
        priorFrontierMessageId: string | null,
      ): Promise<FreshnessEvaluation> => {
        const freshness = await checkStreamOutputFreshness({
          userId,
          catId: catId as string,
          threadId,
          currentTriggerMessageId: streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId,
          parallelBatchId: options.parallelBatchId,
          coveredMessageIds: exactPromptMessageIds,
          throughMessageId: priorFrontierMessageId,
          cursorStore: deps.deliveryCursorStore!,
          messageStore: deps.messageStore,
          messageFilter: (msg: Record<string, unknown>) => {
            if (msg.userId === 'system') return false;
            if (msg.origin === 'briefing') return false;
            const viewer =
              (thinkingMode ?? 'play') === 'play'
                ? ({ type: 'cat' as const, catId } as const)
                : { type: 'user' as const };
            if (
              !canViewMessage(
                msg as unknown as Parameters<typeof canViewMessage>[0],
                viewer as Parameters<typeof canViewMessage>[1],
              )
            )
              return false;
            return true;
          },
          queueChecker: getQueuedFreshnessMessagesForCat
            ? {
                getQueuedForThread: (tid, uid, targetCatId) =>
                  getQueuedFreshnessMessagesForCat(tid, uid, targetCatId, options.parentInvocationId),
              }
            : undefined,
          onEvent: deps.freshnessEventLog
            ? (event) => {
                deps
                  .freshnessEventLog!.append({
                    ...event,
                    invocationId: ownInvocationId ?? 'unknown',
                    catId: catId as string as import('@cat-cafe/shared').CatId,
                  })
                  .catch(() => {});
              }
            : undefined,
        });
        streamFreshnessResult = freshness;
        if (freshness.stale) {
          log.info(
            {
              catId: catId as string,
              threadId,
              invocationId: ownInvocationId,
              unseenCount: freshness.unseenCount,
              unseenSenders: freshness.unseenSenders,
              reason: freshness.reason,
            },
            '[F254] output published with unseen input; offering an additive supplement check',
          );
        }
        return { freshness, rawFrontierMessageId: priorFrontierMessageId };
      };

      if (!actionOutputCommitAllowed && textContent) await scheduleTurnCustodyStopGate(false);

      if (!actionOutputCommitAllowed) {
        catProducedOutput = Boolean(textContent || bufferedBlocks.length > 0 || collectedToolEvents.length > 0);
        if (options.persistenceContext) {
          options.persistenceContext.actionOutputCommitRejected = true;
          if (callbackFinalReplacement.postMessageId) {
            recordPersistedOutputMessageId(callbackFinalReplacement.postMessageId);
          }
        }
        a2aMentions = [];
      } else if (textContent) {
        catProducedOutput = true;
        const sanitized = sanitizeInjectedContent(textContent);

        // F22: Extract cc_rich blocks from text (Route B fallback for non-MCP cats)
        const { cleanText, blocks: textBlocks } = isFreshnessSupplement
          ? { cleanText: sanitized, blocks: [] }
          : extractRichFromText(sanitized);
        let storedContent = cleanText;
        let allRichBlocks = isFreshnessSupplement ? [] : [...bufferedBlocks, ...textBlocks, ...streamRichBlocks];

        // F34-b: Resolve voice blocks (audio with text, no url) — Route B path.
        // Route A blocks were already resolved in the callback handler.
        // F111: When voiceMode is active, skip full synthesis so audio blocks
        // arrive at the frontend with text but no url — the frontend will use
        // /api/tts/stream for chunked streaming playback (<2s first-audio).
        if (!isFreshnessSupplement && !voiceMode) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && allRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              allRichBlocks = await voiceSynth.resolveVoiceBlocks(allRichBlocks, catId as string);
            } catch (err) {
              log.error({ catId: catId as string, err }, 'Voice block synthesis failed');
            }
          }
        }

        const conciergeActionSourceContent =
          !isFreshnessSupplement &&
          'conciergeConfig' in conciergeCtx &&
          conciergeContextForCat(conciergeCtx, catId as string)?.conciergeConfig &&
          storedContent
            ? storedContent
            : undefined;
        if (conciergeActionSourceContent) {
          storedContent = stripTriagePlanMarkers(storedContent);
        }

        // A2A mention detection (缅因猫 P1-3: only after full text accumulated)
        // Line-start @mention = always actionable (no keyword gate)
        a2aMentions = isFreshnessSupplement ? [] : parseA2AMentions(storedContent, catId);

        // clowder-ai#489: baseline counter — line-start mentions
        if (a2aMentions.length > 0) {
          lineStartDetected.add(a2aMentions.length, { 'agent.id': catId as string });
        }

        const routingExitLineStartMentions = getRoutingExitLineStartMentions(a2aMentions);
        const routingExitHasCoCreatorLineStartMention = hasRoutingExitCoCreatorLineStartMention(storedContent);
        const localCvoHasCoCreatorLineStartMention = hasLocalCoCreatorLineStartMention(storedContent);

        const textLegacyObservedBlock = Boolean(
          !isFreshnessSupplement &&
            !hadError &&
            observeLegacyRoutingBlock({
              lineStartMentions: routingExitLineStartMentions,
              toolNames: collectedToolNames,
              structuredTargetCats: [...structuredTargetCats],
              hasCoCreatorLineStartMention: routingExitHasCoCreatorLineStartMention,
            }),
        );
        await scheduleTurnCustodyStopGate(textLegacyObservedBlock);
        a2aMentions = getLocalRoutingLineStartMentions(a2aMentions);

        // Preserve independent first-pass reasoning inside one serial route.
        // Only debug mode injects an earlier cat's in-flight response directly;
        // later invocations still receive that response after it is persisted.
        if (!incrementalMode && thinkingMode === 'debug') {
          previousResponses.push({ catId, content: storedContent });
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
        const phaseHHit = !isFreshnessSupplement && phaseHResult.kind === 'invalid_route_syntax';
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
        if (!isFreshnessSupplement && deps.invocationDeps.threadStore) {
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
          hasVerifiedEventBackedRoutingExit: verifiedEventBackedRoutingExit,
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
        if (!isFreshnessSupplement && votedOption && deps.invocationDeps.threadStore) {
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

        // #1332: a proactive callback is already durable before a later independent
        // final is committed. Timestamp that final at commit time so hydrated history
        // preserves the same callback-before-final order users saw live.
        const storedTimestamp =
          callbackFinalReplacement.postConfirmed && !callbackFinalReplacement.finalReplacementConfirmed
            ? Date.now()
            : invocationStartedAt;

        // F061: Detect local @co-creator mentions for browser/unread notification.
        // Cross-post callbacks can satisfy the guard and emit target-thread operator, but must not
        // create a source-thread unread/user notification.
        mentionsUser =
          !isFreshnessSupplement &&
          Boolean((storedContent ? detectUserMention(storedContent) : false) || localCvoHasCoCreatorLineStartMention);

        // #573/#1332: callback success alone does not prove the final is a duplicate.
        // Suppression is opt-in through streamDisposition="replace_final".
        const callbackAlreadyStored = callbackFinalReplacement.finalReplacementConfirmed;

        // Store with actual mentions — degrade on failure to ensure done reaches frontend
        // (缅因猫 review P1-2: Redis failure must not block done yield)
        let storedMsgId: string | undefined;
        let triagePlanIdsToLink: string[] = [];
        try {
          // #573: persist with the OUTER cat-cafe parentInvocationId (set by QueueProcessor)
          const visibleTurnInvocationId = visibleContentInvocationIdOverride ?? ownInvocationId;
          const persistedInvocationId = options.parentInvocationId ?? visibleTurnInvocationId;
          // F229 KD-23: Post-process concierge reply — resolve markers against per-invocation handle table
          if (conciergeActionSourceContent) {
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
              const verifiedToolAnchor = await resolveVerifiedConciergeToolAnchor(
                verifiedConciergeToolTargets,
                threadId,
                deps.invocationDeps.threadStore,
              );
              conciergeVerifiedToolTargetsPerReply.record(verifiedConciergeToolTargets.verifiedTargetCount());
              const conciergeActions = await buildConciergeActions(
                conciergeActionSourceContent,
                conciergeHandles,
                triageDeps,
                verifiedToolAnchor,
              );
              if (
                verifiedToolAnchor &&
                conciergeActions.some(
                  (action) => !action.handle && action.payload.threadId === verifiedToolAnchor.threadId,
                )
              ) {
                conciergeVerifiedToolActions.add(1);
              }
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
              }
            } catch {
              // Fail-open: action extraction failure → no actions, no crash
            }
          }

          const evaluateStreamFreshness = evaluateCurrentStreamFreshness;

          if (!callbackAlreadyStored) {
            const executionProjections = await readTurnExecutionProjections(visibleTurnInvocationId);
            const streamMessageInput: AppendMessageInput = {
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
                        turnInvocationId: visibleTurnInvocationId ?? persistedInvocationId,
                      },
                    }
                  : {}),
                ...(turnTriggerMessageId
                  ? { causal: { kind: 'invocation_reply' as const, triggerMessageId: turnTriggerMessageId } }
                  : {}),
                ...executionProjections,
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              },
            };
            let storedMsg = null;
            if (deps.freshnessOutputCommitCoordinator && deps.deliveryCursorStore && ownInvocationId) {
              const decision = await deps.freshnessOutputCommitCoordinator.commit({
                userId,
                threadId,
                catId: catId as string,
                invocationId: options.parentInvocationId ?? ownInvocationId,
                turnInvocationId: ownInvocationId,
                originTriggerMessageId: streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId ?? null,
                freshnessClosureId: options.freshnessClosureId,
                freshnessSupplementId: options.freshnessSupplementId,
                message: streamMessageInput,
                replayUnsafeToolNames: findReplayUnsafeToolNames(collectedToolNames),
                evaluateFreshness: evaluateStreamFreshness,
              });
              outputCommitDecision = decision;
              if (options.persistenceContext) {
                options.persistenceContext.outputCommitDecisions = {
                  ...(options.persistenceContext.outputCommitDecisions ?? {}),
                  [catId as string]: decision,
                };
              }
              if (
                decision.kind === 'committed_fresh' ||
                decision.kind === 'committed_degraded_unknown' ||
                decision.kind === 'published_with_unseen'
              ) {
                storedMsg = await deps.messageStore.getById(decision.messageId);
                if (decision.kind === 'published_with_unseen') {
                  await enqueueFreshnessSupplement(decision, catId as string);
                }
              }
            } else {
              storedMsg = await deps.messageStore.append(streamMessageInput);
            }
            storedMsgId = storedMsg?.id;
            turnStoredMessageId = storedMsgId;
            if (storedMsgId) recordPersistedOutputMessageId(storedMsgId);
            const triagePlanStore = deps.invocationDeps.conciergeTriagePlanStore;
            if (storedMsg && triagePlanStore && triagePlanIdsToLink.length > 0) {
              try {
                await Promise.all(
                  triagePlanIdsToLink.map((planId) => triagePlanStore.setConfirmationMessageId(planId, storedMsg.id)),
                );
              } catch (err) {
                log.warn({ err, threadId, messageId: storedMsg.id }, 'Failed to link triage plan confirmation message');
              }
            }
            // F088-P3: Stash rich blocks for outbound delivery
            if (storedMsg && options.persistenceContext && allRichBlocks.length > 0) {
              options.persistenceContext.richBlocks = allRichBlocks;
            }
          } else {
            log.info(
              {
                threadId,
                catId: catId as string,
                callbackMessageId: callbackFinalReplacement.finalReplacementMessageId,
              },
              'Stream store skipped — cat_cafe_post_message explicitly replaced the final',
            );
            const callbackTriagePlanStore = deps.invocationDeps.conciergeTriagePlanStore;
            const linkedCallbackMessageId = callbackFinalReplacement.finalReplacementMessageId;
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
            if (callbackFinalReplacement.finalReplacementMessageId) {
              // F192 Phase D: bind sample anchor in callback path so post-storage
              // emission uses the actual cat-stored message id (via callback).
              storedMsgId = callbackFinalReplacement.finalReplacementMessageId;
              turnStoredMessageId = callbackFinalReplacement.finalReplacementMessageId;
              recordPersistedOutputMessageId(callbackFinalReplacement.finalReplacementMessageId);
              await augmentFinalReplacementMessage(
                callbackFinalReplacement.finalReplacementMessageId,
                visibleTurnInvocationId,
                allRichBlocks,
                mentionsUser,
              );
            }
          }
          // #80/F254: Delete only after MessageStore or closure truth proves custody.
          if (
            deps.draftStore &&
            ownInvocationId &&
            mayDeleteDraft(
              outputCommitDecision,
              Boolean(storedMsgId || callbackFinalReplacement.finalReplacementMessageId),
            )
          ) {
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
            if (!isFreshnessSupplement) {
              emitBallVoidPass(deps.ballCustody, threadId, storedMsgId, pendingC2VoidHoldSampleTrigger);
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
          !hadError &&
          worklistEntry.a2aCount < maxDepth &&
          !catSignal?.aborted &&
          !queuedMessagesPending
        ) {
          // F212 cloud R3 P1: a failed partial turn must not launch downstream cats
          // from incomplete content. The structured stop gate independently skips
          // provider-error turns and does not revive this text-derived dispatch.
          // F153: mention_dispatch span — tracks the causal link between mentioner and dispatched targets
          let dispatchSpan: Span | undefined;
          const pendingTail = worklist.slice(index + 1);
          const pendingOriginalTargets = targetCats.slice(index + 1);
          // F216 c1.3 + P1-2 (砚砚 review): route each mentioned cat through the pure
          // resolveRoutingDecisions function (unifies the depth/pendingTail/streak/occupancy/fairness guards
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

            // enqueue_worklist means the target looks free; defer_queue means Queue already has a
            // responsibility for it. In both cases the tracker claim is the final admission fence:
            // another live owner leaves this exact source in the durable queue, never in this worklist.
            const claimed = await claimOrDeferA2ATarget(
              nextCat,
              catId,
              storedContent,
              storedMsgId,
              noteAcceptedTurnCustodyHandoff,
            );
            if (!claimed) {
              worklistEntry.a2aCount++;
              continue;
            }
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
                ownerAuthProvenance,
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
          // Same guard chain as inline (depth/pendingTail/streak/occupancy) but ctx.queuedMessagesPending=true
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
            const enqueueResult = deferA2AEnqueue({
              threadId,
              userId,
              ownerAuthProvenance,
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
            if (enqueueResult?.outcome === 'enqueued' && storedMsgId) {
              noteAcceptedTurnCustodyHandoff(nextCat, storedMsgId);
            }
            worklistEntry.a2aCount++;
            log.info(
              { threadId, catId: nextCat, fromCat: catId },
              'A2A text-scan deferred: enqueued behind non-agent entries (F185-B)',
            );
          }
        }

        // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
        // We track which targets have already been announced to avoid duplicate handoff events.
        const serialLegs: Array<{ catId: CatId; config?: CatConfig }> = [];
        // ── INV-1 HOLDER: SEALED ADMITTED BATCH ────────────────────────────────────────────
        // Announce only from a frozen batch whose admission is already closed.
        //
        // Two defects live at this exact spot, and they pull in opposite directions:
        //  (a) deriving index/total while claims are still outstanding announces a group size that
        //      counts legs which may still be pruned  → 砚砚 R5: "串行 1/2" with one real leg;
        //  (b) splitting claim and emit into two passes over the MUTABLE worklist opens a
        //      reentrancy window: `yield` suspends this generator, a callback `pushToWorklist`
        //      lands, and the emit pass announces AND starts a cat that never claimed a slot
        //      → 砚砚 R6, a custody violation I introduced while fixing (a).
        //
        // Sealing resolves both: claim/prune the pending tail, freeze a copy, close the batch
        // BEFORE the first yield, then emit only from the frozen copy. A push arriving mid-emit
        // cannot join this batch's size and cannot skip admission — it simply becomes the next
        // batch, which the drain loop claims on its following pass. Late arrivals are therefore
        // late, not unadmitted.
        let sealGuard = maxDepth + targetCats.length + 2;
        while (handoffEmitted < worklist.length && sealGuard-- > 0) {
          for (let wi = handoffEmitted; wi < worklist.length; wi++) {
            if (wi < targetCats.length) continue;
            const claimed = await claimOrDeferA2ATarget(
              worklist[wi]!,
              catId,
              storedContent,
              storedMsgId,
              noteAcceptedTurnCustodyHandoff,
            );
            if (!claimed) {
              worklist.splice(wi, 1);
              wi--;
            }
          }
          if (handoffEmitted >= worklist.length) break;
          const batchStart = handoffEmitted;
          const sealedBatch: readonly CatId[] = Object.freeze(worklist.slice(batchStart));
          handoffEmitted = worklist.length; // close the batch BEFORE any yield can suspend us
          for (const [legIndex, pendingCat] of sealedBatch.entries()) {
            if (batchStart + legIndex < targetCats.length) continue; // originals are not A2A legs

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
            // F086/F216: the scheduling mode is DECLARED, never inferred from how many targets
            // appeared or in what order. Inline line-start @mentions are one ordered worklist.
            const projection: A2ARoutingProjection = {
              mode: A2A_INLINE_MENTION_MODE,
              index: legIndex + 1,
              total: sealedBatch.length,
            };
            serialLegs.push({ catId: pendingCat, ...(nextConfig ? { config: nextConfig } : {}) });
            yield {
              type: 'a2a_handoff' as AgentMessageType,
              catId,
              content: formatA2AHandoffContent(catId, pendingCat, catConfig, nextConfig, projection),
              invocationId: ownInvocationId,
              targetCatId: pendingCat,
              routing: projection,
              timestamp: Date.now(),
            } as AgentMessage;
          }
        }
        // F086/F216 requirement 4: multi-target inline @ is normalized to serial (the semantics
        // the runtime already executes) and SAID OUT LOUD. No NLP over the body, no silent
        // downgrade, and the structured parallel escape hatch is named explicitly.
        if (serialLegs.length > 1) {
          const noticePayload = buildSerialMultiTargetNoticePayload(catId, serialLegs);
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: noticePayload,
            invocationId: ownInvocationId,
            timestamp: Date.now(),
          } as AgentMessage;
          // Persist directly rather than via userFacingSystemInfoContents: the tool-only emit site
          // below runs AFTER that array is flushed, so routing the notice through it would silently
          // drop half the cases. Same writer, ordering-independent.
          await persistUserFacingSystemInfoNotices({
            messageStore: deps.messageStore,
            threadId,
            catId: catId as string,
            contents: [noticePayload],
            ...(options.persistenceContext ? { persistenceContext: options.persistenceContext } : {}),
          });
        }
      } else if (!hadError) {
        // No text content and no error.
        // Persist only when we have non-text payload (tool/thinking/rich).
        // Purely empty turns should not create blank chat bubbles.
        const noTextBlocks = [...bufferedBlocks, ...streamRichBlocks];
        const hasRichBlocks = noTextBlocks.length > 0;
        const callbackAlreadyStored = callbackFinalReplacement.finalReplacementConfirmed;
        const hasNoTextStreamPayload =
          hasRichBlocks ||
          collectedToolEvents.length > 0 ||
          Boolean(renderThinkingChunks(thinkingChunks).trim().length > 0);
        const shouldPersistNoTextMessage = !callbackAlreadyStored && hasNoTextStreamPayload;
        const isFreshnessClosureSuccessor = Boolean(options.freshnessClosureRequiredMessageIds?.length);
        const shouldEmitSilentCompletion =
          !callbackAlreadyStored &&
          collectedToolEvents.length > 0 &&
          !hasRichBlocks &&
          !sawUserFacingSystemInfo &&
          !isFreshnessClosureSuccessor;

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
        if (
          callbackAlreadyStored ||
          shouldPersistNoTextMessage ||
          sawUserFacingSystemInfo ||
          shouldEmitSilentCompletion
        ) {
          catProducedOutput = true;
        }

        if (shouldPersistNoTextMessage || callbackAlreadyStored) {
          try {
            const visibleTurnInvocationId = visibleContentInvocationIdOverride ?? ownInvocationId;
            let storedNoText = null;
            if (callbackAlreadyStored) {
              log.info(
                {
                  threadId,
                  catId: catId as string,
                  callbackMessageId: callbackFinalReplacement.finalReplacementMessageId,
                },
                'No-text stream store skipped — cat_cafe_post_message explicitly replaced the final',
              );
              if (callbackFinalReplacement.finalReplacementMessageId) {
                turnStoredMessageId = callbackFinalReplacement.finalReplacementMessageId;
                recordPersistedOutputMessageId(callbackFinalReplacement.finalReplacementMessageId);
                await augmentFinalReplacementMessage(
                  callbackFinalReplacement.finalReplacementMessageId,
                  visibleTurnInvocationId,
                  noTextBlocks,
                  !isFreshnessSupplement && hasLocalCoCreatorLineStartMention(''),
                );
              }
            } else {
              const executionProjections = await readTurnExecutionProjections(visibleTurnInvocationId);
              const noTextMessageInput: AppendMessageInput = {
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
                  ...((options.parentInvocationId ?? visibleTurnInvocationId)
                    ? {
                        stream: {
                          invocationId: (options.parentInvocationId ?? visibleTurnInvocationId) as string,
                          turnInvocationId: (visibleTurnInvocationId ?? options.parentInvocationId) as string,
                        },
                      }
                    : {}),
                  ...(turnTriggerMessageId
                    ? { causal: { kind: 'invocation_reply' as const, triggerMessageId: turnTriggerMessageId } }
                    : {}),
                  ...executionProjections,
                  ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
                },
              };
              const answerBearingNoText =
                hasRichBlocks || Boolean(renderThinkingChunks(thinkingChunks).trim().length > 0);
              const replayUnsafeToolNames = findReplayUnsafeToolNames(collectedToolNames);
              const requiresFreshnessGate = answerBearingNoText || replayUnsafeToolNames.length > 0;
              if (
                requiresFreshnessGate &&
                deps.freshnessOutputCommitCoordinator &&
                deps.deliveryCursorStore &&
                ownInvocationId
              ) {
                const decision = await deps.freshnessOutputCommitCoordinator.commit({
                  userId,
                  threadId,
                  catId: catId as string,
                  invocationId: options.parentInvocationId ?? ownInvocationId,
                  turnInvocationId: ownInvocationId,
                  originTriggerMessageId: streamReplyTo ?? currentUserMessageId ?? a2aTriggerMessageId ?? null,
                  freshnessClosureId: options.freshnessClosureId,
                  freshnessSupplementId: options.freshnessSupplementId,
                  message: noTextMessageInput,
                  replayUnsafeToolNames,
                  evaluateFreshness: evaluateCurrentStreamFreshness,
                });
                outputCommitDecision = decision;
                if (options.persistenceContext) {
                  options.persistenceContext.outputCommitDecisions = {
                    ...(options.persistenceContext.outputCommitDecisions ?? {}),
                    [catId as string]: decision,
                  };
                }
                if (
                  decision.kind === 'committed_fresh' ||
                  decision.kind === 'committed_degraded_unknown' ||
                  decision.kind === 'published_with_unseen'
                ) {
                  storedNoText = await deps.messageStore.getById(decision.messageId);
                  if (decision.kind === 'published_with_unseen') {
                    await enqueueFreshnessSupplement(decision, catId as string);
                  }
                }
              } else {
                // Reviewed read-only tool-only records are audit output, not answer content.
                // Unknown or mutating tools still enter the freshness gate above so a stale
                // turn cannot hide a side effect and then blind-replay it.
                storedNoText = await deps.messageStore.append(noTextMessageInput);
              }
            }
            // F088-P3: Stash rich blocks for outbound delivery (no-text branch)
            if (storedNoText && options.persistenceContext && noTextBlocks.length > 0) {
              options.persistenceContext.richBlocks = [
                ...(options.persistenceContext.richBlocks ?? []),
                ...noTextBlocks,
              ];
            }
            if (storedNoText) recordPersistedOutputMessageId(storedNoText.id);
            // #80/F254: retained means DraftStore is still the only recoverable copy.
            if (
              deps.draftStore &&
              ownInvocationId &&
              mayDeleteDraft(
                outputCommitDecision,
                Boolean(storedNoText || callbackFinalReplacement.finalReplacementMessageId),
              )
            ) {
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
        }

        if (!shouldPersistNoTextMessage && !callbackAlreadyStored) {
          if (!sawUserFacingSystemInfo && !isFreshnessClosureSuccessor) {
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
          }
          // No persisted message for fully silent turns; clean up draft for turns whose
          // only user-visible content was a system_info warning (persisted in the common path below).
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
        }
      } else if (collectedToolEvents.length > 0) {
        // hadError && textContent === '' but toolEvents exist — persist tool record so
        // refreshing the page still shows what the cat attempted before the error.
        try {
          const visibleTurnInvocationId = visibleContentInvocationIdOverride ?? ownInvocationId;
          if (
            callbackFinalReplacement.finalReplacementConfirmed &&
            callbackFinalReplacement.finalReplacementMessageId
          ) {
            catProducedOutput = true;
            turnStoredMessageId = callbackFinalReplacement.finalReplacementMessageId;
            recordPersistedOutputMessageId(callbackFinalReplacement.finalReplacementMessageId);
            await augmentFinalReplacementMessage(
              callbackFinalReplacement.finalReplacementMessageId,
              visibleTurnInvocationId,
              [...bufferedBlocks, ...streamRichBlocks],
              false,
            );
          } else {
            const executionProjections = await readTurnExecutionProjections(visibleTurnInvocationId);
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
              ...((options.parentInvocationId ?? visibleTurnInvocationId) || doneMsg?.tracing
                ? {
                    extra: {
                      // F194 Phase Z9 AC-Z25 (KD-28): always stamp turnInvocationId
                      // for error+toolEvents records too.
                      ...((options.parentInvocationId ?? visibleTurnInvocationId)
                        ? {
                            stream: {
                              invocationId: (options.parentInvocationId ?? visibleTurnInvocationId) as string,
                              turnInvocationId: (visibleTurnInvocationId ?? options.parentInvocationId) as string,
                            },
                          }
                        : {}),
                      ...(turnTriggerMessageId
                        ? { causal: { kind: 'invocation_reply' as const, triggerMessageId: turnTriggerMessageId } }
                        : {}),
                      ...executionProjections,
                      ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
                    },
                  }
                : {}),
            });
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

      // Persist after all text/no-text/error branches so every live warning survives refresh.
      // Do not broadcast again: the system_info stream already delivered the live event.
      await persistUserFacingSystemInfoNotices({
        messageStore: deps.messageStore,
        threadId,
        catId: catId as string,
        contents: userFacingSystemInfoContents,
        ...(options.persistenceContext ? { persistenceContext: options.persistenceContext } : {}),
      });

      a2aMentions = getLocalRoutingLineStartMentions(a2aMentions);

      // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
      // Keep this outside the text branch: callback/tool-only turns can push worklist entries
      // without producing text, but their child slots still must be tracked before parent done.
      // We track which targets have already been announced to avoid duplicate handoff events.
      const toolOnlySerialLegs: Array<{ catId: CatId; config?: CatConfig }> = [];
      // INV-1 HOLDER (serial side, tool-only turn) — SAME sealed-batch drain as the text path.
      // 砚砚 R6 required both loops to hold the line: a callback push can feed either one, so
      // leaving one loop iterating the mutable worklist would just relocate the reentrancy window
      // rather than close it.
      let toolOnlySealGuard = maxDepth + targetCats.length + 2;
      while (handoffEmitted < worklist.length && toolOnlySealGuard-- > 0) {
        for (let wi = handoffEmitted; wi < worklist.length; wi++) {
          if (wi < targetCats.length) continue;
          const claimed = await claimOrDeferA2ATarget(
            worklist[wi]!,
            catId,
            undefined,
            undefined,
            noteAcceptedTurnCustodyHandoff,
          );
          if (!claimed) {
            worklist.splice(wi, 1);
            wi--;
          }
        }
        if (handoffEmitted >= worklist.length) break;
        const batchStart = handoffEmitted;
        const sealedBatch: readonly CatId[] = Object.freeze(worklist.slice(batchStart));
        handoffEmitted = worklist.length; // close the batch BEFORE any yield can suspend us
        for (const [legIndex, pendingCat] of sealedBatch.entries()) {
          if (batchStart + legIndex < targetCats.length) continue; // originals are not A2A legs

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
          // F086/F216: same declared-serial contract as the text path above.
          const projection: A2ARoutingProjection = {
            mode: A2A_INLINE_MENTION_MODE,
            index: legIndex + 1,
            total: sealedBatch.length,
          };
          toolOnlySerialLegs.push({ catId: pendingCat, ...(nextConfig ? { config: nextConfig } : {}) });
          yield {
            type: 'a2a_handoff' as AgentMessageType,
            catId,
            content: formatA2AHandoffContent(catId, pendingCat, catConfig, nextConfig, projection),
            invocationId: ownInvocationId,
            targetCatId: pendingCat,
            routing: projection,
            timestamp: Date.now(),
          } as AgentMessage;
        }
      }
      // FINAL ADMISSION BOUNDARY: no callback from this caller may extend the worklist after
      // this point. Close before the notice yield and every later await, not merely before done;
      // otherwise a callback can land after the last claim/prune pass and start unadmitted on
      // the next loop iteration while executedIndex still names the old caller.
      setWorklistCallerAdmissionOpen(worklistEntry, false);
      if (toolOnlySerialLegs.length > 1) {
        const noticePayload = buildSerialMultiTargetNoticePayload(catId, toolOnlySerialLegs);
        yield {
          type: 'system_info' as AgentMessageType,
          catId,
          content: noticePayload,
          invocationId: ownInvocationId,
          timestamp: Date.now(),
        } as AgentMessage;
        await persistUserFacingSystemInfoNotices({
          messageStore: deps.messageStore,
          threadId,
          catId: catId as string,
          contents: [noticePayload],
          ...(options.persistenceContext ? { persistenceContext: options.persistenceContext } : {}),
        });
      }

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

      // F254 B3/B4: Freshness re-invoke consumption — enqueue re-invoke if the
      // invocation's terminal hook decided shouldReinvoke=true. Checked AFTER A2A
      // detection (A2A has priority) and BEFORE done yield (enqueue happens while
      // the route is still live). Fail-open: errors never block the done signal.
      if (
        freshnessReinvokeEnqueue &&
        doneMsg?.metadata &&
        !hadError &&
        !streamFreshnessResult?.stale &&
        !outputCommitDecision &&
        !isFreshnessSupplement
      ) {
        const reinvokeDecision = (doneMsg.metadata as unknown as Record<string, unknown>).freshnessReinvoke as
          | {
              shouldReinvoke: boolean;
              reason: string;
              noticeIds: string[];
              senders: string[];
              skipReason?: string;
              reinvokePrompt?: string;
            }
          | undefined;
        if (reinvokeDecision?.shouldReinvoke) {
          try {
            // P1-2 fix: use the spec-defined prompt from the factory, NOT empty string.
            // QueueProcessor strips freshnessContext, so content must carry the prompt.
            const reinvokeContent =
              reinvokeDecision.reinvokePrompt ||
              buildFreshnessReinvokePrompt(threadId, reinvokeDecision.senders, reinvokeDecision.noticeIds.length);
            freshnessReinvokeEnqueue({
              threadId,
              userId,
              ownerAuthProvenance,
              content: reinvokeContent,
              source: 'agent',
              sourceCategory: 'freshness',
              targetCats: [catId as string],
              callerCatId: catId as string,
              autoExecute: true,
              priority: 'normal',
              intent: 'execute',
              freshnessContext: {
                sourceNoticeIds: reinvokeDecision.noticeIds,
                senders: reinvokeDecision.senders,
                reason: reinvokeDecision.reason,
              },
            });
            log.info(
              {
                catId: catId as string,
                threadId,
                invocationId: ownInvocationId,
                reason: reinvokeDecision.reason,
                noticeCount: reinvokeDecision.noticeIds.length,
              },
              '[F254-B3] freshness re-invoke enqueued from routing layer',
            );
          } catch (err) {
            log.warn(
              { catId: catId as string, threadId, err },
              '[F254-B3] freshness re-invoke enqueue failed, fail-open',
            );
          }
        } else if (reinvokeDecision && !reinvokeDecision.shouldReinvoke) {
          log.debug(
            {
              catId: catId as string,
              threadId,
              invocationId: ownInvocationId,
              skipReason: reinvokeDecision.skipReason ?? reinvokeDecision.reason,
            },
            '[F254-B4] freshness re-invoke skipped',
          );
        }
      }

      // Yield buffered done with correct isFinal (evaluated AFTER worklist may have grown)
      // MUST always reach here regardless of append success (缅因猫 review P1-2)
      // F194 Phase Z9 砚砚 R1 P1-1: stamp ownInvocationId on done if not already set.
      emitSingleAcceptedTurnCustodyHandoff();
      const isTerminalCoordinationWake =
        turnCustodyWake.kind === 'non_obligation' && turnCustodyWake.source === 'coordination_terminal';
      if (index === worklist.length - 1 || isTerminalCoordinationWake) {
        await flushTurnCustodyShadowCloses(index === worklist.length - 1 ? 'route_settled' : 'next_turn_boundary');
      }
      await releaseTurnCustodyAdoption();
      if (doneMsg) {
        const isFinal = index === worklist.length - 1;
        const ownStampedDone =
          ownInvocationId && !doneMsg.invocationId ? { ...doneMsg, invocationId: ownInvocationId } : doneMsg;
        yield projectLiveTurnExecution({
          ...ownStampedDone,
          ...(mentionsUser ? { mentionsUser } : {}),
          ...(turnCustodyTerminalWitnesses[0] ? { turnCustodyTerminalWitness: turnCustodyTerminalWitnesses[0] } : {}),
          ...(turnCustodyTerminalWitnesses.length > 0 ? { turnCustodyTerminalWitnesses } : {}),
          ...(structuredDispositionMissingCode ? { errorCode: structuredDispositionMissingCode } : {}),
          isFinal,
        });
        activeTrackedA2ASlots.delete(catId);
        if (isFinal) yieldedFinalDone = true;
        if (ownInvocationId) {
          completedCatInvocationIds.push([catId, ownInvocationId]);
          pushRecallPresentationsByInvocation.set(ownInvocationId, currentPushRecallPresentations);
        }
      }

      // F27: Advance executedIndex so pushToWorklist knows which cats are done
      worklistEntry.executedIndex = index + 1;
      index++;
    }
  } finally {
    // Provider/route failure after system_info must revoke callback ownership
    // before any adopted projections are closed or the route exits.
    await releaseTurnCustodyAdoption();
    if (keepaliveTimer) clearInterval(keepaliveTimer);

    // Phase T stop gate is a turn-settled verdict: current output persistence,
    // operator handoff writes, and inline child receiver-boundary handoffs must all
    // have had a chance to establish machine evidence before the projection closes.
    await flushTurnCustodyShadowCloses('route_settled');

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

    // F200 AC-A1: fire-and-forget recall correlation after all cats complete.
    // TD 2026-08-12: bounded tail read — full-thread reads of large keys
    // (observed 221MB) froze the API event loop every round-end.
    if (deps.toolEventLog && deps.evidenceStore && completedCatInvocationIds.length > 0) {
      const evidenceDb = (deps.evidenceStore as { getDb?: () => import('better-sqlite3').Database }).getDb?.();
      if (evidenceDb) {
        deps.toolEventLog
          .readRecentByThread(threadId, RECALL_CORRELATION_EVENT_WINDOW)
          .then((events) => {
            const raw = events as unknown as Parameters<typeof triggerRecallCorrelation>[1];
            for (const [catId, invId] of completedCatInvocationIds) {
              const withPush = mergePushRecallPresentations(
                raw,
                pushRecallPresentationsByInvocation.get(invId) ?? [],
                invId,
                catId,
                threadId,
              );
              triggerRecallCorrelation(evidenceDb, withPush, invId, catId).catch(() => {});
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
