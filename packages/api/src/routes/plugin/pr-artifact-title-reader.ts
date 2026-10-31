import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PrTitleReader } from '../../domains/cats/services/agents/routing/thread-artifact-pr-titles.js';

/** C2 presentation adapter: provider reads and credentials belong to the installed package. */
export function pluginPrTitleReader(app: FastifyInstance, request: FastifyRequest): PrTitleReader {
  return async (ref, signal) => {
    const remoteAddress = request.raw.socket.remoteAddress;
    if (!remoteAddress || signal.aborted) return null;
    // Re-enter the existing declared HTTP route with the original caller's credentials and
    // network boundary. This must not manufacture a localhost owner or bypass plugin admission.
    const response = await app.inject({
      method: 'GET',
      url: `/api/plugins/official.github-operations/github/pr-title?${new URLSearchParams({ ref })}`,
      headers: { ...request.headers },
      remoteAddress,
      signal,
    });
    if (response.statusCode !== 200 || signal.aborted) return null;
    const value: unknown = response.json();
    return value && typeof value === 'object' && 'title' in value && typeof value.title === 'string'
      ? value.title
      : null;
  };
}
