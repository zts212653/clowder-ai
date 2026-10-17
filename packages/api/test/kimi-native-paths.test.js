import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import {
  readKimiModelConfigInfo,
  resolveKimiConfigPath,
  resolveKimiShareDir,
} from '../dist/domains/cats/services/agents/providers/kimi-config.js';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';
import { nativeKimiLoginCommand } from '../dist/routes/native-kimi-login.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kimi-native-paths-'));
  const modern = join(root, 'native-home');
  const legacy = join(root, 'legacy-home');
  const osHome = join(root, 'os-home');
  for (const directory of [modern, legacy, osHome]) mkdirSync(directory);
  writeFileSync(
    join(modern, 'config.toml'),
    'default_model="fixture-v2"\n[models."fixture-v2"]\nmax_context_size=424242\ncapabilities=["thinking"]\n',
  );
  writeFileSync(join(legacy, 'config.toml'), 'default_model="fixture-legacy"\n');
  const keys = ['KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'KIMI_CONFIG_FILE', 'HOME', 'USERPROFILE'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.HOME = osHome;
  process.env.USERPROFILE = osHome;
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    assert.equal(realpathSync(dirname(root)), realpathSync(tmpdir()));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, modern, legacy, osHome };
}

test('native discovery honors explicit KIMI_CODE_HOME instead of an old config file', (t) => {
  const { modern, legacy, osHome } = fixture(t);
  process.env.KIMI_CODE_HOME = modern;
  process.env.KIMI_CONFIG_FILE = join(legacy, 'config.toml');
  const found = discoverAdditionalRuntimes(osHome, (id) => (id === 'kimi' ? 'fixture-kimi' : null));
  assert.equal(found[0].configuredModel, 'fixture-v2');
  assert.doesNotMatch(JSON.stringify(found), /api_key|refresh_token/);
});

test('host paths and model metadata use the modern home before legacy overrides', (t) => {
  const { modern, legacy } = fixture(t);
  const env = { KIMI_CODE_HOME: modern, KIMI_SHARE_DIR: legacy, KIMI_CONFIG_FILE: join(legacy, 'config.toml') };
  assert.equal(resolveKimiShareDir(env), modern);
  assert.equal(resolveKimiConfigPath(env), join(modern, 'config.toml'));
  assert.equal(readKimiModelConfigInfo('fixture-v2', env).maxContextSize, 424242);
});

test('legacy share/config and default locations retain their existing contract', (t) => {
  const { legacy } = fixture(t);
  assert.equal(resolveKimiShareDir({ KIMI_SHARE_DIR: legacy }), legacy);
  assert.equal(resolveKimiConfigPath({ KIMI_CONFIG_FILE: join(legacy, 'other.toml') }), join(legacy, 'other.toml'));
  assert.equal(resolveKimiShareDir(), join(homedir(), '.kimi'));
  assert.equal(resolveKimiConfigPath(), join(homedir(), '.kimi', 'config.toml'));
});

test('process modern home is used unless the current invocation explicitly selects another modern home', (t) => {
  const { modern, legacy } = fixture(t);
  process.env.KIMI_CODE_HOME = modern;
  assert.equal(resolveKimiShareDir(), modern);
  assert.equal(resolveKimiConfigPath(), join(modern, 'config.toml'));
  assert.equal(resolveKimiShareDir({ KIMI_CODE_HOME: legacy }), legacy);
});

test('copyable login guidance binds or clears modern HOME in each supported shell', (t) => {
  const { modern, osHome } = fixture(t);
  for (const platform of ['win32', 'linux']) {
    const command = nativeKimiLoginCommand(
      'fixture-kimi',
      { HOME: osHome, USERPROFILE: osHome, KIMI_CODE_HOME: modern },
      platform,
    );
    assert.match(command, /KIMI_CODE_HOME/);
    assert.ok(command.includes(modern));
    const cleared = nativeKimiLoginCommand('fixture-kimi', { HOME: osHome, USERPROFILE: osHome }, platform);
    assert.match(
      cleared,
      platform === 'win32' ? /SetEnvironmentVariable\('KIMI_CODE_HOME', \$null/ : /-u KIMI_CODE_HOME/,
    );
  }
});

test('account HOME overrides callback HOME for host metadata and the actual CLI environment', async (t) => {
  const { modern, legacy, root } = fixture(t);
  const cliEnvKeys = ['PATH', 'APPDATA', 'LOCALAPPDATA'];
  const previousCliEnv = Object.fromEntries(cliEnvKeys.map((key) => [key, process.env[key]]));
  process.env.PATH = dirname(ensureFakeCliOnPath('kimi'));
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  for (const command of ['kimi-cli', 'kimi']) invalidateCliCommand(command);
  t.after(() => {
    for (const key of cliEnvKeys) {
      if (previousCliEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousCliEnv[key];
    }
    for (const command of ['kimi-cli', 'kimi']) invalidateCliCommand(command);
  });
  const sessionId = 'fixture-session';
  const session = join(modern, 'sessions', 'fixture-workdir', sessionId);
  mkdirSync(session, { recursive: true });
  // This is the existing legacy context contract at an explicit root, not a
  // proposed parser for modern wire.jsonl or session_index.jsonl.
  writeFileSync(join(session, 'context.jsonl'), '{"role":"_usage","token_count":37}\n');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    model: 'fixture-v2',
    spawnFn,
    mcpServerPath: '',
    rawArchive: createMockArchive(),
    l0CompilerFn: buildFakeL0Compiler(),
  });
  const pending = collect(
    service.invoke('fixture', {
      workingDirectory: root,
      callbackEnv: { KIMI_CODE_HOME: legacy },
      accountEnv: { KIMI_CODE_HOME: modern },
    }),
  );
  await emitEvents(proc, [{ role: 'assistant', session_id: sessionId, content: '42' }]);
  const messages = await pending;
  const [, args, options] = spawnFn.mock.calls[0].arguments;
  assert.equal(options.env.KIMI_CODE_HOME, modern);
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-v2');
  const usage = messages.find((item) => item.type === 'done')?.metadata?.usage;
  assert.equal(usage?.contextWindowSize, 424242);
  assert.equal(usage?.contextUsedTokens, 37);
});

test(
  'PowerShell login guidance restores the original modern HOME after an owned fake login',
  {
    skip: process.platform !== 'win32',
  },
  (t) => {
    const { root, modern, osHome } = fixture(t);
    const script = join(root, 'fake-login.cjs');
    const command = join(root, 'fake-kimi.cmd');
    const witness = join(root, 'login-env.json');
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, JSON.stringify({home:process.env.KIMI_CODE_HOME}));`,
    );
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    const instruction = nativeKimiLoginCommand(
      command,
      { HOME: osHome, USERPROFILE: osHome, KIMI_CODE_HOME: modern },
      'win32',
    );
    const child = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${instruction}\n[pscustomobject]@{home=$env:KIMI_CODE_HOME} | ConvertTo-Json -Compress`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, KIMI_CODE_HOME: 'outer-home-sentinel' },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(readFileSync(witness, 'utf8')).home, modern);
    assert.equal(JSON.parse(child.stdout.trim()).home, 'outer-home-sentinel');
  },
);
