import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { deploymentDefaults } from '@cat-cafe/shared';
import type { A2aEvaluatorSource } from './verdict-source-types.js';

const exec = promisify(execFile);
const CHECKOUT_NAME = 'cat-cafe-eval-a2a-current';
const CANONICAL_REPOSITORY = deploymentDefaults.repositoryFullName;
const CANONICAL_ORIGINS = new Set(
  ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'].flatMap((prefix) => [
    `${prefix}${CANONICAL_REPOSITORY}`,
    `${prefix}${CANONICAL_REPOSITORY}.git`,
  ]),
);
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const SOURCE_KEYS = ['kind', 'checkoutHeadSha', 'snapshotSha256', 'attributionSha256'];

export function validateA2aEvaluatorSource(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'source must be a designated evaluator selector';
  const source = value as Record<string, unknown>;
  if (source.kind !== 'designated-a2a-evaluator' || Object.keys(source).some((key) => !SOURCE_KEYS.includes(key))) {
    return 'source only accepts designated-a2a-evaluator and exact HEAD/content pins; paths are forbidden';
  }
  for (const [field, pattern] of [
    ['checkoutHeadSha', /^[a-f0-9]{40}$/],
    ['snapshotSha256', /^[a-f0-9]{64}$/],
    ['attributionSha256', /^[a-f0-9]{64}$/],
  ] as const) {
    if (typeof source[field] !== 'string' || !pattern.test(source[field]))
      return `source.${field} must be a lowercase hex digest`;
  }
  return null;
}

/** Read-only Git queries, bounded and shell-free. No checkout refresh or runtime write. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 64 * 1024 });
    return stdout.trim();
  } catch {
    // Git stderr can contain local config/remote details; do not expose them.
    throw new Error(`invalid_source_ref: cannot verify evaluator ${args[0]}`);
  }
}

/** Read each raw input once; later writes use these exact hash-verified bytes. */
function readPinnedRaw(checkout: string, category: string, name: string, expectedHash: string): Buffer {
  const directory = resolve(checkout, 'docs/harness-feedback', category);
  let fd: number | undefined;
  try {
    if (realpathSync(directory) !== directory)
      throw new Error('invalid_source_ref: evidence directory boundary is symlinked');
    fd = openSync(resolve(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RAW_BYTES)
      throw new Error('invalid_source_ref: raw evidence must be a regular file <=8 MiB');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length !== stat.size) throw new Error('invalid_source_ref: raw evidence changed during read');
    const result = bytes.subarray(0, length);
    if (createHash('sha256').update(result).digest('hex') !== expectedHash) {
      throw new Error(`invalid_source_ref: ${category} content hash mismatch`);
    }
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`evidence_not_found: designated evaluator ${category} input missing`);
    if (code === 'ELOOP') throw new Error('invalid_source_ref: raw evidence symlink is forbidden');
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readA2aEvaluatorEvidence(
  liveHarnessFeedbackRoot: string,
  snapshotName: string,
  attributionName: string,
  source: A2aEvaluatorSource,
): Promise<{ snapshot: Buffer; attribution: Buffer; provenance: A2aEvaluatorSource & { checkoutName: string } }> {
  const error = validateA2aEvaluatorSource(source);
  if (error) throw new Error(`invalid_source_ref: ${error}`);
  // A runtime worktree's common Git directory points back to MAIN_ROOT/.git.
  // Resolve the designated sibling there, never relative to runtime or a caller path.
  const liveRepo = resolve(liveHarnessFeedbackRoot, '../..');
  const commonDir = await git(liveRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const checkout = resolve(dirname(dirname(commonDir)), CHECKOUT_NAME);
  try {
    if (realpathSync(checkout) !== checkout)
      throw new Error('invalid_source_ref: evaluator checkout boundary is symlinked');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('evidence_not_found: designated evaluator checkout missing');
    throw error;
  }
  const [origin, owner, policy, head, evaluatorCommon] = await Promise.all([
    git(checkout, 'remote', 'get-url', 'origin'),
    git(checkout, 'config', '--local', '--get', 'catcafe.lifecycle.owner'),
    git(checkout, 'config', '--local', '--get', 'catcafe.lifecycle.policy'),
    git(checkout, 'rev-parse', 'HEAD'),
    git(checkout, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  ]);
  if (!CANONICAL_ORIGINS.has(origin)) {
    throw new Error('invalid_source_ref: designated evaluator origin is not the canonical repository');
  }
  if (owner !== 'codex' || policy !== 'never')
    throw new Error('invalid_source_ref: evaluator lifecycle must be owner=codex, policy=never');
  if (evaluatorCommon !== resolve(checkout, '.git'))
    throw new Error('invalid_source_ref: evaluator must be an independent checkout');
  if (head !== source.checkoutHeadSha)
    throw new Error('invalid_source_ref: evaluator HEAD differs from checkoutHeadSha');
  const snapshot = readPinnedRaw(checkout, 'snapshots', snapshotName, source.snapshotSha256);
  const attribution = readPinnedRaw(checkout, 'attributions', attributionName, source.attributionSha256);
  if ((await git(checkout, 'rev-parse', 'HEAD')) !== head)
    throw new Error('invalid_source_ref: evaluator HEAD changed during read');
  return { snapshot, attribution, provenance: { ...source, checkoutName: CHECKOUT_NAME } };
}
