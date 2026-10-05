import { randomUUID } from 'node:crypto';
import { link, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLeaseMetadata(lockPath) {
  try {
    const metadata = JSON.parse(await readFile(lockPath, 'utf8'));
    if (
      typeof metadata?.leaseId !== 'string' ||
      !Number.isSafeInteger(metadata?.holderPid) ||
      metadata.holderPid <= 0 ||
      typeof metadata?.cwd !== 'string' ||
      typeof metadata?.startedAt !== 'string'
    ) {
      return { kind: 'corrupt' };
    }
    return { kind: 'valid', metadata };
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    if (error instanceof SyntaxError) return { kind: 'corrupt' };
    throw error;
  }
}

export async function readProcessResourceLeaseMetadata(lockPath) {
  const state = await readLeaseMetadata(lockPath);
  return state.kind === 'valid' ? state.metadata : null;
}

function recoverySentinelPrefix(lockPath) {
  return `${basename(lockPath)}.recovering.`;
}

async function activeRecoverySentinels(lockPath) {
  const lockDir = dirname(lockPath);
  const prefix = recoverySentinelPrefix(lockPath);
  let entries;
  try {
    entries = await readdir(lockDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const active = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || entry.endsWith('.claimed')) continue;
    const sentinelPath = resolve(lockDir, entry);
    const holderPid = Number.parseInt(entry.slice(prefix.length).split('.', 1)[0] ?? '', 10);
    if (Number.isSafeInteger(holderPid) && holderPid > 0 && processIsAlive(holderPid)) {
      active.push({ holderPid, sentinelPath });
      continue;
    }
    await rm(`${sentinelPath}.claimed`, { force: true });
    await rm(sentinelPath, { force: true });
  }
  return active;
}

export async function tryAcquireLeaseFile(lockPath, metadata) {
  if ((await activeRecoverySentinels(lockPath)).length > 0) return false;
  const candidatePath = `${lockPath}.${metadata.holderPid}.${metadata.leaseId}.candidate`;
  await writeFile(candidatePath, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
  try {
    await link(candidatePath, lockPath);
    if ((await activeRecoverySentinels(lockPath)).length > 0) {
      await removeOwnedLease(lockPath, metadata.leaseId, metadata.holderPid);
      return false;
    }
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(candidatePath, { force: true });
  }
}

export async function transferOwnedLease(lockPath, { holderPid, leaseId, nextCwd, nextHolderPid }) {
  if ((await activeRecoverySentinels(lockPath)).length > 0) return false;
  const current = await readLeaseMetadata(lockPath);
  if (current.kind !== 'valid' || current.metadata.leaseId !== leaseId || current.metadata.holderPid !== holderPid) {
    return false;
  }

  const candidatePath = `${lockPath}.${holderPid}.${leaseId}.${randomUUID()}.transfer`;
  const transferredAt = new Date().toISOString();
  await writeFile(
    candidatePath,
    `${JSON.stringify({
      ...current.metadata,
      holderPid: nextHolderPid,
      cwd: nextCwd,
      startedAt: transferredAt,
      transferredAt,
      transferCount: (current.metadata.transferCount ?? 0) + 1,
    })}\n`,
    { flag: 'wx' },
  );
  try {
    const verified = await readLeaseMetadata(lockPath);
    if (
      verified.kind !== 'valid' ||
      verified.metadata.leaseId !== leaseId ||
      verified.metadata.holderPid !== holderPid ||
      (await activeRecoverySentinels(lockPath)).length > 0
    ) {
      return false;
    }
    await rename(candidatePath, lockPath);
    return true;
  } finally {
    await rm(candidatePath, { force: true });
  }
}

function waitDetail(state) {
  if (state.kind !== 'valid') {
    return {
      holderPid: state.kind,
      holderCwd: 'unknown',
      holderStartedAt: 'unknown',
      holderQueueId: 'unknown',
      holderProtocolVersion: 'unknown',
      holderCohortId: 'unknown',
    };
  }
  return {
    holderPid: state.metadata.holderPid,
    holderCwd: state.metadata.cwd,
    holderStartedAt: state.metadata.startedAt,
    holderQueueId: typeof state.metadata.queueId === 'string' ? state.metadata.queueId : null,
    holderProtocolVersion:
      Number.isSafeInteger(state.metadata.protocolVersion) && state.metadata.protocolVersion > 0
        ? state.metadata.protocolVersion
        : null,
    holderCohortId: typeof state.metadata.cohortId === 'string' ? state.metadata.cohortId : null,
  };
}

export async function readProcessResourceLeaseHolder(lockPath) {
  return waitDetail(await readLeaseMetadata(lockPath));
}

export async function recoverStaleLease(lockPath) {
  const activeRecoveries = await activeRecoverySentinels(lockPath);
  if (activeRecoveries.length > 0) {
    return {
      recovered: false,
      holderPid: `recovery:${activeRecoveries.map(({ holderPid }) => holderPid).join(',')}`,
      holderCwd: 'unknown',
      holderStartedAt: 'unknown',
      holderQueueId: 'unknown',
    };
  }

  const observed = await readLeaseMetadata(lockPath);
  if (observed.kind === 'missing') return { recovered: false, ...waitDetail(observed) };
  if (observed.kind === 'valid' && processIsAlive(observed.metadata.holderPid)) {
    return { recovered: false, ...waitDetail(observed) };
  }

  const recoveryId = randomUUID();
  const recoverySentinelPath = `${lockPath}.recovering.${process.pid}.${recoveryId}`;
  const claimedPath = `${recoverySentinelPath}.claimed`;
  await writeFile(
    recoverySentinelPath,
    `${JSON.stringify({ recoveryId, holderPid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() })}\n`,
    { flag: 'wx' },
  );
  try {
    const current = await readLeaseMetadata(lockPath);
    if (current.kind === 'missing') return { recovered: false, ...waitDetail(current) };
    if (current.kind === 'valid' && processIsAlive(current.metadata.holderPid)) {
      return { recovered: false, ...waitDetail(current) };
    }

    try {
      await rename(lockPath, claimedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { recovered: false, ...waitDetail({ kind: 'missing' }) };
      throw error;
    }
    await rm(claimedPath, { force: true });
    return { recovered: true, ...waitDetail(current) };
  } finally {
    await rm(claimedPath, { force: true });
    await rm(recoverySentinelPath, { force: true });
  }
}

export async function removeOwnedLease(lockPath, leaseId, holderPid) {
  const state = await readLeaseMetadata(lockPath);
  if (state.kind !== 'valid' || state.metadata.leaseId !== leaseId || state.metadata.holderPid !== holderPid) {
    return false;
  }
  await rm(lockPath, { force: true });
  return true;
}
