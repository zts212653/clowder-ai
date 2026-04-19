import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  callbackMemoryTools,
  callbackTools,
  distillationTools,
  evidenceTools,
  gameActionTools,
  limbTools,
  reflectTools,
  richBlockRulesTools,
  scheduleTools,
  sessionChainTools,
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
  'cat_cafe_search_evidence',
  'cat_cafe_reflect',
  'cat_cafe_get_rich_block_rules',
  // Session chain (read-only API calls, no callback creds needed)
  'cat_cafe_list_session_chain',
  'cat_cafe_read_session_events',
  'cat_cafe_read_session_digest',
  'cat_cafe_read_invocation_detail',
  // Signals (read-only)
  'signal_list_inbox',
  'signal_get_article',
  'signal_search',
  'signal_list_studies',
]);

const isReadonly = process.env['CAT_CAFE_READONLY'] === 'true';

function applyReadonlyFilter(tools: readonly ToolDef[]): readonly ToolDef[] {
  return isReadonly ? tools.filter((t) => READONLY_ALLOWED_TOOLS.has(t.name)) : tools;
}

const collabTools: readonly ToolDef[] = applyReadonlyFilter([
  ...callbackTools,
  ...richBlockRulesTools,
  ...gameActionTools,
  ...scheduleTools,
]);

const memoryTools: readonly ToolDef[] = applyReadonlyFilter([
  ...callbackMemoryTools,
  ...distillationTools,
  ...evidenceTools,
  ...reflectTools,
  ...sessionChainTools,
]);

const signalTools: readonly ToolDef[] = applyReadonlyFilter([...signalsTools, ...signalStudyTools]);

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

export function registerFullToolset(server: McpServer): void {
  registerCollabToolset(server);
  registerMemoryToolset(server);
  registerSignalToolset(server);
  registerLimbToolset(server);
}
