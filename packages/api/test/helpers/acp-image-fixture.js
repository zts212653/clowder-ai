import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { AcpClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { AcpHttpStreamClient } from '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js';

export const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ10AAAAASUVORK5CYII=',
  'base64',
);

/** Actual client transports, simulated agents. No native executable/authentication. */
export async function imageFixture(transport, cwd, { image = true, resumeEmpty = false, busy = false, onPrompt } = {}) {
  const captured = [];
  let fresh = 0;
  let attempts = 0;
  const emitter = new EventEmitter();
  const stdin = new PassThrough(),
    stdout = new PassThrough(),
    stderr = new PassThrough();
  const child = {
    pid: 12345,
    stdin,
    stdout,
    stderr,
    killed: false,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    kill() {
      child.killed = true;
      stdout.end();
      stderr.end();
      emitter.emit('exit', 0, null);
      return true;
    },
  };
  function responses(message) {
    captured.push(message);
    if (!message.id) return [];
    let result = {};
    if (message.method === 'initialize')
      result = {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'synthetic', title: 'Synthetic', version: '1' },
        agentCapabilities: { loadSession: true, promptCapabilities: image === null ? {} : { image } },
      };
    if (message.method === 'session/new') result = { sessionId: `fresh-${++fresh}` };
    if (message.method === 'session/load') result = { sessionId: message.params.sessionId };
    if (message.method === 'session/prompt') {
      onPrompt?.(message);
      if (busy && attempts++ === 0)
        return [
          {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32600, message: 'turn.agent_busy', data: { code: 'turn.agent_busy' } },
          },
        ];
      const reply = { jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } };
      if (resumeEmpty && message.params.sessionId === 'existing') return [reply];
      return [
        {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: message.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic reply' } },
          },
        },
        reply,
      ];
    }
    return [{ jsonrpc: '2.0', id: message.id, result }];
  }
  let server, port;
  if (transport === 'stdio')
    stdin.on('data', (chunk) => {
      for (const line of chunk.toString().trim().split('\n')) {
        const packets = responses(JSON.parse(line));
        setImmediate(() => packets.forEach((packet) => stdout.write(`${JSON.stringify(packet)}\n`)));
      }
    });
  else {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/x-ndjson');
      for (const packet of responses(JSON.parse(body))) res.write(`${JSON.stringify(packet)}\n`);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }
  const Client = transport === 'stdio' ? AcpClient : AcpHttpStreamClient;
  const client = new Client({
    command: 'synthetic-no-process',
    args: [],
    cwd,
    spawnFn() {
      if (port) setImmediate(() => stdout.write(`Listening on port ${port}\n`));
      return child;
    },
  });
  const initialized = await client.initialize();
  return {
    client,
    initialized,
    captured,
    async close() {
      await client.close();
      if (server) await new Promise((resolve) => server.close(resolve));
    },
  };
}
