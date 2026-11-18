import { isDeepStrictEqual } from 'node:util';
import type { AcpContentBlock, AcpMcpServer } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';

const requestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()),
});
const mcpRefsSchema = z.array(z.object({ name: z.string() }));

export interface AcpWriteApproval {
  method: string;
  /** Coordinates the worker is authorized to send. Secret-bearing fields travel separately. */
  params: Readonly<Record<string, unknown>>;
  mcp?: ReadonlyMap<string, AcpMcpServer>;
  prompt?: { ref: string; content: readonly AcpContentBlock[] };
}

/** Resolve the actual provider arguments once, at the Host-owned stdin boundary. */
export function createAcpWriteApprovalPort(write: (line: string) => Promise<void>) {
  const pending = new Set<AcpWriteApproval>();
  return {
    approve(approval: AcpWriteApproval) {
      pending.add(approval);
      return () => {
        pending.delete(approval);
      };
    },
    async writeApprovedLine(line: string) {
      const request = requestSchema.parse(JSON.parse(line));
      const { mcpServers, prompt, ...coordinates } = request.params;
      const accepted = [...pending].find((approval) => {
        if (approval.method !== request.method || !isDeepStrictEqual(approval.params, coordinates)) return false;
        if (approval.prompt && !isDeepStrictEqual(prompt, [{ type: 'text', text: approval.prompt.ref }])) return false;
        return (
          (approval.mcp !== undefined) === (mcpServers !== undefined) &&
          (approval.prompt !== undefined) === (prompt !== undefined)
        );
      });
      if (!accepted) throw new Error('acp_worker_write_unapproved');
      const servers = accepted.mcp && mcpRefsSchema.parse(mcpServers).map(({ name }) => accepted.mcp?.get(name));
      if (servers?.some((server) => !server)) throw new Error('acp_worker_write_unapproved');
      pending.delete(accepted);
      await write(
        JSON.stringify({
          ...request,
          params: {
            ...accepted.params,
            ...(servers ? { mcpServers: servers } : {}),
            ...(accepted.prompt ? { prompt: accepted.prompt.content } : {}),
          },
        }) + '\n',
      );
    },
  };
}
