import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { getResolvedCats } from '../dist/config/resolved-cats.js';
import { createRuntimeCat } from '../dist/config/runtime-cat-catalog.js';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { resolveMemberSessionRef } from '../dist/domains/cats/services/agents/session-contract/plugin-agent-provider.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createPluginManagerRuntimeComposition } from '../dist/domains/plugin/index.js';
import { prepareDshDesktopSetup, readDshDesktopSetup } from '../dist/routes/dsh-desktop-setup.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_DSH_CANDIDATE_ARCHIVE;
const desktop = process.env.CLOWDER_DSH_TEST_DESKTOP_ROOT;
const ref = { pluginId: 'official.agent-dsh', contributionId: 'dsh' };

test(
  'saved DSH Desktop member uses the default catalog grant through resume and cancellation',
  {
    skip: !archive || !desktop,
    timeout: 240_000,
  },
  async (t) => {
    const { desktopVersion } = JSON.parse(
      await readFile(join(desktop, 'resources/runtime/primary-runtime/runtime.json'), 'utf8'),
    );
    assert.ok(['0.2.3-alpha.2', '0.2.2-rc.5'].includes(desktopVersion));
    t.diagnostic('DSH Desktop ' + desktopVersion);

    const registry = new SessionImplementationRegistry();
    const { runtime } = await setup(t, registry);
    const root = runtime.projectRoot;
    const workspace = join(root, 'workspace');
    const nativeHome = join(root, 'fixture-desktop-home');
    const nativeCwd = join(nativeHome, 'profiles', 'desktop');
    const template = join(root, 'cat-template.json');
    await mkdir(nativeCwd, { recursive: true });
    await mkdir(workspace);
    await writeFile(template, JSON.stringify({ version: 1, breeds: [], roleTemplates: [] }));
    for (const [key, value] of [
      ['CAT_CAFE_CONFIG_ROOT', root],
      ['CAT_TEMPLATE_PATH', template],
      ['CAT_CAFE_DATA_DIR', join(root, 'state')],
    ]) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }

    const requests = [];
    const waiting = Promise.withResolvers();
    const disconnected = Promise.withResolvers();
    const model = createServer(async (request, response) => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== 'Bearer isolated-dsh-key') {
        response.writeHead(401).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString('utf8'));
      requests.push(body);
      const turn = requests.length;
      const chunk = { id: 'fixture-' + turn, object: 'chat.completion.chunk', created: 1, model: body.model };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const output = turn === 3 ? 'DSH_CANCEL_PREFIX' : 'DSH_DEFAULT_REPLY_' + turn;
      response.write(
        'data: ' +
          JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }],
          }) +
          '\n\n',
      );
      if (turn === 3) {
        response.once('close', disconnected.resolve);
        waiting.resolve();
        return;
      }
      response.write(
        'data: ' +
          JSON.stringify({
            ...chunk,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise((done) => model.listen(0, '127.0.0.1', done));
    t.after(
      () =>
        new Promise((done) => {
          model.close(done);
          model.closeAllConnections();
        }),
    );
    await writeFile(
      join(nativeCwd, 'package.json'),
      JSON.stringify({
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }),
    );
    await writeFile(
      join(nativeCwd, 'cordis.patch.yml'),
      stringify([
        { id: 'llm-deepseek', disabled: true },
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              fixture: {
                api: 'openai-completions',
                baseURL: 'http://127.0.0.1:' + model.address().port + '/v1',
                apiKeyEnv: 'DSH_DEFAULT_GRANT_FIXTURE',
                models: [{ id: 'selected-model', contextWindow: 131072, maxTokens: 2048 }],
              },
            },
          },
        },
      ]),
    );
    await writeFile(join(nativeHome, '.credentials.yaml'), 'DSH_DEFAULT_GRANT_FIXTURE: isolated-dsh-key\n', {
      mode: 0o600,
    });

    const command = join(desktop, 'resources/runtime/cli/bin/dsh.cmd');
    const source = { command, cwd: root, nativeHome, nativeCwd };
    const inspected = await readDshDesktopSetup(source);
    const prepared = await prepareDshDesktopSetup(source, inspected.view.revision, 'fixture', 'selected-model');

    const bytes = await readFile(archive);
    const entry = {
      catalogId: 'agent-dsh',
      packageName: '@clowder-ai/agent-dsh',
      version: '0.1.0-alpha.1',
      pluginId: ref.pluginId,
      distribution: 'registry',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/agent-dsh/-/agent-dsh-0.1.0-alpha.1.tgz',
      packageDigest: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    };
    const { manager } = createPluginManagerRuntimeComposition({
      runtime,
      catalogManifests: [
        {
          pluginId: ref.pluginId,
          version: entry.version,
          contractVersion: '0.4.0-candidate.0',
          name: 'DeepSeek Harness',
          features: [{ id: 'dsh', name: 'DeepSeek Harness', resources: [] }],
          runtime: { transport: 'builtin', entrypoint: 'src/index.mjs', dataDirectory: 'agent-dsh' },
        },
      ],
      catalogProvider: { snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 0 }) },
      fetchOfficialArchive: async () => bytes,
      threads: { get: () => null },
    });
    await manager.install({
      source: { kind: 'catalog', catalogId: entry.catalogId },
      expectedVersion: entry.version,
      expectedDigest: entry.packageDigest,
    });
    const { plugin } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });

    const catId = 'dsh-fixture';
    createRuntimeCat(root, {
      catId,
      name: 'DSH fixture',
      displayName: 'DSH fixture',
      avatar: '/fixture.png',
      color: { primary: '#123456', secondary: '#abcdef' },
      mentionPatterns: ['@dsh-fixture'],
      roleDescription: 'DSH_DEFAULT_ROLE',
      personality: '',
      clientId: 'acp',
      carrier: 'acp',
      configurationSource: 'native_tool',
      agentProvider: 'plugin:official.agent-dsh/dsh',
      defaultModel: JSON.stringify(['fixture', 'selected-model']),
      mcpSupport: false,
      env: prepared.launch.env,
      acp: { command, startupArgs: prepared.launch.args, transport: 'stdio' },
    });
    const catConfig = getResolvedCats(root)[catId];
    assert.deepEqual(resolveMemberSessionRef(catConfig.agentProvider), ref);
    const binding = freezeExecutionAccountBinding({
      catId,
      catConfig,
      workspace: { workingDirectory: workspace, usesDefaultWorkspace: false },
    });
    assert.equal(binding.executionAccount, undefined);
    const member = new RegisteredSessionAgentService({ catId, ref, registry });
    t.after(() => member.releaseAll('fixture_cleanup'));
    const options = {
      hostSessionId: 'isolated-dsh-member',
      workingDirectory: workspace,
      systemPrompt: 'DSH_DEFAULT_ROLE',
      registeredAcpLaunch: binding.registeredAcpLaunch,
      executionPreferences: binding.executionPreferences,
      signal: t.signal,
    };
    const invoke = (prompt, invocationId, extra = {}) =>
      Array.fromAsync(member.invoke(prompt, { ...options, invocationId, ...extra }));
    const assertTurn = (events, reply) => {
      assert.equal(events.at(-1)?.errorCode, undefined, events.find(({ type }) => type === 'error')?.error);
      assert.ok(
        events
          .filter(({ type }) => type === 'text')
          .map(({ content }) => content)
          .join('')
          .includes(reply),
      );
      return events.at(-1)?.metadata?.sessionId;
    };
    const first = await invoke('DSH_DEFAULT_FIRST', 'first');
    const nativeId = assertTurn(first, 'DSH_DEFAULT_REPLY_1');
    assert.ok(nativeId);
    await member.releaseAll('first_reopen');
    const resumed = await invoke('DSH_DEFAULT_RESUMED', 'resumed', { sessionId: nativeId });
    assert.equal(assertTurn(resumed, 'DSH_DEFAULT_REPLY_2'), nativeId);
    assert.match(JSON.stringify(requests[1].messages), /DSH_DEFAULT_FIRST/);
    assert.match(JSON.stringify(requests[1].messages), /DSH_DEFAULT_REPLY_1/);

    const cancel = new AbortController();
    const inFlight = invoke('DSH_DEFAULT_CANCELLED', 'cancelled', { sessionId: nativeId, signal: cancel.signal });
    await Promise.race([waiting.promise, inFlight.then(() => assert.fail('DSH did not reach the held model request'))]);
    assert.equal(requests.length, 3);
    cancel.abort();
    const stopped = await inFlight;
    assert.deepEqual(
      stopped.filter(({ type }) => type === 'done').map(({ errorCode }) => errorCode),
      ['cancelled'],
    );
    await Promise.race([
      disconnected.promise,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Cancelled DSH model request did not close')), 8_000);
        timer.unref();
      }),
    ]);
    const next = await invoke('DSH_DEFAULT_AFTER_CANCEL', 'after-cancel', { sessionId: nativeId });
    assert.equal(assertTurn(next, 'DSH_DEFAULT_REPLY_4'), nativeId);
    assert.equal(requests.length, 4);
    for (const body of requests) {
      assert.equal(body.model, 'selected-model');
      assert.match(JSON.stringify(body.messages.filter(({ role }) => role === 'system')), /DSH_DEFAULT_ROLE/);
      assert.doesNotMatch(JSON.stringify(body.messages.filter(({ role }) => role === 'user')), /DSH_DEFAULT_ROLE/);
    }
    await member.releaseAll('done');
    const beforeUninstall = (await manager.get(ref.pluginId)).plugin;
    await manager.uninstall(ref.pluginId, { expectedRevision: beforeUninstall.lifecycleRevision });
    const retired = await runtime.inventoryStore.readAuthority(beforeUninstall.pluginInstanceId);
    assert.equal(retired?.instance.lifecycleState, 'retired');
    assert.equal(registry.has(ref), false);
    assert.equal(getResolvedCats(root)[catId]?.agentProvider, 'plugin:official.agent-dsh/dsh');
    const unavailable = await invoke('Must not run after uninstall', 'uninstalled', { sessionId: nativeId });
    assert.equal(unavailable.at(-1)?.errorCode, 'session_implementation_unavailable');
    assert.equal(requests.length, 4);
    t.diagnostic(
      JSON.stringify({
        desktopVersion,
        nativeId,
        modelRequests: requests.length,
        cancelled: true,
        resumedAfterCancel: true,
        managerUninstall: 'retired',
      }),
    );
  },
);
