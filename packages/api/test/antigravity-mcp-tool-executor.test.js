import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import {
  buildMcpEnvForTest,
  CallMcpToolExecutor,
  resolveMcpEntrypointForTest,
} from '../dist/domains/cats/services/agents/providers/antigravity/executors/McpToolExecutor.js';

function makeContext() {
  const entries = [];
  return {
    entries,
    ctx: {
      cascadeId: 'c1',
      trajectoryId: 't1',
      stepIndex: 4,
      cwd: '/tmp',
      audit: {
        record: async (entry) => {
          entries.push(entry);
        },
      },
    },
  };
}

describe('CallMcpToolExecutor', () => {
  test('delegates allowlisted read-only MCP tools to the configured caller', async () => {
    const callTool = mock.fn(async () => ({ content: [{ type: 'text', text: 'session-chain-ok' }] }));
    const executor = new CallMcpToolExecutor({ callTool });
    const { ctx, entries } = makeContext();

    const result = await executor.execute(
      {
        serverName: 'cat-cafe-memory',
        toolName: 'cat_cafe_list_session_chain',
        arguments: { threadId: 'thread-1', catId: 'antig-opus', limit: 5 },
      },
      ctx,
    );

    assert.equal(result.status, 'success');
    assert.equal(result.stdout, 'session-chain-ok');
    assert.equal(callTool.mock.callCount(), 1);
    assert.deepEqual(callTool.mock.calls[0].arguments[0], {
      serverName: 'cat-cafe-memory',
      toolName: 'cat_cafe_list_session_chain',
      arguments: { threadId: 'thread-1', catId: 'antig-opus', limit: 5 },
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool, 'call_mcp_tool');
    assert.equal(entries[0].result.status, 'success');
  });

  test('delegates readonly file-slice drilldown instead of falling back to truncated IDE reads', async () => {
    const callTool = mock.fn(async () => ({ content: [{ type: 'text', text: 'Phase D lines' }] }));
    const executor = new CallMcpToolExecutor({ callTool });
    const { ctx, entries } = makeContext();

    const result = await executor.execute(
      {
        serverName: 'cat-cafe-memory',
        toolName: 'cat_cafe_read_file_slice',
        arguments: {
          path: 'docs/features/F211-cross-runtime-session-transparency.md',
          startLine: 220,
          endLine: 260,
        },
      },
      ctx,
    );

    assert.equal(result.status, 'success');
    assert.equal(result.stdout, 'Phase D lines');
    assert.equal(callTool.mock.callCount(), 1);
    assert.deepEqual(callTool.mock.calls[0].arguments[0], {
      serverName: 'cat-cafe-memory',
      toolName: 'cat_cafe_read_file_slice',
      arguments: {
        path: 'docs/features/F211-cross-runtime-session-transparency.md',
        startLine: 220,
        endLine: 260,
      },
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result.status, 'success');
  });

  test('refuses non-read-only MCP tools without calling the MCP server', async () => {
    const callTool = mock.fn(async () => ({ content: [{ type: 'text', text: 'posted' }] }));
    const executor = new CallMcpToolExecutor({ callTool });
    const { ctx, entries } = makeContext();

    const result = await executor.execute(
      {
        serverName: 'cat-cafe-collab',
        toolName: 'cat_cafe_post_message',
        arguments: { content: 'nope' },
      },
      ctx,
    );

    assert.equal(result.status, 'refused');
    assert.match(result.reason, /not allowlisted read-only/);
    assert.equal(callTool.mock.callCount(), 0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].result.status, 'refused');
  });

  test('passes executor context cwd to the MCP caller', async () => {
    const callTool = mock.fn(async (_input, ctx) => {
      assert.equal(ctx.cwd, '/workspace/packages/api');
      return { content: [{ type: 'text', text: 'ok' }] };
    });
    const executor = new CallMcpToolExecutor({ callTool });
    const { ctx } = makeContext();
    ctx.cwd = '/workspace/packages/api';

    const result = await executor.execute(
      {
        serverName: 'cat-cafe-memory',
        toolName: 'cat_cafe_list_session_chain',
        arguments: { threadId: 'thread-1', catId: 'antig-opus' },
      },
      ctx,
    );

    assert.equal(result.status, 'success');
    assert.equal(callTool.mock.callCount(), 1);
  });

  test('buildMcpEnvForTest falls back to API_SERVER_PORT before PORT', () => {
    const env = buildMcpEnvForTest({ API_SERVER_PORT: '3012', PORT: '3011' });
    assert.equal(env.CAT_CAFE_API_URL, 'http://127.0.0.1:3012');

    const explicit = buildMcpEnvForTest({ CAT_CAFE_API_URL: 'http://127.0.0.1:4999', API_SERVER_PORT: '3012' });
    assert.equal(explicit.CAT_CAFE_API_URL, 'http://127.0.0.1:4999');
  });

  test('resolveMcpEntrypointForTest resolves from invocation workspace cwd when runtime root is unset', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-root-'));
    const processRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-process-root-'));
    const originalCwd = process.cwd();
    try {
      const apiDir = path.join(root, 'packages', 'api');
      const mcpDistDir = path.join(root, 'packages', 'mcp-server', 'dist');
      fs.mkdirSync(apiDir, { recursive: true });
      fs.mkdirSync(mcpDistDir, { recursive: true });
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\\n  - packages/*\\n');
      fs.writeFileSync(path.join(mcpDistDir, 'memory.js'), '');

      process.chdir(processRoot);
      const resolved = resolveMcpEntrypointForTest('cat-cafe-memory', apiDir, {});

      assert.deepEqual(resolved, {
        entrypoint: path.join(mcpDistDir, 'memory.js'),
        projectRoot: root,
      });
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(processRoot, { recursive: true, force: true });
    }
  });

  test('resolveMcpEntrypointForTest resolves from runtime root before external invocation cwd', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-runtime-root-'));
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-external-root-'));
    try {
      const mcpDistDir = path.join(runtimeRoot, 'packages', 'mcp-server', 'dist');
      fs.mkdirSync(mcpDistDir, { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, 'pnpm-workspace.yaml'), 'packages:\\n  - packages/*\\n');
      fs.writeFileSync(path.join(mcpDistDir, 'memory.js'), '');

      fs.writeFileSync(path.join(externalRoot, 'pnpm-workspace.yaml'), 'packages:\\n  - packages/*\\n');

      const resolved = resolveMcpEntrypointForTest('cat-cafe-memory', externalRoot, {
        CAT_CAFE_RUNTIME_ROOT: runtimeRoot,
      });

      assert.deepEqual(resolved, {
        entrypoint: path.join(mcpDistDir, 'memory.js'),
        projectRoot: runtimeRoot,
      });
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});
