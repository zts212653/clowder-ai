import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIAGNOSTIC_BUFFER_BYTES = 1024 * 1024;

function outputText(value) {
  if (typeof value === 'string') return value.trim();
  if (Buffer.isBuffer(value)) return value.toString('utf8').trim();
  return '';
}

function assertGitSuccess(label, result) {
  if (!result.error && result.status === 0) return;
  const detail =
    outputText(result.stderr) ||
    result.error?.message ||
    (result.signal ? `terminated by ${result.signal}` : `exited with status ${String(result.status)}`);
  throw new Error(`${label} failed: ${detail}`, result.error ? { cause: result.error } : undefined);
}

export function stablePatchId(repoRoot, baseSha, { gitBinary = 'git', tempParent = os.tmpdir() } = {}) {
  const tempRoot = mkdtempSync(path.join(tempParent, 'cat-cafe-gate-patch-id-'));
  const patchPath = path.join(tempRoot, 'patch.diff');
  let patchFile;

  try {
    patchFile = openSync(patchPath, 'wx', 0o600);
    const diff = spawnSync(gitBinary, ['diff', '--binary', `${baseSha}...HEAD`], {
      cwd: repoRoot,
      stdio: ['ignore', patchFile, 'pipe'],
      encoding: 'utf8',
      maxBuffer: DIAGNOSTIC_BUFFER_BYTES,
    });
    closeSync(patchFile);
    patchFile = undefined;
    assertGitSuccess('git diff --binary', diff);
    if (statSync(patchPath).size === 0) return null;

    patchFile = openSync(patchPath, 'r');
    const patchId = spawnSync(gitBinary, ['patch-id', '--stable'], {
      cwd: repoRoot,
      stdio: [patchFile, 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: DIAGNOSTIC_BUFFER_BYTES,
    });
    closeSync(patchFile);
    patchFile = undefined;
    assertGitSuccess('git patch-id --stable', patchId);
    return patchId.stdout.trim().split(/\s+/)[0] || null;
  } finally {
    if (patchFile !== undefined) closeSync(patchFile);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
