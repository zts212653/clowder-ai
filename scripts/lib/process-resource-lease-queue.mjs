import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const RECEIPT_VERSION = 1;
const MAX_TERMINAL_RECEIPTS = 128;
const WAITER_SUFFIX = '.waiter.json';
const RECEIPT_SUFFIX = '.receipt.json';

export function elapsedMilliseconds(startedAt) {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function queuePaths(lockPath) {
  return {
    queueDir: `${lockPath}.queue`,
    receiptDir: `${lockPath}.receipts`,
  };
}

function receiptPathFor(receiptDir, queueId) {
  return resolve(receiptDir, `${queueId}${RECEIPT_SUFFIX}`);
}

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function validWaiterMetadata(value, expectedQueueId) {
  return (
    value?.version === RECEIPT_VERSION &&
    value?.queueId === expectedQueueId &&
    typeof value?.queueOrder === 'string' &&
    /^\d+$/.test(value.queueOrder) &&
    Number.isSafeInteger(value?.holderPid) &&
    value.holderPid > 0 &&
    typeof value?.cwd === 'string' &&
    typeof value?.label === 'string' &&
    typeof value?.queuedAt === 'string'
  );
}

async function readWaiter(waiterPath, queueId) {
  try {
    const parsed = JSON.parse(await readFile(waiterPath, 'utf8'));
    return validWaiterMetadata(parsed, queueId) ? parsed : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

async function statWaiter(waiterPath) {
  try {
    return await stat(waiterPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function waitDurationFromQueuedAt(queuedAt) {
  const parsed = Date.parse(queuedAt);
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : 0;
}

async function pruneTerminalReceipts(receiptDir) {
  let entries;
  try {
    entries = (await readdir(receiptDir)).filter((entry) => entry.endsWith(RECEIPT_SUFFIX)).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const terminal = [];
  for (const entry of entries) {
    try {
      const receipt = JSON.parse(await readFile(resolve(receiptDir, entry), 'utf8'));
      if (['aborted', 'failed', 'reclaimed', 'released', 'timed_out'].includes(receipt?.status)) {
        terminal.push(entry);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }

  await Promise.all(
    terminal
      .slice(0, Math.max(0, terminal.length - MAX_TERMINAL_RECEIPTS))
      .map((entry) => rm(resolve(receiptDir, entry), { force: true })),
  );
}

export async function createProcessResourceWaiter({ lockPath, holderPid, cwd, label }) {
  const resolvedLockPath = resolve(lockPath);
  const { queueDir, receiptDir } = queuePaths(resolvedLockPath);
  await Promise.all([mkdir(queueDir, { recursive: true }), mkdir(receiptDir, { recursive: true })]);

  const queueOrder = process.hrtime.bigint().toString().padStart(24, '0');
  const queueId = `${queueOrder}-${holderPid}-${randomUUID()}`;
  const metadata = {
    version: RECEIPT_VERSION,
    queueId,
    queueOrder,
    holderPid,
    cwd,
    label,
    queuedAt: new Date().toISOString(),
  };
  const waiterPath = resolve(queueDir, `${queueId}${WAITER_SUFFIX}`);
  const receiptPath = receiptPathFor(receiptDir, queueId);
  await writeJsonAtomically(waiterPath, metadata);
  return { metadata, queueDir, receiptDir, waiterPath, receiptPath };
}

export async function touchProcessResourceWaiter(waiter, now = Date.now()) {
  const touchedAt = new Date(now);
  try {
    await utimes(waiter.waiterPath, touchedAt, touchedAt);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function listLiveProcessResourceWaiters(lockPath, { stalledAfterMs = Number.POSITIVE_INFINITY } = {}) {
  const resolvedLockPath = resolve(lockPath);
  const { queueDir, receiptDir } = queuePaths(resolvedLockPath);
  await Promise.all([mkdir(queueDir, { recursive: true }), mkdir(receiptDir, { recursive: true })]);
  const entries = (await readdir(queueDir)).filter((entry) => entry.endsWith(WAITER_SUFFIX)).sort();
  const live = [];
  let reclaimedAny = false;
  const observedAt = Date.now();

  for (const entry of entries) {
    const queueId = entry.slice(0, -WAITER_SUFFIX.length);
    const waiterPath = resolve(queueDir, entry);
    const metadata = await readWaiter(waiterPath, queueId);
    if (metadata === undefined) continue;
    if (metadata && processIsAlive(metadata.holderPid)) {
      const waiterStat = await statWaiter(waiterPath);
      if (!waiterStat) continue;
      live.push({
        metadata,
        waiterPath,
        receiptDir,
        receiptPath: receiptPathFor(receiptDir, queueId),
        lastProgressAt: waiterStat.mtimeMs,
        stalled: observedAt - waiterStat.mtimeMs >= stalledAfterMs,
      });
      continue;
    }

    if (metadata) {
      await writeJsonAtomically(receiptPathFor(receiptDir, queueId), {
        ...metadata,
        status: 'reclaimed',
        waitDurationMs: waitDurationFromQueuedAt(metadata.queuedAt),
        reclaimedAt: new Date().toISOString(),
      });
      reclaimedAny = true;
    }
    await rm(waiterPath, { force: true });
  }

  live.sort(
    (left, right) =>
      left.metadata.queueOrder.localeCompare(right.metadata.queueOrder) ||
      left.metadata.queueId.localeCompare(right.metadata.queueId),
  );
  if (reclaimedAny) await pruneTerminalReceipts(receiptDir);
  return live;
}

export async function writeProcessResourceReceipt(waiter, receipt) {
  await writeJsonAtomically(waiter.receiptPath, {
    ...waiter.metadata,
    ...receipt,
  });
  if (['aborted', 'failed', 'reclaimed', 'released', 'timed_out'].includes(receipt.status)) {
    await pruneTerminalReceipts(waiter.receiptDir);
  }
}

export async function removeProcessResourceWaiter(waiter) {
  await rm(waiter.waiterPath, { force: true });
}
