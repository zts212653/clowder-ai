import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  audioTools,
  callbackMemoryTools,
  callbackTools,
  distillationTools,
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
  'cat_cafe_get_thread_context',
  // #699: Message lookup by ID
  'cat_cafe_get_message',
  'cat_cafe_list_threads',
  'cat_cafe_register_external_runtime_session',
  // F223: first-party Hub UX actions are callback-authenticated writes that
  // persistent agent-key MCP clients need when invocation credentials are absent.
  'cat_cafe_workspace_navigate',
  'cat_cafe_preview_open',
]);

const isReadonly = process.env['CAT_CAFE_READONLY'] === 'true';
const hasAgentKey = !!(
  process.env['CAT_CAFE_AGENT_KEY_SECRET'] ||
  process.env['CAT_CAFE_AGENT_KEY_FILE'] ||
  process.env['CAT_CAFE_AGENT_KEY_FILES']
);

function applyReadonlyFilter(tools: readonly ToolDef[]): readonly ToolDef[] {
  if (!isReadonly) return tools;
  return tools.filter((t) => READONLY_ALLOWED_TOOLS.has(t.name) || (hasAgentKey && AGENT_KEY_TOOLS.has(t.name)));
}

const collabTools: readonly ToolDef[] = applyReadonlyFilter([
  ...callbackTools,
  ...externalRuntimeSessionCallbackTools,
  ...hubActionTools,
  ...richBlockRulesTools,
  ...gameActionTools,
  ...scheduleTools,
  ...shellTools,
]);

const memoryTools: readonly ToolDef[] = applyReadonlyFilter([
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
]);

const signalTools: readonly ToolDef[] = applyReadonlyFilter([...signalsTools, ...signalStudyTools]);
const financeNodeTools: readonly ToolDef[] = applyReadonlyFilter([...financeTools]);

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
  registerTools(server, collabTools);
}

export function registerMemoryToolset(server: McpServer): void {
  registerTools(server, memoryTools);
}

export function registerSignalToolset(server: McpServer): void {
  registerTools(server, signalTools);
}

const limbNodeTools: readonly ToolDef[] = [...limbTools];

export function registerLimbToolset(server: McpServer): void {
  registerTools(server, limbNodeTools);
}

const audioNodeTools: readonly ToolDef[] = applyReadonlyFilter([...audioTools]);

export function registerAudioToolset(server: McpServer): void {
  registerTools(server, audioNodeTools);
}

export function registerFinanceToolset(server: McpServer): void {
  registerTools(server, financeNodeTools);
}

export function registerFullToolset(server: McpServer): void {
  registerCollabToolset(server);
  registerMemoryToolset(server);
  registerSignalToolset(server);
  registerLimbToolset(server);
  registerAudioToolset(server);
  registerFinanceToolset(server);
}
