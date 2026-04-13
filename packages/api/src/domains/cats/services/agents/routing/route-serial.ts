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

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { getConfigSessionStrategy, isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { getCatVoice } from '../../../../../config/cat-voices.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { detectUserMention } from '../../../../../routes/user-mention.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import { canAccessGuideState, hasHiddenForeignNonTerminalGuideState } from '../../../../guides/guide-state-access.js';
import { assembleContext } from '../../context/ContextAssembler.js';
import {
  buildInvocationContext,
  buildStaticIdentity,
  type InvocationContext,
} from '../../context/SystemPromptBuilder.js';
import { formatDegradationMessage } from '../../orchestration/DegradationPolicy.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { buildSessionBootstrap } from '../../session/SessionBootstrap.js';
import { hydrateReplyPreview, type StoredToolEvent } from '../../stores/ports/MessageStore.js';
import type { ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import { getStreamingTtsRegistry, StreamingTtsChunker } from '../../tts/StreamingTtsChunker.js';
import { getVoiceBlockSynthesizer } from '../../tts/VoiceBlockSynthesizer.js';
import type { AgentMessage, AgentMessageType, MessageMetadata } from '../../types.js';
import { invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { buildMcpCallbackInstructions, needsMcpInjection } from '../invocation/McpPromptInjector.js';
import { getRichBlockBuffer } from '../invocation/RichBlockBuffer.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { detectInlineActionMentions, getMaxA2ADepth, parseA2AMentions } from '../routing/a2a-mentions.js';
import { registerWorklist, unregisterWorklist } from '../routing/WorklistRegistry.js';
import { extractContextEvalSignals } from './context-eval.js';
import { buildBriefingMessage } from './format-briefing.js';
import { extractRichFromText, isValidRichBlock } from './rich-block-extract.js';
import type { RouteOptions, RouteStrategyDeps } from './route-helpers.js';
import {
  assembleIncrementalContext,
  createLeakedToolCallStreamStripper,
  detectContextDegradation,
  getService,
  isUserFacingSystemInfoContent,
  routeContentBlocksForCat,
  sanitizeInjectedContent,
  toStoredToolEvent,
  upsertMaxBoundary,
} from './route-helpers.js';
import { buildVoteTally, checkVoteCompletion, extractVoteFromText, VOTE_RESULT_SOURCE } from './vote-intercept.js';

const log = createModuleLogger('route-serial');

function shouldHandleCompletedGuide(
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

function shouldHandleOfferedGuide(
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
    promptTags,
    contextHistory,
    history,
    currentUserMessageId,
    modeSystemPrompt,
    modeSystemPromptByCat,
    queueHasQueuedMessages,
    hasQueuedOrActiveAgentForCat,
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
  let sopStageHint: { stage: string; suggestedSkill: string | null; featureId: string } | undefined;
  // F092: Voice companion mode
  let voiceMode: boolean | undefined;
  // F087: Bootcamp state for CVO onboarding
  let bootcampState: InvocationContext['bootcampState'];
  // F155: Guide candidate from keyword matching against raw user message
  let guideCandidate: InvocationContext['guideCandidate'];
  /** catId that owns an offered guide prompt, to avoid duplicate offered→offered writes. */
  let guideOfferOwner: string | undefined;
  /** catId that should receive offered-guide selection when owner is absent. */
  let guideOfferSelectionFallbackCatId: string | undefined;
  /** catId that should receive the one-shot completion notice (offeredBy). */
  let guideCompletionOwner: string | undefined;
  let guideCompletionFallbackCatId: string | undefined;
  let hiddenForeignNonTerminalGuideState = false;
  const targetCatIds = new Set<string>(targetCats);
  if (deps.invocationDeps.threadStore) {
    try {
      const thread = await deps.invocationDeps.threadStore.get(threadId);
      routingPolicy = thread?.routingPolicy;
      voiceMode = thread?.voiceMode;
      bootcampState = thread?.bootcampState;
      const threadGuideState = thread?.guideState;
      hiddenForeignNonTerminalGuideState = hasHiddenForeignNonTerminalGuideState(thread, threadGuideState, userId);
      const guideState = canAccessGuideState(thread, threadGuideState, userId) ? threadGuideState : undefined;
      // F155: Read existing guide state from thread (authority source)
      if (guideState) {
        const gs = guideState;
        // cancelled: fully terminal, skip
        // completed: one-shot inject if not yet acked, then mark acked
        const justCompleted = gs.status === 'completed' && !gs.completionAcked;
        const shouldInject = (gs.status !== 'completed' && gs.status !== 'cancelled') || justCompleted;
        if (shouldInject) {
          // Back-fill display metadata from registry so prompt gets real name/time
          let name = gs.guideId;
          let estimatedTime = '';
          try {
            const { getRegistryEntries } = await import('../../../../guides/guide-registry-loader.js');
            const entry = getRegistryEntries().find((e) => e.id === gs.guideId);
            if (entry) {
              name = entry.name;
              estimatedTime = entry.estimated_time;
            }
          } catch {
            /* best-effort */
          }
          // Detect selection response: "引导流程：{label}"
          const selectionMatch = message.match(/^引导流程：(.+)$/);
          guideCandidate = {
            id: gs.guideId,
            name,
            estimatedTime,
            status: gs.status as 'offered' | 'awaiting_choice' | 'active' | 'completed',
            ...(gs.status === 'offered' ? { isNewOffer: false } : {}),
            ...(selectionMatch ? { userSelection: selectionMatch[1] } : {}),
          };
          if (gs.status === 'offered' || gs.status === 'awaiting_choice') {
            guideOfferOwner = gs.offeredBy;
            if (
              (selectionMatch || gs.status === 'awaiting_choice') &&
              gs.offeredBy &&
              !targetCatIds.has(gs.offeredBy)
            ) {
              guideOfferSelectionFallbackCatId = targetCats[0];
            }
          }
          if (justCompleted) {
            guideCompletionOwner = gs.offeredBy;
            if (gs.offeredBy && !targetCatIds.has(gs.offeredBy)) {
              guideCompletionFallbackCatId = targetCats[0];
            }
          }
        }
      }
      // F073 P4: Read workflow-sop if thread is linked to a backlog item
      if (thread?.backlogItemId && deps.invocationDeps.workflowSopStore) {
        try {
          const sop = await deps.invocationDeps.workflowSopStore.get(thread.backlogItemId);
          if (sop) {
            sopStageHint = {
              stage: sop.stage,
              suggestedSkill: sop.nextSkill,
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

  // F155: Match raw user message against guide registry (only if no existing guide state)
  if (!guideCandidate && !hiddenForeignNonTerminalGuideState) {
    try {
      const { resolveGuideForIntent } = await import('../../../../guides/guide-registry-loader.js');
      const guideMatches = resolveGuideForIntent(message);
      if (guideMatches.length > 0) {
        const top = guideMatches[0];
        guideCandidate = {
          id: top.id,
          name: top.name,
          estimatedTime: top.estimatedTime,
          status: 'offered',
          isNewOffer: true,
        };
        guideOfferOwner = targetCats[0];
        log.info(
          { guideId: top.id, guideName: top.name, score: top.score },
          '[F155] guide candidate matched at routing layer',
        );
      }
    } catch {
      /* best-effort: guide matching failure does not block invocation */
    }
  }

  try {
    while (index < worklist.length) {
      if (signal?.aborted) break;
      const catId = worklist[index]!;
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

      // Build identity: static goes in -p content (+ systemPrompt as defense-in-depth), dynamic in -p only
      const catConfig: CatConfig | undefined =
        catRegistry.tryGet(catId as string)?.config ?? CAT_CONFIGS[catId as string];
      const teammates = [...new Set(worklist.filter((id) => id !== catId))];
      const directMessageFrom = worklistEntry.a2aFrom.get(catId);
      const streamReplyTo = worklistEntry.a2aTriggerMessageId.get(catId);
      const streamReplyPreview = streamReplyTo
        ? await hydrateReplyPreview(deps.messageStore, streamReplyTo)
        : undefined;
      let mentionRoutingFeedback = null;
      if (deps.invocationDeps.threadStore) {
        try {
          mentionRoutingFeedback = await deps.invocationDeps.threadStore.consumeMentionRoutingFeedback(threadId, catId);
        } catch (feedbackErr) {
          log.warn({ catId: catId as string, err: feedbackErr }, 'consumeMentionRoutingFeedback failed');
        }
      }
      // MCP documentation: Claude's MCP_TOOLS_SECTION → staticIdentity (in -p content).
      // Non-Claude HTTP callback instructions → per-message (session history may be lost on compress).
      const mcpAvailable = (catConfig?.mcpSupport ?? false) && !!mcpServerPath;
      // F129: Load active pack blocks (best-effort, failure does not block invocation)
      let packBlocks: import('@cat-cafe/shared').CompiledPackBlocks | null = null;
      if (deps.packStore) {
        const { getActivePackBlocks } = await import('../../../../packs/getActivePackBlocks.js');
        packBlocks = await getActivePackBlocks(deps.packStore);
      }
      const staticIdentity = buildStaticIdentity(catId, { mcpAvailable, packBlocks });
      // F041: inject HTTP callback only when MCP is NOT actually available (fallback)
      const mcpInstructions = needsMcpInjection(mcpAvailable)
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

      const invocationContext = buildInvocationContext({
        catId,
        mode: worklist.length > 1 ? 'serial' : 'independent',
        chainIndex: index + 1,
        chainTotal: worklist.length,
        teammates,
        mcpAvailable,
        ...(promptTags && promptTags.length > 0 ? { promptTags } : {}),
        a2aEnabled: worklistEntry.a2aCount < maxDepth,
        ...(directMessageFrom ? { directMessageFrom } : {}),
        ...(mentionRoutingFeedback ? { mentionRoutingFeedback } : {}),
        ...(activeParticipants.length > 0 ? { activeParticipants } : {}),
        ...(routingPolicy ? { routingPolicy } : {}),
        ...(sopStageHint ? { sopStageHint } : {}),
        ...(activeSignals ? { activeSignals } : {}),
        ...(voiceMode ? { voiceMode } : {}),
        ...(bootcampState ? { bootcampState, threadId } : {}),
        ...(guideCandidate &&
        (guideCandidate.status === 'completed'
          ? shouldHandleCompletedGuide(guideCompletionOwner, targetCatIds, guideCompletionFallbackCatId, catId)
          : guideCandidate.status === 'offered' || guideCandidate.status === 'awaiting_choice'
            ? shouldHandleOfferedGuide(
                guideOfferOwner,
                targetCatIds,
                guideOfferSelectionFallbackCatId,
                catId,
                Boolean(guideCandidate.userSelection),
                guideCandidate.status === 'awaiting_choice',
              )
            : true)
          ? { guideCandidate, threadId }
          : {}),
      });

      // F24 Phase E: Bootstrap context for Session #2+
      let bootstrapContext = '';
      if (
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
          { effectiveMaxContextTokens: effectiveContextBudget },
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

        const catModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const parts = [invocationContext, catModePrompt, bootstrapContext, mcpInstructions].filter(Boolean);
        if (inc.contextText) parts.push(inc.contextText);
        // F35 fix: only inject raw message when it was genuinely absent from unseen rows.
        // If it was present but filtered out (e.g. whisper), injecting would leak private content.
        if (!inc.includesCurrentUserMessage && !inc.currentMessageFilteredOut) parts.push(message);
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
      let thinkingContent = '';
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
      const collectedToolEvents: StoredToolEvent[] = [];
      // F148 OQ-2: Collect tool names for context eval signals
      const collectedToolNames: string[] = [];
      // F060: Collect rich blocks emitted inline via system_info (not MCP buffer)
      const streamRichBlocks: import('@cat-cafe/shared').RichBlock[] = [];
      // F22 R2 P1-1: Capture own invocationId from stream (not getLatestId)
      let ownInvocationId: string | undefined;
      // F111 Phase B: Streaming TTS chunker for real-time voice (voiceMode only)
      let voiceChunker: StreamingTtsChunker | undefined;

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
      let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

      // Always pass isLastCat:false — we set isFinal AFTER A2A detection
      log.debug(
        { catId: catId as string, threadId, promptLength: prompt.length, index, worklistSize: worklist.length },
        'Invoking cat via invokeSingleCat',
      );
      const leakedPayloadStripper = createLeakedToolCallStreamStripper();
      for await (const msg of invokeSingleCat(deps.invocationDeps, {
        catId,
        service: getService(deps.services, catId),
        prompt,
        userId,
        threadId,
        ...(targetContentBlocks ? { contentBlocks: targetContentBlocks } : {}),
        ...(targetUploadDir ? { uploadDir: targetUploadDir } : {}),
        ...(signal ? { signal } : {}),
        ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
        ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
        // F121: Pass A2A trigger message ID for auto-replyTo threading
        ...(worklistEntry.a2aTriggerMessageId.get(catId)
          ? { a2aTriggerMessageId: worklistEntry.a2aTriggerMessageId.get(catId) }
          : {}),
        isLastCat: false,
      })) {
        // F39 bugfix: stop yielding after cancel (pipe buffer may still drain)
        if (signal?.aborted) break;

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
                // F111 Phase B: Start streaming TTS when we have an invocationId
                if (voiceMode && deps.socketManager) {
                  const ttsRegistry = getStreamingTtsRegistry();
                  if (ttsRegistry) {
                    voiceChunker = new StreamingTtsChunker({
                      catId: catId as string,
                      invocationId: ownInvocationId!,
                      threadId,
                      voiceConfig: getCatVoice(catId as string),
                      broadcaster: deps.socketManager,
                      ttsRegistry,
                      signal,
                    });
                  }
                }
                // Issue #83: Start keepalive timer once we have an invocationId.
                // This ensures draft TTL is renewed even during long silent tool calls.
                if (deps.draftStore && !keepaliveTimer) {
                  const keepInvId = ownInvocationId!;
                  keepaliveTimer = setInterval(() => {
                    deps.draftStore!.touch(userId, threadId, keepInvId)?.catch?.(noop);
                  }, KEEPALIVE_INTERVAL_MS);
                }
              }
            } catch {
              /* ignore parse errors */
            }
          }

          if (effectiveMsg.type === 'text' && effectiveMsg.content) {
            textContent += effectiveMsg.content;
            voiceChunker?.feed(effectiveMsg.content);
          }
          // F045: Accumulate thinking blocks for persistence (F5 recovery)
          if (effectiveMsg.type === 'system_info' && effectiveMsg.content) {
            if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
              sawUserFacingSystemInfo = true;
            }
            try {
              const parsed = JSON.parse(effectiveMsg.content);
              if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
                thinkingContent += (thinkingContent ? '\n\n---\n\n' : '') + parsed.text;
              }
              // F060: Collect inline rich_block for persistence (P1 fix)
              if (parsed.type === 'rich_block' && parsed.block && isValidRichBlock(parsed.block)) {
                streamRichBlocks.push(parsed.block);
              }
            } catch {
              /* ignore parse errors */
            }
          }
          // Accumulate tool events for persistence (before draft flush so current event is available)
          const toolEvt = toStoredToolEvent(effectiveMsg);
          if (toolEvt) {
            collectedToolEvents.push(toolEvt);
          }

          // F148 OQ-2: Collect tool names for context eval
          if (effectiveMsg.type === 'tool_use' && effectiveMsg.toolName) {
            collectedToolNames.push(effectiveMsg.toolName);
          }

          // F150: Fire-and-forget tool usage counter
          if (effectiveMsg.type === 'tool_use' && deps.toolUsageCounter && effectiveMsg.catId) {
            deps.toolUsageCounter.recordToolUse(
              effectiveMsg.catId as string,
              effectiveMsg.toolName ?? 'unknown',
              effectiveMsg.toolInput as Record<string, unknown> | undefined,
            );
          }

          // #80: Draft flush — fire-and-forget periodic persistence for F5 recovery
          if (deps.draftStore && ownInvocationId) {
            const now = Date.now();
            const charDelta = textContent.length - lastFlushLen;
            const neverFlushed = lastFlushLen === 0 && lastFlushToolLen === 0;
            if (
              effectiveMsg.type === 'text' &&
              charDelta > 0 &&
              (neverFlushed || now - lastFlushTime >= FLUSH_INTERVAL_MS || charDelta >= FLUSH_CHAR_DELTA)
            ) {
              deps.draftStore
                .upsert({
                  userId,
                  threadId,
                  invocationId: ownInvocationId,
                  catId,
                  content: textContent,
                  ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                  ...(thinkingContent ? { thinking: thinkingContent } : {}),
                  updatedAt: now,
                })
                ?.catch?.(noop);
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
                    ...(thinkingContent ? { thinking: thinkingContent } : {}),
                    updatedAt: now,
                  })
                  ?.catch?.(noop);
                lastFlushLen = textContent.length;
                lastFlushToolLen = collectedToolEvents.length;
              } else {
                deps.draftStore.touch(userId, threadId, ownInvocationId)?.catch?.(noop);
              }
              lastFlushTime = now;
            }
          }

          if (effectiveMsg.type === 'error') {
            hadError = true;
            // #267: errors before abort are real provider failures; errors after abort are cleanup
            if (!signal?.aborted) hadProviderError = true;
            if (effectiveMsg.error) {
              collectedErrorText += `${collectedErrorText ? '\n' : ''}${effectiveMsg.error}`;
            }
          }
          if (effectiveMsg.metadata && !firstMetadata) {
            firstMetadata = effectiveMsg.metadata;
          }
          if (effectiveMsg.type === 'done') {
            doneMsg = effectiveMsg; // Buffer — yield after A2A detection
          } else {
            if (effectiveMsg.type === 'text' && !effectiveMsg.content) {
              continue;
            }
            // Tag CLI stdout text with origin: 'stream' (thinking/internal)
            yield effectiveMsg.type === 'text'
              ? {
                  ...effectiveMsg,
                  origin: 'stream' as const,
                  ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
                  ...(streamReplyPreview ? { replyPreview: streamReplyPreview } : {}),
                }
              : effectiveMsg;
          }
        }
      }

      // Issue #83: Stop keepalive timer — streaming loop has exited.
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = undefined;
      }

      // F111 Phase B: Flush remaining buffered text and send voice_stream_end
      let voiceTotalChunks = 0;
      if (voiceChunker) {
        try {
          voiceTotalChunks = await voiceChunker.flush();
        } catch (err) {
          log.error({ err }, 'Voice chunker flush failed');
        }
        if (deps.socketManager && voiceChunker.hasStarted()) {
          const aborted = signal?.aborted ?? false;
          deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'voice_stream_end', {
            type: 'voice_stream_end',
            catId: catId as string,
            invocationId: ownInvocationId ?? '',
            threadId,
            totalChunks: aborted ? -1 : voiceTotalChunks,
          });
        }
        voiceChunker = undefined;
      }

      let a2aMentions: CatId[] = [];

      // F22: Consume MCP-buffered rich blocks BEFORE the text/empty branch —
      // blocks must be persisted even when the cat emits no text (cloud Codex P1).
      const bufferedBlocks = getRichBlockBuffer().consume(threadId, catId as string, ownInvocationId);

      // F061: Detect @co-creator mentions in agent response for browser notification
      let mentionsUser = false;

      if (textContent) {
        catProducedOutput = true;
        const sanitized = sanitizeInjectedContent(textContent);

        // F22: Extract cc_rich blocks from text (Route B fallback for non-MCP cats)
        const { cleanText, blocks: textBlocks } = extractRichFromText(sanitized);
        const storedContent = cleanText;
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

        // In play mode, CLI stream output (thinking) is hidden from other cats.
        // Only share previousResponses in debug mode where cats see each other's thinking.
        // Important: push after review gate mutation so downstream cats see invalid-review marker.
        if (!incrementalMode && thinkingMode === 'debug') {
          previousResponses.push({ catId, content: storedContent });
        }

        // A2A mention detection (缅因猫 P1-3: only after full text accumulated)
        // Line-start @mention = always actionable (no keyword gate)
        a2aMentions = parseA2AMentions(storedContent, catId);

        // #417 / F064 AC-B3: Write-side feedback for inline action-like @mentions
        if (deps.invocationDeps.threadStore) {
          const inlineHits = detectInlineActionMentions(storedContent, catId, a2aMentions);
          if (inlineHits.length > 0) {
            try {
              await deps.invocationDeps.threadStore.setMentionRoutingFeedback(threadId, catId, {
                sourceTimestamp: Date.now(),
                items: inlineHits.map((m) => ({ targetCatId: m.catId, reason: 'inline_action' as const })),
              });
              log.info(
                { catId: catId as string, threadId, targets: inlineHits.map((h) => h.catId) },
                'Inline action @mention detected — wrote routing feedback',
              );
            } catch {
              /* best-effort */
            }
            // #1062: User-visible system message when chain would break
            // (inline action detected but no line-start @ = no routing will happen)
            if (a2aMentions.length === 0) {
              try {
                const targets = inlineHits.map((h) => `@${h.catId}`).join(', ');
                const hintSource = { connector: 'inline-mention-hint', label: 'Routing hint', icon: 'lightbulb' };
                const stored = await deps.messageStore.append({
                  userId: 'system',
                  catId: null,
                  threadId,
                  content: `💡 ${targets} was mentioned but not routed — @ must be on its own line at the start to trigger handoff.`,
                  mentions: [],
                  timestamp: Date.now(),
                  source: hintSource,
                });
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
                /* best-effort */
              }
            }
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

        const storedTimestamp = Date.now();

        // F061: Detect @co-creator mentions in agent response for browser notification
        mentionsUser = storedContent ? detectUserMention(storedContent) : false;

        // Store with actual mentions — degrade on failure to ensure done reaches frontend
        // (缅因猫 review P1-2: Redis failure must not block done yield)
        let storedMsgId: string | undefined;
        try {
          const storedMsg = await deps.messageStore.append({
            userId,
            catId,
            content: storedContent,
            mentions: a2aMentions,
            origin: 'stream',
            timestamp: storedTimestamp,
            threadId,
            ...(mentionsUser ? { mentionsUser } : {}),
            ...(thinkingContent ? { thinking: thinkingContent } : {}),
            ...(firstMetadata ? { metadata: firstMetadata } : {}),
            ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
            ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
            extra: {
              ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
              ...(ownInvocationId ? { stream: { invocationId: ownInvocationId } } : {}),
            },
          });
          storedMsgId = storedMsg.id;
          // F088-P3: Stash rich blocks for outbound delivery
          if (options.persistenceContext && allRichBlocks.length > 0) {
            options.persistenceContext.richBlocks = allRichBlocks;
          }
          // #80: Clean up draft only after successful append (guard: keep draft if append fails)
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

        // Diagnostic: log when A2A text-scan gate blocks (previously silent)
        if (a2aMentions.length > 0) {
          if (queuedMessagesPending) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount },
              'A2A text-scan blocked: user messages pending in queue (fairness gate)',
            );
          } else if (worklistEntry.a2aCount >= maxDepth) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount, maxDepth },
              'A2A text-scan blocked: depth limit reached',
            );
          } else if (signal?.aborted) {
            log.info({ threadId, catId, a2aMentions }, 'A2A text-scan blocked: signal aborted');
          }
        }

        if (a2aMentions.length > 0 && worklistEntry.a2aCount < maxDepth && !signal?.aborted && !queuedMessagesPending) {
          const pendingTail = worklist.slice(index + 1);
          const pendingOriginalTargets = targetCats.slice(index + 1);
          for (const nextCat of a2aMentions) {
            if (worklistEntry.a2aCount >= maxDepth) break;
            // A2A cross-path dedup: skip if this cat is actively processing via callback (InvocationQueue)
            if (hasQueuedOrActiveAgentForCat && hasQueuedOrActiveAgentForCat(threadId, nextCat)) {
              log.info(
                { threadId, catId: nextCat, fromCat: catId },
                'A2A text-scan dedup: cat actively processing in InvocationQueue, skipping',
              );
              continue;
            }
            if (pendingTail.includes(nextCat)) {
              // Keep original user-selected targets replying to user, not to another cat.
              if (!pendingOriginalTargets.includes(nextCat)) {
                worklistEntry.a2aFrom.set(nextCat, catId);
                // F121: response-text path — set trigger message for auto-replyTo
                if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
              }
              continue;
            }

            worklist.push(nextCat);
            worklistEntry.a2aCount++;
            pendingTail.push(nextCat); // Keep dedup view in sync
            worklistEntry.a2aFrom.set(nextCat, catId);
            // F121: response-text path — set trigger message for auto-replyTo
            if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
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

          const nextConfig: CatConfig | undefined =
            catRegistry.tryGet(pendingCat as string)?.config ?? CAT_CONFIGS[pendingCat as string];
          yield {
            type: 'a2a_handoff' as AgentMessageType,
            catId,
            content: `${catConfig?.displayName ?? catId} → ${nextConfig?.displayName ?? pendingCat}`,
            timestamp: Date.now(),
          } as AgentMessage;
        }
        handoffEmitted = worklist.length;
      } else if (!hadError) {
        // No text content and no error.
        // Persist only when we have non-text payload (tool/thinking/rich).
        // Purely empty turns should not create blank chat bubbles.
        const noTextBlocks = [...bufferedBlocks, ...streamRichBlocks];
        const hasRichBlocks = noTextBlocks.length > 0;
        const shouldPersistNoTextMessage =
          hasRichBlocks || collectedToolEvents.length > 0 || Boolean(thinkingContent?.trim().length > 0);
        const shouldEmitSilentCompletion = collectedToolEvents.length > 0 && !hasRichBlocks && !sawUserFacingSystemInfo;

        log.debug(
          {
            catId: catId as string,
            threadId,
            hasRichBlocks,
            sawUserFacingSystemInfo,
            toolCount: collectedToolEvents.length,
            shouldPersist: shouldPersistNoTextMessage,
            thinkingLen: thinkingContent?.length ?? 0,
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
              timestamp: Date.now(),
              threadId,
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              ...(thinkingContent ? { thinking: thinkingContent } : {}),
              ...(firstMetadata ? { metadata: firstMetadata } : {}),
              ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
              extra: {
                ...(noTextBlocks.length > 0 ? { rich: { v: 1 as const, blocks: noTextBlocks } } : {}),
                ...(ownInvocationId ? { stream: { invocationId: ownInvocationId } } : {}),
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
              toolCount: 0,
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
            timestamp: Date.now(),
            threadId,
            ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
            ...(firstMetadata ? { metadata: firstMetadata } : {}),
            toolEvents: collectedToolEvents,
            ...(ownInvocationId ? { extra: { stream: { invocationId: ownInvocationId } } } : {}),
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
          });
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append (error system msg) failed');
        }
      }

      // Ack cursor regardless of hadError: messages were assembled into the prompt
      // and delivered to the cat. Not acking causes infinite re-delivery on subsequent
      // rounds (bug: "砚砚每次都疯狂回之前的消息").
      if (incrementalMode && deliveryBoundaryId) {
        if (options.cursorBoundaries) {
          // ADR-008 S3: defer ack — caller acks after invocation succeeds
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
      // Skip ack on error-only turns so next turn retries delivery.
      if (
        catProducedOutput &&
        guideCandidate?.status === 'completed' &&
        shouldHandleCompletedGuide(guideCompletionOwner, targetCatIds, guideCompletionFallbackCatId, catId) &&
        deps.invocationDeps.threadStore
      ) {
        try {
          const thread = await deps.invocationDeps.threadStore.get(threadId);
          const gs = thread?.guideState;
          if (
            thread &&
            gs &&
            canAccessGuideState(thread, gs, userId) &&
            gs.guideId === guideCandidate.id &&
            gs.status === 'completed' &&
            !gs.completionAcked
          ) {
            await deps.invocationDeps.threadStore.updateGuideState(threadId, { ...gs, completionAcked: true });
          }
        } catch {
          /* best-effort: ack failure means next turn re-injects, which is acceptable */
        }
      }

      // Yield buffered done with correct isFinal (evaluated AFTER worklist may have grown)
      // MUST always reach here regardless of append success (缅因猫 review P1-2)
      if (doneMsg) {
        const isFinal = index === worklist.length - 1;
        yield { ...doneMsg, ...(mentionsUser ? { mentionsUser } : {}), isFinal };
        if (isFinal) yieldedFinalDone = true;
      }

      // F27: Advance executedIndex so pushToWorklist knows which cats are done
      worklistEntry.executedIndex = index + 1;
      index++;
    }
  } finally {
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
