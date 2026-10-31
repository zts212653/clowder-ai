import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';
import { isolateKimiTestEnvironment } from './helpers/kimi-test-environment.js';
import { waitForMockProcessReady } from './helpers/mock-process-lifecycle.js';
import { emitEvents as emitKimiEvents } from './helpers/provider-archive-test-helpers.js';

after(isolateKimiTestEnvironment());

// Ensure `kimi` (new kimi-code) and `kimi-cli` (legacy) are resolvable on CI even
// when the real CLI is not installed. The retired shim must never win selection.
const stubBinDir = mkdtempSync(join(tmpdir(), 'kimi-stub-bin-'));
writeFileSync(join(stubBinDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
writeFileSync(join(stubBinDir, 'kimi-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${stubBinDir}${delimiter}${process.env.PATH}`;

const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
const { invalidateCliCommand } = await import('../dist/utils/cli-resolve.js');

function createKimiAgentService(options = {}) {
  return new KimiAgentService({ l0CompilerFn: async () => 'OWNED-TEST-IDENTITY', ...options });
}

function writeCapabilitiesConfig(projectRoot, capabilities) {
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cat-cafe', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities }),
    'utf8',
  );
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

function createMockProcess() {
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
    pid: 23456,
    exitCode: null,
    kill: mock.fn(() => {
      process.nextTick(() => {
        if (!stdout.destroyed) stdout.end();
        emitter.emit('exit', null, 'SIGTERM');
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

function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

test('yields text, tool_use, inferred session_init, and done on print-mode success', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    mkdirSync(shareDir, { recursive: true });
    writeFileSync(
      join(shareDir, 'kimi.json'),
      JSON.stringify(
        {
          work_dirs: [
            {
              path: process.cwd(),
              kaos: 'local',
              last_session_id: 'kimi-session-123',
            },
          ],
        },
        null,
        2,
      ),
    );

    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );

    emitKimiEvents(proc, [
      {
        role: 'assistant',
        thinking: '先思考一下目录结构。',
        content: '先看一下目录。',
        tool_calls: [
          {
            type: 'function',
            id: 'tc_1',
            function: {
              name: 'Shell',
              arguments: '{"command":"ls"}',
            },
          },
        ],
      },
      { role: 'assistant', content: '已经完成。' },
    ]);

    const msgs = await promise;
    assert.equal(msgs[0].type, 'system_info');
    assert.match(msgs[0].content, /thinking/);
    assert.equal(msgs[1].type, 'text');
    assert.equal(msgs[1].content, '先看一下目录。');
    assert.equal(msgs[2].type, 'tool_use');
    assert.equal(msgs[2].toolName, 'Shell');
    assert.deepEqual(msgs[2].toolInput, { command: 'ls' });
    assert.equal(msgs[3].type, 'text');
    assert.equal(msgs[3].content, '已经完成。');
    assert.equal(msgs[4].type, 'session_init');
    assert.equal(msgs[4].sessionId, 'kimi-session-123');
    assert.equal(msgs[5].type, 'done');

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('-p'));
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('infers session_init from kimi.json when workingDirectory is a symlink alias', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-symlink-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'kimi-worktree-real-'));
  const worktreeAlias = join(tmpdir(), `kimi-worktree-alias-${Date.now()}`);
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    symlinkSync(worktreeRoot, worktreeAlias, process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(
      join(shareDir, 'kimi.json'),
      JSON.stringify(
        {
          work_dirs: [
            {
              path: worktreeRoot,
              last_session_id: 'kimi-session-symlink',
            },
          ],
        },
        null,
        2,
      ),
    );

    const promise = collect(
      service.invoke('Hello', {
        workingDirectory: worktreeAlias,
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    const msgs = await promise;
    const sessionInit = msgs.find((msg) => msg.type === 'session_init');
    assert.equal(sessionInit?.sessionId, 'kimi-session-symlink');
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(worktreeAlias, { recursive: true, force: true });
  }
});

test('maps bare oauth kimi model names to configured model alias', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-config-share-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    writeFileSync(join(shareDir, 'config.toml'), 'default_model = "kimi-code/kimi-for-coding"\n', 'utf8');
    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const modelFlagIndex = args.indexOf('--model');
    assert.ok(modelFlagIndex >= 0);
    assert.equal(args[modelFlagIndex + 1], 'kimi-code/kimi-for-coding');
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('api-key mode injects kimi env overrides instead of embedding secrets in argv', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: {
        CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
        CAT_CAFE_KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
        KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-api-key-')),
      },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const joined = args.join(' ');
  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  assert.ok(!args.includes('--config-file'));
  assert.ok(!args.includes('--model'));
  assert.ok(!joined.includes('sk-kimi-secret'));
  assert.equal(env.KIMI_API_KEY, 'sk-kimi-secret');
  assert.equal(env.KIMI_BASE_URL, 'https://api.moonshot.ai/v1');
  assert.equal(env.KIMI_MODEL_NAME, 'kimi-code/kimi-for-coding');
});

test('api-key mode maps selected model into official kimi env overrides', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-config-shape-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: {
          CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
          CAT_CAFE_KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
          KIMI_CODE_HOME: shareDir,
        },
      }),
    );
    // Native configuration preparation does filesystem IO before spawn.
    await waitForMockProcessReady(proc);
    const args = spawnFn.mock.calls[0].arguments[1];
    const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
    assert.ok(!args.includes('--model'));
    assert.equal(env.KIMI_MODEL_NAME, 'kimi-k2.5');
    assert.equal(env.KIMI_MODEL_MAX_CONTEXT_SIZE, '262144');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('api-key mode normalizes legacy kimi code base url to /coding/v1', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: {
        CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
        CAT_CAFE_KIMI_BASE_URL: 'https://api.kimi.com/coding/',
        KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-legacy-coding-base-')),
      },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  assert.equal(env.KIMI_BASE_URL, 'https://api.kimi.com/coding/v1');
});

test('injects resolved kimi thinking effort into spawn env', async () => {
  const { getCatEffort } = await import('../dist/config/cat-config-loader.js');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: { KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-effort-')) },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  const expected = getCatEffort('kimi', undefined, 'kimi', 'kimi-code/k3');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, expected);
});

test('boolean-thinking kimi models keep CLI thinking config without effort env', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  // kimi-for-coding declares thinking/always_thinking but no support_efforts —
  // the harness must not invent tiers the model does not have.
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const previousParentEffort = process.env.KIMI_MODEL_THINKING_EFFORT;
  process.env.KIMI_MODEL_THINKING_EFFORT = 'forced-parent';
  try {
    const promise = collect(
      service.invoke('Hello', {
        reasoningEffortOverride: 'max',
        callbackEnv: {
          KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-effort-boolean-')),
          KIMI_MODEL_THINKING_EFFORT: 'forced-callback',
        },
      }),
    );
    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;

    // spawnFn sees the final child env (post buildChildEnv): parent and
    // callback values must both be purged for boolean-thinking models.
    const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
    assert.ok(!('KIMI_MODEL_THINKING_EFFORT' in env));
  } finally {
    if (previousParentEffort === undefined) {
      delete process.env.KIMI_MODEL_THINKING_EFFORT;
    } else {
      process.env.KIMI_MODEL_THINKING_EFFORT = previousParentEffort;
    }
  }
});

test('thread effort override wins for kimi spawn env', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      reasoningEffortOverride: 'max',
      callbackEnv: { KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-effort-override-')) },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, 'max');
});

test('incompatible thread effort override fails closed to inherited kimi effort', async () => {
  const { getCatEffort } = await import('../dist/config/cat-config-loader.js');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      // kimi supports low/high/max — medium is an anthropic/openai value
      reasoningEffortOverride: 'medium',
      callbackEnv: { KIMI_CODE_HOME: mkdtempSync(join(tmpdir(), 'kimi-share-effort-stale-')) },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  const expected = getCatEffort('kimi', undefined, 'kimi', 'kimi-code/k3');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, expected);
});

test('keeps the native user prompt unwrapped and adds local image path hints', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });
  const uploadDir = mkdtempSync(join(tmpdir(), 'kimi-upload-'));
  const imagePath = join(uploadDir, 'example.png');
  writeFileSync(imagePath, 'fake-image', 'utf8');

  try {
    const promise = collect(
      service.invoke('帮我分析图片', {
        systemPrompt: '你是梵花猫，回答要简洁。',
        contentBlocks: [{ type: 'image', url: '/uploads/example.png' }],
        uploadDir,
      }),
    );
    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const promptFlagIndex = args.indexOf('-p');
    assert.ok(promptFlagIndex >= 0);
    const effectivePrompt = args[promptFlagIndex + 1];
    assert.doesNotMatch(effectivePrompt, /<system_instructions>/);
    assert.match(effectivePrompt, /example\.png/);
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('parses thinking and grants image directories without retired CLI flags', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-config-cap-'));
  const uploadDir = mkdtempSync(join(tmpdir(), 'kimi-image-cap-'));
  const imagePath = join(uploadDir, 'diagram.png');
  writeFileSync(imagePath, 'fake-image', 'utf8');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  try {
    writeFileSync(
      join(shareDir, 'config.toml'),
      [
        'default_model = "kimi-code/kimi-for-coding"',
        'default_thinking = true',
        '',
        '[models."kimi-code/kimi-for-coding"]',
        'capabilities = ["thinking", "image_in"]',
      ].join('\n'),
      'utf8',
    );

    const promise = collect(
      service.invoke('看看这张图', {
        callbackEnv: { KIMI_CODE_HOME: shareDir },
        contentBlocks: [{ type: 'image', url: '/uploads/diagram.png' }],
        uploadDir,
      }),
    );

    emitKimiEvents(proc, [
      {
        role: 'assistant',
        content: [
          { type: 'think', think: '先理解图片里有什么。' },
          { type: 'text', text: '我已经看到图片路径提示。' },
        ],
      },
    ]);

    const msgs = await promise;
    assert.equal(msgs[0].type, 'system_info');
    assert.match(msgs[0].content, /thinking/);
    assert.match(msgs[0].content, /先理解图片/);
    assert.equal(msgs[1].type, 'system_info');
    assert.match(msgs[1].content, /image_input/);
    assert.match(msgs[1].content, /available/);
    assert.equal(msgs[2].type, 'text');
    assert.match(msgs[2].content, /图片路径提示/);

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--thinking'));
    const addDirIndex = args.indexOf('--add-dir');
    assert.ok(addDirIndex >= 0);
    assert.equal(args[addDirIndex + 1], uploadDir);
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('does not emit thinking unavailable if a later assistant event includes thinking', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    { role: 'assistant', content: '先准备一下。' },
    {
      role: 'assistant',
      content: [
        { type: 'think', think: '这里才给出真正的思考内容。' },
        { type: 'text', text: '最终回答。' },
      ],
    },
  ]);

  const msgs = await promise;
  const capabilityUnavailable = msgs.find(
    (msg) => msg.type === 'system_info' && /provider_capability/.test(msg.content) && /thinking/.test(msg.content),
  );
  const thinkingEvent = msgs.find((msg) => msg.type === 'system_info' && /"type":"thinking"/.test(msg.content));
  assert.equal(capabilityUnavailable, undefined);
  assert.ok(thinkingEvent, 'should emit a thinking event once think content appears later in the stream');
});

test('extracts session id from non-json resume hint lines in print mode', async () => {
  async function* spawnCliOverride() {
    yield {
      line: 'To resume this session: kimi -r ab5188ae-f3e8-4f72-baec-48a53c665e9a',
      error: 'Failed to parse JSON line',
    };
    yield { role: 'assistant', content: 'done' };
  }

  const service = createKimiAgentService({ model: 'kimi-code/kimi-for-coding' });
  const msgs = await collect(service.invoke('Hello', { spawnCliOverride }));
  const session = msgs.find((msg) => msg.type === 'session_init');
  assert.equal(session?.sessionId, 'ab5188ae-f3e8-4f72-baec-48a53c665e9a');
});

test('captures usage and session id from kimi stream events when available', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    {
      role: 'assistant',
      session_id: 'kimi-live-session',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        total_tokens: 46,
      },
      content: 'ok',
    },
  ]);
  const msgs = await promise;
  const session = msgs.find((msg) => msg.type === 'session_init');
  const text = msgs.find((msg) => msg.type === 'text');
  assert.equal(session?.sessionId, 'kimi-live-session');
  assert.equal(text?.metadata?.sessionId, 'kimi-live-session');
  assert.equal(text?.metadata?.usage?.inputTokens, 12);
  assert.equal(text?.metadata?.usage?.outputTokens, 34);
  assert.equal(text?.metadata?.usage?.totalTokens, 46);
});

test('estimates API-equivalent costUsd on done for priced Kimi models', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    {
      role: 'assistant',
      usage: {
        input_tokens: 200_000,
        output_tokens: 50_000,
        total_tokens: 250_000,
      },
      content: 'ok',
    },
  ]);
  const msgs = await promise;
  const done = msgs.find((msg) => msg.type === 'done');
  // Kimi K2.7 Code card (no cached input): input 200k × $0.95/M
  // + output 50k × $4.00/M = $0.19 + $0.2 = $0.39
  assert.equal(done?.metadata?.usage?.costUsd, 0.39);
  assert.equal(done?.metadata?.usage?.costEstimated, true);
});

test('omits cost when raw usage reports cached_input_tokens (unproven subset contract)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    {
      role: 'assistant',
      usage: {
        input_tokens: 200_000,
        cached_input_tokens: 100_000,
        output_tokens: 50_000,
        total_tokens: 250_000,
      },
      content: 'ok',
    },
  ]);
  const msgs = await promise;
  const done = msgs.find((msg) => msg.type === 'done');
  // Terra P1 (cat-cafe#3479): cached_input_tokens ⊂ input_tokens is not an
  // officially documented relationship — omit cost until a verified live
  // sample proves the contract. Tokens stay visible.
  assert.equal(done?.metadata?.usage?.inputTokens, 200_000);
  assert.equal(done?.metadata?.usage?.cacheReadTokens, 100_000);
  assert.equal(done?.metadata?.usage?.costUsd, undefined);
  assert.equal(done?.metadata?.usage?.costEstimated, undefined);
});

test('does not bill the snapshot when raw stats carry only context tokens', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-context-share-'));
  const sessionId = 'kimi-context-session';
  const sessionDir = join(shareDir, 'sessions', 'project-hash', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(shareDir, 'config.toml'),
    [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'max_context_size = 262144',
      'capabilities = ["thinking", "image_in"]',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(sessionDir, 'context.jsonl'),
    ['{"role":"user","content":"hi"}', '{"role":"_usage","token_count":6335}'].join('\n'),
    'utf8',
  );

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  try {
    writeFingerprintStore(shareDir, {
      [`kimi:${sessionId}`]: {
        fingerprint: computeKimiL0Fingerprint('OWNED-TEST-IDENTITY'),
        catId: 'kimi',
        updatedAt: 1,
      },
    });
    const promise = collect(
      service.invoke('Hello', {
        sessionId,
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Terra residual P1 (cat-cafe#3479): raw stats with ONLY context tokens
    // is not a billable input/output record. The snapshot enrichment will
    // still write lastTurnInputTokens=6335 — it must never become cost.
    emitKimiEvents(proc, [{ role: 'assistant', stats: { context_used_tokens: 1 }, content: 'ok' }]);
    const msgs = await promise;
    const done = msgs.find((msg) => msg.type === 'done');
    assert.ok(done?.metadata?.usage, 'done should have usage metadata');
    assert.equal(done.metadata.usage.contextUsedTokens, 6335);
    assert.equal(done.metadata.usage.lastTurnInputTokens, 6335);
    assert.equal(done.metadata.usage.costUsd, undefined);
    assert.equal(done.metadata.usage.costEstimated, undefined);
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('does not estimate when raw usage carries only total_tokens', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    {
      role: 'assistant',
      usage: { total_tokens: 46 },
      content: 'ok',
    },
  ]);
  const msgs = await promise;
  const done = msgs.find((msg) => msg.type === 'done');
  // total_tokens alone is not a billable input/output record.
  assert.equal(done?.metadata?.usage?.totalTokens, 46);
  assert.equal(done?.metadata?.usage?.costUsd, undefined);
  assert.equal(done?.metadata?.usage?.costEstimated, undefined);
});

test('leaves costUsd unset for unverified Kimi model aliases (no guessing)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding-v1' });

  const promise = collect(service.invoke('Hello'));
  emitKimiEvents(proc, [
    {
      role: 'assistant',
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        total_tokens: 46,
      },
      content: 'ok',
    },
  ]);
  const msgs = await promise;
  const done = msgs.find((msg) => msg.type === 'done');
  // Tokens stay visible; cost is omitted rather than guessed.
  assert.equal(done?.metadata?.usage?.inputTokens, 12);
  assert.equal(done?.metadata?.usage?.costUsd, undefined);
  assert.equal(done?.metadata?.usage?.costEstimated, undefined);
});

test('enriches done metadata with local Kimi context snapshot for session-chain health', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-context-share-'));
  const sessionId = 'kimi-context-session';
  const sessionDir = join(shareDir, 'sessions', 'project-hash', sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(shareDir, 'config.toml'),
    [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'max_context_size = 262144',
      'capabilities = ["thinking", "image_in"]',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(sessionDir, 'context.jsonl'),
    ['{"role":"user","content":"hi"}', '{"role":"_usage","token_count":6335}'].join('\n'),
    'utf8',
  );

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  try {
    writeFingerprintStore(shareDir, {
      [`kimi:${sessionId}`]: {
        fingerprint: computeKimiL0Fingerprint('OWNED-TEST-IDENTITY'),
        catId: 'kimi',
        updatedAt: 1,
      },
    });
    const promise = collect(
      service.invoke('Hello', {
        sessionId,
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    const msgs = await promise;
    const done = msgs.find((msg) => msg.type === 'done');
    assert.ok(done?.metadata?.usage, 'done should have usage metadata');
    assert.equal(done.metadata.usage.contextUsedTokens, 6335);
    assert.equal(done.metadata.usage.contextWindowSize, 262144);
    assert.equal(done.metadata.usage.lastTurnInputTokens, 6335);
    // Terra P1 (cat-cafe#3479): the context snapshot is health/display
    // context, not verified billable turn telemetry. With no raw usage from
    // THIS invocation, cost must stay unset even though the model is priced
    // and lastTurnInputTokens is populated by the enrichment above.
    assert.equal(done.metadata.usage.costUsd, undefined);
    assert.equal(done.metadata.usage.costEstimated, undefined);
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native Kimi Code parses meta events for session resume', async () => {
  // Isolate PATH: a bin dir with only `kimi` (no `kimi-cli`).  Keep a skeleton system
  // PATH so `which` itself is findable; the stub `kimi-cli` from the top-level setup
  // is NOT present.  A temp HOME ensures the fallback directory search in
  // resolveCliCommand (e.g. ~/.local/bin) cannot accidentally discover kimi-cli.
  const nonLegacyBinDir = mkdtempSync(join(tmpdir(), 'kimi-nonlegacy-bin-'));
  writeFileSync(join(nonLegacyBinDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const systemBins =
    process.platform === 'win32' ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/usr/bin', '/bin'];
  process.env.PATH = [nonLegacyBinDir, ...systemBins].join(delimiter);
  const tempHome = mkdtempSync(join(tmpdir(), 'kimi-nonlegacy-home-'));
  process.env.HOME = tempHome;

  invalidateCliCommand('kimi-cli');
  invalidateCliCommand('kimi');

  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    // Native mode compiles L0 via --agent-file — stub the compiler so this
    // parser/transport test does not depend on the real L0 pipeline.
    const l0CompilerFn = mock.fn(async () => 'L0_STUB');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding', l0CompilerFn });

    const promise = collect(service.invoke('Hello'));

    // Emit meta session.resume_hint + assistant text (new kimi-code shape)
    emitKimiEvents(proc, [
      { role: 'meta', type: 'session.resume_hint', session_id: 'nonlegacy-session-42' },
      { role: 'assistant', content: 'ok from new kimi' },
    ]);

    const msgs = await promise;

    // session_init from meta event
    const sessionInit = msgs.find((m) => m.type === 'session_init');
    assert.equal(sessionInit?.sessionId, 'nonlegacy-session-42');

    // text content
    const textMsg = msgs.find((m) => m.type === 'text');
    assert.equal(textMsg?.content, 'ok from new kimi');

    // done
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done);

    // command is `kimi` (ends with /kimi, not /kimi-cli)
    const command = spawnFn.mock.calls[0].arguments[0];
    assert.equal(command, join(nonLegacyBinDir, 'kimi'));

    // args: has --output-format stream-json and -p, no legacy-only flags
    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('-p'));
    assert.ok(!args.includes('--print'));
    assert.ok(!args.includes('--prompt'));
    assert.ok(!args.includes('--work-dir'));
    assert.ok(!args.includes('--thinking'));
    assert.ok(!args.includes('--add-dir'));
    assert.ok(!args.includes('--mcp-config-file'));

    // non-legacy mode does NOT emit thinking-unavailable capability
    const thinkUnavail = msgs.find(
      (m) => m.type === 'system_info' && /provider_capability/.test(m.content) && /unavailable/.test(m.content),
    );
    assert.strictEqual(thinkUnavail, undefined);
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    rmSync(nonLegacyBinDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    invalidateCliCommand('kimi-cli');
    invalidateCliCommand('kimi');
  }
});

function enterNonLegacyKimiPath() {
  const binDir = mkdtempSync(join(tmpdir(), 'kimi-native-l0-bin-'));
  writeFileSync(join(binDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const tempHome = mkdtempSync(join(tmpdir(), 'kimi-native-l0-home-'));
  process.env.PATH = [binDir, '/usr/bin', '/bin'].join(delimiter);
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  invalidateCliCommand('kimi-cli');
  invalidateCliCommand('kimi');
  return () => {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    process.env.USERPROFILE = savedUserProfile;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    invalidateCliCommand('kimi-cli');
    invalidateCliCommand('kimi');
  };
}

test('injectsL0Natively stays true when an obsolete kimi-cli shim is also resolvable', async () => {
  const service = createKimiAgentService({ model: 'kimi-code/kimi-for-coding' });
  assert.equal(service.injectsL0Natively(), true);
});

test('injectsL0Natively is true when only new kimi (kimi-code) is resolvable', async () => {
  const restore = enterNonLegacyKimiPath();
  try {
    const service = createKimiAgentService({ model: 'kimi-code/kimi-for-coding' });
    assert.equal(service.injectsL0Natively(), true);
  } finally {
    restore();
  }
});

test('native L0: passes --agent-file with compiled L0 + pack, v2 env flag, no prompt wrap, cleans temp dir', async () => {
  const restore = enterNonLegacyKimiPath();
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_COMPILED_IDENTITY_MARKER');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Hello', {
        systemPrompt: 'PACK_ONLY_MARKER',
        callbackEnv: { CAT_CAFE_USER_ID: 'user-1' },
      }),
    );
    // Read the agent file after launch preparation and before completion cleans it up.
    await waitForMockProcessReady(proc);
    assert.equal(spawnFn.mock.calls.length, 1, 'CLI should be spawned');

    const args = spawnFn.mock.calls[0].arguments[1];
    const agentFlagIndex = args.indexOf('--agent-file');
    assert.ok(agentFlagIndex >= 0, '--agent-file must be passed in native mode');
    const agentFilePath = args[agentFlagIndex + 1];
    const content = readFileSync(agentFilePath, 'utf8');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    const msgs = await promise;

    // L0 compiler received the cat + user id
    assert.equal(l0CompilerFn.mock.calls.length, 1);
    assert.equal(l0CompilerFn.mock.calls[0].arguments[0].catId, 'kimi');
    assert.equal(l0CompilerFn.mock.calls[0].arguments[0].userId, 'user-1');

    assert.match(content, /^---\nname: cat-cafe-l0-kimi\n/);
    assert.ok(content.includes('${base_prompt}'), 'agent file keeps the CLI built-in prompt skeleton');
    assert.ok(content.includes('L0_COMPILED_IDENTITY_MARKER'), 'compiled L0 travels the native channel');
    assert.ok(content.includes('PACK_ONLY_MARKER'), 'pack-only systemPrompt is appended to the agent file');

    // prompt no longer carries the <system_instructions> wrapper
    const promptFlagIndex = args.indexOf('-p');
    assert.ok(promptFlagIndex >= 0);
    const effectivePrompt = args[promptFlagIndex + 1];
    assert.ok(
      !effectivePrompt.includes('<system_instructions>'),
      'native mode must not wrap identity into the user prompt',
    );
    assert.ok(!effectivePrompt.includes('L0_COMPILED_IDENTITY_MARKER'));

    // v2 engine flag is forced into the child env
    const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
    assert.equal(env.KIMI_CODE_EXPERIMENTAL_FLAG, '1');

    // temp agent file dir cleaned up after completion
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(agentFilePath), false, 'agent file temp dir must be removed after invoke');
    assert.equal(msgs.at(-1)?.type, 'done');
  } finally {
    restore();
  }
});

test('native L0: compile failure is fail-closed (error + done, no spawn, no temp leak)', async () => {
  const restore = enterNonLegacyKimiPath();
  const tempShareDir = mkdtempSync(join(tmpdir(), 'kimi-native-l0-fail-share-'));
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => {
      throw new Error('boom');
    });
    const service = createKimiAgentService({
      spawnFn,
      model: 'kimi-code/k3',
      l0CompilerFn,
      mcpServerPath: '/dummy/cat-cafe-mcp-server.js',
    });

    const msgs = await collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_CODE_HOME: tempShareDir, CAT_CAFE_API_URL: 'http://127.0.0.1:3004' },
      }),
    );

    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'expected error event on L0 compile failure');
    assert.match(err.error, /L0/);
    assert.equal(msgs.at(-1)?.type, 'done');
    assert.equal(spawnFn.mock.calls.length, 0, 'CLI must not be spawned without L0');

    // tempMcpConfig dir (if created) must be cleaned up on the fail-closed path
    const { readdirSync } = await import('node:fs');
    const leaked = readdirSync(tempShareDir).filter((name) => name.startsWith('tmp-mcp-'));
    assert.equal(leaked.length, 0, `fail-closed path leaked temp dirs: ${leaked.join(', ')}`);
  } finally {
    restore();
    rmSync(tempShareDir, { recursive: true, force: true });
  }
});

test('native L0: user cliConfigArgs cannot override --agent-file / --agent', async () => {
  const restore = enterNonLegacyKimiPath();
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_X');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Hello', {
        cliConfigArgs: ['--agent-file /tmp/evil.md', '--agent reviewer', '--verbose'],
      }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('/tmp/evil.md'), 'user --agent-file must be stripped');
    assert.ok(!args.includes('--agent'), 'user --agent must be stripped');
    assert.ok(!args.includes('reviewer'));
    assert.ok(args.includes('--verbose'), 'ordinary user args still pass through');
    const agentFlagIndex = args.indexOf('--agent-file');
    assert.ok(agentFlagIndex >= 0, 'system --agent-file must survive');
    assert.match(args[agentFlagIndex + 1], /cat-cafe-kimi-l0-/);
  } finally {
    restore();
  }
});

test('native L0: declares --agent-file as managed argv provenance for diagnostics', async () => {
  const restore = enterNonLegacyKimiPath();
  try {
    let capturedOptions;
    async function* spawnCliOverride(options) {
      capturedOptions = options;
      yield { role: 'assistant', content: 'ok' };
    }
    const l0CompilerFn = mock.fn(async () => 'L0_X');
    const service = createKimiAgentService({ model: 'kimi-code/k3', l0CompilerFn });

    await collect(service.invoke('Hello', { spawnCliOverride }));

    assert.deepEqual(capturedOptions?.managedArgvFlags, ['--agent-file']);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// F274 follow-up (愿景守护 Terra BLOCKED): resume must not silently carry a
// stale L0 — kimi-code freezes the agent prompt at session first bind, so the
// harness compares the compiled-L0 fingerprint before honoring --session.
// ---------------------------------------------------------------------------

const { computeKimiL0Fingerprint, readKimiL0SessionFingerprints } = await import(
  '../dist/domains/cats/services/agents/providers/kimi-l0-session-fingerprint.js'
);

function writeFingerprintStore(shareDir, sessions) {
  mkdirSync(shareDir, { recursive: true });
  writeFileSync(
    join(shareDir, 'cat-cafe-l0-session-fingerprints.json'),
    JSON.stringify({ version: 1, sessions }),
    'utf8',
  );
}

test('native L0 resume: matching fingerprint honors --session', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-match-'));
  try {
    const fp = computeKimiL0Fingerprint('L0_V1');
    writeFingerprintStore(shareDir, {
      'kimi:sess-match': { fingerprint: fp, catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V1');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-match', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'resumed' }]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--session'), 'matching fingerprint must resume');
    assert.equal(args[args.indexOf('--session') + 1], 'sess-match');
    assert.ok(
      !args.includes('--agent-file'),
      'kimi-code rejects --agent-file combined with --session (agent is bound at session creation)',
    );
    const freshInfo = msgs.find((m) => m.type === 'system_info' && /l0_resume_fresh_start/.test(m.content ?? ''));
    assert.equal(freshInfo, undefined, 'no fresh-start notice on clean resume');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

// kimi-code >=0.30 turned the previously-silent no-op into a hard arg error:
//   "error: Cannot combine --agent/--agent-file with --session/--continue:
//    the agent is bound at session creation and the bound agent is restored
//    automatically on resume."
// Observed as exit 1 on every resumed kimi turn from 2026-08-09 (CLI 0.34.0).
// The L0 must still be compiled on resume — the fingerprint gate above depends
// on it — but the agent file only ever applied to a *new* session.
test('native L0 resume: compiles L0 for the fingerprint gate but passes no agent flag', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-noagent-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-bound': { fingerprint: computeKimiL0Fingerprint('L0_V1'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V1');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', {
        sessionId: 'sess-bound',
        systemPrompt: 'PACK_CONTENT',
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'resumed' }]);
    await promise;

    assert.equal(l0CompilerFn.mock.callCount(), 1, 'resume still compiles L0 to verify the fingerprint');
    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--session'), 'verified fingerprint resumes the bound session');
    assert.ok(!args.includes('--agent-file'), '--agent-file must not travel with --session');
    assert.ok(!args.includes('--agent'), '--agent must not travel with --session');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

// @codex-terra REQUEST_CHANGES on PR #1323 (exact HEAD 0f7c453be): session-selection flags
// must be server-owned. Before this PR a user-configured --session still crashed on the CLI's
// --agent-file mutual-exclusion check; dropping --agent-file on verified resume removes that
// accidental shield, so the fingerprint gate could verify session A while the CLI resumes an
// unverified session B — silently, with no l0_resume_fresh_start notice.
test('native L0 resume: cliConfigArgs cannot swap the fingerprint-verified session', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-argv-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-verified': { fingerprint: computeKimiL0Fingerprint('L0_V1'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V1');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', {
        sessionId: 'sess-verified',
        cliConfigArgs: ['--session sess-unverified'],
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'resumed' }]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('sess-unverified'), 'user cliConfigArgs must not select an unverified session');
    assert.equal(args.filter((a) => a === '--session' || a === '-S').length, 1, 'exactly one session flag survives');
    assert.equal(
      args[args.indexOf('--session') + 1],
      'sess-verified',
      'the gate-verified session must be the one used',
    );
    // The gate said "resume verified" — metadata and argv must agree, not diverge silently.
    const init = msgs.find((m) => m.type === 'session_init');
    assert.equal(init?.sessionId, 'sess-verified');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

// Attached-value spellings verified against kimi-code 0.34.0: both `-S<id>` and
// `--session=<id>` are accepted and select the session (`Session "bogus-sess-zzz" not
// found`), so a space-separated-only strip would leave the bypass wide open.
test('native L0 resume: attached-value session spellings (-S<id> / --session=<id>) are stripped too', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-attached-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-verified': { fingerprint: computeKimiL0Fingerprint('L0_V1'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V1');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', {
        sessionId: 'sess-verified',
        cliConfigArgs: ['-Ssneaky-one', '--session=sneaky-two'],
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'resumed' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.some((a) => a.includes('sneaky-one')), '-S<id> concatenated form must be stripped');
    assert.ok(!args.some((a) => a.includes('sneaky-two')), '--session=<id> form must be stripped');
    assert.equal(args[args.indexOf('--session') + 1], 'sess-verified', 'gate-verified session survives intact');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 fresh start: cliConfigArgs cannot sneak --continue past the fingerprint gate', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-cont-'));
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Hello', {
        // no sessionId → fresh bind, --agent-file is carried
        cliConfigArgs: ['--continue', '--verbose'],
        callbackEnv: { KIMI_CODE_HOME: shareDir },
      }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'fresh' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--continue'), '--continue would resume an unverified session behind the gate');
    assert.ok(!args.includes('-c'), '-c is the same flag under its short alias');
    assert.ok(args.includes('--agent-file'), 'fresh bind still carries the L0 agent file');
    // Arity guard: --continue takes NO value, so stripping it must not swallow the next user arg.
    assert.ok(args.includes('--verbose'), 'a valueless reserved flag must not eat the following user arg');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: stale fingerprint forces fresh session (no --session) + notice + records new id', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-stale-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-old': { fingerprint: computeKimiL0Fingerprint('L0_OLD'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-new-1' },
      { role: 'assistant', content: 'fresh' },
    ]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--session'), 'stale fingerprint must NOT resume the old session');

    const freshInfo = msgs.find((m) => m.type === 'system_info' && /l0_resume_fresh_start/.test(m.content ?? ''));
    assert.ok(freshInfo, 'fresh-start notice required when L0 drifted');
    assert.match(freshInfo.content, /stale/);
    assert.match(freshInfo.content, /sess-old/);

    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(store['kimi:sess-new-1']?.fingerprint, computeKimiL0Fingerprint('L0_V2'));
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: unknown session (no fingerprint record) is unverifiable → fresh session', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-unknown-'));
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-unknown', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'fresh' }]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--session'), 'unverifiable session must NOT be silently resumed');
    const freshInfo = msgs.find((m) => m.type === 'system_info' && /l0_resume_fresh_start/.test(m.content ?? ''));
    assert.ok(freshInfo, 'fresh-start notice required for unverifiable session');
    assert.match(freshInfo.content, /unverifiable/);
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 first invoke: records fingerprint for the new session after session_init', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-first-'));
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V3');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(service.invoke('Hello', { callbackEnv: { KIMI_CODE_HOME: shareDir } }));
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-first' },
      { role: 'assistant', content: 'ok' },
    ]);
    const msgs = await promise;
    assert.ok(msgs.find((m) => m.type === 'session_init'));

    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(store['kimi:sess-first']?.fingerprint, computeKimiL0Fingerprint('L0_V3'));
    assert.equal(store['kimi:sess-first']?.catId, 'kimi');
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: fingerprint store is cat-scoped (another cat never matches)', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-catscope-'));
  try {
    writeFingerprintStore(shareDir, {
      'othercat:sess-shared': { fingerprint: computeKimiL0Fingerprint('L0_V1'), catId: 'othercat', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V1');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-shared', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'fresh' }]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(!args.includes('--session'), 'record of another cat must not authenticate this cat resume');
    const freshInfo = msgs.find((m) => m.type === 'system_info' && /l0_resume_fresh_start/.test(m.content ?? ''));
    assert.ok(freshInfo);
    assert.match(freshInfo.content, /unverifiable/);
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: rejected old session id is never recorded with the new fingerprint (no silent fall-back)', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-nofallback-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-old': { fingerprint: computeKimiL0Fingerprint('L0_OLD'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    // CLI (pathologically) echoes the REJECTED old id — must not be recorded.
    emitKimiEvents(proc, [
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-old' },
      { role: 'assistant', content: 'fresh' },
    ]);
    await promise;

    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(
      store['kimi:sess-old']?.fingerprint,
      computeKimiL0Fingerprint('L0_OLD'),
      'rejected session must keep its old fingerprint — never upgraded to the new L0',
    );
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: rejected id must not consume the session-init slot; real new id is recorded and published', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-slot-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-old': { fingerprint: computeKimiL0Fingerprint('L0_OLD'), catId: 'kimi', updatedAt: 1 },
    });
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_CODE_HOME: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    // Rejected id arrives FIRST (resume_hint), real new id arrives later via assistant event.
    emitKimiEvents(proc, [
      { role: 'meta', type: 'session.resume_hint', session_id: 'sess-old' },
      { role: 'assistant', session_id: 'sess-new', content: 'fresh' },
    ]);
    const msgs = await promise;

    // exactly one session_init, for the REAL new id — rejected id never published
    const sessionInits = msgs.filter((m) => m.type === 'session_init');
    assert.equal(sessionInits.length, 1, `expected 1 session_init, got ${sessionInits.length}`);
    assert.equal(sessionInits[0].sessionId, 'sess-new');

    // only kimi:sess-new recorded; old id keeps its old fingerprint
    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(store['kimi:sess-new']?.fingerprint, computeKimiL0Fingerprint('L0_V2'));
    assert.equal(store['kimi:sess-old']?.fingerprint, computeKimiL0Fingerprint('L0_OLD'));
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0 resume: rejected id in non-JSON resume hint line does not consume the session-init slot', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-line-'));
  try {
    writeFingerprintStore(shareDir, {
      'kimi:sess-old': { fingerprint: computeKimiL0Fingerprint('L0_OLD'), catId: 'kimi', updatedAt: 1 },
    });
    const l0CompilerFn = mock.fn(async () => 'L0_V2');
    const service = createKimiAgentService({ model: 'kimi-code/k3', l0CompilerFn });

    async function* spawnCliOverride() {
      yield { line: 'To resume this session: kimi -r sess-old', error: 'Failed to parse JSON line' };
      yield { role: 'assistant', session_id: 'sess-new', content: 'fresh' };
    }

    const msgs = await collect(
      service.invoke('Continue', {
        sessionId: 'sess-old',
        callbackEnv: { KIMI_CODE_HOME: shareDir },
        spawnCliOverride,
      }),
    );

    const sessionInits = msgs.filter((m) => m.type === 'session_init');
    assert.equal(sessionInits.length, 1, `expected 1 session_init, got ${sessionInits.length}`);
    assert.equal(sessionInits[0].sessionId, 'sess-new');

    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(store['kimi:sess-new']?.fingerprint, computeKimiL0Fingerprint('L0_V2'));
    assert.equal(store['kimi:sess-old']?.fingerprint, computeKimiL0Fingerprint('L0_OLD'));
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});

test('native L0: valid new id from non-JSON line is recorded (next resume would pass fingerprint check)', async () => {
  const restore = enterNonLegacyKimiPath();
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-fp-line-record-'));
  try {
    const l0CompilerFn = mock.fn(async () => 'L0_V4');
    const service = createKimiAgentService({ model: 'kimi-code/k3', l0CompilerFn });

    async function* spawnCliOverride() {
      yield { line: 'To resume this session: kimi -r sess-line-new', error: 'Failed to parse JSON line' };
      yield { role: 'assistant', content: 'hello' };
    }

    const msgs = await collect(
      service.invoke('Hello', { callbackEnv: { KIMI_CODE_HOME: shareDir }, spawnCliOverride }),
    );

    const sessionInit = msgs.find((m) => m.type === 'session_init');
    assert.equal(sessionInit?.sessionId, 'sess-line-new');

    const store = readKimiL0SessionFingerprints(shareDir);
    assert.equal(
      store['kimi:sess-line-new']?.fingerprint,
      computeKimiL0Fingerprint('L0_V4'),
      'valid new id from line transport must be recorded, otherwise next resume is perpetually unverifiable',
    );
  } finally {
    restore();
    rmSync(shareDir, { recursive: true, force: true });
  }
});
