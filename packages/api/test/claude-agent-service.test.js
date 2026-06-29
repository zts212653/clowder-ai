/**
 * ClaudeAgentService Tests (CLI mode)
 * 测试布偶猫 CLI 子进程调用
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { ClaudeAgentService, pickGitBashPathFromWhere, resolveDefaultClaudeMcpServerPath } = await import(
  '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js'
);
const { getCatEffort } = await import('../dist/config/cat-config-loader.js');

ensureFakeCliOnPath('claude');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Create a mock child process for testing.
 */
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
    pid: 12345,
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

/** Create a mock SpawnFn */
function createMockSpawnFn(proc) {
  return mock.fn(() => proc);
}

function emitProcessExit(proc, code, signal = null) {
  process.nextTick(() => {
    proc._emitter.emit('exit', code, signal);
  });
}

/** Write NDJSON events to mock process stdout, then end with exit 0 */
function emitClaudeEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    emitProcessExit(proc, 0, null);
  });
  proc.stdout.end();
}

/** Fake L0 compiler: records the call + writes content to outPath. */
function buildFakeL0Compiler(content = 'COMPILED-L0-FOR-CAT') {
  const fn = async ({ catId, outPath }) => {
    fn.calls.push({ catId, outPath });
    if (outPath) writeFileSync(outPath, content, 'utf8');
    return content;
  };
  fn.calls = [];
  return fn;
}

function createClaudeAgentService(options = {}) {
  return new ClaudeAgentService({ l0CompilerFn: buildFakeL0Compiler(), ...options });
}

function writeCapabilitiesConfig(projectRoot, capabilities) {
  mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cat-cafe', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities }),
    'utf8',
  );
}

// --- Test cases ---

test('F203 AC-C5: -p carrier passes --system-prompt-file with compiled L0 path', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const l0CompilerFn = buildFakeL0Compiler('L0 for opus-47');
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  const promise = collect(service.invoke('hi'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  assert.equal(l0CompilerFn.calls.length, 1);
  assert.equal(l0CompilerFn.calls[0].catId, 'opus-47');
  const l0Path = l0CompilerFn.calls[0].outPath;
  assert.ok(l0Path && l0Path.length > 0, 'compiler called with an outPath');

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('-p'), 'still uses print carrier');
  const flagIdx = args.indexOf('--system-prompt-file');
  assert.ok(flagIdx >= 0, `--system-prompt-file present in argv: ${args.join(' ')}`);
  assert.equal(args[flagIdx + 1], l0Path);
  assert.ok(!args.includes('--append-system-prompt'), 'native L0 must not ride append-system-prompt');
});

test('F203 AC-C5: -p carrier removes compiled L0 temp dir after success', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const l0CompilerFn = buildFakeL0Compiler('L0 for opus-47');
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  const promise = collect(service.invoke('hi'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const l0Path = l0CompilerFn.calls[0].outPath;
  assert.equal(existsSync(l0Path), false, 'compiled L0 file is removed after success');
  assert.equal(existsSync(dirname(l0Path)), false, 'compiled L0 temp dir is removed after success');
});

test('F203 AC-C5: -p carrier advertises native L0 injection to route layer', () => {
  const service = createClaudeAgentService({ model: 'claude-test-model' });

  assert.equal(service.injectsL0Natively(), true);
});

// --- #840 ENAMETOOLONG fix: route append-system-prompt via file carrier ---

test('#840: long systemPrompt is passed via --append-system-prompt-file, not inline argv', async () => {
  const proc = createMockProcess();
  // Read the append-prompt file at the moment spawn is invoked — cleanup
  // happens in the finally block AFTER spawn completes, so reading the path
  // post-await would miss the file.
  let capturedAppendPath;
  let capturedAppendContent;
  const spawnFn = mock.fn((_cmd, args) => {
    const idx = args.indexOf('--append-system-prompt-file');
    if (idx >= 0) {
      capturedAppendPath = args[idx + 1];
      try {
        capturedAppendContent = readFileSync(capturedAppendPath, 'utf8');
      } catch {
        capturedAppendContent = undefined;
      }
    }
    return proc;
  });
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
  });

  // Simulate a long pack/briefing payload that would push CreateProcess
  // command line past the Windows 32,767-char limit (ENAMETOOLONG).
  const longPayload = `## pack briefing\n${'C:\\Users\\Administrator\\claude\\projects\\D--clowder-ai-packages-api\\memory\\MEMORY.md\n'.repeat(500)}`;

  const promise = collect(service.invoke('hi', { systemPrompt: longPayload }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];

  // The long payload must NEVER appear inline in argv (root cause of ENAMETOOLONG).
  assert.ok(
    !args.includes(longPayload),
    'long systemPrompt must not be passed as inline argv (would trigger ENAMETOOLONG on Windows)',
  );
  // No bare `--append-system-prompt <text>` carrier.
  assert.ok(
    !args.includes('--append-system-prompt'),
    'inline --append-system-prompt flag must not be used for systemPrompt',
  );

  // Instead, it must go through --append-system-prompt-file <path>.
  const appendFileIdx = args.indexOf('--append-system-prompt-file');
  assert.ok(
    appendFileIdx >= 0,
    `--append-system-prompt-file must be present: ${args.filter((a) => a.startsWith('--')).join(' ')}`,
  );
  assert.ok(typeof capturedAppendPath === 'string' && capturedAppendPath.length > 0, 'captured path during spawn');

  // File content captured at spawn time must equal the systemPrompt.
  assert.equal(capturedAppendContent, longPayload, 'append-system-prompt file content must equal systemPrompt');
});

test('#840: append-system-prompt temp file is removed after successful invocation', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
  });

  const promise = collect(service.invoke('hi', { systemPrompt: 'short pack' }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const appendFileIdx = args.indexOf('--append-system-prompt-file');
  assert.ok(appendFileIdx >= 0);
  const appendPath = args[appendFileIdx + 1];

  assert.equal(existsSync(appendPath), false, 'append temp file removed after success');
  assert.equal(existsSync(dirname(appendPath)), false, 'append temp dir removed after success');
});

test('#840: empty systemPrompt does not produce any append-system-prompt flag', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
  });

  const promise = collect(service.invoke('hi'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--append-system-prompt'));
  assert.ok(!args.includes('--append-system-prompt-file'));
});

// --- #840 R2 finding (砚砚): main prompt must not ride argv either ---

test('#840 R2: long main prompt is delivered via stdin, not as argv element (-p carrier)', async () => {
  // 砚砚 dynamic probe on PR head: invoke('x'.repeat(50000), {}) had
  // promptArgIndex=1, promptArgLength=50012, hasAppendFile=false. The Claude
  // CLI accepts `-p` with stdin (verified: `echo prompt | claude -p` → exit 0,
  // unrelated auth-only error). Move the main prompt off argv too.
  const proc = createMockProcess();
  // Use spawnCliOverride seam so we observe the cli-spawn-level options
  // (stdinInput) directly, not just the raw argv list.
  let capturedCliOpts;
  const spawnCliOverride = (cliOpts) => {
    capturedCliOpts = cliOpts;
    // Return a minimal async iterable that yields a success result and ends,
    // so invoke() can complete the finally block without hanging.
    return (async function* () {
      yield { type: 'result', subtype: 'success' };
    })();
  };
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn: createMockSpawnFn(proc), // not actually invoked when spawnCliOverride is set
    model: 'claude-test-model',
  });

  const longPrompt = `## A2A briefing\n${'x'.repeat(50000)}`;
  await collect(service.invoke(longPrompt, { spawnCliOverride }));

  assert.ok(capturedCliOpts, 'spawnCliOverride was called');
  const args = capturedCliOpts.args;

  // Long prompt must NEVER appear as an argv element (root of ENAMETOOLONG).
  assert.ok(
    !args.some((a) => typeof a === 'string' && a.length > 1000),
    `no argv element should be larger than 1KB; offenders: ${args
      .filter((a) => typeof a === 'string' && a.length > 1000)
      .map((a) => a.slice(0, 40))
      .join(' / ')}`,
  );
  assert.ok(!args.includes(longPrompt), 'long prompt must not appear inline in argv');

  // -p flag must still be present (we still want print mode).
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx >= 0, '-p flag still present');

  // After -p there must NOT be the prompt as a positional argument
  // (it should now flow via stdinInput instead). The next token must either
  // be another flag (starts with '-') or be absent.
  // NOTE: arg at -p+1 might be `effectivePrompt` historically; assert it isn't
  // the long prompt.
  const tokenAfterP = args[pIdx + 1];
  assert.notEqual(tokenAfterP, longPrompt, 'token after -p must not be the long prompt');

  // stdinInput must carry the full prompt content.
  assert.equal(typeof capturedCliOpts.stdinInput, 'string', 'stdinInput is set on cliOpts');
  assert.equal(capturedCliOpts.stdinInput, longPrompt, 'stdinInput equals the full prompt');
});

test('F203 AC-C5: -p carrier reports L0 compile failure without spawning claude and removes temp dir', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const failingCompiler = async ({ outPath }) => {
    failingCompiler.outPath = outPath;
    if (outPath) writeFileSync(outPath, 'partial L0', 'utf8');
    throw new Error('compiler exploded');
  };
  failingCompiler.outPath = undefined;
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: failingCompiler,
  });

  const msgs = await collect(service.invoke('hi'));

  assert.equal(spawnFn.mock.calls.length, 0, 'claude must not spawn when L0 compile fails');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].type, 'error');
  assert.match(msgs[0].error, /L0 compile failed.*opus-47.*compiler exploded/);
  assert.equal(msgs[1].type, 'done');
  assert.ok(failingCompiler.outPath);
  assert.equal(existsSync(failingCompiler.outPath), false, 'partial L0 file is removed after compile failure');
  assert.equal(existsSync(dirname(failingCompiler.outPath)), false, 'L0 temp dir is removed after compile failure');
});

test('F203 AC-C5: -p carrier removes compiled L0 temp dir after CLI failure', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const l0CompilerFn = buildFakeL0Compiler('L0 for opus-47');
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  const promise = collect(service.invoke('crash'));
  proc.stderr.write('Error: authentication failed\n');
  proc.stdout.end();
  emitProcessExit(proc, 1, null);
  await promise;

  const l0Path = l0CompilerFn.calls[0].outPath;
  assert.equal(existsSync(l0Path), false, 'compiled L0 file is removed after CLI failure');
  assert.equal(existsSync(dirname(l0Path)), false, 'compiled L0 temp dir is removed after CLI failure');
});

test('F203 AC-C5: cliConfigArgs cannot override reserved Claude system prompt flags', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const l0CompilerFn = buildFakeL0Compiler('L0 for opus-47');
  const service = createClaudeAgentService({
    catId: 'opus-47',
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  const promise = collect(
    service.invoke('hi', {
      cliConfigArgs: [
        '--system-prompt-file /tmp/attacker.md',
        '--append-system-prompt ATTACKER_APPEND',
        '--append-system-prompt-file ./attacker-append.md',
        '--append-system-prompt-file=./attacker-append-equals.md',
        '--system-prompt=ATTACKER_REPLACE',
      ],
    }),
  );
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const l0Path = l0CompilerFn.calls[0].outPath;
  assert.equal(args.filter((arg) => arg === '--system-prompt-file').length, 1);
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], l0Path);
  assert.ok(!args.includes('/tmp/attacker.md'));
  assert.ok(!args.includes('--append-system-prompt'));
  assert.ok(!args.includes('ATTACKER_APPEND'));
  assert.ok(!args.includes('--append-system-prompt-file'));
  assert.ok(!args.includes('./attacker-append.md'));
  assert.ok(!args.some((arg) => arg.startsWith('--append-system-prompt-file=')));
  assert.ok(!args.some((arg) => arg.startsWith('--system-prompt=')));
});

test('yields session_init, text, and done on basic success', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sess-abc' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    { type: 'result', subtype: 'success', session_id: 'sess-abc' },
  ]);

  const msgs = await promise;

  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].type, 'session_init');
  assert.equal(msgs[0].sessionId, 'sess-abc');
  assert.equal(msgs[1].type, 'text');
  assert.equal(msgs[1].content, 'Hi!');
  assert.equal(msgs[2].type, 'done');
});

test('handles tool_use content blocks', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('read file'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/foo.ts' },
          },
        ],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;

  const toolMsg = msgs.find((m) => m.type === 'tool_use');
  assert.ok(toolMsg);
  assert.equal(toolMsg.toolName, 'Read');
  assert.deepEqual(toolMsg.toolInput, { file_path: '/foo.ts' });
});

test('handles mixed text and tool_use in single assistant message', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('do stuff'));

  emitClaudeEvents(proc, [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me read that.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'text', text: 'Done reading.' },
        ],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  // 3 content messages + 1 done
  const contentMsgs = msgs.filter((m) => m.type !== 'done');
  assert.equal(contentMsgs.length, 3);
  assert.equal(contentMsgs[0].type, 'text');
  assert.equal(contentMsgs[0].content, 'Let me read that.');
  assert.equal(contentMsgs[1].type, 'tool_use');
  assert.equal(contentMsgs[1].toolName, 'Read');
  assert.equal(contentMsgs[2].type, 'text');
  assert.equal(contentMsgs[2].content, 'Done reading.');
});

test('passes --resume flag when sessionId is provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('continue', { sessionId: 'resume-123' }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('resume-123'));
});

test('does not include --resume when no sessionId', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hello'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--resume'));
});

test('passes cwd from workingDirectory option', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi', { workingDirectory: '/my/project' }));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  assert.equal(spawnOpts.cwd, '/my/project');
});

test('preserves inherited Anthropic credentials when no profile mode override is supplied', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-keep',
          CAT_CAFE_CALLBACK_TOKEN: 'token-keep',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, 'sk-inherited');
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, 'https://inherited.example.com');
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('F062: subscription profile clears inherited ANTHROPIC env vars', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-1',
          CAT_CAFE_CALLBACK_TOKEN: 'token-1',
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, undefined);
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('#883: subscription profile clears ANTHROPIC_AUTH_TOKEN to prevent proxy bearer token leak', async () => {
  const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-proxy-token';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn, model: 'claude-test-model' });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-883',
          CAT_CAFE_CALLBACK_TOKEN: 'token-883',
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_AUTH_TOKEN, undefined);
  } finally {
    if (prevAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevAuthToken;
  }
});

test('#883: subscription deny-list survives accountEnv merge (proxy token in account env)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn, model: 'claude-test-model' });

  const promise = collect(
    service.invoke('hello', {
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: 'inv-883b',
        CAT_CAFE_CALLBACK_TOKEN: 'token-883b',
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'subscription',
      },
      // Account-level env contains a proxy token that must NOT leak
      accountEnv: {
        ANTHROPIC_AUTH_TOKEN: 'proxy-bearer-leaked',
        ANTHROPIC_API_KEY: 'sk-account-leaked',
      },
    }),
  );
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  assert.equal(
    spawnOpts.env.ANTHROPIC_AUTH_TOKEN,
    undefined,
    'ANTHROPIC_AUTH_TOKEN from accountEnv must be cleared in subscription mode',
  );
  assert.equal(
    spawnOpts.env.ANTHROPIC_API_KEY,
    undefined,
    'ANTHROPIC_API_KEY from accountEnv must be cleared in subscription mode',
  );
});

test('F062: api_key profile injects ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL', async () => {
  const prevApiKey = process.env.ANTHROPIC_API_KEY;
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-inherited';
  process.env.ANTHROPIC_BASE_URL = 'https://inherited.example.com';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  try {
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-2',
          CAT_CAFE_CALLBACK_TOKEN: 'token-2',
          CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
          CAT_CAFE_ANTHROPIC_API_KEY: 'sk-sponsor',
          CAT_CAFE_ANTHROPIC_BASE_URL: 'https://sponsor.example.com',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const spawnOpts = spawnFn.mock.calls[0].arguments[2];
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, 'sk-sponsor');
    assert.equal(spawnOpts.env.ANTHROPIC_BASE_URL, 'https://sponsor.example.com');
  } finally {
    if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevApiKey;
    if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  }
});

test('pickGitBashPathFromWhere accepts nonstandard bash.exe locations returned by where', () => {
  const whereOutput = [
    'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ].join('\r\n');

  const resolved = pickGitBashPathFromWhere(
    whereOutput,
    (candidate) => candidate === 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  );

  assert.equal(resolved, 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe');
});

test('pickGitBashPathFromWhere skips System32 bash.exe when a Git Bash candidate exists later in PATH', () => {
  const whereOutput = [
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  ].join('\r\n');

  const resolved = pickGitBashPathFromWhere(
    whereOutput,
    (candidate) =>
      candidate === 'C:\\Windows\\System32\\bash.exe' ||
      candidate === 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe',
  );

  assert.equal(resolved, 'C:\\Users\\lang\\scoop\\apps\\git\\current\\bin\\bash.exe');
});

test('yields error on result/error event', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('bad'));

  emitClaudeEvents(proc, [{ type: 'result', subtype: 'error', errors: ['rate limited', 'try again'] }]);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.equal(errMsg.error, 'rate limited; try again');
});

test('yields error on CLI non-zero exit', async () => {
  const proc = createMockProcess();
  // Override kill to not auto-exit (we control exit manually)
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('crash'));

  proc.stderr.write('Error: authentication failed\n');
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  // Error message is sanitized — contains exit code but not raw stderr
  assert.ok(errMsg.error.includes('code: 1'));
  // Raw stderr should NOT be exposed to users (no more 'authentication failed')
  assert.ok(!errMsg.error.includes('authentication failed'), 'stderr should be sanitized');
});

test('yields actionable rescue hint on invalid thinking signature resume failure', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('resume me', { sessionId: 'sess-bad-thinking' }));

  proc.stderr.write(
    'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0: Invalid `signature` in `thinking` block"}}\n',
  );
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.ok(errMsg.error.includes('thinking signature'));
  assert.ok(errMsg.error.includes('pnpm rescue:claude:thinking'));
  assert.ok(errMsg.error.includes('sess-bad-thinking'));
  assert.ok(!errMsg.error.includes('messages.1.content.0'));
});

test('does not duplicate error when result/error is followed by non-zero exit', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('bad'));

  proc.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['rate limited'],
    })}\n`,
  );
  proc.stderr.write('rate limited\n');
  proc.stdout.end();
  emitProcessExit(proc, 1, null);

  const msgs = await promise;
  const errors = msgs.filter((m) => m.type === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'rate limited');
});

test('includes exit signal in CLI error message when no exit code (stderr sanitized)', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('crash'));

  proc.stderr.write('killed by supervisor\n');
  proc.stdout.end();
  emitProcessExit(proc, null, 'SIGKILL');

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  // Sanitized message includes signal info
  assert.ok(errMsg.error.includes('SIGKILL'));
  // Raw stderr should NOT be exposed to users
  assert.ok(!errMsg.error.includes('killed by supervisor'), 'stderr should be sanitized');
});

test('yields error on spawn ENOENT', async () => {
  const proc = createMockProcess();
  proc.kill = mock.fn(() => true);
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi'));

  process.nextTick(() => {
    const err = new Error('spawn claude ENOENT');
    err.code = 'ENOENT';
    proc._emitter.emit('error', err);
    proc.stdout.end();
    emitProcessExit(proc, null, null);
  });

  const msgs = await promise;
  const errMsg = msgs.find((m) => m.type === 'error');
  assert.ok(errMsg);
  assert.ok(errMsg.error.includes('ENOENT'));
});

test('ignores system/hook and unknown event types', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'hook', hookId: 'h1' },
    { type: 'system', subtype: 'init', session_id: 'sid' },
    { type: 'unknown_type', data: 'something' },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  // F212 Phase G (AC-G4): system/hook/unknown events trigger silent_completion diagnostic
  // (eventCount>0, textEventCount=0). Was previously msgs.length === 2 (only session_init +
  // done); now includes a silent_completion system_info notice surfacing event evidence.
  const sessionInit = msgs.find((m) => m.type === 'session_init');
  const done = msgs.find((m) => m.type === 'done');
  const silent = msgs.find(
    (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
  );
  assert.ok(sessionInit, 'session_init still yielded');
  assert.ok(done, 'done still yielded');
  assert.ok(silent, 'silent_completion diagnostic surfaces (Phase G AC-G4 — was previously silent backend warn)');
});

test('all messages have catId opus', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('check'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 's1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  for (const msg of msgs) {
    assert.equal(msg.catId, 'opus', `expected catId opus, got ${msg.catId}`);
  }
});

test('passes correct model flag (default and custom)', async () => {
  // Default model
  const proc1 = createMockProcess();
  const spawnFn1 = createMockSpawnFn(proc1);
  const service1 = createClaudeAgentService({ spawnFn: spawnFn1 });

  const p1 = collect(service1.invoke('hi'));
  emitClaudeEvents(proc1, [{ type: 'result', subtype: 'success' }]);
  await p1;

  const args1 = spawnFn1.mock.calls[0].arguments[1];
  const modelIdx1 = args1.indexOf('--model');
  assert.ok(modelIdx1 >= 0);
  // F32-b: getCatModel('opus') resolves via catRegistry (populated from runtime config).
  assert.equal(args1[modelIdx1 + 1], 'claude-opus-4-6');

  // Custom model (explicit constructor param)
  const proc2 = createMockProcess();
  const spawnFn2 = createMockSpawnFn(proc2);
  const service2 = createClaudeAgentService({ spawnFn: spawnFn2, model: 'haiku' });

  const p2 = collect(service2.invoke('hi'));
  emitClaudeEvents(proc2, [{ type: 'result', subtype: 'success' }]);
  await p2;

  const args2 = spawnFn2.mock.calls[0].arguments[1];
  const modelIdx2 = args2.indexOf('--model');
  assert.equal(args2[modelIdx2 + 1], 'haiku');
});

test('F32-b P1 regression: env var CAT_*_MODEL overrides default when model not passed', async () => {
  // Simulate index.ts pattern: pass catId but NOT model → constructor resolves via getCatModel()
  // getCatModel() should respect env var > catRegistry
  const saved = process.env.CAT_OPUS_MODEL;
  process.env.CAT_OPUS_MODEL = 'env-override-model';
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);
    // NOTE: explicit catId, no `model` param — matches the fixed index.ts pattern
    const service = createClaudeAgentService({ catId: 'opus', spawnFn });

    const p = collect(service.invoke('hi'));
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await p;

    const args = spawnFn.mock.calls[0].arguments[1];
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx >= 0, '--model flag should be present');
    assert.equal(
      args[modelIdx + 1],
      'env-override-model',
      'CAT_OPUS_MODEL env var should take priority over config default',
    );
  } finally {
    if (saved === undefined) delete process.env.CAT_OPUS_MODEL;
    else process.env.CAT_OPUS_MODEL = saved;
  }
});

test('passes --include-partial-messages flag for incremental stream-json output', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('stream please'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('--include-partial-messages'));
});

test('streams text deltas from stream_event without duplicating final assistant payload', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('delta test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid' },
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-1' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      },
    },
    {
      type: 'assistant',
      message: {
        id: 'msg-1',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);

  const msgs = await promise;
  const texts = msgs.filter((m) => m.type === 'text').map((m) => m.content);
  assert.deepEqual(texts, ['Hello ', 'world']);
});

test('does not pass --allowedTools — all tools available by default', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('hi'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(!args.includes('--allowedTools'), 'must NOT pass --allowedTools so all tools are available');
});

test('resolves default MCP server path from API cwd (../mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-'));
  const apiCwd = join(root, 'packages', 'api');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(apiCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(apiCwd);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves default MCP server path from repo root (packages/mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-root-'));
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(root);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolves default MCP server path from deep tooling cwd (../../packages/mcp-server/dist/index.js)', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-deep-'));
  const deepCwd = join(root, 'tools', 'runner');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(deepCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(deepCwd);
    assert.equal(resolved, join(mcpDistDir, 'index.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns undefined when no default MCP server candidate exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-path-missing-'));
  const apiCwd = join(root, 'packages', 'api');
  mkdirSync(apiCwd, { recursive: true });

  try {
    const resolved = resolveDefaultClaudeMcpServerPath(apiCwd);
    assert.equal(resolved, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#712: merges user .mcp.json servers as base layer — managed entries take precedence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-mcp-merge-'));
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  const projectDir = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-project-'));
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), '// stub', 'utf8');
  for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
    writeFileSync(join(mcpDistDir, entry), '// stub', 'utf8');
  }
  // User .mcp.json with a custom server and a stale managed server
  writeFileSync(
    join(projectDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@mcp/fs'] },
        'cat-cafe-collab': { command: 'echo', args: ['stale-should-be-ignored'] },
      },
    }),
    'utf8',
  );

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    spawnFn,
    model: 'claude-test-model',
    mcpServerPath: join(mcpDistDir, 'index.js'),
  });

  try {
    const promise = collect(
      service.invoke('hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-merge',
          CAT_CAFE_CALLBACK_TOKEN: 'token-merge',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpConfigIdx = args.indexOf('--mcp-config');
    assert.ok(mcpConfigIdx >= 0, '--mcp-config should be present');
    assert.ok(args.includes('--strict-mcp-config'), '--strict-mcp-config should be present');

    const parsed = JSON.parse(args[mcpConfigIdx + 1]);
    // User-owned server should be merged in
    assert.ok(parsed.mcpServers.filesystem, 'user-owned filesystem should be merged');
    assert.deepEqual(parsed.mcpServers.filesystem.args, ['-y', '@mcp/fs']);
    // Managed split servers should be present
    assert.ok(parsed.mcpServers['cat-cafe-collab'], 'managed cat-cafe-collab should be present');
    // Stale user copy should NOT override managed entry
    assert.notEqual(parsed.mcpServers['cat-cafe-collab'].command, 'echo', 'stale user entry must not override managed');
    assert.equal(
      parsed.mcpServers['cat-cafe-collab'].command,
      process.execPath,
      'managed entry should use the runtime Node executable',
    );
    assert.equal(
      parsed.mcpServers['cat-cafe-collab'].env.ALLOWED_WORKSPACE_DIRS,
      projectDir,
      'managed split servers must receive the invocation workspace root',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('#712: Claude reads capabilities from runtime root while cwd is user project', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-runtime-root-'));
  const mcpDistDir = join(runtimeRoot, 'packages', 'mcp-server', 'dist');
  const projectDir = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-cap-root-'));
  mkdirSync(mcpDistDir, { recursive: true });
  for (const entry of ['index.js', 'collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
    writeFileSync(join(mcpDistDir, entry), '// stub', 'utf8');
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

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    spawnFn,
    model: 'claude-test-model',
    mcpServerPath: join(mcpDistDir, 'index.js'),
  });

  try {
    const promise = collect(
      service.invoke('hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-cap-root',
          CAT_CAFE_CALLBACK_TOKEN: 'token-cap-root',
          CAT_CAFE_CAT_ID: 'opus',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const parsed = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.equal(parsed.mcpServers['cat-cafe-collab'], undefined, 'disabled runtime capability must not be injected');
    assert.ok(parsed.mcpServers['cat-cafe-memory'], 'enabled runtime capability must be injected');
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('#712: Claude merge excludes disabled capability-managed user entries', async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-disabled-merge-runtime-'));
  const mcpDistDir = join(runtimeRoot, 'packages', 'mcp-server', 'dist');
  const projectDir = mkdtempSync(join(tmpdir(), 'cat-cafe-claude-disabled-merge-project-'));
  mkdirSync(mcpDistDir, { recursive: true });
  for (const entry of ['index.js', 'collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
    writeFileSync(join(mcpDistDir, entry), '// stub', 'utf8');
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
    join(projectDir, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@mcp/fs-stale'] },
        'cat-cafe': { command: 'node', args: ['legacy-monolith.js'] },
        'my-tool': { command: 'node', args: ['tool.js'] },
      },
    }),
    'utf8',
  );

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    spawnFn,
    model: 'claude-test-model',
    mcpServerPath: join(mcpDistDir, 'index.js'),
  });

  try {
    const promise = collect(
      service.invoke('hello', {
        workingDirectory: projectDir,
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-disabled-merge',
          CAT_CAFE_CALLBACK_TOKEN: 'token-disabled-merge',
          CAT_CAFE_CAT_ID: 'opus',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const parsed = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
    assert.equal(parsed.mcpServers.filesystem, undefined, 'disabled capability must not be re-added from .mcp.json');
    assert.equal(parsed.mcpServers['cat-cafe'], undefined, 'legacy monolith alias must not be re-added from .mcp.json');
    assert.ok(parsed.mcpServers['my-tool'], 'unmanaged user server should still be merged');
    assert.ok(parsed.mcpServers['cat-cafe-memory'], 'enabled capability should still be injected');
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('falls back to default MCP path when CAT_CAFE_MCP_SERVER_PATH is empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cat-cafe-mcp-empty-env-'));
  const apiCwd = join(root, 'packages', 'api');
  const mcpDistDir = join(root, 'packages', 'mcp-server', 'dist');
  mkdirSync(apiCwd, { recursive: true });
  mkdirSync(mcpDistDir, { recursive: true });
  writeFileSync(join(mcpDistDir, 'index.js'), 'export {};', 'utf8');
  // #712: Create split entrypoint stubs so the fallback path resolves them
  for (const entry of ['collab.js', 'memory.js', 'signals.js', 'limb.js', 'finance.js']) {
    writeFileSync(join(mcpDistDir, entry), 'export {};', 'utf8');
  }

  const previousCwd = process.cwd();
  const previousEnv = process.env.CAT_CAFE_MCP_SERVER_PATH;
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  try {
    process.chdir(apiCwd);
    process.env.CAT_CAFE_MCP_SERVER_PATH = '';

    const service = createClaudeAgentService({ spawnFn, model: 'claude-test-model' });
    const promise = collect(
      service.invoke('hello', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://localhost:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-1',
          CAT_CAFE_CALLBACK_TOKEN: 'token-1',
        },
      }),
    );
    emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
    await promise;

    const args = spawnFn.mock.calls[0].arguments[1];
    const mcpConfigIdx = args.indexOf('--mcp-config');
    assert.ok(mcpConfigIdx >= 0, '--mcp-config should be present when fallback resolves');
    const parsed = JSON.parse(args[mcpConfigIdx + 1]);
    // #712: Split servers instead of monolith cat-cafe
    assert.ok(parsed.mcpServers['cat-cafe-collab'], 'split server cat-cafe-collab expected');
    assert.equal(parsed.mcpServers['cat-cafe'], undefined, 'monolith must not be injected');
    assert.equal(
      realpathSync(parsed.mcpServers['cat-cafe-collab'].args[0]),
      realpathSync(join(mcpDistDir, 'collab.js')),
    );
  } finally {
    process.chdir(previousCwd);
    if (previousEnv === undefined) {
      delete process.env.CAT_CAFE_MCP_SERVER_PATH;
    } else {
      process.env.CAT_CAFE_MCP_SERVER_PATH = previousEnv;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('F8: result/success extracts usage into done metadata', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Hello'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sess-usage' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-usage',
      usage: { input_tokens: 1234, output_tokens: 567 },
      total_cost_usd: 0.05,
      duration_ms: 3000,
      duration_api_ms: 2500,
      num_turns: 3,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done, 'should have done message');
  assert.ok(done.metadata?.usage, 'done should have usage in metadata');
  assert.equal(done.metadata.usage.inputTokens, 1234);
  assert.equal(done.metadata.usage.outputTokens, 567);
  assert.equal(done.metadata.usage.costUsd, 0.05);
  assert.equal(done.metadata.usage.durationMs, 3000);
  assert.equal(done.metadata.usage.numTurns, 3);
});

test('F24: extracts contextWindowSize from result.modelUsage (camelCase)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('Context window test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2000, output_tokens: 300 },
      modelUsage: {
        'claude-opus-4-6': {
          contextWindow: 200000,
        },
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  assert.equal(
    done.metadata.usage.contextWindowSize,
    200000,
    'should read contextWindow from modelUsage camelCase payload',
  );
});

test('F24: extracts contextWindowSize from result.model_usage (snake_case)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('snake case test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1000, output_tokens: 100 },
      model_usage: {
        'claude-opus-4-6': {
          context_window: 200000,
        },
      },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  assert.equal(done.metadata.usage.contextWindowSize, 200000);
});

test('F8: normalises inputTokens to include cache tokens (Claude API → total)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('cache test'));

  emitClaudeEvents(proc, [
    {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 4,
        output_tokens: 263,
        cache_read_input_tokens: 95000,
        cache_creation_input_tokens: 0,
      },
      total_cost_usd: 0.17,
      num_turns: 2,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // inputTokens = 4 (new) + 95000 (cache read) + 0 (cache create) = 95004
  assert.equal(done.metadata.usage.inputTokens, 95004);
  assert.equal(done.metadata.usage.outputTokens, 263);
  assert.equal(done.metadata.usage.cacheReadTokens, 95000);
  assert.equal(done.metadata.usage.costUsd, 0.17);
  assert.equal(done.metadata.usage.numTurns, 2);
  // cacheCreationTokens should be absent (was 0)
  assert.equal(done.metadata.usage.cacheCreationTokens, undefined);
});

test('F24-fix: lastTurnInputTokens extracted from last message_start usage', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('multi-turn'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid-ctx' },
    // Turn 1: message_start with usage
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-1',
          usage: { input_tokens: 10000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Turn 1' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Turn 2: message_start with larger context (last turn — this is the one we want)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-2',
          usage: { input_tokens: 5000, cache_read_input_tokens: 35000, cache_creation_input_tokens: 4000 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Turn 2' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Assistant final + result
    { type: 'assistant', message: { id: 'msg-2', content: [{ type: 'text', text: 'Turn 2' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 15000, // aggregated across turns (raw new tokens)
        output_tokens: 500,
        cache_read_input_tokens: 55000, // aggregated
        cache_creation_input_tokens: 4000,
      },
      num_turns: 2,
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // lastTurnInputTokens = last message_start: 5000 + 35000 + 4000 = 44000
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    44000,
    'lastTurnInputTokens should be sum of last message_start usage (raw + cache_read + cache_create)',
  );
  // inputTokens is still the aggregated value: 15000 + 55000 + 4000 = 74000
  assert.equal(done.metadata.usage.inputTokens, 74000, 'inputTokens should still be the aggregated total');
});

test('F24-fix: lastTurnInputTokens is undefined when no message_start has usage', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('no-stream'));

  emitClaudeEvents(proc, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi!' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1000, output_tokens: 200 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // No stream events → no lastTurnInputTokens
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    undefined,
    'lastTurnInputTokens should be undefined when no message_start has usage',
  );
  // Aggregated inputTokens still works
  assert.equal(done.metadata.usage.inputTokens, 1000);
});

test('F24-fix: lastTurnInputTokens resets when final message_start has no usage (no stale carryover)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn });

  const promise = collect(service.invoke('stale-test'));

  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'sid-stale' },
    // Turn 1: message_start WITH usage (sets lastTurnInputTokens = 3000)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg-stale-1',
          usage: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'T1' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Turn 2: message_start WITHOUT usage (should clear, not carry over 3000)
    {
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { id: 'msg-stale-2' },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'T2' } },
    },
    { type: 'stream_event', event: { type: 'message_stop' } },
    // Final
    { type: 'assistant', message: { id: 'msg-stale-2', content: [{ type: 'text', text: 'T2' }] } },
    {
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 2000, output_tokens: 300 },
    },
  ]);

  const msgs = await promise;
  const done = msgs.find((m) => m.type === 'done');
  assert.ok(done?.metadata?.usage);
  // The final message_start had no usage → lastTurnInputTokens must be undefined, NOT 3000
  assert.equal(
    done.metadata.usage.lastTurnInputTokens,
    undefined,
    'lastTurnInputTokens must not carry over from a previous turn when the final turn lacks usage',
  );
});

// ── Model override regression tests (third-party Anthropic-compatible APIs) ──

test('third-party model (glm-5): omits --model flag and injects ANTHROPIC_MODEL env var', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn, model: 'claude-test-model' });

  const promise = collect(
    service.invoke('hello', {
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: 'inv-glm',
        CAT_CAFE_CALLBACK_TOKEN: 'token-glm',
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
        CAT_CAFE_ANTHROPIC_API_KEY: 'sk-bigmodel',
        CAT_CAFE_ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/paas',
        CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'glm-5',
      },
    }),
  );
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const spawnOpts = spawnFn.mock.calls[0].arguments[2];

  // --model must NOT appear in args for non-Anthropic models
  assert.ok(!args.includes('--model'), '--model flag must be omitted for third-party model glm-5');
  // ANTHROPIC_MODEL env var must carry the model name
  assert.equal(spawnOpts.env.ANTHROPIC_MODEL, 'glm-5', 'ANTHROPIC_MODEL env var must be set to glm-5');
});

test('native Anthropic model (claude-sonnet-4-6): keeps --model flag, no ANTHROPIC_MODEL env var', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ spawnFn, model: 'claude-test-model' });

  const promise = collect(
    service.invoke('hello', {
      callbackEnv: {
        CAT_CAFE_API_URL: 'http://localhost:3004',
        CAT_CAFE_INVOCATION_ID: 'inv-native',
        CAT_CAFE_CALLBACK_TOKEN: 'token-native',
        CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
        CAT_CAFE_ANTHROPIC_API_KEY: 'sk-anthropic',
        CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'claude-sonnet-4-6',
      },
    }),
  );
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const spawnOpts = spawnFn.mock.calls[0].arguments[2];
  const modelIdx = args.indexOf('--model');

  // --model must be present with the exact Anthropic model name
  assert.ok(modelIdx >= 0, '--model flag must be present for native Anthropic model');
  assert.equal(args[modelIdx + 1], 'claude-sonnet-4-6');
  // ANTHROPIC_MODEL must NOT be set (native model goes through --model)
  assert.ok(!spawnOpts.env.ANTHROPIC_MODEL, 'ANTHROPIC_MODEL env var must not be set for native Anthropic model');
});

test('native Anthropic model keeps --effort value adjacent when --model is inserted', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({ catId: 'opus', spawnFn, model: 'claude-opus-4-6' });

  const promise = collect(service.invoke('hello'));
  emitClaudeEvents(proc, [{ type: 'result', subtype: 'success' }]);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  const effortIdx = args.indexOf('--effort');
  const modelIdx = args.indexOf('--model');
  const expectedEffort = getCatEffort('opus', undefined, 'anthropic');

  assert.ok(effortIdx >= 0, '--effort flag must be present');
  assert.equal(
    args[effortIdx + 1],
    expectedEffort,
    `--effort must be followed by configured effort, argv: ${args.join(' ')}`,
  );
  assert.ok(modelIdx >= 0, '--model flag must be present for native Anthropic model');
  assert.notEqual(modelIdx, effortIdx + 1, '--model must not split the --effort flag/value pair');
  assert.equal(args[modelIdx + 1], 'claude-opus-4-6');
});

// F212 Phase G (AC-G4, clowder-ai#875 sibling sweep): ClaudeAgentService no-text branch
// should mirror OpenCode AC-G3 fix — eventCount > 0 && textEventCount === 0 yields
// silent_completion diagnostic notice. LL-069 sibling-sweep regression guard.
test('AC-G4: Claude eventCount>0 + textEvents=0 → yields silent_completion system_info diagnostic (sibling sweep)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    catId: 'opus',
    spawnFn,
    model: 'claude-opus-4-7',
  });
  const promise = collect(service.invoke('Test silent', { invocationId: 'inv-claude-silent' }));
  proc.stderr.write('Warning: Claude stderr without text output\n');
  // Emit a system event (counts toward eventCount) but no assistant/text event
  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'ses_claudefake' },
    { type: 'result', subtype: 'success' },
  ]);
  const messages = await promise;

  const silentNotice = messages.find(
    (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
  );
  assert.ok(
    silentNotice,
    `Claude AC-G4: expected silent_completion system_info; types: ${messages.map((m) => m.type).join(',')}`,
  );
  assert.equal(JSON.parse(silentNotice.content).type, 'silent_completion');
  assert.ok(
    !messages.some((m) => m.type === 'error' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
    'silent_completion is observability-only and MUST NOT travel as provider error',
  );
  assert.equal(silentNotice.metadata.cliDiagnostics.debugRef.invocationId, 'inv-claude-silent');
  assert.equal(
    silentNotice.metadata.cliDiagnostics.debugRef.exitCode,
    0,
    'silent_completion preserves clean exit code',
  );
  const evidence = JSON.parse(silentNotice.metadata.cliDiagnostics.safeExcerpt);
  assert.ok(evidence.eventCount >= 1, 'Claude evidence eventCount > 0');
  assert.ok(evidence.eventTypes.length > 0, 'Claude evidence has event types');
  assert.equal(evidence.stderrPresent, true, 'Claude successful-exit stderr presence is preserved');
  assert.match(
    evidence.stderrExcerpt,
    /Claude stderr without text output/,
    'Claude successful-exit stderr excerpt is preserved for diagnostics',
  );
  // Done event still yielded
  assert.ok(
    messages.some((m) => m.type === 'done'),
    'done event still yielded after Claude diagnostic',
  );
});

// F212 Phase G R1 P1 (cloud codex catch on 1d519e7f2 sibling sweep): Claude tool-only
// turns are legitimate per F215 AC-B3. assistant event with tool_use content block then
// result:success without text is NOT silent_completion.
test('AC-G4 R1 P1: Claude assistant tool_use block + result success → does NOT yield silent_completion', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    catId: 'opus',
    spawnFn,
    model: 'claude-opus-4-7',
  });
  const promise = collect(service.invoke('Use tools'));
  // Assistant event with tool_use content block (F215 AC-B3 pure-tool-use pattern)
  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'ses_toolonly' },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }],
      },
    },
    { type: 'result', subtype: 'success' },
  ]);
  const messages = await promise;

  const silentError = messages.find(
    (m) => m.type === 'error' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
  );
  assert.ok(
    !silentError,
    `Claude silent_completion MUST NOT fire when assistant emitted tool_use block (R1 P1 sibling guard): types=${messages.map((m) => m.type).join(',')}`,
  );
  const silentNotice = messages.find(
    (m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion',
  );
  assert.ok(
    !silentNotice,
    `Claude silent_completion system_info MUST NOT fire when assistant emitted tool_use block (R1 P1 sibling guard): types=${messages.map((m) => m.type).join(',')}`,
  );
});

test('AC-G4 cloud P2: Claude result is_error:true surfaces tool_call_parse_failed, not silent_completion', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = createClaudeAgentService({
    catId: 'opus',
    spawnFn,
    model: 'claude-opus-4-7',
  });
  const promise = collect(service.invoke('Malformed tool call', { invocationId: 'inv-claude-a2' }));
  emitClaudeEvents(proc, [
    { type: 'system', subtype: 'init', session_id: 'ses_result_error' },
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "The model's tool call could not be parsed (retry also failed).",
      errors: null,
    },
  ]);
  const messages = await promise;

  const resultError = messages.find((m) => m.type === 'error' && /could not be parsed/.test(m.error ?? ''));
  assert.ok(
    resultError,
    `Claude result is_error:true must yield the actual result error; types=${messages.map((m) => m.type).join(',')}`,
  );
  assert.equal(resultError.metadata?.cliDiagnostics?.reasonCode, 'tool_call_parse_failed');
  assert.match(resultError.metadata?.cliDiagnostics?.safeExcerpt ?? '', /could not be parsed/);
  assert.equal(resultError.metadata?.cliDiagnostics?.debugRef.invocationId, 'inv-claude-a2');
  assert.ok(
    !messages.some((m) => m.type === 'system_info' && m.metadata?.cliDiagnostics?.reasonCode === 'silent_completion'),
    'silent_completion MUST NOT fire when Claude result carries is_error:true',
  );
});
