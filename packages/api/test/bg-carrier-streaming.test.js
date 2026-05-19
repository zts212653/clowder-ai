/**
 * F198 Phase B Step 2 slice 2: end-to-end streaming via transcript tailing.
 *
 * Asserts ClaudeBgCarrierService.invoke() actually streams AgentMessages
 * derived from transcript.linkScanPath as the file grows, not just a single
 * final output.result text.
 *
 * 砚砚 slice 2 plan:
 *   wire chunked transcript tailing, lifecycle (session_init/done) only
 *   once, terminal `done` calls extractTranscriptUsage on accumulated entries.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ClaudeBgCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

function buildFakeSpawn({ stdout = '', exitCode = 0 }) {
  return (_cmd, _args, _opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode);
    });
    return child;
  };
}

function assistantEntry({ text, toolUse, usage }) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (toolUse) content.push({ type: 'tool_use', id: toolUse.id, name: toolUse.name, input: toolUse.input });
  return {
    type: 'assistant',
    message: {
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      usage,
    },
  };
}

test('invoke() streams text/tool_use via TranscriptTailer as transcript grows; emits done(usage)', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'beef1234';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-transcript.jsonl`);

  // Initial state: working, with linkScanPath set
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'working', daemonShort: shortId, linkScanPath: transcriptPath }),
  );

  // Pre-seed transcript with first assistant turn
  writeFileSync(
    transcriptPath,
    `${JSON.stringify(assistantEntry({ text: 'Hello!', usage: { input_tokens: 10, output_tokens: 5 } }))}\n`,
  );

  // After 100ms: daemon writes a tool_use turn
  setTimeout(() => {
    appendFileSync(
      transcriptPath,
      `${JSON.stringify(
        assistantEntry({
          toolUse: { id: 't1', name: 'Read', input: { file_path: '/x' } },
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
      )}\n`,
    );
  }, 150);

  // After 250ms: daemon transitions to done state
  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'done', daemonShort: shortId, linkScanPath: transcriptPath }),
    );
  }, 300);

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    // Faster poll for test speed
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  // Order contract: session_init → (text|tool_use)+ → done
  assert.equal(types[0], 'session_init', 'first event must be session_init');
  assert.equal(types[types.length - 1], 'done', 'last event must be done');
  assert.ok(types.includes('text'), 'must yield text AgentMessage from first assistant turn');
  assert.ok(types.includes('tool_use'), 'must yield tool_use AgentMessage from second assistant turn (R2)');

  const text = events.find((e) => e.type === 'text');
  assert.equal(text.content, 'Hello!');
  const toolUse = events.find((e) => e.type === 'tool_use');
  assert.equal(toolUse.toolName, 'Read');
  assert.deepEqual(toolUse.toolInput, { file_path: '/x' });

  const done = events[events.length - 1];
  assert.equal(done.metadata.provider, 'claude-bg');
  assert.equal(done.metadata.model, 'claude-opus-4-7');
  assert.ok(done.metadata.usage, 'done.metadata.usage must be populated from extractTranscriptUsage');
  // Aggregated: input 30, output 13
  assert.equal(done.metadata.usage.inputTokens, 30);
  assert.equal(done.metadata.usage.outputTokens, 13);
  assert.equal(done.metadata.usage.numTurns, 2);
});

test('cloud codex P2 round-16: drain failure after successful streaming → usage still emitted', async () => {
  // Cloud codex round-16: when streaming gathered real usage data but the
  // terminal final-drain fails (transcript becomes unreadable at terminal),
  // round-15 degrade sets tailer=undefined. If the done-event gate requires
  // tailer to be truthy, real accumulated usage telemetry is silently lost.
  //
  // Scenario: stream phase succeeds + observes usage → terminal phase tries
  // final drain but file is gone → tailer=undefined → done must STILL emit
  // the usage we already accumulated.
  const { rmSync } = await import('node:fs');
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'd4a17a17';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-streaming-then-fail.jsonl`);

  // Initial state: working, with linkScanPath set + transcript exists
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'working', daemonShort: shortId, linkScanPath: transcriptPath }),
  );
  const entry = {
    type: 'assistant',
    message: {
      id: 'msg_real',
      role: 'assistant',
      content: [{ type: 'text', text: 'Streamed.' }],
      usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 },
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);

  // Schedule: after stream phase, delete transcript + set state to done
  setTimeout(() => {
    rmSync(transcriptPath, { force: true });
    // Replace path with a directory so subsequent readNew throws
    mkdirSync(transcriptPath);
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({
        state: 'done',
        daemonShort: shortId,
        linkScanPath: transcriptPath, // now a directory → readNew throws
        output: { result: 'Streamed.' },
      }),
    );
  }, 150);

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  // CRITICAL: accumulator had real signal from stream phase → usage MUST be
  // emitted even though terminal drain failed (tailer became undefined).
  assert.ok(done.metadata?.usage, 'must emit usage when accumulator has real signal, regardless of tailer degradation');
  assert.equal(done.metadata.usage.outputTokens, 15);
  assert.equal(done.metadata.usage.inputTokens, 30 + 50 + 5);
});

test('cloud codex P1 round-15: terminal state + unreadable transcript → fall back to output.result (not throw)', async () => {
  // Cloud codex round-15: round-12 P1 (throw on tail read fail + bestEffortStop)
  // conflicts with round-13 regression A (linkScanPath set + transcript missing
  // → fallback to output.result). When state.json is already terminal AND
  // linkScanPath becomes unreadable (directory / permission error), the
  // pre-terminal tailer.readNew() throw blocks the terminal branch from
  // surfacing the successful output.result. Should gracefully degrade.
  //
  // Distinction: non-terminal + unreadable → throw (real consumer failure);
  // terminal + unreadable → degrade (we already have the answer via fallback).
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'a17e7000';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const badTranscriptPath = join(tmpJobsDir, `${shortId}-as-dir`);
  mkdirSync(badTranscriptPath); // unreadable: path is a directory
  // state.json is ALREADY terminal (done) with output.result set
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: badTranscriptPath,
      output: { result: 'terminal-state fallback answer' },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  // Must NOT throw — state is terminal, we have output.result, degrade gracefully.
  for await (const msg of service.invoke('hi')) events.push(msg);

  const text = events.find((e) => e.type === 'text');
  assert.ok(text, 'must emit fallback text from output.result instead of throwing');
  assert.equal(text.content, 'terminal-state fallback answer');
  const done = events[events.length - 1];
  assert.equal(done.type, 'done', 'lifecycle must complete with done event');
});

test('cloud codex P2 round-14: assistant entries WITHOUT message.usage → no synthetic zero token counts', async () => {
  // Cloud codex round-14: when assistant entries are present but
  // message.usage is missing/undefined, accumulator stays at 0 for token
  // fields. finalizeTranscriptUsage still builds {output_tokens: 0, ...}
  // in the synthetic event → extractClaudeUsage emits `outputTokens: 0`
  // as real telemetry. Round-13 gate (assistantTurnCount > 0) doesn't help
  // because assistant entries DO exist — just no usage data. Skews
  // cost/telemetry to false zero-token completions.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'a55e7b0c';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-no-usage.jsonl`);

  // Assistant entry: text content present, message.usage ABSENT
  const entryWithoutUsage = {
    type: 'assistant',
    message: {
      id: 'msg_no_usage',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reply without usage data.' }],
      // No `usage` key at all
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(entryWithoutUsage)}\n`);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: 'Reply without usage data.' }, // matches transcript → no fallback
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  const usage = done.metadata?.usage;
  // usage may exist (numTurns observed) but must NOT have outputTokens: 0
  // or inputTokens: 0 because no usage was actually observed.
  if (usage !== undefined) {
    assert.equal(
      usage.outputTokens,
      undefined,
      'outputTokens must NOT be 0/synthesized when no real usage data was observed',
    );
    assert.equal(
      usage.inputTokens,
      undefined,
      'inputTokens must NOT be 0/synthesized when no real usage data was observed',
    );
  }
});

test('cloud codex P2 round-13: transcript declared but empty → no misleading zero-usage metadata', async () => {
  // Cloud codex round-13: when linkScanPath is set but transcript yields
  // zero parseable assistant entries, finalizeTranscriptUsage(empty acc)
  // produces a synthetic usage object with outputTokens:0 + durationMs.
  // That makes telemetry/cost reporting say "this invocation consumed 0
  // tokens" — silently wrong. Only attach usage when accumulator has signal.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = '0a112022';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-empty.jsonl`);
  // Transcript exists but completely empty (no parseable entries)
  writeFileSync(transcriptPath, '');
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: 'fallback answer' },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  // Must NOT report fake zero-token usage. Either no usage key, or usage
  // is undefined. (Real-signal threshold = at least one parsed assistant entry.)
  assert.equal(
    done.metadata?.usage,
    undefined,
    'must NOT attach misleading zero-token usage when transcript had no parseable entries',
  );
  // But fallback text should still surface (output.result has the answer)
  assert.ok(events.find((e) => e.type === 'text' && e.content === 'fallback answer'));
});

test('cloud codex P1: tailer.readNew throw → bestEffortStop issued + error rethrown (no leaked --bg job)', async () => {
  // Cloud codex round-12: if tailer.readNew() fails (linkScanPath becomes
  // directory / removed between polls / unreadable), invoke must call
  // bestEffortStop before throwing so the detached --bg session stops
  // consuming quota. Pattern matches the round-5 waitForTerminal guard.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'feedbeef';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  // linkScanPath points to a path that exists but is a DIRECTORY → readFile fails
  const badTranscriptPath = join(tmpJobsDir, `${shortId}-as-dir`);
  mkdirSync(badTranscriptPath);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'working', daemonShort: shortId, linkScanPath: badTranscriptPath }),
  );

  const spawnCalls = [];
  const fakeSpawn = (_cmd, args, _opts) => {
    spawnCalls.push({ args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => {
      if (args[0] === '--bg') {
        child.stdout.emit('data', Buffer.from(`backgrounded · ${shortId}\n`));
        child.emit('close', 0);
      }
    });
    return child;
  };
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const iterator = service.invoke('hi')[Symbol.asyncIterator]();
  const init = await iterator.next();
  assert.equal(init.value.type, 'session_init');

  await assert.rejects(
    () => iterator.next(),
    (err) => {
      assert.match(err.message, /transcript/i, 'must throw on tailer read failure');
      return true;
    },
  );

  const stopCalls = spawnCalls.filter((c) => c.args[0] === 'stop');
  assert.equal(stopCalls.length, 1, 'must issue claude stop after tailer read failure');
  assert.equal(stopCalls[0].args[1], shortId);
});

test('cloud codex P2: long transcript (50+ entries) → done.usage correct without retaining all entries', async () => {
  // Cloud codex round-12 P2: invoke must aggregate usage incrementally,
  // not by retaining every entry. Behavioral assertion: with 50 assistant
  // entries the final usage equals sum-of-per-turn. (Structural test on
  // memory bounds is code-review verified; this test ensures the
  // incremental aggregation produces correct totals.)
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'b164a55a';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-many.jsonl`);

  // Pre-seed 50 assistant entries
  const lines = [];
  for (let i = 0; i < 50; i++) {
    lines.push(
      JSON.stringify(
        assistantEntry({
          text: `Turn ${i} response.`,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
        }),
      ),
    );
  }
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: 'Turn 49 response.' }, // matches last transcript text → no fallback
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  const usage = done.metadata?.usage;
  assert.ok(usage, 'must have usage');
  // 50 turns × (10 + 100 + 20) = 6500 inputTokens
  assert.equal(usage.inputTokens, 50 * (10 + 100 + 20));
  assert.equal(usage.outputTokens, 50 * 5);
  assert.equal(usage.cacheReadTokens, 50 * 100);
  assert.equal(usage.cacheCreationTokens, 50 * 20);
  assert.equal(usage.numTurns, 50);
  // diagnostics.transcriptEntries should still be tracked (entry count is cheap)
  assert.ok(typeof done.metadata?.diagnostics?.transcriptEntries === 'number');
});

test('codex slice-2 P1 round-4: early text contains result as substring → still emit fallback (no false coverage)', async () => {
  // 砚砚 round 4: containment via includes() was too generous. If early
  // transcript text happens to mention the short result as substring
  // ("I will verify SPIKE_OK") while final answer is only in
  // output.result ("SPIKE_OK"), substring match falsely suppresses the
  // fallback. Strict predicate: last assistant entry's text MUST equal
  // output.result for the suppress branch.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = '5b04ada7';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-substring-trap.jsonl`);

  // Single assistant entry: text mentions the result as substring + tool_use.
  // No subsequent assistant entry with the actual final answer.
  const entry = {
    type: 'assistant',
    message: {
      id: 'msg_substring',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will verify SPIKE_OK on the file.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo SPIKE_OK' } },
      ],
      usage: { input_tokens: 10, output_tokens: 8 },
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);

  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: 'SPIKE_OK' }, // short final answer that happens to be a substring of early text
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const textEvents = events.filter((e) => e.type === 'text');
  // Must emit BOTH: early "I will verify SPIKE_OK..." AND fallback "SPIKE_OK".
  assert.equal(textEvents.length, 2, 'must emit early text AND output.result fallback (substring is not coverage)');
  const finalText = textEvents.find((e) => e.content === 'SPIKE_OK');
  assert.ok(finalText, 'output.result must surface as fallback even when it appears as substring in earlier text');
});

test('codex slice-2 P1 round-3: transcript has EARLY text + tool_use, final answer only in output.result → still emit fallback', async () => {
  // 砚砚 re-review round 3: guard "has any text → suppress fallback" is still
  // the wrong coordinate. The right predicate is "transcript text covers
  // state.output.result". Scenario: model says "I'll check..." then calls
  // tool, but the FINAL prose answer is only in state.output.result (daemon
  // didn't write the post-tool text turn to transcript before state=done).
  // Old behavior: session_init → text:"I'll check..." → tool_use → done.
  // Final answer lost. Fix: containment check — transcript text must
  // include state.output.result, otherwise fallback fires.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'ea71b41f';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-early.jsonl`);

  // transcript: early text "I will inspect..." + tool_use, NO final text
  const earlyEntry = {
    type: 'assistant',
    message: {
      id: 'msg_early',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect the file first.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } },
      ],
      usage: { input_tokens: 30, output_tokens: 15 },
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(earlyEntry)}\n`);

  const finalAnswer = 'The file contains 42 lines of Lorem ipsum.';
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: finalAnswer },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  // Early text should appear (no behavior change for that).
  const earlyText = events.find((e) => e.type === 'text' && e.content === 'I will inspect the file first.');
  assert.ok(earlyText, 'early transcript text still surfaces');
  // tool_use should appear.
  assert.ok(
    events.find((e) => e.type === 'tool_use'),
    'tool_use surfaces',
  );
  // CRITICAL: final answer must be surfaced via fallback because transcript
  // does NOT contain it.
  const finalText = events.find((e) => e.type === 'text' && e.content === finalAnswer);
  assert.ok(finalText, 'output.result must surface as text when transcript does not contain it');
});

test('codex slice-2 P1 round-3: transcript text already CONTAINS output.result → no duplicate fallback', async () => {
  // Symmetric guard: if transcript text fully covers state.output.result
  // (the normal case — model emitted final prose AND daemon mirrored it
  // to output.result), do NOT emit duplicate text fallback.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'd0cab241';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-covered.jsonl`);

  const finalAnswer = 'Hello world final answer.';
  const entry = {
    type: 'assistant',
    message: {
      id: 'msg_full',
      role: 'assistant',
      content: [{ type: 'text', text: finalAnswer }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: finalAnswer },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const textEvents = events.filter((e) => e.type === 'text');
  assert.equal(textEvents.length, 1, 'must NOT duplicate text when transcript already covers output.result');
  assert.equal(textEvents[0].content, finalAnswer);
});

test('codex slice-2 P1 round-2: transcript yields tool_use ONLY → output.result must still surface as final text', async () => {
  // 砚砚 re-review (round 2): "any user-visible content" guard was too broad.
  // tool_use being visible doesn't mean the user got the model's final
  // prose answer. If transcript only emitted tool_use (no text entries)
  // AND output.result has the final text, the fallback MUST still fire.
  // Otherwise: session_init → tool_use → done (final answer lost).
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = '7001b41f';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-tool-only.jsonl`);

  // transcript: ONE assistant entry with tool_use ONLY (no text block)
  const toolOnlyEntry = {
    type: 'assistant',
    message: {
      id: 'msg_tool_only',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  writeFileSync(transcriptPath, `${JSON.stringify(toolOnlyEntry)}\n`);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath,
      output: { result: 'final answer that is only in output.result' },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  // Both must be present: tool_use (from transcript) AND text (from output.result fallback).
  assert.ok(types.includes('tool_use'), 'tool_use from transcript still surfaces');
  const text = events.find((e) => e.type === 'text');
  assert.ok(text, 'output.result MUST still surface as text even when tool_use was yielded');
  assert.equal(text.content, 'final answer that is only in output.result');
});

test('codex slice-2 P1 regression A: linkScanPath set + transcript missing → fallback to output.result', async () => {
  // 砚砚 slice-2 review: tailer was initialized (linkScanPath present) but
  // transcript file never materialized / empty / unreadable. Old code:
  // `!tailer` check blocked the fallback, daemon went silent. Now: if no
  // user-visible message came through transcript at terminal, surface
  // output.result as last-resort text.
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'b00b1234';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  // Transcript path declared in state but file never created
  const transcriptPath = join(tmpJobsDir, `${shortId}-missing.jsonl`);
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({
      state: 'done',
      daemonShort: shortId,
      linkScanPath: transcriptPath, // declared but file doesn't exist
      output: { result: 'final answer text' },
    }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const text = events.find((e) => e.type === 'text');
  assert.ok(text, 'must fall back to output.result when transcript yielded no user-visible content');
  assert.equal(text.content, 'final answer text');
});

test('codex slice-2 P1 regression B: transcript last line lacks trailing newline → terminal drainFinal reads it', async () => {
  // 砚砚 slice-2 review: daemon writes final assistant entry but the OS
  // hasn't flushed the trailing \n yet. TranscriptTailer correctly held
  // back the partial line during streaming, but terminal final-read must
  // include it (it's been committed as state=done so the entry IS complete).
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'd00d1234';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  const transcriptPath = join(tmpJobsDir, `${shortId}-no-newline.jsonl`);

  // Write a complete JSON line WITHOUT trailing \n — simulates daemon flush
  // race where state went to done before fs wrote the final newline.
  const finalEntry = assistantEntry({
    text: 'No trailing newline answer',
    usage: { input_tokens: 5, output_tokens: 4 },
  });
  writeFileSync(transcriptPath, JSON.stringify(finalEntry));
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'done', daemonShort: shortId, linkScanPath: transcriptPath }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const text = events.find((e) => e.type === 'text');
  assert.ok(text, 'terminal final-drain must include the trailing-\\n-less complete line');
  assert.equal(text.content, 'No trailing newline answer');
});

test('invoke() legacy fallback: no linkScanPath but state.output.result present → single text', async () => {
  // Backward-compat: tests that seed state.json without linkScanPath should
  // still surface output.result as text (existing PR #1666 tests rely on this).
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-stream-test-'));
  const shortId = 'feed1234';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'done', daemonShort: shortId, output: { result: 'legacy text' } }),
  );

  const fakeSpawn = buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` });
  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: fakeSpawn,
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 50,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const text = events.find((e) => e.type === 'text');
  assert.ok(text, 'legacy path must still surface text from output.result');
  assert.equal(text.content, 'legacy text');
  const done = events[events.length - 1];
  assert.equal(done.type, 'done');
  // Legacy path: no transcript → no usage in metadata
  assert.equal(done.metadata.usage, undefined);
});
