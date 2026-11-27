import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { validateManifest } from '@clowder-ai/plugin-contract';
import Fastify from 'fastify';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { computeKimiL0Fingerprint } from '../dist/domains/cats/services/agents/providers/kimi-l0-session-fingerprint.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { accountsRoutes } from '../dist/routes/accounts.js';
import { registerAgentAccessRoutes } from '../dist/routes/agent-access-routes.js';

const archive = process.env.CLOWDER_KIMI_CANDIDATE_ARCHIVE;
const executable = process.env.CLOWDER_KIMI_CANDIDATE_EXECUTABLE;

test(
  'standalone Kimi archive loads across repositories and uses a scoped native grant',
  {
    skip: !archive || !executable,
    timeout: 45_000,
  },
  async (t) => {
    assert.ok(isAbsolute(archive) && isAbsolute(executable));
    const temp = resolve(tmpdir());
    const projectRoot = await mkdtemp(join(temp, 'kimi-adapter-cross-repo-'));
    const previousConfigRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = projectRoot;
    t.after(() => {
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousConfigRoot;
    });
    const accountHome = join(projectRoot, 'isolated-account');
    await mkdir(join(accountHome, 'credentials'), { recursive: true });
    await writeFile(
      join(accountHome, 'config.toml'),
      '[providers.fixture]\ntype = "kimi"\n[providers.fixture.oauth]\nstorage = "file"\nkey = "fixture"\n',
    );
    await writeFile(join(accountHome, 'credentials', 'fixture.json'), JSON.stringify({ access_token: 'test-only' }));
    writeCatalogAccount(projectRoot, 'fixture-kimi', {
      authType: 'oauth',
      clientId: 'kimi',
      displayName: 'Isolated Kimi fixture',
      envVars: { KIMI_CODE_HOME: accountHome },
    });
    const ref = { pluginId: 'official.agent-kimi', contributionId: 'kimi' };
    const registry = new SessionImplementationRegistry();
    const observedAt = Date.parse('2026-11-27T00:00:00Z');
    const calls = [];
    const legacyCalls = [];
    let approvedDigest;
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot,
      messageStore: new MessageStore(),
      contract: { manifestContractRange: '0.4.0-candidate.0', validateManifest },
      agentSessionImplementations: registry,
      grantAgentAdapterNativeRuntime(request) {
        if (
          !approvedDigest ||
          request.packageDigest !== approvedDigest ||
          request.pluginId !== ref.pluginId ||
          request.contributionId !== ref.contributionId
        )
          return;
        if (request.action === 'detect')
          return {
            async inspect(signal) {
              const { stdout, stderr } = await promisify(execFile)(executable, ['--version'], {
                cwd: projectRoot,
                env: {
                  ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                  TEMP: projectRoot,
                  TMP: projectRoot,
                  HOME: projectRoot,
                  USERPROFILE: projectRoot,
                  KIMI_CODE_HOME: projectRoot,
                },
                timeout: 4000,
                windowsHide: true,
                signal,
              });
              const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?/.exec(stdout || stderr)?.[0];
              assert.ok(version, 'No version was returned by the actual Kimi CLI');
              return { status: 'ready', version };
            },
          };
        if (request.action === 'quota') {
          assert.equal(request.account?.accountRef, 'fixture-kimi');
          return {
            terminal: {
              async capture(input) {
                assert.deepEqual(input, { submit: '/usage' });
                calls.push('terminal');
                return { output: '5h limit 25% used\r\nweekly limit 90% left', observedAt };
              },
            },
          };
        }
        assert.equal(request.catId, 'fixture');
        assert.equal(request.hostSession?.cwd, projectRoot);
        if (request.action === 'openSession')
          return {
            async prepare(input) {
              assert.equal(input.resumeNativeSessionId, 'legacy-native');
              return {
                nativeSessionId: 'legacy-native',
                sessionFingerprint: computeKimiL0Fingerprint('fixture identity'),
              };
            },
          };
        if (request.action === 'startTurn')
          return {
            async run(input) {
              assert.deepEqual(input.args, [
                '--output-format',
                'stream-json',
                '--session',
                'legacy-native',
                '-p',
                'continue',
              ]);
              return (async function* () {
                yield {
                  kind: 'record',
                  value: {
                    role: 'assistant',
                    content: 'portable driver fixture',
                    session_id: 'legacy-native',
                    usage: { input_tokens: 3, output_tokens: 4 },
                  },
                };
                yield { kind: 'exit', code: 0 };
              })();
            },
          };
      },
    });
    t.after(async () => {
      await runtime.shutdown();
      assert.equal(dirname(projectRoot), temp);
      await rm(projectRoot, { recursive: true, force: true });
    });
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [],
      catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 0 }) },
    });
    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    approvedDigest = plugin.packageDigest;
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = request.headers['x-test-session-user'];
    });
    registerAgentAccessRoutes(app, {
      inventory: runtime.inventoryStore,
      runtime: {
        attemptInvoke() {
          legacyCalls.push('detection');
          assert.fail('Explicit detection must never call the shared Agent Access package');
        },
      },
      agentAdapters: runtime.agentAdapters,
    });
    await app.register(accountsRoutes, {
      kimiQuotaSampler: () => {
        legacyCalls.push('quota');
        assert.fail('An account selected for the adapter must never use the shared sampler');
      },
      kimiQuotaDispatch: {
        resolveRef: (_root, accountRef) => (accountRef === 'fixture-kimi' ? ref : undefined),
        quota: runtime.agentAdapters.quota,
      },
    });
    const detect = (authenticated = true) =>
      app.inject({
        method: 'POST',
        url: '/api/agent-access/v1/detect',
        headers: { host: 'localhost:3004', ...(authenticated ? { 'x-test-session-user': 'owner-user' } : {}) },
        payload: { adapterRef: 'plugin:official.agent-kimi/kimi', refresh: true },
      });
    assert.equal((await detect(false)).statusCode, 401);
    const detected = await detect();
    assert.equal(detected.statusCode, 200, detected.body);
    const status = detected.json();
    assert.equal(status.readiness.state, 'ready');
    assert.equal(status.candidates[0].state.status, 'ready');
    assert.equal(status.adapterOrigin.packageDigest, approvedDigest);
    assert.equal(status.adapterOrigin.ref, 'plugin:official.agent-kimi/kimi');
    t.diagnostic(`Actual Kimi CLI version ${status.candidates[0].state.version}; turn and quota use synthetic IO`);
    approvedDigest = undefined;
    const ungrantedDetection = await detect();
    assert.equal(ungrantedDetection.statusCode, 503);
    assert.equal(ungrantedDetection.json().readiness.state, 'unavailable');
    assert.equal(ungrantedDetection.json().candidates[0].state.status, 'unavailable');
    approvedDigest = plugin.packageDigest;
    const readQuota = () =>
      app.inject({
        method: 'POST',
        url: '/api/accounts/fixture-kimi/kimi/quota',
        headers: { 'x-cat-cafe-user': 'fixture-user' },
        payload: { projectPath: projectRoot },
      });
    const quotaResponse = await readQuota();
    assert.equal(quotaResponse.statusCode, 200, quotaResponse.body);
    const quota = quotaResponse.json();
    assert.equal(quota.kimiQuota.observedAt, observedAt);
    assert.deepEqual(
      quota.kimiQuota.items.map(({ poolId, usedPercent }) => [poolId, usedPercent]),
      [
        ['kimi-rate-limit', 25],
        ['kimi-weekly', 10],
      ],
    );
    assert.equal(quota.adapterOrigin.packageDigest, approvedDigest);
    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    assert.equal(service.implementationSnapshot().key, 'plugin:official.agent-kimi/kimi');
    const messages = await Array.fromAsync(
      service.invoke('continue', {
        hostSessionId: 'host-fixture',
        sessionId: 'legacy-native',
        invocationId: 'kimi-fixture-turn',
        workingDirectory: projectRoot,
        systemPrompt: 'fixture identity',
      }),
    );
    assert.equal(messages.find((item) => item.type === 'text')?.content, 'portable driver fixture');
    assert.equal(messages.at(-1)?.metadata.sessionId, 'legacy-native');
    assert.equal(messages.at(-1)?.errorCode, undefined, messages.find((item) => item.type === 'error')?.error);
    assert.equal(messages.at(-1)?.metadata.usage?.outputTokens, 4);
    const { plugin: enabled } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
    assert.equal(registry.has(ref), false);
    const disabledDetection = await detect();
    assert.equal(disabledDetection.statusCode, 503);
    assert.deepEqual(disabledDetection.json().candidates, []);
    const disabledQuota = await readQuota();
    assert.equal(disabledQuota.statusCode, 503);
    assert.deepEqual(calls, ['terminal']);
    assert.deepEqual(legacyCalls, []);
  },
);
