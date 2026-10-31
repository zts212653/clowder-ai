import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';
import { resolveKimiRuntimePaths } from '../dist/utils/kimi-cli-runtime.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

function fixture(t, { legacy = false, modernConfig = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kimi-default-home-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const keys = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'KIMI_CODE_HOME',
    'KIMI_SHARE_DIR',
    'KIMI_CONFIG_FILE',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = root;
  process.env.PATH = bin;
  for (const command of legacy ? ['kimi', 'kimi-cli'] : ['kimi']) {
    const file = join(bin, command);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  for (const [directory, alias, window] of [
    ['.kimi', 'legacy-alias', 12345],
    ['.kimi-code', 'modern-alias', 45678],
  ]) {
    if (directory === '.kimi-code' && !modernConfig) continue;
    mkdirSync(join(root, directory));
    writeFileSync(
      join(root, directory, 'config.toml'),
      `default_model="${alias}"\n[models."${alias}"]\nmax_context_size=${window}\n`,
    );
  }
  for (const command of ['kimi-cli', 'kimi']) invalidateCliCommand(command);
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    for (const command of ['kimi-cli', 'kimi']) invalidateCliCommand(command);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, bin };
}

test('discovery uses the resolved modern CLI home when both configuration directories exist', (t) => {
  const { root, bin } = fixture(t);
  const found = discoverAdditionalRuntimes(root)[0];
  assert.equal(found.command, join(bin, 'kimi'));
  assert.equal(found.configuredModel, 'modern-alias');
});

test('modern CLI without a config never borrows stale legacy metadata', (t) => {
  const { root, bin } = fixture(t, { modernConfig: false });
  const found = discoverAdditionalRuntimes(root)[0];
  assert.equal(found.command, join(bin, 'kimi'));
  assert.equal(found.configuredModel, undefined);
  assert.deepEqual(found.models, []);
});

test('discovery and dispatch ignore an obsolete shim when Kimi Code is installed', (t) => {
  const { root, bin } = fixture(t, { legacy: true });
  const found = discoverAdditionalRuntimes(root)[0];
  assert.equal(found.command, join(bin, 'kimi'));
  assert.equal(found.configuredModel, 'modern-alias');
});

test('native paths ignore retired share/config environment variables', (t) => {
  const { root } = fixture(t);
  const modernHome = join(root, 'custom-modern');
  const env = {
    KIMI_CODE_HOME: modernHome,
    KIMI_SHARE_DIR: join(root, 'old-share'),
    KIMI_CONFIG_FILE: join(root, 'old.toml'),
  };
  assert.deepEqual(resolveKimiRuntimePaths(env), { shareDir: modernHome, configPath: join(modernHome, 'config.toml') });
  assert.equal(resolveKimiRuntimePaths({ KIMI_SHARE_DIR: env.KIMI_SHARE_DIR }).shareDir, join(root, '.kimi-code'));
});

test('account-specific OS home affects the native default without inventing an authentication override', (t) => {
  const { root } = fixture(t);
  const accountHome = join(root, 'account-home');
  const env = { HOME: accountHome, USERPROFILE: accountHome };
  const paths = resolveKimiRuntimePaths(env);
  assert.equal(paths.shareDir, join(accountHome, '.kimi-code'));
  assert.equal(paths.configPath, join(accountHome, '.kimi-code', 'config.toml'));
  assert.deepEqual(env, { HOME: accountHome, USERPROFILE: accountHome });
});

for (const legacy of [false, true]) {
  test(`native invocation keeps its own home with obsolete shim ${legacy ? 'present' : 'absent'}`, async (t) => {
    const { root, bin } = fixture(t, { legacy });
    const directory = join(root, '.kimi-code');
    const sessionId = 'owned-session';
    // Exercise only the existing context format at the chosen root. There is
    // no assumption that modern sessions use this format.
    const session = join(directory, 'sessions', 'owned-project', sessionId);
    mkdirSync(session, { recursive: true });
    writeFileSync(join(session, 'context.jsonl'), '{"role":"_usage","token_count":37}\n');
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const service = new KimiAgentService({
      model: 'selected',
      spawnFn,
      mcpServerPath: '',
      rawArchive: createMockArchive(),
      l0CompilerFn: buildFakeL0Compiler(),
    });
    const pending = collect(service.invoke('fixture', { workingDirectory: root }));
    await emitEvents(proc, [{ role: 'assistant', session_id: sessionId, content: '42' }]);
    const messages = await pending;
    const [command, args, options] = spawnFn.mock.calls[0].arguments;
    assert.equal(command, join(bin, 'kimi'));
    assert.equal(args[args.indexOf('--model') + 1], 'modern-alias');
    assert.equal(options.env?.KIMI_CODE_HOME, undefined, 'host defaults must not mutate child authentication');
    assert.equal(messages.find((item) => item.type === 'done')?.metadata?.usage?.contextWindowSize, 45678);
  });
}

test('modern invocation leaves unknown context unknown rather than reading another home', async (t) => {
  const { root } = fixture(t);
  const sessionId = 'legacy-session';
  const stale = join(root, '.kimi', 'sessions', 'stale-project', sessionId);
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'context.jsonl'), '{"role":"_usage","token_count":999}\n');
  const proc = createMockProcess();
  const service = new KimiAgentService({
    model: 'selected',
    spawnFn: createMockSpawnFn(proc),
    mcpServerPath: '',
    rawArchive: createMockArchive(),
    l0CompilerFn: buildFakeL0Compiler(),
  });
  const pending = collect(service.invoke('fixture', { workingDirectory: root }));
  await emitEvents(proc, [{ role: 'assistant', session_id: sessionId, content: '42' }]);
  const messages = await pending;
  assert.equal(messages.find((item) => item.type === 'done')?.metadata?.usage?.contextUsedTokens, undefined);
});
