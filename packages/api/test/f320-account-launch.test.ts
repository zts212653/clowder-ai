import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { CodexAppServerHostPool } from '../src/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import {
  rememberCodexAppServerControlOptions,
  resolveCodexAppServerControlOptions,
} from '../src/domains/cats/services/agents/providers/codex-app-server-control-options.js';
import { createCodexSessionContextSnapshotResolver } from '../src/domains/cats/services/agents/providers/codex-session-context-snapshot.js';
import { loadCodexCredentialsForTests } from '../src/routes/quota.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-launch-')));
  const home = join(root, 'account-a');
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { id: 'codex-a', authType: 'oauth' as const, envVars: { CODEX_HOME: home } };
  return {
    root,
    home,
    account,
    descriptor: () => resolveCodexAccountLaunch(account, { cwd: root, env: { HOME: root } }),
  };
}

test('account revision excludes user notes and credential rotation, and canonicalizes aliases', async (t) => {
  const f = await fixture(t);
  const a = f.descriptor();
  await writeFile(join(f.home, 'auth.json'), '{"fixture":"never-a-real-token"}');
  const renamed = { ...f.account, displayName: '私人 Plus' };
  assert.equal(
    resolveCodexAccountLaunch(renamed, { cwd: f.root, env: { HOME: f.root } }).accountRevision,
    a.accountRevision,
  );
  await symlink(f.home, join(f.root, 'alias'));
  const alias = { ...f.account, envVars: { CODEX_HOME: join(f.root, 'alias') } };
  assert.deepEqual(resolveCodexAccountLaunch(alias, { cwd: f.root, env: { HOME: f.root } }), a);
  const other = { ...f.account, id: 'codex-b' };
  assert.notEqual(
    resolveCodexAccountLaunch(other, { cwd: f.root, env: { HOME: f.root } }).accountRevision,
    a.accountRevision,
  );
});

test('native sqlite_home precedence is represented, and a later CLI override cannot misroute it', async (t) => {
  const f = await fixture(t);
  const sqlite = join(f.root, 'shared-state');
  await writeFile(join(f.home, 'config.toml'), `sqlite_home=${JSON.stringify(sqlite)}`);
  const descriptor = resolveCodexAccountLaunch(
    { ...f.account, envVars: { ...f.account.envVars, CODEX_SQLITE_HOME: '/wrong' } },
    { cwd: f.root },
  );
  assert.equal(descriptor.sqliteHome, sqlite);
  assert.throws(
    () =>
      finalizeCodexAccountEnvironment(descriptor, {
        env: {},
        cwd: f.root,
        args: ['exec', '-c', 'sqlite_home="/wrong"'],
      }),
    /conflict:sqlite_home/,
  );
});

test('OAuth final env removes all ambient/account credentials while preserving unrelated MCP variables', async (t) => {
  const f = await fixture(t);
  const env = finalizeCodexAccountEnvironment(f.descriptor(), {
    cwd: f.root,
    args: ['exec'],
    env: {
      CODEX_API_KEY: 'fake',
      CODEX_ACCESS_TOKEN: 'fake',
      OPENAI_API_KEY: 'fake',
      OPENAI_ORGANIZATION: 'ambient-org',
      OPENAI_PROJECT: 'ambient-project',
      OPENAI_FEDERATION_RULE_ID: 'fake',
      OPENAI_IDENTITY_TOKEN_FILE: 'fake',
      MCP_SERVICE_TOKEN: 'third-party',
    },
  });
  for (const key of [
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_API_KEY',
    'OPENAI_ORGANIZATION',
    'OPENAI_PROJECT',
    'OPENAI_FEDERATION_RULE_ID',
    'OPENAI_IDENTITY_TOKEN_FILE',
  ])
    assert.equal(env[key], null);
  assert.equal(env.MCP_SERVICE_TOKEN, 'third-party');
});

test('OAuth rejects custom HTTPS credential fields and effective root selectors in accepted CLI spellings', async (t) => {
  const f = await fixture(t);
  const expressions = [
    'model_providers.openai_https.env_key="MCP_SERVICE_TOKEN"',
    'model_providers.openai_https.experimental_bearer_token="fixture"',
    'model_providers.openai_https.auth={type="command",command="false"}',
    'model_provider="other"',
    'forced_login_method="api"',
  ];
  for (const expression of expressions)
    for (const args of [['-c', expression], [`-c${expression}`], [`-c=${expression}`], [`--config=${expression}`]]) {
      assert.throws(
        () =>
          finalizeCodexAccountEnvironment(f.descriptor(), {
            env: {},
            cwd: f.root,
            args: ['-c', 'model_provider="openai_https"', ...args],
          }),
        /codex_oauth_configuration_conflict/,
      );
    }
  await writeFile(join(f.home, 'config.toml'), '[profiles.work]\nopenai_base_url="https://fixture.invalid"');
  assert.throws(
    () => finalizeCodexAccountEnvironment(f.descriptor(), { env: {}, cwd: f.root, args: ['-c', 'profile="work"'] }),
    /openai_base_url/,
  );
});

test('OAuth guards native profile-v2 files and direct provider selectors', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'work.config.toml'), 'openai_base_url="https://fixture.invalid"');
  for (const args of [['--profile', 'work'], ['--profile=work'], ['-p', 'work'], ['-pwork'], ['-p=work']]) {
    assert.throws(
      () => finalizeCodexAccountEnvironment(f.descriptor(), { env: {}, cwd: f.root, args }),
      /openai_base_url/,
    );
  }
  for (const args of [['--oss'], ['--local-provider', 'ollama'], ['--local-provider=ollama']]) {
    assert.throws(
      () => finalizeCodexAccountEnvironment(f.descriptor(), { env: {}, cwd: f.root, args }),
      /conflict:model_provider/,
    );
  }
});

test('API-key/custom provider keeps its explicit credential path and custom config', async (t) => {
  const f = await fixture(t);
  const descriptor = resolveCodexAccountLaunch({ ...f.account, authType: 'api_key' }, { cwd: f.root });
  const env = finalizeCodexAccountEnvironment(descriptor, {
    cwd: f.root,
    args: ['-c', 'model_provider="custom"'],
    env: { OPENAI_API_KEY: 'fixture-key' },
    selectedApiEnv: { OPENAI_API_KEY: 'fixture-key' },
  });
  assert.equal(env.OPENAI_API_KEY, 'fixture-key');
});

test('explicit API routing comes from its account snapshot; auto retains ambient routing', async (t) => {
  const f = await fixture(t);
  const ambient = {
    OPENAI_API_KEY: 'ambient-key',
    OPENAI_ORGANIZATION: 'ambient-org',
    OPENAI_PROJECT: 'ambient-project',
  };
  const api = resolveCodexAccountLaunch({ ...f.account, authType: 'api_key' }, { cwd: f.root });
  const selectedApiEnv = {
    OPENAI_API_KEY: 'selected-key',
    OPENAI_ORGANIZATION: 'selected-org',
    OPENAI_PROJECT: 'selected-project',
  };
  const selected = finalizeCodexAccountEnvironment(api, { env: ambient, selectedApiEnv, cwd: f.root, args: [] });
  for (const [key, value] of Object.entries(selectedApiEnv)) assert.equal(selected[key], value);
  const absent = finalizeCodexAccountEnvironment(api, { env: ambient, cwd: f.root, args: [] });
  for (const key of Object.keys(ambient)) assert.equal(absent[key], null);
  const auto = resolveCodexAccountLaunch(f.account, { cwd: f.root, authMode: 'auto' });
  const inherited = finalizeCodexAccountEnvironment(auto, { env: ambient, selectedApiEnv, cwd: f.root, args: [] });
  for (const [key, value] of Object.entries(ambient)) assert.equal(inherited[key], value);
});

test('OAuth preflight fails closed on incomplete CLI config and non-regular or oversized config', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['exec', '-c'],
    ['app-server', '--config'],
  ]) {
    assert.throws(
      () => finalizeCodexAccountEnvironment(f.descriptor(), { cwd: f.root, env: {}, args }),
      /config_invalid/,
    );
  }
  await writeFile(join(f.home, 'config.toml'), ' '.repeat(1024 * 1024 + 1));
  assert.throws(f.descriptor, /config_invalid/);
  await rm(join(f.home, 'config.toml'));
  await mkdir(join(f.home, 'config.toml'));
  assert.throws(f.descriptor, /config_invalid/);
});

test('control and reconnect keep their admitted launch snapshot even when the caller changes binding', () => {
  const pool = new CodexAppServerHostPool({ idleTtlMs: 1000, maxWarmHosts: 2 });
  const env = { CODEX_HOME: '/fixture/account-a' };
  const args = ['app-server', '--stdio'];
  rememberCodexAppServerControlOptions(pool, 'native-thread', {
    invocationId: 'initial',
    command: 'fixture',
    args,
    env,
  });
  env.CODEX_HOME = '/fixture/account-b';
  args.push('--config', 'model_provider="other"');
  const control = resolveCodexAppServerControlOptions(pool, 'native-thread', 'control')!;
  assert.equal(control.env?.CODEX_HOME, '/fixture/account-a');
  assert.deepEqual(control.args, ['app-server', '--stdio']);
  if (control.env) control.env.CODEX_HOME = '/fixture/account-c';
  assert.equal(
    resolveCodexAppServerControlOptions(pool, 'native-thread', 'second-control')?.env?.CODEX_HOME,
    '/fixture/account-a',
  );
});

test('context snapshots key the same UUID by its selected state root rather than a constructor default', async (t) => {
  const f = await fixture(t);
  const a = join(f.root, 'state-a'),
    b = join(f.root, 'state-b');
  const id = 'fixture-shared-uuid';
  for (const [root, tokens] of [
    [a, 11],
    [b, 22],
  ] as const) {
    await mkdir(root);
    await writeFile(
      join(root, `rollout-${id}.jsonl`),
      JSON.stringify({
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: tokens }, model_context_window: 1000 },
        },
      }),
    );
  }
  const read = createCodexSessionContextSnapshotResolver({ sessionsRoot: a });
  assert.equal((await read(id, a))?.contextUsedTokens, 11);
  assert.equal((await read(id, b))?.contextUsedTokens, 22);
  assert.equal((await read(id, a))?.contextUsedTokens, 11);
});

test('selected quota credentials cannot fall back to a legacy operator path or another home', async (t) => {
  const f = await fixture(t);
  const operatorPath = join(f.root, 'operator-auth.json');
  const auth = (account: string) =>
    JSON.stringify({
      tokens: { account_id: account, access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
    });
  await writeFile(operatorPath, auth('operator'));
  assert.equal(loadCodexCredentialsForTests(operatorPath, f.descriptor()), null);
  await writeFile(join(f.home, 'auth.json'), auth('selected'));
  assert.equal(loadCodexCredentialsForTests(operatorPath, f.descriptor())?.accountId, 'selected');
  assert.equal(loadCodexCredentialsForTests(operatorPath)?.accountId, 'operator');
});
