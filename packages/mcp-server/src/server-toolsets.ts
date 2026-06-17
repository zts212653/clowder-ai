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

const KNOWN_DESKTOP_MODES = new Set(['fable-phase0']);

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

function registerTools(server: McpServer, tools: readonly ToolDef[]): void {
  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      const result = await tool.handler(args as never);
      return {
        ...(result as Record<string, unknown>),
      } as { content: Array<{ type: 'text'; text: string }>; isError?: boolean; [key: string]: unknown };
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
