import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { parse } from 'yaml';
import type { CollectivePublishedMediaOwner } from '../src/domains/collaborative-content/collective-artifact/published-media-owner.js';
import { createModuleHostInvocation } from '../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { createCollectiveArtifactOwnerProxy } from '../src/domains/plugin/host-surface/collective-artifact-owner.js';
import { pluginWebhookForwardingRoutes } from '../src/routes/plugin/plugin-webhook-forwarding-routes.js';
import {
  CollectiveConnector,
  collectivePackageRoot,
  loadCollectiveModule,
} from './helpers/f202-collective-installed-business.js';

export async function mediaHostFixture(
  t: { after(fn: () => Promise<unknown>): void },
  directory: string,
  retainedMedia?: CollectivePublishedMediaOwner,
  listen: { port?: number; hostOrigin?: string; connector?: InstanceType<typeof CollectiveConnector> } = {},
) {
  const connector =
    listen.connector ?? (await CollectiveConnector.open({ dataDirectory: directory, verifyAgent: async () => false }));
  if (!listen.connector) t.after(() => connector.stopMediaReads());
  const manifest = parse(await readFile(join(collectivePackageRoot, 'plugin.yaml'), 'utf8'));
  const { createCollectiveMediaHttp } = await loadCollectiveModule('collective-media-http.js');
  const instanceId = 'pi_collective_media';
  const unavailable = {
    execute: async (): Promise<never> => {
      throw new Error('owner_unavailable');
    },
  };
  const owner = createCollectiveArtifactOwnerProxy({
    pluginInstanceId: instanceId,
    owner: () => retainedMedia ?? unavailable,
    retainedMedia: () => retainedMedia,
    assertCurrent: async () => {},
  });
  const actions = { 'collective.media.http': createCollectiveMediaHttp({ connector, owner, assertActive: () => {} }) };
  const carrier = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const webhooks = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw new Error('unused');
      },
    },
    configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
  });
  await webhooks.activate(
    {
      instance: { pluginInstanceId: instanceId },
      packageRecord: {
        pluginId: manifest.pluginId,
        manifest: {
          ...manifest,
          contributions: manifest.contributions.filter(
            (item) => item.type === 'webhook' && item.action.method === 'collective.media.http',
          ),
        },
      },
      effectiveGrants: [],
    } as never,
    (id, method, input) => carrier.invoke(id, method, input),
  );
  const app = Fastify();
  if (listen.hostOrigin) await app.register(cors, { origin: listen.hostOrigin, credentials: true });
  // Fixture for the session issuer; never use URL/body/iframe input as a principal.
  app.addHook('preHandler', async (request) => {
    if (request.headers.cookie === 'test-session=reader') request.sessionUserId = 'reader-private-human';
    if (request.headers.cookie === 'test-session=publisher') request.sessionUserId = 'operator';
  });
  app.get('/api/session', async (request, reply) =>
    request.sessionUserId
      ? { userId: request.sessionUserId }
      : reply.code(401).send({ error: 'fixture session required' }),
  );
  await app.register(pluginWebhookForwardingRoutes, { webhooks });
  await app.listen({ host: '127.0.0.1', port: listen.port ?? 0 });
  t.after(async () => {
    webhooks.deactivate(instanceId);
    await app.close();
  });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  return { app, url: `http://127.0.0.1:${address.port}` };
}
