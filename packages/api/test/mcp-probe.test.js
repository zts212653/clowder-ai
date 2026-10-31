// @ts-check

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

describe('probeMcpCapability', () => {
  it('does not retain the MCP SDK default request timer after a failed probe', async () => {
    const script = `
      const { probeMcpCapability } = await import('./dist/routes/mcp-probe.js');
      const result = await probeMcpCapability(
        {
          id: 'exits-before-initialize',
          type: 'mcp',
          enabled: true,
          source: 'external',
          mcpServer: {
            command: process.execPath,
            args: ['--eval', 'process.exit(0)'],
          },
        },
        { projectRoot: process.cwd(), timeoutMs: 100 },
      );
      if (result.connectionStatus !== 'disconnected') process.exitCode = 2;
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`failed probe retained an active handle past 1500ms: ${stderr}`));
      }, 1500);
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  });

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
