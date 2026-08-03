import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

// Ensure `kimi` (new kimi-code) and `kimi-cli` (legacy) are resolvable on CI even
// when the real CLI is not installed. resolveCliCommand prefers `kimi-cli` first.
const stubBinDir = mkdtempSync(join(tmpdir(), 'kimi-stub-bin-'));
writeFileSync(join(stubBinDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
writeFileSync(join(stubBinDir, 'kimi-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${stubBinDir}:${process.env.PATH}`;

const { KimiAgentService } = await import('../dist/domains/cats/services/agents/providers/KimiAgentService.js');
const { invalidateCliCommand } = await import('../dist/utils/cli-resolve.js');

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
    // #712: writeMcpConfigFile is now async — flush microtask queue so the
    // generator reaches spawnCli before we inspect spawnFn.mock.calls.
    await new Promise((r) => setImmediate(r));
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

test('injects resolved kimi thinking effort into spawn env', async () => {
  const { getCatEffort } = await import('../dist/config/cat-config-loader.js');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      callbackEnv: { KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-effort-')) },
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding' });

  const previousParentEffort = process.env.KIMI_MODEL_THINKING_EFFORT;
  process.env.KIMI_MODEL_THINKING_EFFORT = 'forced-parent';
  try {
    const promise = collect(
      service.invoke('Hello', {
        reasoningEffortOverride: 'max',
        callbackEnv: {
          KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-effort-boolean-')),
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      reasoningEffortOverride: 'max',
      callbackEnv: { KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-effort-override-')) },
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
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3' });

  const promise = collect(
    service.invoke('Hello', {
      // kimi supports low/high/max — medium is an anthropic/openai value
      reasoningEffortOverride: 'medium',
      callbackEnv: { KIMI_SHARE_DIR: mkdtempSync(join(tmpdir(), 'kimi-share-effort-stale-')) },
    }),
  );
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  const expected = getCatEffort('kimi', undefined, 'kimi', 'kimi-code/k3');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, expected);
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
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        },
      }),
      'utf8',
    );
    writeFileSync(join(mcpServerDir, 'index.js'), '// stub', 'utf8');
    // #712: Create split entrypoint stubs so the fallback path finds them
    for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
      writeFileSync(join(mcpServerDir, entry), '// stub', 'utf8');
    }

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
    // #712: writeMcpConfigFile is now async — flush microtask queue so the
    // generator reaches spawnCli before we inspect spawnFn.mock.calls.
    await new Promise((r) => setImmediate(r));
    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpFlagIndex = args.indexOf('--mcp-config-file');
    assert.ok(mcpFlagIndex >= 0);
    const mcpPath = args[mcpFlagIndex + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.ok(mcpConfig.mcpServers['cat-cafe-collab'], 'split server cat-cafe-collab expected');
    assert.ok(mcpConfig.mcpServers['cat-cafe-memory'], 'split server cat-cafe-memory expected');
    assert.ok(mcpConfig.mcpServers.filesystem);
    assert.equal(mcpConfig.mcpServers.github, undefined, 'retired GitHub MCP must not be merged');
    assert.equal(mcpConfig.mcpServers['cat-cafe-collab'].command, process.execPath);
    assert.equal(mcpConfig.mcpServers['cat-cafe-collab'].env.CAT_CAFE_API_URL, 'http://127.0.0.1:3004');
    assert.equal(mcpConfig.mcpServers['cat-cafe-collab'].env.CAT_CAFE_INVOCATION_ID, 'invoke-123');
    assert.equal(mcpConfig.mcpServers['cat-cafe-collab'].env.CAT_CAFE_CALLBACK_TOKEN, 'token-123');
    assert.equal(mcpConfig.mcpServers['cat-cafe'], undefined, 'monolith must not be injected');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(mcpServerDir, { recursive: true, force: true });
  }
});

test('Kimi MCP config reads capabilities from runtime root while cwd is user project', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-cap-root-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'kimi-project-cap-root-'));
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'kimi-runtime-cap-root-'));
  const mcpServerDir = join(runtimeRoot, 'packages', 'mcp-server', 'dist');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    spawnFn,
    model: 'kimi-code/kimi-for-coding',
    mcpServerPath: join(mcpServerDir, 'index.js'),
  });

  try {
    mkdirSync(mcpServerDir, { recursive: true });
    writeFileSync(join(mcpServerDir, 'index.js'), '// stub', 'utf8');
    for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
      writeFileSync(join(mcpServerDir, entry), '// stub', 'utf8');
    }
    writeCapabilitiesConfig(runtimeRoot, [
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        globalEnabled: false,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [] },
      },
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [] },
      },
    ]);

    const promise = collect(
      service.invoke('Hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          KIMI_SHARE_DIR: shareDir,
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'invoke-cap-root',
          CAT_CAFE_CALLBACK_TOKEN: 'token-cap-root',
          CAT_CAFE_CAT_ID: 'opus',
        },
      }),
    );
    await new Promise((r) => setImmediate(r));
    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpPath = args[args.indexOf('--mcp-config-file') + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(
      mcpConfig.mcpServers['cat-cafe-collab'],
      undefined,
      'disabled runtime capability must not be injected',
    );
    assert.ok(mcpConfig.mcpServers['cat-cafe-memory'], 'enabled runtime capability must be injected');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('Kimi MCP merge excludes disabled capability-managed user entries', async () => {
  const shareDir = mkdtempSync(join(tmpdir(), 'kimi-share-disabled-merge-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'kimi-project-disabled-merge-'));
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'kimi-runtime-disabled-merge-'));
  const mcpServerDir = join(runtimeRoot, 'packages', 'mcp-server', 'dist');
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new KimiAgentService({
    spawnFn,
    model: 'kimi-code/kimi-for-coding',
    mcpServerPath: join(mcpServerDir, 'index.js'),
  });

  try {
    mkdirSync(join(projectDir, '.kimi'), { recursive: true });
    mkdirSync(mcpServerDir, { recursive: true });
    writeFileSync(join(mcpServerDir, 'index.js'), '// stub', 'utf8');
    for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
      writeFileSync(join(mcpServerDir, entry), '// stub', 'utf8');
    }
    writeCapabilitiesConfig(runtimeRoot, [
      {
        id: 'filesystem',
        type: 'mcp',
        globalEnabled: false,
        source: 'external',
        mcpServer: { command: 'npx', args: ['-y', '@mcp/fs'] },
      },
      {
        id: 'cat-cafe-memory',
        type: 'mcp',
        globalEnabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [] },
      },
    ]);
    writeFileSync(
      join(projectDir, '.kimi', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', '@mcp/fs-stale'] },
          'cat-cafe': { command: 'node', args: ['legacy-monolith.js'] },
          'my-tool': { command: 'node', args: ['tool.js'] },
        },
      }),
      'utf8',
    );

    const promise = collect(
      service.invoke('Hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          KIMI_SHARE_DIR: shareDir,
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'invoke-disabled-merge',
          CAT_CAFE_CALLBACK_TOKEN: 'token-disabled-merge',
          CAT_CAFE_CAT_ID: 'opus',
        },
      }),
    );
    await new Promise((r) => setImmediate(r));
    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpPath = args[args.indexOf('--mcp-config-file') + 1];
    const mcpConfig = JSON.parse(readFileSync(mcpPath, 'utf8'));
    assert.equal(
      mcpConfig.mcpServers.filesystem,
      undefined,
      'disabled capability must not be re-added from .kimi/mcp.json',
    );
    assert.equal(
      mcpConfig.mcpServers['cat-cafe'],
      undefined,
      'legacy monolith alias must not be re-added from .kimi/mcp.json',
    );
    assert.ok(mcpConfig.mcpServers['my-tool'], 'unmanaged user server should still be merged');
    assert.ok(mcpConfig.mcpServers['cat-cafe-memory'], 'enabled capability should still be injected');

    emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
    await promise;
  } finally {
    rmSync(shareDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(runtimeRoot, { recursive: true, force: true });
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
    // #712: Create split entrypoint stubs so the fallback path finds them
    for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
      writeFileSync(join(mcpServerDir, entry), '// stub', 'utf8');
    }
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
    // #712: writeMcpConfigFile is now async — flush microtask queue so the
    // generator reaches spawnCli before we inspect spawnFn.mock.calls.
    await new Promise((r) => setImmediate(r));

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpFlagIndex = args.indexOf('--mcp-config-file');
    assert.ok(mcpFlagIndex >= 0);
    const mcpPath = args[mcpFlagIndex + 1];
    const content = readFileSync(mcpPath, 'utf8');
    assert.ok(content.includes('cat-cafe-collab'), 'split server expected in config');
    assert.ok(!content.includes('"cat-cafe"'), 'monolith must not appear in config');

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

test('non-legacy kimi fallback: only kimi exists, no kimi-cli, meta events for session resume', async () => {
  // Isolate PATH: a bin dir with only `kimi` (no `kimi-cli`).  Keep a skeleton system
  // PATH so `which` itself is findable; the stub `kimi-cli` from the top-level setup
  // is NOT present.  A temp HOME ensures the fallback directory search in
  // resolveCliCommand (e.g. ~/.local/bin) cannot accidentally discover kimi-cli.
  const nonLegacyBinDir = mkdtempSync(join(tmpdir(), 'kimi-nonlegacy-bin-'));
  writeFileSync(join(nonLegacyBinDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  process.env.PATH = `${nonLegacyBinDir}:/usr/bin:/bin`;
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding', l0CompilerFn });

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
    assert.ok(command.includes('/kimi') && !command.includes('/kimi-cli'));

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

test('both kimi-cli and kimi absent: error emitted without leaking tempMcpConfig dir (regression guard for #944 intake P1 found by opus-48)', async () => {
  // Isolate PATH: no kimi or kimi-cli anywhere; temp HOME prevents fallback search.
  const emptyBinDir = mkdtempSync(join(tmpdir(), 'kimi-empty-bin-'));
  const tempHome = mkdtempSync(join(tmpdir(), 'kimi-empty-home-'));
  const tempShareDir = mkdtempSync(join(tmpdir(), 'kimi-share-empty-'));

  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  process.env.PATH = `${emptyBinDir}:/usr/bin:/bin`;
  process.env.HOME = tempHome;

  invalidateCliCommand('kimi-cli');
  invalidateCliCommand('kimi');

  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    // mcpServerPath non-empty + callbackEnv non-empty are the two preconditions for
    // writeMcpConfigFile() to actually create a tmp-mcp-* dir (per kimi-config.ts:252).
    // If the not-found early-return happened AFTER tempMcpConfig creation (the bug),
    // the dir would be left behind because finally cleanup is gated by the try block.
    const service = new KimiAgentService({
      spawnFn,
      mcpServerPath: '/dummy/cat-cafe-mcp-server.js',
    });

    // KIMI_SHARE_DIR routes writeMcpConfigFile()'s tmp-mcp-* prefix into our temp area,
    // so we can assert no dir is created there.
    const msgs = await collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_SHARE_DIR: tempShareDir },
      }),
    );

    // Should emit error + done (not-found path)
    const err = msgs.find((m) => m.type === 'error');
    assert.ok(err, 'expected error event when both kimi-cli and kimi are absent');
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'expected done event after error');

    // spawn should NOT have been called (kimi binary absent)
    assert.equal(spawnFn.mock.calls.length, 0, 'spawn should not be called when binary absent');

    // CRITICAL: no tmp-mcp-* dir leaked in shareDir (the regression we are guarding).
    // Before the fix (intake commit e939be0), tempMcpConfig was created BEFORE the
    // not-found check, so the dir survived because the try/finally was never entered.
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(tempShareDir).filter((name) => name.startsWith('tmp-mcp-'));
    assert.equal(
      entries.length,
      0,
      `tempMcpConfig leak: expected 0 tmp-mcp-* dirs in shareDir, found ${entries.length} (${entries.join(', ')})`,
    );
  } finally {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    rmSync(emptyBinDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(tempShareDir, { recursive: true, force: true });
    invalidateCliCommand('kimi-cli');
    invalidateCliCommand('kimi');
  }
});

// ---------------------------------------------------------------------------
// F203 Phase J — kimi native L0 channel (--agent-file + v2 engine)
// ---------------------------------------------------------------------------

/** PATH isolation helper: only `kimi` resolvable (no legacy `kimi-cli`). */
function enterNonLegacyKimiPath(t) {
  const binDir = mkdtempSync(join(tmpdir(), 'kimi-native-l0-bin-'));
  writeFileSync(join(binDir, 'kimi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), 'kimi-native-l0-home-'));
  process.env.PATH = `${binDir}:/usr/bin:/bin`;
  process.env.HOME = tempHome;
  invalidateCliCommand('kimi-cli');
  invalidateCliCommand('kimi');
  return () => {
    process.env.PATH = savedPath;
    process.env.HOME = savedHome;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
    invalidateCliCommand('kimi-cli');
    invalidateCliCommand('kimi');
  };
}

test('injectsL0Natively is false when legacy kimi-cli is resolvable', async () => {
  const service = new KimiAgentService({ model: 'kimi-code/kimi-for-coding' });
  assert.equal(service.injectsL0Natively(), false);
});

test('injectsL0Natively is true when only new kimi (kimi-code) is resolvable', async () => {
  const restore = enterNonLegacyKimiPath();
  try {
    const service = new KimiAgentService({ model: 'kimi-code/kimi-for-coding' });
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Hello', {
        systemPrompt: 'PACK_ONLY_MARKER',
        callbackEnv: { CAT_CAFE_USER_ID: 'user-1' },
      }),
    );
    // Flush microtasks until the CLI is spawned (MCP config write + L0 compile
    // are both async), then read the agent file BEFORE completion cleans it up.
    for (let i = 0; i < 20 && spawnFn.mock.calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
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
    const service = new KimiAgentService({
      spawnFn,
      model: 'kimi-code/k3',
      l0CompilerFn,
      mcpServerPath: '/dummy/cat-cafe-mcp-server.js',
    });

    const msgs = await collect(
      service.invoke('Hello', {
        callbackEnv: { KIMI_SHARE_DIR: tempShareDir, CAT_CAFE_API_URL: 'http://127.0.0.1:3004' },
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

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

test('legacy kimi-cli: no --agent-file, no v2 env flag, prompt keeps <system_instructions> wrap', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const l0CompilerFn = mock.fn(async () => 'L0_SHOULD_NOT_BE_COMPILED');
  const service = new KimiAgentService({ spawnFn, model: 'kimi-code/kimi-for-coding', l0CompilerFn });

  const promise = collect(service.invoke('Hello', { systemPrompt: 'IDENTITY_WRAP' }));
  emitKimiEvents(proc, [{ role: 'assistant', content: 'ok' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--agent-file'));
  const env = spawnFn.mock.calls[0].arguments[2]?.env ?? {};
  assert.ok(!('KIMI_CODE_EXPERIMENTAL_FLAG' in env));
  const promptFlagIndex = args.indexOf('--prompt');
  assert.ok(promptFlagIndex >= 0);
  assert.match(args[promptFlagIndex + 1], /<system_instructions>/);
  assert.match(args[promptFlagIndex + 1], /IDENTITY_WRAP/);
  assert.equal(l0CompilerFn.mock.calls.length, 0, 'legacy path must not compile L0');
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-match', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
    );
    await new Promise((r) => setImmediate(r));
    emitKimiEvents(proc, [{ role: 'assistant', content: 'resumed' }]);
    const msgs = await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    assert.ok(args.includes('--session'), 'matching fingerprint must resume');
    assert.equal(args[args.indexOf('--session') + 1], 'sess-match');
    const freshInfo = msgs.find((m) => m.type === 'system_info' && /l0_resume_fresh_start/.test(m.content ?? ''));
    assert.equal(freshInfo, undefined, 'no fresh-start notice on clean resume');
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-unknown', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(service.invoke('Hello', { callbackEnv: { KIMI_SHARE_DIR: shareDir } }));
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-shared', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
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
    const service = new KimiAgentService({ spawnFn, model: 'kimi-code/k3', l0CompilerFn });

    const promise = collect(
      service.invoke('Continue', { sessionId: 'sess-old', callbackEnv: { KIMI_SHARE_DIR: shareDir } }),
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
    const service = new KimiAgentService({ model: 'kimi-code/k3', l0CompilerFn });

    async function* spawnCliOverride() {
      yield { line: 'To resume this session: kimi -r sess-old', error: 'Failed to parse JSON line' };
      yield { role: 'assistant', session_id: 'sess-new', content: 'fresh' };
    }

    const msgs = await collect(
      service.invoke('Continue', {
        sessionId: 'sess-old',
        callbackEnv: { KIMI_SHARE_DIR: shareDir },
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
    const service = new KimiAgentService({ model: 'kimi-code/k3', l0CompilerFn });

    async function* spawnCliOverride() {
      yield { line: 'To resume this session: kimi -r sess-line-new', error: 'Failed to parse JSON line' };
      yield { role: 'assistant', content: 'hello' };
    }

    const msgs = await collect(
      service.invoke('Hello', { callbackEnv: { KIMI_SHARE_DIR: shareDir }, spawnCliOverride }),
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
