/**
 * ContextAssembler — F237 Phase 2-B
 *
 * Gathers all inputs needed by hook resolvers into a typed AssemblerInput.
 * In P2-B, this translates existing InvocationContext + StaticIdentityOptions
 * into the pipeline's centralized data bag. In P2-C, the assembler will
 * replace scattered route-layer queries directly.
 *
 * Why centralize IO: hooks that query stores directly become impossible to
 * test, trace, or mock. By gathering all inputs upfront:
 * 1. Testability — unit test any hook with synthetic AssemblerInput
 * 2. Trace completeness — trace records show which inputs were present
 * 3. Performance — one round of queries per stage, not per hook
 */

import type {
  ActiveParticipantInput,
  CatConfig,
  CatConfigSnapshot,
  CatId,
  CompiledPackBlocks,
  DirectMessageInfo,
  TeammateSnapshot,
  WorldContextEnvelope,
  WorldContextInput,
} from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getCatModel } from '../../config/cat-models.js';

// ---------------------------------------------------------------------------
// Config snapshot builder
// ---------------------------------------------------------------------------

function toConfigSnapshot(config: CatConfig): CatConfigSnapshot {
  return {
    displayName: config.displayName,
    nickname: config.nickname,
    name: config.name,
    roleDescription: config.roleDescription,
    personality: config.personality,
    defaultModel: config.defaultModel,
    variantLabel: config.variantLabel,
    isDefaultVariant: config.isDefaultVariant,
    mentionPatterns: config.mentionPatterns,
    restrictions: config.restrictions,
    caution: config.caution ?? undefined,
    clientId: config.clientId,
    breedId: config.breedId,
    teamStrengths: config.teamStrengths,
  };
}

function resolveModel(catId: string, config: CatConfig): string {
  try {
    return getCatModel(catId);
  } catch {
    return config.defaultModel ?? 'unknown';
  }
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function formatHandleFreeLabel(catId: string, config: CatConfig | undefined): string {
  if (!config) return catId;
  const variantPart = config.variantLabel ? ` ${config.variantLabel}` : '';
  return `${config.displayName}${variantPart}(${catId})`;
}

// ---------------------------------------------------------------------------
// Direct message resolution
// ---------------------------------------------------------------------------

function resolveDirectMessage(
  from: CatId | undefined,
  currentCatId: string,
  currentDisplayName: string,
): DirectMessageInfo | null {
  if (!from || from === currentCatId) return null;
  const fromConfig = catRegistry.tryGet(from as string)?.config;
  if (!fromConfig) return null;
  return {
    fromCatId: from as string,
    fromLabel: formatHandleFreeLabel(from as string, fromConfig),
    fromModel: resolveModel(from as string, fromConfig),
    fromDisplayName: fromConfig.displayName,
    fromVariantLabel: fromConfig.variantLabel,
    isSameBreed: fromConfig.displayName === currentDisplayName,
  };
}

// ---------------------------------------------------------------------------
// World context flattening
// ---------------------------------------------------------------------------

function flattenWorldContext(wc: WorldContextEnvelope): WorldContextInput {
  const constitutionLine = wc.world.constitution ? `Constitution: ${wc.world.constitution}` : '';
  const charactersBlock =
    wc.characters.length > 0
      ? [
          'Characters:',
          ...wc.characters.map((ch) => {
            const identity = ch.coreIdentity?.name ?? ch.characterId;
            const drive = ch.innerDrive?.motivation ? ` — ${ch.innerDrive.motivation}` : '';
            return `- ${identity}${drive}`;
          }),
        ].join('\n')
      : '';
  const canonBlock =
    wc.canonSummary.length > 0
      ? ['Established canon:', ...wc.canonSummary.map((cs) => `- ${cs.summary}`)].join('\n')
      : '';
  const eventsBlock =
    wc.recentEvents.length > 0
      ? [
          `Recent events (${wc.recentEvents.length}):`,
          ...wc.recentEvents.slice(-5).map((ev) => `- [${ev.type}] ${JSON.stringify(ev.payload)}`),
        ].join('\n')
      : '';
  const careHintLine = wc.careLoopHint ? `Care hint: ${wc.careLoopHint.trigger} → ${wc.careLoopHint.suggestion}` : '';
  return {
    worldName: wc.world.name,
    worldStatus: wc.world.status,
    constitutionLine,
    sceneName: wc.scene.name,
    sceneStatus: wc.scene.status,
    charactersBlock,
    canonBlock,
    recentEventsBlock: eventsBlock,
    careHintLine,
  };
}

// ---------------------------------------------------------------------------
// Signal articles block formatting
// ---------------------------------------------------------------------------

function formatSignalsBlock(
  signals: readonly {
    id: string;
    title: string;
    source: string;
    tier: number;
    contentSnippet: string;
    note?: string;
    relatedDiscussions?: readonly { sessionId: string; snippet: string }[];
  }[],
): string {
  return signals
    .map((s) => {
      const parts = [`### [${s.id}] ${s.title} (${s.source}/T${s.tier})`];
      if (s.note) parts.push(`Note: ${s.note}`);
      parts.push(s.contentSnippet);
      if (s.relatedDiscussions && s.relatedDiscussions.length > 0) {
        parts.push('Related past discussions:');
        for (const d of s.relatedDiscussions) {
          parts.push(`- [session:${d.sessionId}] ${d.snippet}`);
        }
      }
      return parts.join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Teammates resolution
// ---------------------------------------------------------------------------

function resolveTeammates(teammateIds: readonly CatId[]): TeammateSnapshot[] {
  const result: TeammateSnapshot[] = [];
  for (const id of teammateIds) {
    const config = catRegistry.tryGet(id as string)?.config;
    if (!config) continue;
    const snapshot: TeammateSnapshot = {
      id: id as string,
      displayName: config.displayName,
      name: config.name,
      roleDescription: config.roleDescription,
    };
    if (config.nickname) snapshot.nickname = config.nickname;
    result.push(snapshot);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Active participants resolution
// ---------------------------------------------------------------------------

function resolveActiveParticipants(
  participants: readonly { catId: CatId; lastMessageAt: number }[] | undefined,
): ActiveParticipantInput[] {
  if (!participants || participants.length === 0) return [];
  return participants.map((p) => {
    const config = catRegistry.tryGet(p.catId as string)?.config;
    return {
      catId: p.catId as string,
      label: formatHandleFreeLabel(p.catId as string, config),
      lastMessageAt: p.lastMessageAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Always-on docs formatting
// ---------------------------------------------------------------------------

function formatAlwaysOnDocs(docs: readonly { title: string; summary: string }[]): string {
  return docs.map((doc) => `### ${doc.title}\n\n${doc.summary}`).join('\n\n');
}

// ---------------------------------------------------------------------------
// Pack blocks extraction
// ---------------------------------------------------------------------------

function extractPackBlocks(blocks: CompiledPackBlocks | null | undefined) {
  return {
    packMasksBlock: blocks?.masksBlock ?? null,
    packWorkflowsBlock: blocks?.workflowsBlock ?? null,
    packGuardrailBlock: blocks?.guardrailBlock ?? null,
    packDefaultsBlock: blocks?.defaultsBlock ?? null,
    packWorldDriverSummary: blocks?.worldDriverSummary ?? null,
  };
}

export {
  extractPackBlocks,
  flattenWorldContext,
  formatAlwaysOnDocs,
  formatHandleFreeLabel,
  formatSignalsBlock,
  resolveActiveParticipants,
  resolveDirectMessage,
  resolveModel,
  resolveTeammates,
  toConfigSnapshot,
  PROVIDER_LABELS,
};
