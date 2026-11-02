import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/index.js';
import { useInvocationAuth } from './helpers/invocation-auth.js';

test('tools/list preserves an exact canonical lookup after a client replaces every tool name', async (t) => {
  useInvocationAuth(t);
  const apiUrl = process.env.CAT_CAFE_API_URL;
  delete process.env.CAT_CAFE_API_URL;
  t.after(() => {
    if (apiUrl === undefined) delete process.env.CAT_CAFE_API_URL;
    else process.env.CAT_CAFE_API_URL = apiUrl;
  });
  const server = createServer();
  const client = new Client({ name: 'opaque-tool-name-consumer', version: '1' });
  const [consumer, provider] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(provider), client.connect(consumer)]);
    const listed = (await client.listTools()).tools;
    assert.ok(listed.length > 0);
    const metadata = listed.map((tool, index) => ({ name: `opaque_${index}`, description: tool.description }));
    for (const [index, tool] of listed.entries()) {
      const canonical = tool.name;
      const matches = metadata.filter(
        (entry) => entry.name === canonical || entry.description?.startsWith(`MCP tool: ${canonical}. `),
      );
      assert.equal(matches.length, 1, `${canonical}: exact metadata lookup must be unique after client renaming`);
      assert.equal(matches[0]?.name, `opaque_${index}`);
      assert.ok(
        tool.description?.slice(`MCP tool: ${canonical}. `.length).trim(),
        'keep the existing routing contract',
      );
    }
    assert.deepEqual((await client.listTools()).tools, listed, 'listing does not accumulate canonical prefixes');
  } finally {
    await client.close();
    await server.close();
  }
});
