import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function commandOutput(command, args, message) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${message}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function stablePublicTestValue(value) {
  if (Array.isArray(value)) return value.map(stablePublicTestValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stablePublicTestValue(value[key])]),
  );
}

export function publicTestArtifactFingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(stablePublicTestValue(value)))
    .digest('hex');
}

export function validatePublicTestProvenance(provenance) {
  invariant(provenance && typeof provenance === 'object' && !Array.isArray(provenance), 'provenance is required');
  invariant(GIT_OBJECT_ID.test(provenance.workspaceTree), 'provenance.workspaceTree must be a Git tree id');
  invariant(SHA256.test(provenance.lockfileHash), 'provenance.lockfileHash must be SHA-256');
  for (const field of ['nodeVersion', 'pnpmVersion', 'platform', 'arch']) {
    invariant(typeof provenance[field] === 'string' && provenance[field].length > 0, `provenance.${field} is required`);
  }
  return stablePublicTestValue(provenance);
}

export function samePublicTestProvenance(left, right) {
  return JSON.stringify(validatePublicTestProvenance(left)) === JSON.stringify(validatePublicTestProvenance(right));
}

export function currentPublicTestProvenance(packageRoot) {
  const workspaceRoot = commandOutput(
    'git',
    ['-C', packageRoot, 'rev-parse', '--show-toplevel'],
    'could not resolve workspace root',
  );
  return validatePublicTestProvenance({
    workspaceTree: commandOutput(
      'git',
      ['-C', workspaceRoot, 'rev-parse', 'HEAD^{tree}'],
      'could not resolve tested workspace tree',
    ),
    lockfileHash: sha256File(resolve(workspaceRoot, 'pnpm-lock.yaml')),
    nodeVersion: process.version,
    pnpmVersion: commandOutput('pnpm', ['--version'], 'could not resolve pnpm version'),
    platform: process.platform,
    arch: process.arch,
  });
}
