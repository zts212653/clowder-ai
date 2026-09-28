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

  test('buildMcpEnv synthesizes the union opt-in only when usable creds exist', () => {
    const strict = buildMcpEnvForTest({});
    assert.equal(strict.CAT_CAFE_READONLY, 'true');
    assert.equal(strict.CAT_CAFE_READONLY_AGENT_KEY_UNION, undefined, 'no agent-key creds → no union opt-in');

    // #1494 round 3: a whitespace-only secret is no material — no synthesis.
    const blankSecret = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_SECRET: '   ' });
    assert.equal(
      blankSecret.CAT_CAFE_READONLY_AGENT_KEY_UNION,
      undefined,
      'blank SECRET must not synthesize the union',
    );
    const paddedSecret = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_SECRET: ' s ' });
    assert.equal(paddedSecret.CAT_CAFE_READONLY_AGENT_KEY_UNION, 'true', 'non-blank SECRET keeps the union');

    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-key-'));
    try {
      const sidecar = path.join(keyDir, 'agent.secret');
      fs.writeFileSync(sidecar, 'agent-key-material\n', 'utf-8');

      const withKeyFile = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_FILE: sidecar });
      assert.equal(
        withKeyFile.CAT_CAFE_READONLY_AGENT_KEY_UNION,
        'true',
        'antigravity mount with a usable sidecar keeps the union',
      );

      const withKeyFiles = buildMcpEnvForTest({
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: sidecar }),
      });
      assert.equal(withKeyFiles.CAT_CAFE_READONLY_AGENT_KEY_UNION, 'true');

      const withSecret = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_SECRET: 's' });
      assert.equal(withSecret.CAT_CAFE_READONLY_AGENT_KEY_UNION, 'true');
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  test('buildMcpEnv treats env presence without usable credentials as no creds (#1494)', () => {
    const missingSidecar = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_FILE: '/nonexistent/agent-key.secret' });
    assert.equal(
      missingSidecar.CAT_CAFE_READONLY_AGENT_KEY_UNION,
      undefined,
      'a path to a missing sidecar is not a credential',
    );

    const emptyMap = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_FILES: '{}' });
    assert.equal(emptyMap.CAT_CAFE_READONLY_AGENT_KEY_UNION, undefined, "'{}' variant map resolves zero keys");

    const badJson = buildMcpEnvForTest({ CAT_CAFE_AGENT_KEY_FILES: 'not-json' });
    assert.equal(badJson.CAT_CAFE_READONLY_AGENT_KEY_UNION, undefined, 'bad-JSON variant map is not a credential');
  });

  test('buildMcpEnv never clobbers an explicit union switch (#1494)', () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-key-'));
    try {
      const sidecar = path.join(keyDir, 'agent.secret');
      fs.writeFileSync(sidecar, 'agent-key-material\n', 'utf-8');
      const creds = { CAT_CAFE_AGENT_KEY_FILE: sidecar };

      const forcedFalse = buildMcpEnvForTest({ ...creds, CAT_CAFE_READONLY_AGENT_KEY_UNION: 'false' });
      assert.equal(forcedFalse.CAT_CAFE_READONLY_AGENT_KEY_UNION, 'false', 'explicit false forces strict readonly');

      const forcedEmpty = buildMcpEnvForTest({ ...creds, CAT_CAFE_READONLY_AGENT_KEY_UNION: '' });
      assert.equal(forcedEmpty.CAT_CAFE_READONLY_AGENT_KEY_UNION, '', 'explicit empty string is preserved verbatim');

      const forcedUpper = buildMcpEnvForTest({ ...creds, CAT_CAFE_READONLY_AGENT_KEY_UNION: 'TRUE' });
      assert.equal(
        forcedUpper.CAT_CAFE_READONLY_AGENT_KEY_UNION,
        'TRUE',
        'explicit non-canonical value stays verbatim',
      );
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
  });

  test('buildMcpEnv honors the bound-identity restriction when synthesizing (#1494)', () => {
    const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-mcp-key-'));
    try {
      const sidecar = path.join(keyDir, 'agent.secret');
      fs.writeFileSync(sidecar, 'agent-key-material\n', 'utf-8');

      const boundWrongMap = buildMcpEnvForTest({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: sidecar }),
      });
      assert.equal(
        boundWrongMap.CAT_CAFE_READONLY_AGENT_KEY_UNION,
        undefined,
        'a bound identity whose map entry is missing must not synthesize the union',
      );

      const boundOwnEntry = buildMcpEnvForTest({
        CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'antigravity',
        CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ antigravity: sidecar }),
      });
      assert.equal(
        boundOwnEntry.CAT_CAFE_READONLY_AGENT_KEY_UNION,
        'true',
        "the bound identity's own readable entry keeps the union",
      );
    } finally {
      fs.rmSync(keyDir, { recursive: true, force: true });
    }
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
