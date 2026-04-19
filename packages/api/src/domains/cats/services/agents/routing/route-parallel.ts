/**
 * Parallel Route Strategy
 * All cats respond independently to the same message.
 */

import type { CatConfig, CatId } from '@cat-cafe/shared';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import { getCatContextBudget } from '../../../../../config/cat-budgets.js';
import { getConfigSessionStrategy, isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import {
  ackGuideCompletion,
  guideContextForCat,
  prepareGuideContext,
} from '../../../../guides/GuideRoutingInterceptor.js';
import { assembleContext } from '../../context/ContextAssembler.js';
import {
  buildInvocationContext,
  buildStaticIdentity,
  type InvocationContext,
} from '../../context/SystemPromptBuilder.js';
import { formatDegradationMessage } from '../../orchestration/DegradationPolicy.js';
import { buildSessionBootstrap } from '../../session/SessionBootstrap.js';
import type { StoredToolEvent } from '../../stores/ports/MessageStore.js';
import type { Thread, ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import { getVoiceBlockSynthesizer } from '../../tts/VoiceBlockSynthesizer.js';
import type { AgentMessage, AgentMessageType, MessageMetadata } from '../../types.js';
import { invokeSingleCat } from '../invocation/invoke-single-cat.js';
import { buildMcpCallbackInstructions, needsMcpInjection } from '../invocation/McpPromptInjector.js';
import { getRichBlockBuffer } from '../invocation/RichBlockBuffer.js';
import { mergeStreams } from '../invocation/stream-merge.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { parseA2AMentions } from '../routing/a2a-mentions.js';
import { type ContextEvalInput, extractContextEvalSignals } from './context-eval.js';
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
  shouldAppendExplicitCurrentMessage,
  toStoredToolEvent,
  upsertMaxBoundary,
} from './route-helpers.js';
import { buildVoteTally, checkVoteCompletion, extractVoteFromText, VOTE_RESULT_SOURCE } from './vote-intercept.js';

const log = createModuleLogger('route-parallel');

export async function* routeParallel(
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
  } = options;
  const thinkingMode = options.thinkingMode ?? 'play';
  // P2-3 fix: also consider default MCP server path (ClaudeAgentService has fallback resolution)
  const mcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
  const incrementalMode = Boolean(currentUserMessageId && deps.deliveryCursorStore);

  const degradationMsgs: AgentMessage[] = [];
  const boundaryByCat = new Map<CatId, string | undefined>();

  // F042 Wave 3: Fetch thread participant activity once (shared across all cats).
  let activeParticipants: { catId: CatId; lastMessageAt: number; messageCount: number }[] = [];
  if (deps.invocationDeps.threadStore) {
    try {
      activeParticipants = await deps.invocationDeps.threadStore.getParticipantsWithActivity(threadId);
    } catch {
      /* best-effort */
    }
  }
  // F042: Fetch thread routingPolicy once (shared across all cats).
  let routingPolicy: ThreadRoutingPolicyV1 | undefined;
  // F073 P4: SOP stage hint from workflow-sop (告示牌 — info only, cats decide actions)
  let sopStageHint: { stage: string; suggestedSkill: string | null; featureId: string } | undefined;
  // F092: Voice companion mode
  let voiceMode: boolean | undefined;
  // F087: Bootcamp state for CVO onboarding
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

  // F155: Guide interceptor — resolve existing state + match new candidates
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

  // F148 OQ-2: briefing→invocation link per cat (must be before Promise.all — TDZ fix)
  const catBriefingMessageId = new Map<string, string>();
  // F148 OQ-2: Collect tool names and coverage maps per cat for context eval
  const catToolNames = new Map<string, string[]>();
  const catCoverageMap = new Map<string, ContextEvalInput['coverageMap']>();

  const streams = await Promise.all(
    targetCats.map(async (catId) => {
      const catConfig: CatConfig | undefined =
        catRegistry.tryGet(catId as string)?.config ?? CAT_CONFIGS[catId as string];
      const teammates = targetCats.filter((id) => id !== catId);
      // Build identity: static goes in -p content (+ systemPrompt as defense-in-depth), dynamic in -p only.
      // Non-Claude HTTP callback instructions → per-message (session history may be lost on compress).
      const mcpAvailable = (catConfig?.mcpSupport ?? false) && !!mcpServerPath;
      // F129: Load active pack blocks (best-effort)
      let packBlocks: import('@cat-cafe/shared').CompiledPackBlocks | null = null;
      if (deps.packStore) {
        const { getActivePackBlocks } = await import('../../../../packs/getActivePackBlocks.js');
        packBlocks = await getActivePackBlocks(deps.packStore);
      }
      const staticIdentity = buildStaticIdentity(catId, { mcpAvailable, packBlocks });
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
            const queryAlwaysOn = (
              deps.evidenceStore as { queryAlwaysOn?: () => Array<{ anchor: string; title: string; summary: string }> }
            ).queryAlwaysOn;
            if (queryAlwaysOn) {
              const docs = queryAlwaysOn();
              if (docs.length > 0) alwaysOnDocs = docs;
            }
          }
        } catch {
          /* fail-open: always_on lookup failure does not block invocation */
        }
      }

      const invocationContext = buildInvocationContext({
        catId,
        mode: 'parallel',
        teammates,
        mcpAvailable,
        ...(promptTags && promptTags.length > 0 ? { promptTags } : {}),
        ...(activeParticipants.length > 0 ? { activeParticipants } : {}),
        ...(routingPolicy ? { routingPolicy } : {}),
        ...(sopStageHint ? { sopStageHint } : {}),
        ...(activeSignals ? { activeSignals } : {}),
        ...(voiceMode ? { voiceMode } : {}),
        ...(bootcampState ? { bootcampState, threadId } : {}),
        ...(alwaysOnDocs && alwaysOnInjectionMode === 'on' ? { alwaysOnDocs } : {}),
        ...guideContextForCat(guideCtx, catId, targetCatIds, threadId),
      });

      const targetContentBlocks = routeContentBlocksForCat(catId, contentBlocks);
      const targetUploadDir = targetContentBlocks ? uploadDir : undefined;

      // F24 Phase E: Bootstrap context for Session #2+
      let bootstrapCtx = '';
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
            bootstrapCtx = bootstrap.text;
          }
        } catch {
          // Best-effort: bootstrap failure doesn't block invocation
        }
      }

      let prompt: string;
      if (incrementalMode) {
        // A+ fix: calculate effective context budget by deducting ALL system parts from maxPromptTokens.
        const parCatModePromptForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const parIncBudget = getCatContextBudget(catId as string);
        const parIncSystemTokens = estimateTokens(
          [staticIdentity, invocationContext, parCatModePromptForBudget, bootstrapCtx, mcpInstructions]
            .filter(Boolean)
            .join('\n'),
        );
        const parIncMessageTokens = estimateTokens(message);
        const parEffectiveContextBudget = Math.min(
          Math.max(0, parIncBudget.maxPromptTokens - parIncSystemTokens - parIncMessageTokens - 200),
          parIncBudget.maxContextTokens,
        );

        const inc = await assembleIncrementalContext(
          deps,
          userId,
          threadId,
          catId,
          currentUserMessageId,
          thinkingMode,
          { effectiveMaxContextTokens: parEffectiveContextBudget },
        );
        boundaryByCat.set(catId, inc.boundaryId);
        if (inc.degradation) {
          degradationMsgs.push({
            type: 'system_info' as AgentMessageType,
            catId,
            content: inc.degradation,
            timestamp: Date.now(),
          } as AgentMessage);
        }

        // F148 Phase E: Auto-insert context briefing when smart window triggered (AC-E1)
        if (inc.coverageMap) {
          const briefingInput = buildBriefingMessage(inc.coverageMap, threadId, inc.briefingContext);
          try {
            const stored = await deps.messageStore.append(briefingInput);
            catBriefingMessageId.set(catId, stored.id);
            catCoverageMap.set(catId, inc.coverageMap);
            // P1-3: Include full stored message in payload so frontend can addMessage directly
            degradationMsgs.push({
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
            } as AgentMessage);
          } catch {
            // fail-open: briefing is non-critical UI enhancement
          }
        }

        const parCatModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const parts = [invocationContext, parCatModePrompt, bootstrapCtx, mcpInstructions].filter(Boolean);
        if (inc.contextText) parts.push(inc.contextText);
        // F35 fix: only inject raw message when it was genuinely absent from unseen rows.
        // Defensive guard: if the current message ID is already present anywhere in
        // the assembled context text, do not append the raw message again.
        if (shouldAppendExplicitCurrentMessage(inc, currentUserMessageId)) parts.push(message);
        prompt = parts.join('\n\n---\n\n');
      } else {
        // Per-cat context budget (Phase 4.0)
        let catContextHistory = contextHistory;
        if (history && history.length > 0 && !contextHistory) {
          const budget = getCatContextBudget(catId as string);
          // F8: token-based budget — estimate non-context tokens, remainder goes to context
          // A+ fix: include catModePrompt + bootstrapCtx in system parts estimate (P2-1)
          const parCatModePromptLegacyForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
          const parSystemTokens = estimateTokens(
            [staticIdentity, invocationContext, parCatModePromptLegacyForBudget, bootstrapCtx, mcpInstructions]
              .filter(Boolean)
              .join('\n'),
          );
          const parPromptTokens = estimateTokens(message);
          const budgetForContext = Math.max(0, budget.maxPromptTokens - parSystemTokens - parPromptTokens - 200);
          const { contextText, messageCount } = assembleContext(history, {
            maxMessages: budget.maxMessages,
            maxContentLength: budget.maxContentLengthPerMsg,
            maxTotalTokens: Math.min(budgetForContext, budget.maxContextTokens),
          });
          catContextHistory = contextText || undefined;

          // Degradation check: notify user if context was truncated (count budget or char budget)
          const degradation = detectContextDegradation(history.length, messageCount, budget);
          if (degradation?.degraded) {
            degradationMsgs.push({
              type: 'system_info' as AgentMessageType,
              catId,
              content: formatDegradationMessage(degradation),
              timestamp: Date.now(),
            } as AgentMessage);
          }
        }

        const parCatModePromptLegacy = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        if (invocationContext || parCatModePromptLegacy || mcpInstructions || bootstrapCtx) {
          const parts = [invocationContext, parCatModePromptLegacy, bootstrapCtx, mcpInstructions].filter(Boolean);
          if (catContextHistory) parts.push(catContextHistory);
          prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${message}`;
        } else if (catContextHistory) {
          prompt = `${catContextHistory}\n\n---\n\n${message}`;
        } else {
          prompt = message;
        }
      }

      return invokeSingleCat(deps.invocationDeps, {
        catId,
        service: getService(deps.services, catId),
        prompt,
        userId,
        threadId,
        ...(targetContentBlocks ? { contentBlocks: targetContentBlocks } : {}),
        ...(targetUploadDir ? { uploadDir: targetUploadDir } : {}),
        ...(signal ? { signal } : {}),
        ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
        isLastCat: false,
      });
    }),
  );

  // Yield degradation notifications before streaming starts (BACKLOG #32)
  for (const dm of degradationMsgs) {
    yield dm;
  }

  const catText = new Map<string, string>();
  const catThinking = new Map<string, string>();
  const catMeta = new Map<string, MessageMetadata>();
  const catSawUserFacingSystemInfo = new Map<string, boolean>();
  const catToolEvents = new Map<string, StoredToolEvent[]>();
  // F060: Collect inline rich blocks per cat from system_info stream
  const catStreamRichBlocks = new Map<string, import('@cat-cafe/shared').RichBlock[]>();
  const catErrorText = new Map<string, string>();
  const catHadError = new Set<string>();
  // #267: track errors that happened BEFORE abort — only these are real provider failures
  const catHadProviderError = new Set<string>();
  // F22 R2 P1-1: Capture own invocationId per cat from stream
  const catInvocationId = new Map<string, string>();
  const catPayloadStrippers = new Map<string, ReturnType<typeof createLeakedToolCallStreamStripper>>();
  let completedCount = 0;
  let yieldedFinalDone = false;

  // #80: Per-cat draft flush state
  const catFlushTime = new Map<string, number>();
  const catFlushLen = new Map<string, number>();
  const catFlushToolLen = new Map<string, number>();
  const FLUSH_INTERVAL_MS = 2000;
  const FLUSH_CHAR_DELTA = 2000;
  const noop = () => {};

  // Issue #83: Independent keepalive timer — touch draft every 60s during long tool calls.
  const KEEPALIVE_INTERVAL_MS = 60_000;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  // Track which cats have had their keepalive started
  let keepaliveStarted = false;

  function getPayloadStripper(catId: string) {
    let stripper = catPayloadStrippers.get(catId);
    if (!stripper) {
      stripper = createLeakedToolCallStreamStripper();
      catPayloadStrippers.set(catId, stripper);
    }
    return stripper;
  }

  for await (const msg of mergeStreams(streams, (idx, err) => {
    log.error({ streamIndex: idx, err }, 'Parallel stream error');
  })) {
    const effectiveMsgs: AgentMessage[] = [];
    if (msg.type === 'text' && msg.content && msg.catId) {
      effectiveMsgs.push({ ...msg, content: getPayloadStripper(msg.catId).push(msg.content) });
    } else if (msg.type === 'done' && msg.catId) {
      if (msg.metadata && !catMeta.has(msg.catId)) {
        catMeta.set(msg.catId, msg.metadata);
      }
      const flushedText = getPayloadStripper(msg.catId).flush();
      if (flushedText) {
        effectiveMsgs.push({
          type: 'text',
          catId: msg.catId,
          content: flushedText,
          timestamp: msg.timestamp,
        });
      }
    } else {
      effectiveMsgs.push(msg);
    }

    for (const effectiveMsg of effectiveMsgs) {
      // F22 R2 P1-1: Capture invocationId from the initial system_info per cat.
      // Keep forwarding this boundary event so frontend can reset stale task progress.
      if (
        effectiveMsg.type === 'system_info' &&
        effectiveMsg.content &&
        effectiveMsg.catId &&
        !catInvocationId.has(effectiveMsg.catId)
      ) {
        try {
          const parsed = JSON.parse(effectiveMsg.content);
          if (parsed.type === 'invocation_created') {
            catInvocationId.set(effectiveMsg.catId, parsed.invocationId);
            // #80 fix: seed flush baseline so interval triggers after FLUSH_INTERVAL_MS
            catFlushTime.set(effectiveMsg.catId, Date.now());
            // Issue #83: Start a single keepalive timer that touches all active drafts.
            if (deps.draftStore && !keepaliveStarted) {
              keepaliveStarted = true;
              keepaliveTimer = setInterval(() => {
                for (const [, invId] of catInvocationId) {
                  deps.draftStore!.touch(userId, threadId, invId)?.catch?.(noop);
                }
              }, KEEPALIVE_INTERVAL_MS);
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }
      if (effectiveMsg.type === 'text' && effectiveMsg.content && effectiveMsg.catId) {
        catText.set(effectiveMsg.catId, (catText.get(effectiveMsg.catId) ?? '') + effectiveMsg.content);
      }
      // F045: Accumulate thinking blocks per cat for persistence (F5 recovery)
      if (effectiveMsg.type === 'system_info' && effectiveMsg.content && effectiveMsg.catId) {
        if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
          catSawUserFacingSystemInfo.set(effectiveMsg.catId, true);
        }
        try {
          const parsed = JSON.parse(effectiveMsg.content);
          if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
            const prev = catThinking.get(effectiveMsg.catId) ?? '';
            catThinking.set(effectiveMsg.catId, prev ? `${prev}\n\n---\n\n${parsed.text}` : parsed.text);
          }
          // F060: Collect inline rich_block for persistence (P1 fix)
          if (parsed.type === 'rich_block' && parsed.block && isValidRichBlock(parsed.block)) {
            const arr = catStreamRichBlocks.get(effectiveMsg.catId) ?? [];
            arr.push(parsed.block);
            catStreamRichBlocks.set(effectiveMsg.catId, arr);
          }
        } catch {
          /* ignore parse errors */
        }
      }
      if (effectiveMsg.type === 'error' && effectiveMsg.catId) {
        catHadError.add(effectiveMsg.catId);
        // #267: errors before abort are real provider failures; errors after abort are cleanup
        if (!signal?.aborted) catHadProviderError.add(effectiveMsg.catId);
        if (effectiveMsg.error) {
          const prev = catErrorText.get(effectiveMsg.catId) ?? '';
          catErrorText.set(effectiveMsg.catId, `${prev}${prev ? '\n' : ''}${effectiveMsg.error}`);
        }
      }
      // Accumulate tool events per cat
      const toolEvt = toStoredToolEvent(effectiveMsg);
      if (toolEvt && effectiveMsg.catId) {
        const arr = catToolEvents.get(effectiveMsg.catId) ?? [];
        arr.push(toolEvt);
        catToolEvents.set(effectiveMsg.catId, arr);
      }

      // F148 OQ-2: Collect tool names for context eval
      if (effectiveMsg.type === 'tool_use' && effectiveMsg.toolName && effectiveMsg.catId) {
        const names = catToolNames.get(effectiveMsg.catId) ?? [];
        names.push(effectiveMsg.toolName);
        catToolNames.set(effectiveMsg.catId, names);
      }

      // F150: Fire-and-forget tool usage counter
      if (effectiveMsg.type === 'tool_use' && deps.toolUsageCounter && effectiveMsg.catId) {
        deps.toolUsageCounter.recordToolUse(
          effectiveMsg.catId as string,
          effectiveMsg.toolName ?? 'unknown',
          effectiveMsg.toolInput as Record<string, unknown> | undefined,
        );
      }
      if (effectiveMsg.metadata && effectiveMsg.catId && !catMeta.has(effectiveMsg.catId)) {
        catMeta.set(effectiveMsg.catId, effectiveMsg.metadata);
      }

      // #80: Draft flush — fire-and-forget periodic persistence per cat
      if (deps.draftStore && effectiveMsg.catId && catInvocationId.has(effectiveMsg.catId)) {
        const invId = catInvocationId.get(effectiveMsg.catId)!;
        const now = Date.now();
        const lastFlush = catFlushTime.get(effectiveMsg.catId) ?? now;
        const lastLen = catFlushLen.get(effectiveMsg.catId) ?? 0;
        const curText = catText.get(effectiveMsg.catId) ?? '';
        const charDelta = curText.length - lastLen;

        const lastToolLen = catFlushToolLen.get(effectiveMsg.catId) ?? 0;
        const curTools = catToolEvents.get(effectiveMsg.catId);
        const curToolLen = curTools?.length ?? 0;

        const neverFlushedCat = lastLen === 0 && lastToolLen === 0;
        if (
          effectiveMsg.type === 'text' &&
          charDelta > 0 &&
          (neverFlushedCat || now - lastFlush >= FLUSH_INTERVAL_MS || charDelta >= FLUSH_CHAR_DELTA)
        ) {
          const curThinking = catThinking.get(effectiveMsg.catId);
          deps.draftStore
            .upsert({
              userId,
              threadId,
              invocationId: invId,
              catId: effectiveMsg.catId as CatId,
              content: curText,
              ...(curTools && curToolLen > 0 ? { toolEvents: curTools } : {}),
              ...(curThinking ? { thinking: curThinking } : {}),
              updatedAt: now,
            })
            ?.catch?.(noop);
          catFlushTime.set(effectiveMsg.catId, now);
          catFlushLen.set(effectiveMsg.catId, curText.length);
          catFlushToolLen.set(effectiveMsg.catId, curToolLen);
        } else if (
          (effectiveMsg.type === 'tool_use' || effectiveMsg.type === 'tool_result') &&
          // Cloud R7 P1: bypass interval for the very first flush — tool-first invocations
          // must create a draft immediately, not wait 2s for the interval gate.
          (neverFlushedCat || now - lastFlush >= FLUSH_INTERVAL_MS)
        ) {
          // Cloud R6 P1: upsert when there's unsaved text OR new tool events —
          // tool-first invocations (no text yet) must still create a draft record.
          if (curText.length > lastLen || curToolLen > lastToolLen) {
            const curThinkingTool = catThinking.get(effectiveMsg.catId);
            deps.draftStore
              .upsert({
                userId,
                threadId,
                invocationId: invId,
                catId: effectiveMsg.catId as CatId,
                content: curText,
                ...(curTools && curToolLen > 0 ? { toolEvents: curTools } : {}),
                ...(curThinkingTool ? { thinking: curThinkingTool } : {}),
                updatedAt: now,
              })
              ?.catch?.(noop);
            catFlushLen.set(effectiveMsg.catId, curText.length);
            catFlushToolLen.set(effectiveMsg.catId, curToolLen);
          } else {
            deps.draftStore.touch(userId, threadId, invId)?.catch?.(noop);
          }
          catFlushTime.set(effectiveMsg.catId, now);
        }
      }

      if (effectiveMsg.type === 'text' && !effectiveMsg.content) continue;
      yield effectiveMsg;
    }

    if (msg.type === 'done' && msg.catId) {
      completedCount++;

      // F148 OQ-2: Log briefing→invocation link + context eval signals
      const doneBriefingId = catBriefingMessageId.get(msg.catId);
      const doneInvId = catInvocationId.get(msg.catId);
      if (doneBriefingId && doneInvId) {
        const doneCoverage = catCoverageMap.get(msg.catId);
        const evalSignals = doneCoverage
          ? extractContextEvalSignals({
              coverageMap: doneCoverage,
              toolNames: catToolNames.get(msg.catId) ?? [],
              responseTokenEstimate: estimateTokens(catText.get(msg.catId) ?? ''),
            })
          : undefined;
        log.info({
          f148: 'briefing-invocation-link',
          briefingMessageId: doneBriefingId,
          invocationId: doneInvId,
          catId: msg.catId,
          threadId,
          hadError: catHadProviderError.has(msg.catId),
          ...(evalSignals ? { eval: evalSignals } : {}),
        });
      }

      // F22: Consume MCP-buffered rich blocks BEFORE text/empty branch —
      // blocks must be persisted even when the cat emits no text (cloud Codex P1).
      const ownInvId = catInvocationId.get(msg.catId);
      // Issue #83 P2 fix: Remove completed cat from keepalive set.
      // Without this, the shared keepalive timer would touch() a deleted draft,
      // recreating an orphan Redis hash key via HSET.
      catInvocationId.delete(msg.catId);
      const bufferedBlocks = getRichBlockBuffer().consume(threadId, msg.catId, ownInvId);
      let catProducedOutput = false;
      const text = catText.get(msg.catId);
      if (text) {
        catProducedOutput = true;
        const meta = catMeta.get(msg.catId);
        const sanitized = sanitizeInjectedContent(text);
        // F22: Extract cc_rich blocks from text + merge with buffered
        const { cleanText: storedContent, blocks: textBlocks } = extractRichFromText(sanitized);
        let allRichBlocks = [...bufferedBlocks, ...textBlocks, ...(catStreamRichBlocks.get(msg.catId) ?? [])];
        // F34-b: synthesize text-only audio blocks (voice messages)
        // F111: skip synthesis in voiceMode — frontend streams via /api/tts/stream
        if (!voiceMode) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && allRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              allRichBlocks = await voiceSynth.resolveVoiceBlocks(allRichBlocks, msg.catId as string);
            } catch (err) {
              log.error({ catId: msg.catId, err }, 'Voice block synthesis failed');
            }
          }
        }
        const catTools = catToolEvents.get(msg.catId);
        // F167 L2 AC-A5: parallel mode has no routing semantics, so persist mentions=[]
        // to keep parallel @ mentions out of MessageStore.getMentionsFor() / pending-mentions flow.
        // L2 suppression log below still surfaces the raw @ tokens from the text for observability.

        // F079 Phase 2: Vote interception for parallel routing.
        // @all / multi-cat requests route here, so [VOTE:xxx] must be handled too.
        const votedOption = extractVoteFromText(storedContent);
        if (votedOption && deps.invocationDeps.threadStore) {
          try {
            const voteState = await deps.invocationDeps.threadStore.getVotingState(threadId);
            if (voteState && voteState.status === 'active' && voteState.options.includes(votedOption)) {
              // Parity with HTTP/routeSerial cast validations.
              if (Date.now() > voteState.deadline) {
                log.info({ threadId, votedOption }, 'Vote expired, ignoring');
              } else if (
                voteState.voters &&
                voteState.voters.length > 0 &&
                !voteState.voters.includes(msg.catId) &&
                msg.catId !== voteState.initiatedByCat
              ) {
                log.info({ catId: msg.catId, threadId }, 'Not in voters list, ignoring vote');
              } else {
                voteState.votes[msg.catId] = votedOption;
                await deps.invocationDeps.threadStore.updateVotingState(threadId, voteState);
                log.info({ catId: msg.catId, votedOption, threadId }, 'Vote cast');

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
            log.warn({ catId: msg.catId, err: voteErr }, 'Vote interception failed');
          }
        }

        const thinking = catThinking.get(msg.catId);
        try {
          await deps.messageStore.append({
            userId,
            catId: msg.catId as CatId,
            content: storedContent,
            mentions: [],
            origin: 'stream',
            timestamp: Date.now(),
            threadId,
            ...(thinking ? { thinking } : {}),
            ...(meta ? { metadata: meta } : {}),
            ...(catTools && catTools.length > 0 ? { toolEvents: catTools } : {}),
            extra: {
              ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
              ...(ownInvId ? { stream: { invocationId: ownInvId } } : {}),
            },
          });
          // F088-P3: Stash rich blocks for outbound delivery
          if (options.persistenceContext && allRichBlocks.length > 0) {
            options.persistenceContext.richBlocks = [
              ...(options.persistenceContext.richBlocks ?? []),
              ...allRichBlocks,
            ];
          }
          // #80: Clean up draft only after successful append
          if (deps.draftStore && ownInvId) {
            deps.draftStore.delete(userId, threadId, ownInvId)?.catch?.(noop);
          }
          // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
          if (deps.invocationDeps.threadStore) {
            try {
              await deps.invocationDeps.threadStore.updateParticipantActivity(
                threadId,
                msg.catId as CatId,
                // #267: only errors before abort are provider failures
                !catHadProviderError.has(msg.catId),
              );
            } catch (activityErr) {
              log.warn({ catId: msg.catId, err: activityErr }, 'updateParticipantActivity failed');
            }
          }
        } catch (err) {
          log.error({ catId: msg.catId, err }, 'messageStore.append failed, degrading');
          if (options.persistenceContext) {
            options.persistenceContext.failed = true;
            options.persistenceContext.errors.push({
              catId: msg.catId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else if (!catHadError.has(msg.catId)) {
        // No text content and no error.
        // Persist only when there is non-text payload (tool/thinking/rich).
        // Purely empty turns should not create blank chat bubbles.
        const meta = catMeta.get(msg.catId);
        const catTools = catToolEvents.get(msg.catId);
        const thinking = catThinking.get(msg.catId);
        const noTextBlocks = [...bufferedBlocks, ...(catStreamRichBlocks.get(msg.catId) ?? [])];
        const hasRichBlocks = noTextBlocks.length > 0;
        const sawUserFacingSystemInfo = catSawUserFacingSystemInfo.get(msg.catId) === true;
        const shouldPersistNoTextMessage =
          hasRichBlocks || (catTools?.length ?? 0) > 0 || Boolean(thinking?.trim().length ?? 0);
        const shouldEmitSilentCompletion = (catTools?.length ?? 0) > 0 && !hasRichBlocks && !sawUserFacingSystemInfo;

        // Diagnostic: if cat ran tools but produced no text, emit a system_info so the
        // user sees *something* instead of a silent vanish (bugfix: silent-exit P1).
        if (shouldEmitSilentCompletion) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId: msg.catId,
            content: JSON.stringify({
              type: 'silent_completion',
              detail: `${msg.catId} completed with tool calls but no text response.`,
              toolCount: catTools?.length ?? 0,
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
              catId: msg.catId as CatId,
              content: '',
              mentions: [],
              origin: 'stream',
              timestamp: Date.now(),
              threadId,
              ...(thinking ? { thinking } : {}),
              ...(meta ? { metadata: meta } : {}),
              ...(catTools && catTools.length > 0 ? { toolEvents: catTools } : {}),
              extra: {
                ...(noTextBlocks.length > 0 ? { rich: { v: 1 as const, blocks: noTextBlocks } } : {}),
                ...(ownInvId ? { stream: { invocationId: ownInvId } } : {}),
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
            if (deps.draftStore && ownInvId) {
              deps.draftStore.delete(userId, threadId, ownInvId)?.catch?.(noop);
            }
            // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
            if (deps.invocationDeps.threadStore) {
              try {
                await deps.invocationDeps.threadStore.updateParticipantActivity(
                  threadId,
                  msg.catId as CatId,
                  // #267: only errors before abort are provider failures
                  !catHadProviderError.has(msg.catId),
                );
              } catch (activityErr) {
                log.warn({ catId: msg.catId, err: activityErr }, 'updateParticipantActivity failed');
              }
            }
          } catch (err) {
            log.error({ catId: msg.catId, err }, 'messageStore.append failed, degrading');
            if (options.persistenceContext) {
              options.persistenceContext.failed = true;
              options.persistenceContext.errors.push({
                catId: msg.catId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } else if (!sawUserFacingSystemInfo) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId: msg.catId,
            content: JSON.stringify({
              type: 'silent_completion',
              detail: `${msg.catId} completed without textual output.`,
              toolCount: 0,
            }),
            timestamp: Date.now(),
          } as AgentMessage;
          // No persisted message for fully silent turns.
          if (deps.draftStore && ownInvId) {
            deps.draftStore.delete(userId, threadId, ownInvId)?.catch?.(noop);
          }
        } else if (deps.draftStore && ownInvId) {
          deps.draftStore.delete(userId, threadId, ownInvId)?.catch?.(noop);
        }
      } else {
        // hadError but toolEvents exist — persist tool record so refresh shows what was attempted
        const catTools = catToolEvents.get(msg.catId);
        if (catTools && catTools.length > 0) {
          const meta = catMeta.get(msg.catId);
          const thinking = catThinking.get(msg.catId);
          try {
            await deps.messageStore.append({
              userId,
              catId: msg.catId as CatId,
              content: '',
              mentions: [],
              origin: 'stream',
              timestamp: Date.now(),
              threadId,
              ...(thinking ? { thinking } : {}),
              ...(meta ? { metadata: meta } : {}),
              toolEvents: catTools,
              ...(ownInvId ? { extra: { stream: { invocationId: ownInvId } } } : {}),
            });
            // #80: Clean up draft only after successful append
            if (deps.draftStore && ownInvId) {
              deps.draftStore.delete(userId, threadId, ownInvId)?.catch?.(noop);
            }
            // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
            if (deps.invocationDeps.threadStore) {
              try {
                await deps.invocationDeps.threadStore.updateParticipantActivity(
                  threadId,
                  msg.catId as CatId,
                  // #267: only errors before abort are provider failures
                  !catHadProviderError.has(msg.catId),
                );
              } catch (activityErr) {
                log.warn({ catId: msg.catId, err: activityErr }, 'updateParticipantActivity failed');
              }
            }
          } catch (err) {
            log.error({ catId: msg.catId, err }, 'messageStore.append (error+tools) failed, degrading');
            if (options.persistenceContext) {
              options.persistenceContext.failed = true;
              options.persistenceContext.errors.push({
                catId: msg.catId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }

      // Persist error as system message so it survives F5 reload but does NOT
      // re-enter the prompt as a cat message (aligned with route-serial.ts).
      // Previously errors were mixed into catText and persisted with userId=user,
      // which polluted the conversation history and caused "context poisoning".
      const errorText = catErrorText.get(msg.catId);
      if (errorText) {
        try {
          await deps.messageStore.append({
            userId: 'system',
            catId: null,
            content: `Error: ${errorText}`,
            mentions: [],
            origin: 'stream',
            timestamp: Date.now(),
            threadId,
          });
        } catch (err) {
          log.error({ catId: msg.catId, err }, 'messageStore.append (error system msg) failed');
        }
      }

      // Ack cursor regardless of error: messages were assembled into the prompt
      // and delivered to the cat. Not acking causes infinite re-delivery.
      if (incrementalMode) {
        const boundaryId = boundaryByCat.get(msg.catId as CatId);
        if (boundaryId) {
          if (options.cursorBoundaries) {
            // ADR-008 S3: defer ack — caller acks after invocation succeeds
            upsertMaxBoundary(options.cursorBoundaries, msg.catId, boundaryId);
          } else if (deps.deliveryCursorStore) {
            // Legacy: ack immediately
            try {
              await deps.deliveryCursorStore.ackCursor(userId, msg.catId as CatId, threadId, boundaryId);
            } catch (err) {
              log.error({ catId: msg.catId, err }, 'ackCursor failed');
            }
          }
        }
      }

      // F155: Ack guide completion only after cat produced visible output.
      if (deps.invocationDeps.threadStore) {
        const { createGuideStoreBridge } = await import('../../../../guides/GuideSessionRepository.js');
        const sessionStore = deps.invocationDeps.guideSessionStore!;
        await ackGuideCompletion({
          ctx: guideCtx,
          catId: msg.catId as string,
          catProducedOutput,
          targetCatIds,
          threadId,
          userId,
          guideStore: createGuideStoreBridge(sessionStore),
          threadStore: deps.invocationDeps.threadStore!,
        });
      }

      const isFinal = completedCount === targetCats.length;

      // F167 L2: parallel 模式 @ 无路由语义（independent thinking），
      // 不 emit a2a_followup_available 提示，避免引导用户/猫猫误以为 @ 真的转移了球权。
      // 若文本里仍出现 @句柄，仅记录 suppressedInParallel 日志用于观测。
      if (isFinal) {
        for (const [cid, text] of catText.entries()) {
          const ms = parseA2AMentions(text, cid as CatId);
          if (ms.length > 0) {
            log.info(
              { threadId, cat: cid, suppressedMentions: ms, suppressedInParallel: true },
              'F167 L2: parallel-mode @ mentions suppressed (no routing, no followup hint)',
            );
          }
        }
      }

      yield { ...msg, isFinal };
      if (isFinal) yieldedFinalDone = true;
    }
  }

  // done-guarantee safety net: synthesize final done if loop exited without one
  if (!yieldedFinalDone && targetCats.length > 0) {
    yield {
      type: 'done' as AgentMessageType,
      catId: targetCats[targetCats.length - 1]!,
      isFinal: true,
      timestamp: Date.now(),
    } as AgentMessage;
  }

  // Issue #83: Stop keepalive timer — streaming loop has exited.
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }
}
