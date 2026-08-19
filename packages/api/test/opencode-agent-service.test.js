import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  OpenCodeAgentService,
  summarizeOpenCodeEnvForDebug,
} from '../dist/domains/cats/services/agents/providers/OpenCodeAgentService.js';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

ensureFakeCliOnPath('opencode');

// ── Mock helpers ──

function createMockProcess(exitCode = 0) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') {
      process.nextTick(() => originalEmit('close', ...args));
    }
    return emitted;
  };
  const proc = {
    stdout,
    stderr,
    pid: 54321,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', exitCode, null);
      });
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

function emitOpenCodeEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();
}

async function collect(iterable) {
  const messages = [];
  for await (const msg of iterable) messages.push(msg);
  return messages;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, description) {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(`timed out waiting for ${description}`);
}

function createOpenCodeRecoveryDb({ sessionId, messageId, text }) {
  const dir = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-db-'));
  const dbPath = join(dir, 'opencode.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    'prt_recovered_text',
    messageId,
    sessionId,
    1780915410601,
    1780915410687,
    JSON.stringify({ type: 'text', text }),
  );
  db.close();
  return dbPath;
}

// ── opencode JSON event fixtures ──

const STEP_START = {
  type: 'step_start',
  timestamp: 1773304958492,
  sessionID: 'ses_test123',
  part: { type: 'step-start', id: 'prt_1', sessionID: 'ses_test123', messageID: 'msg_1' },
};

const TEXT_RESPONSE = {
  type: 'text',
  timestamp: 1773304958494,
  sessionID: 'ses_test123',
  part: { type: 'text', text: 'Hello from opencode!', time: { start: 1773304958493, end: 1773304958493 } },
};
const EMPTY_TEXT_RESPONSE = {
  type: 'text',
  timestamp: 1773304958495,
  sessionID: 'ses_test123',
  part: { type: 'text', text: '' },
};

const TOOL_USE = {
  type: 'tool_use',
  timestamp: 1773304980356,
  sessionID: 'ses_test123',
  part: {
    type: 'tool',
    callID: 'toolu_test1',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'ls', description: 'List files' }, output: 'file.txt' },
  },
};

const STEP_FINISH = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_test123',
  part: {
    type: 'step-finish',
    reason: 'stop',
    cost: 0.036,
    tokens: { total: 36937, input: 36928, output: 9 },
  },
};

const STEP_FINISH_TOOL_CALLS = {
  ...STEP_FINISH,
  part: { ...STEP_FINISH.part, reason: 'tool-calls' },
};

// CodeAgent 3.0 → OpenCode facade: translate script may drop usage, yielding
// step_finish without tokens. This fixture pins the missing-usage alert path.
const STEP_FINISH_NO_TOKENS = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_test123',
  part: { type: 'step-finish', reason: 'stop' },
};

const STEP_FINISH_TOTAL_ONLY = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_test123',
  part: { type: 'step-finish', reason: 'stop', tokens: { total: 36937 } },
};

const STEP_FINISH_OUTPUT_ONLY = {
  type: 'step_finish',
  timestamp: 1773304958508,
  sessionID: 'ses_test123',
  part: { type: 'step-finish', reason: 'stop', tokens: { output: 9 } },
};

const _ERROR_EVENT = {
  type: 'error',
  timestamp: 1773298718314,
  sessionID: 'ses_test123',
  error: { name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429 } },
};

const PERMANENT_PROVIDER_ERROR_EVENT = {
  type: 'error',
  timestamp: 1773298718315,
  sessionID: 'ses_test123',
  error: {
    name: 'APIError',
    data: {
      message: 'No available channel for model claude-sonnet-4-6',
      statusCode: 400,
    },
  },
};

describe('OpenCodeAgentService', () => {
  test('summarizeOpenCodeEnvForDebug reports runtime-config mode and masks secrets', () => {
    const summary = summarizeOpenCodeEnvForDebug({
      OPENCODE_CONFIG: '/tmp/.cat-cafe/oc-config-opencode-inv1/opencode.json',
      CAT_CAFE_OC_API_KEY: 'sk-oc-secret',
      CAT_CAFE_OC_BASE_URL: 'https://maas.example.com/v1',
      ANTHROPIC_API_KEY: null,
      ANTHROPIC_BASE_URL: null,
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
      CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'anthropic/minimax-m2.7',
    });

    assert.equal(summary.mode, 'runtime-config');
    assert.equal(summary.opencodeConfig, '/tmp/.cat-cafe/oc-config-opencode-inv1/opencode.json');
    assert.equal(summary.catCafeOcApiKey, 'sk-oc-***');
    assert.equal(summary.catCafeOcBaseUrl, 'https://maas.example.com/v1');
    assert.equal(summary.anthropicApiKey, '(cleared)');
    assert.equal(summary.anthropicBaseUrl, '(cleared)');
    assert.equal(summary.profileMode, 'api_key');
    assert.equal(summary.modelOverride, 'anthropic/minimax-m2.7');
  });

  test('summarizeOpenCodeEnvForDebug reports direct-env mode without leaking raw keys', () => {
    const summary = summarizeOpenCodeEnvForDebug({
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
      ANTHROPIC_API_KEY: 'sk-direct-secret',
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic/v1',
    });

    assert.equal(summary.mode, 'direct-env');
    assert.equal(summary.opencodeConfig, '(unset)');
    assert.equal(summary.anthropicApiKey, 'sk-dir***');
    assert.equal(summary.anthropicBaseUrl, 'https://api.minimaxi.com/anthropic/v1');
    assert.equal(summary.catCafeOcApiKey, '(unset)');
    assert.equal(summary.catCafeOcBaseUrl, '(unset)');
  });

  test('yields session_init, text, done from opencode events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Say hello'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('session_init'), `expected session_init, got: ${types}`);
    assert.ok(types.includes('text'), `expected text, got: ${types}`);
    assert.ok(types.includes('done'), `expected done, got: ${types}`);

    const textMsg = messages.find((m) => m.type === 'text');
    assert.strictEqual(textMsg.content, 'Hello from opencode!');
    assert.strictEqual(textMsg.catId, 'opencode');
  });

  test('yields tool_use for tool events', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Use tools'));
    emitOpenCodeEvents(proc, [STEP_START, TOOL_USE, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const toolMsg = messages.find((m) => m.type === 'tool_use');
    assert.ok(toolMsg, 'expected tool_use message');
    assert.strictEqual(toolMsg.toolName, 'bash');
  });

  test('drops empty text chunks (prevents blank assistant bubbles)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Say hello'));
    emitOpenCodeEvents(proc, [STEP_START, EMPTY_TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const textMsgs = messages.filter((m) => m.type === 'text');
    assert.equal(textMsgs.length, 0, 'empty text chunk should be ignored');
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'done should still be emitted',
    );
  });

  test('passes --format json and -m model in CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke('Test prompt'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const call = spawnFn.mock.calls[0];
    const args = call.arguments[1];
    assert.ok(args.includes('run'), `expected 'run' in args: ${args}`);
    assert.ok(args.includes('--format') && args.includes('json'), `expected --format json in args: ${args}`);
    const mIdx = args.indexOf('-m');
    assert.ok(mIdx >= 0, `expected -m in args: ${args}`);
    assert.strictEqual(args[mIdx + 1], 'claude-sonnet-4-6');
  });

  test('terminates option parsing before a dash-prefixed prompt', async () => {
    const prompt = '- [navigation]\nTreat this entire value as the user prompt.';
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke(prompt, { cliConfigArgs: ['--title regression'] }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.deepEqual(args.slice(-2), ['--', prompt], `expected option terminator immediately before prompt: ${args}`);
    assert.ok(args.indexOf('--title') < args.indexOf('--'), 'user-defined CLI flags must remain before the terminator');
  });

  test('no-tool finalizer overwrites inherited permissions and scopes its agent config', () => {
    const service = new OpenCodeAgentService({ catId: 'opencode', model: 'claude-sonnet-4-6' });
    const finalizerAgent = 'cat-cafe-no-tool-finalizer-test-nonce';
    const env = service.buildNoToolFinalizerEnv(
      {
        OPENCODE_PERMISSION: JSON.stringify({ '*': 'allow', bash: 'allow' }),
      },
      finalizerAgent,
    );

    const envPermission = JSON.parse(env.OPENCODE_PERMISSION);
    assert.equal(envPermission['*'], 'deny', 'finalizer must override post-config global permission precedence');
    assert.equal(envPermission.bash, 'deny', 'finalizer must explicitly deny executable tools');

    const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(config.default_agent, finalizerAgent);
    assert.equal(config.agent[finalizerAgent].permission['*'], 'deny');
    assert.equal(
      config.agent['cat-cafe-no-tool-finalizer'],
      undefined,
      'an organization config must not be able to target a stable finalizer agent name',
    );
  });

  test('no-tool finalizer terminates option parsing before a dash-prefixed prompt', () => {
    const prompt = '- [navigation]\nTreat this entire value as the finalizer prompt.';
    const finalizerAgent = 'cat-cafe-no-tool-finalizer-test-nonce';
    const service = new OpenCodeAgentService({ catId: 'opencode', model: 'claude-sonnet-4-6' });
    const args = service.buildNoToolFinalizerArgs(prompt, 'ses_test123', 'claude-sonnet-4-6', finalizerAgent);

    assert.equal(args[args.indexOf('--agent') + 1], finalizerAgent);
    assert.deepEqual(args.slice(-2), ['--', prompt], `expected option terminator immediately before prompt: ${args}`);
  });

  test('API key is passed via ANTHROPIC_API_KEY env, not CLI args', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      apiKey: 'sk-test-secret',
    });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('sk-test-secret'), 'secret must not appear in CLI args');

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-test-secret');
  });

  test('subscription mode clears inherited anthropic credentials', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    const previousOpenCodeApiKey = process.env.OPENCODE_API_KEY;
    const previousOpenCodeBaseUrl = process.env.OPENCODE_BASE_URL;
    process.env.ANTHROPIC_API_KEY = 'sk-parent-anthropic';
    process.env.ANTHROPIC_BASE_URL = 'https://parent.anthropic.example/v1';
    process.env.OPENCODE_API_KEY = 'sk-parent-opencode';
    process.env.OPENCODE_BASE_URL = 'https://parent.opencode.example';

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      apiKey: 'sk-should-not-leak',
      baseUrl: 'https://proxy.example/v1',
    });
    try {
      const promise = collect(
        service.invoke('Test', {
          callbackEnv: {
            CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
          },
        }),
      );
      emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
      await promise;

      const opts = spawnFn.mock.calls[0].arguments[2];
      assert.strictEqual(opts.env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, undefined);
      assert.strictEqual(opts.env.OPENCODE_API_KEY, undefined);
      assert.strictEqual(opts.env.OPENCODE_BASE_URL, undefined);
    } finally {
      if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
      if (previousOpenCodeApiKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousOpenCodeApiKey;
      if (previousOpenCodeBaseUrl === undefined) delete process.env.OPENCODE_BASE_URL;
      else process.env.OPENCODE_BASE_URL = previousOpenCodeBaseUrl;
    }
  });

  // F203 Phase I: instructions-only config preserves native auth
  test('F203-I: OPENCODE_CONFIG + OC_INSTRUCTIONS_ONLY preserves ANTHROPIC_API_KEY', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      apiKey: 'sk-native-key',
    });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: {
          OPENCODE_CONFIG: '/tmp/instructions-only.json',
          CAT_CAFE_OC_INSTRUCTIONS_ONLY: '1',
          CAT_CAFE_ANTHROPIC_API_KEY: 'sk-native-key',
        },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    // With OC_INSTRUCTIONS_ONLY_ENV=1, buildEnv must NOT clear auth.
    // ANTHROPIC_API_KEY should survive (from apiKey constructor arg or callbackEnv).
    assert.strictEqual(
      opts.env.ANTHROPIC_API_KEY,
      'sk-native-key',
      'instructions-only config must preserve ANTHROPIC_API_KEY',
    );
    assert.strictEqual(
      opts.env.OPENCODE_CONFIG,
      '/tmp/instructions-only.json',
      'OPENCODE_CONFIG must be passed through',
    );
  });

  // F203 Phase I: full custom-provider config STILL clears native auth (regression guard)
  test('F203-I: OPENCODE_CONFIG without OC_INSTRUCTIONS_ONLY still clears auth', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-parent-should-clear';

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });
    try {
      const promise = collect(
        service.invoke('Test', {
          callbackEnv: {
            OPENCODE_CONFIG: '/tmp/full-provider-config.json',
            // NO OC_INSTRUCTIONS_ONLY — this is a full custom provider config
          },
        }),
      );
      emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
      await promise;

      const opts = spawnFn.mock.calls[0].arguments[2];
      // Full custom-provider config: auth MUST be cleared (clowder-ai#223 behavior preserved)
      assert.strictEqual(opts.env.ANTHROPIC_API_KEY, undefined, 'full provider config must clear ANTHROPIC_API_KEY');
    } finally {
      if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
  });

  // F203 Phase I: subscription + instructions-only → subscription clears auth (priority)
  test('F203-I: subscription + OC_INSTRUCTIONS_ONLY → subscription still clears inherited auth', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-inherited-should-clear';

    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
    });
    try {
      const promise = collect(
        service.invoke('Test', {
          callbackEnv: {
            OPENCODE_CONFIG: '/tmp/instructions-only.json',
            CAT_CAFE_OC_INSTRUCTIONS_ONLY: '1',
            CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
          },
        }),
      );
      emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
      await promise;

      const opts = spawnFn.mock.calls[0].arguments[2];
      // Instructions-only skips the OPENCODE_CONFIG auth clear block,
      // but subscription mode still independently clears inherited auth.
      assert.strictEqual(
        opts.env.ANTHROPIC_API_KEY,
        undefined,
        'subscription must clear inherited ANTHROPIC_API_KEY even with instructions-only',
      );
      assert.strictEqual(opts.env.OPENCODE_CONFIG, '/tmp/instructions-only.json', 'OPENCODE_CONFIG must survive');
    } finally {
      if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
  });

  test('baseUrl passed via ANTHROPIC_BASE_URL env', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'claude-haiku-4-5',
      baseUrl: 'https://proxy.example/v1',
    });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, 'https://proxy.example/v1');
  });

  test('cwd is workingDirectory', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test', { workingDirectory: '/tmp/project' }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.cwd, '/tmp/project');
  });

  test('does not put invocation workspace into the parent OpenCode env', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test', { workingDirectory: '/tmp/project' }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(
      opts.env.ALLOWED_WORKSPACE_DIRS,
      undefined,
      'mcp.cat-cafe.environment in OPENCODE_CONFIG is the workspace source of truth',
    );
  });

  test('does not let stale account ALLOWED_WORKSPACE_DIRS override the invocation workspace', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        workingDirectory: '/tmp/project',
        accountEnv: { ALLOWED_WORKSPACE_DIRS: '/stale/account/workspace' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(
      opts.env.ALLOWED_WORKSPACE_DIRS,
      undefined,
      'OpenCode parent env must not carry a stale workspace; mcp.cat-cafe.environment is the authoritative child env',
    );
  });

  test('yields error + done on CLI exit failure', async () => {
    const proc = createMockProcess(1);
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    proc.stdout.end();
    emitProcessExit(proc, 1, null);
    const messages = await promise;

    const types = messages.map((m) => m.type);
    assert.ok(types.includes('error'), `expected error in types: ${types}`);
    assert.ok(types.includes('done'), `expected done in types: ${types}`);
  });

  test('terminates a retrying CLI after a permanent provider configuration error', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const collection = collect(service.invoke('Test', { invocationId: 'inv-permanent-error' }));

    proc.stdout.write(`${JSON.stringify(PERMANENT_PROVIDER_ERROR_EVENT)}\n`);

    try {
      const messages = await Promise.race([
        collection,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('permanent provider error did not terminate the retrying CLI')), 250);
        }),
      ]);

      assert.equal(proc.kill.mock.callCount(), 1, 'the CLI process must be terminated exactly once');
      assert.equal(messages.filter((message) => message.type === 'error').length, 1);
      assert.equal(messages.filter((message) => message.type === 'done').length, 1);
      assert.match(messages.find((message) => message.type === 'error').error, /No available channel/);
    } finally {
      if (proc.kill.mock.callCount() === 0) proc.kill();
    }
  });

  test('terminates a retrying CLI after an auth status even when the provider omits a message', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const collection = collect(service.invoke('Test', { invocationId: 'inv-auth-error' }));

    proc.stdout.write(
      `${JSON.stringify({
        type: 'error',
        timestamp: 1773298718316,
        sessionID: 'ses_test123',
        error: { name: 'AuthError', data: { statusCode: 401 } },
      })}\n`,
    );

    try {
      const messages = await Promise.race([
        collection,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('auth status did not terminate the retrying CLI')), 250);
        }),
      ]);
      assert.equal(proc.kill.mock.callCount(), 1);
      assert.equal(messages.filter((message) => message.type === 'error').length, 1);
      assert.equal(messages.filter((message) => message.type === 'done').length, 1);
      assert.equal(
        messages.find((message) => message.type === 'error').metadata.cliDiagnostics.reasonCode,
        'auth_failed',
      );
    } finally {
      if (proc.kill.mock.callCount() === 0) proc.kill();
    }
  });

  test('does not terminate a CLI for a transient provider error', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const collection = collect(service.invoke('Test'));

    emitOpenCodeEvents(proc, [_ERROR_EVENT, STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await collection;

    assert.equal(proc.kill.mock.callCount(), 0, 'natural completion after a transient error must not be killed');
    assert.equal(messages.filter((message) => message.type === 'error').length, 1);
    assert.ok(messages.some((message) => message.type === 'text'));
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });

  test('metadata includes provider=opencode and model', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg.metadata);
    assert.strictEqual(textMsg.metadata.provider, 'opencode');
    assert.strictEqual(textMsg.metadata.model, 'claude-sonnet-4-6');
  });

  test('step_finish yields agent_loop with usage AND service-level model (clowder#915 R1 P1)', async () => {
    // 砚砚 R1 P1 (#2271): transformer carries metadata.usage but pre-fix the
    // service layer's `metadata: yieldMetadata` clobbered the transformer's
    // metadata via spread-with-override. Without this merge, usage never
    // reached invoke-single-cat → F24 contextHealth never fired → handoff
    // never triggered → opencode hung at context limit (the clowder#915 bug).
    //
    // This test asserts the END-TO-END contract: step_finish → service yield →
    // a yielded message that carries BOTH (a) the usage payload from the
    // transformer AND (b) the effective model from the service layer (not '').
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [
      STEP_START,
      TEXT_RESPONSE,
      {
        type: 'step_finish',
        timestamp: 1773304958508,
        sessionID: 'ses_test123',
        part: {
          type: 'step-finish',
          reason: 'stop',
          cost: 0.036973,
          tokens: { total: 36937, input: 36928, output: 9 },
        },
      },
    ]);
    const messages = await promise;

    const loopMsg = messages.find((m) => m.type === 'agent_loop');
    assert.ok(loopMsg, 'service must emit agent_loop for step_finish events');
    assert.ok(loopMsg.metadata, 'agent_loop must carry metadata');
    // usage from transformer must survive the service layer's metadata override
    assert.ok(loopMsg.metadata.usage, 'usage must reach invoke-single-cat for F8/F24 to fire');
    assert.strictEqual(loopMsg.metadata.usage.inputTokens, 36928);
    assert.strictEqual(loopMsg.metadata.usage.lastTurnInputTokens, 36928);
    assert.strictEqual(loopMsg.metadata.usage.outputTokens, 9);
    assert.strictEqual(loopMsg.metadata.usage.totalTokens, 36937);
    assert.strictEqual(loopMsg.metadata.usage.costUsd, 0.036973);
    // model comes from the service layer (effectiveModel), NOT transformer's ''
    // (砚砚 R1 P2: empty model would break getContextWindowFallback in invoke-single-cat).
    assert.strictEqual(loopMsg.metadata.model, 'claude-sonnet-4-6');
    assert.strictEqual(loopMsg.metadata.provider, 'opencode');
  });

  test('metadata.sessionId set after session_init', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const doneMsg = messages.find((m) => m.type === 'done');
    assert.strictEqual(doneMsg.metadata.sessionId, 'ses_test123');
  });

  test('session resume passes --session and --continue', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Continue', { sessionId: 'ses_prev' }));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const sIdx = args.indexOf('--session');
    assert.ok(sIdx >= 0, `expected --session in args: ${args}`);
    assert.strictEqual(args[sIdx + 1], 'ses_prev');
  });

  test('always yields exactly one final done', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Test'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const doneMessages = messages.filter((m) => m.type === 'done');
    assert.strictEqual(doneMessages.length, 1, `expected exactly 1 done, got ${doneMessages.length}`);
  });

  // ── P1-2: CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE via callbackEnv ──

  test('callbackEnv MODEL_OVERRIDE overrides constructor model in -m arg', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-sonnet-4-6' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'claude-haiku-4-5' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mIdx = args.indexOf('-m');
    assert.strictEqual(
      args[mIdx + 1],
      'claude-haiku-4-5',
      `expected model override to be used, got: ${args[mIdx + 1]}`,
    );
  });

  // ── Base URL passthrough: no /v1 auto-append ──

  test('callbackEnv CAT_CAFE_ANTHROPIC_BASE_URL is passed through as-is', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9877/a247a834' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(
      opts.env.ANTHROPIC_BASE_URL,
      'http://127.0.0.1:9877/a247a834',
      'base URL should be passed through without modification',
    );
  });

  test('callbackEnv BASE_URL with trailing /v1 is preserved as-is', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: { CAT_CAFE_ANTHROPIC_BASE_URL: 'http://127.0.0.1:9877/slug/v1' },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(
      opts.env.ANTHROPIC_BASE_URL,
      'http://127.0.0.1:9877/slug/v1',
      'explicit /v1 should be preserved',
    );
  });

  // ── P2-1: multiple step_start should NOT produce multiple session_init ──

  test('multiple step_start events yield only one session_init', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const STEP_START_2 = { ...STEP_START, timestamp: STEP_START.timestamp + 5000 };
    const promise = collect(service.invoke('Multi-step'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH, STEP_START_2, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const sessionInits = messages.filter((m) => m.type === 'session_init');
    assert.strictEqual(
      sessionInits.length,
      1,
      `expected exactly 1 session_init, got ${sessionInits.length} — multi-step runs must not produce duplicate session events`,
    );
  });

  // ── clowder-ai#223: OPENCODE_CONFIG passthrough clears anthropic env vars ──

  test('OPENCODE_CONFIG in callbackEnv clears ANTHROPIC env vars', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'maas/glm-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: {
          OPENCODE_CONFIG: '/tmp/.cat-cafe/oc-config-test-inv1/opencode.json',
          CAT_CAFE_OC_API_KEY: 'sk-custom-key',
          CAT_CAFE_OC_BASE_URL: 'https://maas.example.com/v1',
          CAT_CAFE_ANTHROPIC_API_KEY: 'sk-should-be-cleared',
          CAT_CAFE_ANTHROPIC_BASE_URL: 'https://should-be-cleared.example.com',
        },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    // OPENCODE_CONFIG and OC credentials must be present
    assert.strictEqual(opts.env.OPENCODE_CONFIG, '/tmp/.cat-cafe/oc-config-test-inv1/opencode.json');
    assert.strictEqual(opts.env.CAT_CAFE_OC_API_KEY, 'sk-custom-key');
    assert.strictEqual(opts.env.CAT_CAFE_OC_BASE_URL, 'https://maas.example.com/v1');
    // Anthropic env vars must be cleared to prevent builtin provider conflict
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, undefined);
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, undefined);
    assert.strictEqual(opts.env.OPENCODE_API_KEY, undefined);
    assert.strictEqual(opts.env.OPENCODE_BASE_URL, undefined);
  });

  test('without OPENCODE_CONFIG, anthropic env vars are still set normally', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(
      service.invoke('Test', {
        callbackEnv: {
          CAT_CAFE_ANTHROPIC_API_KEY: 'sk-normal-key',
          CAT_CAFE_ANTHROPIC_BASE_URL: 'https://proxy.example.com/v1',
        },
      }),
    );
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    await promise;

    const opts = spawnFn.mock.calls[0].arguments[2];
    assert.strictEqual(opts.env.ANTHROPIC_API_KEY, 'sk-normal-key');
    assert.strictEqual(opts.env.ANTHROPIC_BASE_URL, 'https://proxy.example.com/v1');
  });

  // F212 Phase A (砚砚 review BLOCKED P1-2 fix): cliDiagnostics must flow from
  // spawnCli __cliError → provider yield error.metadata.cliDiagnostics
  // so frontend folded panel (Phase B) can render reasonCode / safeExcerpt / publicHint.
  test('F212: forwards cliDiagnostics on metadata when CLI errors (issue #777 reproducer)', async () => {
    const proc = createMockProcess(1);
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'deepseek-v-4' });

    const promise = collect(service.invoke('Test'));
    // Real-world issue #777 case: opencode emits a NDJSON error event for DeepSeek 400 model_not_found
    proc.stdout.write(
      `${JSON.stringify({
        type: 'error',
        error: {
          name: 'APIError',
          data: {
            message:
              'The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-v-4.',
            statusCode: 400,
          },
        },
      })}\n`,
    );
    proc.stdout.end();
    emitProcessExit(proc, 1, null);
    const messages = await promise;

    // Two error messages may be yielded: (1) stream error event (transform-time, cli still running),
    // (2) cli-spawn __cliError (after exit 1). Both should carry cliDiagnostics; pick any.
    const errorsWithCD = messages.filter((m) => m.type === 'error' && m.metadata?.cliDiagnostics);
    assert.ok(
      errorsWithCD.length >= 1,
      `at least one error message must carry cliDiagnostics. all messages=${JSON.stringify(messages.map((m) => ({ type: m.type, hasCD: !!m.metadata?.cliDiagnostics })))}`,
    );
    // All cliDiagnostics-bearing errors must classify correctly (same rawText source)
    for (const e of errorsWithCD) {
      assert.strictEqual(e.metadata.cliDiagnostics.reasonCode, 'model_not_found');
      assert.ok(
        e.metadata.cliDiagnostics.safeExcerpt?.includes('deepseek-v4-pro'),
        `safeExcerpt should include matched line: ${e.metadata.cliDiagnostics.safeExcerpt}`,
      );
      assert.match(e.metadata.cliDiagnostics.publicSummary, /模型/);
      assert.ok(e.metadata.cliDiagnostics.publicHint.length > 0);
      assert.ok(e.metadata.cliDiagnostics.debugRef, 'debugRef must be present');
      // command may be 'opencode' (stream error path) OR a resolved absolute path (cli-spawn __cliError path)
      assert.ok(
        e.metadata.cliDiagnostics.debugRef.command.includes('opencode'),
        `debugRef.command should reference opencode: ${e.metadata.cliDiagnostics.debugRef.command}`,
      );
    }
  });

  // F212 Phase G (AC-G3, clowder-ai#875): silent-stdout case where OpenCode produces
  // only step_start events and no text. Reporter's direct OpenCode CLI checks proved
  // this is upstream behavior (fresh CLI reproduces), so Clowder AI responsibility is
  // surfacing the diagnostic instead of swallowing it into generic message.
  test('AC-G3: step_start-only NDJSON → yields system_info notice with silent_completion cliDiagnostics', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'deepseek-chat',
    });
    const promise = collect(service.invoke('Test silent', { invocationId: 'inv-silent-clowder-875' }));
    proc.stderr.write('Warning: upstream stderr without text output\n');
    // Emit only step_start — exactly the clowder-ai#875 reporter's NDJSON
    emitOpenCodeEvents(proc, [STEP_START]);
    const messages = await promise;

    // Find the user-visible system notice carrying the silent_completion diagnostic.
    const silentNotice = messages.find(
      (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
    );
    assert.ok(
      silentNotice,
      `expected system_info notice with silent_completion reasonCode; got types: ${messages.map((m) => m.type).join(',')}`,
    );
    assert.equal(JSON.parse(silentNotice.content).type, 'silent_completion');
    assert.ok(
      !messages.some((m) => m.type === 'error' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
      'silent_completion is observability-only and MUST NOT travel as provider error',
    );
    assert.equal(silentNotice.metadata.cliDiagnostics.debugRef.invocationId, 'inv-silent-clowder-875');
    assert.equal(
      silentNotice.metadata.cliDiagnostics.debugRef.exitCode,
      0,
      'silent_completion preserves clean exit code',
    );

    const evidence = JSON.parse(silentNotice.metadata.cliDiagnostics.safeExcerpt);
    assert.ok(
      evidence.eventTypes.includes('step_start'),
      `eventTypes should include step_start: ${JSON.stringify(evidence.eventTypes)}`,
    );
    assert.ok(evidence.eventCount >= 1, 'eventCount should be > 0');
    assert.equal(evidence.model, 'deepseek-chat', 'model captured');
    assert.equal(evidence.stderrPresent, true, 'successful-exit stderr presence is preserved');
    assert.match(
      evidence.stderrExcerpt,
      /upstream stderr without text output/,
      'successful-exit stderr excerpt is preserved for diagnostics',
    );
    // sessionId comes through session_init, then truncated to first 8 chars
    if (evidence.sessionIdPrefix) {
      assert.equal(
        evidence.sessionIdPrefix.length,
        8,
        'sessionIdPrefix MUST be exactly 8 chars (no full session leak)',
      );
    }
    // Done event still yielded so caller can complete
    assert.ok(
      messages.some((m) => m.type === 'done'),
      'done event still yielded after diagnostic',
    );
  });

  test('step_start-only NDJSON recovers assistant text from OpenCode SQLite by session/message id', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const dbPath = createOpenCodeRecoveryDb({
      sessionId: STEP_START.sessionID,
      messageId: STEP_START.part.messageID,
      text: 'Recovered from OpenCode SQLite.',
    });
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'deepseek-chat',
      opencodeDbPath: dbPath,
    });
    const promise = collect(service.invoke('Test silent', { invocationId: 'inv-silent-sqlite-recovery' }));

    emitOpenCodeEvents(proc, [STEP_START]);
    const messages = await promise;

    const recovered = messages.find((m) => m.type === 'text');
    assert.equal(recovered?.content, 'Recovered from OpenCode SQLite.');
    assert.ok(
      !messages.some((m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
      'SQLite recovery supplies text, so silent_completion must not fire',
    );
  });

  test('AC-G3: text event present → does NOT yield silent_completion (no false positive)', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Say hello'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const silentError = messages.find(
      (m) => m.type === 'error' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
    );
    assert.ok(!silentError, 'silent_completion MUST NOT fire when text event present');
    const silentNotice = messages.find(
      (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
    );
    assert.ok(!silentNotice, 'silent_completion system_info MUST NOT fire when text event present');
  });

  // F212 Phase G R1 P1 (cloud codex catch on 1d519e7f2): tool-only turns are legitimate
  // task completions per F215 AC-B3. Tool events must not be mislabeled as
  // silent_completion and must not be routed through the post-tool finalizer.
  test('AC-G3 R1 P1: pure tool_use completion is preserved without silent_completion or finalizer', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [
            STEP_START,
            { ...TEXT_RESPONSE, part: { ...TEXT_RESPONSE.part, text: 'unexpected finalizer text' } },
            STEP_FINISH,
          ]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-haiku-4-5' });
    const promise = collect(service.invoke('Use tools'));
    // step_start + tool_use only — no TEXT_RESPONSE from the main CLI invocation.
    // This is not a provider error, but users still need final assistant text.
    emitOpenCodeEvents(proc, [STEP_START, TOOL_USE, STEP_FINISH]);
    const messages = await promise;
    const textMsgs = messages.filter((m) => m.type === 'text');

    const silentError = messages.find(
      (m) => m.type === 'error' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
    );
    assert.ok(
      !silentError,
      `silent_completion MUST NOT fire when tool_use event present (R1 P1 guard): types=${messages.map((m) => m.type).join(',')}`,
    );
    const silentNotice = messages.find(
      (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
    );
    assert.ok(
      !silentNotice,
      `silent_completion system_info MUST NOT fire when tool_use event present (R1 P1 guard): types=${messages.map((m) => m.type).join(',')}`,
    );
    // Verify the tool_use was actually yielded (sanity check on fixture)
    assert.ok(
      messages.some((m) => m.type === 'tool_use'),
      'tool_use yield confirms event reached transformer',
    );
    assert.equal(spawnCalls, 1, 'pure tool-only completion must not start a no-tool finalizer invocation');
    assert.equal(textMsgs.length, 0, 'pure tool-only completion remains non-user-visible text');
  });

  // Issue #1208: CodeAgent 3.0 → OpenCode translate may drop token usage.
  // When the CLI produces events but no step_finish carries tokens, auto-handoff
  // based on context fill cannot fire. The service must surface a persistent
  // visible alert so users know automatic handoff is unavailable.
  test('post-tool completion gap runs a no-tool finalizer and replaces the incomplete prelude', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [
            STEP_START,
            {
              ...TEXT_RESPONSE,
              part: { ...TEXT_RESPONSE.part, text: 'The active model is deepseek-v4-pro.' },
            },
            STEP_FINISH,
          ]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'deepseek-v4-pro' });
    const promise = collect(service.invoke('Check the active model and report it'));

    emitOpenCodeEvents(proc, [
      STEP_START,
      {
        ...TEXT_RESPONSE,
        part: { ...TEXT_RESPONSE.part, text: 'Let me verify from the actual config rather than guessing.' },
      },
      {
        ...TOOL_USE,
        part: {
          ...TOOL_USE.part,
          tool: 'read',
          state: {
            status: 'completed',
            input: { filePath: '.cat-cafe/cat-catalog.json', offset: 210, limit: 50 },
            output: '"defaultModel": "deepseek-v4-pro"',
          },
        },
      },
      STEP_FINISH_TOOL_CALLS,
    ]);

    const messages = await promise;
    const textMsgs = messages.filter((m) => m.type === 'text');

    assert.equal(spawnCalls, 2, 'post-tool gap should start exactly one no-tool finalizer invocation');
    const finalizerArgs = spawnFn.mock.calls[1].arguments[1];
    assert.ok(finalizerArgs.includes('--session'), `finalizer must resume the same OpenCode session: ${finalizerArgs}`);
    assert.equal(finalizerArgs[finalizerArgs.indexOf('--session') + 1], 'ses_test123');
    assert.ok(finalizerArgs.includes('--agent'), `finalizer must use a dedicated no-tool agent: ${finalizerArgs}`);
    const finalizerAgent = finalizerArgs[finalizerArgs.indexOf('--agent') + 1];
    assert.match(
      finalizerAgent,
      /^cat-cafe-no-tool-finalizer-[0-9a-f-]{36}$/,
      'finalizer agent name must be invocation-scoped so post-inline organization config cannot target it',
    );
    const finalizerEnv = spawnFn.mock.calls[1].arguments[2].env;
    const finalizerConfig = JSON.parse(finalizerEnv.OPENCODE_CONFIG_CONTENT);
    assert.equal(finalizerConfig.permission['*'], 'deny', 'finalizer env must deny tool execution');
    assert.equal(
      finalizerConfig.agent[finalizerAgent].permission['*'],
      'deny',
      'dedicated finalizer agent must deny tool execution',
    );
    assert.equal(
      JSON.parse(finalizerEnv.OPENCODE_PERMISSION)['*'],
      'deny',
      'finalizer must override permission env loaded after organization and managed config',
    );
    assert.equal(textMsgs.length, 2, 'finalizer should add one replacement text after the incomplete prelude');
    assert.equal(textMsgs[0].content, 'Let me verify from the actual config rather than guessing.');
    assert.equal(textMsgs.at(-1)?.textMode, 'replace');
    assert.equal(textMsgs.at(-1)?.content, 'The active model is deepseek-v4-pro.');
    assert.ok(
      !messages.some((m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
      'post-tool finalizer is a recovery, not silent_completion',
    );
  });

  test('post-tool step_finish stop still runs one finalizer and replaces the incomplete prelude', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [
            STEP_START,
            { ...TEXT_RESPONSE, part: { ...TEXT_RESPONSE.part, text: 'Recovered final answer.' } },
            STEP_FINISH,
          ]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'deepseek-v4-pro' });
    const promise = collect(service.invoke('Inspect the config and report the result'));

    emitOpenCodeEvents(proc, [
      STEP_START,
      { ...TEXT_RESPONSE, part: { ...TEXT_RESPONSE.part, text: 'Let me inspect that.' } },
      {
        ...TOOL_USE,
        part: { ...TOOL_USE.part, tool: 'read', state: { status: 'completed', output: 'config loaded' } },
      },
      STEP_FINISH,
    ]);

    const messages = await promise;
    const textMsgs = messages.filter((m) => m.type === 'text');

    assert.equal(spawnCalls, 2, 'reason=stop after tool_use is not proof of user-visible completion');
    assert.equal(textMsgs.at(-1)?.textMode, 'replace');
    assert.equal(textMsgs.at(-1)?.content, 'Recovered final answer.');
  });

  test('post-tool finalizer tool attempt poisons later text and falls back safely', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [
            STEP_START,
            {
              ...TOOL_USE,
              part: { ...TOOL_USE.part, tool: 'read', state: { status: 'completed', input: {}, output: 'forbidden' } },
            },
            {
              ...TEXT_RESPONSE,
              part: { ...TEXT_RESPONSE.part, text: 'accepted-after-tool' },
            },
            STEP_FINISH,
          ]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'deepseek-v4-pro' });
    const promise = collect(service.invoke('Check the active model and report it'));

    emitOpenCodeEvents(proc, [
      STEP_START,
      {
        ...TEXT_RESPONSE,
        part: { ...TEXT_RESPONSE.part, text: 'Let me check that.' },
      },
      {
        ...TOOL_USE,
        part: { ...TOOL_USE.part, tool: 'read', state: { status: 'completed', output: 'model=deepseek-v4-pro' } },
      },
      STEP_FINISH_TOOL_CALLS,
    ]);

    const messages = await promise;
    const textMsgs = messages.filter((m) => m.type === 'text');

    assert.equal(spawnCalls, 2);
    assert.ok(
      !textMsgs.some((m) => m.content === 'accepted-after-tool'),
      'any finalizer tool_use must poison the whole finalizer result before later text is accepted',
    );
    assert.equal(textMsgs.at(-1)?.textMode, 'replace');
    assert.match(String(textMsgs.at(-1)?.content), /tool_use_blocked/);
  });

  test('post-tool finalizer fails closed before spawn when managed OpenCode config can override permissions', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    const managedConfigPath = join(mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-managed-')), 'opencode.json');
    writeFileSync(managedConfigPath, JSON.stringify({ permission: { '*': 'allow' } }), 'utf8');
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [
            STEP_START,
            { ...TEXT_RESPONSE, part: { ...TEXT_RESPONSE.part, text: 'managed override would have run' } },
            STEP_FINISH,
          ]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      spawnFn,
      model: 'deepseek-v4-pro',
      opencodeManagedConfigPaths: [managedConfigPath],
    });
    const promise = collect(service.invoke('Check the active model and report it'));

    emitOpenCodeEvents(proc, [
      STEP_START,
      {
        ...TEXT_RESPONSE,
        part: { ...TEXT_RESPONSE.part, text: 'Let me check that.' },
      },
      {
        ...TOOL_USE,
        part: { ...TOOL_USE.part, tool: 'read', state: { status: 'completed', output: 'model=deepseek-v4-pro' } },
      },
      STEP_FINISH_TOOL_CALLS,
    ]);

    const messages = await promise;
    const textMsgs = messages.filter((m) => m.type === 'text');

    assert.equal(
      spawnCalls,
      1,
      'managed config precedence must block finalizer before a second OpenCode process starts',
    );
    assert.equal(textMsgs.at(-1)?.textMode, 'replace');
    assert.match(String(textMsgs.at(-1)?.content), /managed_config_present/);
  });

  test('post-tool deterministic fallback omits raw tool output entirely', async () => {
    const proc = createMockProcess();
    const finalizerProc = createMockProcess();
    let spawnCalls = 0;
    const spawnFn = mock.fn(() => {
      spawnCalls++;
      if (spawnCalls === 2) {
        process.nextTick(() => {
          emitOpenCodeEvents(finalizerProc, [STEP_START, STEP_FINISH]);
        });
        return finalizerProc;
      }
      return proc;
    });
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'deepseek-v4-pro' });
    const promise = collect(service.invoke('Read config'));

    emitOpenCodeEvents(proc, [
      STEP_START,
      {
        ...TEXT_RESPONSE,
        part: { ...TEXT_RESPONSE.part, text: 'Reading config.' },
      },
      {
        ...TOOL_USE,
        part: {
          ...TOOL_USE.part,
          tool: 'read',
          state: {
            status: 'completed',
            output:
              'token=sk-review-secret-123 path=C:\\Users\\Alice\\secrets\\config.json also /home/user/.ssh/id_rsa',
          },
        },
      },
      STEP_FINISH_TOOL_CALLS,
    ]);

    const messages = await promise;
    const fallback = messages.filter((m) => m.type === 'text').at(-1);
    const content = String(fallback?.content);

    assert.equal(spawnCalls, 2);
    assert.equal(fallback?.textMode, 'replace');
    assert.doesNotMatch(content, /sk-review-secret/);
    assert.doesNotMatch(content, /C:\\Users\\Alice/);
    assert.doesNotMatch(content, /\/Users\/alice/);
    assert.doesNotMatch(content, /Latest tool output/);
    assert.match(content, /not included in this user-visible fallback/i);
  });

  test('same OpenCode session invocations are serialized through finalization', async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const releases = [];
    const spawnCliOverride = async function* () {
      active++;
      started++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => releases.push(resolve));
      yield STEP_START;
      yield TEXT_RESPONSE;
      yield STEP_FINISH;
      active--;
    };
    const service = new OpenCodeAgentService({
      catId: 'opencode',
      model: 'deepseek-v4-pro',
      spawnFn: mock.fn(() => {
        throw new Error('spawnCliOverride must own this test');
      }),
    });
    const first = collect(service.invoke('first', { sessionId: 'ses_shared', spawnCliOverride }));
    const second = collect(service.invoke('second', { sessionId: 'ses_shared', spawnCliOverride }));

    await waitFor(() => started >= 1, 'first session process to start');
    await delay(20);
    assert.equal(maxActive, 1, 'second same-session invoke must not spawn before first completes');
    releases[0]();
    await first;

    await waitFor(() => started === 2, 'second session process to start after first completes');
    releases[1]();
    await second;

    assert.equal(maxActive, 1, 'same-session invokes must remain single-flight');
  });

  test('issue #1208: opencode events without usage telemetry yield warning alert', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-opus-4-6' });
    const promise = collect(service.invoke('Long session'));
    // Simulate a CodeAgent translate that emits the opencode facade shape
    // but omits token counts on step_finish.
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH_NO_TOKENS]);
    const messages = await promise;

    const alert = messages.find((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'warning';
      } catch {
        return false;
      }
    });
    assert.ok(
      alert,
      `expected warning system_info when no usage telemetry; got types: ${messages.map((m) => m.type).join(',')}`,
    );
    const payload = JSON.parse(alert.content);
    assert.ok(payload.message, 'alert must include human-readable message');
    assert.ok(payload.message.includes('token 用量'), 'message should mention missing token usage');

    // Sanity: no usage-bearing agent_loop was produced.
    const usageLoops = messages.filter((m) => m.type === 'agent_loop' && m.metadata?.usage);
    assert.strictEqual(usageLoops.length, 0, 'no usage should reach invoke-single-cat');
  });

  test('issue #1208: successful zero-event completion still yields the missing-usage warning', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-opus-4-6' });
    const promise = collect(service.invoke('Empty successful run'));
    emitOpenCodeEvents(proc, []);
    const messages = await promise;

    const warnings = messages.filter((message) => {
      if (message.type !== 'system_info') return false;
      try {
        return JSON.parse(message.content).type === 'warning';
      } catch {
        return false;
      }
    });
    assert.equal(warnings.length, 1, 'a zero-event success has no usage evidence and must warn durably');
    assert.match(JSON.parse(warnings[0].content).message, /token 用量/);
  });

  test('issue #1208: usage-bearing step_finish does NOT yield warning alert', async () => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-opus-4-6' });
    const promise = collect(service.invoke('Normal session'));
    emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, STEP_FINISH]);
    const messages = await promise;

    const alert = messages.find((m) => {
      if (m.type !== 'system_info') return false;
      try {
        return JSON.parse(m.content).type === 'warning';
      } catch {
        return false;
      }
    });
    assert.ok(!alert, 'usage warning MUST NOT fire when usage telemetry is present');
  });

  for (const [label, partialUsageEvent] of [
    ['total-only', STEP_FINISH_TOTAL_ONLY],
    ['output-only', STEP_FINISH_OUTPUT_ONLY],
  ]) {
    test(`issue #1208: ${label} usage still yields warning alert`, async () => {
      const proc = createMockProcess();
      const spawnFn = mock.fn(() => proc);
      const service = new OpenCodeAgentService({ catId: 'opencode', spawnFn, model: 'claude-opus-4-6' });
      const promise = collect(service.invoke('Partial telemetry'));
      emitOpenCodeEvents(proc, [STEP_START, TEXT_RESPONSE, partialUsageEvent]);
      const messages = await promise;

      const alert = messages.find((m) => {
        if (m.type !== 'system_info') return false;
        try {
          return JSON.parse(m.content).type === 'warning';
        } catch {
          return false;
        }
      });
      assert.ok(alert, `${label} usage cannot drive context-fill handoff; warning must still fire`);
    });
  }
});
