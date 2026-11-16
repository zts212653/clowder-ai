import Fastify from 'fastify';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook, requireCallbackAuth } from '../../dist/routes/callback-auth-prehandler.js';
import { registerCallbackRememberRoutes } from '../../dist/routes/callback-remember-routes.js';

export const paths = {
  profile: '/api/callbacks/propose-profile-update',
  taste: '/api/callbacks/propose-taste',
  matter: '/api/callbacks/memory-matters/write',
  person: '/api/callbacks/propose-person-memory',
};
export const items = ['profile', 'taste', 'matter', 'profile'].map((target, i) => ({
  itemId: `row-${i}`,
  target,
  payload: { marker: `${target}-${i}` },
}));

export async function fixture(
  t,
  { registry = new InvocationRegistry(), auth: existingAuth, allowed = ['profile', 'taste', 'matter'], onChild } = {},
) {
  const app = Fastify(),
    messages = new MessageStore(),
    calls = [],
    claims = [],
    receipts = [];
  t.after(() => app.close());
  const policy = {
    mode: 'watcher',
    maxToolCalls: 6,
    allowedToolNames: ['cat_cafe_remember', 'cat_cafe_get_message'],
    allowedCallbackRoutes: [
      'POST /api/callbacks/remember',
      'GET /api/callbacks/get-message',
      ...allowed.map((target) => `POST ${paths[target]}`),
    ],
  };
  const auth =
    existingAuth ?? (await registry.create('owner', 'codex', 'thread', undefined, undefined, policy, 'source'));
  const headers = { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken };
  const claim = registry.claimWatcherToolCallback.bind(registry);
  registry.claimWatcherToolCallback = async (...args) => {
    claims.push(args);
    return claim(...args);
  };
  const complete = registry.completeWatcherToolCallback.bind(registry);
  registry.completeWatcherToolCallback = async (...args) => {
    receipts.push(args);
    return complete(...args);
  };
  registerCallbackAuthHook(app, registry);
  for (const [target, path] of Object.entries(paths))
    app.post(path, async (request, reply) => {
      const caller = requireCallbackAuth(request, reply);
      if (!caller) return;
      calls.push({
        target,
        body: request.body,
        invocationId: caller.invocationId,
        userId: caller.userId,
        source: caller.originTriggerMessageId,
      });
      await onChild?.(target, request, registry);
      return target === 'matter'
        ? { outcome: 'applied', matterId: 'matter' }
        : { status: 'pending', proposalId: `${target}-${calls.length}` };
    });
  registerCallbackRememberRoutes(app, {
    registry,
    messageStore: messages,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  const request = (callId, payload = { clientRequestId: 'batch', items }) => ({
    method: 'POST',
    url: '/api/callbacks/remember',
    headers: { ...headers, 'x-watcher-tool-call-id': callId },
    payload,
  });
  const admit = (id, name = 'cat_cafe_remember') => registry.consumeWatcherToolCall(auth.invocationId, id, name);
  return { app, registry, auth, headers, calls, claims, receipts, messages, request, admit };
}
