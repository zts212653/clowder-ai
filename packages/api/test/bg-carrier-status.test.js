/**
 * F198 Phase C - AC-C2: daemon state.detail → 'status' AgentMessage stream
 *
 * Verifies ClaudeBgCarrierService.invoke() yields { type: 'status', content: detail }
 * when state.json detail changes during the working phase.
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

test('F198-C AC-C2: emits status message when state.detail changes from null to a string', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-status-test-'));
  const shortId = 'c2a11111';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });

  // Initial state: working, detail null
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ state: 'working', daemonShort: shortId }));

  // After 100ms: update detail
  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'working', daemonShort: shortId, detail: 'searching for F198 evidence...' }),
    );
  }, 120);

  // After 250ms: transition to done
  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'done', daemonShort: shortId, output: { result: 'found it' } }),
    );
  }, 260);

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

  const statusEvents = events.filter((e) => e.type === 'status');
  assert.ok(statusEvents.length >= 1, 'must emit at least one status AgentMessage when detail changes');
  assert.equal(
    statusEvents[0].content,
    'searching for F198 evidence...',
    'status message content must be the detail string',
  );
  assert.equal(statusEvents[0].catId, service.catId, 'status message must carry catId');
  assert.ok(typeof statusEvents[0].timestamp === 'number', 'status message must have timestamp');
});

test('F198-C AC-C2: same detail value repeated across multiple polls → only 1 status message (dedup)', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-status-test-'));
  const shortId = 'c2a22222';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });

  // State stays with the same detail for 5 polls (pollMs=50 → ~250ms), then done
  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'working', daemonShort: shortId, detail: 'same detail every poll' }),
  );

  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'done', daemonShort: shortId, output: { result: 'done' } }),
    );
  }, 300);

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

  const statusEvents = events.filter((e) => e.type === 'status');
  assert.equal(statusEvents.length, 1, 'must NOT duplicate status message when detail is unchanged across polls');
  assert.equal(statusEvents[0].content, 'same detail every poll');
});

test('F198-C AC-C2: detail=null → no status message emitted', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-status-test-'));
  const shortId = 'c2a33333';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });

  // State is working with null detail (no detail key at all)
  writeFileSync(join(jobDir, 'state.json'), JSON.stringify({ state: 'working', daemonShort: shortId }));

  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'done', daemonShort: shortId, output: { result: 'silent' } }),
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

  const statusEvents = events.filter((e) => e.type === 'status');
  assert.equal(statusEvents.length, 0, 'must NOT emit status when detail is null/absent');
});

test('F198-C AC-C2: detail changes multiple times → emits status for each distinct value', async () => {
  const tmpJobsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-status-test-'));
  const shortId = 'c2a44444';
  const jobDir = join(tmpJobsDir, shortId);
  mkdirSync(jobDir, { recursive: true });

  writeFileSync(
    join(jobDir, 'state.json'),
    JSON.stringify({ state: 'working', daemonShort: shortId, detail: 'step 1: searching...' }),
  );

  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'working', daemonShort: shortId, detail: 'step 2: loading MCP tools...' }),
    );
  }, 120);

  setTimeout(() => {
    writeFileSync(
      join(jobDir, 'state.json'),
      JSON.stringify({ state: 'done', daemonShort: shortId, output: { result: 'all done' } }),
    );
  }, 260);

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

  const statusEvents = events.filter((e) => e.type === 'status');
  assert.ok(statusEvents.length >= 2, 'must emit status for each distinct detail value');
  const contents = statusEvents.map((e) => e.content);
  assert.ok(contents.includes('step 1: searching...'), 'must emit status for first detail');
  assert.ok(contents.includes('step 2: loading MCP tools...'), 'must emit status for second detail');
});
