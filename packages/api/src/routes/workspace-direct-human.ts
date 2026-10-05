import type { FastifyRequest } from 'fastify';

export function workspaceDirectHuman(
  request: FastifyRequest,
  resolveUserId: (request: FastifyRequest) => string | null,
): string | null {
  return request.callbackPrincipal ||
    request.headers['x-invocation-id'] ||
    request.headers['x-callback-token'] ||
    request.headers['x-agent-key-secret']
    ? null
    : resolveUserId(request);
}
