import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  callbackMemoryTools,
  callbackTools,
  evidenceTools,
  gameActionTools,
  limbTools,
  reflectTools,
  richBlockRulesTools,
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

const collabTools: readonly ToolDef[] = [...callbackTools, ...richBlockRulesTools, ...gameActionTools];

const memoryTools: readonly ToolDef[] = [
  ...callbackMemoryTools,
  ...evidenceTools,
  ...reflectTools,
  ...sessionChainTools,
];

const signalTools: readonly ToolDef[] = [...signalsTools, ...signalStudyTools];

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
