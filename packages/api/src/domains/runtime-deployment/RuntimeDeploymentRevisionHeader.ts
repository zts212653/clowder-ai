import { DEPLOYMENT_REVISION_HEADER, DEPLOYMENT_REVISION_UNKNOWN } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';

/** Response headers a cross-origin Hub page must be able to read. */
export const API_CORS_EXPOSED_HEADERS: readonly string[] = ['x-clowder-save-id', DEPLOYMENT_REVISION_HEADER];

/**
 * F294: publish the revision /api/health reports on every response Fastify sends (raw or hijacked
 * replies such as audio SSE or MCP transports bypass hooks; none of them is cacheable revision
 * evidence), so an already-open page learns about a deploy from whichever response completes first
 * instead of only from a short health probe that times out exactly when the backend is overloaded.
 * Read per request: the deployment context can replace the boot revision after listen.
 * An unknown revision is published as DEPLOYMENT_REVISION_UNKNOWN, never as absence: a 304
 * revalidation replaces only the headers it carries, so absence would leave a cached copy's
 * older revision in place. Browsers treat the sentinel as no observation.
 */
export function registerDeploymentRevisionHeader(app: FastifyInstance, currentRevision: () => string | null): void {
  app.addHook('onRequest', (_request, reply, done) => {
    reply.header(DEPLOYMENT_REVISION_HEADER, currentRevision() ?? DEPLOYMENT_REVISION_UNKNOWN);
    done();
  });
}
