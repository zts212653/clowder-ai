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
  text?: { ref: string; content: string };
  onAccepted?: (requestId: string | number | undefined) => void;
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
      const { mcpServers, prompt, text, ...coordinates } = request.params;
      const accepted = [...pending].find((approval) => {
        if (approval.method !== request.method || !isDeepStrictEqual(approval.params, coordinates)) return false;
        if (approval.prompt && !isDeepStrictEqual(prompt, [{ type: 'text', text: approval.prompt.ref }])) return false;
        if (approval.text ? text !== approval.text.ref : text !== undefined) return false;
        return (
          (approval.mcp !== undefined) === (mcpServers !== undefined) &&
          (approval.prompt !== undefined) === (prompt !== undefined)
        );
      });
      if (!accepted) throw new Error('acp_worker_write_unapproved');
      let servers: AcpMcpServer[] | undefined;
      if (accepted.mcp) {
        const references = mcpRefsSchema.parse(mcpServers).map(({ name }) => name);
        const selected = new Set(references);
        const approved = [...accepted.mcp].filter(([name]) => selected.has(name));
        if (
          !isDeepStrictEqual(
            approved.map(([name]) => name),
            references,
          )
        ) {
          throw new Error('acp_worker_write_unapproved');
        }
        servers = approved.map(([, server]) => server);
      }
      pending.delete(accepted);
      accepted.onAccepted?.(request.id);
      await write(
        JSON.stringify({
          ...request,
          params: {
            ...accepted.params,
            ...(servers ? { mcpServers: servers } : {}),
            ...(accepted.prompt ? { prompt: accepted.prompt.content } : {}),
            ...(accepted.text ? { text: accepted.text.content } : {}),
          },
        }) + '\n',
      );
    },
  };
}
