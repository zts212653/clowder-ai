import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CliExecutionOwnerRef, CliProcessOwnerRecord } from './cli-process-ownership.js';

const DIRECTORY = 'cli-execution-stops';
export type CliStopProofOrigin = 'cleanup' | 'operator_archived_manifest';
const SCOPE_KEYS = ['executionId', 'invocationId', 'threadId', 'catId', 'userId'] as const;
const ownerKey = (owner: CliExecutionOwnerRef): string =>
  createHash('sha256')
    .update(JSON.stringify([owner.executionId, owner.invocationId, owner.threadId, owner.catId, owner.userId]))
    .digest('hex');

/** Called only by cleanup after its supervisor/reaper has proved the entire owned tree empty. */
export function persistCliExecutionStopEvidence(
  record: CliProcessOwnerRecord,
  origin: CliStopProofOrigin = 'cleanup',
): void {
  const { execution } = record.manifest;
  if (!execution) return;
  const root = dirname(dirname(record.path));
  const directory = join(root, DIRECTORY, ownerKey(execution));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${record.manifest.ownerId}.json`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const observedAt = Date.now();
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({
          v: 1,
          source: 'owned_tree_empty',
          origin,
          execution,
          ownerId: record.manifest.ownerId,
          createdAt: record.manifest.createdAt,
          supervisor: record.manifest.supervisor,
          root: record.manifest.root,
          stoppedAt: observedAt,
          ...(origin === 'operator_archived_manifest' ? { observedAt } : {}),
        }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const fdDirectory = openSync(directory, 'r');
      try {
        fsyncSync(fdDirectory);
      } finally {
        closeSync(fdDirectory);
      }
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error; // The caller must retain its active manifest if evidence was not durable.
  }
}

function parseStopProof(
  proof: unknown,
  owner: CliExecutionOwnerRef,
  name: string,
): { exitedAt: number; hostPid: number; origin: CliStopProofOrigin } | undefined {
  if (!proof || typeof proof !== 'object') return undefined;
  const value = proof as Record<string, unknown>;
  const scope = value.execution;
  if (!scope || typeof scope !== 'object') return undefined;
  const execution = scope as Record<string, unknown>;
  const supervisor = value.supervisor;
  if (
    !supervisor ||
    typeof supervisor !== 'object' ||
    !('ppid' in supervisor) ||
    typeof supervisor.ppid !== 'number' ||
    !Number.isSafeInteger(supervisor.ppid)
  )
    return undefined;
  if (
    value.v !== 1 ||
    value.source !== 'owned_tree_empty' ||
    (value.origin !== 'cleanup' && value.origin !== 'operator_archived_manifest') ||
    typeof value.ownerId !== 'string' ||
    name !== `${value.ownerId}.json` ||
    typeof value.createdAt !== 'number' ||
    typeof value.stoppedAt !== 'number' ||
    !Number.isFinite(value.stoppedAt) ||
    value.stoppedAt < value.createdAt ||
    SCOPE_KEYS.some((key) => execution[key] !== owner[key])
  )
    return undefined;
  if (
    value.origin === 'operator_archived_manifest' &&
    (typeof value.observedAt !== 'number' || !Number.isFinite(value.observedAt) || value.observedAt < value.stoppedAt)
  )
    return undefined;
  return { exitedAt: value.stoppedAt, hostPid: supervisor.ppid, origin: value.origin };
}

/** Exact scope only. Absence or malformed evidence never establishes stop. */
export function readCliExecutionStopEvidence(
  owner: CliExecutionOwnerRef,
  dataRoot: string,
): { exitedAt: number; hostPids: number[]; origins: CliStopProofOrigin[] } | undefined {
  const directory = join(dataRoot, DIRECTORY, ownerKey(owner));
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const completed = names.filter((name) => name.endsWith('.json'));
  if (!completed.length || completed.length > 256) return undefined;
  let exitedAt = 0;
  const hostPids = new Set<number>();
  const origins = new Set<CliStopProofOrigin>();
  for (const name of completed) {
    const proof = parseStopProof(JSON.parse(readFileSync(join(directory, name), 'utf8')), owner, name);
    if (!proof) return undefined;
    exitedAt = Math.max(exitedAt, proof.exitedAt);
    hostPids.add(proof.hostPid);
    origins.add(proof.origin);
  }
  return { exitedAt, hostPids: [...hostPids], origins: [...origins].sort() };
}
