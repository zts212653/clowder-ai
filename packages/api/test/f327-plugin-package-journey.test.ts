import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CapabilitiesConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  InstalledPluginOperations,
  pluginOperationRoutes,
} from '../src/domains/plugin/operations/plugin-operation-routes.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
  type DormantPluginRuntimeComposition,
} from '../src/domains/plugin/runtime-composition.js';
import { pluginNativeActionRoutes } from '../src/routes/plugin-native-action-routes.js';
import { nativeTool } from './helpers/native-music-tool.js';

const journeyName =
  'exact music archive: disabled setup, owner-confirmed reuse, enable, native generation and retained files after stop/uninstall';
test(journeyName, { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f327-installed-journey-'));
  const originalFetch = globalThis.fetch;
  const originalAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const adc = join(root, 'fixture-adc.json');
  let runtime: DormantPluginRuntimeComposition | undefined;
  const app = Fastify({ forceCloseConnections: true });
  t.after(
    async () => {
      try {
        // Closing inbound HTTP must not wait behind a stop that itself drains requests.
        const results = await Promise.allSettled([app.close(), runtime?.shutdown()]);
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'fixture cleanup failed',
          );
      } finally {
        // Keep interception, fixture credentials and package bytes alive until work stops.
        globalThis.fetch = originalFetch;
        if (originalAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        else process.env.GOOGLE_APPLICATION_CREDENTIALS = originalAdc;
        await rm(root, { recursive: true, force: true });
      }
    },
    { timeout: 15_000 },
  );
  await writeFile(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'fixture-client',
      client_secret: 'fixture-only',
      refresh_token: 'fixture-grant',
      quota_project_id: 'project-one',
    }),
    { mode: 0o600 },
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  let generated = 0;
  const audio = Buffer.from('ID3installed-fixture-audio');
  globalThis.fetch = async (url) => {
    const target = String(url);
    const json = (value: unknown) => new Response(JSON.stringify(value));
    if (target === 'https://oauth2.googleapis.com/token')
      return json({ token_type: 'Bearer', access_token: 'fixture-access', expires_in: 3600 });
    if (target === 'https://cloudbilling.googleapis.com/v1/projects/project-one/billingInfo?fields=billingEnabled')
      return json({ billingEnabled: true });
    if (
      target ===
      'https://serviceusage.googleapis.com/v1/projects/project-one/services/aiplatform.googleapis.com?fields=state'
    )
      return json({ state: 'ENABLED' });
    if (target === 'https://aiplatform.googleapis.com/v1beta1/projects/project-one/locations/global/interactions') {
      generated++;
      return json({
        status: 'completed',
        model: 'lyria-3-clip-preview',
        id: 'fixture-response',
        outputs: [{ type: 'audio', mime_type: 'audio/mpeg', data: audio.toString('base64') }],
      });
    }
    throw new Error('Network outside the installed fixture is forbidden');
  };
  const owner = 'default-user';
  const threadStore = new ThreadStore();
  const thread = threadStore.create(owner, 'Music fixture', root);
  let capabilities: CapabilitiesConfig | null = null;
  runtime = createDormantPluginRuntimeComposition({
    projectRoot: root,
    capabilityProjectRoot: root,
    messageStore: new MessageStore(),
    threadStore,
    threadOwnerUserId: owner,
    mcpConfigIO: {
      readConfig: async () => capabilities,
      writeAndRegenCli: async (value) => {
        capabilities = value;
      },
      withLock: async (run) => run(),
    },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
    catalogManifests: [],
  });
  const artifact = new URL('./fixtures/f327-music-plugin-candidate.tgz', import.meta.url);
  const bytes = await readFile(artifact);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const installed = await composition.manager.install({
    source: { kind: 'local-archive', path: artifact.pathname },
    expectedDigest: integrity,
  });
  const pluginId = installed.pluginId;
  const initial = (await composition.manager.get(pluginId)).plugin;
  assert.equal(initial.intent, 'disabled');
  assert.equal(initial.live, 'stopped');
  assert.equal(initial.config, 'incomplete');
  assert.equal(generated, 0);
  const operations = new InstalledPluginOperations({
    inventory: runtime.inventoryStore,
    configuration: composition.configuration,
    invocation: runtime.supervisor,
    settingsInvocation: runtime.settingsInvocation,
  });
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
    request.assertSessionCurrent = () => {};
  });
  await app.register(pluginOperationRoutes, { operations });
  const record = {
    invocationId: 'fixture-invocation',
    callbackToken: 'fixture-callback',
    catId: 'cat-one',
    threadId: thread.id,
    userId: owner,
    ownerAuthProvenance: 'strict' as const,
  };
  const verify = async (id: string, key: string) =>
    id === record.invocationId && key === record.callbackToken
      ? { ok: true as const, record }
      : { ok: false as const, reason: 'invalid_token' as const };
  await app.register(pluginNativeActionRoutes, {
    actions: runtime.supervisor.nativeActions,
    registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true } as Parameters<
      typeof pluginNativeActionRoutes
    >[1]['registry'],
    sources: {},
    threadStore,
  });
  const call = (confirmed: boolean) =>
    app.inject({
      method: 'POST',
      url: `/api/plugins/${pluginId}/actions/existingAuthorization/import`,
      remoteAddress: '127.0.0.1',
      headers: {
        host: 'localhost:5173',
        origin: 'http://localhost:5173',
        ...(confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}),
      },
      payload: { projectId: 'project-one' },
    });
  const unconfirmed = await call(false);
  assert.equal(unconfirmed.statusCode, 400, unconfirmed.payload);
  const reused = await call(true);
  assert.equal(reused.statusCode, 200, reused.payload);
  assert.equal(reused.json().data.status, 'connected');
  assert.equal(reused.payload.includes('fixture-grant'), false);
  const checked = await app.inject({
    method: 'POST',
    url: `/api/plugins/${pluginId}/test`,
    remoteAddress: '127.0.0.1',
    headers: { host: 'localhost:5173', origin: 'http://localhost:5173' },
  });
  assert.equal(checked.statusCode, 200, checked.payload);
  assert.equal(checked.json().ok, true, checked.payload);
  assert.equal(generated, 0);
  const configured = (await composition.manager.get(pluginId)).plugin;
  assert.equal(configured.config, 'ready');
  assert.equal(configured.intent, 'disabled');
  await composition.manager.setEnabled(pluginId, { enabled: true, expectedRevision: configured.lifecycleRevision });
  const enabled = (await composition.manager.get(pluginId)).plugin;
  assert.equal(enabled.live, 'running');
  assert.equal(generated, 0);
  const environment = runtime.supervisor.nativeActions.environment(installed.pluginInstanceId, 'music-native');
  assert.ok(environment.CLOWDER_PLUGIN_ACTION_TOKEN);
  const descriptor = await runtime.supervisor.resolveNativeMcpLaunch({
    mode: 'plugin_native',
    pluginInstanceId: installed.pluginInstanceId,
    contributionId: 'music-native',
    actionMethods: ['music.output'],
  });
  assert.ok(
    descriptor?.command && descriptor.args,
    'the installed contribution supplies the actual packed native entrypoint',
  );
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const launchCommand = descriptor.command;
  const request = {
    requestId: 'installed-once',
    outputPath: 'soundtrack.mp3',
    parameters: { prompt: 'Quiet piano' },
  };
  const invoke = () =>
    nativeTool(
      launchCommand,
      [...descriptor.args],
      {
        ...environment,
        CAT_CAFE_API_URL: address,
        CAT_CAFE_INVOCATION_ID: record.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: record.callbackToken,
      },
      request,
      { signal: t.signal },
    );
  let result = await invoke();
  for (let i = 0; i < 100 && result.state === 'pending'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await invoke();
  }
  assert.equal(result.state, 'delivered', JSON.stringify(result));
  assert.equal(generated, 1);
  assert.deepEqual(await readFile(join(root, 'soundtrack.mp3')), audio);
  const receiptPath = join(root, 'soundtrack.mp3.provenance.json');
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).cost.actualChargedUsd, null);
  assert.equal((await invoke()).state, 'delivered');
  assert.equal(generated, 1);
  const current = (await composition.manager.get(pluginId)).plugin;
  await composition.manager.setEnabled(pluginId, { enabled: false, expectedRevision: current.lifecycleRevision });
  await assert.rejects(invoke());
  const stopped = (await composition.manager.get(pluginId)).plugin;
  await composition.manager.uninstall(pluginId, { expectedRevision: stopped.lifecycleRevision });
  assert.deepEqual(await readFile(join(root, 'soundtrack.mp3')), audio);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).delivery.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(generated, 1);
});
