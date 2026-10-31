import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import type { CodexAppServerHostLaunch } from '../src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { assertSelectedApiProvider, installAmbientCodexAccount } from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

// Optional pinned-CLI fixture. All credentials are false values; only a loopback server is contacted.
for (const selectedRouting of [{}, { OPENAI_ORGANIZATION: 'org-b', OPENAI_PROJECT: 'project-b' }])
  test(
    `native API provider signs with selected B and selected headers (${Object.keys(selectedRouting).length})`,
    { timeout: 20_000 },
    async (t) => {
      installAmbientCodexAccount(t);
      const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-native-api-')));
      t.after(() => rm(root, { recursive: true, force: true }));
      let launch: CodexAppServerHostLaunch | undefined;
      const pool = new CodexAppServerHostPool(
        { idleTtlMs: 0, maxWarmHosts: 0 },
        {
          createSocketDirectory: () => join(root, 'socket'),
          removeSocketDirectory: async () => {},
          spawnHost: async (options) => {
            launch = options;
            return {
              alive: true,
              get isAlive() {
                return this.alive;
              },
              socketPath: options.socketPath,
              async close() {
                this.alive = false;
              },
            };
          },
          connectHost: async () => new F320AccountWire({}),
        },
      );
      t.after(() => pool.closeAll());
      const service = new CodexAgentService({
        carrierMode: 'app_server',
        appServerHostPool: pool,
        l0CompilerFn: fakeL0Compiler,
      });
      const source = await service.requestNativeCapabilitySource({
        invocationId: 'native-api-fixture',
        cwd: root,
        timeoutMs: 1000,
        account: {
          id: 'selected-b',
          authType: 'api_key',
          apiKey: 'selected-key-b-fixture',
          envVars: { HOME: root, ...selectedRouting },
        },
      });
      assert.equal(source.availability, 'live');
      assert.ok(launch);
      assertSelectedApiProvider(launch, 'https://api.openai.com/v1');
      assert.notEqual(launch.env?.CODEX_HOME, join(root, '.codex'));
      const requests: Array<{ authorization?: string; organization?: string; project?: string }> = [];
      const server = createServer((request, response) => {
        requests.push({
          authorization: request.headers.authorization,
          organization:
            typeof request.headers['openai-organization'] === 'string'
              ? request.headers['openai-organization']
              : undefined,
          project:
            typeof request.headers['openai-project'] === 'string' ? request.headers['openai-project'] : undefined,
        });
        request.resume();
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture stops after observing authentication' } }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      // Substitute only the transport endpoint. Keep the actual producer's provider/key/header configuration.
      const configArgs = launch.args.flatMap((arg, index) =>
        arg === '--config' || arg === '-c' ? [arg, launch.args[index + 1]] : [],
      );
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        ...configArgs,
        '--config',
        `model_providers.custom.base_url="http://127.0.0.1:${address.port}/v1"`,
        '--config',
        'model_providers.custom.request_max_retries=0',
        '--config',
        'features.apps=false',
        '--config',
        'features.hooks=false',
        '--config',
        'hooks={}',
        '--config',
        'mcp_servers={}',
        '-',
      ];
      const env = buildChildEnv(launch.env);
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
      delete env.ALL_PROXY;
      env.NO_PROXY = '127.0.0.1,localhost';
      const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'ignore', 'pipe'] });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 12_000);
      t.after(() => {
        clearTimeout(timeout);
        child.kill();
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdin.end('fixture');
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      clearTimeout(timeout);
      assert.equal(code, 1, stderr);
      assert.ok(requests.length > 0, stderr);
      for (const request of requests) {
        assert.equal(request.authorization, 'Bearer selected-key-b-fixture');
        assert.equal(request.organization, selectedRouting.OPENAI_ORGANIZATION);
        assert.equal(request.project, selectedRouting.OPENAI_PROJECT);
      }
    },
  );
