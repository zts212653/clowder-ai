import { isDeepStrictEqual } from 'node:util';
import { createMemberGatewayHandler } from '@cat-cafe/mcp-server/dist/member-gateway.js';
import type { FastifyInstance } from 'fastify';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import { captureNativeCallbackCurrentness } from './plugin-native-action-currentness.js';
import type { PluginNativeActionRouteOptions } from './plugin-native-action-routes.js';
import { assertSharedPluginMcpAccess } from './plugin-shared-mcp-access.js';
import { createSharedPluginActionClient } from './plugin-shared-mcp-client.js';

export interface PluginSharedMcpOptions extends PluginNativeActionRouteOptions {
  supervisor: Pick<PluginRuntimeCarrierRouter, 'resolveSharedMcp' | 'resolveMemberMcpView'>;
  threadStore: Pick<IThreadStore, 'get'>;
  apiBaseUrl: string;
  deploymentId: string;
}

export function registerPluginSharedMcpRoutes(app: FastifyInstance, options: PluginSharedMcpOptions): void {
  const gateway = createMemberGatewayHandler({
    verify: async ({ invocationId, callbackToken }) => {
      if (options.registry.isStartupRecoveryComplete?.() === false)
        return { ok: false, reason: 'startup_recovery_pending' };
      const result = await options.registry.verifyLatest(invocationId, callbackToken);
      if (!result.ok) return { ok: false, reason: result.reason };
      const record = result.record;
      if (record.sharedMcpContext?.deploymentId !== options.deploymentId || record.toolExecutionPolicy)
        return { ok: false, reason: 'shared_plugin_mcp_unavailable' };
      return {
        ok: true,
        context: {
          invocationId,
          callbackToken,
          catId: record.catId,
          userId: record.userId,
          threadId: record.threadId,
          apiBaseUrl: options.apiBaseUrl,
          toolsetEnv: {},
          sharedContext: record.sharedMcpContext,
        },
      };
    },
    resolveFamilies: () => [],
    createMcpServer: async ({ context, url, signal }) => {
      const parts = /^\/api\/plugin-mcp\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!parts) throw new NativePluginActionError(403, 'Plugin MCP contribution is unavailable');
      const instanceId = decodeURIComponent(parts[1]!);
      const contributionId = decodeURIComponent(parts[2]!);
      const revision = url.searchParams.get('activation') ?? '';
      const binding = await options.supervisor.resolveSharedMcp(instanceId, contributionId, revision);
      const verified = await options.registry.verifyLatest(context.invocationId, context.callbackToken);
      if (!verified.ok) throw new NativePluginActionError(401, 'Invocation is not current');
      const record = verified.record;
      if (
        record.catId !== context.catId ||
        record.userId !== context.userId ||
        record.threadId !== context.threadId ||
        !isDeepStrictEqual(record.sharedMcpContext, context.sharedContext)
      )
        throw new NativePluginActionError(409, 'Invocation MCP identity changed');
      const fence = captureNativeCallbackCurrentness(
        record,
        context.callbackToken,
        { instanceId, contributionId },
        options,
      );
      const sharedContext = structuredClone(record.sharedMcpContext);
      let project: string | undefined;
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await fence.assertCurrent();
        const latest = await options.registry.verifyLatest(context.invocationId, context.callbackToken);
        if (!latest.ok || !isDeepStrictEqual(latest.record.sharedMcpContext, sharedContext))
          throw new NativePluginActionError(409, 'Invocation MCP context changed');
        await options.supervisor.resolveSharedMcp(instanceId, contributionId, revision);
        const currentProject = await assertSharedPluginMcpAccess(record, binding, options);
        if (project !== undefined && project !== currentProject)
          throw new NativePluginActionError(409, 'Calling project changed');
        project = currentProject;
        await fence.assertCurrent();
        signal.throwIfAborted();
      };
      try {
        await assertCurrent();
        const client = createSharedPluginActionClient({
          record,
          token: binding.token,
          fence,
          assertCurrent,
          signal,
          options,
        });
        const server = binding.factory(client);
        if (!server || typeof server.connect !== 'function' || typeof server.close !== 'function')
          throw new NativePluginActionError(502, 'Plugin MCP factory is incompatible');
        return {
          connect: async (transport) => {
            await assertCurrent();
            await server.connect(transport);
          },
          close: async () => {
            fence.close();
            await server.close();
          },
        };
      } catch (error) {
        fence.close();
        throw error;
      }
    },
    // Package exceptions are intentionally absent from this logger.
    log: app.log,
  });
  app.post('/api/plugin-mcp/:instanceId/:contributionId', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    reply.hijack();
    await gateway(request.raw, reply.raw, request.body);
  });
  app.get('/api/plugin-mcp/:instanceId/:contributionId', async (_request, reply) =>
    reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' }),
  );
}
