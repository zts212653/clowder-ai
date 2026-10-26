/**
 * Member MCP gateway route — /api/member-mcp/mcp (F306 Phase B).
 *
 * Hosts the member gateway inside the API process so ACP members (iCode) can
 * reach the canonical cat-cafe tools over Streamable HTTP — iCode rejects
 * client-injected stdio MCP servers. Requests authenticate against the live
 * F298 invocation registry, so credentials die with their invocation and every
 * turn carries fresh ones. Identity comes from the verified record, never the
 * request body; the tool surface comes from the member's own config plus
 * capability gating.
 */

import {
  createMemberGatewayHandler,
  type MemberToolFamily,
  type ToolsetEnv,
} from '@cat-cafe/mcp-server/dist/member-gateway.js';
import type { SharedInvocationContext } from '@cat-cafe/mcp-server/dist/shared-invocation-context.js';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

export { resolveConfiguredMemberMcpFamilies as resolveMemberToolFamiliesForCat } from '../config/capabilities/member-mcp-families.js';

import type { InvocationRecord, VerifyResult } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { toolExecutionPolicyAllowedToolNames } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';

export const MEMBER_MCP_ROUTE_PATH = '/api/member-mcp/mcp';

/**
 * Project the invocation's durable tool policy onto the toolset filter.
 * The API process env is not member policy: a host-level READONLY/profile or
 * inherited agent-key material must not change a member's surface. Desktop and
 * agent-key surfaces are not carriers of the member gateway, so they stay off.
 * `allowedToolNames` carries the exact canonical policy: read_only denies every
 * tool, and callback_allowlist / plugin_native cannot be represented here and
 * fail closed.
 */
function toolsetEnvFromInvocation(record: InvocationRecord): ToolsetEnv {
  return {
    hasAgentKey: false,
    agentKeyUnion: false,
    allowedToolNames: toolExecutionPolicyAllowedToolNames(record.toolExecutionPolicy),
  };
}

export interface MemberMcpRouteDeps {
  registry: { verify(invocationId: string, callbackToken: string): Promise<VerifyResult> };
  resolveMemberToolFamilies(input: {
    catId: string;
    sharedContext?: SharedInvocationContext;
  }): Promise<readonly MemberToolFamily[]>;
  /** API base URL the tool handlers must callback to (loopback, this process). */
  apiBaseUrl: string;
  log: Pick<FastifyBaseLogger, 'warn'>;
  deploymentId?: string;
}

export function registerMemberMcpRoutes(app: FastifyInstance, deps: MemberMcpRouteDeps): void {
  const gateway = createMemberGatewayHandler({
    verify: async ({ invocationId, callbackToken }) => {
      const result = await deps.registry.verify(invocationId, callbackToken);
      if (!result.ok) return { ok: false, reason: result.reason };
      const record = result.record;
      if (record.sharedMcpContext && deps.deploymentId && record.sharedMcpContext.deploymentId !== deps.deploymentId)
        return { ok: false, reason: 'deployment_mismatch' };
      return {
        ok: true,
        context: {
          invocationId,
          callbackToken,
          catId: record.catId,
          threadId: record.threadId,
          userId: record.userId,
          apiBaseUrl: deps.apiBaseUrl,
          toolsetEnv: toolsetEnvFromInvocation(record),
          ...(record.sharedMcpContext ? { sharedContext: record.sharedMcpContext } : {}),
        },
      };
    },
    resolveFamilies: deps.resolveMemberToolFamilies,
    log: deps.log,
  });

  app.post(MEMBER_MCP_ROUTE_PATH, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    // The MCP transport owns the raw response (streamable HTTP framing).
    reply.hijack();
    await gateway(request.raw, reply.raw, request.body);
  });

  app.get(MEMBER_MCP_ROUTE_PATH, async (_request, reply) => {
    // Stateless gateway: no server-initiated SSE stream is offered.
    return reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' });
  });
}
