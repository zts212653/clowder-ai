/**
 * System Prompt Builder
 * 为每次 CLI 调用构建身份注入 prompt（~150-200 tokens）
 *
 * 纯函数，无副作用。读取 catRegistry 生成身份上下文。
 */

import type {
  CatConfig,
  CatId,
  CompiledPackBlocks,
  ConciergeConfig,
  CrossThreadCoordination,
  WorldContextEnvelope,
} from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getDossierL0Pronouns, getDossierRosterSummary, hasDossierEntry } from '@cat-cafe/shared/dossier';
import {
  catHasRole,
  getCoCreatorConfig,
  getReviewPolicy,
  getRoster,
  isCatAvailable,
  isCatLead,
} from '../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';
// F167 Phase F P1 (cloud Codex): roster model cell must resolve via getCatModel
// (env CAT_{CATID}_MODEL → registry → defaults), not from static config.defaultModel,
// otherwise env overrides cause exactly the handle/model drift Phase F is killing.
// F237 Phase 2 (AC-P2-6): pipeline-backed builders for delegation
import {
  buildInvocationContextViaHookPipeline,
  buildStaticIdentityViaHookPipeline,
} from '../../../prompt-hooks/PipelinePromptBuilder.js';
import type {
  BootcampStateV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
} from '../stores/ports/ThreadStore.js';
import { loadCompiledGovernanceL0, loadCompiledGovernanceL0Sync } from './governance-l0.js';
import { loadMcpToolsSection, loadWorkflowTriggers } from './prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from './rich-block-rules.js';

// L0-budget-defense PR-B-impl (ADR-038 件套 ④): staging is wired in
// invoke-single-cat (mirrors F225 contextHintPrefix), NOT here. See note
// at the buildLiveStaticIdentity removal site below for the rationale.

const MERGE_GATE_SOURCE_PROVENANCE_TRIGGER = '- MG provenance override：外部finding修完后等PR truth，不@旧reviewer。';

/**
 * Context for a single cat invocation
 */
export interface InvocationContext {
  /** Which cat is being invoked */
  catId: CatId;
  /** independent = sole responder, serial = part of a chain, parallel = concurrent ideation */
  mode: 'independent' | 'serial' | 'parallel';
  /** 1-based position in chain (only for serial mode) */
  chainIndex?: number;
  /** Total cats in chain (only for serial mode) */
  chainTotal?: number;
  /** Other cats in this invocation (for teammate awareness) */
  teammates: readonly CatId[];
  /** Whether MCP tools are available for this cat */
  mcpAvailable: boolean;
  /** Whether this invocation already receives the compiled L0 through a native system/developer channel. */
  nativeL0Injected?: boolean;
  /** Prompt-level tags like 'critique' (from IntentParser) */
  promptTags?: readonly string[];
  /** Whether A2A collaboration prompt should be injected (only in serial/execute mode) */
  a2aEnabled?: boolean;
  /**
   * F042: Direct-message sender (A2A).
   * When present, the invoked cat MUST reply to this cat (not the user).
   */
  directMessageFrom?: CatId;
  /**
   * F167 L1: ping-pong streak warning.
   * When present (streak >= 2), inject a warning prompt reminding the cat
   * that they've been bouncing the same pair back and forth — consider
   * third-party input / wrap up / escalate to co-creator instead of another volley.
   */
  pingPongWarning?: {
    /** The other cat in the ping-pong pair (not this cat). */
    pairedWith: CatId;
    /** Current streak count (≥2, <4). */
    count: number;
  };
  /**
   * F193 AC-B2 / F167 Phase R: routing and coordination hint.
   * A distinct source thread injects cross-thread reply guidance. Same-thread
   * coordination may still carry terminal lifecycle state for the route guard,
   * but D4 must not describe it as a cross-thread message.
   *
   * Hydrated from trigger message id (worklist a2aTriggerMessageId / queue
   * path backfill) → StoredMessage.extra.crossPost / extra.coordination + catId.
   * MUST be structured (not parsed from prompt text) — ContextAssembler
   * only renders slice(0,8) truncated thread + lacks senderCatId.
   *
   * KD-1 boundary: only set for invocation-token cross-thread RELAY path.
   * Agent-key target-thread write does NOT inject this (no source thread).
   */
  crossThreadReplyHint?: {
    /** Full source thread id (not truncated). */
    sourceThreadId: string;
    /** Sender cat handle (catId). */
    senderCatId: CatId;
    /** F246 Phase B: effect-class label for receiving-side behavior constraints */
    effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    /** F167 Phase R: active/terminal coordination projection. */
    coordination?: CrossThreadCoordination;
  };
  /**
   * F046 D3: One-shot feedback injected when previous @mention was not routed.
   * Consumed from threadStore before invocation and cleared after injection.
   */
  mentionRoutingFeedback?: ThreadMentionRoutingFeedback;
  /** F042 Wave 3: Thread-level participant activity for @ disambiguation.
   *  Sorted by lastMessageAt desc. Injected per-invocation to survive compression. */
  activeParticipants?: readonly ThreadParticipantActivity[];
  /** F042: Thread-scoped routing policy summary (intent/scope). Injected per-invocation. */
  routingPolicy?: ThreadRoutingPolicyV1;
  /**
   * F073 P4: SOP stage hint from Mission Hub workflow-sop.
   * Injected per-invocation so all cats (Claude/Codex/Gemini) see current stage.
   * 告示牌哲学：猫看了自己决定行动，不被系统推着走。
   */
  sopStageHint?: {
    readonly stage: string;
    readonly suggestedSkill: string;
    readonly suggestedSkillSource?: string;
    readonly featureId: string;
  };
  /**
   * F091: Active Signal articles in discussion context.
   * Injected when co-creator links a Signal article in the thread.
   */
  activeSignals?: readonly {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly tier: number;
    readonly contentSnippet: string;
    readonly note?: string | undefined;
    readonly relatedDiscussions?:
      | readonly {
          readonly sessionId: string;
          readonly snippet: string;
          readonly score: number;
        }[]
      | undefined;
  }[];
  /**
   * F092: Voice companion mode.
   * When true, cats should prioritize audio rich blocks for spoken output.
   */
  voiceMode?: boolean;
  /**
   * Thread ID — injected for tools that need it (e.g. bootcamp state updates).
   */
  threadId?: string;
  /**
   * F087: Bootcamp state for operator onboarding threads.
   * When present, cats inject bootcamp-guide behavior per phase.
   */
  bootcampState?: BootcampStateV1;
  /**
   * F155: Matched guide candidate from routing-layer keyword match.
   * When present, cats load guide-interaction skill and offer the guide.
   */
  guideCandidate?: {
    id: string;
    name: string;
    estimatedTime: string;
    status: 'offered' | 'awaiting_choice' | 'active' | 'completed';
    /** True only on the first routing-layer match before any guideState has been persisted. */
    isNewOffer?: boolean;
    /** When user clicked an interactive selection, carries the chosen label. */
    userSelection?: string;
  };
  /**
   * F087: Number of cats currently registered in this account.
   * Injected alongside bootcampState so the model knows team size without querying /api/cats.
   */
  bootcampMemberCount?: number;
  /**
   * F129: Compiled pack blocks from active packs.
   * Injected into static identity via buildStaticIdentity → packBlocks.
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * F163 AC-A3: Pre-fetched always_on + constitutional docs for physical injection.
   * Populated from SqliteEvidenceStore.queryAlwaysOn() at bootstrap time.
   */
  alwaysOnDocs?: readonly { anchor: string; title: string; summary: string }[];
  /**
   * F093: World context envelope for world-building mode.
   * When present, injects world state (characters, scene, canon) into the prompt.
   */
  worldContext?: WorldContextEnvelope;
  /**
   * F229: Concierge thread marker.
   * When 'concierge', ConciergePromptSection is injected into the invocation context.
   */
  threadKind?: 'concierge';
  /**
   * F229: Per-user concierge configuration.
   * Required when threadKind === 'concierge'. Provides displayName / personaTone / dutyCatProfileId.
   */
  conciergeConfig?: ConciergeConfig;
}

/** Get all cat configs from catRegistry (.cat-cafe/cat-catalog.json) */
function getAllConfigs(): Record<string, CatConfig> {
  return catRegistry.getAllConfigs();
}

/** Get a single cat config by ID
 * @internal F237 — exported for ContextAssembler bridge; will be removed when SystemPromptBuilder is replaced.
 */
export function getConfig(catId: string): CatConfig | undefined {
  return catRegistry.tryGet(catId)?.config;
}

interface CallableCatEntry {
  readonly id: string;
  readonly config: CatConfig;
}

interface CallableMentionsResult {
  readonly mentions: string[];
  readonly hasDuplicateDisplayNames: boolean;
  readonly uniqueHandleExample: string | null;
}

function pickVariantMention(id: string, config: CatConfig): string {
  const expected = `@${id}`.toLowerCase();
  const byId = config.mentionPatterns.find((p) => p.toLowerCase() === expected);
  if (byId) return byId;
  if (config.mentionPatterns.length > 0) {
    return [...config.mentionPatterns].sort((a, b) => a.length - b.length)[0]!;
  }
  return `@${id}`;
}

/** @internal F237 — exported for AssembleBridge routing policy parity (cloud P2-1 fix) */
export function pickVariantMentionForBridge(id: string): string {
  const config = getConfig(id);
  return config ? pickVariantMention(id, config) : `@${id}`;
}

function pickDisplayNameMention(config: CatConfig): string | null {
  const expected = `@${config.displayName}`.toLowerCase();
  return config.mentionPatterns.find((p) => p.toLowerCase() === expected) ?? null;
}

function pickDisplayNameOrVariantMention(id: string, config: CatConfig): string {
  // Do not synthesize @displayName unless the registry actually routes it.
  // Example: opus-47 shares displayName="布偶猫" but only registers @opus-47.
  return pickDisplayNameMention(config) ?? pickVariantMention(id, config);
}

/** @internal F237 — exported for ContextAssembler bridge */
export function buildCallableMentions(currentCatId: CatId): CallableMentionsResult {
  const entries: CallableCatEntry[] = Object.entries(getAllConfigs())
    .filter(([id]) => id !== currentCatId && isCatAvailable(id))
    .map(([id, config]) => ({ id, config }));

  if (entries.length === 0) {
    return { mentions: [], hasDuplicateDisplayNames: false, uniqueHandleExample: null };
  }

  const byDisplayName = new Map<string, CallableCatEntry[]>();
  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName);
    if (group) {
      group.push(entry);
    } else {
      byDisplayName.set(entry.config.displayName, [entry]);
    }
  }

  const hasDuplicateDisplayNames = Array.from(byDisplayName.values()).some((group) => group.length > 1);
  const mentions: string[] = [];
  const seen = new Set<string>();
  let uniqueHandleExample: string | null = null;

  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName) ?? [];
    const mention =
      group.length <= 1 || entry.config.isDefaultVariant
        ? pickDisplayNameOrVariantMention(entry.id, entry.config)
        : pickVariantMention(entry.id, entry.config);
    if (group.length > 1 && !entry.config.isDefaultVariant && uniqueHandleExample == null) {
      uniqueHandleExample = mention;
    }
    if (!seen.has(mention)) {
      seen.add(mention);
      mentions.push(mention);
    }
  }

  return { mentions, hasDuplicateDisplayNames, uniqueHandleExample };
}

/** @internal F237 — exported for ContextAssembler bridge */
export function formatHandleFreeLabel(catId: string, config: CatConfig | undefined): string {
  if (!config) return catId;
  // F167 identity anti-spoofing: carry variantLabel when present to disambiguate same-breed variants
  // (e.g. "布偶猫 Opus 4.7(opus-47)" vs "布偶猫(opus)"), preventing A2A handoff identity confusion.
  const variantPart = config.variantLabel ? ` ${config.variantLabel}` : '';
  return `${config.displayName}${variantPart}(${catId})`;
}

function compactRosterModel(model: string): string {
  return model.replace(/-\d{8}$/u, '').replace(/^kimi-code\//u, '');
}

function compactRosterCell(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/** @internal F237 — exported for ContextAssembler bridge */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * @segment S13 — MCP tools section (loaded from template)
 * Skills-as-source-of-truth: MCP tools section is minimal.
 * Full specs live in cat-cafe-skills/refs/ (rich-blocks.md, mcp-callbacks.md).
 * Lazy-evaluated to pick up .local overlay changes (F237 Checkpoint C).
 */
/** @internal F237 — exported for ContextAssembler bridge */
export function getMcpToolsSection(): string {
  return `\n${loadMcpToolsSection({ RICH_BLOCK_SHORT })}`;
}

// --- shared-rules.md → compiled governance L0 support (#747) ---
let _governanceDigestResolved = loadCompiledGovernanceL0Sync().content;

/**
 * Preload governance overlay at startup. Call once before first prompt build.
 * Checks for shared-rules.local-override.md (replaces digest) or
 * shared-rules.local.md (appends to digest).
 */
export async function initGovernanceOverlay(): Promise<void> {
  const result = await loadCompiledGovernanceL0();
  _governanceDigestResolved = result.content;
  if (result.source !== 'base') {
    console.log(`[governance] shared-rules ${result.source}: ${result.overlayPath}`);
  }
}

export function getGovernanceDigest(): string {
  return _governanceDigestResolved;
}

/** @segment S6 — Per-breed workflow triggers (loaded from template)
 *  Keyed by breedId so all variants of a breed share the same workflow.
 *  Lazy-evaluated to pick up .local overlay changes (F237 Checkpoint C). */
/** @internal F237 — exported for ContextAssembler bridge */
export function getWorkflowTriggers(): Record<string, string> {
  const triggers = loadWorkflowTriggers();
  return Object.fromEntries(
    Object.entries(triggers).map(([breed, content]) => [breed, ensureMergeGateSourceProvenanceTrigger(content)]),
  );
}

function ensureMergeGateSourceProvenanceTrigger(content: string): string {
  if (content.includes('MG provenance override') && content.includes('外部finding修完后等PR truth')) {
    return content;
  }
  return `${content.trimEnd()}\n${MERGE_GATE_SOURCE_PROVENANCE_TRIGGER}`;
}

/**
 * F-Ground-3: Build teammate roster table.
 * Lists all other cats with @mention, strengths, and caution.
 * Excludes the current cat. Returns null if no teammates.
 */
/** @internal F237 — exported for ContextAssembler bridge */
export function buildTeammateRoster(currentCatId: CatId): string | null {
  const allConfigs = getAllConfigs();
  const entries = Object.entries(allConfigs).filter(([id]) => id !== currentCatId && isCatAvailable(id));
  if (entries.length === 0) return null;

  const rows: string[] = [];
  for (const [id, config] of entries) {
    const label = config.variantLabel
      ? `${config.displayName} ${config.variantLabel}`
      : config.nickname
        ? `${config.displayName}/${config.nickname}`
        : config.displayName;
    const projectRoot = findMonorepoRoot();
    const pronouns = getDossierL0Pronouns(id, projectRoot)?.split('/')[0]?.trim();
    const rosterLabel = pronouns ? `${config.nickname ?? label}（${pronouns}）` : label;
    const mention = pickVariantMention(id, config);
    // F167 Phase F (KD-21): surface resolved runtime model next to the @mention so
    // sender's 认知真相 aligns with runtime catalog. Handle is identity constant;
    // model is runtime-resolved metadata — the two must be visibly decoupled to
    // prevent cargo-cult projection (e.g. "云端 codex bot" → 本地 @codex 快照).
    // P1 fix (cloud Codex review): resolve via getCatModel so env overrides show through,
    // not the static template's defaultModel. Fall back to defaultModel only on error.
    let resolvedModel: string;
    try {
      resolvedModel = getCatModel(id);
    } catch {
      resolvedModel = config.defaultModel ?? '';
    }
    resolvedModel = compactRosterModel(resolvedModel);
    const mentionCell = resolvedModel ? `${mention} · ${resolvedModel}` : mention;
    // F208 KD-12: dossier l0RosterSummary → legacy teamStrengths → roleDescription
    const dossierSummary = getDossierRosterSummary(id, projectRoot);
    // KD-9: warn only for tracked cats (have dossier entry) missing l0RosterSummary.
    // Runtime/custom cats with no dossier entry silently use config fallback.
    if (!dossierSummary && hasDossierEntry(id, projectRoot)) {
      console.warn(
        `[F208 KD-9] cat "${id}" has dossier entry but missing l0RosterSummary — falling back to config.teamStrengths`,
      );
    }
    const strengths = compactRosterCell(dossierSummary ?? config.teamStrengths ?? config.roleDescription, 52);
    // F167 Phase E (KD-20): surface hard restrictions alongside caution — data-driven
    // replacement for the retired L3 role-gate. Sender sees e.g. "禁止写代码" so they
    // self-regulate which cat to @ for which task; no harness-side regex.
    const restrictionsNote =
      config.restrictions && config.restrictions.length > 0 ? `**硬限制**：${config.restrictions.join('、')}` : null;
    const cautionCell = compactRosterCell(
      [config.caution ?? null, restrictionsNote].filter(Boolean).join('；') || '—',
      72,
    );
    rows.push(`| ${rosterLabel} | ${mentionCell} | ${strengths} | ${cautionCell} |`);
  }

  return [
    '## 队友名册',
    '| 猫猫 | @mention · 当前模型 | 擅长 | 注意 |',
    '|------|---------|------|------|',
    ...rows,
  ].join('\n');
}

/**
 * Options for building the static identity prompt.
 * MCP section is included here (not in invocationContext) because it's
 * session-level — injected once on new session, skipped on --resume.
 */
export interface StaticIdentityOptions {
  /**
   * Whether native MCP tools are available (Claude with --mcp-config).
   * When true, getMcpToolsSection() is included in static identity because
   * Claude's --append-system-prompt survives context compression.
   *
   * Non-Claude cats (Codex/Gemini) use HTTP callback instructions which
   * must stay in per-message prompt because their systemPrompt is in
   * session history and MAY be lost on compression.
   */
  mcpAvailable?: boolean;
  /**
   * F129: Compiled pack blocks to inject.
   * Dual-track priority (ADR-021):
   *   Identity (core) > Pack Masks > Governance L0 > Pack Guardrails > Pack Defaults > Workflows
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * F237: When true, insert `── [SN] Name ──` markers before each segment.
   * Used by compiled-preview to show which segment generated which content.
   */
  annotateSegments?: boolean;
}

/**
 * Build static identity prompt — persistent across invocations.
 * Includes: identity, personality, rules, A2A format, workflow triggers,
 * co-creator reference, and MCP tool documentation (session-level).
 * Suitable for --system-prompt / --append-system-prompt injection.
 */
export function buildStaticIdentity(catId: CatId, options?: StaticIdentityOptions): string {
  const config = getConfig(catId as string);
  if (!config) return '';
  return buildStaticIdentityViaHookPipeline(catId, options);
}

/**
 * F203 Phase C (Task 2): the pack-only slice of the static identity.
 *
 * After L0 (non-pack identity / A2A / roster / workflow triggers / operator ref /
 * governance digest / MCP) moves to the compression-immune native system role
 * (`--system-prompt-file` for Claude, `-c developer_instructions` for Codex —
 * Task 3/4), the user-message `systemPrompt` must carry ONLY the F129 pack
 * blocks: per-invocation dynamic + external-project-specific, so they must
 * never be baked into the cached native prompt nor duplicated there.
 *
 * Returns '' for an unknown cat or when there are no pack blocks — the route
 * layer's `...(x ? { systemPrompt: x } : {})` then omits the prepend entirely.
 *
 * Block order mirrors buildStaticIdentity's dual-track priority (ADR-021):
 * masks → workflows → guardrails → defaults → worldDriver. buildStaticIdentity
 * keeps its own interleaved push sites unchanged (guard tests must not
 * regress); both paths consume the same `CompiledPackBlocks` contract.
 */
export function buildStaticIdentityPackOnly(catId: CatId, options?: StaticIdentityOptions): string {
  const config = getConfig(catId as string);
  if (!config) return '';
  const pb = options?.packBlocks;
  if (!pb) return '';
  const blocks = [pb.masksBlock, pb.workflowsBlock, pb.guardrailBlock, pb.defaultsBlock, pb.worldDriverSummary].filter(
    (b): b is string => typeof b === 'string' && b.trim().length > 0,
  );
  return blocks.join('\n\n');
}

/**
 * Build dynamic invocation context — changes per call.
 * Includes: teammates, mode, chain position, prompt tags.
 * (MCP tools and co-creator reference moved to buildStaticIdentity for session-level injection.)
 */
export function buildInvocationContext(context: InvocationContext): string {
  // AC-P2-6: delegate to HookPipeline for production path.
  // Trace events emitted during pipeline execution enable injection observability.
  // Unknown cat guard: legacy returns '', pipeline would throw (same as buildStaticIdentity)
  const config = getConfig(context.catId as string);
  if (!config) return '';
  return buildInvocationContextViaHookPipeline(context);
}

/**
 * F032 Phase D2: Build reviewer section for system prompt.
 * Shows available reviewers based on roster, filtered by family.
 *
 * Cloud Codex R5 P2 fix: When requireDifferentFamily is enabled but no cross-family
 * reviewers are available, show same-family reviewers as fallback options to match
 * the actual degradation behavior in resolveReviewer().
 *
 * Cloud Codex R6 P2 fix: Respect excludeUnavailable policy. When false, show
 * unavailable cats as available to match resolveReviewer() behavior.
 */
export function buildReviewerSection(catId: CatId): string | null {
  const roster = getRoster();
  const policy = getReviewPolicy();

  // If no roster configured, skip reviewer section
  if (Object.keys(roster).length === 0) return null;

  const currentEntry = roster[catId];
  if (!currentEntry) return null;

  // Collect reviewers in separate buckets
  const crossFamily: string[] = [];
  const sameFamily: string[] = [];
  const unavailable: string[] = [];

  for (const [id, entry] of Object.entries(roster)) {
    // Skip self
    if (id === catId) continue;
    // Must have peer-reviewer role
    if (!catHasRole(id, 'peer-reviewer')) continue;

    const config = getConfig(id);
    const displayName = config?.displayName ?? id;
    const isLead = isCatLead(id);
    const isDifferentFamily = entry.family !== currentEntry.family;

    // Build description
    const tags: string[] = [];
    if (isDifferentFamily) tags.push(entry.family);
    if (isLead) tags.push('lead');
    const desc = tags.length > 0 ? ` (${tags.join(', ')})` : '';
    const mention = `@${id}`;
    const line = `- ${mention}${desc}`;

    // Cloud Codex R6 P2 fix: Respect excludeUnavailable policy
    // When excludeUnavailable=false, treat all cats as "effectively available"
    const isEffectivelyAvailable = !policy.excludeUnavailable || isCatAvailable(id);

    if (isEffectivelyAvailable) {
      if (isDifferentFamily) {
        crossFamily.push(line);
      } else {
        sameFamily.push(line);
      }
    } else {
      unavailable.push(`- ${mention} (${displayName}, 没猫粮)`);
    }
  }

  // Determine which reviewers to show as "available"
  let available: string[];
  let fallbackNote: string | null = null;

  if (policy.requireDifferentFamily) {
    if (crossFamily.length > 0) {
      // Cross-family available, show them
      available = crossFamily;
    } else if (sameFamily.length > 0) {
      // Cloud Codex R5 P2 fix: No cross-family, but same-family available as fallback
      available = sameFamily;
      fallbackNote = '[注意] 没有跨家族 reviewer 可用，以下同家族猫可作为 fallback：';
    } else {
      available = [];
    }
  } else {
    // No family requirement, show all available
    available = [...crossFamily, ...sameFamily];
  }

  // Don't generate section if no reviewers at all
  if (available.length === 0 && unavailable.length === 0) return null;

  const lines: string[] = ['## 你当前的 Reviewers', ''];
  if (available.length > 0) {
    if (fallbackNote) {
      lines.push(fallbackNote);
    } else {
      lines.push('根据 roster 配置，你当前可以找以下猫 review：');
    }
    lines.push(...available);
    lines.push('');
  }
  if (unavailable.length > 0) {
    lines.push('[注意] 以下猫当前不可用：');
    lines.push(...unavailable);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build identity system prompt for a cat invocation.
 * Backward-compatible: returns staticIdentity + invocationContext combined.
 * Pure function — same inputs always produce same output.
 */
export function buildSystemPrompt(context: InvocationContext): string {
  const staticPart = buildStaticIdentity(context.catId, {
    mcpAvailable: context.mcpAvailable,
    packBlocks: context.packBlocks,
  });
  if (!staticPart) return '';

  const parts: string[] = [staticPart];

  // F032 Phase D2: Inject reviewer section if available
  const reviewerSection = buildReviewerSection(context.catId);
  if (reviewerSection) parts.push(reviewerSection);

  // Invocation-specific context
  const dynamicPart = buildInvocationContext(context);
  if (dynamicPart) parts.push(dynamicPart);

  return parts.join('\n\n');
}

// L0-budget-defense PR-B-impl (ADR-038 件套 ④): staging is now injected directly
// in invoke-single-cat at the per-invocation prompt prefix level (mirrors F225
// contextHintPrefix), NOT folded into staticIdentity at route-serial/parallel.
//
// Cloud R2 P1 #2237 L1099 (root cause): folding staging into staticIdentity
// causes resumed session-chain turns to drop staging, because invoke-single-cat
// skips systemPrompt injection on canSkipOnResume + isResume turns. Staging
// must apply EVERY turn per ADR-038 "每轮注入生效" contract → wire it
// independently of injectSystemPrompt.
//
// buildLiveStaticIdentity removed. buildStagingPrepend (in StagingContent.ts)
// is the single source — invoke-single-cat consumes it directly.
