import type { FastifyRequest } from 'fastify';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import type { PluginManagerRouteOptions } from './plugin-manager-routes.js';
import { captureNativeCallbackCurrentness } from './plugin-native-action-currentness.js';

/** A direct tool retains its ordinary route authorization; model identity is a separate Host fact. */
export function captureDirectToolCaller(request: FastifyRequest, options: PluginManagerRouteOptions) {
  if (!request.callbackAuth) {
    if (request.callbackPrincipal) throw new NativePluginActionError(401, 'Live invocation credentials required');
    return undefined;
  }
  const registry = options.callbackRegistry;
  if (!registry?.verifyLatest) throw new NativePluginActionError(503, 'Invocation currentness is unavailable');
  const invocationId = request.headers['x-invocation-id'];
  const callbackToken = request.headers['x-callback-token'];
  if (typeof callbackToken !== 'string' || invocationId !== request.callbackAuth.invocationId)
    throw new NativePluginActionError(401, 'Live invocation credentials required');
  return captureNativeCallbackCurrentness(
    request.callbackAuth,
    callbackToken,
    undefined,
    {
      registry: { verifyLatest: registry.verifyLatest.bind(registry) },
      ...(options.threadStore ? { threadStore: options.threadStore } : {}),
    },
    'cat_cafe_plugin_manager_mutation',
  );
}
