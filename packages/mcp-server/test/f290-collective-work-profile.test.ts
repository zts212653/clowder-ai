import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { COLLECTIVE_WORK_TOOLS } from '../../api/src/domains/cats/services/agents/invocation/tool-execution-policy.js';
import { CANONICAL_TOOL_REGISTRY } from '../src/canonical-server-tools.js';
import { parseToolsetEnv, registerFullToolset, type ToolsetEnv } from '../src/server-toolsets.js';

test('the explicit private Work server profile is recognized and does not inherit another surface', () => {
  const env = parseToolsetEnv({
    CAT_CAFE_MCP_PROFILE: 'collective-work',
    CAT_CAFE_READONLY: 'true',
    CAT_CAFE_AGENT_KEY_SECRET: 'fixture',
    CAT_CAFE_READONLY_AGENT_KEY_UNION: 'true',
  });
  assert.equal(env.collectiveWork, true);
  assert.equal(env.participation, false);
});

test('actual registered MCP Work surface equals the existing API permission set and rejects direct shell RPC', async () => {
  const server = new McpServer({ name: 'f290-private-work-fixture', version: '1' });
  const client = new Client({ name: 'direct-rpc-fixture', version: '1' });
  const env = { collectiveWork: true, readonly: false } as ToolsetEnv;
  const previousFetch = globalThis.fetch;
  let transports = 0;
  try {
    globalThis.fetch = async () => {
      transports += 1;
      throw new Error('Fixture prohibits callback/network IO');
    };
    registerFullToolset(server, env);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const expected = CANONICAL_TOOL_REGISTRY.filter((tool) => COLLECTIVE_WORK_TOOLS.has(tool.name))
      .map((tool) => tool.name)
      .sort();
    assert.equal(expected.length, 12, 'two native credential callbacks are not MCP declarations');
    assert.deepEqual(names, expected, 'server and API permission definitions cannot drift');
    for (const name of [
      'cat_cafe_shell_exec',
      'cat_cafe_get_thread_context',
      'cat_cafe_collective_accept_work',
      'cat_cafe_collective_continue_work',
      'cat_cafe_workflow_sop',
    ]) {
      const denied = await client.callTool({ name, arguments: {} });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied.content), /not found|Unknown tool/i);
    }
    assert.equal(transports, 0, 'forbidden tools are absent before any callback or command runs');
  } finally {
    globalThis.fetch = previousFetch;
    await client.close();
    await server.close();
  }
});
