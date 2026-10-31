import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import {
  readProcessResourceLeaseMetadata,
  recoverStaleLease,
  removeOwnedLease,
  tryAcquireLeaseFile,
} from './process-resource-lease-lock.mjs';
import { isProcessRunning } from './process-tree.mjs';

function lifecyclePaths(coordinates) {
  // This coordinate survives canonical checkout release. Retirement must never
  // recreate an Alpha/data directory just to acquire its lifecycle lock.
  const root = coordinates.mainRoot;
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
    throw new Error('Alpha lifecycle requires its physical main checkout');
  const state = join(root, '.cat-cafe');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  if (realpathSync(state) !== state) throw new Error('Alpha lifecycle directory is linked');
  const directory = join(state, 'named-alpha-lifecycles');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw new Error('Alpha lifecycle directory is linked');
  return [`instance-${coordinates.instance}`, ...Object.values(coordinates.ports).map((port) => `port-${port}`)]
    .sort()
    .map((key) => join(directory, `${key}.lock`));
}

async function acquireOne(path, metadata) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Alpha lifecycle lock is linked');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!(await tryAcquireLeaseFile(path, metadata))) {
    const prior = await readProcessResourceLeaseMetadata(path);
    if (
      !prior ||
      isProcessRunning(prior.holderPid) !== false ||
      !(await recoverStaleLease(path)).recovered ||
      !(await tryAcquireLeaseFile(path, metadata))
    )
      throw new Error('named Alpha lifecycle is active or unproven (including a build before listening)');
  }
}

async function releaseOwned(paths, metadata) {
  for (const path of paths) await removeOwnedLease(path, metadata.leaseId, metadata.holderPid);
}

/** Admission starts before install/build; overlapping tuples must reserve their ports too. */
export async function acquireNamedAlphaLifecycle(coordinates, holderPid = process.pid) {
  const metadata = {
    leaseId: randomUUID(),
    holderPid,
    cwd: coordinates.alphaRoot,
    startedAt: new Date().toISOString(),
  };
  const held = [];
  try {
    for (const path of lifecyclePaths(coordinates)) {
      await acquireOne(path, metadata);
      held.push(path);
    }
  } catch (error) {
    await releaseOwned(held, metadata);
    throw error;
  }
  return () => releaseOwned(held, metadata);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, raw, parent, ...extra] = process.argv.slice(2);
    if (extra.length || !['acquire', 'release'].includes(action) || Number(parent) !== process.ppid)
      throw new Error('Alpha admission must be owned by its invoking launcher');
    const coordinates = parseNamedAlphaCoordinates(raw);
    if (action === 'acquire') await acquireNamedAlphaLifecycle(coordinates, process.ppid);
    else {
      const paths = lifecyclePaths(coordinates);
      const owners = await Promise.all(paths.map((path) => readProcessResourceLeaseMetadata(path)));
      if (owners.some((owner) => !owner || owner.holderPid !== process.ppid || owner.leaseId !== owners[0]?.leaseId))
        throw new Error('Alpha admission owner changed');
      await releaseOwned(paths, owners[0]);
    }
  } catch (error) {
    process.stderr.write(`[alpha-lifecycle] ${error.message}\n`);
    process.exitCode = 1;
  }
}
