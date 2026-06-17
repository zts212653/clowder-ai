/**
 * F230 Phase B: ClaudeInteractivePtyCarrierService tests
 *
 * Unit tests using a mock PtyDriver + real temp-file JSONL fixtures.
 * TranscriptTailer reads from real files (no mocking needed — it's pure I/O).
 *
 * TDD steps:
 *   Step 1: spike fixture → session_init → text → system_info → done; usage non-zero
 *   Step 2: abort signal → cancel() called; stream ends with error + done
 *   Step 3: tool_use in transcript → AgentMessage stream has type=tool_use
 *   Step 4: driver.start() throws → error+done yielded; dispose() called (no zombie)
 *  Step 13: image contentBlocks → --add-dir in extraArgs + [Local image path:] hint in prompt
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  ClaudeInteractivePtyCarrierService,
  ptyTranscriptDir,
} from '../dist/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js';
import { acquireTranscriptDirWatch } from '../dist/domains/cats/services/agents/providers/pty/pty-utils.js';

// Set env so getCatModel('opus') resolves without registry (test-env has no cat-catalog)
process.env.CAT_OPUS_MODEL = 'claude-opus-4-8';

// ─── Hook sidecar JSONL fixture builders (F230 B-hook) ────────────────────────

const TEST_SESSION_ID = 'f230test-1111-2222-3333-444444444444';

/** Stop hook event → text AgentMessage. Terminal signal. */
function stopEventLine(text, sessionId = TEST_SESSION_ID, entrypoint = undefined) {
  const evt = {
    hook_event_name: 'Stop',
    session_id: sessionId,
    last_assistant_message: text,
  };
  if (entrypoint) evt._cc_entrypoint = entrypoint;
  return JSON.stringify(evt);
}

/** PostToolUse hook event → tool_use AgentMessage. */
function postToolUseLine(toolName, input, sessionId = TEST_SESSION_ID) {
  return JSON.stringify({
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_name: toolName,
    tool_input: input ?? {},
    tool_response: '',
    tool_use_id: 'tu_test',
    duration_ms: 100,
  });
}

/** Write hook sidecar fixture file. Returns the path. */
async function writeSidecar(dir, lines) {
  const path = join(dir, 'hook-sidecar.jsonl');
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

// ─── MockPtyDriver ──────────────────────────────────────────────────────────────

class MockPtyDriver {
  calls = { start: 0, injectPrompt: 0, cancel: 0, dispose: 0 };
  /** If set, start() will throw this error */
  startError = null;
  /** Must be set before injectPrompt is called: { transcriptPath, sessionId } */
  injectResult = null;

  async start() {
    this.calls.start++;
    if (this.startError) throw this.startError;
  }

  async injectPrompt(_text, _transcriptDir) {
    this.calls.injectPrompt++;
    return this.injectResult;
  }

  async cancel() {
    this.calls.cancel++;
  }

  async dispose() {
    this.calls.dispose++;
  }
}

/** Drain async iterable into array, optionally calling onMessage per item. */
async function collect(gen, onMessage) {
  const msgs = [];
  for await (const msg of gen) {
    msgs.push(msg);
    if (onMessage) await onMessage(msg);
  }
  return msgs;
}

// ─── Step 1: happy path ──────────────────────────────────────────────────────

describe('ClaudeInteractivePtyCarrierService — Step 1: happy path (B-hook)', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s1-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('yields session_init → text → done via Stop hook event; usage degraded', async () => {
    const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('Hello from F230 hook')]);

    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    const msgs = await collect(carrier.invoke('test prompt'));

    // session_init
    const sessionInit = msgs.find((m) => m.type === 'session_init');
    assert.ok(sessionInit, 'session_init yielded');
    assert.equal(sessionInit.sessionId, TEST_SESSION_ID, 'sessionId matches');

    // text (from Stop hook's last_assistant_message)
    const text = msgs.find((m) => m.type === 'text');
    assert.ok(text, 'text yielded');
    assert.ok(text.content.includes('Hello from F230 hook'), 'text content matches hook response');

    // done
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded');
    assert.equal(done.isFinal, true, 'done.isFinal = true');

    // usage is degraded (hooks carry no token data)
    const usage = done?.metadata?.usage;
    assert.ok(usage, 'done.metadata.usage present (empty object)');
    assert.equal(usage.outputTokens, undefined, 'outputTokens undefined — hook has no usage data');

    // driver lifecycle
    assert.equal(mock.calls.start, 1, 'start() called once');
    assert.equal(mock.calls.injectPrompt, 1, 'injectPrompt() called once');
    assert.equal(mock.calls.dispose, 1, 'dispose() called once (cleanup)');
  });
});

// ─── Step 2: abort signal ────────────────────────────────────────────────────

describe('ClaudeInteractivePtyCarrierService — Step 2: abort signal', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s2-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('abort after session_init → cancel() called; stream ends with error+done', async () => {
    // Empty sidecar — no Stop event, loop would run indefinitely without abort
    const sidecarPath = await writeSidecar(tmpDir, []);

    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const controller = new AbortController();

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 30_000, // long — we abort before silence timeout
    });

    // Abort as soon as we see session_init
    const msgs = await collect(carrier.invoke('abort test', { signal: controller.signal }), (msg) => {
      if (msg.type === 'session_init') {
        controller.abort();
      }
    });

    // Must have error message for cancellation
    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'error yielded on abort');
    assert.ok(error.error.includes('cancel'), `error message mentions cancel: "${error.error}"`);

    // Must have done
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded after abort error');
    assert.equal(done.isFinal, true, 'done.isFinal = true');

    // cancel() must have been called on the driver
    assert.ok(mock.calls.cancel >= 1, `cancel() called at least once, got ${mock.calls.cancel}`);

    // dispose() must have been called (finally block)
    assert.equal(mock.calls.dispose, 1, 'dispose() called once (finally cleanup)');
  });
});

// ─── Step 3: tool_use in transcript ─────────────────────────────────────────

describe('ClaudeInteractivePtyCarrierService — Step 3: tool_use (B-hook)', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s3-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('PostToolUse hook event → AgentMessage stream contains type=tool_use', async () => {
    const sidecarPath = await writeSidecar(tmpDir, [
      postToolUseLine('cat_cafe_search_evidence', { query: 'F230' }),
      stopEventLine('Done with tool call'),
    ]);

    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    const msgs = await collect(carrier.invoke('call a tool'));

    const toolUse = msgs.find((m) => m.type === 'tool_use');
    assert.ok(toolUse, 'tool_use yielded');
    assert.equal(toolUse.toolName, 'cat_cafe_search_evidence', 'toolName matches');
    assert.deepEqual(toolUse.toolInput, { query: 'F230' }, 'toolInput matches');

    // done present (stream terminated normally via Stop event)
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded');
  });
});

// ─── Step 5: env delta contract (P1-1 regression) ───────────────────────────
// The carrier must pass opts.env as the delta (Record<string, string|null>)
// to PtyDriver — NOT the full merged process.env.
// After fix: opts.env is the raw envOverrides (delta); null=unset, string=set.

describe('ClaudeInteractivePtyCarrierService — Step 5: env delta contract', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s5-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('opts.env passed to driver is delta (null=unset, string=set), not merged process.env', async () => {
    const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('hello')]);
    let capturedOpts = null;
    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: (opts) => {
        capturedOpts = opts;
        return mock;
      },
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    await collect(carrier.invoke('test prompt'));

    assert.ok(capturedOpts, 'driverFactory was called');
    const env = capturedOpts.env;

    // Subscription mode: these must be null (unset)
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, null, 'CLAUDE_CODE_ENTRYPOINT must be null in delta');
    assert.equal(env.CLAUDECODE, null, 'CLAUDECODE must be null in delta');
    assert.equal(env.ANTHROPIC_API_KEY, null, 'ANTHROPIC_API_KEY must be null (subscription mode unset)');

    // Delta must NOT include process.env keys like PATH, HOME (it's a delta, not full env)
    assert.ok(!('PATH' in env), 'PATH must NOT be in env delta (not a full merged env)');
    assert.ok(!('HOME' in env), 'HOME must NOT be in env delta');

    // B-hook P1-1 fix: skipTranscriptAck must be passed to PtyDriver
    assert.equal(capturedOpts.skipTranscriptAck, true, 'skipTranscriptAck must be true (B-hook: no transcript ack)');
  });
});

// ─── Step 6: MCP config shape (P1-2 regression) ─────────────────────────────
// When callbackEnv + mcpServerPath present, --mcp-config must point to a
// JSON config file ({ mcpServers: { "cat-cafe": { command, args } } }),
// NOT directly to the MCP server JS path.

describe('ClaudeInteractivePtyCarrierService — Step 6: MCP config shape', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s6-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('callbackEnv + mcpServerPath → extraArgs has --mcp-config <json-file> with correct shape', async () => {
    // Create a fake MCP server JS file so existsSync passes
    const fakeMcpServerPath = join(tmpDir, 'fake-mcp-index.js');
    await writeFile(fakeMcpServerPath, '// fake mcp server', 'utf8');

    const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('ok')]);
    let capturedOpts = null;
    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: (opts) => {
        capturedOpts = opts;
        return mock;
      },
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
      mcpServerPath: fakeMcpServerPath, // test seam
    });

    await collect(carrier.invoke('test', { callbackEnv: { CAT_CAFE_SOME_CALLBACK: 'val' } }));

    assert.ok(capturedOpts, 'driverFactory was called');
    const extraArgs = capturedOpts.extraArgs ?? [];

    // --mcp-config must be present
    const mcpIdx = extraArgs.indexOf('--mcp-config');
    assert.ok(mcpIdx >= 0, '--mcp-config present in extraArgs');

    const mcpConfigValue = extraArgs[mcpIdx + 1];
    assert.ok(typeof mcpConfigValue === 'string', '--mcp-config has a value');

    // Value must be a JSON FILE path (not the JS server path directly)
    assert.ok(mcpConfigValue.endsWith('.json'), `--mcp-config value must be a .json file, got: ${mcpConfigValue}`);
    assert.notEqual(mcpConfigValue, fakeMcpServerPath, '--mcp-config must NOT be the raw JS path');

    // JSON file must have the correct mcpServers shape
    let config;
    try {
      config = JSON.parse(readFileSync(mcpConfigValue, 'utf8'));
    } catch (err) {
      assert.fail(`--mcp-config file is not valid JSON at ${mcpConfigValue}: ${err.message}`);
    }
    assert.ok(config.mcpServers, 'config.mcpServers present');
    const catCafe = config.mcpServers['cat-cafe'];
    assert.ok(catCafe, 'mcpServers["cat-cafe"] present');
    assert.equal(catCafe.command, 'node', 'mcpServers["cat-cafe"].command === "node"');
    assert.deepEqual(catCafe.args, [fakeMcpServerPath], 'mcpServers["cat-cafe"].args === [mcpServerPath]');

    // --strict-mcp-config must also be present
    assert.ok(extraArgs.includes('--strict-mcp-config'), '--strict-mcp-config present in extraArgs');
  });

  it('no callbackEnv → --mcp-config NOT injected', async () => {
    const fakeMcpServerPath = join(tmpDir, 'fake-mcp-index2.js');
    await writeFile(fakeMcpServerPath, '// fake', 'utf8');

    const sidecarPath2 = join(tmpDir, 'hook-sidecar-2.jsonl');
    writeFileSync(sidecarPath2, stopEventLine('ok') + '\n', 'utf8');
    let capturedOpts = null;
    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: (opts) => {
        capturedOpts = opts;
        return mock;
      },
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath2,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
      mcpServerPath: fakeMcpServerPath,
    });

    // No callbackEnv passed → MCP not injected
    await collect(carrier.invoke('test'));

    assert.ok(capturedOpts, 'driverFactory was called');
    const extraArgs = capturedOpts.extraArgs ?? [];
    assert.ok(!extraArgs.includes('--mcp-config'), '--mcp-config must NOT be present when no callbackEnv');
  });
});

// ─── Step 7a: resume sessionId passed to driver ─────────────────────────────
// Regression guard for P1-B: carrier must pass resumeSessionId to driverFactory
// when options.sessionId is a valid UUID.

describe('ClaudeInteractivePtyCarrierService — Step 7a: resume sessionId', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s7a-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('valid UUID sessionId → driverFactory receives resumeSessionId', async () => {
    const resumeId = 'aabbccdd-0011-2233-4455-667788990011';
    // Create transcript stub so resume existsSync check passes
    await writeFile(join(tmpDir, `${resumeId}.jsonl`), '', 'utf8');
    const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('resume reply', resumeId)]);

    let capturedOpts = null;
    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, `${resumeId}.jsonl`), sessionId: resumeId };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: (opts) => {
        capturedOpts = opts;
        return mock;
      },
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    await collect(carrier.invoke('continue', { sessionId: resumeId }));

    assert.ok(capturedOpts, 'driverFactory was called');
    assert.equal(capturedOpts.resumeSessionId, resumeId, 'resumeSessionId matches passed sessionId');
  });

  it('invalid/short sessionId → resumeSessionId is undefined', async () => {
    const sidecarPath2 = join(tmpDir, 'hook-sidecar-inv.jsonl');
    writeFileSync(sidecarPath2, stopEventLine('hello') + '\n', 'utf8');
    let capturedOpts = null;
    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: (opts) => {
        capturedOpts = opts;
        return mock;
      },
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath2,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    await collect(carrier.invoke('test', { sessionId: 'short-invalid-id' }));

    assert.ok(capturedOpts, 'driverFactory was called');
    assert.equal(capturedOpts.resumeSessionId, undefined, 'invalid sessionId → resumeSessionId=undefined');
  });
});

// ─── Step 8: trailing partial drain (P2 regression) ─────────────────────────
// When Claude flushes `system/turn_duration` without a trailing \n, the default
// readNew() drops it (partial line guard). The fix: when entries is empty, retry
// with { includeTrailingPartial: true } to catch the final flush race.

describe('ClaudeInteractivePtyCarrierService — Step 8: trailing partial drain (B-hook)', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s8-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('Stop event with no trailing \\n → detected via final drain, not silence timeout', async () => {
    // Write sidecar WITHOUT trailing \n — triggers the partial drain path.
    const path = join(tmpDir, 'hook-sidecar-partial.jsonl');
    // intentionally NO trailing \n
    const content = stopEventLine('hello from partial test');
    await writeFile(path, content, 'utf8');

    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: path,
      pollIntervalMs: 20,
      // Short timeout: without fix, done arrives via silence timeout.
      terminalTimeoutMs: 200,
    });

    const msgs = await collect(carrier.invoke('test trailing partial'));

    // Stop event (no trailing newline) must be detected via the final drain
    // (readNew({includeTrailingPartial:true})), NOT the silence-timeout fallback.
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded (terminal reached)');

    // Text content proves the Stop event was actually read (not silence timeout)
    const text = msgs.find((m) => m.type === 'text');
    assert.ok(text, 'text from Stop event must be yielded');
    assert.ok(text.content.includes('hello from partial test'), 'text content matches');
  });
});

// ─── Step 9: resume old transcript NOT replayed (P1-B regression) ───────────
// When the driver returns initialLines for a resume session, the carrier must create
// TranscriptTailer starting at that offset so old session content is not replayed.
//
// Before fix: carrier creates TranscriptTailer(path) ignoring initialLines=2 →
//   emittedLines starts at 0 → reads old assistant text + old turn_duration →
//   emits OLD_CONTENT and signals terminal immediately (RED).
//
// After fix: carrier creates TranscriptTailer(path, 2) → emittedLines starts at 2 →
//   no old content returned → silence timeout → done without old text (GREEN).

describe('ClaudeInteractivePtyCarrierService — Step 9: resume uses fresh sidecar (B-hook)', { timeout: 10_000 }, () => {
  let tmpDir;
  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s9-'));
  });
  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('resume session uses fresh hook sidecar — no old content replayed', async () => {
    const resumeId = '11223344-aabb-ccdd-eeff-001122334455';
    // Create transcript stub so resume existsSync check passes
    await writeFile(join(tmpDir, `${resumeId}.jsonl`), '', 'utf8');

    // Fresh sidecar with only new-turn content (B-hook: each invoke creates fresh sidecar)
    const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('NEW_RESUME_REPLY', resumeId)]);

    const mock = new MockPtyDriver();
    mock.injectResult = { transcriptPath: join(tmpDir, `${resumeId}.jsonl`), sessionId: resumeId, initialLines: 0 };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      transcriptDirOverride: tmpDir,
      hookSidecarPathOverride: sidecarPath,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    const msgs = await collect(carrier.invoke('continue', { sessionId: resumeId }));

    // Only new content from this turn's Stop event
    const texts = msgs.filter((m) => m.type === 'text');
    assert.equal(texts.length, 1, 'exactly one text message');
    assert.ok(texts[0].content.includes('NEW_RESUME_REPLY'), 'text is from this turn');

    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded');
    assert.equal(done.isFinal, true, 'done.isFinal = true');
  });
});

// ─── Step 10: pre-aborted signal → early exit before start() ────────────────
//
// Cloud P2: if caller passes a signal that is already aborted, addEventListener
// won't fire → carrier proceeds through 30s+ start() grace and injectPrompt(),
// wasting a Claude turn.
//
// Fix: check options.signal.aborted BEFORE calling driver.start().
//   Before fix (RED): mock.calls.start = 1 (carrier proceeds through start)
//   After fix (GREEN): mock.calls.start = 0, error + done yielded immediately

describe('ClaudeInteractivePtyCarrierService — Step 10: pre-aborted signal early exit', { timeout: 5_000 }, () => {
  it('pre-aborted signal → error+done yielded without calling start()', async () => {
    const mock = new MockPtyDriver();
    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      pollIntervalMs: 20,
      terminalTimeoutMs: 100,
    });

    const ac = new AbortController();
    ac.abort(); // already aborted BEFORE invoke()

    const msgs = await collect(carrier.invoke('test prompt', { signal: ac.signal }));

    // start() MUST NOT have been called (pre-abort check fires before resource commit)
    assert.equal(mock.calls.start, 0, 'start() must NOT be called for pre-aborted signal');

    // error yielded with pre-abort message
    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'error message yielded');
    assert.ok(
      error.error.includes('already aborted') || error.error.includes('pre-aborted'),
      `error message indicates pre-abort: "${error.error}"`,
    );

    // done yielded
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded');
    assert.equal(done.isFinal, true, 'done.isFinal = true');
  });
});

// ─── Step 11: malformed sessionId rejected (full UUID validation) ────────────
//
// Cloud P1: the prefix-only UUID regex /^[0-9a-f]{8}-[0-9a-f]{4}-/ allows tails
// with shell metacharacters (e.g. "11223344-aabb-'; rm -rf /") that flow into the
// tmux shell-command string and get interpreted by the shell.
//
// Fix: use full UUID regex /^[0-9a-f]{8}-[0-9a-f]{4}-...-[0-9a-f]{12}$/ so any
// non-UUID sessionId is silently ignored (carrier falls back to new-session mode).
//   Before fix (RED): mock.driverOpts.resumeSessionId set to malformed ID
//   After fix (GREEN): mock.driverOpts.resumeSessionId is undefined

describe(
  'ClaudeInteractivePtyCarrierService — Step 11: full UUID validation rejects malformed sessionId',
  { timeout: 5_000 },
  () => {
    it('prefix-only UUID with shell metacharacters → resumeSessionId not passed to driver', async () => {
      // This ID matches the OLD prefix regex but is not a valid UUID (shell injection attempt)
      const malformedId = "11223344-aabb-'; rm -rf /";

      let capturedDriverOpts;
      const carrier = new ClaudeInteractivePtyCarrierService({
        driverFactory: (opts) => {
          capturedDriverOpts = opts;
          return new MockPtyDriver();
        },
        pollIntervalMs: 20,
        terminalTimeoutMs: 100,
      });

      // Kick off invoke (fire-and-forget; we only care about driver opts)
      const iter = carrier.invoke('test prompt', { sessionId: malformedId });
      // Consume first message to trigger driverFactory call
      await iter.next().catch(() => void 0);
      // Drain remaining (prevent unhandled rejection)
      iter.return?.();

      // driver must have been created with resumeSessionId = undefined (rejected)
      assert.equal(
        capturedDriverOpts?.resumeSessionId,
        undefined,
        'malformed sessionId must NOT reach driver as resumeSessionId',
      );
    });

    it('valid full UUID + matching .jsonl present → resumeSessionId passed through correctly', async () => {
      const validId = '11223344-aabb-ccdd-eeff-001122334455';

      // Create a tmpDir with the matching .jsonl file so the fail-safe check passes
      const td = await mkdtemp(join(tmpdir(), 'cat-cafe-step11-'));
      try {
        await writeFile(
          join(td, `${validId}.jsonl`),
          `${JSON.stringify({ type: 'system', subtype: 'init', sessionId: validId })}\n`,
        );

        let capturedDriverOpts;
        const carrier = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: td, // point to the dir containing the validId.jsonl
          driverFactory: (opts) => {
            capturedDriverOpts = opts;
            return new MockPtyDriver();
          },
          pollIntervalMs: 20,
          terminalTimeoutMs: 100,
        });

        const iter = carrier.invoke('test prompt', { sessionId: validId });
        await iter.next().catch(() => void 0);
        iter.return?.();

        assert.equal(
          capturedDriverOpts?.resumeSessionId,
          validId,
          'valid UUID with existing transcript must be passed to driver as resumeSessionId',
        );
      } finally {
        await rm(td, { recursive: true, force: true });
      }
    });
  },
);

// ─── Step 12: abort during start() → injectPrompt NOT called ─────────────────
//
// This tests the mid-start abort guard added after cloud P2 review (round 3).
// If the abort signal fires AFTER the pre-abort check (Step 10) but WHILE
// driver.start() is still awaiting, abortRequested becomes true but the code
// was previously proceeding to injectPrompt() anyway, spending a Claude turn.
//
//   Before fix (RED): mock.calls.injectPrompt = 1 (carrier proceeds past start)
//   After fix (GREEN): mock.calls.injectPrompt = 0, error + done yielded

describe('ClaudeInteractivePtyCarrierService — Step 12: mid-start abort guard', { timeout: 5_000 }, () => {
  it('abort fires during start() → injectPrompt NOT called, error+done yielded', async () => {
    const ac = new AbortController();
    const mock = new MockPtyDriver();

    // Override start() to fire the abort signal partway through,
    // simulating abort arriving during the 30 s tmux startup grace window.
    mock.start = async function midStartAbortSimulator() {
      mock.calls.start++;
      // Signal abort DURING start execution (as if user cancelled mid-launch)
      ac.abort();
      // Let the abort event listener run asynchronously (sets abortRequested = true)
      await new Promise((r) => setImmediate(r));
      // start() "completes" — tmux is up, but we were cancelled
    };

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    const msgs = await collect(carrier.invoke('test prompt', { signal: ac.signal }));

    assert.equal(mock.calls.start, 1, 'start() called exactly once');
    assert.equal(mock.calls.injectPrompt, 0, 'injectPrompt() must NOT be called when abort fires during start()');

    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'error message yielded after mid-start abort');
    assert.ok(
      typeof error.error === 'string' && error.error.length > 0,
      `error.error is non-empty string: "${error.error}"`,
    );

    const done = msgs.find((m) => m.type === 'done' && m.isFinal === true);
    assert.ok(done, 'done isFinal yielded after mid-start abort');

    // dispose() still called (finally block — zombie prevention)
    assert.equal(mock.calls.dispose, 1, 'dispose() called for cleanup despite mid-start abort');
  });
});

// ─── Step 4: driver.start() throws ──────────────────────────────────────────

describe('ClaudeInteractivePtyCarrierService — Step 4: start() throws', { timeout: 10_000 }, () => {
  it('start() throws → yields error+done; dispose() still called (no zombie)', async () => {
    const mock = new MockPtyDriver();
    mock.startError = new Error('tmux not available: command not found');

    const carrier = new ClaudeInteractivePtyCarrierService({
      driverFactory: () => mock,
      pollIntervalMs: 20,
      terminalTimeoutMs: 5_000,
    });

    const msgs = await collect(carrier.invoke('should fail fast'));

    // error yielded with start failure message
    const error = msgs.find((m) => m.type === 'error');
    assert.ok(error, 'error yielded when start() throws');
    assert.ok(
      error.error.includes('PtyDriver start failed'),
      `error message contains "PtyDriver start failed": "${error.error}"`,
    );
    assert.ok(error.error.includes('tmux not available'), `error message includes original error: "${error.error}"`);

    // done yielded
    const done = msgs.find((m) => m.type === 'done');
    assert.ok(done, 'done yielded after start error');
    assert.equal(done.isFinal, true, 'done.isFinal = true');

    // dispose() still called (finally block — zombie prevention)
    assert.equal(mock.calls.dispose, 1, 'dispose() called even when start() throws (no zombie)');

    // injectPrompt must NOT have been called (never got to inject)
    assert.equal(mock.calls.injectPrompt, 0, 'injectPrompt() not called when start() throws');
  });
});

// ─── Step 13: image contentBlocks → --add-dir + path hints ──────────────────
//
// P2-image-inputs fix (cloud review round 5): when a turn includes uploaded images,
// the carrier must:
//   (a) add --add-dir <uploadDir> to extraArgs so Claude CLI can read the directory
//   (b) append [Local image path: /abs/path.png] hint to the injected prompt
//
// Mirrors ClaudeAgentService: extractImagePaths + collectImageAccessDirectories +
// appendLocalImagePathHints (image-paths.ts + image-cli-bridge.ts).
//
//   Before fix (RED): --add-dir absent; prompt = bare 'test prompt' (no path hint)
//   After fix (GREEN): --add-dir in extraArgs; prompt contains '[Local image path:'

describe(
  'ClaudeInteractivePtyCarrierService — Step 13: image contentBlocks → --add-dir + path hints',
  { timeout: 10_000 },
  () => {
    let tmpDir;
    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s13-'));
    });
    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('--add-dir <uploadDir> present in extraArgs passed to driverFactory', async () => {
      // Use pre-aborted signal to stop before start() — driverFactory is called first,
      // so we can capture extraArgs without running any tmux session.
      const ac = new AbortController();
      ac.abort();

      let capturedExtraArgs = null;
      const carrier = new ClaudeInteractivePtyCarrierService({
        driverFactory: (opts) => {
          capturedExtraArgs = opts.extraArgs;
          return new MockPtyDriver();
        },
        pollIntervalMs: 20,
        terminalTimeoutMs: 1_000,
      });

      await collect(
        carrier.invoke('test prompt', {
          signal: ac.signal,
          contentBlocks: [{ type: 'image', url: '/uploads/test-image.png' }],
          uploadDir: '/tmp/fake-uploads',
        }),
      );

      assert.ok(capturedExtraArgs !== null, 'driverFactory was called and captured extraArgs');
      const addDirIdx = capturedExtraArgs.indexOf('--add-dir');
      assert.ok(addDirIdx !== -1, '--add-dir should be in extraArgs when contentBlocks contains an image');
      assert.equal(
        capturedExtraArgs[addDirIdx + 1],
        '/tmp/fake-uploads',
        'the directory after --add-dir must be the resolved upload directory',
      );
    });

    it('[Local image path: ...] hint appended to prompt passed to injectPrompt', async () => {
      const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('image response')]);

      let capturedPrompt = null;
      const mockDriver = {
        start: async () => {},
        injectPrompt: async (text, _transcriptDir) => {
          capturedPrompt = text;
          return { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID, initialLines: 0 };
        },
        dispose: async () => {},
        cancel: async () => {},
      };

      const carrier = new ClaudeInteractivePtyCarrierService({
        driverFactory: () => mockDriver,
        transcriptDirOverride: tmpDir,
        hookSidecarPathOverride: sidecarPath,
        pollIntervalMs: 20,
        terminalTimeoutMs: 5_000,
      });

      await collect(
        carrier.invoke('hello world', {
          contentBlocks: [{ type: 'image', url: '/uploads/sample.png' }],
          uploadDir: '/tmp/fake-uploads',
        }),
      );

      assert.ok(capturedPrompt !== null, 'injectPrompt was called');
      assert.ok(
        capturedPrompt.includes('[Local image path:'),
        `prompt must contain '[Local image path:' hint; got: "${capturedPrompt.slice(0, 200)}"`,
      );
      assert.ok(
        capturedPrompt.includes('/tmp/fake-uploads/sample.png'),
        `hint must include resolved absolute path '/tmp/fake-uploads/sample.png'; got: "${capturedPrompt.slice(0, 200)}"`,
      );
      // Original prompt text must still be present (hint is appended, not replacing)
      assert.ok(
        capturedPrompt.startsWith('hello world'),
        `original prompt text must be preserved at start; got: "${capturedPrompt.slice(0, 100)}"`,
      );
    });
  },
);

// ─── Step 15: concurrent invoke() on same transcriptDir — queue serialization ───
//
// F230 R10 / R11 root-cause context:
//   `--session-id <uuid>` does NOT route conversation events to the given UUID.
//   The flag writes ONLY the ai-title metadata file to that UUID; real conversation
//   events go to a DIFFERENT file with Claude's own generated UUID.
//   PtyDriver therefore uses watchForTranscriptFile (heuristic, not deterministic).
//
// With watchForTranscriptFile, two concurrent watchers on the same transcriptDir would
// race and each could claim the other's .jsonl — silent wrong session IDs and lost
// responses. acquireTranscriptDirWatch serializes access via an async queue: the SECOND
// caller AWAITS the first's release, then proceeds independently with a fresh watch.
// Both invocations complete successfully with their own session IDs.
//
// Cloud P1 fix: changed from fail-fast Set (second got error+done) to async queue
// (second waits, then runs — both callers complete).
//
// This test covers the production path: the mock's injectPrompt calls
// acquireTranscriptDirWatch just like real PtyDriver does.

describe(
  'ClaudeInteractivePtyCarrierService — Step 15: concurrent invoke() same-dir — queue serialization',
  { timeout: 10_000 },
  () => {
    let tmpDir;
    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'f230-r10-'));
    });
    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('two concurrent invoke() on same dir both complete — second waits, then gets its own session', async () => {
      // Shared sidecar for both invocations — each invoke reads from offset 0
      const sidecarPath = join(tmpDir, 'hook-sidecar-concurrent.jsonl');
      // Pre-write two Stop events so both invocations can terminate
      writeFileSync(
        sidecarPath,
        stopEventLine('done-1', '00000000-0000-0000-0000-000000000001') +
          '\n' +
          stopEventLine('done-2', '00000000-0000-0000-0000-000000000002') +
          '\n',
        'utf8',
      );

      let counter = 0;
      const service = new ClaudeInteractivePtyCarrierService({
        transcriptDirOverride: tmpDir,
        hookSidecarPathOverride: sidecarPath,
        driverFactory: () => ({
          start: () => Promise.resolve(),
          injectPrompt: async (_text, transcriptDir) => {
            const releaseDir = await acquireTranscriptDirWatch(transcriptDir);
            try {
              const idx = ++counter;
              const sessionId = `00000000-0000-0000-0000-${String(idx).padStart(12, '0')}`;
              const path = join(transcriptDir, `${sessionId}.jsonl`);
              await writeFile(path, '', 'utf8');
              return { transcriptPath: path, sessionId };
            } finally {
              releaseDir();
            }
          },
          cancel: () => Promise.resolve(),
          dispose: () => Promise.resolve(),
        }),
        pollIntervalMs: 10,
        terminalTimeoutMs: 500,
      });

      const drain = async (iter) => {
        const msgs = [];
        for await (const m of iter) msgs.push(m);
        return msgs;
      };

      // Both invocations run concurrently. The queue serializes same-dir access:
      // one runs first, releases, then the other runs independently.
      const [msgsA, msgsB] = await Promise.all([
        drain(service.invoke('Hello from A')),
        drain(service.invoke('Hello from B')),
      ]);

      // Both must complete without error
      const errA = msgsA.filter((m) => m.type === 'error');
      const errB = msgsB.filter((m) => m.type === 'error');
      assert.ok(errA.length === 0, `invoke A must not error; got: ${JSON.stringify(errA)}`);
      assert.ok(errB.length === 0, `invoke B must not error; got: ${JSON.stringify(errB)}`);

      // Both must reach done
      assert.ok(
        msgsA.some((m) => m.type === 'done'),
        'invoke A must produce a done event',
      );
      assert.ok(
        msgsB.some((m) => m.type === 'done'),
        'invoke B must produce a done event',
      );

      // Each must use a unique session_init sessionId (no cross-claim)
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const initA = msgsA.find((m) => m.type === 'session_init');
      const initB = msgsB.find((m) => m.type === 'session_init');
      assert.ok(initA && uuidRe.test(initA.sessionId), `A must have a UUID sessionId; got: ${initA?.sessionId}`);
      assert.ok(initB && uuidRe.test(initB.sessionId), `B must have a UUID sessionId; got: ${initB?.sessionId}`);
      assert.notStrictEqual(
        initA.sessionId,
        initB.sessionId,
        'A and B must use different session IDs (no cross-claim)',
      );
    });
  },
);

// ─── Step 14: ptyTranscriptDir respects accountEnv.HOME ──────────────────────
//
// If an account supplies HOME in accountEnv (a valid accountEnv key), Claude
// runs in the child env with that HOME, so it writes transcripts to
// <childHOME>/.claude/projects/<slug>. The transcript dir must be derived
// from the effective child HOME, not the API process homedir().
//
// F230 R8 P2: previous code always called ptyTranscriptDir(cwd) using
// process homedir() — invocations with a custom HOME silently timed out in
// injectPrompt (watching the wrong directory).
// Fix: pass effectiveHome = options.accountEnv.HOME to ptyTranscriptDir.
describe('ptyTranscriptDir: respects custom effectiveHome (F230 R8 P2)', () => {
  it('uses provided effectiveHome instead of process homedir()', () => {
    const result = ptyTranscriptDir('/home/user/my-project', '/custom/home');
    assert.equal(
      result,
      '/custom/home/.claude/projects/-home-user-my-project',
      'must use effectiveHome, not process homedir()',
    );
  });

  it('falls back to process homedir() when effectiveHome is undefined', () => {
    const result = ptyTranscriptDir('/home/user/my-project');
    assert.ok(result.startsWith(homedir()), `must start with process homedir() ${homedir()}, got: ${result}`);
  });
});

// ─── Step 16: stale cross-carrier sessionId → new session fallback ────────────
//
// Production P1 (F230 alpha 2026-06-11): when options.sessionId is a bg/-p era
// cliSessionId that doesn't exist in the PTY carrier's transcriptDir, the
// carrier must NOT pass it as resumeSessionId to PtyDriver — doing so causes
// PtyDriver to dead-wait for `<stale-id>.jsonl` which never appears (5s timeout).
//
// Fail-safe: if transcript file is absent → treat as fresh session (fallthrough
// to watchForTranscriptFile path) rather than hard-erroring.
describe(
  'ClaudeInteractivePtyCarrierService — Step 16: stale sessionId falls back to new session',
  { timeout: 10_000 },
  () => {
    let tmpDir;
    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-step16-'));
    });
    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('ignores sessionId with no matching .jsonl in transcriptDir — starts fresh', async () => {
      const staleId = 'a1ceef46-0000-0000-0000-000000000000';
      let capturedResumeSessionId = 'NOT_SET';
      const newId = '99999999-0000-0000-0000-000000000000';

      const sidecarPath = join(tmpDir, 'hook-sidecar-stale.jsonl');
      writeFileSync(sidecarPath, stopEventLine('fresh', newId) + '\n', 'utf8');

      const service = new ClaudeInteractivePtyCarrierService({
        transcriptDirOverride: tmpDir, // empty dir — staleId.jsonl does NOT exist
        hookSidecarPathOverride: sidecarPath,
        driverFactory: (opts) => {
          capturedResumeSessionId = opts.resumeSessionId;
          return {
            start: () => Promise.resolve(),
            injectPrompt: async (_text, transcriptDir) => {
              const path = join(transcriptDir, `${newId}.jsonl`);
              await writeFile(path, '');
              return { transcriptPath: path, sessionId: newId };
            },
            cancel: () => Promise.resolve(),
            dispose: () => Promise.resolve(),
          };
        },
        pollIntervalMs: 10,
        terminalTimeoutMs: 500,
      });

      const msgs = [];
      for await (const m of service.invoke('Hello', { sessionId: staleId })) {
        msgs.push(m);
      }

      // resumeSessionId must be undefined — file absent → fail-safe triggered
      assert.equal(
        capturedResumeSessionId,
        undefined,
        'resumeSessionId must be undefined when transcript file absent (fail-safe: cross-carrier stale ID)',
      );
      // Invocation must complete normally
      assert.ok(
        msgs.some((m) => m.type === 'done'),
        'must complete with done event',
      );
      // session_init must NOT carry the stale ID
      const init = msgs.find((m) => m.type === 'session_init');
      assert.ok(init, 'must emit session_init');
      assert.notEqual(init.sessionId, staleId, 'session_init must use new session ID, not stale cross-carrier ID');
    });
  },
);

// ─── Step 17: proxy env vars forwarded to driverFactory env (P2 regression) ──
describe(
  'ClaudeInteractivePtyCarrierService — Step 17: proxy env vars forwarded to PtyDriver',
  { timeout: 10_000 },
  () => {
    let tmpDir;
    before(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'cat-cafe-step17-'));
    });
    after(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('forwards HTTP_PROXY + http_proxy from process.env into driverFactory opts.env', async () => {
      const savedHttp = process.env.HTTP_PROXY;
      const savedHttpLower = process.env.http_proxy;
      process.env.HTTP_PROXY = 'http://127.0.0.1:7897';
      process.env.http_proxy = 'http://127.0.0.1:7897';
      const newId = 'aaaabbbb-0000-0000-0000-000000000000';
      let capturedEnv = null;

      const sidecarPath = join(tmpDir, 'hook-sidecar-proxy.jsonl');
      writeFileSync(sidecarPath, stopEventLine('ok', newId) + '\n', 'utf8');

      try {
        const service = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpDir,
          hookSidecarPathOverride: sidecarPath,
          driverFactory: (opts) => {
            capturedEnv = { ...opts.env };
            return {
              start: () => Promise.resolve(),
              injectPrompt: async (_text, transcriptDir) => {
                const path = join(transcriptDir, `${newId}.jsonl`);
                await writeFile(path, '');
                return { transcriptPath: path, sessionId: newId };
              },
              cancel: () => Promise.resolve(),
              dispose: () => Promise.resolve(),
            };
          },
          pollIntervalMs: 10,
          terminalTimeoutMs: 500,
        });

        const msgs = [];
        for await (const m of service.invoke('Hello')) {
          msgs.push(m);
        }

        assert.ok(capturedEnv, 'driverFactory must have been called');
        assert.equal(
          capturedEnv.HTTP_PROXY,
          'http://127.0.0.1:7897',
          'HTTP_PROXY must be forwarded to PtyDriver env (defeats tmux server env snapshot)',
        );
        assert.equal(capturedEnv.http_proxy, 'http://127.0.0.1:7897', 'http_proxy (lowercase) must also be forwarded');
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          'must complete with done event',
        );
      } finally {
        if (savedHttp === undefined) delete process.env.HTTP_PROXY;
        else process.env.HTTP_PROXY = savedHttp;
        if (savedHttpLower === undefined) delete process.env.http_proxy;
        else process.env.http_proxy = savedHttpLower;
      }
    });

    it('does NOT override proxy vars already set via accountEnv', async () => {
      const savedHttps = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = 'http://process-proxy:7897';
      const newId = 'ccccdddd-0000-0000-0000-000000000000';
      let capturedEnv = null;

      const sidecarPath = join(tmpDir, 'hook-sidecar-proxy2.jsonl');
      writeFileSync(sidecarPath, stopEventLine('ok', newId) + '\n', 'utf8');

      try {
        const service = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpDir,
          hookSidecarPathOverride: sidecarPath,
          driverFactory: (opts) => {
            capturedEnv = { ...opts.env };
            return {
              start: () => Promise.resolve(),
              injectPrompt: async (_text, transcriptDir) => {
                const path = join(transcriptDir, `${newId}.jsonl`);
                await writeFile(path, '');
                return { transcriptPath: path, sessionId: newId };
              },
              cancel: () => Promise.resolve(),
              dispose: () => Promise.resolve(),
            };
          },
          pollIntervalMs: 10,
          terminalTimeoutMs: 500,
        });

        const msgs = [];
        for await (const m of service.invoke('Hello', {
          accountEnv: { HTTPS_PROXY: 'http://account-proxy:8888' },
        })) {
          msgs.push(m);
        }

        assert.ok(capturedEnv, 'driverFactory must have been called');
        assert.equal(
          capturedEnv.HTTPS_PROXY,
          'http://account-proxy:8888',
          'accountEnv HTTPS_PROXY must win over process.env (caller intent trumps process default)',
        );
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          'must complete with done event',
        );
      } finally {
        if (savedHttps === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = savedHttps;
      }
    });
  },
);

// ─── Step 18: B-hook review fixes (R1 P1-2 + P2) ────────────────────────────

describe('ClaudeInteractivePtyCarrierService — Step 18: pre-abort hook cleanup (R1 P1-2)', { timeout: 10_000 }, () => {
  it('pre-aborted signal cleans up hook infra and sidecar dir', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s18-'));
    try {
      const controller = new AbortController();
      controller.abort(); // pre-abort

      const carrier = new ClaudeInteractivePtyCarrierService({
        transcriptDirOverride: tmpDir,
        // No hookSidecarPathOverride — exercise real setupHookInfrastructure path
        cwd: tmpDir,
        driverFactory: () => new MockPtyDriver(),
        pollIntervalMs: 20,
        terminalTimeoutMs: 500,
      });

      const msgs = await collect(carrier.invoke('test', { signal: controller.signal }));

      // Must yield error + done
      assert.ok(
        msgs.some((m) => m.type === 'error'),
        'error yielded on pre-abort',
      );
      assert.ok(
        msgs.some((m) => m.type === 'done'),
        'done yielded on pre-abort',
      );

      // Hook infra artifacts must be cleaned from cwd
      const { existsSync } = await import('node:fs');
      const settingsPath = join(tmpDir, '.claude', 'settings.json');
      const scriptPath = join(tmpDir, '.claude', 'hook-capture.sh');
      assert.ok(!existsSync(settingsPath), '.claude/settings.json must be cleaned on pre-abort');
      assert.ok(!existsSync(scriptPath), '.claude/hook-capture.sh must be cleaned on pre-abort');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe(
  'ClaudeInteractivePtyCarrierService — Step 18: sidecar dir cleanup after normal invoke (R1 P2)',
  { timeout: 15_000 },
  () => {
    it('sidecar temp dir is removed after normal completion', async () => {
      const tmpCwd = await mkdtemp(join(tmpdir(), 'f230-carrier-s18p2-'));
      let capturedSidecarPath;

      try {
        const carrier = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpCwd,
          cwd: tmpCwd,
          // No hookSidecarPathOverride — exercise real setupHookInfrastructure + sidecar dir lifecycle
          driverFactory: (opts) => {
            // Capture sidecar path injected via env delta by carrier
            capturedSidecarPath = opts.env?.CAT_CAFE_HOOK_SIDECAR;
            const d = new MockPtyDriver();
            d.injectResult = { transcriptPath: '', sessionId: '' };
            // Override injectPrompt to write a Stop event to sidecar so carrier terminates
            d.injectPrompt = async (_text, _dir) => {
              d.calls.injectPrompt++;
              if (capturedSidecarPath) {
                writeFileSync(capturedSidecarPath, stopEventLine('s18p2 done') + '\n', 'utf8');
              }
              return d.injectResult;
            };
            return d;
          },
          pollIntervalMs: 20,
          terminalTimeoutMs: 2_000,
        });

        const msgs = await collect(carrier.invoke('test-s18p2', {}));

        // Must complete normally with done message
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          'done yielded after normal invoke',
        );

        // Sidecar path must have been set (proves we exercised the non-override path)
        assert.ok(capturedSidecarPath, 'sidecar path was set via env delta (CAT_CAFE_HOOK_SIDECAR)');

        // P2 assertion: sidecar temp dir must be cleaned up by finally block
        const { existsSync } = await import('node:fs');
        const sidecarDir = dirname(capturedSidecarPath);
        assert.ok(!existsSync(sidecarDir), `sidecar temp dir must be removed after normal invoke: ${sidecarDir}`);

        // Also verify hook infra was cleaned from cwd
        const settingsPath = join(tmpCwd, '.claude', 'settings.json');
        assert.ok(!existsSync(settingsPath), '.claude/settings.json must be cleaned after normal invoke');
      } finally {
        await rm(tmpCwd, { recursive: true, force: true });
      }
    });
  },
);

// ─── Step 19: B-hook review R2 fix (P1-3: hookSessionId → session_init) ──────

describe(
  'ClaudeInteractivePtyCarrierService — Step 19: hookSessionId propagates to session_init (R2 P1-3)',
  { timeout: 15_000 },
  () => {
    it('session_init.sessionId comes from hook event, not empty driver result', async () => {
      const tmpCwd = await mkdtemp(join(tmpdir(), 'f230-carrier-s19-'));
      const HOOK_SESSION_UUID = 'a1b2c3d4-5678-90ab-cdef-111111111111';

      try {
        const carrier = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpCwd,
          cwd: tmpCwd,
          // No hookSidecarPathOverride — exercises real setupHookInfrastructure
          driverFactory: (opts) => {
            const sidecarPath = opts.env?.CAT_CAFE_HOOK_SIDECAR;
            const d = new MockPtyDriver();
            // skipTranscriptAck → driver returns empty sessionId
            d.injectResult = { transcriptPath: '', sessionId: '' };
            d.injectPrompt = async (_text, _dir) => {
              d.calls.injectPrompt++;
              if (sidecarPath) {
                // Write Stop event with real session_id to sidecar
                writeFileSync(sidecarPath, `${stopEventLine('s19 hello', HOOK_SESSION_UUID)}\n`, 'utf8');
              }
              return d.injectResult;
            };
            return d;
          },
          pollIntervalMs: 20,
          terminalTimeoutMs: 2_000,
        });

        const msgs = await collect(carrier.invoke('test-s19', {}));

        // session_init must carry the hook-extracted sessionId, not empty string
        const sessionInit = msgs.find((m) => m.type === 'session_init');
        assert.ok(sessionInit, 'session_init yielded');
        assert.equal(
          sessionInit.sessionId,
          HOOK_SESSION_UUID,
          'session_init.sessionId must come from hook event session_id, not empty driver result',
        );

        // done must also be present
        assert.ok(
          msgs.some((m) => m.type === 'done'),
          'done yielded',
        );
      } finally {
        await rm(tmpCwd, { recursive: true, force: true });
      }
    });
  },
);

// ─── Step 20: F230 follow-up ① — entrypoint in done.metadata (AC-B1) ─────────

describe(
  'ClaudeInteractivePtyCarrierService — Step 20: hookEntrypoint surfaces in done.metadata (F230 follow-up ①)',
  { timeout: 15_000 },
  () => {
    it('done.metadata.entrypoint extracted from enriched sidecar entries', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s20-'));
      const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('ep test', undefined, 'cli')]);
      try {
        const mock = new MockPtyDriver();
        mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };
        const carrier = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpDir,
          cwd: tmpDir,
          hookSidecarPathOverride: sidecarPath,
          driverFactory: () => mock,
          pollIntervalMs: 20,
          terminalTimeoutMs: 2_000,
        });
        const msgs = await collect(carrier.invoke('test-s20'));
        const done = msgs.find((m) => m.type === 'done');
        assert.ok(done, 'done yielded');
        assert.equal(done.metadata?.entrypoint, 'cli', 'done.metadata.entrypoint must be cli');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('done.metadata has no entrypoint when sidecar entries lack _cc_entrypoint', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'f230-carrier-s20b-'));
      const sidecarPath = await writeSidecar(tmpDir, [stopEventLine('no ep test')]);
      try {
        const mock = new MockPtyDriver();
        mock.injectResult = { transcriptPath: join(tmpDir, 'stub.jsonl'), sessionId: TEST_SESSION_ID };
        const carrier = new ClaudeInteractivePtyCarrierService({
          transcriptDirOverride: tmpDir,
          cwd: tmpDir,
          hookSidecarPathOverride: sidecarPath,
          driverFactory: () => mock,
          pollIntervalMs: 20,
          terminalTimeoutMs: 2_000,
        });
        const msgs = await collect(carrier.invoke('test-s20b'));
        const done = msgs.find((m) => m.type === 'done');
        assert.ok(done, 'done yielded');
        assert.equal(done.metadata?.entrypoint, undefined, 'no entrypoint when not in sidecar');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  },
);
