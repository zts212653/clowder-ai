import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createMcpDoctorHarness, pencilBinarySuffix } from './mcp-doctor-test-helpers.js';

const { cleanupSandboxes, createSandbox, runDoctor } = createMcpDoctorHarness();

afterEach(cleanupSandboxes);

describe('mcp-doctor artifact detection', () => {
  it('fails when any referenced local artifact argument is missing', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'multi-artifact',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'node',
          args: ['./scripts/loader.js', './scripts/entry.js'],
        },
      },
    ]);

    writeFileSync(join(root, 'scripts', 'loader.js'), '// loader stub\n');

    const result = runDoctor(root, binDir);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /\[unresolved\] multi-artifact — command args reference missing local artifact/);
  });

  it('fails for missing path-like artifact args beyond .js entrypoints', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'non-js-artifact',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'node',
          args: ['scripts/server.mjs', 'tools/bootstrap.ts'],
        },
      },
    ]);

    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'tools', 'bootstrap.ts'), '// bootstrap stub\n');

    const result = runDoctor(root, binDir);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /\[unresolved\] non-js-artifact — command args reference missing local artifact/);
  });

  it('fails for missing local artifact paths passed via --flag=path args', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'flagged-artifact',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'node',
          args: ['--config=./missing.json'],
        },
      },
    ]);

    const result = runDoctor(root, binDir);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stdout, /\[unresolved\] flagged-artifact — command args reference missing local artifact/);
  });

  it('does not treat scoped package arguments as local artifact paths', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'scoped-package',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-everything'],
        },
      },
    ]);

    const result = runDoctor(root, binDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] scoped-package — stdio npx/);
  });

  it('does not treat slash-bearing package specs as local artifact paths', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'slash-package-spec',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'npx',
          args: ['github:modelcontextprotocol/servers'],
        },
      },
    ]);

    const result = runDoctor(root, binDir);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] slash-package-spec — stdio npx/);
  });

  it('expands home-relative artifact args before checking the filesystem', () => {
    const { root, binDir } = createSandbox([
      {
        id: 'tilde-artifact',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          transport: 'stdio',
          command: 'node',
          args: ['~/tools/server.mjs'],
        },
      },
    ]);

    const homeDir = join(root, 'fake-home');
    mkdirSync(join(homeDir, 'tools'), { recursive: true });
    writeFileSync(join(homeDir, 'tools', 'server.mjs'), '// server stub\n');

    const result = runDoctor(root, binDir, {
      HOME: homeDir,
      USERPROFILE: homeDir,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] tilde-artifact — stdio node/);
  });

  it('ignores discovered Pencil binaries that are not executable', (t) => {
    if (process.platform === 'win32') t.skip('non-executable file mode is not meaningful on win32');

    const { root, binDir } = createSandbox([
      {
        id: 'pencil-discovered',
        type: 'mcp',
        enabled: true,
        mcpServer: {
          resolver: 'pencil',
        },
      },
    ]);

    const homeDir = join(root, 'fake-home');
    const pencilDir = join(homeDir, '.vscode', 'extensions', 'highagency.pencildev-0.6.41-universal');
    mkdirSync(join(pencilDir, 'out'), { recursive: true });
    writeFileSync(join(pencilDir, pencilBinarySuffix), '#!/bin/sh\nexit 0\n', { mode: 0o644 });

    const result = runDoctor(root, binDir, {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PENCIL_MCP_APP: 'vscode',
    });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /\[unresolved\] pencil-discovered — resolver declared but no local Pencil installation found/,
    );
  });
});
