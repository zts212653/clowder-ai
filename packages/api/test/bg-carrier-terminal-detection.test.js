/**
 * F198 Phase D Bug #2: BgCarrier terminal-state detection.
 *
 * Root cause (bug-report 2026-05-19-F198-bg-carrier-hang-resume):
 *   When a `claude --bg` daemon invokes an MCP tool, `state.json.state`
 *   gets permanently stuck at `working` after the turn completes. The
 *   transcript correctly records turn completion (system/turn_duration +
 *   system/stop_hook_summary) but state.json is never updated. The carrier
 *   used `state==='done'` as its only terminal trigger → looped to the
 *   30-minute timeout → UI showed "正在回复" forever.
 *
 * Plus: JobState enum omitted `failed`/`blocked`/`stopped` — daemons that
 * end in those states also hung the carrier to timeout.
 *
 * Fix: detect terminal from the transcript turn-completion markers, and
 * recognise the full daemon state enum.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

function assistantTextEntry(text) {
  return {
    type: 'assistant',
    message: {
      id: `msg_${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  };
}

/** Seed a job dir with state.json + (optional) transcript jsonl. */
function seedJob(jobsDir, shortId, { state, detail, needs, output, transcriptLines }) {
  const jobDir = join(jobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });
  let transcriptPath;
  if (transcriptLines) {
    transcriptPath = join(jobsDir, `${shortId}-transcript.jsonl`);
    writeFileSync(transcriptPath, transcriptLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state, detail, needs, output, daemonShort: shortId, linkScanPath: transcriptPath }),
  );
  return transcriptPath;
}

test('Bug #2: invoke() terminates via transcript turn_duration even when state.json stuck at working', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-term-test-'));
  const shortId = 'aaaa1111';
  // state.json PERMANENTLY stuck at working — daemon never writes done
  // (reproduces the real `77df0627` evidence). Transcript HAS the turn
  // completion markers.
  seedJob(tmpJobsDir, shortId, {
    state: 'working',
    detail: 'scanning for deeper context',
    transcriptLines: [
      assistantTextEntry('Here is the answer.'),
      { type: 'system', subtype: 'stop_hook_summary' },
      { type: 'system', subtype: 'turn_duration', durationMs: 4200 },
    ],
  });

  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` }),
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 30,
    timeoutMs: 3000, // would throw timeout with the buggy carrier
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  assert.equal(types[types.length - 1], 'done', 'must emit done (detected via transcript turn_duration)');
  assert.ok(types.includes('text'), 'must stream the assistant text');
  const text = events.find((e) => e.type === 'text');
  assert.equal(text.content, 'Here is the answer.');
});

test('Bug #2: invoke() treats state=failed as terminal error', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-term-test-'));
  const shortId = 'bbbb2222';
  seedJob(tmpJobsDir, shortId, { state: 'failed', detail: 'exit 1 before init — bad MCP config' });

  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` }),
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 30,
    timeoutMs: 3000,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  assert.ok(types.includes('error'), 'state=failed must yield an error AgentMessage');
  assert.equal(types[types.length - 1], 'done', 'must still emit done after error (no throw)');
  const err = events.find((e) => e.type === 'error');
  assert.match(err.error, /bad MCP config/, 'error message should surface the daemon detail');
});

test('Bug #2: invoke() treats state=blocked as terminal (surfaces needs)', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-term-test-'));
  const shortId = 'cccc3333';
  seedJob(tmpJobsDir, shortId, {
    state: 'blocked',
    detail: 'awaiting user go-ahead',
    needs: 'confirm whether to trigger the demo',
  });

  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` }),
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 30,
    timeoutMs: 3000,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  assert.ok(types.includes('error'), 'state=blocked must yield an error AgentMessage');
  assert.equal(types[types.length - 1], 'done', 'must emit done after blocked (no 30-min hang)');
  const err = events.find((e) => e.type === 'error');
  assert.match(err.error, /confirm whether to trigger the demo/, 'blocked error should surface the needs field');
});

test('Bug #2: invoke() treats state=stopped as terminal', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-term-test-'));
  const shortId = 'dddd4444';
  seedJob(tmpJobsDir, shortId, { state: 'stopped', detail: 'stopped' });

  const service = new ClaudeBgCarrierService({
    l0CompilerFn: fakeL0Compiler,
    spawnFn: buildFakeSpawn({ stdout: `backgrounded · ${shortId}\n` }),
    model: 'claude-opus-4-7',
    jobsDir: tmpJobsDir,
    pollMs: 30,
    timeoutMs: 3000,
  });

  const events = [];
  for await (const msg of service.invoke('hi')) events.push(msg);

  const types = events.map((e) => e.type);
  assert.equal(types[types.length - 1], 'done', 'state=stopped must terminate the carrier with done');
});
