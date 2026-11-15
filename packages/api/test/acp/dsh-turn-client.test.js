import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpClient } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

function createMockChild() {
  const clientStdin = new PassThrough();
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  const ee = new EventEmitter();
  const child = {
    pid: 12345,
    stdin: clientStdin,
    stdout: agentStdout,
    stderr: agentStderr,
    killed: false,
    kill: mock.fn(() => {
      child.killed = true;
      agentStdout.end();
      agentStderr.end();
      ee.emit('exit', 0, null);
      return true;
    }),
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    removeListener: ee.removeListener.bind(ee),
  };
  return { child, clientStdin, agentStdout };
}

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'test', title: 'Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

function agentRespond(stdout, id, result) {
  setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`));
}
function agentError(stdout, id, code, message) {
  setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`));
}
function agentNotify(stdout, method, params) {
  setImmediate(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`));
}

function requestLines(stdin, handler) {
  stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      if (line.trim()) handler(JSON.parse(line));
    }
  });
}

describe('DSH turn client channel', () => {
  const clients = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
  });

  function create(handler) {
    const { child, clientStdin, agentStdout } = createMockChild();
    requestLines(clientStdin, (message) => handler(message, agentStdout));
    const client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    clients.push(client);
    return { client, agentStdout };
  }

  it('negotiates the private bridge without changing ordinary initialize', async () => {
    const { client } = create((message, stdout) => {
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      if (message.method === '_clowder/hello')
        return agentRespond(stdout, message.id, {
          protocol: 1,
          bridge: 'cat-cafe-dsh-turn',
          steer: true,
          nativeTurns: true,
          desktopVersion: '0.2.2-rc.1',
        });
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();
    const capability = await client.probeTurnBridge();
    assert.equal(capability?.steer, true);
    assert.equal(capability?.nativeTurns, true);
    assert.equal(client.turnBridge?.desktopVersion, '0.2.2-rc.1');
  });

  it('keeps the private notification out of the prompt stream', async () => {
    const events = [];
    const { client } = create((message, stdout) => {
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      if (message.method === 'session/new') return agentRespond(stdout, message.id, { sessionId: 's1' });
      if (message.method === 'session/prompt') {
        agentNotify(stdout, 'session/update', {
          sessionId: 's1',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        });
        agentNotify(stdout, '_clowder/turn', { sessionId: 's1', type: 'turn_started', nativeTurnId: 1 });
        return agentRespond(stdout, message.id, { stopReason: 'end_turn' });
      }
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();
    await client.newSession('/tmp');
    const unsubscribe = client.onTurnBridgeEvent((event) => events.push(event));
    const stream = client.promptStream('s1', 'hi', { idleStallMs: 0, timeoutMs: 0 });
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value.update.sessionUpdate, 'agent_message_chunk');
    const end = await stream.next();
    assert.equal(end.done, true);
    assert.deepEqual(events, [{ sessionId: 's1', type: 'turn_started', nativeTurnId: 1 }]);
    unsubscribe();
  });

  it('parses native read and turn-end notifications from the private channel', async () => {
    const events = [];
    const { client, agentStdout } = create((message, stdout) => {
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();
    const unsubscribe = client.onTurnBridgeEvent((event) => events.push(event));
    agentNotify(agentStdout, '_clowder/turn', {
      sessionId: 's1',
      type: 'input_read',
      deliveryId: 'd1',
      nativeTurnId: 4,
    });
    agentNotify(agentStdout, '_clowder/turn', {
      sessionId: 's1',
      type: 'turn_ended',
      nativeTurnId: 4,
      reason: 'completed',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, [
      { sessionId: 's1', type: 'input_read', deliveryId: 'd1', nativeTurnId: 4 },
      { sessionId: 's1', type: 'turn_ended', nativeTurnId: 4, reason: 'completed' },
    ]);
    unsubscribe();
  });

  it('treats method-not-found as absent capability, not a turn failure', async () => {
    const { client } = create((message, stdout) => {
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();
    assert.equal(await client.probeTurnBridge(), null);
  });

  it('sends steer/status with the exact delivery and parses the native turn', async () => {
    const calls = [];
    const { client } = create((message, stdout) => {
      calls.push(message);
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      if (message.method === '_clowder/turn/steer')
        return agentRespond(stdout, message.id, { accepted: true, nativeTurnId: 3, deliveryId: 'd1' });
      if (message.method === '_clowder/turn/status')
        return agentRespond(stdout, message.id, { state: 'read', nativeTurnId: 3 });
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();
    assert.deepEqual(
      await client.steerTurn({ sessionId: 's1', deliveryId: 'd1', text: 'only analyze', expectedTurn: 3 }),
      {
        accepted: true,
        nativeTurnId: 3,
        deliveryId: 'd1',
      },
    );
    assert.deepEqual(await client.inspectTurnInput('s1', 'd1'), { state: 'read', nativeTurnId: 3 });
    const steer = calls.find((call) => call.method === '_clowder/turn/steer');
    assert.deepEqual(steer.params, {
      sessionId: 's1',
      deliveryId: 'd1',
      text: 'only analyze',
      expectedTurn: 3,
    });
  });

  it('isolates a throwing turn listener and keeps the readline channel alive', async () => {
    const { client, agentStdout } = create((message, stdout) => {
      if (message.method === 'initialize') return agentRespond(stdout, message.id, INIT_RESULT);
      if (message.method === '_clowder/turn/status') return agentRespond(stdout, message.id, { state: 'unknown' });
      return agentError(stdout, message.id, -32601, 'Method not found');
    });
    await client.initialize();

    const received = [];
    const unsubscribeThrow = client.onTurnBridgeEvent((event) => {
      if (event.type === 'turn_started') throw new Error('owner mismatch');
    });
    const unsubscribeCollect = client.onTurnBridgeEvent((event) => received.push(event));
    const started = { sessionId: 's1', type: 'turn_started', nativeTurnId: 1 };
    assert.doesNotThrow(() =>
      agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: '_clowder/turn', params: started })}\n`),
    );
    assert.deepEqual(received, [{ sessionId: 's1', type: 'turn_started', nativeTurnId: 1 }]);
    const ended = { sessionId: 's1', type: 'turn_ended', nativeTurnId: 1, reason: 'completed' };
    agentStdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: '_clowder/turn', params: ended })}\n`);
    assert.deepEqual(received, [started, ended]);
    // A later RPC response still reaches the same client after the listener failure.
    assert.deepEqual(await client.inspectTurnInput('s1', 'd1'), { state: 'unknown' });
    unsubscribeThrow();
    unsubscribeCollect();
  });
});
