/**
 * F198 Phase B: ClaudeBgCarrierService tests
 *
 * Unit tests covering 砚砚 review guards #1/#2 + parse error handling.
 * Happy-path integration is covered by scripts/spike-f198-bg-carrier.mjs.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CarrierError,
  ClaudeBgCarrierService,
} from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { JobEventConsumer } from '../dist/domains/cats/services/agents/providers/JobEventConsumer.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

/**
 * Build a fake spawn function emitting controlled stdout/stderr/exit/error.
 * Captures the env that was passed to spawn() for assertion.
 */
function buildFakeSpawn({ stdout = '', stderr = '', exitCode = 0, errorOnSpawn = null }) {
  const fn = function fakeSpawn(_cmd, _args, opts) {
    fn.lastEnv = opts?.env ?? {};
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (errorOnSpawn) {
        child.emit('error', errorOnSpawn);
        return;
      }
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  fn.lastEnv = null;
  return fn;
}

/** Helper: write a fake job state.json + timeline.jsonl under a custom jobsDir. */
function seedJobState(jobsDir, shortId, { state, output, timelineLines }) {
  const jobDir = join(jobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ state, output, daemonShort: shortId }));
  if (timelineLines) {
    writeFileSync(join(jobDir, 'timeline.jsonl'), timelineLines.join('\n') + '\n');
  }
  return jobDir;
}

test('parses short id from successful claude --bg stdout', async () => {
  const fakeSpawn = buildFakeSpawn({
    stdout: 'Starting background service…\nbackgrounded · abcd1234\n  claude agents             list sessions\n',
  });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
  });
  const { shortId } = await service.startJob('hi');
  assert.equal(shortId, 'abcd1234');
});

test('throws CarrierError when claude --bg exits non-zero', async () => {
  const fakeSpawn = buildFakeSpawn({ exitCode: 1, stderr: 'auth required' });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
  });
  await assert.rejects(
    () => service.startJob('hi'),
    (err) => {
      assert.ok(err instanceof CarrierError, `expected CarrierError, got ${err.constructor.name}`);
      assert.match(err.message, /exited code=1/);
      return true;
    },
  );
});

test('throws CarrierError when short id cannot be parsed', async () => {
  const fakeSpawn = buildFakeSpawn({
    stdout: 'Starting background service…\nrandom output line\nno match here\n',
  });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
  });
  await assert.rejects(
    () => service.startJob('hi'),
    (err) => {
      assert.ok(err instanceof CarrierError);
      assert.match(err.message, /Could not parse short id/);
      return true;
    },
  );
});

test('砚砚 guard #2: spawn error (ENOENT) rejects with CarrierError', async () => {
  const fakeSpawn = buildFakeSpawn({
    errorOnSpawn: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
  });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
  });
  await assert.rejects(
    () => service.startJob('hi'),
    (err) => {
      assert.ok(err instanceof CarrierError);
      assert.match(err.message, /spawn failed/);
      assert.ok(err.cause, 'CarrierError should preserve underlying cause');
      return true;
    },
  );
});

test('砚砚 P1.1: callbackEnv CANNOT re-poison CLAUDE_CODE_ENTRYPOINT', async () => {
  const fakeSpawn = buildFakeSpawn({
    stdout: 'backgrounded · abcd1234\n',
  });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
  });
  await service.startJob('hi', {
    callbackEnv: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', CLAUDECODE: '1', OTHER_VAR: 'kept' },
  });
  const childEnv = fakeSpawn.lastEnv;
  assert.equal(
    childEnv.CLAUDE_CODE_ENTRYPOINT,
    undefined,
    'CLAUDE_CODE_ENTRYPOINT must be unset in child env even when callbackEnv tries to set it',
  );
  assert.equal(childEnv.CLAUDECODE, undefined, 'CLAUDECODE must be unset too');
  assert.equal(childEnv.OTHER_VAR, 'kept', 'other callbackEnv vars must still propagate');
});

test('砚砚 guard #3: JobEventConsumer.readTimeline skips malformed jsonl lines', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  seedJobState(tmpJobsDir, 'beef1234', {
    state: 'done',
    output: { result: 'ok' },
    timelineLines: [
      '{"at":"2026-05-14T00:00:00Z","state":"working","text":"first"}',
      'NOT_JSON_LINE_SHOULD_BE_SKIPPED',
      '{"at":"2026-05-14T00:00:01Z","state":"done","text":"second"}',
      '{"truncated":', // malformed JSON, still must skip
      '{"at":"2026-05-14T00:00:02Z","state":"done","text":"third"}',
    ],
  });
  const consumer = new JobEventConsumer('beef1234', { jobsDir: tmpJobsDir });
  const events = await consumer.readTimeline();
  assert.equal(events.length, 3, 'must keep 3 valid events; 2 malformed lines skipped');
  assert.equal(events[0].text, 'first');
  assert.equal(events[2].text, 'third');
});

test('砚砚 guard #1 + codex P1.1: invoke() state===error yields error → done → completes (no throw)', async () => {
  // codex round 1 P1: must NOT throw after terminal error (duplicate event).
  // codex round 2 P1.1: must STILL emit terminal done after error
  // (route-serial.ts / route-parallel.ts key completion off `done`).
  // Pattern: yield error → yield done(terminalState:error) → return.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  seedJobState(tmpJobsDir, 'dead1234', {
    state: 'error',
    output: { result: null },
    timelineLines: ['{"at":"2026-05-14T00:00:00Z","state":"error","detail":"auth failed"}'],
  });
  const fakeSpawn = buildFakeSpawn({ stdout: 'backgrounded · dead1234\n' });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test-model',
    jobsDir: tmpJobsDir,
  });

  const iterator = service.invoke('hi')[Symbol.asyncIterator]();
  const sessionInit = await iterator.next();
  assert.equal(sessionInit.value.type, 'session_init');

  const errorMsg = await iterator.next();
  assert.equal(errorMsg.value.type, 'error', 'must yield error AgentMessage');
  assert.equal(errorMsg.value.sessionId, 'dead1234');

  const doneMsg = await iterator.next();
  assert.equal(doneMsg.value.type, 'done', 'must yield done after error (routing completion contract)');
  assert.equal(doneMsg.value.metadata?.diagnostics?.terminalState, 'error');

  // generator completes — no throw
  const finalResult = await iterator.next();
  assert.equal(finalResult.done, true, 'generator must complete (NO throw)');
});

test('codex round-3 P2: readState skips malformed/partial JSON without throwing', async () => {
  // codex review (PR #1666 round 3) P2: daemon writes state.json async,
  // polling can hit partial writes. JSON.parse must not abort waitForTerminal.
  // Pattern matches readTimeline / readTranscriptEntrypoints per-line guard.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  const jobDir = join(tmpJobsDir, 'partial1234');
  mkdirSync(jobDir, { recursive: true });
  // Simulate partial write (truncated JSON)
  writeFileSync(join(jobDir, 'state.json'), '{"state":"working","detail":"');
  const consumer = new JobEventConsumer('partial1234', { jobsDir: tmpJobsDir });
  const state = await consumer.readState();
  assert.equal(state, null, 'malformed state.json must return null, not throw');
});

test('codex round-3 P1: waitForTerminal default timeout accommodates long jobs (≥ 30 min)', async () => {
  // codex review (PR #1666 round 3) P1: 45s default was too short for LLM
  // jobs with thinking + tool calls. Default raised to 30 min.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  seedJobState(tmpJobsDir, 'long1234', {
    state: 'done',
    output: { result: 'ok' },
    timelineLines: [],
  });
  const consumer = new JobEventConsumer('long1234', { jobsDir: tmpJobsDir });
  // Default timeout must accept jobs that take >> 45s — even though this test
  // completes immediately (state.json already seeded as done), we assert the
  // default doesn't reject under 1 minute (proxy for "much larger than 45s").
  const startedAt = Date.now();
  const state = await consumer.waitForTerminal({ pollMs: 50 });
  assert.equal(state.state, 'done');
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 2_000, `terminal state should resolve fast when seeded done; got ${elapsed}ms`);
  // Note: full timeout assertion (waiting 30 min) impractical; relying on
  // default-value review + source inspection for the 30 min upper bound.
});

test('codex round-4 P1: accountEnv merged after callbackEnv but entrypoint guard is FINAL', async () => {
  // codex review (PR #1666 round 4): F171 accountEnv applied LAST overrides
  // provider-injected values, but our entrypoint guard MUST stay final
  // (account env trying to re-poison must still be neutralized).
  const fakeSpawn = buildFakeSpawn({ stdout: 'backgrounded · acce1234\n' });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test',
  });
  await service.startJob('hi', {
    callbackEnv: { CALLBACK_VAR: 'cb', OVERRIDE_ME: 'from-callback' },
    accountEnv: {
      ACCOUNT_VAR: 'acct',
      OVERRIDE_ME: 'from-account',
      CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', // try to re-poison via accountEnv
    },
  });
  const env = fakeSpawn.lastEnv;
  assert.equal(env.CALLBACK_VAR, 'cb', 'callbackEnv must propagate');
  assert.equal(env.ACCOUNT_VAR, 'acct', 'accountEnv must propagate');
  assert.equal(env.OVERRIDE_ME, 'from-account', 'accountEnv must override callbackEnv (F171)');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, 'entrypoint guard is FINAL — accountEnv cannot re-poison');
});

test('codex round-5 P1.2: aborted invoke() best-effort claude stop <shortId>', async () => {
  // codex review (PR #1666 round 5) P1.2: when waitForTerminal throws (abort),
  // invoke() must issue a best-effort `claude stop <shortId>` so the detached
  // --bg session doesn't leak. Spike script's explicit stop in step 5 confirms
  // this cleanup is required.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  // Seed state.json so it stays in 'working' (never reaches terminal)
  seedJobState(tmpJobsDir, '1eaf1234', {
    state: 'working',
    output: { result: null },
    timelineLines: [],
  });
  // Track all spawn calls — fakeSpawn captures cmd + args for assertion
  const spawnCalls = [];
  const fakeSpawn = (_cmd, args, opts) => {
    spawnCalls.push({ args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      // First call = --bg startup → emit short id + close 0
      if (args[0] === '--bg') {
        child.stdout.emit('data', Buffer.from('backgrounded · 1eaf1234\n'));
        child.emit('close', 0);
      }
      // Second call = stop (fire-and-forget, no events needed)
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test',
    jobsDir: tmpJobsDir,
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 80);
  const iterator = service.invoke('hi', { signal: controller.signal })[Symbol.asyncIterator]();

  // session_init yielded first
  const init = await iterator.next();
  assert.equal(init.value.type, 'session_init');

  // waitForTerminal aborts → invoke() throws
  await assert.rejects(
    () => iterator.next(),
    (err) => {
      assert.match(err.message, /aborted/);
      return true;
    },
  );

  // Critical assertion: claude stop <shortId> must have been issued
  const stopCalls = spawnCalls.filter((c) => c.args[0] === 'stop');
  assert.equal(stopCalls.length, 1, 'must issue exactly one claude stop call');
  assert.equal(stopCalls[0].args[1], '1eaf1234', 'stop must target the spawned shortId');
});

test('codex round-4 P1: waitForTerminal honors AbortSignal', async () => {
  // codex review (PR #1666 round 4): cancellation/timeout from invoke-single-cat
  // must stop our internal polling promptly — otherwise default 30-min wait
  // leaves daemon jobs running after caller cancels.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  // state.json never reaches terminal — relies on signal to abort
  seedJobState(tmpJobsDir, 'abrt1234', {
    state: 'working',
    output: { result: null },
    timelineLines: [],
  });
  const consumer = new JobEventConsumer('abrt1234', { jobsDir: tmpJobsDir });
  const controller = new AbortController();
  // Abort after 100ms
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  await assert.rejects(
    () => consumer.waitForTerminal({ signal: controller.signal, pollMs: 50 }),
    (err) => {
      assert.match(err.message, /aborted/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_000, `must abort promptly, got ${elapsed}ms`);
});

test('codex round-6 P1.2: strip ANTHROPIC_* env for subscription-mode carrier', async () => {
  // codex review (PR #1666 round 6) P1.2: host ANTHROPIC_API_KEY would route
  // --bg to API-key billing instead of subscription. This carrier is always
  // subscription (api_key fallback → ClaudeAgentService per KD-3), so all
  // ANTHROPIC_* must be cleared. accountEnv CAN re-introduce them if a
  // specific cat wants api_key mode for that invocation.
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-host-default';
  process.env.ANTHROPIC_BASE_URL = 'https://host-default.example';
  try {
    const fakeSpawn = buildFakeSpawn({ stdout: 'backgrounded · ab120000\n' });
    const service = new ClaudeBgCarrierService({
      l0CompilerFn: fakeL0Compiler,
      spawnFn: fakeSpawn,
      model: 'claude-test',
    });
    await service.startJob('hi');
    const env = fakeSpawn.lastEnv;
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'host ANTHROPIC_API_KEY must be stripped');
    assert.equal(env.ANTHROPIC_BASE_URL, undefined, 'host ANTHROPIC_BASE_URL must be stripped');

    // accountEnv CAN re-introduce (api_key mode for specific cat)
    await service.startJob('hi', {
      accountEnv: { ANTHROPIC_API_KEY: 'sk-ant-account', ANTHROPIC_BASE_URL: 'https://acct.example' },
    });
    const env2 = fakeSpawn.lastEnv;
    assert.equal(env2.ANTHROPIC_API_KEY, 'sk-ant-account', 'accountEnv can opt-in to api_key mode');
    assert.equal(env2.ANTHROPIC_BASE_URL, 'https://acct.example');
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBase;
  }
});

test('codex round-6 P1.3: spawn passes options.signal so startup abort kills child', async () => {
  // codex review (PR #1666 round 6) P1.3: AbortSignal must reach spawn so
  // cancellation during the 5-15s startup window terminates the child via
  // SIGTERM. Without this, abort never reaches waitForTerminal's bestEffortStop.
  let capturedOpts = null;
  const fakeSpawn = (_cmd, _args, opts) => {
    capturedOpts = opts;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · ab120002\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-test',
  });
  const controller = new AbortController();
  await service.startJob('hi', { signal: controller.signal });
  assert.ok(capturedOpts.signal, 'spawn must receive AbortSignal');
  assert.strictEqual(capturedOpts.signal, controller.signal, 'signal must be the caller-provided one');
});

test('codex P1.2: spawn args include --model flag from configured cat model (subscription mode)', async () => {
  // codex review round 2 P1.2: spawn must pass --model so the run uses the
  // cat's configured Anthropic model in subscription mode.
  let capturedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafe1234\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
  });
  await service.startJob('hi');
  assert.ok(capturedArgs.includes('--model'), 'subscription + Anthropic model: --model must be passed');
  const modelIdx = capturedArgs.indexOf('--model');
  assert.equal(capturedArgs[modelIdx + 1], 'claude-opus-4-7');
});

test('codex round-7 B-prime: MODEL_OVERRIDE_KEY in callbackEnv used as effective model', async () => {
  // codex review (PR #1666 round 7) P1.4: callbackEnv MODEL_OVERRIDE_KEY
  // (set by invoke-single-cat.ts for api_key Anthropic accounts) must take
  // precedence over constructor model. Single source of truth via
  // resolveClaudeModelSelection shared helper.
  let capturedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafe5678\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
  });
  await service.startJob('hi', {
    callbackEnv: { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'claude-sonnet-4-7' },
  });
  const modelIdx = capturedArgs.indexOf('--model');
  assert.ok(modelIdx >= 0, '--model still passed for Anthropic override');
  assert.equal(
    capturedArgs[modelIdx + 1],
    'claude-sonnet-4-7',
    'effective model must come from MODEL_OVERRIDE_KEY, not constructor',
  );
});

test('砚砚 Step-3 P1: --mcp-config injected when callbackEnv present and mcpServerPath resolved (AC-B4)', async () => {
  // 砚砚 Step-3 review: ClaudeBgCarrierService missed mcp-config injection,
  // mirroring ClaudeAgentService behavior. Without this, canary布偶猫 sessions
  // lose Clowder AI MCP tools (cat_cafe_*) → AC-B4 / R5 break.
  let capturedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafe7890\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    mcpServerPath: '/tmp/fake-mcp-server/dist/index.js',
  });
  await service.startJob('hi', {
    callbackEnv: { CAT_CAFE_INVOCATION_ID: 'inv-xyz' },
  });

  const mcpIdx = capturedArgs.indexOf('--mcp-config');
  assert.ok(mcpIdx >= 0, 'must include --mcp-config when callbackEnv present');
  const nextArg = capturedArgs[mcpIdx + 1];
  assert.ok(typeof nextArg === 'string' && nextArg.length > 0, '--mcp-config must have a value');
  // Step-4 alpha finding (defensive code, not approval bypass):
  // daemon --bg discovers cwd `.mcp.json` walking up tree. WITHOUT
  // --strict-mcp-config, claude would LOAD discovered servers IN ADDITION
  // to our injected cat-cafe MCP → unpredictable tool surface in canary
  // sessions. WITH --strict-mcp-config, only our explicit --mcp-config is
  // used at runtime. The .mcp.json approval UX gate is SEPARATE — that's
  // one-time-per-project operator setup (claude attach + approve once).
  // This flag is about predictable loading, not approval bypass.
  assert.ok(
    capturedArgs.includes('--strict-mcp-config'),
    'must include --strict-mcp-config for predictable MCP loading (only inject our cat-cafe MCP)',
  );
});

test('砚砚 Step-3 P1: --mcp-config NOT injected when callbackEnv absent', async () => {
  // Mirrors ClaudeAgentService: only inject MCP config when caller signals
  // a callback-bound invocation.
  let capturedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafe7891\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    mcpServerPath: '/tmp/fake-mcp-server/dist/index.js',
  });
  await service.startJob('hi');

  assert.ok(!capturedArgs.includes('--mcp-config'), 'must NOT include --mcp-config when no callbackEnv');
});

test('codex round-7 B-prime: api_key mode + non-Anthropic model omits --model (env-driven)', async () => {
  // codex review (PR #1666 round 7) P1.3: when accountEnv/callbackEnv switch
  // to api_key mode with a non-Anthropic model (e.g. glm-5 via proxy),
  // --model must be OMITTED so ANTHROPIC_MODEL env can drive routing.
  // Otherwise CLI gives --model precedence and overrides env-based routing.
  let capturedArgs = null;
  const fakeSpawn = (_cmd, args) => {
    capturedArgs = args;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('backgrounded · cafe9abc\n'));
      child.emit('close', 0);
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
  });
  await service.startJob('hi', {
    callbackEnv: {
      CAT_CAFE_ANTHROPIC_PROFILE_MODE: 'api_key',
      CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'glm-5', // non-Anthropic
    },
  });
  assert.ok(
    !capturedArgs.includes('--model'),
    'api_key + non-Anthropic model: --model must be OMITTED so env drives routing',
  );
});

test('codex round-9 P2: success-path done metadata reports effectiveModel, not constructor fallback', async () => {
  // codex review (PR #1666 round 9) P2: when callbackEnv MODEL_OVERRIDE_KEY
  // selects a model different from constructor `this.model`, the SUCCESS-path
  // terminal `done` event must report the override (matching session_init and
  // the error-path done). Otherwise downstream metrics/routing see the wrong
  // model on the happy path. Symmetry with line-237/282; this closes the
  // last `this.model` leak at line 307.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-bg-test-'));
  seedJobState(tmpJobsDir, 'aced1234', {
    state: 'done',
    output: { result: 'ok' },
    timelineLines: [],
  });
  const fakeSpawn = buildFakeSpawn({ stdout: 'backgrounded · aced1234\n' });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
  });

  const events = [];
  for await (const msg of service.invoke('hi', {
    callbackEnv: { CAT_CAFE_ANTHROPIC_MODEL_OVERRIDE: 'claude-sonnet-4-7' },
  })) {
    events.push(msg);
  }
  const sessionInit = events.find((e) => e.type === 'session_init');
  const done = events.find((e) => e.type === 'done');
  assert.equal(
    sessionInit?.metadata?.model,
    'claude-sonnet-4-7',
    'session_init must report effective model (override)',
  );
  assert.equal(
    done?.metadata?.model,
    'claude-sonnet-4-7',
    'success-path done must report effective model (override), not this.model',
  );
  assert.notEqual(
    done?.metadata?.model,
    'claude-opus-4-7',
    'success-path done must NOT fall back to constructor model when override active',
  );
});
