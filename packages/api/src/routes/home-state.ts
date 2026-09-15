/**
 * F300 Home-State Routes — the cat's own coordinates, same source as the UI.
 *
 * GET /api/home-state/self — where am I running, what am I running inside of,
 * and what do I currently hold. Refs only, built per request, never stored.
 *
 * Identity comes from the authenticated caller, never from the query string. An
 * earlier draft read `?catId=` and answered, which meant any caller could ask
 * for any cat's coordinates and, worse, that the answer was shaped by whatever
 * the caller claimed to be -- a self-knowledge tool whose "self" is an argument
 * is not self-knowledge.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HomeStateSelfFacet } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveRuntimeDeploymentRevision } from '../config/runtime-deployment-revision.js';
import { buildSelfFacet } from '../domains/home-state/self-facet.js';
import { selfFacetSourcesFromRuntime } from '../domains/home-state/self-facet-sources.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
} from './callback-auth-prehandler.js';

const execFileAsync = promisify(execFile);

export interface HomeStateRoutesOptions {
  readonly apiPort?: number;
  /**
   * The deployment revision this process captured when it started -- the same
   * value `/health` closes over -- so the two can never disagree about which
   * build is running. `null` means there was no valid stamp at startup, and that
   * stays true for the life of the process: building newer files on disk later
   * does not make them the running revision. When omitted, the value is captured
   * once, as the plugin registers, and never re-read per request.
   */
  readonly runningRevision?: string | null;
  /**
   * Registered in this plugin's scope: Fastify encapsulation means a sibling
   * plugin's auth hook does not reach these routes, so without it every MCP
   * caller would arrive with no principal at all.
   */
  readonly callbackRegistry?: CallbackAuthRegistry;
  readonly agentKeyRegistry?: AgentKeyAuthRegistry;
}

type Principal = { kind: string; catId?: string; threadId?: string; invocationId?: string };
type AuthenticatedRequest = FastifyRequest & { sessionUserId?: string; callbackPrincipal?: Principal };

async function readGitHead(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() });
    return stdout.trim();
  } catch {
    // A packaged install has no checkout. That is a real deployment shape, not
    // an error: the rest of the facet still grounds the cat (spec section 5.4.6).
    return '';
  }
}

/**
 * Who is asking.
 *
 * A callback principal is authoritative and wins outright. A local session is
 * the Console reading its own machine, which may name the cat it wants to look
 * at; that is bounded by the loopback check, and remote callers without a
 * principal get nothing at all.
 */
function resolveCaller(
  request: AuthenticatedRequest,
  reply: FastifyReply,
): { catId: string; threadId?: string; invocationId?: string } | undefined {
  const principal = request.callbackPrincipal;
  if (principal?.catId) {
    return {
      catId: principal.catId,
      ...(principal.threadId ? { threadId: principal.threadId } : {}),
      ...(principal.invocationId ? { invocationId: principal.invocationId } : {}),
    };
  }

  // A caller on this machine is already inside the trust boundary that owns the
  // deployment being described -- it can read the same pids and ports from `ps`.
  // It may name the cat it wants to look at; a remote caller may not exist here
  // at all, with or without a claimed identity.
  if (isDirectLoopbackRequest(request)) {
    const query = request.query as { catId?: string };
    return { catId: query.catId ?? 'console' };
  }

  reply
    .code(401)
    .send({ error: 'unauthorized', message: 'Home state requires an invocation credential or a local caller.' });
  return undefined;
}

export const homeStateRoutes: FastifyPluginAsync<HomeStateRoutesOptions> = async (app, options) => {
  if (options.callbackRegistry) {
    registerCallbackAuthHook(app, options.callbackRegistry, {
      ...(options.agentKeyRegistry ? { agentKeyRegistry: options.agentKeyRegistry } : {}),
    });
  }

  // Captured once. A per-request read of the build stamp would report whatever
  // was built on disk since, under the label of the process still serving.
  const running =
    options.runningRevision !== undefined
      ? (options.runningRevision ?? undefined)
      : (resolveRuntimeDeploymentRevision(process.env['CAT_CAFE_RUNTIME_ROOT']) ?? undefined);

  app.get('/api/home-state/self', async (request, reply): Promise<HomeStateSelfFacet | undefined> => {
    const caller = resolveCaller(request as AuthenticatedRequest, reply);
    if (!caller) return undefined;

    return buildSelfFacet(
      selfFacetSourcesFromRuntime({
        env: process.env,
        ...(options.apiPort ? { apiPort: options.apiPort } : {}),
        invocation: caller,
        runningRevision: () => running,
        gitHead: readGitHead,
      }),
    );
  });
};
