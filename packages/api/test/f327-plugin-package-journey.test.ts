import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type CapabilitiesConfig, catRegistry } from '@cat-cafe/shared';
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
import { registerPluginSharedMcpRoutes } from '../src/routes/plugin-shared-mcp.js';
import { cancelMusicPoll } from './helpers/cancel-music-poll.js';
import { nativeTool } from './helpers/native-music-tool.js';

const shared = process.env.F333_MUSIC_SHARED === '1';

const journeyName = `exact music archive (${shared ? 'shared HTTP' : 'stdio'}): setup, enable, generation, recovery and retained files after stop/uninstall`;
test(journeyName, { timeout: shared ? 120_000 : 60_000 }, async (t) => {
  const stages: { phase: string; elapsedMs: number }[] = [];
  const startedAt = performance.now();
  const mark = (phase: string) => {
    stages.push({ phase, elapsedMs: Math.round(performance.now() - startedAt) });
  };
  const root = await mkdtemp(join(tmpdir(), 'f327-installed-journey-'));
  const originalFetch = globalThis.fetch;
  const originalAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const adc = join(root, 'fixture-adc.json');
  let runtime: DormantPluginRuntimeComposition | undefined;
  let releaseGeneration = () => {};
  const app = Fastify({ forceCloseConnections: true });
  t.after(
    async () => {
      try {
        releaseGeneration();
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
        if (shared) console.log(JSON.stringify({ kind: 'f333-installed-journey-timing', stages }));
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
  const pendingGeneration = new Promise<void>((resolve) => {
    releaseGeneration = resolve;
  });
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
      if (shared && generated === 1) await pendingGeneration;
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
        if (shared) {
          await mkdir(join(root, '.cat-cafe'), { recursive: true });
          await writeFile(join(root, '.cat-cafe/capabilities.json'), JSON.stringify(value));
        }
      },
      withLock: async (run) => run(),
    },
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
    catalogManifests: [],
  });
  const artifact = new URL(
    shared ? './fixtures/f333-music-plugin-candidate.tgz' : './fixtures/f327-music-plugin-candidate.tgz',
    import.meta.url,
  );
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
    ...(shared
      ? {
          sharedMcpContext: {
            v: 1 as const,
            deploymentId: 'f333-fixture',
            workspaceRoot: root,
            capabilityRoot: root,
            dataDir: root,
            allowedWorkspaceDirs: [root],
            families: [],
          },
        }
      : {}),
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
  if (shared) {
    if (!catRegistry.has(record.catId))
      catRegistry.register(record.catId, { clientId: 'openai', mcpSupport: true } as never);
    registerPluginSharedMcpRoutes(app, {
      actions: runtime.supervisor.nativeActions,
      supervisor: runtime.supervisor,
      registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
      sources: {},
      threadStore,
      apiBaseUrl: 'http://127.0.0.1:1',
      deploymentId: 'f333-fixture',
    } as never);
  }
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
  mark('before-settings-import');
  const reused = await call(true);
  mark('after-settings-import');
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
  mark('before-first-enable');
  await composition.manager.setEnabled(pluginId, { enabled: true, expectedRevision: configured.lifecycleRevision });
  mark('after-first-enable');
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
  let httpPath = shared
    ? (await runtime.supervisor.resolveMemberMcpView())?.entries.find((entry) => entry.pluginId === pluginId)
        ?.sharedHttpPath
    : undefined;
  if (shared) assert.ok(httpPath, 'the exact installed archive must expose its factory, not fall back to stdio');
  const rpcHttp = (method: string, params: unknown, id: number | null = 1) =>
    originalFetch(new URL(httpPath!, address), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
        'x-mcp-connection-id': 'f333-installed-connection',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(id === null ? {} : { id }),
        method,
        params,
      }),
    });
  const invokeHttp = async () => {
    const response = await rpcHttp('tools/call', { name: 'generate_music', arguments: request });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.ok(!body.result.isError, JSON.stringify(body));
    return JSON.parse(body.result.content[0].text) as { state: string };
  };
  const invoke = () =>
    shared
      ? invokeHttp()
      : nativeTool(
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
  mark('before-first-http-output');
  let result = await invoke();
  if (shared) {
    assert.equal(result.state, 'pending', 'the real installed Music job is still waiting for provider completion');
    await cancelMusicPoll(
      runtime.supervisor.nativeActions,
      () => rpcHttp('tools/call', { name: 'generate_music', arguments: request }),
      () => rpcHttp('notifications/cancelled', { requestId: 1 }, null),
    );
    assert.equal((await invoke()).state, 'pending', 'transport cancellation leaves the original provider job running');
    assert.equal(generated, 1, 'cancelling and resuming the same request never dispatches a replacement generation');
    releaseGeneration();
    mark('pending-job-survived-poll-cancellation');
  }
  for (let i = 0; i < 100 && result.state === 'pending'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await invoke();
  }
  assert.equal(result.state, 'delivered', JSON.stringify(result));
  mark('first-output-delivered');
  assert.equal(generated, 1);
  assert.deepEqual(await readFile(join(root, 'soundtrack.mp3')), audio);
  const receiptPath = join(root, 'soundtrack.mp3.provenance.json');
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).cost.actualChargedUsd, null);
  assert.equal((await invoke()).state, 'delivered');
  assert.equal(generated, 1);
  if (shared) {
    const secondProject = join(root, 'second-project');
    await mkdir(secondProject);
    // This isolated Host does not publish installation policy into other projects.
    // Give the second owned fixture project its own explicit canonical capability grant.
    const installedEntry = (await runtime.supervisor.resolveMemberMcpView())!.entries.find(
      (entry) => entry.pluginId === pluginId,
    )!;
    await mkdir(join(secondProject, '.cat-cafe'));
    await writeFile(
      join(secondProject, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          {
            ...installedEntry.installationPolicy,
            id: installedEntry.capabilityId,
            type: 'mcp',
            pluginId,
            source: 'plugin',
            enabled: true,
            blockedCats: [],
            mcpServer: { command: descriptor.command, args: [...descriptor.args], transport: 'stdio' },
          },
        ],
      }),
    );
    const secondThread = threadStore.create(owner, 'Second project', secondProject);
    record.threadId = secondThread.id;
    record.sharedMcpContext!.workspaceRoot = secondProject;
    let second = await invoke();
    for (let i = 0; second.state === 'pending' && i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      second = await invoke();
    }
    assert.equal(second.state, 'delivered');
    assert.equal(generated, 2, 'equal request IDs and output paths remain scoped to their two authenticated projects');
    assert.deepEqual(await readFile(join(secondProject, 'soundtrack.mp3')), audio);
    assert.deepEqual(await readFile(join(root, 'soundtrack.mp3')), audio);
    record.threadId = thread.id;
    record.sharedMcpContext!.workspaceRoot = root;
    const fallback = await nativeTool(
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
    assert.equal(fallback.state, 'delivered', 'the same actual package retains a usable stdio rollback');
    assert.equal(generated, 2);
  }
  mark('projects-and-stdio-rollback-complete');
  const expectedGenerated = shared ? 2 : 1;
  const current = (await composition.manager.get(pluginId)).plugin;
  await composition.manager.setEnabled(pluginId, { enabled: false, expectedRevision: current.lifecycleRevision });
  await assert.rejects(invoke());
  if (shared) {
    mark('before-reenable');
    const disabled = (await composition.manager.get(pluginId)).plugin;
    await composition.manager.setEnabled(pluginId, { enabled: true, expectedRevision: disabled.lifecycleRevision });
    mark('after-reenable');
    const replacement = (await runtime.supervisor.resolveMemberMcpView())!.entries.find(
      (entry) => entry.pluginId === pluginId,
    )!.sharedHttpPath;
    assert.ok(replacement);
    assert.notEqual(replacement, httpPath);
    httpPath = replacement;
    assert.equal(
      (await invoke()).state,
      'delivered',
      'module reconstruction recovers the same durable output without generation',
    );
    assert.equal(generated, expectedGenerated);
    const active = (await composition.manager.get(pluginId)).plugin;
    await composition.manager.setEnabled(pluginId, { enabled: false, expectedRevision: active.lifecycleRevision });
  }
  const stopped = (await composition.manager.get(pluginId)).plugin;
  await composition.manager.uninstall(pluginId, { expectedRevision: stopped.lifecycleRevision });
  assert.deepEqual(await readFile(join(root, 'soundtrack.mp3')), audio);
  assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).delivery.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(generated, expectedGenerated);
});
