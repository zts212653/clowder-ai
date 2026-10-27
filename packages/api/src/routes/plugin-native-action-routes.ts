import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import { NativePluginActionError, type NativePluginActions } from '../domains/plugin/declared/native-plugin-actions.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';
import { captureTypedWaitSource } from './callback-typed-wait-source.js';
import { captureNativeCallbackCurrentness } from './plugin-native-action-currentness.js';

export interface PluginNativeActionRouteOptions {
  readonly actions: NativePluginActions;
  readonly registry: Pick<InvocationRegistry, 'verify' | 'verifyLatest' | 'isStartupRecoveryComplete'>;
  readonly sources: Parameters<typeof captureTypedWaitSource>[1];
  readonly threadStore?: Parameters<typeof getDeletedCallbackThreadGuard>[0];
}

const bodySchema = z.object({ method: z.string().min(1).max(256), input: z.unknown() }).strict();

/** Native plugin MCP transport; business identity never comes from tool arguments. */
export const pluginNativeActionRoutes: FastifyPluginAsync<PluginNativeActionRouteOptions> = async (app, options) => {
  // Presence and registry lookups only: never log headers, tokens, body, or package exceptions.
  app.addHook('preHandler', async (request) => {
    const token = request.headers['x-clowder-plugin-action-token'];
    const parsed = bodySchema.safeParse(request.body);
    request.log.info(
      {
        event: 'plugin_native_auth',
        stage: 'received',
        hasInvocationId: typeof request.headers['x-invocation-id'] === 'string',
        hasCallbackToken: typeof request.headers['x-callback-token'] === 'string',
        hasActivationToken: typeof token === 'string',
        activeTargetKnown: typeof token === 'string' && parsed.success && Boolean(options.actions.target(token)),
      },
      'Native plugin action received',
    );
  });
  registerCallbackAuthHook(app, options.registry, {
    pluginNativeActionTarget: (request) => {
      const token = request.headers['x-clowder-plugin-action-token'];
      const parsed = bodySchema.safeParse(request.body);
      return typeof token === 'string' && parsed.success ? options.actions.target(token) : undefined;
    },
  });
  app.post('/api/plugin-runtime/action', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    const invocationId = request.headers['x-invocation-id'];
    const callbackToken = request.headers['x-callback-token'];
    const token = request.headers['x-clowder-plugin-action-token'];
    if (typeof invocationId !== 'string' || typeof callbackToken !== 'string' || typeof token !== 'string') {
      request.log.warn(
        { event: 'plugin_native_auth', stage: 'headers', reason: 'missing_credentials' },
        'Native plugin action rejected',
      );
      return reply.status(401).send({ error: 'Native plugin invocation credentials required' });
    }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid plugin action input' });
    const verified = await options.registry.verifyLatest(invocationId, callbackToken);
    if (!verified.ok) {
      request.log.warn(
        { event: 'plugin_native_auth', stage: 'invocation_currentness', reason: verified.reason },
        'Native plugin action rejected',
      );
      return reply.status(401).send({ error: 'Invocation is not current' });
    }
    const { record } = verified;
    request.log.info(
      {
        event: 'plugin_native_auth',
        stage: 'invocation_verified',
        invocationId: record.invocationId,
        threadId: record.threadId,
        catId: record.catId,
      },
      'Native plugin invocation verified',
    );
    let fence: ReturnType<typeof captureNativeCallbackCurrentness> | undefined;
    const onAbort = () => fence?.close();
    const onClose = () => {
      if (!reply.raw.writableEnded) onAbort();
    };
    try {
      fence = captureNativeCallbackCurrentness(record, callbackToken, options.actions.target(token), options);
      request.raw.on('aborted', onAbort);
      reply.raw.on('close', onClose);
      if (request.raw.aborted) onAbort();
      const deleted = await getDeletedCallbackThreadGuard(options.threadStore, fence.identity.threadId);
      if (deleted) return reply.status(deleted.statusCode).send(deleted.body);
      const source = await captureTypedWaitSource(record, options.sources);
      const result = await options.actions.call(token, parsed.data.method, parsed.data.input, {
        ...fence.identity,
        ...(source ? { source: Object.freeze(source) } : {}),
        assertCurrent: fence.assertCurrent,
        assertInvocationCurrent: fence.assertInvocationCurrent,
      });
      request.log.info({ event: 'plugin_native_auth', stage: 'completed' }, 'Native plugin action completed');
      return { result };
    } catch (error) {
      if (error instanceof NativePluginActionError) {
        request.log.warn(
          {
            event: 'plugin_native_auth',
            stage: error.statusCode === 401 ? 'activation' : 'action_authority',
            reason: error.statusCode === 401 ? 'inactive_connection' : 'action_refused',
            statusCode: error.statusCode,
          },
          'Native plugin action rejected',
        );
        return reply.status(error.statusCode).send({ error: error.message });
      }
      // Package failures may contain provider secrets; do not serialize arbitrary exception text.
      request.log.warn(
        { event: 'plugin_native_auth', stage: 'execution', reason: 'plugin_runtime_failure' },
        'Native plugin action failed',
      );
      return reply.status(502).send({ error: 'Plugin action failed' });
    } finally {
      fence?.close();
      request.raw.off('aborted', onAbort);
      reply.raw.off('close', onClose);
    }
  });
};
