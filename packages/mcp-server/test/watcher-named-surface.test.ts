import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { parseToolsetEnv, registerFullToolset } from '../src/server-toolsets.js';

test('ordinary named surface clears the inherited bounded protocol and registers only its real tools', async () => {
  const names = ['cat_cafe_get_thread_context', 'cat_cafe_read_file_slice'];
  const env = parseToolsetEnv({
    CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(names),
    CAT_CAFE_WATCHER_TOOL_NAMES: '',
  });
  assert.equal(env.watcher, false, 'ordinary context must not enter the old bounded admission path');
  const server = new McpServer({ name: 'named-surface-proof', version: '1' });
  registerFullToolset(server, env);
  const client = new Client({ name: 'named-surface-client', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), names.sort());
  } finally {
    await client.close();
    await server.close();
  }
});

test('clearing a bounded marker never accepts missing, invalid, or conflicting named policies', () => {
  assert.throws(() => parseToolsetEnv({ CAT_CAFE_WATCHER_TOOL_NAMES: '' }));
  assert.throws(() => parseToolsetEnv({ CAT_CAFE_ALLOWED_TOOL_NAMES: '', CAT_CAFE_WATCHER_TOOL_NAMES: '' }));
  assert.throws(() =>
    parseToolsetEnv({ CAT_CAFE_ALLOWED_TOOL_NAMES: '["not_a_tool"]', CAT_CAFE_WATCHER_TOOL_NAMES: '' }),
  );
  assert.throws(() => parseToolsetEnv({ CAT_CAFE_ALLOWED_TOOL_NAMES: '[]', CAT_CAFE_WATCHER_TOOL_NAMES: '[]' }));
  const denied = parseToolsetEnv({ CAT_CAFE_ALLOWED_TOOL_NAMES: '[]', CAT_CAFE_WATCHER_TOOL_NAMES: '' });
  assert.deepEqual(denied.allowedToolNames, []);
  assert.equal(denied.watcher, false);
  assert.equal(parseToolsetEnv({ CAT_CAFE_WATCHER_TOOL_NAMES: '[]' }).watcher, true);
});
