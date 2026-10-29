import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('real stdio exposes the bounded input contract and refuses an unknown binding', async () => {
  const home = resolve('.cat-cafe/tmp/claude-acp-parity/wire-home');
  await mkdir(home, { recursive: true });
  const child = spawn(process.execPath, [resolve('.cat-cafe/tmp/claude-acp-parity/upstream/dist/index.js')], {
    cwd: home,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      CLAUDE_CONFIG_DIR: home,
      USERPROFILE: home,
      HOME: home,
      CLAUDE_AGENT_ACP_PROTOCOL: 'v1',
    },
  });
  let buffer = '',
    sequence = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message);
    }
  });
  const request = (method, params) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => reject(new Error('wire timeout')), 10000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        done(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  try {
    await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const result = await request('_clowder/spike/v1/input', {
      sessionId: 'absent',
      runKey: 'run',
      inputId: randomUUID(),
      mode: 'append',
      prompt: [{ type: 'text', text: 'synthetic' }],
    });
    assert.notEqual(result.error?.code, -32601, 'input contract is missing on the actual wire');
    assert.equal(result.error?.code, -32603);
    assert.equal(result.result, undefined);
  } finally {
    const stopped = new Promise((done) => child.once('exit', done));
    child.stdin.end();
    const guard = setTimeout(() => child.kill(), 2000);
    await stopped;
    clearTimeout(guard);
  }
});
