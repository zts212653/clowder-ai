/**
 * AcpHttpStreamClient unit tests using a mock child process and local HTTP server.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpHttpStreamClient } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js'
);

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'http-acp', title: 'HTTP ACP Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

function createMockChild() {
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  const clientStdin = new PassThrough();
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
  return { child, agentStdout };
}

function startJsonRpcServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = await handler(message, res);
    if (response === undefined) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('AcpHttpStreamClient', () => {
  let client = null;
  let server = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
  });

  it('initializes when stdout port discovery line is matched', async () => {
    const seenMethods = [];
    server = await startJsonRpcServer((message) => {
      seenMethods.push(message.method);
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    const result = await client.initialize();

    assert.equal(result.agentInfo.name, 'http-acp');
    assert.deepEqual(seenMethods, ['initialize']);
  });

  it('keeps draining stdout after discovering the HTTP port', async () => {
    server = await startJsonRpcServer((message) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();

    let backpressuredAt = -1;
    for (let i = 0; i < 1000; i++) {
      if (!agentStdout.write(`${'x'.repeat(1024)}\n`)) {
        backpressuredAt = i;
        break;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(backpressuredAt, -1, `stdout stopped draining after chunk ${backpressuredAt}`);
    assert.equal(agentStdout.readableLength, 0);
  });

  it('keeps HTTP request timeouts active until JSON bodies are fully read', async () => {
    let sessionNewStarted = false;

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        sessionNewStarted = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"jsonrpc":"2.0"');
        setTimeout(() => {
          res.destroy();
        }, 1000);
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();

    await assert.rejects(
      () =>
        withTimeout(
          client.httpRequest('session/new', { cwd: '/tmp', mcpServers: [] }, 100),
          500,
          'httpRequest did not settle after the configured timeout',
        ),
      /ACP timeout: session\/new did not respond within 100ms/,
    );
    assert.equal(sessionNewStarted, true);
  });

  it('rejects prompt streams that close before the final JSON-RPC response', async () => {
    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'http-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
            },
          })}\n`,
        );
        res.end();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();
    const events = [];
    let caught = null;
    try {
      for await (const event of client.promptStream(session.sessionId, 'hello')) events.push(event);
    } catch (err) {
      caught = err;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].update.sessionUpdate, 'agent_message_chunk');
    assert.ok(caught, 'Expected truncated prompt stream to reject');
    assert.match(caught.message, /closed before final prompt response/);
  });

  it('responds to id-bearing permission requests on prompt streams', async () => {
    let resolvePermissionResponse;
    const permissionResponseReceived = new Promise((resolve) => {
      resolvePermissionResponse = resolve;
    });
    let capturedPermissionResponse = null;

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-http',
            method: 'session/request_permission',
            params: {
              sessionId: 'http-session',
              options: [
                { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
              ],
            },
          })}\n`,
        );
        permissionResponseReceived.then(() => {
          res.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'http-session',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'approved' } },
              },
            })}\n`,
          );
          res.end(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })}\n`);
        });
        return undefined;
      }
      if (message.id === 'perm-http' && !message.method) {
        capturedPermissionResponse = message;
        res.writeHead(204);
        res.end();
        resolvePermissionResponse();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();
    const events = [];
    let caught = null;
    try {
      for await (const event of client.promptStream(session.sessionId, 'hello', { timeoutMs: 300 })) {
        events.push(event);
      }
    } catch (err) {
      caught = err;
    }

    assert.equal(caught, null, `Permission request should not stall: ${caught?.message}`);
    assert.ok(capturedPermissionResponse, 'client should POST a JSON-RPC response for the permission request');
    assert.equal(capturedPermissionResponse.result?.outcome?.outcome, 'selected');
    assert.equal(capturedPermissionResponse.result?.outcome?.optionId, 'allow_once');
    assert.equal(events.at(-1)?.update?.content?.text, 'approved');
  });

  it('treats 204 agent response acknowledgements as complete', async () => {
    let agentResponsePostSeen = false;

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.id === 'agent-response-ack' && !message.method) {
        agentResponsePostSeen = true;
        res.writeHead(204);
        res.end();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    await withTimeout(
      client.sendAgentResponse(
        { jsonrpc: '2.0', id: 'agent-response-ack', result: {} },
        { timeoutMs: 100, method: 'session/request_permission' },
      ),
      500,
      'sendAgentResponse did not finish after a 204 acknowledgement',
    );
    assert.equal(agentResponsePostSeen, true);
  });

  it('keeps agent response timeouts active until response bodies finish', async () => {
    let agentResponsePostSeen = false;
    let hangingAgentResponse = null;

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.id === 'agent-response-hangs' && !message.method) {
        agentResponsePostSeen = true;
        hangingAgentResponse = res;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();

    try {
      await assert.rejects(
        () =>
          withTimeout(
            client.sendAgentResponse(
              { jsonrpc: '2.0', id: 'agent-response-hangs', result: {} },
              { timeoutMs: 100, method: 'session/request_permission' },
            ),
            500,
            'sendAgentResponse did not settle after the configured timeout',
          ),
        /ACP timeout: session\/request_permission did not respond within 100ms/,
      );
    } finally {
      hangingAgentResponse?.destroy();
    }
    assert.equal(agentResponsePostSeen, true);
  });

  it('times out prompt streams when the permission response POST never completes', async () => {
    let permissionResponsePostSeen = false;

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'perm-http-hangs',
            method: 'session/request_permission',
            params: {
              sessionId: 'http-session',
              options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
            },
          })}\n`,
        );
        return undefined;
      }
      if (message.id === 'perm-http-hangs' && !message.method) {
        permissionResponsePostSeen = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        setTimeout(() => {
          res.destroy();
        }, 1000);
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();
    const result = await withTimeout(
      (async () => {
        const events = [];
        let caught = null;
        try {
          for await (const event of client.promptStream(session.sessionId, 'hello', { timeoutMs: 100 })) {
            events.push(event);
          }
        } catch (err) {
          caught = err;
        }
        return { caught, events };
      })(),
      500,
      'promptStream did not settle after the configured turn timeout',
    );

    assert.equal(permissionResponsePostSeen, true);
    assert.ok(result.caught, 'Expected hanging permission response POST to reject');
    assert.match(
      result.caught.message,
      /ACP timeout: session\/(prompt|request_permission) did not respond within 100ms/,
    );
    assert.ok(
      result.events.some((event) => (event.update ?? event).sessionUpdate === 'permission_pending'),
      'permission_pending should be emitted before the timeout',
    );
  });

  it('sends session/cancel before aborting prompt streams on turn budget timeout', async () => {
    let resolveCancelSeen;
    const cancelSeen = new Promise((resolve) => {
      resolveCancelSeen = resolve;
    });

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        return undefined;
      }
      if (message.method === 'session/cancel') {
        resolveCancelSeen(message);
        res.writeHead(204);
        res.end();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();

    let caught = null;
    try {
      for await (const _event of client.promptStream(session.sessionId, 'hello', { timeoutMs: 100 })) {
        // no-op
      }
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'Expected prompt stream to reject on turn budget timeout');
    assert.match(caught.message, /ACP timeout: session\/prompt did not respond within 100ms/);

    const cancelMessage = await withTimeout(cancelSeen, 300, 'session/cancel was not sent before timeout abort');
    assert.equal(cancelMessage.method, 'session/cancel');
    assert.deepEqual(cancelMessage.params, { sessionId: session.sessionId });
  });

  it('injects capacity signals into zero-event prompt streams', async () => {
    let promptResponse = null;
    let promptRequestId = null;
    let resolvePromptSeen;
    const promptSeen = new Promise((resolve) => {
      resolvePromptSeen = resolve;
    });

    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        promptRequestId = message.id;
        promptResponse = res;
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.flushHeaders();
        resolvePromptSeen();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();
    const iterator = client.promptStream(session.sessionId, 'hello', { timeoutMs: 1000 });
    const firstEventPromise = iterator.next();

    await promptSeen;
    child.stderr.write('MODEL_CAPACITY_EXHAUSTED: No capacity available for model x\n');

    const firstEvent = await withTimeout(
      firstEventPromise,
      300,
      'capacity signal did not unblock the HTTP prompt queue',
    );
    assert.equal(firstEvent.done, false);
    assert.equal(firstEvent.value.update.sessionUpdate, 'provider_capacity_signal');
    assert.match(firstEvent.value.update.message, /MODEL_CAPACITY_EXHAUSTED/);

    promptResponse.end(
      `${JSON.stringify({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } })}\n`,
    );
    const final = await withTimeout(iterator.next(), 300, 'prompt stream did not finish after final response');
    assert.equal(final.done, true);
    assert.equal(final.value, 'end_turn');
  });
});
