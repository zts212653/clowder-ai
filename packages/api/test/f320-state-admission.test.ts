import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { AccountConfig } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../src/config/account-resolver.js';
import { readCatalogAccounts, writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { CodexLoginManager } from '../src/config/codex-login-manager.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { prepareCodexHostLaunch } from '../src/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { accountsRoutes } from '../src/routes/accounts.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

let root: string;
let saved: NodeJS.ProcessEnv;
const ref = 'codex-00000000-0000-0000-0000-000000000001';
const headers = { 'x-cat-cafe-user': 'fixture' };
beforeEach(() => {
  saved = { ...process.env };
  root = mkdtempSync(join(tmpdir(), 'f320-state-admission-'));
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
function defaultAt(home: string) {
  writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: home } });
}
function managed() {
  const codex = prepareCodexManagedLayout(describeCodexManagedLayout(root, ref));
  writeCatalogAccount(root, ref, { authType: 'oauth', clientId: 'openai', codex });
  return codex;
}
for (const field of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
  test(`default PATCH cannot fork ${field}; rejection precedes catalog/credential writes`, async () => {
    const home = join(root, 'default-a');
    defaultAt(home);
    const layout = managed();
    const before = readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8');
    const app = Fastify();
    await app.register(accountsRoutes);
    try {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/accounts/codex',
        headers,
        payload: {
          projectPath: root,
          envVars: { CODEX_HOME: home, [field]: join(root, 'default-b') },
          apiKey: 'not-written',
        },
      });
      assert.equal(response.statusCode, 400, response.body);
      assert.match(response.json().error, /state_roots_divergent/);
      assert.equal(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'), before);
      assert.equal(existsSync(join(root, '.cat-cafe/credentials.json')), false);
      assert.equal(
        resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root }).stateRoot,
        layout.stateRoot,
      );
      const note = await app.inject({
        method: 'PATCH',
        url: '/api/accounts/codex',
        headers,
        payload: { projectPath: root, displayName: '新备注' },
      });
      assert.equal(note.statusCode, 200, note.body);
    } finally {
      await app.close();
    }
  });
}
test('default DELETE refuses a divergent synthetic fallback even with force', async () => {
  defaultAt(join(root, 'selected'));
  managed();
  process.env.CODEX_HOME = join(root, 'ambient');
  const before = readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8');
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/codex',
      headers,
      payload: { projectPath: root, force: true },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error, /state_roots_divergent/);
    assert.equal(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'), before);
  } finally {
    await app.close();
  }
});
test('default DELETE may preserve an identical synthetic fallback root', async () => {
  defaultAt(join(root, '.codex'));
  managed();
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/accounts/codex',
      headers,
      payload: { projectPath: root, force: true },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(readCatalogAccounts(root).codex, undefined);
  } finally {
    await app.close();
  }
});
test('crash-left unprepared A cannot recover against default/prepared B; zero preparation and native driver calls', async () => {
  defaultAt(join(root, 'default-a'));
  const stale = describeCodexManagedLayout(root, ref);
  // A historical/crash snapshot bypasses today's writer, as a restart must not trust it.
  const nextRef = 'codex-00000000-0000-0000-0000-000000000002';
  const currentHome = join(root, 'default-b');
  const preparedB = prepareCodexManagedLayout({
    ...stale,
    stateRoot: currentHome,
    sqliteHome: currentHome,
    credentialHome: join(root, 'private-b'),
  });
  const accounts: Record<string, AccountConfig> = {
    codex: { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: currentHome } },
    [ref]: { authType: 'oauth', clientId: 'openai', codex: stale },
    [nextRef]: { authType: 'oauth', clientId: 'openai', codex: preparedB },
  };
  writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
  let calls = 0;
  const manager = new CodexLoginManager({
    run: async () => {
      calls++;
      throw new Error('no native login');
    },
  });
  try {
    const before = readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8');
    assert.throws(() => manager.start(root, ref), /state_roots_divergent/);
    assert.equal(calls, 0);
    assert.equal(existsSync(stale.credentialHome), false);
    assert.equal(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'), before);
    assert.equal(readCatalogAccounts(root)[ref].codex?.prepared, false);
  } finally {
    await manager.close();
  }
});
test('unprepared durable roots reserve the shared owner before later default edits', () => {
  defaultAt(join(root, 'default-a'));
  writeCatalogAccount(root, ref, {
    authType: 'oauth',
    clientId: 'openai',
    codex: describeCodexManagedLayout(root, ref),
  });
  assert.throws(() => defaultAt(join(root, 'default-b')), /state_roots_divergent/);
});
test('synthetic ambient restart drift is refused at the actual default final launch boundary', () => {
  managed();
  const original = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
  process.env.CODEX_HOME = join(root, 'restart-ambient');
  const next = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
  assert.notEqual(original.stateRoot, next.stateRoot);
  assert.throws(() => finalizeCodexAccountEnvironment(next, { cwd: root, env: {}, args: [] }), /state_roots_divergent/);
  assert.equal(existsSync(next.credentialHome), false);
});
test('prepared managed admission also refuses external default config root drift before auth reads', () => {
  const layout = managed();
  writeFileSync(join(layout.stateRoot, 'config.toml'), 'sqlite_home="other-state"');
  const launch = resolveCodexAccountLaunch(resolveByAccountRef(root, ref)!, { cwd: root });
  assert.throws(
    () => finalizeCodexAccountEnvironment(launch, { cwd: root, env: {}, args: [] }),
    /state_roots_divergent/,
  );
  assert.equal(existsSync(join(layout.credentialHome, 'auth.json')), false);
});

for (const carrier of ['probe', 'direct', 'pooled', 'exec'] as const)
  test(`actual ${carrier} refuses ambient shared-root drift before acquisition/spawn`, async () => {
    managed();
    const accepted = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
    process.env.CODEX_HOME = join(root, 'restart-ambient');
    let launches = 0;
    const unexpected = async () => {
      launches++;
      throw new Error('unexpected_launch');
    };
    const pool = new CodexAppServerHostPool(
      { idleTtlMs: 0, maxWarmHosts: 0 },
      {
        createSocketDirectory: () => {
          launches++;
          return join(root, 'socket');
        },
        removeSocketDirectory: async () => {},
        spawnHost: unexpected,
        connectHost: unexpected,
      },
    );
    const service = new CodexAgentService({
      carrierMode: carrier === 'exec' ? 'exec_json' : 'app_server',
      ...(carrier === 'probe' || carrier === 'pooled' ? { appServerHostPool: pool } : {}),
      cliCommand: process.execPath,
      l0CompilerFn: fakeL0Compiler,
      rawArchive: { append: async () => {} },
      spawnFn: () => {
        launches++;
        throw new Error('unexpected_spawn');
      },
    });
    try {
      if (carrier === 'probe')
        await assert.rejects(
          () =>
            service.requestNativeCapabilitySource({
              invocationId: 'state-probe',
              cwd: root,
              timeoutMs: 1000,
              account: resolveByAccountRef(root, 'codex')!,
            }),
          /state_roots_divergent/,
        );
      else {
        const errors: string[] = [];
        for await (const event of service.invoke('fixture', {
          workingDirectory: root,
          invocationId: 'state-main',
          codexAccountLaunch: accepted,
          ...(carrier === 'direct' ? { agentCarrierSessionFactory: unexpected } : {}),
        }))
          if (event.type === 'error') errors.push(event.error ?? '');
        assert.ok(
          errors.some((error) => error.includes('state_roots_divergent')),
          JSON.stringify(errors),
        );
      }
      assert.equal(launches, 0);
      assert.equal(existsSync(join(root, 'restart-ambient')), false);
    } finally {
      await pool.closeAll();
    }
  });

test('recreated control/attachment host checks the accepted roots without reselecting binding', async () => {
  managed();
  const accepted = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
  const env = finalizeCodexAccountEnvironment(accepted, { cwd: root, env: {}, args: [] });
  process.env.CODEX_HOME = join(root, 'restart-ambient');
  await assert.rejects(
    () => prepareCodexHostLaunch({ command: process.execPath, args: ['app-server', '--stdio'], cwd: root, env }),
    /state_roots_divergent/,
  );
  assert.equal(env.CODEX_CAT_STATE_ROOT, accepted.stateRoot);
  assert.equal(existsSync(join(root, 'restart-ambient')), false);
});
