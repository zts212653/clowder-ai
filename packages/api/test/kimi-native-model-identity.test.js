import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { isolateKimiTestEnvironment } from './helpers/kimi-test-environment.js';
import {
  buildFakeL0Compiler,
  collect,
  createMockArchive,
  createMockProcess,
  createMockSpawnFn,
  emitEvents,
} from './helpers/provider-archive-test-helpers.js';

after(isolateKimiTestEnvironment());

const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
const { invalidateCliCommand } = await import('../dist/utils/cli-resolve.js');

const ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATH',
  'KIMI_CODE_HOME',
  'KIMI_SHARE_DIR',
  'KIMI_CONFIG_FILE',
  'CAT_CAFE_MCP_SERVER_PATH',
];

const NATIVE_MODEL_CONFIG =
  'default_model="fixture-native"\n[models."fixture-native"]\ncapabilities=["thinking","image_in"]\nmax_context_size=424242\n';

/**
 * A native kimi-code fixture that owns the whole HOME/PATH surface.
 * Only `kimi` is planted on PATH, so dispatch resolves the native flavor even
 * when the developer machine has a legacy `kimi-cli` installed.
 */
function nativeKimiFixture(t, { config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kimi-native-model-identity-'));
  const bin = join(root, 'bin');
  const shareDir = join(root, '.kimi-code');
  mkdirSync(bin, { recursive: true });
  mkdirSync(shareDir, { recursive: true });
  const cli = join(bin, 'kimi');
  writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(cli, 0o755);
  if (config !== undefined) writeFileSync(join(shareDir, 'config.toml'), config);
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.APPDATA = root;
  process.env.LOCALAPPDATA = root;
  process.env.PATH = bin;
  process.env.KIMI_CODE_HOME = shareDir;
  delete process.env.KIMI_SHARE_DIR;
  delete process.env.KIMI_CONFIG_FILE;
  process.env.CAT_CAFE_MCP_SERVER_PATH = '';
  invalidateCliCommand('kimi');
  invalidateCliCommand('kimi-cli');
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    invalidateCliCommand('kimi');
    invalidateCliCommand('kimi-cli');
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, shareDir };
}

function registerNativeMember(catId) {
  catRegistry.register(catId, {
    id: catId,
    clientId: 'kimi',
    configurationSource: 'native_tool',
    defaultModel: '',
  });
}

function seedSessionContext(shareDir, sessionId) {
  const dir = join(shareDir, 'sessions', 'fixture-project', sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'context.jsonl'), '{"role":"_usage","token_count":37}\n');
}

async function invokeKimi({ catId, model, workingDirectory, sessionId, callbackEnv }) {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    catId,
    model,
    spawnFn,
    mcpServerPath: '',
    rawArchive: createMockArchive(),
    l0CompilerFn: buildFakeL0Compiler(),
  });
  let preparedRequest;
  const pending = collect(
    service.invoke('hello', {
      workingDirectory,
      ...(callbackEnv ? { callbackEnv } : {}),
      beforeProviderLaunch: async (request) => {
        preparedRequest = request;
      },
    }),
  );
  await emitEvents(proc, [{ role: 'assistant', session_id: sessionId, content: '42' }]);
  const messages = await pending;
  assert.ok(spawnFn.mock.calls.length > 0, 'the CLI must be launched');
  const [, args] = spawnFn.mock.calls[0].arguments;
  return {
    args,
    preparedRequest,
    done: messages.find((message) => message.type === 'done'),
    text: messages.find((message) => message.type === 'text'),
  };
}

beforeEach(() => {
  catRegistry.reset();
  invalidateCliCommand('kimi');
  invalidateCliCommand('kimi-cli');
});

test('native_tool member observes the native config model without injecting --model', async (t) => {
  const { root, shareDir } = nativeKimiFixture(t, { config: NATIVE_MODEL_CONFIG });
  registerNativeMember('native-kimi-observed');
  seedSessionContext(shareDir, 'observed-session');

  const { args, preparedRequest, done, text } = await invokeKimi({
    catId: 'native-kimi-observed',
    model: '',
    workingDirectory: root,
    sessionId: 'observed-session',
  });

  assert.equal(args.includes('--model'), false, 'native selection must keep letting the CLI own --model');
  assert.equal(done?.metadata?.model, 'fixture-native');
  assert.equal(text?.metadata?.model, 'fixture-native');
  assert.equal(preparedRequest?.runtime?.model, 'fixture-native');
  assert.equal(
    done?.metadata?.usage?.contextWindowSize,
    424242,
    'capability/context reads must use the observed model, not the empty selection',
  );
  assert.equal(done?.metadata?.usage?.contextUsedTokens, 37);
});

test('native_tool member without a readable native config keeps a conservative unknown identity', async (t) => {
  const { root } = nativeKimiFixture(t, {});
  registerNativeMember('native-kimi-unknown');

  const { args, preparedRequest, done } = await invokeKimi({
    catId: 'native-kimi-unknown',
    model: '',
    workingDirectory: root,
    sessionId: 'unknown-session',
  });

  assert.equal(args.includes('--model'), false);
  assert.equal(done?.metadata?.model, '');
  assert.equal(preparedRequest?.runtime?.model, undefined, 'unknown identity must not fabricate a model claim');
  assert.equal(done?.metadata?.usage?.contextWindowSize, undefined);
});

test('native_tool member with an explicit model still sends --model and keeps that identity', async (t) => {
  const { root } = nativeKimiFixture(t, { config: NATIVE_MODEL_CONFIG });
  registerNativeMember('native-kimi-explicit');

  const { args, preparedRequest, done } = await invokeKimi({
    catId: 'native-kimi-explicit',
    model: 'fixture-explicit',
    workingDirectory: root,
    sessionId: 'explicit-session',
  });

  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'fixture-explicit']);
  assert.equal(done?.metadata?.model, 'fixture-explicit');
  assert.equal(preparedRequest?.runtime?.model, 'fixture-explicit');
});

test('native_tool member with a request override keeps the override identity', async (t) => {
  const { root } = nativeKimiFixture(t, { config: NATIVE_MODEL_CONFIG });
  registerNativeMember('native-kimi-override');

  const { args, preparedRequest, done } = await invokeKimi({
    catId: 'native-kimi-override',
    model: '',
    workingDirectory: root,
    sessionId: 'override-session',
    callbackEnv: { CAT_CAFE_KIMI_MODEL_OVERRIDE: 'fixture-override' },
  });

  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'fixture-override']);
  assert.equal(done?.metadata?.model, 'fixture-override');
  assert.equal(preparedRequest?.runtime?.model, 'fixture-override');
});

test('non-native member with an empty model keeps the existing no-model behavior', async (t) => {
  const { root } = nativeKimiFixture(t, { config: NATIVE_MODEL_CONFIG });

  const { args, done } = await invokeKimi({
    catId: 'managed-kimi-empty',
    model: '',
    workingDirectory: root,
    sessionId: 'managed-session',
  });

  assert.equal(args.includes('--model'), false);
  assert.equal(done?.metadata?.model, '');
});
