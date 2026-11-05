import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../../src/domains/concierge/ConciergeThreadService.js';
import { CompanionHostBridge } from '../../src/domains/concierge/live/CompanionHostBridge.js';
import type { DesktopWindowLaunch } from '../../src/domains/plugin/desktop-window-runtime/types.js';
import { OfficialPluginPackageInstaller } from '../../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../../src/domains/plugin/runtime-composition.js';
import { sessionAuthPlugin, sessionRoute } from '../../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../../src/routes/concierge.js';
import { desktopWindowFixture } from '../f317-window.fixture.js';

/** Real admitted archive, Broker, private stage, bridge and owner authentication;
 * only the native window and realtime provider are synthetic. No media or Redis. */
export async function integrityPollFixture(t: TestContext, large = false) {
  const f = await desktopWindowFixture();
  for (let i = 0; large && i < 59; i++)
    await writeFile(join(f.root, 'package/renderer', `asset-${i}.bin`), Buffer.alloc(216000, i));
  await promisify(execFile)('tar', ['czf', join(f.root, 'package.tgz'), '-C', f.root, 'package']);
  const bytes = await readFile(join(f.root, 'package.tgz'));
  const entry = { ...f.entry, packageDigest: `sha512-${createHash('sha512').update(bytes).digest('base64')}` };
  const app = Fastify();
  let blockRead: (() => Promise<void>) | undefined;
  app.addHook('preHandler', async (request) => {
    if (request.url === '/api/concierge/config?view=native') await blockRead?.();
  });
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'integrity-poll-owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'integrity-poll-owner' });
  const callId = randomUUID();
  const config = { ...CONCIERGE_CONFIG_DEFAULTS, dutyCatProfileId: 'opus' };
  const configStore = new MemoryConciergeConfigStore();
  await configStore.put('integrity-poll-owner', config);
  await app.register(conciergeRoutes, {
    conciergeConfigStore: configStore,
    conciergeThreadService: new ConciergeThreadService({
      conciergeConfigStore: configStore,
      threadStore: new ThreadStore(),
    }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
    processes: {
      spawn: async () => {
        throw new Error('static poll fixture cannot spawn external processes');
      },
    },
  });
  app.post('/api/concierge/live', async (_, reply) => reply.code(202).send({ callId }));
  app.get('/api/concierge/live/:id', async () => ({
    state: 'ready',
    catId: 'codex',
    toolsReady: true,
    nativeActivity: 'none',
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  }));
  app.get('/api/concierge/live/:id/transcript', async () => ({
    scope: { callId, realtimeSessionId: 'synthetic-session' },
    messages: [],
    hasMore: false,
  }));
  app.delete('/api/concierge/live/:id', async () => ({ stopped: true }));
  app.get('/api/threads/:id', async () => ({ title: 'Synthetic history' }));
  app.get('/api/messages', async () => ({ messages: [], hasMore: false }));
  let launch: DesktopWindowLaunch | undefined;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => 2000,
    createCompanionBridge: (options) =>
      new CompanionHostBridge({
        ...options,
        app,
        ownerUserId: 'integrity-poll-owner',
        origin: 'http://localhost:5472',
        companionContract: '0.1.0-beta.23',
        openConversation: async () => false,
      }),
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        return { poll: async () => 'visible', show: async () => {}, close: async () => {} };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await app.close();
    await f.cleanup();
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [entry],
    fetchArchive: async () => bytes,
  });
  const installed = await installer.install(entry.catalogId, entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.ok(launch?.request);
  const stageName = (await readdir(runtime.paths.packagesRoot)).find((name) => name.startsWith('.runtime-stage-'));
  assert.ok(stageName);
  const stagedRoot = join(runtime.paths.packagesRoot, stageName, 'ready');
  const request = launch.request;
  const initial = await request({ kind: 'prepare' });
  assert.equal(initial.kind, 'state', `synthetic call must be admitted: ${JSON.stringify(initial)}`);
  return {
    runtime,
    request,
    installed,
    stagedRoot,
    launch,
    blockOwnerRead: (block: () => Promise<void>) => {
      blockRead = block;
    },
  };
}
