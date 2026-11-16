import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyRequest } from 'fastify';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';

interface RememberForward {
  parent: FastifyRequest;
  url: string;
  body: string;
  active: boolean;
  request?: FastifyRequest;
}

const forwarding = new AsyncLocalStorage<RememberForward>();

/** Server-only, one-child scope of an already claimed batch. Never represented by an HTTP credential. */
export async function withWatcherRememberForward<T>(
  parent: FastifyRequest,
  url: string,
  payload: Record<string, unknown>,
  dispatch: () => Promise<T>,
): Promise<T> {
  const auth = parent.callbackAuth;
  if (auth?.toolExecutionPolicy?.mode !== 'watcher') return dispatch();
  if (
    parent.method !== 'POST' ||
    parent.routeOptions.url !== '/api/callbacks/remember' ||
    parent.watcherToolTicket?.invocationId !== auth.invocationId
  )
    throw new Error('watcher_remember_parent_not_claimed');
  const scope: RememberForward = { parent, url, body: JSON.stringify(payload), active: true };
  return forwarding.run(scope, async () => {
    try {
      return await dispatch();
    } finally {
      scope.active = false;
    }
  });
}

/** Called only after normal auth AND allowedCallbackRoutes checks. Children do not own the batch receipt. */
export function claimWatcherRememberForward(request: FastifyRequest, record: InvocationRecord): boolean {
  const scope = forwarding.getStore();
  if (
    !scope?.active ||
    scope.parent.callbackAuth?.invocationId !== record.invocationId ||
    scope.parent.watcherToolTicket?.invocationId !== record.invocationId ||
    request.method !== 'POST' ||
    request.url !== scope.url ||
    JSON.stringify(request.body) !== scope.body ||
    (scope.request !== undefined && scope.request !== request)
  )
    return false;
  scope.request = request;
  return true;
}
