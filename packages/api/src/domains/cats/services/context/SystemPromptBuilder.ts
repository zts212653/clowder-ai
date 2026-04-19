/**
 * System Prompt Builder
 * 为每次 CLI 调用构建身份注入 prompt（~150-200 tokens）
 *
 * 纯函数，无副作用。读取 CAT_CONFIGS 生成身份上下文。
 */

import type { CatConfig, CatId, CompiledPackBlocks } from '@cat-cafe/shared';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import {
  catHasRole,
  getCoCreatorConfig,
  getReviewPolicy,
  getRoster,
  isCatAvailable,
  isCatLead,
} from '../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { buildGuidePromptLines } from '../../../guides/GuidePromptSection.js';
import type {
  BootcampStateV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
} from '../stores/ports/ThreadStore.js';
import { RICH_BLOCK_SHORT } from './rich-block-rules.js';

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
   * third-party input / wrap up / escalate to 铲屎官 instead of another volley.
   */
  pingPongWarning?: {
    /** The other cat in the ping-pong pair (not this cat). */
    pairedWith: CatId;
    /** Current streak count (≥2, <4). */
    count: number;
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
    readonly suggestedSkill: string | null;
    readonly featureId: string;
  };
  /**
   * F091: Active Signal articles in discussion context.
   * Injected when 铲屎官 links a Signal article in the thread.
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
   * F087: Bootcamp state for CVO onboarding threads.
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
   * F129: Compiled pack blocks from active packs.
   * Injected into static identity via buildStaticIdentity → packBlocks.
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * F163 AC-A3: Pre-fetched always_on + constitutional docs for physical injection.
   * Populated from SqliteEvidenceStore.queryAlwaysOn() at bootstrap time.
   */
  alwaysOnDocs?: readonly { anchor: string; title: string; summary: string }[];
}

/** Get all cat configs — registry first, fallback to static CAT_CONFIGS */
function getAllConfigs(): Record<string, CatConfig> {
  const registryConfigs = catRegistry.getAllConfigs();
  return Object.keys(registryConfigs).length > 0 ? registryConfigs : CAT_CONFIGS;
}

/** Get a single cat config by ID */
function getConfig(catId: string): CatConfig | undefined {
  const entry = catRegistry.tryGet(catId);
  if (entry) return entry.config;
  return CAT_CONFIGS[catId];
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

function buildCallableMentions(currentCatId: CatId): CallableMentionsResult {
  const entries: CallableCatEntry[] = Object.entries(getAllConfigs())
    .filter(([id]) => id !== currentCatId)
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
        ? `@${entry.config.displayName}`
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
 * Skills-as-source-of-truth: MCP tools section is minimal.
 * Full specs live in cat-cafe-skills/refs/ (rich-blocks.md, mcp-callbacks.md).
 */
const MCP_TOOLS_SECTION = `
MCP 工具（异步汇报；token 有效期有限）：

**记忆工具：**
- cat_cafe_search_evidence: 首选入口；depth=raw 可看消息级细节
- cat_cafe_reflect: 反思性合成

**drill-down：**
- cat_cafe_list_session_chain: 列出 session 链
- cat_cafe_read_session_digest: 读 session 摘要
- cat_cafe_read_session_events: 读 session 事件（raw/chat/handoff）
- cat_cafe_read_invocation_detail: 读单次 invocation 全事件

**协作工具：**
- cat_cafe_post_message: 异步消息
- cat_cafe_register_pr_tracking: PR tracking
- cat_cafe_get_pending_mentions: @提及
- cat_cafe_get_thread_context: thread 上下文
- cat_cafe_list_threads: thread 摘要
- cat_cafe_create_task: 🧶 毛线球（持久任务）
- cat_cafe_update_task: 更新任务状态
- cat_cafe_create_rich_block: rich block（inline）
- cat_cafe_generate_document: 文档生成→IM投递
- cat_cafe_get_rich_block_rules: rich block 规则
- cat_cafe_multi_mention: 并行拉猫讨论（先搜后问）

${RICH_BLOCK_SHORT}
需要富呈现时优先 rich block；首次使用前先 call get_rich_block_rules。
规范：cat-cafe-skills/refs/rich-blocks.md。`;

/**
 * L0 Governance Digest — always-on first principles & operational floor.
 * Compiled from cat-cafe-skills/refs/shared-rules.md (single source of truth).
 * F086 post-completion: cats couldn't see shared-rules content, only a link.
 * Design decision: inject compact L0 digest, not full text. See F086 spec.
 */
const GOVERNANCE_L0_DIGEST = `## 家规（shared-rules.md）
Rule 0: 规则是边界不是全部。边界之内保留判断力——执行规则时可以问"为什么？在这里适用吗？"认为不适用时用证据说话（Push Back协议：证据+适用性论证+替代方案，这是底线不是仪式）。判断力基于三个自问：①我在做什么（先定角色再动手）②信息源可靠吗（验证不盲信）③方案笨重？（坐标变换——换问题分解方式）
原则：P1每步产物是终态基座不是脚手架 P2自主跑完SOP不每步问铲屎官（SOP写了下一步→直接做，不问；方向不确定/阻塞→才升级） P3方向正确>速度 P4每个概念只在一处定义 P5可验证才算完成
世界观：W1猫是Agent不是API W2共享才成团队 W3用户是CVO W4产出放对目录（assets/docs/packages/） W5只回流方法论不回流数据 W6教训追到根因 W7 Knowledge Feed自动提取知识，猫不写标签——主动澄清决策/教训是否成立+提醒铲屎官看Feed W8共享视图——产物端上桌：写完文件/页面/报告→主动用navigate/preview/rich block帮铲屎官打开
纪律：用自己的身份签名[昵称/模型🐾] | 实事求是——结论基于多源证据（代码+commit+PR+文档），查完再下判断，不够就说"还没查完" | @是路由指令——发前问"到我这里结束了吗？"收到@后三选一：接（我做X）/退（退给@xxx）/升（铲屎官拍板），禁止状态描述代替球权声明（"我先hold/你继续/等以后"都是违禁句式） | runtime操作交铲屎官（只读诊断可以做） | 团队用"我们" | BACKLOG等共享状态只在main改，改完立刻commit push | 跨thread阻塞依赖双写到可追溯状态（feature doc/workflow/task），消息不是真相源 | commit带签名含模型型号（如[宪宪/Opus-46🐾]）
质量覆盖（对冲CLI"先简单后复杂"——方向错误的加速=浪费）：
- Bug先定位根因再修。复现→日志→调用链→根因→动手
- 不确定方向：停→搜→问→确认→再动手
- "完成"附证据（测试/截图/日志）。Bug先红后绿
- scope失控→记录；同类错误→提案；有价值经验→Episode→蒸馏→Eval（self-evolution+五级阶梯）
- 被铲屎官纠正理解偏差时（"不是让你…/你理解错了"等），先完成实际任务，再主动记录evidence到F167 spec（我以为→实际→偏差根因），按self-evolution归档
Magic Words（铲屎官对你说以下词=手动拉闸，仅铲屎官当前指令触发，引用/复述/讨论历史不触发）：
-「脚手架」= 你在偷懒写临时方案 → 停，审视产物是否终态，不是→重写
-「绕路了」= 局部最优但全局绕路 → 停，画出直线路径，丢掉绕路部分
-「喵约」= 你忘了我们的约定 → 重读本段家规，逐条对照当前行为
-「星星罐子」= P0不可逆风险 → 立刻停止新增副作用（不发新命令、不写新文件、不push），等铲屎官指示
-「第一性原理」= 你在堆复杂度代偿无知 → 停，重读 Round 4 数学美学讨论，用 Agent Quality = Capability × Environment Fit 审视当前方案，砍掉认知脚手架只留运行时刹车和认知路径工程
-「数学之美」= 同「第一性原理」。最优表达在正确坐标系下必然最简——如果方案需要那么多层，说明坐标系选错了`;

/** Per-breed workflow triggers: when to proactively @ other cats.
 *  Keyed by breedId so all variants of a breed share the same workflow. */
const WORKFLOW_TRIGGERS: Record<string, string> = {
  ragdoll: [
    '## 工作流（主动 @ 触发点）',
    '- 完成开发/修复 → @缅因猫 请 review',
    '- 修完 review 意见 → @缅因猫 确认修复',
    '- 遇到视觉/体验问题 → @暹罗猫 征询',
    '- Review 别人代码：每个发现给明确立场（放行/退回 + 理由）',
  ].join('\n'),
  'maine-coon': [
    '## 工作流（主动 @ 触发点）',
    '- 完成 review → @布偶猫 通知结果',
    '- 修完 bug/feature → @布偶猫 请 review',
    '- serial/handoff 场景且需要对方行动 → @ 对应猫（parallel 模式各自独立，不互 @）',
    '- 发现需要架构决策 → @布偶猫 征询',
    '- Review 代码：每个发现给明确立场（放行/退回 + 理由）',
    '- 收到 review 意见：独立判断，认为自己对就 push back（Rule 0），不全盘接受',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 接球后静默执行：收到"放行"后沉默做到下一状态迁移点（BLOCKED / REVIEW READY / DONE）',
    '- 声明 = 执行：说"我进 merge gate"必须同 turn 加载 skill 并执行',
    '- 只发状态迁移消息，中间产物留在代码里',
    '- 完成任务后必须 @ 下一棒',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
  ].join('\n'),
  siamese: [
    '## 工作流（主动 @ 触发点）',
    '- 完成设计/视觉资产 → 分别 @布偶猫 和 @缅因猫 请确认（每只猫各占一行）',
    '- 遇到技术实现问题 → @布偶猫 征询',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 涉及 UI/前端验证时：通过截图产出证据',
    '- 接球后静默执行到下一状态点（DONE / HANDOFF）',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
  ].join('\n'),
};

/**
 * F-Ground-3: Build teammate roster table.
 * Lists all other cats with @mention, strengths, and caution.
 * Excludes the current cat. Returns null if no teammates.
 */
function buildTeammateRoster(currentCatId: CatId): string | null {
  const allConfigs = getAllConfigs();
  const entries = Object.entries(allConfigs).filter(([id]) => id !== currentCatId);
  if (entries.length === 0) return null;

  const rows: string[] = [];
  for (const [id, config] of entries) {
    const label = config.variantLabel
      ? `${config.displayName} ${config.variantLabel}`
      : config.nickname
        ? `${config.displayName}/${config.nickname}`
        : config.displayName;
    const mention = pickVariantMention(id, config);
    const strengths = config.teamStrengths ?? config.roleDescription;
    const caution = config.caution ?? '—';
    rows.push(`| ${label} | ${mention} | ${strengths} | ${caution} |`);
  }

  return ['## 队友名册', '| 猫猫 | @mention | 擅长 | 注意 |', '|------|---------|------|------|', ...rows].join('\n');
}

/**
 * Options for building the static identity prompt.
 * MCP section is included here (not in invocationContext) because it's
 * session-level — injected once on new session, skipped on --resume.
 */
export interface StaticIdentityOptions {
  /**
   * Whether native MCP tools are available (Claude with --mcp-config).
   * When true, MCP_TOOLS_SECTION is included in static identity because
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
}

/**
 * Build static identity prompt — persistent across invocations.
 * Includes: identity, personality, rules, A2A format, workflow triggers,
 * 铲屎官 reference, and MCP tool documentation (session-level).
 * Suitable for --system-prompt / --append-system-prompt injection.
 */
export function buildStaticIdentity(catId: CatId, options?: StaticIdentityOptions): string {
  const config = getConfig(catId as string);
  if (!config) return '';

  const providerLabel = PROVIDER_LABELS[config.clientId] ?? config.clientId;
  const lines: string[] = [];

  // Identity
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  lines.push(
    `你是 ${nameLabel}，由 ${providerLabel} 提供的 AI 猫猫。`,
    ...(config.nickname ? [`昵称 "${config.nickname}" 的由来见 docs/stories/cat-names/。`] : []),
    `角色：${config.roleDescription}`,
    `性格：${config.personality}`,
    '',
  );

  // F129: Pack masks — role overlay (never changes core identity, see KD-3)
  if (options?.packBlocks?.masksBlock) {
    lines.push(options.packBlocks.masksBlock, '');
  }

  // A2A collaboration format (always included — cats should know how to @ even in single-cat mode)
  const { mentions: callableMentions, hasDuplicateDisplayNames, uniqueHandleExample } = buildCallableMentions(catId);
  if (callableMentions.length > 0) {
    const exampleTarget = callableMentions[0]!;
    lines.push('## 协作');
    lines.push(`你可以 @队友: ${callableMentions.join(' / ')}`);
    if (hasDuplicateDisplayNames) {
      const example = uniqueHandleExample ?? '@opus';
      lines.push(`同族多分身时：默认 \`@显示名\`，其它用**唯一句柄**（例如 \`${example}\`）。`);
      lines.push(`同名队友并存时，请优先使用唯一句柄（例如 \`${example}\`）避免歧义。`);
    }
    lines.push('格式：另起一行行首写 @猫名（行中无效，多猫各占一行），上文或下文写请求均可。');
    lines.push(`[正确] ${exampleTarget}\\n请帮忙  [正确] 内容...\\n${exampleTarget}  [错误] 行中 ${exampleTarget}`);
    lines.push('');
  }

  // F-Ground-3: Teammate roster — who to @ and what they're good at
  const rosterLines = buildTeammateRoster(catId);
  if (rosterLines) {
    lines.push(rosterLines, '');
  }

  // Per-breed workflow triggers (fallback to catId for legacy configs without breedId)
  const triggers = WORKFLOW_TRIGGERS[config.breedId ?? ''] ?? WORKFLOW_TRIGGERS[catId as string];
  if (triggers) {
    lines.push(triggers, '');
  }

  // F129: Pack workflow blocks (after breed workflow triggers)
  const packBlocks = options?.packBlocks;
  if (packBlocks?.workflowsBlock) {
    lines.push(packBlocks.workflowsBlock, '');
  }

  // 铲屎官 reference (session-level, not per-message)
  // F067: Use co-creator config for name + mention handles
  // Note: "不冒充/不编造/身份契约" folded into GOVERNANCE_L0_DIGEST
  const coCreator = getCoCreatorConfig();
  const ccName = coCreator.name;
  const ccHandles = coCreator.mentionPatterns.map((p) => `\`${p}\``).join(' / ');
  lines.push(`${ccName}（铲屎官/CVO）。重要决策由${ccName}拍板。需要关注时行首写 ${ccHandles}。`, '');

  // L0 Governance Digest — always-on principles from shared-rules.md (F086 post-completion fix)
  // Source of truth: cat-cafe-skills/refs/shared-rules.md
  lines.push('', GOVERNANCE_L0_DIGEST);

  // F129: Pack guardrails — hard constraint track (only adds strictness, never relaxes Core Rails)
  if (packBlocks?.guardrailBlock) {
    lines.push('', packBlocks.guardrailBlock);
  }

  // F129: Pack defaults — user-overridable behavior track
  if (packBlocks?.defaultsBlock) {
    lines.push('', packBlocks.defaultsBlock);
  }

  // F129: World driver summary (read-only, informational)
  if (packBlocks?.worldDriverSummary) {
    lines.push('', packBlocks.worldDriverSummary);
  }

  // MCP tools documentation — ONLY for Claude (--append-system-prompt survives compression).
  // Non-Claude cats (Codex/Gemini) inject HTTP callback instructions per-message
  // because their systemPrompt lives in session history and may be lost on compression.
  if (options?.mcpAvailable) {
    lines.push('', MCP_TOOLS_SECTION.trim());
  }

  return lines.join('\n');
}

/**
 * Build dynamic invocation context — changes per call.
 * Includes: teammates, mode, chain position, prompt tags.
 * (MCP tools and 铲屎官 reference moved to buildStaticIdentity for session-level injection.)
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

  // F042: Identity constant — pinned per invocation to survive compression.
  lines.push(
    `Identity: ${config.displayName}${config.nickname ? `/${config.nickname}` : ''} (@${context.catId}, model=${runtimeModel})`,
  );

  // F042 + F167: A2A direct-message reply target + identity anti-spoofing.
  // When handoff comes from a same-breed variant (same displayName, different catId),
  // inject explicit model markers + "not-you" reminder to prevent identity collapse
  // (e.g. opus-47 receiving from opus-default conflating itself with the 4.6 variant).
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
    lines.push(`Direct message from ${fromLabel} [model=${fromModel}]; reply to ${fromLabel}`);
    // Anti-spoofing fires only for same-breed variant handoffs (displayName collision + catId differs)
    if (fromConfig && fromConfig.displayName === config.displayName) {
      const selfVariant = config.variantLabel ?? runtimeModel;
      const fromVariant = fromConfig.variantLabel ?? fromModel;
      lines.push(
        `⚠️ 同族分身提醒：对方是 ${fromVariant}（model=${fromModel}），你是 ${selfVariant}（model=${runtimeModel}）——两个独立分身，不是你的旧版或新版。`,
      );
    }
  }

  // F167 L1: ping-pong streak warning — inject when this cat just received the ball
  // in a same-pair streak >= 2 (but < 4, else it would have been blocked upstream).
  if (context.pingPongWarning) {
    const otherConfig = getConfig(context.pingPongWarning.pairedWith as string);
    const otherLabel = formatHandleFreeLabel(context.pingPongWarning.pairedWith as string, otherConfig);
    lines.push(
      `🏓 乒乓球警告：你和 ${otherLabel} 已连续互相 @ ${context.pingPongWarning.count} 轮。思考是否真的需要再回一棒——第三方介入？收尾给铲屎官？还是这轮可以不 @？再 @ 2 轮将自动熔断。`,
    );
  }

  // Teammates — only list cats actually in this invocation
  if (context.teammates.length > 0) {
    lines.push('你的队友：');
    for (const id of context.teammates) {
      const c = getConfig(id as string);
      if (c) {
        const tmName = c.nickname ? `${c.displayName}/${c.nickname}` : c.displayName;
        lines.push(`- ${tmName}（${c.name}）：${c.roleDescription}`);
      }
    }
  }
  // Mode context
  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    lines.push(`当前模式：你是第 ${context.chainIndex}/${context.chainTotal} 只被召唤的猫，请注意前面猫的回复。`, '');
  } else if (context.mode === 'parallel') {
    lines.push(
      '当前模式：并行模式——独立思考。你和队友各自独立回答同一问题，给出你自己的观点。',
      `重要：你是 ${config.displayName}（@${context.catId}），不要复制或模仿其他猫的自我介绍。`,
      'F167 L2: @句柄 在并行模式下无路由语义（各猫并发、无先后顺序），不要互相 @；需要提醒队友做后续动作请等串行轮再说。',
      '',
    );
  } else {
    lines.push('当前模式：独立回答。', '');
  }

  // A2A: Exit check reminder — prevents "chain termination blind spot" where cats finish output
  // without considering whether a teammate needs to act next.
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    const ccHandle = getCoCreatorConfig().mentionPatterns[0] ?? '@铲屎官';
    lines.push(
      `A2A 球权检查：@ = 球权转移（行首 @句柄，句中无效）。下一棒是谁？猫 → 末尾行首 @句柄 / 铲屎官需要动 → 末尾行首 ${ccHandle} / 没人 → 不 @。收到 @ 但对方说"我在动" → 矛盾，push back + 立刻接/退/升（诊断≠解决，说完不@=球还在地上）。收了球却说"你等着/你别动" → 球权死锁，禁止——做不了就退回或升级。不 @ 但自己还在干活 → 结尾声明"球在我手上，继续 X"，防止倒装句让人误判你走了。`,
      '',
    );
  }

  // F064: One-shot feedback when previous @mention was not routed.
  if (context.mentionRoutingFeedback && context.mentionRoutingFeedback.items?.length > 0) {
    const items = context.mentionRoutingFeedback.items.slice(0, 2).map((it) => `@${it.targetCatId}`);
    lines.push(
      `[路由提醒] 上次你提到了 ${items.join('、')} 但没有用行首 @ 路由。如果需要对方行动，请在行首独立一行写 @句柄。`,
      '',
    );
  }

  // Prompt tags
  if (context.promptTags?.includes('critique')) {
    lines.push('思维方式：批判性分析。挑战假设，找出漏洞，提出反例。', '');
  }

  // F140 Phase C: connector-triggered skill suggestion (hint, not directive)
  const skillTag = context.promptTags?.find((t) => t.startsWith('skill:'));
  if (skillTag) {
    lines.push(`⚡ Signal-triggered action → load skill: ${skillTag.slice(6)}`, '');
  }

  // F042 Wave 3: Active participant hint — re-injected per-invocation, survives compression.
  if (context.activeParticipants && context.activeParticipants.length > 0) {
    const topActive = context.activeParticipants
      .filter((p) => p.catId !== context.catId)
      .find((p) => p.lastMessageAt > 0);
    if (topActive) {
      const topConfig = getConfig(topActive.catId as string);
      if (topConfig) {
        lines.push(`最近活跃：${formatHandleFreeLabel(topActive.catId as string, topConfig)}`);
      }
    }
  }

  // F042: Thread routing policy hint — short, per-invocation, survives compression.
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
      // Defensive guard: data might be malformed from external persistence.
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
      lines.push(`Routing: ${parts.join('; ')}`);
    }
  }

  // F073 P4: SOP stage hint — 告示牌 (bulletin board, not controller)
  if (context.sopStageHint) {
    const { stage, suggestedSkill, featureId } = context.sopStageHint;
    const skillPart = suggestedSkill ? ` → load skill: ${suggestedSkill}` : '';
    lines.push(`SOP: ${featureId} stage=${stage}${skillPart}`);
  }

  // F092: Voice companion mode — instruct cats to prioritize audio output
  if (context.voiceMode) {
    lines.push(
      'Voice Mode ON: 铲屎官正在语音陪伴模式（AirPods，双手不空）。',
      '- 每条回复用 audio rich block 发语音（call get_rich_block_rules if unsure）',
      '- 文字是给日志看的，语音才是给铲屎官耳朵的输出',
      '- 代码/表格/长内容仍用文字，但加一段语音摘要',
      '',
    );
  } else {
    lines.push(
      'Voice Mode OFF: 不强制发语音。默认用文字回复。你仍然可以发 audio rich block，但仅在铲屎官明确要求语音时才发。',
      '',
    );
  }

  // F087: Bootcamp mode — inject phase context so cats know to guide the new CVO
  if (context.bootcampState) {
    const { phase, leadCat, selectedTaskId } = context.bootcampState;
    const threadPart = context.threadId ? ` thread=${context.threadId}` : '';
    lines.push(
      `Bootcamp Mode:${threadPart} phase=${phase}${leadCat ? ` leadCat=${leadCat}` : ''}${selectedTaskId ? ` task=${selectedTaskId}` : ''}`,
      '→ Load bootcamp-guide skill and act per current phase.',
      '',
    );
  }

  // F155: Guide candidate — inline protocol (cats don't have /Skill tool at runtime)
  if (context.guideCandidate) {
    lines.push(...buildGuidePromptLines(context.guideCandidate, context.threadId));
  }

  // F163 AC-A3: always_on constitutional knowledge injection (physical, not retrieval)
  if (context.alwaysOnDocs && context.alwaysOnDocs.length > 0) {
    lines.push('');
    lines.push('## Constitutional Knowledge (always_on)');
    lines.push('');
    for (const doc of context.alwaysOnDocs) {
      lines.push(`### ${doc.title}`);
      lines.push('');
      lines.push(doc.summary);
      lines.push('');
    }
  }

  // F091: Active Signal articles in discussion context
  if (context.activeSignals && context.activeSignals.length > 0) {
    lines.push('Signal articles linked to this thread:');
    for (const s of context.activeSignals) {
      lines.push(`### [${s.id}] ${s.title} (${s.source}/T${s.tier})`);
      if (s.note) lines.push(`Note: ${s.note}`);
      lines.push(s.contentSnippet);
      // AC-10: Related discussions from our memory architecture (session search)
      if (s.relatedDiscussions && s.relatedDiscussions.length > 0) {
        lines.push('Related past discussions:');
        for (const d of s.relatedDiscussions) {
          lines.push(`- [session:${d.sessionId}] ${d.snippet}`);
        }
      }
    }
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
