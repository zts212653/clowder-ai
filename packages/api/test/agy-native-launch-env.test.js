import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isolatedOAuthEnv } from '../dist/domains/cats/services/agents/providers/agy-native/launch/agy-native-launch-env.js';

test('isolated OAuth uses the native temporary directory for TMPDIR', () => {
  withEnv({ TMPDIR: process.platform === 'win32' ? '/tmp' : undefined }, () => {
    const env = isolatedOAuthEnv('/isolated/profile');
    assert.equal(env.TMPDIR, tmpdir());
    assert.equal(env.TEMP, process.env.TEMP);
    assert.equal(env.TMP, process.env.TMP);
  });
});

const proxies = {
  HTTP_PROXY: 'http://proxy.example:8080',
  http_proxy: 'http://lowercase.example:8081',
  HTTPS_PROXY: 'http://proxy.example:8082',
  https_proxy: 'http://lowercase.example:8083',
  ALL_PROXY: 'socks5://proxy.example:1080',
  all_proxy: 'socks5://lowercase.example:1081',
  NO_PROXY: 'localhost,127.0.0.1,::1,.internal.example',
  no_proxy: '',
};

function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('isolated OAuth preserves configured proxy values without importing account or host authority', () => {
  withEnv(
    {
      ...proxies,
      GEMINI_API_KEY: 'synthetic-api-key',
      GOOGLE_APPLICATION_CREDENTIALS: '/synthetic/credentials.json',
      CAT_CAFE_CALLBACK_TOKEN: ['synthetic', 'callback', 'token'].join('-'),
      AGY_UNRELATED_SECRET: 'synthetic-unrelated-secret',
      NODE_OPTIONS: '--inspect',
    },
    () => {
      const env = isolatedOAuthEnv('/isolated/profile');
      for (const [key, value] of Object.entries(proxies)) assert.equal(env[key], value, key);
      assert.equal(env.HOME, '/isolated/profile');
      assert.equal(env.GEMINI_API_KEY, null);
      assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, null);
      assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, null);
      assert.equal(env.AGY_UNRELATED_SECRET, undefined);
      assert.equal(env.NODE_OPTIONS, null);
    },
  );
});

test('isolated OAuth leaves absent proxies unset', () => {
  withEnv(Object.fromEntries(Object.keys(proxies).map((key) => [key, undefined])), () => {
    const env = isolatedOAuthEnv('/isolated/profile');
    for (const key of Object.keys(proxies)) assert.equal(env[key], undefined, key);
  });
});

test('account environment cannot execute a Git credential helper through injected configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'agy-account-git-'));
  try {
    const marker = join(root, 'marker.txt');
    const helperFile = join(root, 'helper.cjs');
    const configFile = join(root, 'empty.gitconfig');
    writeFileSync(configFile, '');
    writeFileSync(
      helperFile,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n` +
        "process.stdout.write('username=synthetic\\npassword=synthetic\\n');\n",
    );
    // Git invokes helpers with its shell, including on Windows; quote paths for that shell.
    const shellPath = (value) => `'${value.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    const injection = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: `!${shellPath(process.execPath)} ${shellPath(helperFile)}`,
    };
    const inherited = Object.fromEntries(
      Object.entries(isolatedOAuthEnv(root)).filter(([key, value]) => value !== null && !/^GIT_/i.test(key)),
    );
    const base = {
      ...inherited,
      HOME: root,
      XDG_CONFIG_HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: configFile,
      GIT_CONFIG_SYSTEM: configFile,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'false',
    };
    const fill = (env) =>
      spawnSync('git', ['credential', 'fill'], {
        cwd: root,
        env,
        input: 'protocol=https\nhost=synthetic.invalid\n\n',
        encoding: 'utf8',
        timeout: 5000,
      });
    const control = fill({ ...base, ...injection });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(readFileSync(marker, 'utf8'), 'executed', 'control must exercise the actual helper');
    rmSync(marker);

    let rejection;
    try {
      const account = isolatedOAuthEnv(root, injection);
      fill({ ...base, ...Object.fromEntries(Object.entries(account).filter(([key]) => /^GIT_/i.test(key))) });
    } catch (error) {
      rejection = error;
    }
    assert.equal(existsSync(marker), false, 'account-controlled configuration must never execute the helper');
    assert.match(rejection?.message ?? '', /accountEnv refuses/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('account environment rejects the entire Git control namespace, including case variants and future keys', () => {
  for (const key of [
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_CONFIG_PARAMETERS',
    'git_config_parameters',
    'GIT_EXEC_PATH',
    'GIT_SSH',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_CONFIG_GLOBAL',
    'GIT_TEMPLATE_DIR',
    'GIT_FUTURE_CONTROL',
  ]) {
    assert.throws(() => isolatedOAuthEnv('/isolated/profile', { [key]: 'override' }), /accountEnv refuses/, key);
  }
  assert.equal(
    isolatedOAuthEnv('/isolated/profile', { TZ: 'UTC', CUSTOM_DEV_FLAG: 'enabled' }).CUSTOM_DEV_FLAG,
    'enabled',
  );
});
