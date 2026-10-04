/**
 * F300 Task 2.1 — capability snapshot for cats, same source as the Console.
 *
 * GET /api/capabilities/snapshot[?projectPath=] — the F041 capability board
 * read through the pure read service and nothing else. Unlike
 * `GET /api/capabilities` this never bootstraps, syncs, or writes: a project
 * without a capability config is answered `absent`, not given one.
 *
 * Identity comes from the authenticated caller (the MCP tool's invocation
 * credentials), never from the query. A cat is shown its own per-cat state
 * (member scope); a local Console caller may name the cat it wants to look at.
 */

import type { CapabilityReadScope, CapabilitySnapshotResponse } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfigState } from '../config/capabilities/capability-orchestrator.js';
import { findMonorepoRoot } from '../domains/capabilities/capability-board-parts.js';
import { readCapabilitySnapshot } from '../domains/capabilities/capability-read-service.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { redirectRuntimeProjectPath, resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
} from './callback-auth-prehandler.js';

export interface CapabilitySnapshotRoutesOptions {
  /**
   * Registered in this plugin's scope: Fastify encapsulation means a sibling
   * plugin's auth hook does not reach these routes.
   */
  readonly callbackRegistry?: CallbackAuthRegistry;
  readonly agentKeyRegistry?: AgentKeyAuthRegistry;
  /** Test seam; defaults to the persistent home root, as `GET /api/capabilities` uses. */
  readonly mainRoot?: string;
}

type AuthenticatedRequest = FastifyRequest & { callbackPrincipal?: { catId?: string } };

/**
 * A callback principal is authoritative and wins outright. A caller on this
 * machine is inside the trust boundary that owns the config being described and
 * may name a cat or read the Console view; a remote caller without a principal
 * gets nothing.
 */
function resolveScope(request: AuthenticatedRequest, reply: FastifyReply): CapabilityReadScope | undefined {
  const catId = request.callbackPrincipal?.catId;
  if (catId) return { kind: 'member', catId };
  if (isDirectLoopbackRequest(request)) {
    const named = (request.query as { catId?: string }).catId;
    return named ? { kind: 'member', catId: named } : { kind: 'console' };
  }
  reply.code(401).send({
    error: 'unauthorized',
    message: 'Capability snapshot requires an invocation credential or a local caller.',
  });
  return undefined;
}

export const capabilitySnapshotRoutes: FastifyPluginAsync<CapabilitySnapshotRoutesOptions> = async (app, options) => {
  if (options.callbackRegistry) {
    registerCallbackAuthHook(app, options.callbackRegistry, {
      ...(options.agentKeyRegistry ? { agentKeyRegistry: options.agentKeyRegistry } : {}),
    });
  }
  const mainRoot = options.mainRoot ?? (await redirectRuntimeProjectPath(findMonorepoRoot()));
  if (!mainRoot) throw new Error('Unable to resolve persistent global capabilities root');

  app.get(
    '/api/capabilities/snapshot',
    async (request, reply): Promise<CapabilitySnapshotResponse | { error: string } | undefined> => {
      const scope = resolveScope(request as AuthenticatedRequest, reply);
      if (!scope) return undefined;

      const query = request.query as { projectPath?: string };
      let projectRoot = mainRoot;
      if (query.projectPath) {
        const validated = await resolvePersistentProjectPath(query.projectPath);
        if (!validated) {
          reply.status(400);
          return { error: 'Invalid project path: must be an existing directory under allowed roots' };
        }
        projectRoot = validated;
      }

      return readCapabilitySnapshot({
        projectRoot,
        mainRoot,
        isProjectView: !!query.projectPath,
        config: await readCapabilitiesConfigState(projectRoot),
        scope,
      });
    },
  );
};
