/**
 * Gemini chunk boundary tests — streaming delta raw concat
 *
 * Gemini CLI stream-json emits each content chunk as a separate
 * message/assistant event with delta:true. GeminiAgentService must
 * raw-concat them without injecting synthetic \n\n separators.
 *
 * Covers: display text integrity, @ handle routing, path/digit/English
 * chunk boundaries.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, mock, test } from 'node:test';
import { ensureFakeCliOnPath } from './helpers/fake-cli-path.js';

const { GeminiAgentService } = await import('../dist/domains/cats/services/agents/providers/GeminiAgentService.js');

ensureFakeCliOnPath('gemini');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 99999,
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

function emitGeminiEvents(proc, events) {
  for (const event of events) {
    proc.stdout.write(`${JSON.stringify(event)}\n`);
  }
  proc.stdout.once('finish', () => {
    process.nextTick(() => proc._emitter.emit('exit', 0, null));
  });
  proc.stdout.end();
}

function setup() {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const service = new GeminiAgentService({ spawnFn, adapter: 'gemini-cli' });
  return { proc, service };
}

describe('Gemini streaming delta — no synthetic \\n\\n', () => {
  test('CJK chunk boundary: yielded text has no \\n\\n between chunks', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's1', model: 'auto' },
      { type: 'message', role: 'assistant', content: '调', delta: true },
      { type: 'message', role: 'assistant', content: '用', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    assert.equal(texts.length, 2);
    assert.equal(texts[0].content, '调');
    assert.equal(texts[1].content, '用', 'second chunk must NOT have \\n\\n prefix');
    assert.ok(!texts[1].content.includes('\n\n'), 'no synthetic separator');
  });

  test('path chunk boundary: /Volumes + /mac1t → no \\n\\n', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's2', model: 'auto' },
      { type: 'message', role: 'assistant', content: '/Volumes', delta: true },
      { type: 'message', role: 'assistant', content: '/mac1t/test', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    assert.equal(texts[1].content, '/mac1t/test');
    const combined = texts.map((m) => m.content).join('');
    assert.equal(combined, '/Volumes/mac1t/test');
  });

  test('digit chunk boundary: 2 + 026 → no \\n\\n', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's3', model: 'auto' },
      { type: 'message', role: 'assistant', content: '2', delta: true },
      { type: 'message', role: 'assistant', content: '026-05-13', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    const combined = texts.map((m) => m.content).join('');
    assert.equal(combined, '2026-05-13');
  });

  test('English chunk boundary: A + cknowledge → no \\n\\n', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's4', model: 'auto' },
      { type: 'message', role: 'assistant', content: 'A', delta: true },
      { type: 'message', role: 'assistant', content: 'cknowledge', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    const combined = texts.map((m) => m.content).join('');
    assert.equal(combined, 'Acknowledge');
    assert.ok(!texts[1].content.startsWith('\n\n'));
  });

  test('@ handle chunk boundary: @缅 + 因猫 → @缅因猫 intact for routing', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's5', model: 'auto' },
      { type: 'message', role: 'assistant', content: '一些文字\n@缅', delta: true },
      { type: 'message', role: 'assistant', content: '因猫\n请帮忙', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    assert.equal(texts[1].content, '因猫\n请帮忙', 'second chunk has no \\n\\n prefix');

    const combined = texts.map((m) => m.content).join('');
    assert.equal(combined, '一些文字\n@缅因猫\n请帮忙');
    assert.ok(combined.includes('\n@缅因猫\n'), '@ handle is intact on its own line');
    assert.ok(!combined.includes('@缅\n\n因猫'), 'no synthetic \\n\\n splitting the handle');
  });

  test('multiple chunks after tool_use: no synthetic \\n\\n', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's6', model: 'auto' },
      { type: 'message', role: 'assistant', content: 'Let me check.', delta: true },
      { type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { path: '/tmp/x' } },
      { type: 'tool_result', tool_id: 't1', status: 'success', output: 'data' },
      { type: 'message', role: 'assistant', content: 'The file contains', delta: true },
      { type: 'message', role: 'assistant', content: ' the data.', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    assert.equal(texts.length, 3);
    assert.equal(texts[1].content, 'The file contains', 'post-tool text has no \\n\\n');
    assert.equal(texts[2].content, ' the data.', 'consecutive post-tool text has no \\n\\n');
  });

  test('all yielded text events preserve original content (no content mutation)', async () => {
    const { proc, service } = setup();
    const promise = collect(service.invoke('test'));

    const chunks = ['First', ' second', ' third', ' fourth'];
    emitGeminiEvents(proc, [
      { type: 'init', session_id: 's7', model: 'auto' },
      ...chunks.map((c) => ({ type: 'message', role: 'assistant', content: c, delta: true })),
      { type: 'result', status: 'success', stats: {} },
    ]);

    const msgs = await promise;
    const texts = msgs.filter((m) => m.type === 'text');
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(texts[i].content, chunks[i], `chunk ${i} content must not be mutated`);
    }
  });
});
