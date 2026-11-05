import type { FastifyPluginAsync } from 'fastify';
import { PluginExternalAccessError } from '../../domains/plugin/external-access/plugin-external-access.js';

export interface PluginExternalRequestRoutesOptions {
  readonly external: {
    handle(token: string, request: Readonly<Record<string, unknown>>): Promise<unknown>;
  };
}

const REQUEST_HEADERS = new Set(['accept', 'content-type', 'last-event-id', 'mcp-protocol-version', 'mcp-session-id']);
const RESPONSE_HEADERS = new Set(['cache-control', 'content-type', 'retry-after', 'x-content-type-options']);

function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('Bearer ')) return undefined;
  const token = value.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

function requestToken(authorization: string | undefined, query: unknown): string | undefined {
  const bearer = bearerToken(authorization);
  const candidate =
    typeof query === 'object' && query !== null && !Array.isArray(query) && 'token' in query
      ? (query as { token?: unknown }).token
      : undefined;
  const token = typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
  if (bearer !== undefined && token !== undefined && bearer !== token) return undefined;
  return bearer ?? token;
}

export const pluginExternalRequestRoutes: FastifyPluginAsync<PluginExternalRequestRoutesOptions> = async (
  app,
  opts,
) => {
  app.post('/api/plugin-runtime/handle', { bodyLimit: 15 * 1024 * 1024 }, async (request, reply) => {
    const token = requestToken(request.headers.authorization, request.query);
    if (token === undefined) return reply.status(401).send({ error: 'Plugin access token required' });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (!REQUEST_HEADERS.has(name) || value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    try {
      const response = await opts.external.handle(token, {
        method: request.method,
        headers,
        body: request.body,
      });
      if (typeof response !== 'object' || response === null || !('status' in response)) {
        return reply.status(502).send({ error: 'Plugin returned an invalid response' });
      }
      const result = response as { status?: unknown; headers?: unknown; body?: unknown };
      if (!Number.isInteger(result.status) || (result.status as number) < 100 || (result.status as number) > 599) {
        return reply.status(502).send({ error: 'Plugin returned an invalid response' });
      }
      if (typeof result.headers === 'object' && result.headers !== null && !Array.isArray(result.headers)) {
        for (const [name, value] of Object.entries(result.headers)) {
          if (RESPONSE_HEADERS.has(name.toLowerCase()) && typeof value === 'string') reply.header(name, value);
        }
      }
      return reply.status(result.status as number).send(result.body);
    } catch (error) {
      if (error instanceof PluginExternalAccessError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      request.log.error({ err: error }, 'plugin external request failed');
      return reply.status(502).send({ error: 'Plugin external request failed' });
    }
  });
};
