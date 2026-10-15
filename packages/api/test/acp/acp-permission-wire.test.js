import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';

const wait = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('wire condition timeout');
};
const init = { protocolVersion: 1, authMethods: [], agentInfo: { name: 'proof', version: '1' }, agentCapabilities: {} };
const permission = (id, sessionId, kind = 'allow_once') => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: { sessionId, options: [{ optionId: 'allow', kind, name: 'Allow' }] },
});
for (const Client of [AcpClient, AcpHttpStreamClient])
  test(`${Client.name} wire: late cancelled session cannot approve, B keeps authority, numeric ID survives`, async () => {
    const ee = new EventEmitter();
    const stdout = new PassThrough(),
      stderr = new PassThrough(),
      stdin = new PassThrough();
    const child = {
      pid: 1234,
      stdout,
      stderr,
      stdin,
      killed: false,
      on: ee.on.bind(ee),
      once: ee.once.bind(ee),
      kill() {
        this.killed = true;
        ee.emit('exit', 0, null);
        stdout.end();
        return true;
      },
    };
    const replies = [],
      handlers = [],
      prompts = new Map(),
      httpStreams = new Map();
    let pendingReply, server;
    function send(msg, streamSession = 'B') {
      const data = `${JSON.stringify(msg)}\n`;
      if (Client === AcpClient) stdout.write(data);
      else httpStreams.get(streamSession).write(data);
    }
    function handle(msg, res) {
      if (!msg.method) {
        replies.push(msg);
        return null;
      }
      if (msg.method === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: init };
      if (msg.method === 'session/prompt') {
        prompts.set(msg.params.sessionId, msg.id);
        if (res) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write('\n');
          httpStreams.set(msg.params.sessionId, res);
        }
        return undefined;
      }
      return { jsonrpc: '2.0', id: msg.id, result: {} };
    }
    const config = {
      command: 'proof',
      args: [],
      cwd: process.cwd(),
      permissionTimeoutMs: 1000,
      permissionHandler(req, respond) {
        handlers.push(req.id);
        if (req.id === 6) {
          respond({ optionId: 'allow' });
          client.cancelSession('A');
          return;
        }
        if (req.id === 1) pendingReply = respond;
        else respond({ optionId: 'allow' });
      },
    };
    if (Client === AcpClient) {
      config.spawnFn = () => child;
      stdin.on('data', (chunk) => {
        for (const line of chunk.toString().trim().split('\n')) {
          const result = handle(JSON.parse(line));
          if (result) send(result);
        }
      });
    } else {
      server = createServer(async (req, res) => {
        const parts = [];
        for await (const chunk of req) parts.push(chunk);
        const msg = JSON.parse(Buffer.concat(parts).toString());
        const result = handle(msg, res);
        if (result === undefined) return;
        if (result === null) {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(200);
          res.end(JSON.stringify(result));
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      config.spawnFn = () => {
        setImmediate(() => stdout.write(`Listening on port ${server.address().port}\n`));
        return child;
      };
    }
    const client = new Client(config);
    try {
      await client.initialize();
      const drain = (session) =>
        (async () => {
          try {
            for await (const _event of client.promptStream(session, 'synthetic', {
              timeoutMs: 2000,
              idleStallMs: 2000,
            })) {
            }
          } catch (error) {
            return error;
          }
        })();
      const a = drain('A'),
        b = drain('B');
      await wait(() => prompts.size === 2);
      send(permission(1, 'A'), 'A');
      await wait(() => pendingReply);
      send(permission(6, 'A'));
      await wait(() => replies.some((reply) => reply.id === 6));
      assert.equal(replies.find((reply) => reply.id === 6).result.outcome.outcome, 'cancelled');
      pendingReply({ optionId: 'allow' });
      send(permission(8, 'A'));
      send(permission(7, 'B'));
      send(permission(9, 'B', { toString: null }));
      await wait(() => replies.some((reply) => reply.id === 9));
      assert.equal(replies.find((reply) => reply.id === 8).result.outcome.outcome, 'cancelled');
      assert.equal(replies.find((reply) => reply.id === 7).result.outcome.optionId, 'allow');
      assert.equal(typeof replies.find((reply) => reply.id === 7).id, 'number');
      assert.equal(replies.find((reply) => reply.id === 9).result.outcome.outcome, 'cancelled');
      assert.deepEqual(handlers, [1, 6, 7]);
      send({ jsonrpc: '2.0', id: prompts.get('B'), result: { stopReason: 'end_turn' } });
      await b;
      await a;
      await assert.rejects(client.promptStream('A', 'cannot reopen cancelled connection').next(), /binding retired/);
      assert.equal(prompts.size, 2);
      if (Client === AcpClient) {
        const iterator = client.promptStream('C', 'early return');
        const first = iterator.next();
        await wait(() => prompts.has('C'));
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'C',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
          },
        });
        await first;
        await iterator.return();
        send(permission(12, 'C'));
        await wait(() => replies.some((reply) => reply.id === 12));
        assert.equal(replies.find((reply) => reply.id === 12).result.outcome.outcome, 'cancelled');
        await assert.rejects(client.promptStream('C', 'early return cannot reopen').next(), /binding retired/);
        assert.deepEqual(handlers, [1, 6, 7]);
        send(permission(10, 'B'));
        await wait(() => replies.some((reply) => reply.id === 10));
        assert.equal(replies.find((reply) => reply.id === 10).result.outcome.outcome, 'cancelled');
        assert.deepEqual(handlers, [1, 6, 7]);
      }
    } finally {
      await client.close();
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
