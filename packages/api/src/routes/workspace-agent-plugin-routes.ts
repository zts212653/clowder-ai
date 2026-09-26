/**
 * F247 Workspace Agent (slice 3): owner-only Settings routes.
 *
 * Covers the Settings card contract (#7): trigger id, authorize/re-auth,
 * disable, and one real test trigger. The access token is write-only —
 * responses expose a `tokenConfigured` presence bit and never the value
 * (redaction is structural: routes only return config-store projections).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  buildWorkspaceAgentConversationKey,
  isWorkspaceAgentConversationKeySegment,
} from '../domains/cats/services/cloud-bridge/workspace-agent/conversation-key.js';
import type { WorkspaceAgentConfigStore } from '../domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-config.js';
import type { IWorkspaceAgentTriggerAdapter } from '../domains/cats/services/cloud-bridge/workspace-agent/workspace-agent-trigger-adapter.js';
import { pluginAccessError, requirePluginOwnerLocalAccess, requirePluginWriteAccess } from './plugin-access-guards.js';

export interface WorkspaceAgentPluginRouteOptions {
  readonly config: WorkspaceAgentConfigStore;
  /** Refreshable adapter — one real bounded trigger for the Settings test action. */
  readonly adapter: IWorkspaceAgentTriggerAdapter;
  readonly logger?: { warn(ctx: object, msg: string): void };
}

const TRIGGER_ID_PATTERN = /^[A-Za-z0-9_:-]{1,200}$/;
const TEST_CONVERSATION_SUFFIX = 'settings-selftest';

interface ConfigBody {
  triggerId?: unknown;
  workspaceId?: unknown;
  token?: unknown;
  enabled?: unknown;
}

function optionalPattern(value: unknown, pattern: RegExp, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

/** astra R3: workspace ids share the conversation-key segment constraint. */
function optionalWorkspaceId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isWorkspaceAgentConversationKeySegment(value)) {
    throw new Error('workspaceId is invalid (must be a conversation-key safe segment)');
  }
  return value;
}

function optionalToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new Error('token is invalid');
  }
  return value;
}

function optionalEnabled(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error('enabled must be a boolean');
  return value;
}

export function registerWorkspaceAgentPluginRoutes(
  app: FastifyInstance,
  options: WorkspaceAgentPluginRouteOptions,
): void {
  app.get('/api/plugins/workspace-agent', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return pluginAccessError(reply, access);
    return options.config.project();
  });

  app.put('/api/plugins/workspace-agent/config', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const body = (request.body ?? {}) as ConfigBody;
    try {
      return options.config.save({
        triggerId: optionalPattern(body.triggerId, TRIGGER_ID_PATTERN, 'triggerId'),
        workspaceId: optionalWorkspaceId(body.workspaceId),
        token: optionalToken(body.token),
        enabled: optionalEnabled(body.enabled),
      });
    } catch (error) {
      reply.status(400);
      return { error: 'Workspace Agent config is invalid', code: 'INVALID_CONFIG', detail: (error as Error).message };
    }
  });

  app.delete('/api/plugins/workspace-agent', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    return options.config.disable();
  });

  // Note: callers POST an empty JSON object `{}` — this Fastify version
  // rejects a content-type body of zero length before the handler runs.
  app.post('/api/plugins/workspace-agent/test', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const active = options.config.resolve();
    if (!active) {
      reply.status(409);
      return {
        ok: false,
        code: 'WORKSPACE_AGENT_NOT_CONFIGURED',
        message: 'Authorize the Workspace Agent before testing',
      };
    }
    const nonce = `f247-selftest-${Date.now().toString(36)}`;
    try {
      const receipt = await options.adapter.trigger({
        input: `Clowder AI settings self-test ${nonce} — internal verification only, no reply needed.`,
        conversationKey: buildWorkspaceAgentConversationKey({
          workspaceId: active.workspaceId,
          threadId: TEST_CONVERSATION_SUFFIX,
        }),
        idempotencyKey: nonce,
      });
      return {
        ok: true,
        conversationUrl: receipt.conversationUrl,
        ...(receipt.providerRunId ? { providerRunId: receipt.providerRunId } : {}),
      };
    } catch (error) {
      options.logger?.warn({ code: (error as { code?: string }).code }, 'F247 workspace-agent settings test failed');
      reply.status(502);
      return {
        ok: false,
        code: (error as { code?: string }).code ?? 'WORKSPACE_AGENT_FAILED',
        message: (error as Error).message,
      };
    }
  });
}
