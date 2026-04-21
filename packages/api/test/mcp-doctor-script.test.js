import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createMcpDoctorHarness, repoRoot } from './mcp-doctor-test-helpers.js';

const { cleanupSandboxes, createSandbox, installSandboxNodeModules, runDoctor } = createMcpDoctorHarness();

afterEach(cleanupSandboxes);

describe('mcp-doctor.mjs', () => {
  it('uses a junction when linking sandbox node_modules on win32', () => {
    const calls = [];

    installSandboxNodeModules('/tmp/fake-root', {
      platform: 'win32',
      link: (source, target, type) => {
        calls.push({ source, target, type });
      },
    });

    assert.deepEqual(calls, [
      {
        source: join(repoRoot, 'node_modules'),
        target: '/tmp/fake-root/node_modules',
        type: 'junction',
      },
    ]);
  });

  it('falls back to copying node_modules when win32 symlink setup is denied', () => {
    const copied = [];

    installSandboxNodeModules('/tmp/fake-root', {
      platform: 'win32',
      link: () => {
        const error = new Error('EPERM: operation not permitted');
        error.code = 'EPERM';
        throw error;
      },
      copy: (source, target, options) => {
        copied.push({ source, target, options });
      },
    });

    assert.deepEqual(copied, [
      {
        source: join(repoRoot, 'node_modules'),
        target: '/tmp/fake-root/node_modules',
        options: { recursive: true },
      },
    ]);
  });

  it('resolves stdio commands even when `which` is unavailable', () => {
    const { root, binDir } = createSandbox();
    const result = runDoctor(root, binDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] custom-stdio — stdio node/);
    assert.ok(existsSync(join(root, 'node_modules', 'yaml')));
    assert.match(readFileSync(join(root, '.cat-cafe', 'capabilities.json'), 'utf8'), /custom-stdio/);
  });

  it('expands home-relative stdio command paths before validation', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'tilde-command',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: '~/bin/mcp-server',
          args: [],
        },
      },
    ]);

    const homeDir = join(root, 'fake-home');
    mkdirSync(join(homeDir, 'bin'), { recursive: true });
    writeFileSync(join(homeDir, 'bin', 'mcp-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const result = runDoctor(root, binDir, {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] tilde-command — stdio ~\/bin\/mcp-server/);
  });

  it('fails when explicit PENCIL_MCP_BIN points to a non-executable path', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'pencil-custom',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          resolver: 'pencil',
        },
      },
    ]);

    const explicitDir = join(root, 'fake-pencil-bin');
    mkdirSync(explicitDir, { recursive: true });

    const result = runDoctor(root, binDir, {
      PENCIL_MCP_BIN: explicitDir,
      PENCIL_MCP_APP: 'vscode',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /\[unresolved\] pencil-custom — configured PENCIL_MCP_BIN is not executable/);
  });

  it('resolves home-relative PENCIL_MCP_BIN before executability check', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'pencil-home',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          resolver: 'pencil',
        },
      },
    ]);

    const homeDir = join(root, 'fake-home');
    mkdirSync(join(homeDir, 'bin'), { recursive: true });
    writeFileSync(join(homeDir, 'bin', 'pencil-mcp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const result = runDoctor(root, binDir, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PENCIL_MCP_BIN: '~/bin/pencil-mcp',
      PENCIL_MCP_APP: 'vscode',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] pencil-home — resolved via vscode/);
  });
});
