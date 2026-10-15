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
export async function imageFixture(
  transport,
  cwd,
  {
    image = true,
    resumeEmpty = false,
    busy = false,
    onPrompt,
    promptResult = { stopReason: 'end_turn' },
    initializeResult,
    sessionResult,
    configResult,
    executionResult,
    agentPackets = [],
    packetTransform = (packets) => packets,
    beforeResponse = () => {},
  } = {},
) {
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
    if (message.id == null || typeof message.method !== 'string') return [];
    let result = {};
    if (message.method === 'initialize')
      result = initializeResult ?? {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'synthetic', title: 'Synthetic', version: '1' },
        agentCapabilities: { loadSession: true, promptCapabilities: image === null ? {} : { image } },
      };
    if (message.method === 'session/new') result = { sessionId: `fresh-${++fresh}`, ...sessionResult };
    if (message.method === 'session/load' || message.method === 'session/resume')
      result = { sessionId: message.params.sessionId, ...sessionResult };
    if (message.method === 'session/set_config_option') result = configResult ?? {};
    if (message.method === '_clowder/v1/execution/read') result = executionResult ?? {};
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
      const reply = {
        jsonrpc: '2.0',
        id: message.id,
        result: typeof promptResult === 'function' ? promptResult(message) : promptResult,
      };
      if (resumeEmpty && message.params.sessionId === 'existing') return [reply];
      return [
        ...agentPackets,
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
        const message = JSON.parse(line);
        const packets = packetTransform(responses(message), message);
        Promise.resolve(beforeResponse(message)).then(() =>
          setImmediate(() => packets.forEach((packet) => stdout.write(`${JSON.stringify(packet)}\n`))),
        );
      }
    });
  else {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      res.setHeader('Content-Type', 'application/x-ndjson');
      const message = JSON.parse(body);
      const packets = packetTransform(responses(message), message);
      await beforeResponse(message);
      for (const packet of packets) res.write(`${JSON.stringify(packet)}\n`);
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
  let initialized;
  try {
    initialized = await client.initialize();
  } catch (error) {
    await client.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    throw error;
  }
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
