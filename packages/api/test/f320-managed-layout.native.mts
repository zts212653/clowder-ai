import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexManagedLayout, validateCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { runCodexAppServerInitializedRpc } from '../src/domains/cats/services/agents/providers/CodexAppServerNativeRpc.js';
import { bindCodexAccountConfiguration } from '../src/domains/cats/services/agents/providers/codex-app-server-account-configuration.js';
import { scanAndPublishCodexImages } from '../src/domains/cats/services/agents/providers/codex-image-scanner.js';
import { startLayoutModel } from './helpers/f320-layout-model.mjs';
import { startLayoutHost, waitUntil } from './helpers/f320-layout-rpc.mjs';

test(
  'production managed layout preserves config writer, compacted history, locks and image consumer across A-B-coldA',
  { timeout: 60000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-managed-native-')));
    const state = join(root, 'state');
    mkdirSync(state);
    const model = await startLayoutModel({ replyText: 'F320_COMPACTED_LOCAL_LAYOUT_SENTINEL' });
    const hosts: Awaited<ReturnType<typeof startLayoutHost>>[] = [];
    try {
      const config = `cli_auth_credentials_store="file"\nmodel="fixture"\nmodel_provider="fixture"\n[features]\nplugins=false\napps=false\nrespect_system_proxy=false\nsystem_proxy_fallback=false\nenable_request_compression=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(model.url)}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`;
      writeFileSync(join(state, 'config.toml'), config);
      const a = prepareCodexManagedLayout({
        kind: 'managed',
        layoutVersion: 1,
        prepared: false,
        credentialHome: join(root, 'a', 'home'),
        stateRoot: state,
        sqliteHome: state,
      });
      const b = prepareCodexManagedLayout({ ...a, credentialHome: join(root, 'b', 'home'), prepared: false });
      mkdirSync(join(a.credentialHome, '.tmp'));
      mkdirSync(join(b.credentialHome, '.tmp'));
      assert.notEqual(realpathSync(join(a.credentialHome, '.tmp')), realpathSync(join(b.credentialHome, '.tmp')));
      writeFileSync(join(state, 'AGENTS.md'), 'F320_SHARED_INSTRUCTIONS\n');
      assert.equal(readFileSync(join(b.credentialHome, 'AGENTS.md'), 'utf8'), 'F320_SHARED_INSTRUCTIONS\n');
      const launch = async (home: string, name: string) => {
        const host = await startLayoutHost('codex', home, state, root, name);
        hosts.push(host);
        return host;
      };
      const hostA = await launch(a.credentialHome, 'A');
      const hostB = await launch(b.credentialHome, 'B');
      const nativeConfig = {
        cwd: root,
        model: 'fixture',
        modelProvider: 'fixture',
        approvalPolicy: 'never',
        sandbox: 'read-only',
      };
      const started = await hostA.rpc('thread/start', nativeConfig);
      const id = started.thread.id;
      await hostA.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'LOCAL_LAYOUT_SENTINEL' }] });
      await waitUntil(() => hostA.events.some((event) => event.method === 'turn/completed'));
      await assert.rejects(hostB.rpc('thread/resume', { ...nativeConfig, threadId: id }), /writer|WouldBlock/i);
      await hostA.rpc('thread/compact/start', { threadId: id });
      await waitUntil(() =>
        hostA.events.some(
          (event) => event.method === 'item/completed' && event.params?.item?.type === 'contextCompaction',
        ),
      );
      await hostA.rpc('config/value/write', {
        keyPath: 'model_reasoning_effort',
        value: 'low',
        mergeStrategy: 'replace',
      });
      assert.equal(
        readFileSync(join(a.credentialHome, 'config.toml'), 'utf8'),
        readFileSync(join(b.credentialHome, 'config.toml'), 'utf8'),
      );
      assert.ok(lstatSync(join(a.credentialHome, 'config.toml')).isSymbolicLink());
      await hostA.stop();
      await hostB.rpc('thread/resume', { ...nativeConfig, threadId: id });
      const history = await hostB.rpc('thread/read', { threadId: id, includeTurns: true });
      assert.match(JSON.stringify(history), /LOCAL_LAYOUT_SENTINEL/);
      await hostB.rpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'CONTINUE_FROM_B' }] });
      await waitUntil(() => hostB.events.some((event) => event.method === 'turn/completed'));
      await hostB.rpc('thread/archive', { threadId: id });
      await hostB.rpc('thread/unarchive', { threadId: id });
      await hostB.stop();
      const coldA = await launch(a.credentialHome, 'coldA');
      await coldA.rpc('thread/resume', { ...nativeConfig, threadId: id });
      assert.match(
        JSON.stringify(await coldA.rpc('thread/read', { threadId: id, includeTurns: true })),
        /CONTINUE_FROM_B/,
      );
      // Pinned image-generation artifact root; no remote image model or real account is invoked.
      mkdirSync(join(a.credentialHome, 'generated_images', id), { recursive: true });
      writeFileSync(
        join(a.credentialHome, 'generated_images', id, 'fixture.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/K9sAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      const published = await scanAndPublishCodexImages({
        codexSessionId: id,
        codexHome: b.credentialHome,
        uploadDir: join(root, 'uploads'),
      });
      assert.equal(published.length, 1);
      assert.ok(!lstatSync(join(a.credentialHome, '.tmp')).isSymbolicLink());
      validateCodexManagedLayout(a);
      validateCodexManagedLayout(b);
    } finally {
      await Promise.allSettled(hosts.map((host) => host.stop()));
      await model.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  'real native pool retires a warm account owner and resumes the same ordinary/compacted thread on B and A',
  { timeout: 60000 },
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-pool-switch-')));
    const state = join(root, 'state');
    mkdirSync(state);
    const model = await startLayoutModel({ replyText: 'F320_WARM_POOL_SENTINEL' });
    const pool = new CodexAppServerHostPool({ idleTtlMs: 60000, maxWarmHosts: 2 });
    let sessionId: string | undefined;
    try {
      writeFileSync(
        join(state, 'config.toml'),
        `cli_auth_credentials_store="file"\nmodel="fixture"\nmodel_provider="fixture"\n[features]\nplugins=false\napps=false\nrespect_system_proxy=false\nsystem_proxy_fallback=false\nenable_request_compression=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(model.url)}\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n`,
      );
      const a = prepareCodexManagedLayout({
        kind: 'managed',
        layoutVersion: 1,
        prepared: false,
        credentialHome: join(root, 'a/home'),
        stateRoot: state,
        sqliteHome: state,
      });
      const b = prepareCodexManagedLayout({ ...a, credentialHome: join(root, 'b/home'), prepared: false });
      for (const [index, layout] of [a, b, a].entries()) {
        const options = {
          command: 'codex',
          args: ['app-server', '--stdio', '-c', `sqlite_home=${JSON.stringify(state)}`],
          cwd: root,
          invocationId: `f320-pool-${index}`,
          ...(sessionId ? { sessionId } : {}),
          env: {
            HOME: layout.credentialHome,
            CODEX_HOME: layout.credentialHome,
            CODEX_SQLITE_HOME: state,
            CODEX_AUTH_MODE: 'auto',
            NODE_OPTIONS: null,
            HTTP_PROXY: 'http://127.0.0.1:1',
            HTTPS_PROXY: 'http://127.0.0.1:1',
            NO_PROXY: 'localhost,127.0.0.1',
          },
        };
        const wire = bindCodexAccountConfiguration(await pool.createSession(options), options);
        const notifications: Array<Record<string, unknown>> = [];
        await runCodexAppServerInitializedRpc({
          wire,
          timeoutMs: 20000,
          capabilities: { experimentalApi: true },
          onNotification: (message) => {
            notifications.push(message);
          },
          run: async (client) => {
            const params = {
              cwd: root,
              model: 'fixture',
              modelProvider: 'fixture',
              approvalPolicy: 'never',
              sandbox: 'read-only',
            };
            const result = (await client.request(sessionId ? 'thread/resume' : 'thread/start', {
              ...params,
              ...(sessionId ? { threadId: sessionId } : {}),
            })) as { thread: { id: string } };
            if (sessionId) assert.equal(result.thread.id, sessionId);
            sessionId = result.thread.id;
            wire.rememberSession?.(sessionId);
            await client.request('turn/start', {
              threadId: sessionId,
              input: [{ type: 'text', text: `F320_FROM_${index}` }],
            });
            await waitUntil(() => notifications.some((event) => event.method === 'turn/completed'));
            if (index === 1) {
              await client.request('thread/compact/start', { threadId: sessionId });
              await waitUntil(() =>
                notifications.some(
                  (event) =>
                    event.method === 'item/completed' &&
                    (event.params as { item?: { type?: string } })?.item?.type === 'contextCompaction',
                ),
              );
            }
            const history = await client.request('thread/read', { threadId: sessionId, includeTurns: true });
            assert.match(JSON.stringify(history), /F320_FROM_0|F320_WARM_POOL_SENTINEL/);
          },
        });
        assert.equal(
          pool.getMetrics().warmHostCount,
          1,
          'the fixture keeps the previous native process warm before switching',
        );
      }
      assert.equal(pool.getMetrics().activeLeaseCount, 0);
    } finally {
      await pool.closeAll();
      await model.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
