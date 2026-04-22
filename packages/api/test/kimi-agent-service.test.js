import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

// Ensure `kimi` is resolvable on CI even when the real CLI is not installed.
// resolveCliCommand uses `which kimi` — placing a stub on PATH satisfies it.
const stubBinDir = mkdtempSync(join(tmpdir(), 'kimi-stub-bin-'));
writeFileSync(join(stubBinDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${stubBinDir}:${process.env.PATH}`;

const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');

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

function emitKimiEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
}

test('yields text, tool_use, inferred session_init, and done on print-mode success', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

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
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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
    assert.ok(args.includes('--print'));
    assert.ok(args.includes('--output-format'));
    assert.ok(args.includes('stream-json'));
    assert.ok(args.includes('--prompt'));
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

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
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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

test('uses --session for resume and emits session_init immediately', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  const promise = collect(service.invoke('Continue', { sessionId: 'resume-kimi-456' }));
  await new Promise((resolve) => setImmediate(resolve));
  emitKimiEvents(proc, [{ role: 'assistant', content: 'Resumed Kimi.' }]);
  const msgs = await promise;

  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[0].sessionId, 'resume-kimi-456');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Resumed Kimi.');
  assert.equal(msgs[2].type, 'system_info');
  assert.match(msgs[2].content, /provider_capability/);

  const args = spawnFn.mock.calls[0].arguments[1];
  const sessionFlagIndex = args.indexOf('--session');
  assert.ok(sessionFlagIndex >= 0);
  assert.equal(args[sessionFlagIndex + 1], 'resume-kimi-456');
});

test('maps bare oauth kimi model names to configured model alias', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-config-share-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    writeFileSync(join(shareDir, 'config.toml'), 'default_model = "kimi-code/kimi-for-coding"\n', 'utf8');
    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: {
        CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
        CAT_CAFE_KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
        KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-api-key-')),
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-k2.5' });

  try {
    const promise = collect(
      service.invoke('Hello', {
        callbackEnv: {
          CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
          CAT_CAFE_KIMI_BASE_URL: 'https://api.moonshot.ai/v1',
          KIMI_SHARE_DIR: shareDir,
        },
      }),
    );
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: {
        CAT_CAFE_KIMI_API_KEY: 'sk-kimi-secret',
        CAT_CAFE_KIMI_BASE_URL: 'https://api.kimi.com/coding/',
        KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-legacy-coding-base-')),
      },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  assert.equal(env.KIMI_BASE_URL, 'https://api.kimi.com/coding/v1');
});

test('injects cat-cafe MCP config file when callback env is present', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-mcp-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'kimi-project-mcp-'));
  const mcpServerDir = mkdtempSync(join(tmpdir(), 'kimi-mcp-server-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    spawnFn,
    model: 'kimi-code/kimi-for-coding',
    mcpServerPath: join(mcpServerDir, 'index.js'),
  });

  try {
    mkdirSync(join(projectDir, '.kimi'), { recursive: true });
    writeFileSync(
      join(projectDir, '.kimi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        },
      }),
      'utf8',
    );
    writeFileSync(join(mcpServerDir, 'index.js'), '// stub', 'utf8');

    const promise = collect(
      service.invoke('Hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          KIMI_SHARE_DIR: shareDir,
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'invoke-123',
          CAT_CAFE_CALLBACK_TOKEN: 'token-123',
        },
      }),
    );
    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpFlagIndex = args.indexOf('--mcp-config-file');
    assert.ok(mcpFlagIndex >= 0);
    const mcpPath = args[mcpFlagIndex + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(mcpConfig.mcpServers['cat-cafe']);
    assert.ok(mcpConfig.mcpServers.filesystem);
    assert.equal(mcpConfig.mcpServers['cat-cafe'].command, 'node');
    assert.equal(mcpConfig.mcpServers['cat-cafe'].env.CAT_CAFE_API_URL, 'http://127.0.0.1:3004');
    assert.equal(mcpConfig.mcpServers['cat-cafe'].env.CAT_CAFE_INVOCATION_ID, 'invoke-123');
    assert.equal(mcpConfig.mcpServers['cat-cafe'].env.CAT_CAFE_CALLBACK_TOKEN, 'token-123');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(mcpServerDir, { recursive: true, force: true });
  }
});

test('creates Kimi share dir before writing temp MCP config on fresh setups', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kimi-fresh-root-'));
  const shareDir = join(root, 'does-not-exist-yet');
  const projectDir = mkdtempSync(join(tmpdir(), 'kimi-fresh-project-'));
  const mcpServerDir = mkdtempSync(join(tmpdir(), 'kimi-fresh-mcp-'));
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    spawnFn,
    model: 'kimi-code/kimi-for-coding',
    mcpServerPath: join(mcpServerDir, 'index.js'),
  });

  try {
    writeFileSync(join(mcpServerDir, 'index.js'), '// stub', 'utf8');
    const promise = collect(
      service.invoke('Hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          KIMI_SHARE_DIR: shareDir,
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'invoke-fresh',
          CAT_CAFE_CALLBACK_TOKEN: 'token-fresh',
        },
      }),
    );

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpFlagIndex = args.indexOf('--mcp-config-file');
    assert.ok(mcpFlagIndex >= 0);
    const mcpPath = args[mcpFlagIndex + 1];
    assert.ok(readFileSync(mcpPath, 'utf8').includes('cat-cafe'));

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    const msgs = await promise;
    assert.equal(msgs.at(-1)?.type, 'done');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(mcpServerDir, { recursive: true, force: true });
  }
});

test('wraps system prompt separately and adds local image path hints', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });
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
    const promptFlagIndex = args.indexOf('--prompt');
    assert.ok(promptFlagIndex >= 0);
    const effectivePrompt = args[promptFlagIndex + 1];
    assert.match(effectivePrompt, /<system_instructions>/);
    assert.match(effectivePrompt, /你是梵花猫/);
    assert.match(effectivePrompt, /example\.png/);
  } finally {
    rmSync(uploadDir, { recursive: true, force: true });
  }
});

test('enables thinking mode, parses think blocks, and grants image directories to kimi-cli', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-config-cap-'));
  const uploadDir = mkdtempSync(join(tmpdir(), 'kimi-image-cap-'));
  const imagePath = join(uploadDir, 'diagram.png');
  writeFileSync(imagePath, 'fake-image', 'utf8');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

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
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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
    assert.ok(args.includes('--thinking'));
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

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

  const service = new KimiAgentService({ model: 'kimi-code/kimi-for-coding' });
  const msgs = await collect(service.invoke('Hello', { spawnCliOverride }));
  const session = msgs.find((msg) => msg.type === 'session_init');
  assert.equal(session?.sessionId, 'ab5188ae-f3e8-4f72-baec-48a53c665e9a');
});

test('captures usage and session id from kimi stream events when available', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  try {
    const promise = collect(
      service.invoke('Hello', {
        sessionId,
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
  }
});
