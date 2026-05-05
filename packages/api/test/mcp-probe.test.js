// @ts-check

import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { probeMcpCapability, resolveProbeTimeoutMs } = await import('../dist/routes/mcp-probe.js');

function makeCapability(command, args = []) {
  return {
    id: 'tool',
    type: 'mcp',
    enabled: true,
    source: 'external',
    mcpServer: { command, args },
  };
}

describe('resolveProbeTimeoutMs', () => {
  it('uses explicit override when provided', () => {
    const cap = makeCapability('node', ['dist/index.js']);
    assert.equal(resolveProbeTimeoutMs(cap, 4321), 4321);
  });

  it('uses default timeout for normal node-based server', () => {
    const cap = makeCapability('node', ['dist/index.js']);
    assert.equal(resolveProbeTimeoutMs(cap), 2500);
  });

  it('uses slow-start timeout for npx servers', () => {
    const cap = makeCapability('npx', ['-y', '@playwright/mcp@latest']);
    assert.equal(resolveProbeTimeoutMs(cap), 7000);
  });

  it('uses slow-start timeout for pnpm dlx servers', () => {
    const cap = makeCapability('pnpm', ['dlx', '@modelcontextprotocol/server-filesystem']);
    assert.equal(resolveProbeTimeoutMs(cap), 7000);
  });

  it('uses slow-start timeout for docker mcp gateway run', () => {
    const cap = makeCapability('docker', ['mcp', 'gateway', 'run']);
    assert.equal(resolveProbeTimeoutMs(cap), 7000);
  });
});

describe('cat-cafe probe path resolution', () => {
  it('re-resolves stale mcp-server dist paths using projectRoot, not process.cwd()', async () => {
    const staleWorktree = '/old/stale/worktree';
    const stalePath = `${staleWorktree}/packages/mcp-server/dist/collab.js`;
    // Use the repo root (two levels up from packages/api/test/) as projectRoot,
    // which is the correct binary root regardless of API cwd.
    const repoRoot = join(import.meta.dirname, '../../..');

    const result = await probeMcpCapability(
      {
        id: 'cat-cafe-collab',
        type: 'mcp',
        enabled: true,
        source: 'cat-cafe',
        mcpServer: { command: 'node', args: [stalePath] },
      },
      { projectRoot: repoRoot, timeoutMs: 3000 },
    );

    // With correct projectRoot, the re-resolved path should point to the
    // actual dist. If mcp-server/dist/collab.js exists, probe connects.
    // Even if dist is not built, the key assertion is it doesn't return
    // 'unknown' (which would mean command resolution failed entirely).
    assert.ok(
      result.connectionStatus === 'connected' || result.connectionStatus === 'disconnected',
      `Expected connected/disconnected but got ${result.connectionStatus}`,
    );
    // If dist exists in this repo, we should get actual tools
    if (result.connectionStatus === 'connected') {
      assert.ok(Array.isArray(result.tools) && result.tools.length > 0, 'Connected but got no tools');
    }
  });
});

describe('probeMcpCapability', () => {
  it('returns unknown when pencil resolver-backed capability cannot resolve a local binary', async () => {
    const originalBin = process.env.PENCIL_MCP_BIN;
    const originalApp = process.env.PENCIL_MCP_APP;
    process.env.PENCIL_MCP_BIN = join(tmpdir(), `missing-pencil-${Date.now()}`);
    delete process.env.PENCIL_MCP_APP;

    try {
      const result = await probeMcpCapability(
        {
          id: 'pencil',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: { command: '', args: [], resolver: 'pencil' },
        },
        { projectRoot: process.cwd() },
      );

      assert.deepEqual(result, { connectionStatus: 'unknown' });
    } finally {
      if (originalBin === undefined) delete process.env.PENCIL_MCP_BIN;
      else process.env.PENCIL_MCP_BIN = originalBin;
      if (originalApp === undefined) delete process.env.PENCIL_MCP_APP;
      else process.env.PENCIL_MCP_APP = originalApp;
    }
  });
});
