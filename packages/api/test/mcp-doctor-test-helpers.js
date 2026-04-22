import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(__dirname, '..', '..', '..');
const doctorScriptSource = join(repoRoot, 'scripts', 'mcp-doctor.mjs');

export const pencilBinarySuffix = `out/mcp-server-${
  process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'darwin'
}-${process.arch === 'x64' ? 'x64' : 'arm64'}${process.platform === 'win32' ? '.exe' : ''}`;

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

export function createMcpDoctorHarness() {
  const tempDirs = [];

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

  async function cleanupSandboxes() {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  }

  return {
    cleanupSandboxes,
    createSandbox,
    installSandboxNodeModules,
    runDoctor,
  };
}
