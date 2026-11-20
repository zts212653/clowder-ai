import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CANONICAL_TOOL_REGISTRY } from '@cat-cafe/mcp-server/dist/canonical-server-tools.js';
import { parseToolsetEnv } from '@cat-cafe/mcp-server/dist/server-toolsets.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { watcherPanelToolPolicy } from '../dist/domains/concierge/watcher/panel/watcher-panel-policy.js';

test('ordinary watcher launch has a concrete tool policy with file, thread and memory readers', () => {
  const policy = watcherPanelToolPolicy();
  for (const name of [
    'cat_cafe_read_file_slice',
    'cat_cafe_get_thread_context',
    'cat_cafe_read_memory',
    'cat_cafe_search_evidence',
    'cat_cafe_watcher_nudge',
    'cat_cafe_remember',
  ])
    assert.ok(policy.allowedToolNames?.includes(name), `missing real consumer ${name}`);
  for (const name of ['cat_cafe_shell_exec', 'cat_cafe_post_message', 'cat_cafe_audio_capture_start'])
    assert.equal(policy.allowedToolNames.includes(name), false, name);
  const service = new CodexAgentService({ catId: 'codex', model: 'fixture', carrierMode: 'app_server' });
  assert.equal(service.supportsToolExecutionPolicy(policy), true);
});

test(
  'actual MCP processes expose exactly the selected readers and can read a repository file',
  { timeout: 30000 },
  async () => {
    const policy = watcherPanelToolPolicy();
    const root = mkdtempSync(join(tmpdir(), 'watcher-mcp-read-'));
    const path = join(root, 'source.ts');
    writeFileSync(path, 'export const visibleLine = 42;\n');
    const listed = [];
    try {
      for (const family of ['collab', 'memory']) {
        const client = new Client({ name: 'watcher-surface-test', version: '1' });
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve(`../mcp-server/dist/${family}.js`)],
          env: {
            CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(policy.allowedToolNames),
            ALLOWED_WORKSPACE_DIRS: root,
            CAT_CAFE_API_URL: 'http://127.0.0.1:9',
          },
          stderr: 'pipe',
        });
        try {
          await client.connect(transport);
          const { tools } = await client.listTools();
          listed.push(...tools.map((t) => t.name));
          const denied = await client.callTool({ name: 'cat_cafe_shell_exec', arguments: { command: 'false' } });
          assert.equal(denied.isError, true, 'unregistered command tool must fail closed');
          if (family === 'memory') {
            const result = await client.callTool({
              name: 'cat_cafe_read_file_slice',
              arguments: { path, startLine: 1, endLine: 1 },
            });
            assert.notEqual(result.isError, true, JSON.stringify(result));
            assert.match(JSON.stringify(result), /visibleLine = 42/);
          }
        } finally {
          await client.close();
        }
      }
      assert.deepEqual(listed.sort(), [...policy.allowedToolNames].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('the exact panel MCP selection keeps ordinary responses and no bounded six-call admission', () => {
  const policy = watcherPanelToolPolicy();
  const env = parseToolsetEnv({ CAT_CAFE_ALLOWED_TOOL_NAMES: JSON.stringify(policy.allowedToolNames) });
  assert.deepEqual(env.allowedToolNames, policy.allowedToolNames);
  assert.equal(env.watcher, false, 'the retired 30k/six-call path must not be reintroduced');
  for (const name of policy.allowedToolNames) {
    const tool = CANONICAL_TOOL_REGISTRY.find((t) => t.name === name);
    assert.ok(tool, name);
    const operations = tool.operation.kind === 'single' ? [tool.operation] : tool.operation.variants;
    for (const op of operations)
      for (const auth of op.boundary.authorizationPaths)
        if (auth.credentialSource === 'local-process' || auth.scope.kind === 'local-runtime')
          assert.equal(op.boundary.risk.level, 'read', `${name} would bypass the callback write fence`);
  }
});
