import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountToRuntimeProfile } from '../src/config/account-resolver.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { codexExecutionAccountSnapshot } from '../src/config/codex-execution-account.js';
import { codexManagedLaunchArgs } from '../src/config/codex-managed-launch.js';
import { prepareCodexManagedLayout, validateCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import { buildChildEnv } from '../src/utils/cli-spawn.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

// These two producer cases exercise the measured native admission (a real credential-free probe of
// whatever Codex is installed), even with a mock transport. Other CI platforms still run the
// platform-independent layout/identity cases.
let measuredNativeAvailable = false;
if (process.platform === 'darwin') {
  try {
    measuredNativeAvailable = /^codex-cli /.test(
      execFileSync('codex', ['--version'], {
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH, HOME: tmpdir(), CODEX_HOME: tmpdir(), NODE_ENV: 'test' },
      }).trim(),
    );
  } catch {
    measuredNativeAvailable = false;
  }
}

function fixture(planType = 'pro') {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-managed-consumer-')));
  const state = join(root, 'state');
  mkdirSync(state);
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: state } });
  const identity = { userId: 'user-b', workspaceId: 'workspace-b', email: 'b@example.test', planType };
  const layout = prepareCodexManagedLayout({
    kind: 'managed',
    layoutVersion: 1,
    credentialHome: join(root, 'managed', 'home'),
    stateRoot: state,
    sqliteHome: state,
    prepared: false,
    identity,
  });
  const jwt = `x.${Buffer.from(JSON.stringify({ email: identity.email, 'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId, chatgpt_plan_type: identity.planType } })).toString('base64url')}.x`;
  writeFileSync(
    join(layout.credentialHome, 'auth.json'),
    JSON.stringify({ tokens: { id_token: jwt, account_id: identity.workspaceId } }),
  );
  const account = {
    id: 'managed-b',
    displayName: '公司',
    authType: 'oauth' as const,
    codex: layout,
    envVars: accountToRuntimeProfile('managed-b', {
      authType: 'oauth',
      clientId: 'openai',
      codex: layout,
    }).envVars,
  };
  const launch = resolveCodexAccountLaunch(account, { cwd: root });
  return {
    root,
    state,
    account,
    launch,
    identity,
    close() {
      process.env = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('managed principal fields ignore note/email/plan changes in the identity revision', () => {
  const f = fixture();
  try {
    const changed = resolveCodexAccountLaunch(
      {
        ...f.account,
        displayName: '新备注',
        codex: { ...f.account.codex, identity: { ...f.identity, email: 'new@example.test', planType: 'plus' } },
      },
      { cwd: f.root },
    );
    assert.equal(changed.accountRevision, f.launch.accountRevision);
    const snapshot = codexExecutionAccountSnapshot(f.account, f.launch);
    f.account.displayName = '晚改备注';
    assert.equal(snapshot.displayName, '公司');
  } finally {
    f.close();
  }
});
test('organization plan names do not add a blanket login/runtime refusal', () => {
  for (const planType of ['business', 'enterprise', 'edu', 'pro']) {
    const f = fixture(planType);
    try {
      assert.doesNotThrow(() =>
        finalizeCodexAccountEnvironment(f.launch, {
          cwd: f.root,
          env: {},
          args: codexManagedLaunchArgs(f.launch, []),
        }),
      );
    } finally {
      f.close();
    }
  }
});
test('managed source rejects every profile spelling and owned SQLite/auth override', () => {
  const f = fixture();
  try {
    for (const args of [
      ['-pfoo'],
      ['--profile=foo'],
      ['-c', 'sqlite_home="elsewhere"'],
      ['--config', 'cli_auth_credentials_store="keyring"'],
    ])
      assert.throws(() => codexManagedLaunchArgs(f.launch, args), /configuration_conflict/);
  } finally {
    f.close();
  }
});

test('atomic replacement of a known shared instructions link is refused before launch', () => {
  const f = fixture();
  try {
    validateCodexManagedLayout(f.account.codex);
    const temporary = join(f.root, 'instructions-replacement');
    writeFileSync(temporary, 'private divergent instructions');
    renameSync(temporary, join(f.account.codex.credentialHome, 'AGENTS.md'));
    assert.throws(() => validateCodexManagedLayout(f.account.codex), /layout_changed/);
  } finally {
    f.close();
  }
});
test(
  'real managed app-server consumer carries private home, shared SQLite and immutable identity before business',
  { skip: !measuredNativeAvailable },
  async () => {
    const f = fixture();
    try {
      let launches = 0;
      const service = new CodexAgentService({
        carrierMode: 'app_server',
        cliCommand: 'codex',
        l0CompilerFn: fakeL0Compiler,
      });
      const events = [];
      for await (const event of service.invoke('fixture', {
        workingDirectory: f.root,
        invocationId: 'managed-consumer',
        codexAccountLaunch: f.launch,
        accountEnv: f.account.envVars,
        executionAccount: codexExecutionAccountSnapshot(f.account, f.launch),
        agentCarrierSessionFactory: async (options) => {
          launches++;
          assert.equal(options.env?.CODEX_HOME, f.account.codex.credentialHome);
          assert.equal(buildChildEnv(options.env).HOME, f.root);
          assert.equal(options.env?.CODEX_SQLITE_HOME, f.state);
          assert.equal(options.env?.CODEX_CAT_EXPECTED_USER_ID, f.identity.userId);
          assert.ok(options.args.includes('cli_auth_credentials_store="file"'));
          return new F320AccountWire({
            sqlite_home: f.state,
            cli_auth_credentials_store: 'file',
            forced_chatgpt_workspace_id: f.identity.workspaceId,
          });
        },
      }))
        events.push(event);
      assert.equal(launches, 1);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        [],
      );
      assert.ok(
        events.some((event) => event.type === 'done' && event.metadata?.executionAccount?.accountRef === f.account.id),
      );
    } finally {
      f.close();
    }
  },
);
test(
  'real managed exec producer inserts owned config before the prompt separator and keeps selected snapshot',
  { skip: !measuredNativeAvailable },
  async () => {
    const f = fixture();
    try {
      let launches = 0;
      const service = new CodexAgentService({
        carrierMode: 'exec_json',
        cliCommand: 'codex',
        l0CompilerFn: fakeL0Compiler,
      });
      const events = [];
      for await (const event of service.invoke('fixture', {
        workingDirectory: f.root,
        invocationId: 'managed-exec',
        codexAccountLaunch: f.launch,
        accountEnv: f.account.envVars,
        executionAccount: codexExecutionAccountSnapshot(f.account, f.launch),
        spawnCliOverride: async function* (options) {
          launches++;
          assert.ok(options.args.indexOf('cli_auth_credentials_store="file"') < options.args.indexOf('--'));
          assert.equal(options.env?.CODEX_HOME, f.account.codex.credentialHome);
          assert.equal(buildChildEnv(options.env).HOME, f.root);
          assert.equal(options.env?.CODEX_SQLITE_HOME, f.state);
          yield { type: 'thread.started', thread_id: 'fixture-thread' };
          yield { type: 'item.completed', item: { type: 'agent_message', text: 'fixture reply' } };
          yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
        },
      }))
        events.push(event);
      assert.equal(launches, 1);
      assert.deepEqual(
        events.filter((event) => event.type === 'error'),
        [],
      );
      assert.ok(
        events.some((event) => event.type === 'done' && event.metadata?.executionAccount?.accountRef === f.account.id),
      );
    } finally {
      f.close();
    }
  },
);
