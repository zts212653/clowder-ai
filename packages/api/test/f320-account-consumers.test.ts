import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveCodexAccountLaunch, resolveCodexApiExecutionHome } from '../src/config/codex-account-launch.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import type { CodexAppServerHostProcess } from '../src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { rememberCodexAppServerControlOptions } from '../src/domains/cats/services/agents/providers/codex-app-server-control-options.js';
import type { AgentCarrierSessionOptions } from '../src/domains/cats/services/types.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import {
  assertSelectedApiAccount,
  assertSelectedApiProvider,
  installAmbientCodexAccount,
} from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const originalHome = process.env.CODEX_HOME;
const originalSqlite = process.env.CODEX_SQLITE_HOME;
delete process.env.CODEX_HOME;
delete process.env.CODEX_SQLITE_HOME;
after(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (originalSqlite === undefined) delete process.env.CODEX_SQLITE_HOME;
  else process.env.CODEX_SQLITE_HOME = originalSqlite;
});

for (const explicit of [false, true])
  for (const custom of [false, true])
    for (const selectedRouting of [
      {},
      { OPENAI_ORGANIZATION: 'org-b', OPENAI_PROJECT: 'project-b', OPENAI_ORG_ID: 'org-b-legacy' },
    ])
      test(`API/custom actual probe and invocation share a stable isolated home (explicit=${explicit}, custom=${custom}, selectedRouting=${Object.keys(selectedRouting).length})`, async (t) => {
        installAmbientCodexAccount(t);
        const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-api-consumer-')));
        t.after(() => rm(root, { recursive: true, force: true }));
        const account = {
          id: 'api-fixture',
          authType: 'api_key' as const,
          ...(custom ? { baseUrl: 'http://127.0.0.1:1' } : {}),
          apiKey: 'never-used-fixture',
          envVars: {
            HOME: root,
            ...selectedRouting,
            ...(explicit ? { CODEX_HOME: join(root, 'explicit') } : {}),
          },
        };
        const descriptor = resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } });
        const baseUrl = account.baseUrl ?? 'https://api.openai.com/v1';
        const expectedHome = resolveCodexApiExecutionHome(descriptor, baseUrl, root, { HOME: root });
        assert.equal(existsSync(expectedHome), false, 'execution-home preparation is read-only');
        const rotatedAccount = { ...account, apiKey: 'rotated-fixture', displayName: 'renamed' };
        const rotated = resolveCodexAccountLaunch(rotatedAccount, { cwd: root, env: { HOME: root } });
        assert.equal(resolveCodexApiExecutionHome(rotated, baseUrl, root, { HOME: root }), expectedHome);
        const other = resolveCodexAccountLaunch(
          { ...account, id: 'other-account' },
          { cwd: root, env: { HOME: root } },
        );
        assert.notEqual(resolveCodexApiExecutionHome(other, baseUrl, root, { HOME: root }), expectedHome);
        assert.notEqual(
          resolveCodexApiExecutionHome(descriptor, 'http://127.0.0.1:2', root, { HOME: root }),
          expectedHome,
        );
        const homes: string[] = [];
        const pool = new CodexAppServerHostPool(
          { idleTtlMs: 0, maxWarmHosts: 0 },
          {
            createSocketDirectory: () => join(root, 'socket'),
            removeSocketDirectory: async () => {},
            spawnHost: async (launch) => {
              assertSelectedApiAccount(buildChildEnv(launch.env), account.apiKey, selectedRouting);
              assertSelectedApiProvider(launch, baseUrl);
              const home = launch.env?.CODEX_HOME;
              assert.equal(typeof home, 'string');
              assert.ok(existsSync(home!), 'actual spawn receives an existing explicit home');
              if (process.platform !== 'win32') assert.equal(statSync(home!).mode & 0o777, 0o700);
              homes.push(home!);
              return {
                alive: true,
                get isAlive() {
                  return this.alive;
                },
                socketPath: launch.socketPath,
                async close() {
                  this.alive = false;
                },
              };
            },
            connectHost: async () => new F320AccountWire({}),
          },
        );
        // This probe uses the actual F306 service entry, not the withdrawn B launch builder.
        const service = new CodexAgentService({
          carrierMode: 'app_server',
          appServerHostPool: pool,
          cliCommand: process.execPath,
          l0CompilerFn: fakeL0Compiler,
          rawArchive: { append: async () => {} },
        });
        for (let n = 0; n < 2; n++) {
          const source = await service.requestNativeCapabilitySource({
            invocationId: `probe-${n}`,
            cwd: root,
            timeoutMs: 1000,
            account,
          });
          assert.equal(source.availability, 'live');
        }
        for await (const event of service.invoke('fixture', {
          workingDirectory: root,
          invocationId: 'invoke',
          codexAccountLaunch: descriptor,
          accountEnv: account.envVars,
          callbackEnv: {
            CODEX_AUTH_MODE: 'api_key',
            OPENAI_API_KEY: account.apiKey,
            ...(account.baseUrl ? { OPENAI_BASE_URL: account.baseUrl } : {}),
          },
          agentCarrierSessionFactory: async (options) => {
            assertSelectedApiAccount(buildChildEnv(options.env), account.apiKey, selectedRouting);
            assertSelectedApiProvider(options, baseUrl);
            homes.push(options.env!.CODEX_HOME!);
            return new F320AccountWire({});
          },
        }))
          assert.notEqual(event.type, 'error', event.error);
        assert.equal(homes.length, 3);
        assert.equal(new Set(homes).size, 1, 'probe and invocation consume the same execution root');
        assert.equal(homes[0], expectedHome);
        assert.notEqual(homes[0], descriptor.credentialHome, 'API/custom must not read the OAuth credential home');
      });

const controls = ['compaction', 'goal', 'review', 'status', 'fork', 'attachment'] as const;
for (const lifecycle of ['fresh', 'warm', 'recreated'] as const)
  for (const control of controls)
    for (const conflict of [false, true])
      test(`${control} ${lifecycle} connection validates the original snapshot before business (conflict=${conflict})`, async (t) => {
        const home = await realpath(await mkdtemp(join(tmpdir(), 'f320-control-consumer-')));
        t.after(() => rm(home, { recursive: true, force: true }));
        await mkdir(join(home, 'other'));
        const wires: F320AccountWire[] = [];
        const hosts: Array<CodexAppServerHostProcess & { alive: boolean }> = [];
        const pool = new CodexAppServerHostPool(
          { idleTtlMs: 60_000, maxWarmHosts: 2 },
          {
            createSocketDirectory: () => join(home, `socket-${hosts.length}`),
            removeSocketDirectory: async () => {},
            spawnHost: async (launch) => {
              assert.equal(launch.env?.CODEX_HOME, home, 'reconstruction retains the original account');
              const host = {
                alive: true,
                get isAlive() {
                  return this.alive;
                },
                socketPath: launch.socketPath,
                async close() {
                  this.alive = false;
                },
              };
              hosts.push(host);
              return host;
            },
            connectHost: async () => {
              const wire = new F320AccountWire(
                { model_provider: 'openai', sqlite_home: conflict ? join(home, 'other') : home },
                true,
              );
              wires.push(wire);
              return wire;
            },
          },
        );
        t.after(() => pool.closeAll());
        const options: AgentCarrierSessionOptions = {
          command: process.execPath,
          args: ['app-server', '--stdio'],
          cwd: home,
          invocationId: 'seed',
          env: { CODEX_HOME: home, CODEX_SQLITE_HOME: home, CODEX_AUTH_MODE: 'oauth' },
        };
        rememberCodexAppServerControlOptions(pool, 'fixture-thread', options);
        if (lifecycle !== 'fresh') {
          const seed = await pool.createSession({ ...options, sessionId: 'fixture-thread' });
          await seed.close();
          if (lifecycle === 'recreated') hosts[0].alive = false;
        }
        options.env!.CODEX_HOME = join(home, 'other');
        options.env!.CODEX_SQLITE_HOME = join(home, 'other');
        const service = new CodexAgentService({
          carrierMode: 'app_server',
          appServerHostPool: pool,
          l0CompilerFn: fakeL0Compiler,
        });
        const input = { sessionId: 'fixture-thread', invocationId: 'control', timeoutMs: 1000 };
        const run = () => {
          switch (control) {
            case 'compaction':
              return service.requestNativeCompaction(input);
            case 'goal':
              return service.requestNativeGoal({ ...input, request: { action: 'get' } });
            case 'review':
              return service.requestNativeReview({
                ...input,
                request: { target: { kind: 'uncommitted_changes' }, delivery: 'inline' },
              });
            case 'status':
              return service.requestNativeStatus(input);
            case 'fork':
              return service.requestNativeFork(input);
            case 'attachment':
              return service.openNativeRealtimeCompanion({
                ...input,
                consumer: 'watch_video',
                startupTimeoutMs: 1000,
                maxDurationMs: 1000,
              });
          }
        };
        if (conflict) await assert.rejects(run, /configuration_conflict:sqlite_home/);
        else await run().catch((error: Error) => assert.match(error.message, /fixture_business_reached/));
        const wire = wires.at(-1)!;
        const methods = wire.writes.map((message) => message.method);
        assert.deepEqual(methods.slice(0, 5), [
          'initialize',
          'initialized',
          'config/read',
          'configRequirements/read',
          'account/read',
        ]);
        assert.equal(methods.includes('thread/resume'), !conflict);
        assert.equal(wire.closed, true, 'only the control connection is released');
        if (conflict) assert.equal(methods.length, 5, 'no business RPC after a conflicting observation');
        assert.equal(hosts.length, lifecycle === 'recreated' ? 2 : 1);
      });

test('a rejected attachment releases its connection without closing the active parent lease', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'f320-attached-account-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const wires: F320AccountWire[] = [];
  const host = {
    alive: true,
    get isAlive() {
      return this.alive;
    },
    socketPath: join(home, 'sock'),
    async close() {
      this.alive = false;
    },
  };
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 60_000, maxWarmHosts: 1 },
    {
      createSocketDirectory: () => home,
      removeSocketDirectory: async () => {},
      spawnHost: async () => host,
      connectHost: async () => {
        const wire = new F320AccountWire({ sqlite_home: join(home, 'wrong') });
        wires.push(wire);
        return wire;
      },
    },
  );
  t.after(() => pool.closeAll());
  const options = {
    command: process.execPath,
    args: ['app-server', '--stdio'],
    cwd: home,
    invocationId: 'parent',
    sessionId: 'fixture-thread',
    env: { CODEX_AUTH_MODE: 'oauth', CODEX_HOME: home, CODEX_SQLITE_HOME: home },
  };
  rememberCodexAppServerControlOptions(pool, 'fixture-thread', options);
  const parent = await pool.createSession(options);
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    l0CompilerFn: fakeL0Compiler,
  });
  await assert.rejects(
    service.openNativeRealtimeCompanion({
      sessionId: 'fixture-thread',
      invocationId: 'attachment',
      consumer: 'watch_video',
      startupTimeoutMs: 1000,
      maxDurationMs: 1000,
    }),
    /configuration_conflict:sqlite_home/,
  );
  assert.equal(wires[0].closed, false);
  assert.equal(wires[1].closed, true);
  assert.equal(host.isAlive, true);
  assert.equal(pool.getMetrics().activeLeaseCount, 1);
  await parent.close();
});
