import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startSecretMcpProxy } from '../src/secret-mcp-proxy.js';

const dispose: Array<() => Promise<void>> = [];
const fake = () => ['ghp', '_', 'G'.repeat(36)].join('');
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

describe('external MCP transport relay', () => {
  it('does not forward secrets in client notifications or server-initiated messages', async () => {
    const [caller, downstream] = InMemoryTransport.createLinkedPair();
    const [upstream, remote] = InMemoryTransport.createLinkedPair();
    const sentToRemote: unknown[] = [];
    const sentToCaller: unknown[] = [];
    remote.onmessage = (message) => {
      sentToRemote.push(message);
    };
    caller.onmessage = (message) => {
      sentToCaller.push(message);
    };
    await remote.start();
    await caller.start();
    dispose.push(await startSecretMcpProxy(downstream, upstream));
    await caller.send({ jsonrpc: '2.0', method: 'notifications/message', params: { text: fake() } });
    await remote.send({ jsonrpc: '2.0', method: 'notifications/message', params: { text: fake() } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(!JSON.stringify(sentToRemote).includes(fake()));
    assert.ok(!JSON.stringify(sentToCaller).includes(fake()));
  });
  it('preserves tool discovery, executes clean calls, and blocks a secret before the external handler', async () => {
    let executions = 0;
    const remote = new McpServer({ name: 'external-fixture', version: '1' });
    remote.registerTool('browser_input', { inputSchema: { text: z.string() } }, async ({ text }) => {
      executions++;
      return { content: [{ type: 'text' as const, text }] };
    });
    const [proxyUpstream, remoteSide] = InMemoryTransport.createLinkedPair();
    await remote.connect(remoteSide);
    const [clientSide, proxyDownstream] = InMemoryTransport.createLinkedPair();
    // An in-memory transport starts once on both sides; the relay owns its peers.
    const close = await startSecretMcpProxy(proxyDownstream, proxyUpstream);
    dispose.push(close);
    const client = new Client({ name: 'caller-fixture', version: '1' });
    dispose.push(() => client.close());
    await client.connect(clientSide);
    assert.equal((await client.listTools()).tools[0].name, 'browser_input');
    await assert.rejects(client.request({ method: 'fixture/unsupported' }, z.object({})), { code: -32601 });
    const clean = await client.callTool({ name: 'browser_input', arguments: { text: 'hello' } });
    assert.equal((clean.content as Array<{ text: string }>)[0].text, 'hello');
    assert.equal(executions, 1);
    const blocked = await client.callTool({ name: 'browser_input', arguments: { text: fake() } });
    assert.equal(blocked.isError, true);
    assert.equal(executions, 1);
    assert.ok(!JSON.stringify(blocked).includes(fake()));
    await remote.close();
  });
});
