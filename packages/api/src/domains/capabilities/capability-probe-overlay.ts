/**
 * Optional live MCP probe overlay (`GET /api/capabilities?probe=1`).
 *
 * The probe spawns MCP servers, so it is an owner resolver the Console may pass
 * in, never something the read service does on its own (LL-055 spawn-free
 * reads). Its results are a live observation layered on the board, not part of
 * the source revision.
 */

import type { CapabilityBoardItem, CapabilityEntry, McpToolInfo } from '@cat-cafe/shared';

type McpConnectionStatus = NonNullable<CapabilityBoardItem['connectionStatus']>;

import { describeMcpCapability } from './capability-board-parts.js';

export type McpProbeResolver = (
  cap: CapabilityEntry,
) => Promise<{ connectionStatus: McpConnectionStatus; tools?: McpToolInfo[] }>;

const MAX_CONCURRENT_MCP_PROBES = 4;

export async function applyMcpProbe(
  items: CapabilityBoardItem[],
  capabilities: readonly CapabilityEntry[],
  probe: McpProbeResolver,
): Promise<void> {
  const mcpCaps = capabilities.filter((cap) => cap.type === 'mcp');
  const mcpItemById = new Map(items.filter((item) => item.type === 'mcp').map((item) => [item.id, item] as const));
  const probeOne = async (cap: CapabilityEntry) => {
    const boardItem = mcpItemById.get(cap.id);
    const anyCatEnabled = boardItem ? Object.values(boardItem.cats).some(Boolean) : (cap.globalEnabled ?? true);
    if (!anyCatEnabled) return [cap.id, { connectionStatus: 'unknown' as const }] as const;
    return [cap.id, await probe(cap)] as const;
  };
  const probeEntries: Array<Awaited<ReturnType<typeof probeOne>>> = [];
  for (let i = 0; i < mcpCaps.length; i += MAX_CONCURRENT_MCP_PROBES) {
    const chunk = mcpCaps.slice(i, i + MAX_CONCURRENT_MCP_PROBES);
    probeEntries.push(...(await Promise.all(chunk.map(probeOne))));
  }
  const probeMap = new Map<string, { connectionStatus: McpConnectionStatus; tools?: McpToolInfo[] }>(probeEntries);
  for (const item of items) {
    if (item.type !== 'mcp') continue;
    const result = probeMap.get(item.id);
    if (!result) continue;
    item.connectionStatus = result.connectionStatus;
    if (result.tools) item.tools = result.tools;
    const cap = mcpCaps.find((entry) => entry.id === item.id);
    if (cap) {
      const dynamicDesc = describeMcpCapability(cap, result.tools);
      if (dynamicDesc) item.description = dynamicDesc;
    }
  }
}
