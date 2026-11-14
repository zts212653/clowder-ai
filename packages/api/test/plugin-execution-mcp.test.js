import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { currentPluginCallContext, withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { executionFixture } from './helpers/module-execution-fixture.js';

const moduleSource = `
import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
import { threadId } from 'node:worker_threads';
export default { create() { return { start(host) { return {
  actions: { inspect: async () => ({ threadId, caller: await host.config.get('CALLER') }) }, stop() {}
}; } }; } };
export function createServer(client) {
  const server = new Server({name:'execution-fixture',version:'1'}, {capabilities:{tools:{}}});
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const value=await client.invoke(request.params.name, request.params.arguments, {
      signal:extra.signal, _meta:request.params._meta
    });
    return {content:[{type:'text',text:JSON.stringify(value)}]};
  });
  return server;
}
`;

async function fixture(t, invoke) {
  const f = await executionFixture(t, moduleSource, {
    configuration: [{ key: 'CALLER', label: 'Caller', kind: 'string', required: false }],
    readConfig: async () => currentPluginCallContext('instance')?.catId ?? 'background',
    manifest: {
      contractVersion: '0.3.2-candidate.0',
      features: [
        {
          id: 'main',
          name: 'Main',
          resources: [],
          contributions: [{ type: 'mcp', id: 'ordinary' }],
          capabilities: ['plugin.state.get', 'plugin.state.set'],
        },
      ],
      contributions: [
        {
          type: 'mcp',
          id: 'ordinary',
          runtime: { transport: 'stdio', entrypoint: 'dist/plugin.js' },
          sharedFactory: { module: 'dist/plugin.js', export: 'createServer' },
        },
      ],
    },
  });
  await f.runtime.start('instance', f.record);
  const factory = await f.runtime.resolveMcpFactory('instance', 'ordinary');
  const server = factory({ invoke: (...args) => invoke(f, ...args) });
  const client = new Client({ name: 'real-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { ...f, client, server };
}

test('a real MCP SDK request enters the worker and keeps authenticated Host context across its callback', async (t) => {
  const f = await fixture(t, (host, method, params) =>
    withPluginCallContext(
      'instance',
      {
        catId: 'codex61-sol',
        userId: 'owner',
        threadId: 'fixture-thread',
        invocationId: 'fixture-invocation',
        ownerAuthProvenance: 'user_message',
        assertCurrent: async () => {},
      },
      () => host.runtime.invoke('instance', method, params),
    ),
  );
  const result = await f.client.callTool({ name: 'inspect', arguments: {} });
  const value = JSON.parse(result.content[0].text);
  assert.ok(value.threadId > 0);
  assert.equal(value.caller, 'codex61-sol');
  await f.runtime.stop('instance', 'owner-stop');
  await assert.rejects(f.client.callTool({ name: 'inspect', arguments: {} }));
});

test('MCP cancellation reaches the in-flight Host action through the real SDK transport', async (t) => {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const f = await fixture(t, async (_host, _method, _params, call) => {
    entered.resolve();
    await new Promise((resolve) => {
      call.signal.addEventListener('abort', resolve, { once: true });
      if (call.signal.aborted) resolve();
    });
    aborted.resolve();
    call.signal.throwIfAborted();
  });
  const cancellation = new AbortController();
  const pending = f.client.callTool({ name: 'held', arguments: {} }, undefined, { signal: cancellation.signal });
  pending.catch(() => {});
  await entered.promise;
  cancellation.abort();
  await assert.rejects(pending);
  await aborted.promise;
});
