import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('AntigravityBridge.pushToolResult', () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    cleanupPaths.length = 0;
  });

  function createBridge() {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath },
    );
    const rpcCalls = [];
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 'test', useTls: false }));
    // Patch the private rpc through prototype access
    const proto = Object.getPrototypeOf(bridge);
    proto.rpc = async (_conn, method, payload) => {
      rpcCalls.push({ method, payload });
      if (method === 'CancelCascadeSteps') return {};
      return {};
    };
    mock.method(bridge, 'sendMessage', async (cascadeId, text) => {
      rpcCalls.push({ method: 'sendMessage', payload: { cascadeId, text } });
      return 1;
    });
    return { bridge, rpcCalls };
  }

  test('cancels stuck step then injects synthetic user message with stdout', async () => {
    const { bridge, rpcCalls } = createBridge();
    await bridge.pushToolResult(
      'c1',
      23,
      {
        status: 'success',
        output: { exitCode: 0 },
        stdout: '3e6c7a0 first\n9ba57d8 second\n',
        exitCode: 0,
        durationMs: 42,
      },
      { commandLine: 'git log --oneline -5', cwd: '/tmp' },
    );
    const cancel = rpcCalls.find((c) => c.method === 'CancelCascadeSteps');
    assert.ok(cancel, 'should call CancelCascadeSteps');
    assert.equal(cancel.payload.cascadeId, 'c1');
    const msg = rpcCalls.find((c) => c.method === 'sendMessage');
    assert.ok(msg, 'should call sendMessage');
    assert.equal(msg.payload.cascadeId, 'c1');
    assert.match(msg.payload.text, /git log --oneline -5/);
    assert.match(msg.payload.text, /3e6c7a0 first/);
    assert.match(msg.payload.text, /exit.*0/i);
  });

  test('includes stderr in message when present', async () => {
    const { bridge, rpcCalls } = createBridge();
    await bridge.pushToolResult(
      'c1',
      5,
      {
        status: 'success',
        output: { exitCode: 1 },
        stdout: '',
        stderr: 'fatal: not a git repo\n',
        exitCode: 1,
        durationMs: 10,
      },
      { commandLine: 'git status', cwd: '/tmp' },
    );
    const msg = rpcCalls.find((c) => c.method === 'sendMessage');
    assert.match(msg.payload.text, /fatal: not a git repo/);
    assert.match(msg.payload.text, /exit.*1/i);
  });

  test('reports refused when executor refused', async () => {
    const { bridge, rpcCalls } = createBridge();
    await bridge.pushToolResult(
      'c1',
      10,
      { status: 'refused', reason: 'Redis 6399 is user sanctum' },
      { commandLine: 'redis-cli -p 6399 del x', cwd: '/tmp' },
    );
    const msg = rpcCalls.find((c) => c.method === 'sendMessage');
    assert.match(msg.payload.text, /refused/i);
    assert.match(msg.payload.text, /6399/);
  });

  test('truncates long stdout with marker', async () => {
    const { bridge, rpcCalls } = createBridge();
    const bigStdout = 'A'.repeat(20000);
    await bridge.pushToolResult(
      'c1',
      1,
      { status: 'success', output: { exitCode: 0 }, stdout: bigStdout, exitCode: 0, durationMs: 1 },
      { commandLine: 'some-cmd', cwd: '/tmp' },
    );
    const msg = rpcCalls.find((c) => c.method === 'sendMessage');
    assert.ok(msg.payload.text.length < 10000, `text should be truncated, got ${msg.payload.text.length} chars`);
    assert.match(msg.payload.text, /truncated/i);
  });
});
