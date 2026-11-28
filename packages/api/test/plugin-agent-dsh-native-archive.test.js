import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, isAbsolute, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { createAgentAdapterAcpRuntime } from '../dist/domains/plugin/declared/agent-adapter-native/agent-adapter-acp-runtime.js';
import { setup } from './helpers/agent-adapter-archive.js';

const archive = process.env.CLOWDER_DSH_CANDIDATE_ARCHIVE;
const desktop = process.env.CLOWDER_DSH_TEST_DESKTOP_ROOT;

test(
  'installed DSH adapter preserves native history and replaces system identity after relaunch',
  {
    skip: !archive || !desktop,
    timeout: 180_000,
  },
  async (t) => {
    assert.ok(isAbsolute(archive) && isAbsolute(desktop));
    const executable = join(desktop, 'DeepSeek Harness.exe');
    const cli = join(desktop, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    const { desktopVersion } = JSON.parse(
      await readFile(join(desktop, 'resources/runtime/primary-runtime/runtime.json'), 'utf8'),
    );
    assert.ok(['0.2.2-rc.5', '0.2.3-alpha.2'].includes(desktopVersion));
    const requests = [];
    const model = createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url.endsWith('/messages')) {
        res.writeHead(404).end();
        return;
      }
      const chunks = await Array.fromAsync(req);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ system: body.system, messages: body.messages });
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'local-dsh-fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: `DSH_LOOPBACK_REPLY_${requests.length}` },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    await new Promise((listening) => model.listen(0, '127.0.0.1', listening));
    t.after(
      () =>
        new Promise((closed) => {
          model.close(closed);
          model.closeAllConnections();
        }),
    );
    const modelUrl = `http://127.0.0.1:${model.address().port}`;
    const registry = new SessionImplementationRegistry();
    const ref = { pluginId: 'official.agent-dsh', contributionId: 'dsh' };
    let digest;
    let acp;
    let launchCount = 0;
    const clients = [];
    const { runtime, manager } = await setup(t, registry, (request) => {
      if (
        !digest ||
        request.packageDigest !== digest ||
        request.pluginId !== ref.pluginId ||
        request.contributionId !== ref.contributionId
      )
        return;
      if (request.action === 'detect') return { inspect: async () => ({ status: 'ready', version: desktopVersion }) };
      if (request.action === 'describe') return;
      assert.equal(request.hostSession?.cwd, root);
      assert.equal(request.catId, 'fixture');
      acp ??= createAgentAdapterAcpRuntime(async ({ startup }, signal) => {
        const modulePath = await realpath(fileURLToPath(startup.moduleUrl));
        const fromPackage = relative(await realpath(runtime.paths.packagesRoot), modulePath);
        assert.ok(fromPackage && !isAbsolute(fromPackage) && !fromPackage.startsWith('..'));
        assert.equal(basename(modulePath), 'dsh-l0-series.mjs');
        assert.match(startup.config.body, /^DSH_ROLE_[AB]_FIXTURE$/);
        assert.equal(
          startup.config.marker,
          `<!-- clowder-l0:${createHash('sha256').update(startup.config.body).digest('hex')} -->`,
        );
        const identity = join(root, `identity-${++launchCount}.patch.json`);
        await writeFile(
          identity,
          JSON.stringify([{ insert: [{ id: 'clowder-l0-series', name: startup.moduleUrl, config: startup.config }] }]),
          { flag: 'wx', mode: 0o600 },
        );
        const client = new AcpClient({
          command: executable,
          args: [],
          cwd: root,
          // Desktop took 27 seconds to exit normally after EOF on the Windows test machine.
          stdinShutdownGraceMs: 45_000,
          preparedSpawn: {
            command: executable,
            args: ['--expose-internals', cli, '--profile', 'acp', '--patch', provider, '--patch', identity],
          },
          preparedEnv: {
            ...env,
            DEEPSEEK_API_KEY: 'fixture-only',
            DEEPSEEK_BASE_URL: modelUrl,
          },
        });
        clients.push(client);
        try {
          signal.throwIfAborted();
          await client.initialize();
          return { client, cwd: root };
        } catch (error) {
          await client.close();
          throw error;
        } finally {
          await unlink(identity);
        }
      }, request.activationSignal);
      return { acp };
    });
    const root = runtime.projectRoot;
    const home = join(root, 'dsh');
    await mkdir(home);
    const provider = join(root, 'provider.patch.json');
    await writeFile(
      provider,
      JSON.stringify([
        { id: 'llm-deepseek', config: { baseURL: modelUrl, apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled' } },
      ]),
    );
    const env = {
      ...Object.fromEntries(
        ['SystemRoot', 'WINDIR', 'ComSpec', 'Path', 'PATHEXT', 'SystemDrive', 'OS', 'ProgramFiles']
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
      ELECTRON_RUN_AS_NODE: '1',
      DSH_TELEMETRY_DISABLED: '1',
      HOME: home,
      USERPROFILE: home,
      DSH_HOME: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      TEMP: home,
      TMP: home,
      NO_PROXY: '127.0.0.1,localhost',
    };

    await manager.install({ source: { kind: 'local-archive', path: archive } });
    const { plugin } = await manager.get(ref.pluginId);
    digest = plugin.packageDigest;
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    assert.equal((await runtime.agentAdapters.detect(ref)).candidates[0].state.version, desktopVersion);
    assert.equal((await runtime.agentAdapters.describe(ref)).capabilities.quota.status, 'unsupported');

    const service = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const options = { hostSessionId: 'dsh-host', workingDirectory: root };
    const first = await Array.fromAsync(
      service.invoke('DSH_FIRST_FIXTURE', {
        ...options,
        invocationId: 'first',
        systemPrompt: 'DSH_ROLE_A_FIXTURE',
      }),
    );
    assert.equal(
      first.find((event) => event.type === 'text')?.content,
      'DSH_LOOPBACK_REPLY_1',
      first.find((event) => event.type === 'error')?.error,
    );
    const nativeId = first.at(-1)?.metadata.sessionId;
    assert.ok(nativeId);
    const warm = await Array.fromAsync(
      service.invoke('DSH_WARM_FIXTURE', {
        ...options,
        invocationId: 'warm',
        systemPrompt: 'DSH_ROLE_A_FIXTURE',
        sessionId: nativeId,
      }),
    );
    assert.equal(warm.find((event) => event.type === 'text')?.content, 'DSH_LOOPBACK_REPLY_2');
    assert.equal(warm.at(-1)?.metadata.sessionId, nativeId);
    assert.equal(launchCount, 1);
    await service.releaseAll('reopen');
    assert.equal(clients[0].hasExited, true);
    await clients[0].close();
    const second = await Array.fromAsync(
      service.invoke('DSH_SECOND_FIXTURE', {
        ...options,
        invocationId: 'second',
        systemPrompt: 'DSH_ROLE_B_FIXTURE',
        sessionId: nativeId,
        requireExactResume: true,
      }),
    );
    await service.releaseAll('test_complete');
    assert.equal(clients[1]?.hasExited, true, 'restarted DSH process must exit before fixture cleanup');
    await clients[1].close();
    assert.equal(
      second.find((event) => event.type === 'text')?.content,
      'DSH_LOOPBACK_REPLY_3',
      second.find((event) => event.type === 'error')?.error,
    );
    assert.equal(second.at(-1)?.metadata.sessionId, nativeId);
    assert.equal(launchCount, 2);
    assert.equal(requests.length, 3);
    assert.match(JSON.stringify(requests[0].system), /DSH_ROLE_A_FIXTURE/);
    assert.match(JSON.stringify(requests[1].system), /DSH_ROLE_A_FIXTURE/);
    assert.match(JSON.stringify(requests[2].system), /DSH_ROLE_B_FIXTURE/);
    assert.doesNotMatch(JSON.stringify(requests[2].system), /DSH_ROLE_A_FIXTURE/);
    assert.doesNotMatch(JSON.stringify(requests[2].messages), /DSH_ROLE_[AB]_FIXTURE/);
    assert.match(JSON.stringify(requests[2].messages), /DSH_FIRST_FIXTURE/);
    assert.match(JSON.stringify(requests[2].messages), /DSH_LOOPBACK_REPLY_1/);
    assert.match(JSON.stringify(requests[2].messages), /DSH_WARM_FIXTURE/);
    assert.match(JSON.stringify(requests[2].messages), /DSH_SECOND_FIXTURE/);
    t.diagnostic(`Verified installed DSH ${desktopVersion} with live ACP stdio and a loopback model.`);
  },
);
