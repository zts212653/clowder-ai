import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { codexManagedLaunchArgs } from '../src/config/codex-managed-launch.js';
import { assertCodexSharedStateRoots } from '../src/config/codex-shared-state.js';
import { invokeSingleCat } from '../src/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { prepareCodexHostLaunch } from '../src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { rememberCodexAppServerControlOptions } from '../src/domains/cats/services/agents/providers/codex-app-server-control-options.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { ownedManagedFixture } from './helpers/f320-owned-account.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

test('final managed environment reads the canonical owner, not an external cwd without a global override', () => {
  const f = ownedManagedFixture();
  try {
    assert.doesNotThrow(() => assertCodexSharedStateRoots(f.owner, { launch: f.launch }));
    const env = finalizeCodexAccountEnvironment(f.launch, {
      cwd: f.external,
      env: {},
      args: codexManagedLaunchArgs(f.launch, []),
    });
    assert.equal(env.CODEX_HOME, f.layout.credentialHome);
    assert.equal(env.CODEX_SQLITE_HOME, f.state);
  } finally {
    f.close();
  }
});

test('actual external-thread invocation consumes managed B from the runtime catalog', async () => {
  const f = ownedManagedFixture();
  try {
    // This invocation declares a persistent capability owner; absence is an
    // unreadable source, not an empty MCP policy. Give the account fixture one.
    mkdirSync(join(f.owner, '.cat-cafe'), { recursive: true });
    writeFileSync(join(f.owner, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [] }));
    const wires: F320AccountWire[] = [];
    const native = new CodexAgentService({
      catId: 'codex-sol',
      carrierMode: 'app_server',
      cliCommand: 'codex',
      l0CompilerFn: fakeL0Compiler,
      rawArchive: { append: async () => {} },
    });
    const deps = {
      registry: {
        create: async () => ({ invocationId: 'owner-root-invoke', callbackToken: 'fixture' }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => f.external,
      },
      threadStore: { get: async () => ({ id: 'external-thread', projectPath: f.external }) },
      apiUrl: 'http://127.0.0.1:0',
    } as unknown as Parameters<typeof invokeSingleCat>[0];
    const service: Parameters<typeof invokeSingleCat>[1]['service'] = {
      async *invoke(prompt, options) {
        assert.equal(options?.workingDirectory, f.external);
        assert.equal(options?.codexAccountLaunch?.credentialHome, f.layout.credentialHome);
        yield* native.invoke(prompt, {
          ...options,
          agentCarrierSessionFactory: async (launch) => {
            assert.equal(launch.cwd, f.external);
            assert.equal(launch.env?.CODEX_HOME, f.layout.credentialHome);
            const wire = new F320AccountWire({
              sqlite_home: f.state,
              cli_auth_credentials_store: 'file',
              forced_chatgpt_workspace_id: f.identity.workspaceId,
            });
            wires.push(wire);
            return wire;
          },
        });
      },
    };
    const events = [];
    for await (const event of invokeSingleCat(deps, {
      catId: 'codex-sol',
      service,
      prompt: 'fixture',
      userId: 'fixture',
      threadId: 'external-thread',
      isLastCat: true,
    }))
      events.push(event);
    assert.deepEqual(
      events.filter((event) => event.type === 'error'),
      [],
    );
    assert.equal(wires.length, 1);
    assert.ok(wires[0].writes.some((item) => item.method === 'turn/start'));
    assert.ok(events.some((event) => event.metadata?.executionAccount?.accountRef === f.ref));
  } finally {
    f.close();
  }
});

for (const lifecycle of ['fresh', 'warm', 'recreated'] as const)
  for (const control of ['fork', 'attachment'] as const)
    test(`${control} ${lifecycle} retains the saved owner separately from execution cwd`, async () => {
      const f = ownedManagedFixture();
      const wires: F320AccountWire[] = [];
      const hosts: Array<{ alive: boolean }> = [];
      const pool = new CodexAppServerHostPool(
        { idleTtlMs: 60000, maxWarmHosts: 2 },
        {
          createSocketDirectory: () => `${f.root}/socket`,
          removeSocketDirectory: async () => {},
          spawnHost: async (launch) => {
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
              {
                sqlite_home: f.state,
                cli_auth_credentials_store: 'file',
                forced_chatgpt_workspace_id: f.identity.workspaceId,
              },
              true,
            );
            wires.push(wire);
            return wire;
          },
        },
      );
      try {
        const env = finalizeCodexAccountEnvironment(f.launch, {
          cwd: f.external,
          env: {},
          args: codexManagedLaunchArgs(f.launch, []),
        });
        const options = {
          command: 'codex',
          args: ['app-server', '--stdio', ...codexManagedLaunchArgs(f.launch, [])],
          cwd: f.external,
          env,
          invocationId: 'accepted',
        };
        rememberCodexAppServerControlOptions(pool, 'fixture-thread', options);
        if (lifecycle !== 'fresh') {
          const original = await pool.createSession(options);
          original.rememberSession?.('fixture-thread');
          await original.close();
          if (lifecycle === 'recreated') for (const host of hosts) host.alive = false;
        }
        // A later active-project change cannot reselect this accepted account owner.
        process.env.CAT_CAFE_CONFIG_ROOT = f.external;
        const service = new CodexAgentService({
          carrierMode: 'app_server',
          appServerHostPool: pool,
          cliCommand: 'codex',
        });
        const run =
          control === 'fork'
            ? () => service.requestNativeFork({ sessionId: 'fixture-thread', invocationId: 'control', timeoutMs: 1000 })
            : () =>
                service.openNativeRealtimeCompanion({
                  sessionId: 'fixture-thread',
                  invocationId: 'attachment',
                  consumer: 'watch_video',
                  startupTimeoutMs: 1000,
                  maxDurationMs: 1000,
                });
        await assert.rejects(run, /fixture_business_reached/);
        assert.ok(
          wires.at(-1)?.writes.some((item) => item.method === (control === 'fork' ? 'thread/fork' : 'thread/resume')),
        );
      } finally {
        await pool.closeAll();
        f.close();
      }
    });

test('owner provenance stays stable across execution projects and account note changes', () => {
  const f = ownedManagedFixture();
  try {
    const other = resolveCodexAccountLaunch({ ...f.account, displayName: 'renamed' }, { cwd: f.owner });
    assert.equal(other.accountRevision, f.launch.accountRevision);
    assert.equal(other.credentialHome, f.layout.credentialHome);
  } finally {
    f.close();
  }
});

test('F306 actual capability admission carries B owner independently of its external cwd', async () => {
  const f = ownedManagedFixture();
  const pool = new CodexAppServerHostPool(
    { idleTtlMs: 0, maxWarmHosts: 0 },
    {
      createSocketDirectory: () => join(f.root, 'socket'),
      removeSocketDirectory: async () => {},
      spawnHost: async (launch) => {
        assert.equal(launch.cwd, f.external);
        assert.equal(launch.env?.CODEX_CAT_ACCOUNT_OWNER_ROOT, f.owner);
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
      connectHost: async () =>
        new F320AccountWire({
          sqlite_home: f.state,
          cli_auth_credentials_store: 'file',
          forced_chatgpt_workspace_id: f.identity.workspaceId,
        }),
    },
  );
  try {
    const service = new CodexAgentService({ carrierMode: 'app_server', appServerHostPool: pool, cliCommand: 'codex' });
    const result = await service.requestNativeCapabilitySource({
      invocationId: 'external-probe',
      cwd: f.external,
      account: f.account,
      timeoutMs: 1000,
    });
    assert.equal(result.availability, 'live');
  } finally {
    await pool.closeAll();
    f.close();
  }
});

test('actual owner drift is still refused when the execution project has an empty catalog', () => {
  const f = ownedManagedFixture();
  try {
    const path = join(f.owner, '.cat-cafe/accounts.json');
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.codex.envVars.CODEX_HOME = f.ambient;
    writeFileSync(path, JSON.stringify(data));
    assert.throws(
      () =>
        finalizeCodexAccountEnvironment(f.launch, {
          cwd: f.external,
          env: {},
          args: codexManagedLaunchArgs(f.launch, []),
        }),
      /state_roots_divergent/,
    );
  } finally {
    f.close();
  }
});

test('saved carrier markers cannot fall back to execution cwd when owner provenance is missing', async () => {
  const f = ownedManagedFixture();
  try {
    const env = finalizeCodexAccountEnvironment(f.launch, {
      cwd: f.owner,
      env: {},
      args: codexManagedLaunchArgs(f.launch, []),
    });
    delete env.CODEX_CAT_ACCOUNT_OWNER_ROOT;
    await assert.rejects(
      () => prepareCodexHostLaunch({ command: 'codex', args: ['app-server'], cwd: f.owner, env }),
      /codex_account_owner_unavailable/,
    );
  } finally {
    f.close();
  }
});

test('owner provenance neither changes prior auth revisions nor accepts a composed-env override', () => {
  const f = ownedManagedFixture();
  try {
    const legacyRevision = createHash('sha256')
      .update(
        JSON.stringify({
          accountRef: f.launch.accountRef,
          authMode: f.launch.authMode,
          credentialHome: f.launch.credentialHome,
          stateRoot: f.launch.stateRoot,
          sqliteHome: f.launch.sqliteHome,
          managed: true,
          identity: { userId: f.identity.userId, workspaceId: f.identity.workspaceId },
        }),
      )
      .digest('hex');
    assert.equal(f.launch.accountRevision, legacyRevision);
    const env = finalizeCodexAccountEnvironment(f.launch, {
      cwd: f.external,
      env: { CODEX_CAT_ACCOUNT_OWNER_ROOT: f.external },
      args: codexManagedLaunchArgs(f.launch, []),
    });
    assert.equal(env.CODEX_CAT_ACCOUNT_OWNER_ROOT, f.owner);
    assert.equal(f.launch.accountOwnerRoot, f.owner);
  } finally {
    f.close();
  }
});
