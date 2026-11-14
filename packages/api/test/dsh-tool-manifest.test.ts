import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dshDefinitionOnlyServers, readDshToolManifest } from '../src/routes/dsh-tool-manifest.js';

test('independent definition sources are read concurrently while their manifest order stays stable', async (t) => {
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => originalTimeout(1_500));
  const waiting: (() => void)[] = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') return response.writeHead(405).end();
    let text = '';
    for await (const part of request) text += part;
    const message = JSON.parse(text) as { id?: number; method: string };
    if (message.method === 'tools/call') calls += 1;
    if (message.id === undefined) return response.writeHead(202).end();
    if (message.method === 'tools/list') {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2)
          waiting.forEach((release) => {
            release();
          });
      });
    }
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: request.url?.includes('first') ? 'first' : 'second', inputSchema: { type: 'object' } }] };
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sources = ['first', 'second'].map((name) => ({
    name,
    type: 'http' as const,
    url: `http://127.0.0.1:${address.port}/${name}`,
    headers: [],
  }));
  const manifest = await readDshToolManifest(sources, process.cwd());
  assert.deepEqual(
    manifest.servers.map(({ name, tools }) => [name, tools[0]?.name]),
    [
      ['first', 'first'],
      ['second', 'second'],
    ],
  );
  assert.equal(calls, 0);
});

test('the check reads every tools/list page, retains schema and namespace, and detects schema-only changes', async (t) => {
  const cursors: unknown[] = [];
  let businessCalls = 0;
  let pattern = '^collective\\-attachment\\:';
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const part of request) text += part;
    const message = JSON.parse(text) as { id?: number; method: string; params?: { cursor?: string } };
    if (message.method === 'tools/call') businessCalls += 1;
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : message.params?.cursor === 'page2'
          ? {
              tools: [
                {
                  name: 'attachment',
                  inputSchema: { type: 'object', properties: { ref: { type: 'string', pattern } } },
                },
              ],
            }
          : {
              tools: [
                {
                  name: 'first',
                  inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } } },
                },
              ],
              nextCursor: 'page2',
            };
    if (message.method === 'tools/list') cursors.push(message.params?.cursor);
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const descriptor = {
    type: 'http' as const,
    name: 'original-server-name',
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: [],
  };
  const old = await readDshToolManifest([descriptor], process.cwd());
  assert.deepEqual(cursors, [undefined, 'page2']);
  assert.equal(old.servers[0]?.name, descriptor.name);
  assert.deepEqual(
    old.servers[0]?.tools.map((tool) => tool.name),
    ['first', 'attachment'],
  );
  assert.equal(JSON.stringify(old.servers).includes(JSON.stringify(pattern)), true);
  pattern = '^collective-attachment:';
  const current = await readDshToolManifest([descriptor], process.cwd());
  assert.notEqual(current.hash, old.hash, 'plugin schema changes invalidate old success and failure facts');
  const directory = mkdtempSync(join(tmpdir(), 'dsh-definition-only-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const projected = dshDefinitionOnlyServers(current, directory)[0]!;
  assert.ok('command' in projected);
  const client = new Client({ name: 'definition-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: projected.command, args: projected.args }));
  assert.deepEqual((await client.listTools()).tools, current.servers[0]?.tools);
  const denied = await client.callTool({ name: 'first', arguments: { count: 1 } });
  assert.equal(denied.isError, true);
  assert.equal(businessCalls, 0, 'definition-only checks never forward actions to the source');
});

[
  { name: 'each admitted server gets its own timeout budget', sources: 2, pages: 1, totalExpires: false, fails: false },
  { name: 'one server cannot reset its timeout between pages', sources: 1, pages: 2, totalExpires: false, fails: true },
  {
    name: 'the complete manifest retains a bounded total deadline',
    sources: 2,
    pages: 2,
    totalExpires: true,
    fails: true,
  },
].forEach(({ name, sources, pages, totalExpires, fails }) =>
  test(name, async (t) => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, 'timeout', (budget) =>
      timeout(budget === 30_000 ? (totalExpires ? 1000 : 30_000) : totalExpires ? 10_000 : 1000),
    );
    let businessCalls = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      let text = '';
      for await (const part of request) text += part;
      const message = JSON.parse(text) as { id?: number; method: string; params?: { cursor?: string } };
      if (message.method === 'tools/call') businessCalls += 1;
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === 'tools/list') await new Promise((resolve) => setTimeout(resolve, 650));
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'fixture', version: '1' },
            }
          : {
              tools: [{ name: 'read', inputSchema: { type: 'object' } }],
              ...(pages === 2 && !message.params?.cursor ? { nextCursor: 'page2' } : {}),
            };
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const names = ['first', 'second'].slice(0, sources);
    const manifest = readDshToolManifest(
      names.map((name) => ({
        type: 'http' as const,
        name,
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: [],
      })),
      process.cwd(),
    );
    if (fails) await assert.rejects(manifest, /timeout/i);
    else
      assert.deepEqual(
        (await manifest).servers.map((source) => source.name),
        names,
      );
    assert.equal(businessCalls, 0);
  }),
);
