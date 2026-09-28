import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomFillSync } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyGateRoute, deriveGateRoute } from '../classify-gate-route.mjs';
import { stablePatchId } from './git-patch-id.mjs';

const FORMER_PATCH_BUFFER_BYTES = 64 * 1024 * 1024;
const LARGE_BINARY_BYTES = 56 * 1024 * 1024;

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function initializeGateRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'gate-large-patch-'));
  git(repoRoot, ['init', '-q']);
  git(repoRoot, ['config', 'user.email', 'gate@example.test']);
  git(repoRoot, ['config', 'user.name', 'Gate Test']);
  mkdirSync(path.join(repoRoot, 'packages', 'api', 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'package.json'), '{"packageManager":"pnpm@10.0.0"}\n');
  writeFileSync(path.join(repoRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(repoRoot, 'biome.json'), '{}\n');
  writeFileSync(path.join(repoRoot, '.nvmrc'), '24\n');
  writeFileSync(path.join(repoRoot, 'packages', 'api', 'src', 'value.ts'), 'export const value = 1;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-qm', 'base']);
  return repoRoot;
}

function writeRandomBinary(filePath, byteLength) {
  const fileDescriptor = openSync(filePath, 'wx');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (let written = 0; written < byteLength; written += chunk.length) {
      randomFillSync(chunk);
      writeSync(fileDescriptor, chunk, 0, Math.min(chunk.length, byteLength - written));
    }
  } finally {
    closeSync(fileDescriptor);
  }
}

function nativePatchEvidence(repoRoot, baseSha) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'gate-native-patch-id-'));
  const patchPath = path.join(tempRoot, 'patch.diff');
  let patchFile;
  try {
    patchFile = openSync(patchPath, 'wx');
    const diff = spawnSync('git', ['diff', '--binary', `${baseSha}...HEAD`], {
      cwd: repoRoot,
      stdio: ['ignore', patchFile, 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(diff.status, 0, diff.stderr);
    closeSync(patchFile);
    patchFile = undefined;

    patchFile = openSync(patchPath, 'r');
    const patchId = spawnSync('git', ['patch-id', '--stable'], {
      cwd: repoRoot,
      stdio: [patchFile, 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(patchId.status, 0, patchId.stderr);
    return {
      bytes: statSync(patchPath).size,
      patchId: patchId.stdout.trim().split(/\s+/)[0],
    };
  } finally {
    if (patchFile !== undefined) closeSync(patchFile);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function createFailingGit(repoRoot) {
  const executable = path.join(repoRoot, 'fake-git.mjs');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const command = process.argv[2];
appendFileSync(path.join(process.cwd(), 'fake-git.log'), command + '\\n');
if (command === 'diff') {
  if (process.argv.at(-1).startsWith('fail-diff')) {
    process.stderr.write('forced diff failure\\n');
    process.exit(17);
  }
  process.stdout.write('synthetic non-empty patch\\n');
  process.exit(0);
}
process.stderr.write('forced patch-id failure\\n');
process.exit(23);
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

test('derives the real stable ID for a binary patch larger than the former 64 MiB buffer', { timeout: 120_000 }, () => {
  const repoRoot = initializeGateRepo();
  try {
    const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);
    writeRandomBinary(path.join(repoRoot, 'large.bin'), LARGE_BINARY_BYTES);
    git(repoRoot, ['add', 'large.bin']);
    git(repoRoot, ['commit', '-qm', 'large binary']);
    const expected = nativePatchEvidence(repoRoot, baseSha);
    assert.ok(expected.bytes > FORMER_PATCH_BUFFER_BYTES, `expected >64 MiB patch, got ${expected.bytes}`);

    const result = deriveGateRoute({
      repoRoot,
      baseSha,
      databasePath: path.join(repoRoot, '.git', 'gate.sqlite'),
    });
    assert.equal(result.patchId, expected.patchId);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('preserves ordinary patch IDs and returns null for an empty range', () => {
  const repoRoot = initializeGateRepo();
  try {
    const baseSha = git(repoRoot, ['rev-parse', 'HEAD']);
    assert.equal(stablePatchId(repoRoot, baseSha), null);

    writeFileSync(path.join(repoRoot, 'packages', 'api', 'src', 'value.ts'), 'export const value = 2;\n');
    git(repoRoot, ['add', '.']);
    git(repoRoot, ['commit', '-qm', 'ordinary patch']);
    const expected = nativePatchEvidence(repoRoot, baseSha);
    assert.equal(stablePatchId(repoRoot, baseSha), expected.patchId);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('keeps the patch-id helper inside the canonical full-gate control surface', () => {
  const result = classifyGateRoute({
    riskAxis: 'behavior',
    previousStatus: 'none',
    previousFailureRelevance: 'none',
    authoredPatch: 'changed',
    prPaths: ['scripts/lib/git-patch-id.mjs'],
    basePaths: [],
    exactGreen: false,
  });
  assert.equal(result.route, 'full');
  assert.match(result.reasons.join('\n'), /gate classifier|gate execution/i);
});

test('propagates git diff failure and removes its private temporary patch', () => {
  const repoRoot = initializeGateRepo();
  const tempParent = mkdtempSync(path.join(os.tmpdir(), 'gate-patch-cleanup-diff-'));
  try {
    const gitBinary = createFailingGit(repoRoot);
    assert.throws(
      () => stablePatchId(repoRoot, 'fail-diff', { gitBinary, tempParent }),
      /git diff --binary failed: forced diff failure/,
    );
    assert.deepEqual(readdirSync(tempParent), []);
    assert.equal(readFileSync(path.join(repoRoot, 'fake-git.log'), 'utf8'), 'diff\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(tempParent, { recursive: true, force: true });
  }
});

test('propagates git patch-id failure and removes its private temporary patch', () => {
  const repoRoot = initializeGateRepo();
  const tempParent = mkdtempSync(path.join(os.tmpdir(), 'gate-patch-cleanup-id-'));
  try {
    const gitBinary = createFailingGit(repoRoot);
    assert.throws(
      () => stablePatchId(repoRoot, 'fail-patch-id', { gitBinary, tempParent }),
      /git patch-id --stable failed: forced patch-id failure/,
    );
    assert.deepEqual(readdirSync(tempParent), []);
    assert.equal(readFileSync(path.join(repoRoot, 'fake-git.log'), 'utf8'), 'diff\npatch-id\n');
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(tempParent, { recursive: true, force: true });
  }
});
