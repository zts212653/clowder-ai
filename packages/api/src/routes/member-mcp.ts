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
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { getAcpConfig } from '../config/cat-config-loader.js';
import { readRuntimeCatCatalog } from '../config/runtime-cat-catalog.js';
import type { InvocationRecord, VerifyResult } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { toolExecutionPolicyAllowedToolNames } from '../domains/cats/services/agents/invocation/tool-execution-policy.js';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';

export const MEMBER_MCP_ROUTE_PATH = '/api/member-mcp/mcp';

/** Split builtin server name → gateway tool family. */
const NAME_TO_FAMILY: Record<string, MemberToolFamily> = {
  'cat-cafe-collab': 'collab',
  'cat-cafe-memory': 'memory',
  'cat-cafe-signals': 'signals',
  'cat-cafe-limb': 'limb',
  'cat-cafe-audio': 'audio',
  'cat-cafe-finance': 'finance',
};

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
  resolveMemberToolFamilies(input: { catId: string }): Promise<readonly MemberToolFamily[]>;
  /** API base URL the tool handlers must callback to (loopback, this process). */
  apiBaseUrl: string;
  log: Pick<FastifyBaseLogger, 'warn'>;
}

export function registerMemberMcpRoutes(app: FastifyInstance, deps: MemberMcpRouteDeps): void {
  const gateway = createMemberGatewayHandler({
    verify: async ({ invocationId, callbackToken }) => {
      const result = await deps.registry.verify(invocationId, callbackToken);
      if (!result.ok) return { ok: false, reason: result.reason };
      const record = result.record;
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
        },
      };
    },
    resolveFamilies: deps.resolveMemberToolFamilies,
    log: deps.log,
  });

  app.post(MEMBER_MCP_ROUTE_PATH, async (request, reply) => {
    // The MCP transport owns the raw response (streamable HTTP framing).
    reply.hijack();
    await gateway(request.raw, reply.raw, request.body);
  });

  app.get(MEMBER_MCP_ROUTE_PATH, async (_request, reply) => {
    // Stateless gateway: no server-initiated SSE stream is offered.
    return reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' });
  });
}

function findVariantByCatId(projectRoot: string, catId: string): { mcpSupport?: boolean } | undefined {
  const catalog = readRuntimeCatCatalog(projectRoot) as unknown as {
    breeds?: Array<{
      catId?: string;
      variants?: Array<{ catId?: string; mcpSupport?: boolean }>;
    }>;
  };
  for (const breed of catalog.breeds ?? []) {
    for (const variant of breed.variants ?? []) {
      const variantCatId = variant.catId ?? breed.catId;
      if (variantCatId === catId) return variant;
    }
  }
  return undefined;
}

/**
 * Resolve which tool families an ACP member may call through the gateway.
 * Fail-closed: unknown members, mcpSupport off, empty whitelist, or members
 * whose cat-cafe servers are disabled in capabilities.json get no tools.
 */
export async function resolveMemberToolFamiliesForCat(
  projectRoot: string,
  catId: string,
): Promise<readonly MemberToolFamily[]> {
  const variant = findVariantByCatId(projectRoot, catId);
  if (!variant || variant.mcpSupport !== true) return [];

  const acpConfig = getAcpConfig(catId, projectRoot);
  const whitelist = acpConfig?.mcpWhitelist ?? [];
  if (whitelist.length === 0) return [];

  let capabilitiesConfig = null;
  try {
    capabilitiesConfig = await readCapabilitiesConfig(projectRoot);
  } catch {
    /* best-effort — resolveAcpMcpServers handles null config */
  }
  const disabledServerIds = resolveDisabledServerIds(projectRoot, catId, capabilitiesConfig);
  const servers = await resolveAcpMcpServers(projectRoot, whitelist, undefined, {
    mcpSupport: true,
    disabledServerIds,
    catId,
    capabilitiesConfig,
    configSourceRoot: projectRoot,
  });

  const families = new Set<MemberToolFamily>();
  for (const server of servers) {
    const family = NAME_TO_FAMILY[server.name];
    if (family) families.add(family);
  }
  return [...families];
}
