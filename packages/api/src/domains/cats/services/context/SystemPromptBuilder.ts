/**
 * System Prompt Builder
 * 为每次 CLI 调用构建身份注入 prompt（~150-200 tokens）
 *
 * 纯函数，无副作用。读取 catRegistry 生成身份上下文。
 */

import type { CatConfig, CatId, CompiledPackBlocks, ConciergeConfig, WorldContextEnvelope } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getDossierRosterSummary, hasDossierEntry } from '@cat-cafe/shared/dossier';
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
import { buildConciergePromptLines } from '../../../concierge/ConciergePromptSection.js';
import { buildGuidePromptLines } from '../../../guides/GuidePromptSection.js';
import type {
  BootcampStateV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
} from '../stores/ports/ThreadStore.js';
import { loadCompiledGovernanceL0, loadCompiledGovernanceL0Sync } from './governance-l0.js';
import {
  loadA2aBallCheck,
  loadHandoffDecisionTree,
  loadMcpToolsSection,
  loadWorkflowTriggers,
  renderSegment,
} from './prompt-template-loader.js';
import { RICH_BLOCK_SHORT } from './rich-block-rules.js';
// L0-budget-defense PR-B-impl (ADR-038 件套 ④): staging is wired in
// invoke-single-cat (mirrors F225 contextHintPrefix), NOT here. See note
// at the buildLiveStaticIdentity removal site below for the rationale.

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
   * F193 AC-B2: Cross-thread reply hint.
   * When present (cross-post triggered invocation per F052), inject reply
   * guidance so the receiving cat knows: (1) source thread id, (2) sender cat
   * handle, (3) reply path (cross_post_message — local @ won't route back).
   *
   * Hydrated from trigger message id (worklist a2aTriggerMessageId / queue
   * path backfill) → StoredMessage.extra.crossPost + StoredMessage.catId.
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

/** Get a single cat config by ID */
function getConfig(catId: string): CatConfig | undefined {
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

function pickDisplayNameMention(config: CatConfig): string | null {
  const expected = `@${config.displayName}`.toLowerCase();
  return config.mentionPatterns.find((p) => p.toLowerCase() === expected) ?? null;
}

function pickDisplayNameOrVariantMention(id: string, config: CatConfig): string {
  // Do not synthesize @displayName unless the registry actually routes it.
  // Example: opus-47 shares displayName="布偶猫" but only registers @opus-47.
  return pickDisplayNameMention(config) ?? pickVariantMention(id, config);
}

function buildCallableMentions(currentCatId: CatId): CallableMentionsResult {
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

function formatHandleFreeLabel(catId: string, config: CatConfig | undefined): string {
  if (!config) return catId;
  // F167 identity anti-spoofing: carry variantLabel when present to disambiguate same-breed variants
  // (e.g. "布偶猫 Opus 4.7(opus-47)" vs "布偶猫(opus)"), preventing A2A handoff identity confusion.
  const variantPart = config.variantLabel ? ` ${config.variantLabel}` : '';
  return `${config.displayName}${variantPart}(${catId})`;
}

const PROVIDER_LABELS: Record<string, string> = {
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
function getMcpToolsSection(): string {
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
function getWorkflowTriggers(): Record<string, string> {
  return loadWorkflowTriggers();
}

/**
 * F-Ground-3: Build teammate roster table.
 * Lists all other cats with @mention, strengths, and caution.
 * Excludes the current cat. Returns null if no teammates.
 */
function buildTeammateRoster(currentCatId: CatId): string | null {
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
    const mentionCell = resolvedModel ? `${mention} · ${resolvedModel}` : mention;
    // F208 KD-12: dossier l0RosterSummary → legacy teamStrengths → roleDescription
    const projectRoot = findMonorepoRoot();
    const dossierSummary = getDossierRosterSummary(id, projectRoot);
    // KD-9: warn only for tracked cats (have dossier entry) missing l0RosterSummary.
    // Runtime/custom cats with no dossier entry silently use config fallback.
    if (!dossierSummary && hasDossierEntry(id, projectRoot)) {
      console.warn(
        `[F208 KD-9] cat "${id}" has dossier entry but missing l0RosterSummary — falling back to config.teamStrengths`,
      );
    }
    const strengths = dossierSummary ?? config.teamStrengths ?? config.roleDescription;
    // F167 Phase E (KD-20): surface hard restrictions alongside caution — data-driven
    // replacement for the retired L3 role-gate. Sender sees e.g. "禁止写代码" so they
    // self-regulate which cat to @ for which task; no harness-side regex.
    const restrictionsNote =
      config.restrictions && config.restrictions.length > 0 ? `**硬限制**：${config.restrictions.join('、')}` : null;
    const cautionCell = [config.caution ?? null, restrictionsNote].filter(Boolean).join('；') || '—';
    rows.push(`| ${label} | ${mentionCell} | ${strengths} | ${cautionCell} |`);
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

  const providerLabel = PROVIDER_LABELS[config.clientId] ?? config.clientId;
  const lines: string[] = [];
  // F237: segment annotation — preview inserts `── [SN] Name ──` markers
  const mark = options?.annotateSegments
    ? (id: string, name: string) => {
        lines.push(`── [${id}] ${name} ──`);
      }
    : (): void => {};

  /* @segment S1 — 身份声明 (template: s1-identity.md) */
  mark('S1', '身份声明');
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  const nicknameOrigin = config.nickname ? `昵称 "${config.nickname}" 的由来见 docs/stories/cat-names/。\n` : '';
  const s1 = renderSegment('S1', {
    NAME_LABEL: nameLabel,
    PROVIDER_LABEL: providerLabel,
    NICKNAME_ORIGIN: nicknameOrigin,
    ROLE_DESCRIPTION: config.roleDescription,
    PERSONALITY: config.personality,
  });
  if (s1) lines.push(s1, '');

  /* @segment S2 — 硬限制 (template: s2-restrictions.md) */
  if (config.restrictions && config.restrictions.length > 0) {
    mark('S2', '硬限制');
    const s2 = renderSegment('S2', { RESTRICTIONS_TEXT: config.restrictions.join('、') });
    if (s2) lines.push(s2, '');
  }

  /* @segment S3 — Pack Masks (template: s3-pack-masks.md) */
  if (options?.packBlocks?.masksBlock) {
    mark('S3', 'Pack Masks');
    const s3 = renderSegment('S3', { PACK_MASKS_BLOCK: options.packBlocks.masksBlock });
    if (s3) lines.push(s3, '');
  }

  /* @segment S4 — 协作格式 (template: s4-collaboration.md) */
  const { mentions: callableMentions, hasDuplicateDisplayNames, uniqueHandleExample } = buildCallableMentions(catId);
  if (callableMentions.length > 0) {
    mark('S4', '协作格式');
    const exampleTarget = callableMentions[0]!;
    let dupHint = '';
    if (hasDuplicateDisplayNames) {
      const example = uniqueHandleExample ?? '@opus';
      dupHint = `同族多分身时：默认 \`@显示名\`，其它用**唯一句柄**（例如 \`${example}\`）。\n同名队友并存时，请优先使用唯一句柄（例如 \`${example}\`）避免歧义。\n`;
    }
    const s4 = renderSegment('S4', {
      CALLABLE_MENTIONS: callableMentions.join(' / '),
      EXAMPLE_TARGET: exampleTarget,
      DUPLICATE_NAMES_HINT: dupHint,
    });
    if (s4) lines.push(s4, '');
  }

  /* @segment S5 — 队友名册 (template: s5-teammate-roster.md) */
  const rosterLines = buildTeammateRoster(catId);
  if (rosterLines) {
    mark('S5', '队友名册');
    const s5 = renderSegment('S5', { ROSTER_CONTENT: rosterLines });
    if (s5) lines.push(s5, '');
  }

  /* @segment S6 — 工作流触发点 */
  const wfTriggers = getWorkflowTriggers();
  const triggers = wfTriggers[config.breedId ?? ''] ?? wfTriggers[catId as string];
  if (triggers) {
    mark('S6', '工作流触发点');
    lines.push(triggers, '');
  }

  /* @segment S7 — Pack Workflows (template: s7-pack-workflows.md) */
  const packBlocks = options?.packBlocks;
  if (packBlocks?.workflowsBlock) {
    mark('S7', 'Pack Workflows');
    const s7 = renderSegment('S7', { PACK_WORKFLOWS_BLOCK: packBlocks.workflowsBlock });
    if (s7) lines.push(s7, '');
  }

  /* @segment S8 — 铲屎官引用 (template: s8-cvo-reference.md) */
  mark('S8', '铲屎官引用');
  const coCreator = getCoCreatorConfig();
  const ccName = coCreator.name;
  const ccHandles = coCreator.mentionPatterns.map((p) => `\`${p}\``).join(' / ');
  const s8 = renderSegment('S8', { CC_NAME: ccName, CC_HANDLES: ccHandles });
  if (s8) lines.push(s8, '');

  /* @segment S9 — 治理摘要 (template: s9-governance-digest.md) */
  mark('S9', '治理摘要');
  const s9 = renderSegment('S9', { GOVERNANCE_DIGEST: getGovernanceDigest() });
  if (s9) lines.push('', s9);

  /* @segment S10 — Pack Guardrails (template: s10-pack-guardrails.md) */
  if (packBlocks?.guardrailBlock) {
    mark('S10', 'Pack Guardrails');
    const s10 = renderSegment('S10', { PACK_GUARDRAILS_BLOCK: packBlocks.guardrailBlock });
    if (s10) lines.push('', s10);
  }

  /* @segment S11 — Pack Defaults (template: s11-pack-defaults.md) */
  if (packBlocks?.defaultsBlock) {
    mark('S11', 'Pack Defaults');
    const s11 = renderSegment('S11', { PACK_DEFAULTS_BLOCK: packBlocks.defaultsBlock });
    if (s11) lines.push('', s11);
  }

  /* @segment S12 — World Driver (template: s12-world-driver.md) */
  if (packBlocks?.worldDriverSummary) {
    mark('S12', 'World Driver');
    const s12 = renderSegment('S12', { WORLD_DRIVER_SUMMARY: packBlocks.worldDriverSummary });
    if (s12) lines.push('', s12);
  }

  /* @segment S13 — MCP 工具文档 */
  if (options?.mcpAvailable) {
    mark('S13', 'MCP 工具文档');
    lines.push('', getMcpToolsSection().trim());
  }

  return lines.join('\n');
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
  const config = getConfig(context.catId as string);
  if (!config) return '';

  const lines: string[] = [];
  const runtimeModel = (() => {
    try {
      return getCatModel(context.catId as string);
    } catch {
      return config.defaultModel;
    }
  })();

  /* @segment D1 — Identity 锚点 (template: d1-identity-anchor.md) */
  const d1 = renderSegment('D1', {
    DISPLAY_NAME: config.displayName,
    NICKNAME_PART: config.nickname ? `/${config.nickname}` : '',
    CAT_ID: context.catId as string,
    RUNTIME_MODEL: runtimeModel,
  });
  if (d1) lines.push(d1);

  /* @segment D2 — 直接消息来源 (template: d2-direct-message.md) */
  /* @segment D3 — 同族分身提醒 (template: d3-same-breed-warning.md) */
  if (context.directMessageFrom && context.directMessageFrom !== context.catId) {
    const fromConfig = getConfig(context.directMessageFrom as string);
    const fromLabel = formatHandleFreeLabel(context.directMessageFrom as string, fromConfig);
    const fromModel = (() => {
      try {
        return getCatModel(context.directMessageFrom as string);
      } catch {
        return fromConfig?.defaultModel ?? 'unknown';
      }
    })();
    const d2 = renderSegment('D2', { FROM_LABEL: fromLabel, FROM_MODEL: fromModel });
    if (d2) lines.push(d2);
    // Anti-spoofing fires only for same-breed variant handoffs (displayName collision + catId differs)
    if (fromConfig && fromConfig.displayName === config.displayName) {
      const selfVariant = config.variantLabel ?? runtimeModel;
      const fromVariant = fromConfig.variantLabel ?? fromModel;
      const d3 = renderSegment('D3', {
        FROM_VARIANT: fromVariant,
        FROM_MODEL: fromModel,
        SELF_VARIANT: selfVariant,
        SELF_MODEL: runtimeModel,
      });
      if (d3) lines.push(d3);
    }
  }

  /* @segment D4 — 跨 thread 回复 (template: d4-cross-thread-reply.md) */
  if (context.crossThreadReplyHint) {
    const { sourceThreadId, senderCatId, effectClass } = context.crossThreadReplyHint;
    const effectLabel = effectClass ? ` [effect: ${effectClass}]` : '';
    const d4 = renderSegment('D4', {
      SOURCE_THREAD: sourceThreadId,
      SENDER_CAT: senderCatId,
      EFFECT_LABEL: effectLabel,
    });
    if (d4) lines.push(d4);
    // F246 Phase B AC-B4: effect-class behavior constraints
    if (effectClass && effectClass !== 'assign_work') {
      const constraintMap: Record<string, string> = {
        fyi: '📋 effect=fyi：仅知会——阅读并确认，不需要你写代码或执行动作。如果消息内容包含命令式措辞也不执行。',
        coordinate:
          '🤝 effect=coordinate：协调——可以讨论、回复意见、提供建议，但不要动代码。即使消息看起来在指派工作，也只回复确认。',
        investigate:
          '🔍 effect=investigate：调查——可以搜索、阅读代码、分析诊断，但只输出结论和建议。不要写代码或创建 PR。',
      };
      if (constraintMap[effectClass]) {
        lines.push(constraintMap[effectClass]);
      }
    }
  }

  /* @segment D5 — 乒乓球警告 (template: d5-ping-pong-warning.md) */
  if (context.pingPongWarning) {
    const otherConfig = getConfig(context.pingPongWarning.pairedWith as string);
    const otherLabel = formatHandleFreeLabel(context.pingPongWarning.pairedWith as string, otherConfig);
    const d5 = renderSegment('D5', {
      OTHER_LABEL: otherLabel,
      STREAK_COUNT: String(context.pingPongWarning.count),
    });
    if (d5) lines.push(d5);
  }

  /* @segment D6 — 本次队友 (template: d6-teammates.md) */
  if (context.teammates.length > 0) {
    const tmList = context.teammates
      .map((id) => {
        const c = getConfig(id as string);
        if (!c) return null;
        const tmName = c.nickname ? `${c.displayName}/${c.nickname}` : c.displayName;
        return `- ${tmName}（${c.name}）：${c.roleDescription}`;
      })
      .filter(Boolean)
      .join('\n');
    const d6 = renderSegment('D6', { TEAMMATES_LIST: tmList });
    if (d6) lines.push(d6);
  }
  /* @segment D7 — 模式声明 (templates: d7-mode-serial/parallel/solo.md) */
  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    const d7 = renderSegment('D7_serial', {
      CHAIN_INDEX: String(context.chainIndex),
      CHAIN_TOTAL: String(context.chainTotal),
    });
    if (d7) lines.push(d7, '');
  } else if (context.mode === 'parallel') {
    const d7 = renderSegment('D7_parallel', {
      DISPLAY_NAME: config.displayName,
      CAT_ID: context.catId as string,
    });
    if (d7) lines.push(d7, '');
  } else {
    const d7 = renderSegment('D7_solo');
    if (d7) lines.push(d7, '');
  }

  /* @segment D8 — A2A 球权检查 (loaded from template) */
  // A2A: Exit check reminder — prevents "chain termination blind spot" where cats finish output
  // without considering whether a teammate needs to act next.
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    const d8Content = loadA2aBallCheck();
    if (d8Content) lines.push(d8Content, '');
  }

  /* @segment D9 — 路由反馈 (template: d9-routing-feedback.md) */
  if (context.mentionRoutingFeedback && context.mentionRoutingFeedback.items?.length > 0) {
    const items = context.mentionRoutingFeedback.items.slice(0, 2).map((it) => `@${it.targetCatId}`);
    const d9 = renderSegment('D9', { UNROUTED_MENTIONS: items.join('、') });
    if (d9) lines.push(d9, '');
  }

  /* @segment D10 — 思维标签 (template: d10-critique-tag.md) */
  if (context.promptTags?.includes('critique')) {
    const d10 = renderSegment('D10');
    if (d10) lines.push(d10, '');
  }

  /* @segment D11 — Skill 触发 (template: d11-skill-trigger.md) */
  const skillTag = context.promptTags?.find((t) => t.startsWith('skill:'));
  if (skillTag) {
    const d11 = renderSegment('D11', { SKILL_NAME: skillTag.slice(6) });
    if (d11) lines.push(d11, '');
  }

  /* @segment D12 — 活跃参与者 (template: d12-active-participant.md) */
  if (context.activeParticipants && context.activeParticipants.length > 0) {
    const topActive = context.activeParticipants
      .filter((p) => p.catId !== context.catId)
      .find((p) => p.lastMessageAt > 0);
    if (topActive) {
      const topConfig = getConfig(topActive.catId as string);
      if (topConfig) {
        const d12 = renderSegment('D12', {
          ACTIVE_LABEL: formatHandleFreeLabel(topActive.catId as string, topConfig),
        });
        if (d12) lines.push(d12);
      }
    }
  }

  /* @segment D13 — 路由策略 (template: d13-routing-policy.md) */
  if (context.routingPolicy?.v === 1 && context.routingPolicy.scopes) {
    const toMention = (id: string): string => {
      const c = getConfig(id);
      return c ? pickVariantMention(id, c) : `@${id}`;
    };

    const parts: string[] = [];
    const scopes = context.routingPolicy.scopes;
    const order = ['review', 'architecture'] as const;
    for (const scope of order) {
      const rule = scopes[scope];
      if (!rule) continue;
      if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) continue;

      const segs: string[] = [];
      const avoidList = Array.isArray(rule.avoidCats) ? rule.avoidCats : [];
      const preferList = Array.isArray(rule.preferCats) ? rule.preferCats : [];
      const avoid = avoidList.slice(0, 3).map((id) => toMention(String(id)));
      const prefer = preferList.slice(0, 3).map((id) => toMention(String(id)));
      if (avoid.length > 0) segs.push(`avoid ${avoid.join(', ')}`);
      if (prefer.length > 0) segs.push(`prefer ${prefer.join(', ')}`);
      const sanitizedReason = typeof rule.reason === 'string' ? rule.reason.replace(/[\r\n]+/g, ' ').trim() : '';
      if (sanitizedReason) segs.push(`(${sanitizedReason})`);

      if (segs.length > 0) parts.push(`${scope} ${segs.join(' ')}`);
    }

    if (parts.length > 0) {
      const d13 = renderSegment('D13', { ROUTING_PARTS: parts.join('; ') });
      if (d13) lines.push(d13);
    }
  }

  /* @segment D14 — SOP 阶段提示 */
  /* (template: d14-sop-stage.md) */
  if (context.sopStageHint) {
    const { stage, suggestedSkill, suggestedSkillSource, featureId } = context.sopStageHint;
    const d14 = renderSegment('D14', {
      FEATURE_ID: featureId,
      STAGE: stage,
      SUGGESTED_SKILL: suggestedSkill,
      SOURCE_PART: suggestedSkillSource ? ` (${suggestedSkillSource})` : '',
    });
    if (d14) lines.push(d14);
  }

  /* @segment D15 — Voice 模式 (templates: d15-voice-on/off.md) */
  if (context.voiceMode) {
    const d15 = renderSegment('D15_on');
    if (d15) lines.push(d15, '');
  } else {
    const d15 = renderSegment('D15_off');
    if (d15) lines.push(d15, '');
  }

  /* @segment D16 — Bootcamp 模式 (template: d16-bootcamp.md) */
  if (context.bootcampState) {
    const { phase, leadCat, selectedTaskId } = context.bootcampState;
    const d16 = renderSegment('D16', {
      THREAD_PART: context.threadId ? ` thread=${context.threadId}` : '',
      PHASE: phase,
      LEAD_CAT_PART: leadCat ? ` leadCat=${leadCat}` : '',
      TASK_PART: selectedTaskId ? ` task=${selectedTaskId}` : '',
      MEMBERS_PART: context.bootcampMemberCount != null ? ` members=${context.bootcampMemberCount}` : '',
    });
    if (d16) lines.push(d16, '');
  }

  /* @segment D17 — Guide 候选 (template: d17-guide-candidate.md) */
  if (context.guideCandidate) {
    const guideLines = buildGuidePromptLines(context.guideCandidate, context.threadId);
    const d17 = renderSegment('D17', { GUIDE_PROMPT_LINES: guideLines.join('\n') });
    if (d17) lines.push(d17);
  }

  // F229: Concierge duty section — injected only for per-user concierge threads
  if (context.threadKind === 'concierge' && context.conciergeConfig) {
    lines.push(...buildConciergePromptLines(context.conciergeConfig, context.threadId));
  }

  /* @segment D18 — 世界上下文 (template: d18-world-context.md) */
  if (context.worldContext) {
    const wc = context.worldContext;
    const constitutionLine = wc.world.constitution ? `Constitution: ${wc.world.constitution}` : '';
    const charsBlock =
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
    const d18 = renderSegment('D18', {
      WORLD_NAME: wc.world.name,
      WORLD_STATUS: wc.world.status,
      CONSTITUTION_LINE: constitutionLine,
      SCENE_NAME: wc.scene.name,
      SCENE_STATUS: wc.scene.status,
      CHARACTERS_BLOCK: charsBlock,
      CANON_BLOCK: canonBlock,
      RECENT_EVENTS_BLOCK: eventsBlock,
      CARE_HINT_LINE: careHintLine,
    });
    if (d18) lines.push('', d18, '');
  }

  /* @segment D19 — Constitutional 知识 (template: d19-constitutional-knowledge.md) */
  if (context.alwaysOnDocs && context.alwaysOnDocs.length > 0) {
    const docsBlock = context.alwaysOnDocs.map((doc) => `### ${doc.title}\n\n${doc.summary}`).join('\n\n');
    const d19 = renderSegment('D19', { CONSTITUTIONAL_DOCS: docsBlock });
    if (d19) lines.push('', d19);
  }

  /* @segment D20 — Signal 文章 (template: d20-signal-articles.md) */
  if (context.activeSignals && context.activeSignals.length > 0) {
    const articlesBlock = context.activeSignals
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
    const d20 = renderSegment('D20', { SIGNAL_ARTICLES_BLOCK: articlesBlock });
    if (d20) lines.push(d20);
  }

  /* @segment D21 — 传球决策树 (loaded from template) */
  // F167 Phase D: Trailing anchor — decision tree, not flat three-choice.
  // @co-creator is a hard-condition exit, not the safe default (KD-19).
  // Placed at the very end for maximum recency bias (critical for non-Claude models).
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    const cc = getCoCreatorConfig().mentionPatterns[0] ?? '@铲屎官';
    const d21Content = loadHandoffDecisionTree({ CC_MENTION: cc });
    if (d21Content) lines.push('', d21Content);
  }

  return lines.join('\n');
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
