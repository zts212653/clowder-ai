import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(apiRoot, '../..');
const states = [
  { name: 'missing', version: null },
  { name: 'older', version: '0.1.0' },
  { name: 'newer', version: '999.0.0' },
];
const targets = [
  { name: 'api', cwd: apiRoot },
  { name: 'root', cwd: repoRoot },
];

function markerExists(path) {
  try {
    accessSync(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

function createCodexProbe(path, state) {
  const outcome = state.version
    ? `process.stdout.write('codex-cli ${state.version}\\n');`
    : "process.stderr.write('codex: command not found\\n'); process.exitCode = 127;";
  writeFileSync(
    path,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.CAT_CAFE_CODEX_PROBE_MARKER, 'invoked');\n${outcome}\n`,
    'utf8',
  );
  chmodSync(path, 0o755);
}

for (const state of states) {
  const probeDir = mkdtempSync(join(tmpdir(), `cat-cafe-codex-build-${state.name}-`));
  try {
    createCodexProbe(join(probeDir, 'codex'), state);
    for (const target of targets) {
      const markerPath = join(probeDir, `${target.name}-codex-invoked`);
      const result = spawnSync('pnpm', ['run', 'build'], {
        cwd: target.cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${probeDir}:${process.env.PATH ?? ''}`,
          CAT_CAFE_CODEX_PROBE_MARKER: markerPath,
        },
        maxBuffer: 20 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(
          `${target.name} build failed with ambient Codex state ${state.name}:\n${result.stdout}\n${result.stderr}`,
        );
      }
      if (markerExists(markerPath)) {
        throw new Error(`${target.name} build executed ambient Codex in state ${state.name}`);
      }
      process.stdout.write(`[codex-build-independence] ${target.name}/${state.name}: PASS\n`);
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}
