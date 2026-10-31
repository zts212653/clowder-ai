import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import {
  finalizeCodexAccountEnvironment,
  validateCodexOwnedProvider,
} from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { readCodexLaunchProjection } from '../src/config/codex-launch-config.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-config-review-')));
  const home = join(root, 'home'),
    cwd = join(root, 'work');
  await mkdir(home);
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const account = { id: 'codex', authType: 'oauth' as const, envVars: { CODEX_HOME: home } };
  const guard = (args: string[] = [], env: Record<string, string> = {}) =>
    finalizeCodexAccountEnvironment(resolveCodexAccountLaunch(account, { cwd }), { args, env, cwd });
  return { home, cwd, account, guard };
}
test('effective root endpoint selectors are rejected in user config and CLI overlays', async (t) => {
  const f = await fixture(t);
  for (const key of ['openai_base_url', 'chatgpt_base_url']) {
    assert.throws(() => f.guard(['--config', `${key}="https://fixture.invalid/v1"`]), /configuration_conflict/);
    await writeFile(join(f.home, 'config.toml'), `${key}="https://fixture.invalid/v1"`);
    assert.throws(() => f.guard(), /configuration_conflict/);
    await rm(join(f.home, 'config.toml'));
  }
});
test('project auth selectors and redefinitions of native builtin openai are ignored', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.codex'));
  await writeFile(
    join(f.cwd, '.codex/config.toml'),
    'model_provider="custom"\nopenai_base_url="https://fixture.invalid"\n[model_providers.openai]\nenv_key="PRIVATE_FIXTURE"',
  );
  assert.doesNotThrow(() => f.guard());
  await writeFile(
    join(f.home, 'config.toml'),
    '[model_providers.openai]\nname="Ignored"\nwire_api="responses"\nenv_key="PRIVATE_FIXTURE"',
  );
  assert.doesNotThrow(() => f.guard());
});
test('relative sqlite_home keeps the originating user layer base directory', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'config.toml'), 'sqlite_home="state"');
  const descriptor = resolveCodexAccountLaunch(f.account, { cwd: f.cwd });
  assert.equal(descriptor.sqliteHome, join(f.home, 'state'));
  assert.doesNotThrow(() => finalizeCodexAccountEnvironment(descriptor, { args: [], env: {}, cwd: f.cwd }));
});
test('OAuth clears native refresh/revoke/AuthAPI/client-id environment selectors', async (t) => {
  const f = await fixture(t);
  const keys = [
    'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
    'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
    'CODEX_AUTHAPI_BASE_URL',
    'CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL',
    'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
  ];
  const output = f.guard([], Object.fromEntries(keys.map((key) => [key, 'fixture-value'])));
  for (const key of keys) assert.equal(output[key], null);
});
test('RPC final overlays and HTTPS provider extra fields cannot reopen credential outlets', async (t) => {
  const f = await fixture(t);
  for (const rpcConfig of [
    { openai_base_url: 'https://fixture.invalid' },
    { model_provider: 'custom' },
    { model_provider: 'openai_https', 'model_providers.openai_https.env_key': 'PRIVATE' },
  ]) {
    assert.throws(
      () =>
        finalizeCodexAccountEnvironment(resolveCodexAccountLaunch(f.account, { cwd: f.cwd }), {
          args: [],
          env: {},
          cwd: f.cwd,
          rpcConfig,
        }),
      /configuration_conflict/,
    );
  }
  assert.doesNotThrow(() =>
    f.guard([
      '-c',
      'model_provider="openai_https"',
      '-c',
      'model_providers.openai_https={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
    ]),
  );
});
test('projection retains sensitive-field origin and follows native trusted project SQLite only', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, '.git'));
  await mkdir(join(f.cwd, '.codex'));
  await writeFile(join(f.cwd, '.codex/config.toml'), 'sqlite_home="state"\nopenai_base_url="https://fixture.invalid"');
  for (const level of ['untrusted', 'trusted']) {
    await writeFile(join(f.home, 'config.toml'), `[projects.${JSON.stringify(f.cwd)}]\ntrust_level="${level}"`);
    const projection = readCodexLaunchProjection(f.home, f.cwd);
    assert.equal(projection.config.openai_base_url, undefined);
    assert.equal(projection.config.sqlite_home, level === 'trusted' ? join(f.cwd, '.codex', 'state') : undefined);
    const layer = projection.layers.find((layer) => layer.kind === 'project');
    assert.equal(layer?.baseDir, level === 'trusted' ? join(f.cwd, '.codex') : undefined);
  }
});
test('native CLI parses values separately from literal dotted keys, and tilde uses child HOME', async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.guard(['-c', ' openai_base_url = https://fixture.invalid']), /openai_base_url/);
  assert.doesNotThrow(() => f.guard(['-c', '"openai_base_url"="https://fixture.invalid"']));
  await writeFile(join(f.home, 'config.toml'), 'sqlite_home="~/state"');
  const descriptor = resolveCodexAccountLaunch(
    { ...f.account, envVars: { ...f.account.envVars, HOME: f.cwd } },
    { cwd: f.cwd },
  );
  assert.equal(descriptor.sqliteHome, join(f.cwd, 'state'));
});

test('native owned-provider serialized null defaults are inert; active and unknown fields are rejected', () => {
  const owned = { name: 'OpenAI', wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
  assert.doesNotThrow(() =>
    validateCodexOwnedProvider({
      ...owned,
      base_url: null,
      env_key: null,
      http_headers: null,
      auth: null,
      supports_standalone_web_search: false,
    }),
  );
  for (const extension of [
    { base_url: 'https://fixture.invalid' },
    { env_key: 'FOREIGN' },
    { auth: { command: 'foreign' } },
    { http_headers: { Authorization: 'foreign' } },
    { unexpected_field: null },
    { supports_standalone_web_search: true },
  ])
    assert.throws(() => validateCodexOwnedProvider({ ...owned, ...extension }), /configuration_conflict/);
});
test('OAuth official ChatGPT default is allowed but URL variants cannot redirect transport', async (t) => {
  const f = await fixture(t);
  assert.doesNotThrow(() => f.guard(['-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"']));
  for (const url of [
    'http://chatgpt.com/backend-api/',
    'https://chatgpt.com/backend-api/?redirect=foreign',
    'https://chatgpt.com@fixture.invalid/backend-api/',
    'https://chatgpt.com/other/',
  ])
    assert.throws(() => f.guard(['-c', `chatgpt_base_url="${url}"`]), /chatgpt_base_url/);
});
