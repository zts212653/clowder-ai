import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import {
  assertSelectedApiAccount,
  assertSelectedApiProvider,
  installAmbientCodexAccount,
} from './helpers/f320-auth-environment.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

test('API fixture owns a temporary data root independently of the outer wrapper', async (t) => {
  const inherited = await realpath(await mkdtemp(join(tmpdir(), 'f320-external-data-')));
  const previous = process.env.CAT_CAFE_DATA_DIR;
  const cleanups: Array<() => void> = [];
  t.after(() => rm(inherited, { recursive: true, force: true }));
  process.env.CAT_CAFE_DATA_DIR = inherited;
  try {
    installAmbientCodexAccount({ after: (cleanup: () => void) => cleanups.push(cleanup) });
    assert.notEqual(process.env.CAT_CAFE_DATA_DIR, inherited, 'fixture must not use the inherited data root');
    assert.ok(process.env.CAT_CAFE_DATA_DIR?.includes('f320-account-data-'));
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    if (previous === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previous;
  }
});

for (const carrier of ['direct', 'pooled'] as const)
  for (const custom of [false, true])
    for (const selectedRouting of [
      {},
      { OPENAI_ORGANIZATION: 'org-b', OPENAI_PROJECT: 'project-b', OPENAI_ORG_ID: 'org-b-legacy' },
    ])
      test(`API ${carrier} main call keeps selected routing only (custom=${custom}, selectedRouting=${Object.keys(selectedRouting).length})`, async (t) => {
        installAmbientCodexAccount(t);
        const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-api-auth-')));
        t.after(() => rm(root, { recursive: true, force: true }));
        const account = {
          id: 'selected-b',
          authType: 'api_key' as const,
          envVars: { HOME: root, CODEX_HOME: join(root, 'credential-home'), ...selectedRouting },
        };
        const descriptor = resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } });
        const baseUrl = custom ? 'http://127.0.0.1:1' : 'https://api.openai.com/v1';
        let launches = 0;
        const pool = new CodexAppServerHostPool(
          { idleTtlMs: 0, maxWarmHosts: 0 },
          {
            createSocketDirectory: () => join(root, 'socket'),
            removeSocketDirectory: async () => {},
            spawnHost: async (launch) => {
              launches++;
              assertSelectedApiAccount(buildChildEnv(launch.env), 'selected-key-fixture', selectedRouting);
              assertSelectedApiProvider(launch, baseUrl);
              assert.notEqual(launch.env.CODEX_HOME, descriptor.credentialHome);
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
        t.after(() => pool.closeAll());
        const service = new CodexAgentService({
          carrierMode: 'app_server',
          ...(carrier === 'pooled' ? { appServerHostPool: pool } : {}),
          cliCommand: process.execPath,
          l0CompilerFn: fakeL0Compiler,
          rawArchive: { append: async () => {} },
        });
        const events = [];
        for await (const event of service.invoke('fixture', {
          workingDirectory: root,
          invocationId: 'api-fixture-invoke',
          codexAccountLaunch: descriptor,
          accountEnv: account.envVars,
          callbackEnv: {
            CODEX_AUTH_MODE: 'api_key',
            OPENAI_API_KEY: 'selected-key-fixture',
            ...(custom ? { OPENAI_BASE_URL: 'http://127.0.0.1:1' } : {}),
            CAT_CAFE_API_URL: 'http://127.0.0.1:1',
            CAT_CAFE_INVOCATION_ID: 'api-fixture-invoke',
            CAT_CAFE_CALLBACK_TOKEN: 'callback-fixture',
            CAT_CAFE_USER_ID: 'fixture-user',
            CAT_CAFE_CAT_ID: 'codex',
            CAT_CAFE_THREAD_ID: 'fixture-thread',
          },
          ...(carrier === 'direct'
            ? {
                agentCarrierSessionFactory: async (options) => {
                  launches++;
                  assertSelectedApiAccount(buildChildEnv(options.env), 'selected-key-fixture', selectedRouting);
                  assertSelectedApiProvider(options, baseUrl);
                  assert.notEqual(options.env.CODEX_HOME, descriptor.credentialHome);
                  return new F320AccountWire({});
                },
              }
            : {}),
        }))
          events.push(event);
        assert.equal(launches, 1, JSON.stringify(events.filter((event) => event.type === 'error')));
        assert.deepEqual(
          events.filter((event) => event.type === 'error'),
          [],
        );
        assert.ok(events.some((event) => event.type === 'done'));
      });
