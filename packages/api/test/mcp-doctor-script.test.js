import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const doctorScriptSource = join(repoRoot, 'scripts', 'mcp-doctor.mjs');
const tempDirs = [];

function buildCapabilities(extraCapabilities = []) {
  return [
    ...['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'].map((id) => ({
      id,
      type: 'mcp',
      enabled: true,
      mcpServer: {
        transport: 'stdio',
        command: 'node',
        args: [],
      },
    })),
    {
      id: 'custom-stdio',
      type: 'mcp',
      enabled: true,
      mcpServer: {
        transport: 'stdio',
        command: 'node',
        args: [],
      },
    },
    ...extraCapabilities,
  ];
}

function writeCapabilities(root, extraCapabilities = []) {
  writeFileSync(
    join(root, '.cat-cafe', 'capabilities.json'),
    JSON.stringify({
      capabilities: buildCapabilities(extraCapabilities),
    }),
  );
}

function installSandboxNodeModules(root, { copy = cpSync, link = symlinkSync, platform = process.platform } = {}) {
  const source = join(repoRoot, 'node_modules');
  const target = join(root, 'node_modules');
  const type = platform === 'win32' ? 'junction' : 'dir';

  try {
    link(source, target, type);
  } catch (error) {
    if (platform === 'win32' && error?.code === 'EPERM') {
      copy(source, target, { recursive: true });
      return;
    }
    throw error;
  }
}

function createSandbox(extraCapabilities = []) {
  const root = mkdtempSync(join(tmpdir(), 'cc-mcp-doctor-'));
  tempDirs.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  mkdirSync(join(root, 'cat-cafe-skills'), { recursive: true });
  mkdirSync(join(root, 'packages', 'mcp-server', 'dist'), { recursive: true });

  cpSync(doctorScriptSource, join(root, 'scripts', 'mcp-doctor.mjs'));
  installSandboxNodeModules(root);

  writeCapabilities(root, extraCapabilities);
  writeFileSync(join(root, '.cat-cafe', 'mcp-resolved.json'), '{}');
  writeFileSync(join(root, 'cat-cafe-skills', 'manifest.yaml'), 'skills: {}\n');

  for (const filename of ['index.js', 'collab.js', 'memory.js', 'signals.js']) {
    writeFileSync(join(root, 'packages', 'mcp-server', 'dist', filename), '// stub\n');
  }

  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'which'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });

  return { root, binDir };
}

function runDoctor(root, binDir, envOverrides = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'mcp-doctor.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ...envOverrides,
    },
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

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
});
