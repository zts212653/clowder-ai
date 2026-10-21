import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { KimiAgentService } from '../dist/domains/cats/services/agents/providers/KimiAgentService.js';
import { isKimiNativeL0ChannelAvailable } from '../dist/domains/cats/services/agents/providers/kimi-l0-agent-file.js';
import { discoverAdditionalRuntimes } from '../dist/routes/native-additional-runtimes.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';
import { resolveKimiCliRuntime } from '../dist/utils/kimi-cli-runtime.js';
import { isolateKimiTestEnvironment } from './helpers/kimi-test-environment.js';
import { collect, createMockArchive } from './helpers/provider-archive-test-helpers.js';

function fixture(t, modern = true) {
  const restore = isolateKimiTestEnvironment();
  const root = mkdtempSync(join(tmpdir(), 'kimi-native-only-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const command of modern ? ['kimi-cli', 'kimi'] : ['kimi-cli']) {
    const file = join(bin, command);
    writeFileSync(file, '#!/bin/sh\nexit 0\n');
    chmodSync(file, 0o755);
  }
  process.env.PATH = bin;
  process.env.KIMI_CODE_HOME = join(root, 'modern');
  process.env.KIMI_SHARE_DIR = join(root, 'legacy');
  for (const [dir, model] of [
    [process.env.KIMI_CODE_HOME, 'modern-model'],
    [process.env.KIMI_SHARE_DIR, 'legacy-model'],
  ]) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'config.toml'), `default_model="${model}"\n`);
  }
  for (const name of ['kimi', 'kimi-cli']) invalidateCliCommand(name);
  t.after(() => {
    restore();
    for (const name of ['kimi', 'kimi-cli']) invalidateCliCommand(name);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, bin };
}

test('discovery and native identity choose Kimi Code when an obsolete shim also exists', (t) => {
  const { root, bin } = fixture(t);
  const found = discoverAdditionalRuntimes(root)[0];
  assert.equal(found.command, join(bin, 'kimi'));
  assert.equal(found.configuredModel, 'modern-model');
  assert.equal(isKimiNativeL0ChannelAvailable(), true);
});

test('an obsolete kimi-cli shim alone is not a supported Kimi installation', (t) => {
  const { root } = fixture(t, false);
  assert.equal(resolveKimiCliRuntime(), null);
  assert.equal(discoverAdditionalRuntimes(root)[0].installed, false);
  assert.equal(isKimiNativeL0ChannelAvailable(), false);
});

test('dispatch uses the native program, native configuration and native identity channel together', async (t) => {
  const { root, bin } = fixture(t);
  let launch;
  const service = new KimiAgentService({
    model: 'selected-model',
    mcpServerPath: '',
    l0CompilerFn: async () => 'owned native identity',
    rawArchive: createMockArchive(),
  });
  const messages = await collect(
    service.invoke('hello', {
      workingDirectory: root,
      systemPrompt: 'owned pack',
      spawnCliOverride: async function* (options) {
        launch = options;
        yield { role: 'assistant', content: '42' };
      },
    }),
  );
  assert.equal(launch.command, join(bin, 'kimi'));
  assert.ok(launch.args.includes('--agent-file'));
  assert.ok(launch.args.includes('-p'));
  assert.ok(!launch.args.includes('--print'));
  assert.ok(!launch.args.includes('--prompt'));
  assert.equal(launch.env.KIMI_CODE_HOME, undefined, 'the existing parent binding is inherited unchanged');
  assert.ok(messages.some((m) => m.type === 'text' && m.content === '42'));
});

test('a zero-exit deprecation banner without a model response cannot become a successful blank turn', async (t) => {
  const { root } = fixture(t);
  const service = new KimiAgentService({
    model: '',
    mcpServerPath: '',
    l0CompilerFn: async () => 'owned native identity',
    rawArchive: createMockArchive(),
  });
  const messages = await collect(
    service.invoke('hello', {
      workingDirectory: root,
      spawnCliOverride: async function* () {
        yield { line: 'kimi-cli is no longer maintained. Please use the new Kimi Code CLI.' };
      },
    }),
  );
  assert.ok(
    messages.some((m) => m.type === 'error'),
    'the invocation must report a failed response',
  );
  assert.equal(messages.at(-1)?.type, 'done');
});
