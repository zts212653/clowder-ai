/**
 * AcpClient unit tests using mock child process.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpClient, AcpProtocolError } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js'
);

/** Create a minimal mock child process */
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
      // Close streams to prevent hanging
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

/** Respond async — readline needs an event loop tick to process buffered data */
function agentRespond(agentStdout, id, result) {
  setImmediate(() => agentStdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'));
}

function agentNotify(agentStdout, method, params) {
  setImmediate(() => agentStdout.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'));
}

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'test', title: 'Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

describe('AcpClient', () => {
  let client = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  it('initialize sends protocolVersion and parses response', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    const result = await client.initialize();
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo.name, 'test');
    assert.ok(client.isAlive);
  });

  it('newSession sends cwd and mcpServers', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    let capturedCwd = null;
    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          capturedCwd = msg.params.cwd;
          agentRespond(agentStdout, msg.id, { sessionId: 'sess-456' });
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/my/project',
      spawnFn: () => child,
    });

    await client.initialize();
    const session = await client.newSession();
    assert.equal(session.sessionId, 'sess-456');
    assert.equal(capturedCwd, '/my/project');
  });

  it('promptCollect collects events and returns stopReason', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'sess-789' });
        } else if (msg.method === 'session/prompt') {
          agentNotify(agentStdout, 'session/update', {
            sessionId: 'sess-789',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PONG' } },
          });
          agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();
    await client.newSession();
    const { events, stopReason } = await client.promptCollect('sess-789', 'hello');

    assert.equal(stopReason, 'end_turn');
    assert.ok(events.length >= 1, `Expected >=1 event, got ${events.length}`);
  });

  it('handles protocol errors', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          setImmediate(() =>
            agentStdout.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                error: { code: -32000, message: 'Auth required' },
              }) + '\n',
            ),
          );
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await assert.rejects(
      () => client.initialize(),
      (err) => {
        assert.ok(err instanceof AcpProtocolError);
        assert.equal(err.code, -32000);
        return true;
      },
    );
    // End mock streams to prevent hanging during afterEach cleanup
    agentStdout.end();
  });

  it('P1-1: spawn ENOENT rejects initialize instead of crashing', async () => {
    const ee = new EventEmitter();
    const child = {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: mock.fn(() => {
        child.killed = true;
        return true;
      }),
      on: ee.on.bind(ee),
      once: ee.once.bind(ee),
      removeListener: ee.removeListener.bind(ee),
    };

    client = new AcpClient({
      command: 'definitely-not-a-real-bin-xyz',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        // Simulate what Node does on ENOENT: emit 'error' async
        setImmediate(() => ee.emit('error', new Error('spawn definitely-not-a-real-bin-xyz ENOENT')));
        return child;
      },
    });

    await assert.rejects(
      () => client.initialize(),
      (err) => {
        assert.ok(err.message.includes('ENOENT'));
        return true;
      },
    );
    // Cleanup: end streams
    child.stdout.end();
  });

  it('P1-2: isAlive returns false after child exits naturally', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const ee = child; // child.on is ee.on.bind(ee), we need the real ee to emit exit
    // We need access to the raw EventEmitter to emit exit without kill
    const rawEe = new EventEmitter();
    const childWithRawEe = {
      ...child,
      on: rawEe.on.bind(rawEe),
      once: rawEe.once.bind(rawEe),
      removeListener: rawEe.removeListener.bind(rawEe),
    };

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => childWithRawEe,
    });

    await client.initialize();
    assert.ok(client.isAlive, 'should be alive after initialize');

    // Simulate natural exit (not via kill)
    rawEe.emit('exit', 0, null);
    agentStdout.end();

    assert.ok(!client.isAlive, 'should NOT be alive after natural exit');
  });

  it('P2: custom permission handler is called instead of auto-approve', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const permissionCalls = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
      permissionHandler: (req, respond) => {
        permissionCalls.push(req);
        respond({ optionId: 'deny' });
      },
    });

    await client.initialize();

    // Simulate an agent permission request
    setImmediate(() =>
      agentStdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 'perm-001',
          params: { description: 'Write file', options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
        }) + '\n',
      ),
    );

    // Give the event loop a chance to process
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(permissionCalls.length, 1, 'custom handler should be called');
    assert.equal(permissionCalls[0].params.description, 'Write file');
  });

  it('P1-cloud: throwing permissionHandler does not crash host', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    let errorResponseSent = false;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
        // Capture any error response sent back for the permission request
        if (msg.id === 'perm-boom' && msg.error) {
          errorResponseSent = true;
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
      permissionHandler: () => {
        throw new Error('boom');
      },
    });

    await client.initialize();

    // Feed a permission request — should NOT crash the process
    setImmediate(() =>
      agentStdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 'perm-boom',
          params: { description: 'Dangerous op', options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
        }) + '\n',
      ),
    );

    // Give the event loop a chance to process
    await new Promise((r) => setTimeout(r, 50));

    // The process should still be alive (not crashed)
    assert.ok(client.isAlive, 'host should not crash from handler error');
    // The client should have sent a JSON-RPC error response back to the agent
    assert.ok(errorResponseSent, 'should send JSON-RPC error response when handler throws');
  });

  it('F148: permission response wraps in ACP outcome envelope', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    let capturedResponse = null;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
        // Capture auto-approve response
        if (msg.id === 'perm-acp' && msg.result) {
          capturedResponse = msg.result;
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
      // No permissionHandler → auto-approve path
    });

    await client.initialize();

    setImmediate(() =>
      agentStdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/request_permission',
          id: 'perm-acp',
          params: { description: 'Read file', options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
        }) + '\n',
      ),
    );

    await new Promise((r) => setTimeout(r, 50));

    assert.ok(capturedResponse, 'should have sent a permission response');
    assert.ok(capturedResponse.outcome, 'response must have outcome wrapper');
    assert.equal(capturedResponse.outcome.outcome, 'selected');
    assert.equal(capturedResponse.outcome.optionId, 'allow_once');
  });

  it('promptStream yields events as they arrive and returns stopReason', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'stream-sess' });
        } else if (msg.method === 'session/prompt') {
          // Send 3 notifications with delays, then the response
          agentNotify(agentStdout, 'session/update', {
            sessionId: 'stream-sess',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
          });
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'stream-sess',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
            });
          }, 10);
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'stream-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' World' } },
            });
          }, 20);
          setTimeout(() => {
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 30);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();
    await client.newSession();

    const events = [];
    const gen = client.promptStream('stream-sess', 'hello');
    for await (const event of gen) {
      events.push(event);
    }

    assert.equal(events.length, 3, `Expected 3 events, got ${events.length}`);
    assert.equal(events[0].update.sessionUpdate, 'agent_message_chunk');
    assert.equal(events[0].update.content.text, 'Hello');
    assert.equal(events[1].update.sessionUpdate, 'agent_thought_chunk');
    assert.equal(events[2].update.content.text, ' World');
  });

  it('promptStream filters events by sessionId', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'my-sess' });
        } else if (msg.method === 'session/prompt') {
          // Notification for a DIFFERENT session — should be ignored
          agentNotify(agentStdout, 'session/update', {
            sessionId: 'other-sess',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrong' } },
          });
          // Notification for OUR session
          agentNotify(agentStdout, 'session/update', {
            sessionId: 'my-sess',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'right' } },
          });
          setTimeout(() => {
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 20);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();
    await client.newSession();

    const events = [];
    for await (const event of client.promptStream('my-sess', 'hi')) {
      events.push(event);
    }

    assert.equal(events.length, 1, 'Should only get events for my-sess');
    assert.equal(events[0].update.content.text, 'right');
  });

  it('close kills the process', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();
    assert.ok(client.isAlive);

    await client.close();
    assert.ok(!client.isAlive);
    client = null;
  });

  it('emits capacity signal to registered onCapacity listeners', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();

    let captured = null;
    client.onCapacity((signal) => {
      captured = signal;
    });

    // Simulate stderr from Gemini CLI with 429/capacity error
    child.stderr.write(
      'Attempt 1 failed with status 429. Retrying with backoff... ' +
        'No capacity available for model gemini-3.1-pro-preview on the server\n',
    );
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(captured, 'listener should receive capacity signal');
    assert.match(captured.message, /No capacity available/);
    assert.ok(captured.timestamp > 0);
  });

  it('sends session/cancel when session/prompt times out', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const sentMessages = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        sentMessages.push(msg);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'timeout-sess' });
        }
        // Don't respond to session/prompt — let it timeout
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();
    await client.newSession('/tmp');

    // Use a very short timeout so test doesn't wait 120s
    await assert.rejects(
      () => client.promptCollect('timeout-sess', 'hello', { timeoutMs: 50 }),
      (err) => err.name === 'AcpTimeoutError',
    );

    // Verify session/cancel was sent after timeout
    const cancelMsg = sentMessages.find((m) => m.method === 'session/cancel');
    assert.ok(cancelMsg, 'session/cancel should be sent after prompt timeout');
    assert.equal(cancelMsg.params.sessionId, 'timeout-sess');
  });

  it('offCapacity prevents receiving signals after unregistration', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();

    let captured = null;
    const fn = (signal) => {
      captured = signal;
    };
    client.onCapacity(fn);

    // Signal while registered → captured
    child.stderr.write('No capacity available for model gemini-3.1-pro-preview\n');
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(captured, 'should receive signal while registered');

    // Unregister and reset
    client.offCapacity(fn);
    captured = null;

    // Signal after unregister → NOT captured
    child.stderr.write('No capacity available for model gemini-3.1-pro-preview again\n');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(captured, null, 'should NOT receive signals after offCapacity');
  });

  it('recentCapacitySignal persists even without registered listeners', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        }
      }
    });

    client = new AcpClient({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      spawnFn: () => child,
    });

    await client.initialize();

    // No listener registered — but recentCapacitySignal should still capture
    assert.equal(client.recentCapacitySignal, null, 'initially null');

    child.stderr.write('No capacity available for model gemini-3.1-pro-preview on the server\n');
    await new Promise((r) => setTimeout(r, 10));

    assert.ok(client.recentCapacitySignal, 'should capture signal without listeners');
    assert.match(client.recentCapacitySignal.message, /No capacity available/);
    assert.ok(client.recentCapacitySignal.timestamp > 0);
  });

  // ─── F149: Stream Idle Watchdog Tests ─────────────────────────

  it('F149: idle watchdog injects stream_idle_warning after idle threshold', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'idle-sess' });
        } else if (msg.method === 'session/prompt') {
          // Send one real event, then go silent for longer than idleWarningMs
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'idle-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first chunk' } },
            });
          });
          // Complete after a delay (longer than warning but shorter than stall)
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'idle-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resumed' } },
            });
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 200);
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    for await (const event of client.promptStream('idle-sess', 'hello', {
      idleWarningMs: 50,
      idleStallMs: 500,
    })) {
      events.push(event);
    }

    const warningEvents = events.filter((e) => e.update?.sessionUpdate === 'stream_idle_warning');
    assert.equal(warningEvents.length, 1, `Expected 1 stream_idle_warning, got ${warningEvents.length}`);
    assert.ok(warningEvents[0].update.idleSinceMs >= 50, 'idleSinceMs should be >= warning threshold');
    assert.ok(warningEvents[0].update.eventCount >= 1, 'eventCount should be >= 1');

    // Real events should still be present
    const realEvents = events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk');
    assert.equal(realEvents.length, 2, `Expected 2 real events, got ${realEvents.length}`);
  });

  it('F149: idle watchdog injects stream_idle_stall and terminates stream', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'stall-sess' });
        } else if (msg.method === 'session/prompt') {
          // Send one event, then go completely silent (never complete)
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'stall-sess',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
            });
          });
          // Never send response — simulate full stall
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('stall-sess', 'hello', {
        idleWarningMs: 30,
        idleStallMs: 100,
        timeoutMs: 5000, // Keep outer timeout high so idle stall fires first
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    // Should have warning event before stall
    const warningEvents = events.filter((e) => e.update?.sessionUpdate === 'stream_idle_warning');
    assert.ok(warningEvents.length >= 1, `Expected at least 1 warning, got ${warningEvents.length}`);

    // Should throw with stream idle stall
    assert.ok(thrownError, 'Should throw an error on stall');
    assert.match(thrownError.message, /[Ss]tream idle|STREAM_IDLE/);
  });

  it('F149: idle watchdog does NOT fire before first event (eventCount=0)', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'zero-sess' });
        } else if (msg.method === 'session/prompt') {
          // Delay first event longer than idle thresholds — but watchdog should NOT fire
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'zero-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } },
            });
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 200);
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    for await (const event of client.promptStream('zero-sess', 'hello', {
      idleWarningMs: 50,
      idleStallMs: 100,
    })) {
      events.push(event);
    }

    // No idle events should fire — eventCount was 0 when the threshold passed
    const idleEvents = events.filter(
      (e) => e.update?.sessionUpdate === 'stream_idle_warning' || e.update?.sessionUpdate === 'stream_idle_stall',
    );
    assert.equal(idleEvents.length, 0, `Expected 0 idle events (eventCount=0), got ${idleEvents.length}`);

    // The real event should be present
    const realEvents = events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk');
    assert.equal(realEvents.length, 1, 'Should have 1 real event');
  });

  // ─── pendingTool: suppress stall during MCP tool execution ──

  it('pendingTool: tool_call suppresses stall, resumes watchdog on non-tool event', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const capturedMessages = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        capturedMessages.push(msg);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'tool-sess' });
        } else if (msg.method === 'session/prompt') {
          // 1. Send a tool_call event → enters pendingTool
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'tool-sess',
              update: { sessionUpdate: 'tool_call', content: { type: 'text', text: 'search_evidence' } },
            });
          });
          // 2. Wait past both idleWarningMs and idleStallMs while in pendingTool
          //    (stall should NOT fire)
          // 3. Then send a non-tool event → exits pendingTool, completes
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'tool-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } },
            });
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 250); // Well past idleWarningMs(30) + idleStallMs(100)
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('tool-sess', 'hello', {
        idleWarningMs: 30,
        idleStallMs: 100,
        timeoutMs: 5000,
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    // Should NOT throw — pendingTool suppresses stall
    assert.equal(thrownError, null, `Should not throw during tool wait, got: ${thrownError?.message}`);

    // Should have stream_tool_wait_warning (not stream_idle_warning)
    const toolWaits = events.filter((e) => e.update?.sessionUpdate === 'stream_tool_wait_warning');
    assert.ok(toolWaits.length >= 1, `Expected stream_tool_wait_warning, got ${toolWaits.length}`);

    // Should NOT have stream_idle_warning or stall
    const idleWarnings = events.filter((e) => e.update?.sessionUpdate === 'stream_idle_warning');
    assert.equal(idleWarnings.length, 0, `Expected 0 stream_idle_warning during tool wait, got ${idleWarnings.length}`);

    // Should NOT have sent session/cancel
    const cancelMsgs = capturedMessages.filter((m) => m.method === 'session/cancel');
    assert.equal(cancelMsgs.length, 0, 'Should not send session/cancel during tool wait');

    // Real events present
    const toolEvents = events.filter((e) => e.update?.sessionUpdate === 'tool_call');
    assert.equal(toolEvents.length, 1, 'Should have 1 tool_call event');
    const textEvents = events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk');
    assert.equal(textEvents.length, 1, 'Should have 1 text event after tool completes');
  });

  // ─── Flat format: Gemini CLI v0.35+ sends sessionUpdate at top level ───

  it('pendingTool: flat-format tool_call (no update wrapper) suppresses stall', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'flat-sess' });
        } else if (msg.method === 'session/prompt') {
          // Flat format: sessionUpdate directly on params, no update wrapper
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'flat-sess',
              sessionUpdate: 'tool_call',
              content: { type: 'text', text: 'search_evidence' },
            });
          });
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'flat-sess',
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'done' },
            });
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 250);
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('flat-sess', 'hello', {
        idleWarningMs: 30,
        idleStallMs: 100,
        timeoutMs: 5000,
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    assert.equal(thrownError, null, `Should not stall on flat-format tool_call: ${thrownError?.message}`);
    const toolWaits = events.filter((e) => e.update?.sessionUpdate === 'stream_tool_wait_warning');
    assert.ok(toolWaits.length >= 1, 'Should emit stream_tool_wait_warning for flat-format tool_call');
    const idleWarnings = events.filter((e) => e.update?.sessionUpdate === 'stream_idle_warning');
    assert.equal(idleWarnings.length, 0, 'No stream_idle_warning during flat-format tool wait');
  });

  // ─── Permission notification: Gemini sends request_permission without id ───
  // Gate-based test: mock agent only continues AFTER seeing a valid permission
  // response on stdin. If AcpClient doesn't send one, agent stays silent → stall.

  it('permission notification (no id) is auto-approved and does not block stream', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    let promptId = null;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'perm-sess' });
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          // 1. tool_call → pendingTool=true
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'perm-sess',
              update: { sessionUpdate: 'tool_call', content: { type: 'text', text: 'search' } },
            });
          });
          setTimeout(() => {
            // 2. thought_chunk during tool execution (should NOT reset pendingTool)
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'perm-sess',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '{"limit":20}' } },
            });
            // 3. Permission notification (no id!) — should be auto-approved
            const permNotif = JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/request_permission',
              params: {
                sessionId: 'perm-sess',
                options: [
                  { optionId: 'proceed_always', name: 'Always Allow', kind: 'allow_always' },
                  { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
                ],
              },
            });
            agentStdout.push(permNotif + '\n');
          }, 30);
        } else if (
          // GATE: mock agent only continues after seeing a valid permission response.
          // If AcpClient doesn't send one, agent stays silent → stall → test fails.
          !msg.method &&
          msg.id?.toString().startsWith('synth-perm-') &&
          msg.result?.outcome?.outcome === 'selected'
        ) {
          // Permission response accepted — now continue
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'perm-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
            });
            agentRespond(agentStdout, promptId, { stopReason: 'end_turn' });
          });
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('perm-sess', 'hello', {
        idleWarningMs: 60,
        idleStallMs: 500,
        timeoutMs: 5000,
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    assert.equal(thrownError, null, `Should not stall — permission gate not unlocked: ${thrownError?.message}`);

    // Stream should have completed with real events (gate was opened)
    const msgChunks = events.filter((e) => e.update?.sessionUpdate === 'agent_message_chunk');
    assert.ok(msgChunks.length >= 1, 'Agent must continue after permission response (gate-based)');

    // Permission notification should NOT appear in stream events
    const permEvents = events.filter((e) => e.options || (e.update && !e.update.sessionUpdate));
    assert.equal(permEvents.length, 0, 'Permission notification should not pollute stream events');
  });

  // ─── permission_pending suppresses stall even without prior tool_call ───
  // Runtime scenario: thought_chunk → request_permission (no tool_call first)

  it('permission notification injects permission_pending to suppress stall', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    let promptId = null;

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'perm-stall-sess' });
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          // 1. thought_chunk (NOT tool_call) — pendingTool stays false
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'perm-stall-sess',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } },
            });
          });
          setTimeout(() => {
            // 2. Permission notification (no id, no prior tool_call)
            agentStdout.push(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'session/request_permission',
                params: {
                  sessionId: 'perm-stall-sess',
                  options: [
                    { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
                    { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
                  ],
                  toolCall: { toolCallId: 'shell-1', status: 'pending', title: 'echo hello' },
                },
              }) + '\n',
            );
          }, 20);
          // 3. Wait past stall threshold, then complete
          // If permission_pending doesn't suppress stall, this will never be reached
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'perm-stall-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
            });
            agentRespond(agentStdout, promptId, { stopReason: 'end_turn' });
          }, 250);
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('perm-stall-sess', 'hello', {
        idleWarningMs: 60,
        idleStallMs: 200,
        timeoutMs: 5000,
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    assert.equal(thrownError, null, `Stall should be suppressed during permission wait: ${thrownError?.message}`);
    // permission_pending synthetic event should be in stream
    const permPending = events.filter((e) => e.sessionUpdate === 'permission_pending');
    assert.ok(permPending.length >= 1, 'permission_pending synthetic event should be emitted');
    // tool_wait_warning should fire (pendingTool was set by permission_pending)
    const toolWaits = events.filter((e) => e.update?.sessionUpdate === 'stream_tool_wait_warning');
    assert.ok(toolWaits.length >= 1, 'Tool wait warning should fire during permission wait');
  });

  // ─── thought_chunk should not reset pendingTool during active tool execution ───

  it('agent_thought_chunk during tool_call does not reset pendingTool', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'thought-tool-sess' });
        } else if (msg.method === 'session/prompt') {
          // tool_call → thought_chunk → (wait past stall) → complete
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'thought-tool-sess',
              update: { sessionUpdate: 'tool_call', content: { type: 'text', text: 'web_search' } },
            });
          });
          setTimeout(() => {
            // Thought chunk DURING tool execution — should not reset pendingTool
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'thought-tool-sess',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'processing' } },
            });
          }, 10);
          // Complete well after stall threshold
          setTimeout(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'thought-tool-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'result' } },
            });
            agentRespond(agentStdout, msg.id, { stopReason: 'end_turn' });
          }, 250);
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    const events = [];
    let thrownError = null;
    try {
      for await (const event of client.promptStream('thought-tool-sess', 'hello', {
        idleWarningMs: 30,
        idleStallMs: 100,
        timeoutMs: 5000,
      })) {
        events.push(event);
      }
    } catch (err) {
      thrownError = err;
    }

    // Should NOT stall — thought_chunk doesn't reset pendingTool during tool execution
    assert.equal(thrownError, null, `Should not stall: ${thrownError?.message}`);
    const toolWaits = events.filter((e) => e.update?.sessionUpdate === 'stream_tool_wait_warning');
    assert.ok(toolWaits.length >= 1, 'Should emit tool_wait_warning (pendingTool stayed true through thought_chunk)');
  });

  // ─── P1 fixes from gpt52 review ─────────────────────────────

  it('F149-P1: idle stall sends session/cancel to terminate upstream', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const capturedMessages = [];

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        capturedMessages.push(msg);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'cancel-sess' });
        } else if (msg.method === 'session/prompt') {
          // Send one event then go silent
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'cancel-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
            });
          });
          // Never complete — force idle stall
        } else if (msg.method === 'session/cancel') {
          // After cancel, agent responds to the pending prompt (if stream still open)
          const promptMsg = capturedMessages.find((m) => m.method === 'session/prompt');
          if (promptMsg && agentStdout.writable) {
            setImmediate(() => {
              if (agentStdout.writable) {
                agentRespond(agentStdout, promptMsg.id, { stopReason: 'cancelled' });
              }
            });
          }
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    try {
      for await (const _ of client.promptStream('cancel-sess', 'hello', {
        idleWarningMs: 30,
        idleStallMs: 80,
        timeoutMs: 5000,
      })) {
        // drain
      }
    } catch {
      // expected AcpStreamIdleError
    }

    // P1: session/cancel MUST be sent when idle stall fires
    const cancelMsgs = capturedMessages.filter((m) => m.method === 'session/cancel');
    assert.equal(cancelMsgs.length, 1, `Expected 1 session/cancel, got ${cancelMsgs.length}`);
    assert.equal(cancelMsgs[0].params.sessionId, 'cancel-sess');
  });

  it('F149-P1: stall fires at ~idleStallMs total idle (not warning + stall)', async () => {
    const { child, clientStdin, agentStdout } = createMockChild();
    const originalSetTimeout = globalThis.setTimeout;
    const scheduledDelays = [];
    globalThis.setTimeout = (callback, delay, ...args) => {
      if (delay === 50 || delay === 70 || delay === 120) {
        scheduledDelays.push(delay);
      }
      return originalSetTimeout(callback, delay, ...args);
    };

    clientStdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          agentRespond(agentStdout, msg.id, INIT_RESULT);
        } else if (msg.method === 'session/new') {
          agentRespond(agentStdout, msg.id, { sessionId: 'timing-sess' });
        } else if (msg.method === 'session/prompt') {
          setImmediate(() => {
            agentNotify(agentStdout, 'session/update', {
              sessionId: 'timing-sess',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chunk' } },
            });
          });
          // Never complete
        }
      }
    });

    client = new AcpClient({ command: 'fake', args: [], cwd: '/tmp', spawnFn: () => child });
    await client.initialize();
    await client.newSession();

    let thrownError = null;
    try {
      for await (const _ of client.promptStream('timing-sess', 'hello', {
        idleWarningMs: 50,
        idleStallMs: 120, // Total ~120ms, NOT 50+120=170ms
        timeoutMs: 5000,
      })) {
        // drain
      }
    } catch (err) {
      thrownError = err;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.ok(thrownError, 'Should throw AcpStreamIdleError');
    // With correct implementation, the stall timer scheduled after the warning
    // uses the remaining delay (120 - 50 = 70). The regression scheduled another
    // full 120ms after warning, which is deterministic to detect without relying
    // on wall-clock elapsed time under full-suite CPU load.
    assert.deepEqual(
      scheduledDelays.slice(-2),
      [50, 70],
      `Idle watchdog should schedule warning then remaining stall delay, got ${scheduledDelays.join(', ')}`,
    );
  });
});
