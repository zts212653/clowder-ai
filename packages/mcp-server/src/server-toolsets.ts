import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  audioTools,
  callbackMemoryTools,
  callbackTools,
  distillationTools,
  eventMemoryTools,
  evidenceTools,
  externalRuntimeSessionCallbackTools,
  externalRuntimeSessionReadTools,
  fileSliceTools,
  financeTools,
  gameActionTools,
  graphTools,
  hubActionTools,
  libraryLifecycleTools,
  limbTools,
  perspectiveTools,
  publishVerdictTools,
  recentTools,
  richBlockRulesTools,
  scheduleTools,
  sessionChainTools,
  shellTools,
  signalStudyTools,
  signalsTools,
} from './tools/index.js';

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: never) => Promise<unknown>;
};

/**
 * F061: CAT_CAFE_READONLY=true → whitelist-only tool registration.
 * Used by Antigravity's persistent MCP registration where callback credentials
 * are unavailable. Bridge handles writes; LS only gets read-only tools.
 *
 * Whitelist approach: new tools default to excluded (safer than blacklist).
 * Design doc: docs/discussions/2026-04-12-f061-antigravity-mcp-evolution-design.md
 */
export const READONLY_ALLOWED_TOOLS = new Set([
  // Evidence & knowledge (local SQLite, no credentials needed)
  // F193 Phase D AC-D1: cat_cafe_reflect tool removed (deprecated in F152 era)
  'cat_cafe_search_evidence',
  'cat_cafe_run_perspective',
  'cat_cafe_graph_resolve', // F188 Phase F AC-F1
  'cat_cafe_list_recent', // F188 Phase F AC-F2
  'cat_cafe_get_rich_block_rules',
  'cat_cafe_read_file_slice',
  // Session chain (read-only API calls, no callback creds needed)
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  'cat_cafe_list_external_runtime_sessions',
  'cat_cafe_read_external_runtime_session',
  // Signals (read-only)
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_list_studies',
  // Shell exec (F061 Bug-F workaround — read-only whitelist enforced at tool level)
  'cat_cafe_shell_exec',
  // F207 Phase B0: finance fact queries are read-only and credential-safe at wrapper boundary.
  'cat_cafe_finance_query',
]);

/**
 * F178 Phase C: Tools unlocked when agent-key credentials are available in
 * READONLY mode. These are the KD-8 allowlist — callback-authenticated write
 * tools that persistent agents (Bengal) need. File/shell mutators stay blocked.
 */
export const AGENT_KEY_TOOLS = new Set([
  'cat_cafe_post_message',
  'cat_cafe_cross_post_message',
  'cat_cafe_create_rich_block',
  'cat_cafe_get_thread_context',
  'cat_cafe_list_threads',
  'cat_cafe_register_external_runtime_session',
  // F223: first-party Hub UX actions are callback-authenticated writes that
  // persistent agent-key MCP clients need when invocation credentials are absent.
  'cat_cafe_workspace_navigate',
  'cat_cafe_preview_open',
  // F227: teleport is a callback-authenticated navigation write
  'cat_cafe_teleport',
  // F227 Task 7: backfill is a callback-authenticated write (populates Event Memory)
  'cat_cafe_backfill_events',
  // F227 (cloud P2): list_events is a callback-backed READ — callbackGet fails closed
  // without invocation/agent-key creds, so it belongs with the creds-gated tools, NOT
  // the credential-free readonly whitelist (where it'd be visible-but-unusable).
  'cat_cafe_list_events',
  // #699: Message lookup by ID
  'cat_cafe_get_message',
  // F192 Phase H AC-H4 (砚砚 R9 P1): shared-MCP cats can publish verdicts.
  'cat_cafe_publish_verdict',
]);

/**
 * F178 Phase D (V3, opus-47 + codex review 2026-06-13): Desktop tool profile
 * for fable-5 cowork adapter. Strict 10-tool whitelist for Phase 0
 * "messages + memory only". DOES NOT union with READONLY/AGENT_KEY (mode has
 * highest precedence). Any value other than 'fable-phase0' for
 * CAT_CAFE_DESKTOP_MODE → fail-fast on server startup (codex adjustment §3:
 * fail loudly, not silently empty whitelist).
 *
 * Design doc: docs/discussions/2026-06-13-fable-cowork-adapter-phase0.md
 * Review: codex HOLD V1 (msg 0001781346820469-000055-551e26fd) +
 *         APPROVE V2 (msg 0001781347107820-000075-32310aa7)
 */
export const DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS = new Set([
  // collab — 5 项消息能力
  'cat_cafe_post_message',
  'cat_cafe_cross_post_message',
  'cat_cafe_get_thread_context',
  'cat_cafe_list_threads',
  'cat_cafe_get_message',
  // memory — 5 项冷启动需要
  'cat_cafe_search_evidence',
  'cat_cafe_graph_resolve',
  'cat_cafe_list_recent',
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_digest',
]);

// F238 Phase B1a: cloud-pro-phase0 mode 给云端 ChatGPT Pro 砚砚 (gpt-pro catId)。
// 复用 fable-phase0 同 10 工具白名单 (5 collab + 5 memory)，同样 mode-precedence-
// highest，不与 READONLY/AGENT_KEY 取并集。两个 mode 共享白名单是有意为之——
// 任何一只云端猫想接入只要白名单一致，逻辑就重用；future 如需 per-mode 差异化
// 白名单，再 fork constants。
export const DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS = DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS;

const KNOWN_DESKTOP_MODES = new Set(['fable-phase0', 'cloud-pro-phase0']);

export interface ToolsetEnv {
  readonly?: boolean;
  hasAgentKey?: boolean;
  desktopMode?: string;
}

/**
 * Parse env vars into a structured ToolsetEnv. Defaults to process.env;
 * tests may pass a fixture env to avoid module-cache games.
 */
export function parseToolsetEnv(env: NodeJS.ProcessEnv = process.env): ToolsetEnv {
  const desktopMode = env.CAT_CAFE_DESKTOP_MODE?.trim();
  return {
    readonly: env.CAT_CAFE_READONLY === 'true',
    hasAgentKey: !!(env.CAT_CAFE_AGENT_KEY_SECRET || env.CAT_CAFE_AGENT_KEY_FILE || env.CAT_CAFE_AGENT_KEY_FILES),
    desktopMode: desktopMode || undefined,
  };
}

/**
 * Filter a list of tools by the current ToolsetEnv.
 *
 * Precedence (V3, codex APPROVE):
 *   1. desktopMode highest — NOT union with READONLY/AGENT_KEY whitelists.
 *      Unknown value → throw (fail-fast on server startup).
 *   2. !readonly → return all tools unchanged.
 *   3. readonly → READONLY_ALLOWED_TOOLS ∪ (hasAgentKey ? AGENT_KEY_TOOLS : ∅).
 */
export function applyReadonlyFilter(
  tools: readonly ToolDef[],
  env: ToolsetEnv = parseToolsetEnv(),
): readonly ToolDef[] {
  if (env.desktopMode) {
    if (!KNOWN_DESKTOP_MODES.has(env.desktopMode)) {
      throw new Error(
        `Unknown CAT_CAFE_DESKTOP_MODE: "${env.desktopMode}". Valid modes: ${[...KNOWN_DESKTOP_MODES].join(', ')}`,
      );
    }
    if (env.desktopMode === 'fable-phase0') {
      return tools.filter((t) => DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS.has(t.name));
    }
    if (env.desktopMode === 'cloud-pro-phase0') {
      // F238 Phase B1a: cloud-pro-phase0 复用 fable-phase0 同 10 工具白名单
      return tools.filter((t) => DESKTOP_CLOUD_PRO_PHASE0_ALLOWED_TOOLS.has(t.name));
    }
  }
  if (!env.readonly) return tools;
  return tools.filter((t) => READONLY_ALLOWED_TOOLS.has(t.name) || (!!env.hasAgentKey && AGENT_KEY_TOOLS.has(t.name)));
}

// Tool source arrays — module-load static, ENV-independent.
// Build* functions below apply the env-aware filter at register time
// (not module load), so unknown CAT_CAFE_DESKTOP_MODE fails fast at startup.
const COLLAB_TOOL_SOURCES: readonly ToolDef[] = [
  ...callbackTools,
  ...externalRuntimeSessionCallbackTools,
  ...hubActionTools,
  ...eventMemoryTools, // F227: cat_cafe_teleport
  ...publishVerdictTools, // F192 Phase H AC-H4
  ...richBlockRulesTools,
  ...gameActionTools,
  ...scheduleTools,
  ...shellTools,
];

const MEMORY_TOOL_SOURCES: readonly ToolDef[] = [
  ...callbackMemoryTools,
  ...distillationTools,
  ...evidenceTools,
  ...externalRuntimeSessionReadTools,
  ...fileSliceTools,
  ...graphTools, // F188 Phase F AC-F1
  ...libraryLifecycleTools, // F188 Phase I AC-I4
  ...perspectiveTools, // F209 Phase D
  ...recentTools, // F188 Phase F AC-F2
  // F193 Phase D AC-D1: reflectTools removed
  ...sessionChainTools,
];

const SIGNAL_TOOL_SOURCES: readonly ToolDef[] = [...signalsTools, ...signalStudyTools];
const FINANCE_TOOL_SOURCES: readonly ToolDef[] = [...financeTools];
const AUDIO_TOOL_SOURCES: readonly ToolDef[] = [...audioTools];

export function buildCollabTools(env?: ToolsetEnv): readonly ToolDef[] {
  return applyReadonlyFilter(COLLAB_TOOL_SOURCES, env);
}

export function buildMemoryTools(env?: ToolsetEnv): readonly ToolDef[] {
  return applyReadonlyFilter(MEMORY_TOOL_SOURCES, env);
}

export function buildSignalTools(env?: ToolsetEnv): readonly ToolDef[] {
  return applyReadonlyFilter(SIGNAL_TOOL_SOURCES, env);
}

export function buildFinanceTools(env?: ToolsetEnv): readonly ToolDef[] {
  return applyReadonlyFilter(FINANCE_TOOL_SOURCES, env);
}

export function buildAudioTools(env?: ToolsetEnv): readonly ToolDef[] {
  return applyReadonlyFilter(AUDIO_TOOL_SOURCES, env);
}

/**
 * F247 fix (R8 hardened, R8.2 wording corrected): MCP tool annotations
 * (readOnlyHint / destructiveHint / openWorldHint).
 *
 * 背景：ChatGPT MCP custom connector 强制要求每个 tool 设三个 hint（官方 Apps SDK 文档）。
 * 实测：缺 annotations 时 ChatGPT 平台层 safety/validation 拦截属于 **stochastic / 策略性**
 * 行为（同 payload 不同时刻不同结果），**不是** 官方承诺的 "unset=destructive default=block-every-call"。
 * 我们能做的是提供正确 annotations 让平台有判定依据，之后是否被拦截属平台不可控（详见 F247 KD-13）。
 * - 实测来源：co-creator 2026-06-21 05:36 UTC + 砚砚云端报错"此工具调用被 OpenAI 的安全检查屏蔽"
 * - 官方语义参考：https://developers.openai.com/apps-sdk/build/tools/ + /reference/
 *
 * R8 review (砚砚 P1)：早期 inferAnnotations 用 prefix 推断把 7 个真正 mutating 工具误标为
 * read-only（workspace_navigate / preview_open / signal_summarize / generate_document /
 * bootcamp_env_check / review_distillation 都会 callbackPost 写后端；library_dry_run 是只读
 * 但被命中 destructive 分支）。这是 cross-cutting metadata 污染，必须改为 **explicit table**：
 *
 * 1. EXPLICIT_TOOL_ANNOTATIONS：每个真实工具显式声明三 hint，权威 + 可审计 + 可测
 * 2. fallback 给未列出的 future tool 默认 write/non-destructive（最安全保守值）
 * 3. 配套测试：`test/server-toolsets-annotations.test.ts` 锁住 cloud-pro-phase0 10 项白名单
 *    + R8 7 项修正工具的 annotation 不被回退
 *
 * 设计判据：
 * - `readOnlyHint: true` 只给**严格不产生任何写动作**的工具（search / graph / list / get / read /
 *   feat_index / check_permission_status / external runtime 只读读取 / audio list/read /
 *   finance_query / signal_search/list/get / limb_list / run_perspective）
 * - `destructiveHint: true` 只给**会破坏既有数据**的工具（shell_exec / delete / revoke / archive /
 *   library_rebuild）。**注意 library_dry_run 不持久化**（描述明示），不算 destructive
 * - `openWorldHint: true` 只给**真正调远端/外部世界**的工具（search_evidence 命中远端 index /
 *   signal_search / 其他真外部 API）
 * - 其他 write 工具（post_message / create / update / ack / preview_open / workspace_navigate /
 *   bootcamp_env_check / generate_document / signal_summarize / review_distillation 等）：
 *   readOnly=false, destructive=false, openWorld=false（写本地 cat-cafe 但不破坏数据）
 *
 * 关联：
 * - LL-mcp-annotations-required-for-chatgpt.md（背景）
 * - F247 §10 KD-13（OpenAI safety check stochastic 不可控）
 * - 砚砚 R8 review HOLD finding P1-1
 */
type Annotation = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
};

const A_READ_LOCAL: Annotation = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const A_READ_OPEN_WORLD: Annotation = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
};
const A_WRITE_SAFE: Annotation = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
};
const A_WRITE_OPEN_WORLD: Annotation = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
};
const A_DESTRUCTIVE: Annotation = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

/**
 * Explicit annotation table for every cat-cafe MCP tool.
 * Authoritative source; loops do not infer.
 * Add new tool → add an entry here. Future tools without entry → fall back to A_WRITE_SAFE
 * (most conservative without scaring ChatGPT into destructive treatment).
 */
export const EXPLICIT_TOOL_ANNOTATIONS: Record<string, Annotation> = {
  // ── Read-only memory + search (local index) ────────────────────────
  cat_cafe_graph_resolve: A_READ_LOCAL,
  cat_cafe_list_recent: A_READ_LOCAL,
  cat_cafe_list_session_chain: A_READ_LOCAL,
  cat_cafe_read_session_digest: A_READ_LOCAL,
  cat_cafe_read_session_events: A_READ_LOCAL,
  cat_cafe_read_invocation_detail: A_READ_LOCAL,
  cat_cafe_read_file_slice: A_READ_LOCAL,
  cat_cafe_list_external_runtime_sessions: A_READ_LOCAL,
  cat_cafe_read_external_runtime_session: A_READ_LOCAL,
  cat_cafe_get_rich_block_rules: A_READ_LOCAL,
  cat_cafe_run_perspective: A_READ_LOCAL,
  // search_evidence hits remote/external knowledge stores → openWorld
  cat_cafe_search_evidence: A_READ_OPEN_WORLD,
  // ── Read-only collab (thread / message / labels / cats) ────────────
  cat_cafe_get_thread_context: A_READ_LOCAL,
  cat_cafe_get_thread_cats: A_READ_LOCAL,
  cat_cafe_get_message: A_READ_LOCAL,
  cat_cafe_get_pending_mentions: A_READ_LOCAL,
  cat_cafe_get_available_guides: A_READ_LOCAL,
  cat_cafe_list_threads: A_READ_LOCAL,
  cat_cafe_list_labels: A_READ_LOCAL,
  cat_cafe_list_tasks: A_READ_LOCAL,
  cat_cafe_list_events: A_READ_LOCAL,
  cat_cafe_list_schedule_templates: A_READ_LOCAL,
  cat_cafe_check_permission_status: A_READ_LOCAL,
  cat_cafe_feat_index: A_READ_LOCAL,
  cat_cafe_bootcamp_env_check: A_WRITE_SAFE, // R8 P1-1: callback-tools.ts:2092-2098 writes thread bootcampState
  // ── Read-only audio / finance / signals / limb ─────────────────────
  cat_cafe_audio_list_sources: A_READ_LOCAL,
  cat_cafe_audio_read_transcript: A_READ_LOCAL,
  cat_cafe_audio_capture_status: A_READ_LOCAL,
  cat_cafe_finance_query: A_READ_OPEN_WORLD, // queries external finance backend
  signal_search: A_READ_OPEN_WORLD,
  signal_list_inbox: A_READ_LOCAL,
  signal_list_studies: A_READ_LOCAL,
  signal_get_article: A_READ_LOCAL,
  limb_list_available: A_READ_LOCAL,
  limb_pair_list: A_READ_LOCAL,
  // ── Library reads (dry_run + verify are read-only despite "library_" prefix) ──
  cat_cafe_library_list: A_READ_LOCAL,
  cat_cafe_library_dry_run: A_READ_LOCAL, // R8 P1-1: described as non-persisting; previously mis-bucketed as destructive
  cat_cafe_library_verify: A_READ_LOCAL,
  // ── Write but non-destructive: messages / tasks / rich blocks ──────
  cat_cafe_post_message: A_WRITE_SAFE,
  cat_cafe_cross_post_message: A_WRITE_SAFE,
  cat_cafe_multi_mention: A_WRITE_SAFE,
  cat_cafe_ack_mentions: A_WRITE_SAFE,
  cat_cafe_create_rich_block: A_WRITE_SAFE,
  cat_cafe_create_task: A_WRITE_SAFE,
  cat_cafe_update_task: A_WRITE_SAFE,
  cat_cafe_hold_ball: A_WRITE_SAFE,
  cat_cafe_backfill_events: A_WRITE_SAFE,
  cat_cafe_community_await_external: A_WRITE_SAFE,
  cat_cafe_propose_thread: A_WRITE_SAFE,
  cat_cafe_propose_session_handoff: A_WRITE_SAFE,
  cat_cafe_propose_profile_update: A_WRITE_SAFE,
  cat_cafe_publish_verdict: A_WRITE_SAFE,
  cat_cafe_register_pr_tracking: A_WRITE_SAFE,
  cat_cafe_register_issue_tracking: A_WRITE_SAFE,
  cat_cafe_register_scheduled_task: A_WRITE_SAFE,
  cat_cafe_remove_scheduled_task: A_DESTRUCTIVE, // R8.2: "stops the task and deletes it permanently" (schedule-tools.ts:217)
  cat_cafe_register_external_runtime_session: A_WRITE_SAFE,
  cat_cafe_unregister_tracking: A_DESTRUCTIVE, // R8.2: stops all automated PR/CI/issue notifications, deletes tracking association
  cat_cafe_request_permission: A_WRITE_SAFE,
  cat_cafe_update_bootcamp_state: A_WRITE_SAFE,
  cat_cafe_update_guide_state: A_WRITE_SAFE,
  cat_cafe_update_workflow: A_WRITE_SAFE,
  cat_cafe_start_guide: A_WRITE_SAFE,
  cat_cafe_guide_control: A_WRITE_SAFE,
  cat_cafe_start_vote: A_WRITE_SAFE,
  cat_cafe_submit_game_action: A_WRITE_SAFE,
  cat_cafe_teleport: A_WRITE_SAFE,
  cat_cafe_mark_generalizable: A_WRITE_SAFE,
  cat_cafe_nominate_for_global: A_WRITE_SAFE,
  cat_cafe_retain_memory_callback: A_WRITE_SAFE,
  cat_cafe_review_distillation: A_WRITE_SAFE, // R8 P1-1: distillation-tools.ts:71-87 writes global knowledge/discard
  cat_cafe_generate_document: A_WRITE_SAFE, // R8 P1-1: callback-tools.ts:1974 saves file + may post IM
  cat_cafe_preview_open: A_WRITE_SAFE, // R8 P1-1: hub-action-tools.ts:50-91 callbackPost changes Hub preview
  cat_cafe_preview_scheduled_task: A_WRITE_SAFE,
  cat_cafe_workspace_navigate: A_WRITE_SAFE, // R8 P1-1: hub-action-tools.ts:50-91 callbackPost changes Hub workspace
  // ── Audio control (writes capture state) ───────────────────────────
  cat_cafe_audio_capture_start: A_WRITE_SAFE,
  cat_cafe_audio_capture_stop: A_WRITE_SAFE,
  cat_cafe_audio_enroll_speakers: A_WRITE_SAFE,
  cat_cafe_audio_set_advisory_mode: A_WRITE_SAFE,
  cat_cafe_audio_set_talking_points: A_WRITE_SAFE,
  // ── Signals (write) ────────────────────────────────────────────────
  signal_save_notes: A_WRITE_SAFE,
  signal_mark_read: A_WRITE_SAFE,
  signal_update_article: A_WRITE_SAFE,
  signal_summarize: A_WRITE_SAFE, // R8 P1-1: signals-tools.ts:269-275 persists summary to frontmatter
  signal_start_study: A_WRITE_SAFE,
  // R8.2: action=unlink branch DELETEs article-thread association (signal-study-tools.ts:55).
  // Tool annotations must reflect the maximum-risk path of a multi-mode tool.
  signal_link_thread: A_DESTRUCTIVE,
  signal_generate_podcast: A_WRITE_OPEN_WORLD, // calls external TTS
  // ── Limb actions (write) ───────────────────────────────────────────
  limb_invoke: A_WRITE_SAFE,
  limb_pair_approve: A_WRITE_SAFE,
  // ── Destructive (data loss / unrecoverable) ────────────────────────
  cat_cafe_shell_exec: A_DESTRUCTIVE,
  cat_cafe_library_archive: A_DESTRUCTIVE,
  cat_cafe_library_rebuild: A_DESTRUCTIVE,
  cat_cafe_library_create: A_WRITE_SAFE, // creating a new library is non-destructive
  signal_delete_article: A_DESTRUCTIVE,
};

function inferAnnotations(toolName: string): Annotation {
  const explicit = EXPLICIT_TOOL_ANNOTATIONS[toolName];
  if (explicit) return explicit;
  // Fallback for unmapped tools: most conservative write/non-destructive,
  // never silently mark unknown as read-only (砚砚 R8 finding).
  return A_WRITE_SAFE;
}

type RegisteredToolHandler = (args: never) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}>;

/**
 * Type-erased view of `McpServer.tool`'s 5-arg overload.
 * SDK 1.26.0 strict generics (ZodRawShapeCompat) collide with our generic
 * `Record<string, unknown>` ToolDef.inputSchema; we cast the call site once
 * and keep runtime behaviour identical (SDK reads inputSchema at handler time).
 */
type TypeErasedToolRegistration = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
  },
  cb: RegisteredToolHandler,
) => void;

function registerTools(server: McpServer, tools: readonly ToolDef[]): void {
  // 5-arg overload: server.tool(name, description, paramsSchema, annotations, cb)
  // — MCP SDK 1.26.0 内部 generics 太严，我们 ToolDef.inputSchema 是 Record<string,unknown>
  // 不匹配 ZodRawShapeCompat → 用 type-erased view 让 TS 通过，runtime 行为不变。
  // annotations 会通过 list_tools 暴露给 ChatGPT / Claude 客户端。
  const registerToolErased = server.tool.bind(server) as unknown as TypeErasedToolRegistration;
  for (const tool of tools) {
    const annotations = inferAnnotations(tool.name);
    registerToolErased(tool.name, tool.description, tool.inputSchema, annotations, async (args: never) => {
      const result = await tool.handler(args);
      return {
        ...(result as Record<string, unknown>),
      } as {
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
        [key: string]: unknown;
      };
    });
  }
}

export function registerCollabToolset(server: McpServer): void {
  registerTools(server, buildCollabTools());
}

export function registerMemoryToolset(server: McpServer): void {
  registerTools(server, buildMemoryTools());
}

export function registerSignalToolset(server: McpServer): void {
  registerTools(server, buildSignalTools());
}

// F061: limbTools 默认不走 readonly filter（Antigravity 设计要求 — 让 antigravity
// readonly + agent-key 仍能调 limb 控制 antigravity 自己的浏览器）。
//
// 但 F178 Phase D V3（cloud codex review 2026-06-13 P1）：DESKTOP_MODE=fable-phase0
// 是 strict-whitelist 模式 + 最高优先级，在 legacy createServer + registerFullToolset
// 路径下（fable Desktop config 误指 dist/index.js）必须杜绝 limb_invoke /
// limb_pair_approve 等设备控制面暴露。defense-in-depth：DESKTOP_FABLE_PHASE0_ALLOWED_TOOLS
// 不含任何 limb 工具，所以 fable-phase0 mode 下 limb 全 deny。
const LIMB_TOOL_SOURCES: readonly ToolDef[] = [...limbTools];

export function buildLimbTools(env?: ToolsetEnv): readonly ToolDef[] {
  const e = env ?? parseToolsetEnv();
  // F178 Phase D cloud-review round 3 P2: any non-empty desktopMode (even
  // a mistyped one) must go through applyReadonlyFilter so unknown modes
  // throw fail-fast on server startup instead of silently registering the
  // full limb surface in standalone limb.ts entry. Antigravity / default
  // (no desktopMode set) keeps the F061 contract: limb fully exposed,
  // not filtered by readonly.
  if (e.desktopMode) {
    return applyReadonlyFilter(LIMB_TOOL_SOURCES, e);
  }
  return LIMB_TOOL_SOURCES;
}

export function registerLimbToolset(server: McpServer): void {
  registerTools(server, buildLimbTools());
}

export function registerAudioToolset(server: McpServer): void {
  registerTools(server, buildAudioTools());
}

export function registerFinanceToolset(server: McpServer): void {
  registerTools(server, buildFinanceTools());
}

export function registerFullToolset(server: McpServer): void {
  registerCollabToolset(server);
  registerMemoryToolset(server);
  registerSignalToolset(server);
  registerLimbToolset(server);
  registerAudioToolset(server);
  registerFinanceToolset(server);
}
