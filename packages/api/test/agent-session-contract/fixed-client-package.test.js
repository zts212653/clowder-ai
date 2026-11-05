import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { catRegistry } from '@cat-cafe/shared';
import { createAcpServiceForConfig } from '../../dist/domains/cats/services/agents/providers/acp/AcpServiceFactory.js';
import { createRefreshingAcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { declaredAgentSessionProviders } from '../../dist/domains/plugin/declared/declared-agent-session-providers.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../../dist/domains/plugin/index.js';
import { readPluginConfig } from '../../dist/domains/plugin/plugin-config-store.js';
import { collect, options } from './fake-session-provider.js';

test(
  'packed fixed client: real Host admission, shared configuration, two ACP sessions, disable and restart',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'fixed-client-package-'));
    catRegistry.reset();
    for (const id of ['codex', 'opus'])
      catRegistry.register(id, {
        id,
        clientId: 'acp',
        configurationSource: 'native_tool',
        defaultModel: '',
        mcpSupport: false,
      });
    const originalMode = process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
    if (process.platform === 'win32') process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = 'trusted-host';
    let host;
    try {
      let archive = process.env.CODEAGENT_PLUGIN_ARCHIVE;
      let pluginId = 'local.agent-session-reference';
      let contributionId = 'agent';
      if (!archive) {
        const source = join(root, 'source');
        await cp(new URL('../fixtures/agent-session-reference/plugin/', import.meta.url), join(source, 'package'), {
          recursive: true,
        });
        const packageRoot = join(source, 'package');
        const manifest = JSON.parse(await readFile(join(packageRoot, 'manifest.json'), 'utf8'));
        manifest.configuration = [
          { key: 'connection', label: 'Connection', kind: 'string', required: false, default: '{}' },
        ];
        await writeFile(join(packageRoot, 'manifest.json'), JSON.stringify(manifest));
        await writeFile(
          join(packageRoot, 'agent-provider.json'),
          JSON.stringify({
            id: contributionId,
            transport: 'acp',
            configurationKey: 'connection',
            acp: { command: 'unconfigured-client', startupArgs: ['--acp'] },
          }),
        );
        archive = join(root, 'fixture.tgz');
        await promisify(execFile)('tar', ['-czf', archive, '-C', source, 'package'], { windowsHide: true });
      } else {
        pluginId = 'official.codeagent';
        contributionId = 'codeagent';
      }
      const archiveHash = createHash('sha256')
        .update(await readFile(archive))
        .digest('hex');
      const projectRoot = join(root, 'project');
      await mkdir(projectRoot);
      const ref = { pluginId, contributionId };
      const makeHost = () => {
        const registry = new SessionImplementationRegistry();
        const pools = new Map();
        const services = new Map(
          ['codex', 'opus'].map((catId) => [catId, new RegisteredSessionAgentService({ catId, ref, registry })]),
        );
        const runtime = createDormantPluginRuntimeComposition({
          projectRoot,
          messageStore: new MessageStore(),
          agentSessionProviders: (packages, configuration) =>
            declaredAgentSessionProviders({
              packages,
              configuration,
              registry,
              services,
              settings: { mode: 'plugin', bindings: new Map() },
              createProvider: (declaration, { catId }) =>
                createRefreshingAcpSessionProvider({
                  catId,
                  scope: {},
                  revision: () => 1,
                  createService: () =>
                    createAcpServiceForConfig({
                      projectRoot,
                      profileId: catId,
                      config: {
                        id: catId,
                        clientId: 'acp',
                        configurationSource: 'native_tool',
                        defaultModel: '',
                        mcpSupport: false,
                      },
                      effectiveModel: '',
                      acpConfig: declaration.acp,
                      bootstrapRoot: declaration.acp.bootstrapRoot,
                      poolRegistry: pools,
                      log: { info() {}, warn() {} },
                    }),
                }),
            }),
        });
        const { manager } = createPluginManagerRuntimeComposition({
          runtime,
          catalogManifests: [],
          catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
        });
        return { runtime, manager, registry, services, pools };
      };
      host = makeHost();
      await host.manager.install({ source: { kind: 'local-archive', path: archive } });
      const current = async () => (await host.manager.get(pluginId)).plugin;
      const installed = await current();
      assert.equal(installed.intent, 'disabled');
      assert.equal(installed.config, 'ready');
      const savedConnection = JSON.stringify({
        command: process.execPath,
        startupArgs: [fileURLToPath(new URL('../fixtures/plugin-acp-session-agent.mjs', import.meta.url))],
        bootstrapRoot: join(root, 'bootstrap'),
        permissionPolicy: 'deny',
      });
      await host.manager.configure(pluginId, {
        expectedRevision: installed.lifecycleRevision,
        updates: [{ key: 'connection', value: savedConnection }],
      });
      await host.manager.setEnabled(pluginId, { enabled: true, expectedRevision: (await current()).lifecycleRevision });
      assert.ok(host.registry.has(ref));
      assert.equal(host.pools.size, 2, 'one plugin prepares separate member pools');
      const invoke = (catId, text) =>
        collect(host.services.get(catId).invoke(text, options({ hostSessionId: `host-${catId}` })));
      const first = await invoke('codex', 'first-member');
      const other = await invoke('opus', 'second-member');
      assert.equal(first.at(-1).errorCode, undefined);
      assert.equal(other.at(-1).errorCode, undefined);
      assert.ok(
        first.some((m) => m.metadata?.model === 'model-a'),
        'native default comes from the actual session response',
      );
      assert.notEqual(
        first.find((m) => m.type === 'session_init').sessionId,
        other.find((m) => m.type === 'session_init').sessionId,
      );
      const continued = await invoke('codex', 'continued #tool');
      assert.ok(continued.some((m) => m.content?.includes('previous=first-member')));
      assert.ok(continued.some((m) => m.type === 'tool_use'));
      assert.ok(!continued.some((m) => m.content?.includes('previous=second-member')));
      const denied = await invoke('codex', '#permission');
      assert.ok(
        denied.some((m) => m.content?.includes('"optionId":"reject"')),
        'the factory enforces the explicit deny policy on the wire',
      );
      const allowedConnection = JSON.stringify({ ...JSON.parse(savedConnection), permissionPolicy: 'auto_allow' });
      await host.manager.configure(pluginId, {
        expectedRevision: (await current()).lifecycleRevision,
        updates: [{ key: 'connection', value: allowedConnection }],
      });
      assert.ok((await invoke('codex', '#permission')).some((m) => m.content?.includes('"optionId":"allow"')));
      await host.manager.configure(pluginId, {
        expectedRevision: (await current()).lifecycleRevision,
        updates: [{ key: 'connection', value: savedConnection }],
      });
      await assert.rejects(
        host.manager.configure(pluginId, {
          expectedRevision: (await current()).lifecycleRevision,
          updates: [{ key: 'connection', value: '{"id":"invalid-identity-override"}' }],
        }),
        { code: 'RUNTIME_START_FAILED' },
      );
      assert.equal(readPluginConfig(projectRoot, pluginId).connection, '{"id":"invalid-identity-override"}');
      assert.equal(host.registry.has(ref), false);
      await host.manager.configure(pluginId, {
        expectedRevision: (await current()).lifecycleRevision,
        updates: [{ key: 'connection', value: savedConnection }],
      });
      assert.ok(
        host.registry.has(ref),
        'correcting a saved invalid connection recovers without reinstall or manual enable',
      );
      assert.equal((await invoke('codex', 'recovered')).at(-1).errorCode, undefined);
      await host.manager.setEnabled(pluginId, {
        enabled: false,
        expectedRevision: (await current()).lifecycleRevision,
      });
      assert.equal(host.registry.has(ref), false);
      assert.equal((await invoke('codex', 'blocked'))[0].errorCode, 'session_implementation_unavailable');
      assert.equal(readPluginConfig(projectRoot, pluginId).connection, savedConnection);
      await host.manager.setEnabled(pluginId, { enabled: true, expectedRevision: (await current()).lifecycleRevision });
      assert.ok(host.registry.has(ref));
      await host.runtime.shutdown('test_restart');
      host = makeHost();
      await host.runtime.recoverAfterRestart();
      await host.runtime.lifecycle.drainRestartRecovery();
      assert.ok(host.registry.has(ref));
      assert.equal(readPluginConfig(projectRoot, pluginId).connection, savedConnection);
      const restarted = await invoke('codex', 'after-restart');
      assert.equal(restarted.at(-1).errorCode, undefined);
      assert.ok(restarted.some((m) => m.type === 'text' && m.content?.includes('current=after-restart')));
      console.log(
        JSON.stringify({
          evidence: 'packed-plugin-host-acp-fixture',
          archiveHash,
          pluginId,
          contributionId,
          assertions: [
            'admission',
            'configuration',
            'independent-sessions',
            'continuation',
            'invalid-save-recovery',
            'disable',
            'reenable',
            'restart',
          ],
          nativeCodeAgent: false,
        }),
      );
    } finally {
      await host?.runtime.shutdown('test_complete');
      await Promise.all([...(host?.pools.values() ?? [])].map((pool) => pool.closeAll()));
      if (originalMode === undefined) delete process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE;
      else process.env.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE = originalMode;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
