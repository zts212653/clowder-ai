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

function createSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cc-mcp-doctor-'));
  tempDirs.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  mkdirSync(join(root, 'cat-cafe-skills'), { recursive: true });
  mkdirSync(join(root, 'packages', 'mcp-server', 'dist'), { recursive: true });

  cpSync(doctorScriptSource, join(root, 'scripts', 'mcp-doctor.mjs'));
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

  writeFileSync(
    join(root, '.cat-cafe', 'capabilities.json'),
    JSON.stringify({
      capabilities: [
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
      ],
    }),
  );
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

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('mcp-doctor.mjs', () => {
  it('resolves stdio commands even when `which` is unavailable', () => {
    const { root, binDir } = createSandbox();
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'mcp-doctor.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
      },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[ready\] custom-stdio — stdio node/);
    assert.ok(existsSync(join(root, 'node_modules', 'yaml')));
    assert.match(readFileSync(join(root, '.cat-cafe', 'capabilities.json'), 'utf8'), /custom-stdio/);
  });
});
