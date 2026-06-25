/**
 * AssembleBridge — F237 Phase 2 (AC-P2-5)
 *
 * Converts old InvocationContext / StaticIdentityOptions into the pipeline's
 * AssemblerInput, enabling dual-path validation:
 *   old buildStaticIdentity/buildInvocationContext === pipeline.executeStage
 *
 * This bridge is temporary scaffolding for the migration — once all hooks are
 * validated, the route layer will construct AssemblerInput directly and the
 * bridge functions will be removed.
 */

import type { AssemblerInput, CatId } from '@cat-cafe/shared';
import { getCoCreatorConfig } from '../../config/cat-config-loader.js';
import { loadA2aBallCheck } from '../cats/services/context/prompt-template-loader.js';
import type { InvocationContext, StaticIdentityOptions } from '../cats/services/context/SystemPromptBuilder.js';
import {
  buildCallableMentions,
  buildTeammateRoster,
  getConfig,
  getGovernanceDigest,
  getMcpToolsSection,
  getWorkflowTriggers,
  pickVariantMentionForBridge,
} from '../cats/services/context/SystemPromptBuilder.js';
import { buildConciergePromptLines } from '../concierge/ConciergePromptSection.js';
import { buildGuidePromptLines } from '../guides/GuidePromptSection.js';
import {
  extractPackBlocks,
  flattenWorldContext,
  formatAlwaysOnDocs,
  formatHandleFreeLabel,
  formatSignalsBlock,
  PROVIDER_LABELS,
  resolveActiveParticipants,
  resolveDirectMessage,
  resolveModel,
  resolveTeammates,
  toConfigSnapshot,
} from './context-assembler.js';

// ---------------------------------------------------------------------------
// Routing policy formatting (mirrors D13 logic in SystemPromptBuilder)
// ---------------------------------------------------------------------------

interface RoutingPolicyScope {
  avoidCats?: readonly (string | CatId)[];
  preferCats?: readonly (string | CatId)[];
  reason?: string;
  expiresAt?: number;
}

export function formatRoutingPolicy(
  policy: { v?: number; scopes?: Record<string, RoutingPolicyScope> } | undefined,
): string | null {
  if (!policy || policy.v !== 1 || !policy.scopes) return null;
  const parts: string[] = [];
  const order = ['review', 'architecture'] as const;
  for (const scope of order) {
    const rule = policy.scopes[scope];
    if (!rule) continue;
    if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) continue;
    const segs: string[] = [];
    const avoidList = Array.isArray(rule.avoidCats) ? rule.avoidCats : [];
    const preferList = Array.isArray(rule.preferCats) ? rule.preferCats : [];
    const avoid = avoidList.slice(0, 3).map((id) => pickVariantMentionForBridge(String(id)));
    const prefer = preferList.slice(0, 3).map((id) => pickVariantMentionForBridge(String(id)));
    if (avoid.length > 0) segs.push(`avoid ${avoid.join(', ')}`);
    if (prefer.length > 0) segs.push(`prefer ${prefer.join(', ')}`);
    const sanitizedReason = typeof rule.reason === 'string' ? rule.reason.replace(/[\r\n]+/g, ' ').trim() : '';
    if (sanitizedReason) segs.push(`(${sanitizedReason})`);
    if (segs.length > 0) parts.push(`${scope} ${segs.join(' ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}

// ---------------------------------------------------------------------------
// Shared session-level field gathering
// ---------------------------------------------------------------------------

function gatherSessionFields(catId: string, mcpAvailable: boolean, packBlocks?: unknown) {
  const config = getConfig(catId);
  if (!config) throw new Error(`[AssembleBridge] Unknown cat: ${catId}`);

  const runtimeModel = resolveModel(catId, config);
  const providerLabel = PROVIDER_LABELS[config.clientId ?? ''] ?? config.clientId ?? '';
  const { mentions, hasDuplicateDisplayNames, uniqueHandleExample } = buildCallableMentions(catId as CatId);
  const coCreator = getCoCreatorConfig();
  const ccHandles = coCreator.mentionPatterns.map((p: string) => `\`${p}\``).join(' / ');
  const triggers = getWorkflowTriggers();
  const wfContent = triggers[config.breedId ?? ''] ?? triggers[catId] ?? null;
  const packFields = extractPackBlocks(packBlocks as Parameters<typeof extractPackBlocks>[0]);

  return {
    config,
    catConfig: toConfigSnapshot(config),
    runtimeModel,
    providerLabel,
    callableMentions: { mentions, hasDuplicateDisplayNames, uniqueHandleExample },
    rosterContent: buildTeammateRoster(catId as CatId),
    workflowTriggerContent: wfContent,
    coCreatorName: coCreator.name,
    coCreatorHandles: ccHandles,
    governanceDigest: getGovernanceDigest(),
    mcpToolsSection: mcpAvailable ? getMcpToolsSection() : '',
    coCreatorFirstMention: coCreator.mentionPatterns[0] ?? '@co-creator',
    ...packFields,
  };
}

// ---------------------------------------------------------------------------
// Assembly functions
// ---------------------------------------------------------------------------

/**
 * Assemble session-init inputs from StaticIdentityOptions.
 * Produces an AssemblerInput for session-init hooks (S1-S13, L1-L7, B1, C1).
 * Per-turn fields are filled with neutral defaults.
 */
export function assembleForSession(catId: CatId, options?: StaticIdentityOptions): AssemblerInput {
  const session = gatherSessionFields(catId as string, options?.mcpAvailable ?? false, options?.packBlocks);
  return {
    catId: catId as string,
    ...session,
    mode: 'independent',
    chainIndex: null,
    chainTotal: null,
    mcpAvailable: options?.mcpAvailable ?? false,
    nativeL0Injected: false,
    a2aEnabled: false,
    directMessage: null,
    crossThreadReplyHint: null,
    pingPongWarning: null,
    teammates: [],
    mentionRoutingItems: [],
    promptTags: [],
    activeParticipants: [],
    routingPolicyParts: null,
    sopStageHint: null,
    voiceMode: false,
    bootcampState: null,
    threadId: null,
    bootcampMemberCount: null,
    guidePromptLines: null,
    conciergeLines: null,
    worldContext: null,
    alwaysOnDocsBlock: null,
    activeSignalsBlock: null,
    a2aBallCheckContent: null,
    handoffDecisionTreeContent: null,
  };
}

/**
 * Assemble per-turn inputs from InvocationContext.
 * Produces a full AssemblerInput covering all hooks (session-init + per-turn).
 * This is the primary bridge for dual-path validation (AC-P2-5).
 */
export function assembleForTurn(context: InvocationContext): AssemblerInput {
  const session = gatherSessionFields(context.catId as string, context.mcpAvailable, context.packBlocks);
  const shouldA2A = context.mode !== 'parallel' && context.a2aEnabled === true && !context.nativeL0Injected;
  const routingItems: string[] =
    context.mentionRoutingFeedback?.items?.slice(0, 2).map((it) => `@${it.targetCatId}`) ?? [];

  return {
    catId: context.catId as string,
    ...session,
    mode: context.mode,
    chainIndex: context.chainIndex ?? null,
    chainTotal: context.chainTotal ?? null,
    mcpAvailable: context.mcpAvailable,
    nativeL0Injected: context.nativeL0Injected ?? false,
    a2aEnabled: context.a2aEnabled ?? false,
    directMessage: resolveDirectMessage(context.directMessageFrom, context.catId as string, session.config.displayName),
    crossThreadReplyHint: context.crossThreadReplyHint
      ? {
          sourceThreadId: context.crossThreadReplyHint.sourceThreadId,
          senderCatId: context.crossThreadReplyHint.senderCatId as string,
          effectClass: context.crossThreadReplyHint.effectClass,
        }
      : null,
    pingPongWarning: context.pingPongWarning
      ? {
          otherLabel: formatHandleFreeLabel(
            context.pingPongWarning.pairedWith as string,
            getConfig(context.pingPongWarning.pairedWith as string),
          ),
          count: context.pingPongWarning.count,
        }
      : null,
    teammates: resolveTeammates(context.teammates),
    mentionRoutingItems: routingItems,
    promptTags: context.promptTags ? [...context.promptTags] : [],
    activeParticipants: resolveActiveParticipants(context.activeParticipants),
    routingPolicyParts: formatRoutingPolicy(context.routingPolicy),
    sopStageHint: context.sopStageHint
      ? {
          featureId: context.sopStageHint.featureId,
          stage: context.sopStageHint.stage,
          suggestedSkill: context.sopStageHint.suggestedSkill,
          suggestedSkillSource: context.sopStageHint.suggestedSkillSource,
        }
      : null,
    voiceMode: context.voiceMode ?? false,
    bootcampState: context.bootcampState
      ? {
          phase: context.bootcampState.phase,
          leadCat: context.bootcampState.leadCat,
          selectedTaskId: context.bootcampState.selectedTaskId,
        }
      : null,
    threadId: context.threadId ?? null,
    bootcampMemberCount: context.bootcampMemberCount ?? null,
    guidePromptLines: context.guideCandidate
      ? buildGuidePromptLines(context.guideCandidate, context.threadId).join('\n')
      : null,
    conciergeLines:
      context.threadKind === 'concierge' && context.conciergeConfig
        ? buildConciergePromptLines(context.conciergeConfig, context.threadId)
        : null,
    worldContext: context.worldContext ? flattenWorldContext(context.worldContext) : null,
    alwaysOnDocsBlock:
      context.alwaysOnDocs && context.alwaysOnDocs.length > 0 ? formatAlwaysOnDocs(context.alwaysOnDocs) : null,
    activeSignalsBlock:
      context.activeSignals && context.activeSignals.length > 0 ? formatSignalsBlock(context.activeSignals) : null,
    a2aBallCheckContent: shouldA2A ? loadA2aBallCheck() || null : null,
    handoffDecisionTreeContent: null,
  };
}
