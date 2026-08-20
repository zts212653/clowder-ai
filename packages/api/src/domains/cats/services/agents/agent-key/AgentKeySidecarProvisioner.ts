import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';

const DEFAULT_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LEASE_STALE_MS = 30_000;
const DEFAULT_LEASE_WAIT_MS = 5_000;
const LEASE_RETRY_MS = 25;
const KEY_DIR_MODE = 0o700;
const KEY_FILE_MODE = 0o600;

export type AgentKeySidecarDisposition =
  | { readonly kind: 'preserved'; readonly agentKeyId: string; readonly expiresAt: number }
  | { readonly kind: 'rotated'; readonly agentKeyId: string; readonly expiresAt: number }
  | { readonly kind: 'replaced'; readonly agentKeyId: string; readonly expiresAt: number }
  | { readonly kind: 'issued'; readonly agentKeyId: string; readonly expiresAt: number };

export interface EnsureAgentKeySidecarOptions {
  readonly registry: AgentKeyRegistry;
  readonly catId: string;
  readonly userId: string;
  readonly keyFile: string;
  readonly renewBeforeMs?: number;
  readonly leaseStaleMs?: number;
  readonly leaseWaitMs?: number;
  readonly now?: () => number;
  /** Test seam for proving registry rollback when durable publication fails. */
  readonly publish?: (keyFile: string, secret: string) => Promise<void>;
}

interface SidecarSnapshot {
  readonly exists: boolean;
  readonly secret: string;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSidecar(keyFile: string): Promise<SidecarSnapshot> {
  try {
    return { exists: true, secret: (await readFile(keyFile, 'utf8')).trim() };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { exists: false, secret: '' };
    throw error;
  }
}

interface LeaseRecord {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAt: number;
}

async function readLeaseRecord(leaseFile: string): Promise<LeaseRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(leaseFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<LeaseRecord>;
    if (
      typeof candidate.token !== 'string' ||
      typeof candidate.pid !== 'number' ||
      typeof candidate.acquiredAt !== 'number'
    ) {
      return null;
    }
    return { token: candidate.token, pid: candidate.pid, acquiredAt: candidate.acquiredAt };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

async function releaseOwnedLease(leaseFile: string, token: string): Promise<void> {
  const current = await readLeaseRecord(leaseFile);
  if (current?.token === token) await rm(leaseFile, { force: true });
}

interface StaleLeaseObservation {
  readonly token: string | null;
}

async function observeStaleLease(
  leaseFile: string,
  now: () => number,
  staleMs: number,
): Promise<StaleLeaseObservation | null> {
  try {
    const leaseStat = await stat(leaseFile);
    const record = await readLeaseRecord(leaseFile);
    if (now() - leaseStat.mtimeMs <= staleMs || processIsAlive(record?.pid ?? 0)) return null;
    return { token: record?.token ?? null };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

async function removeObservedLease(leaseFile: string, observedToken: string | null): Promise<boolean> {
  const current = await readLeaseRecord(leaseFile);
  if ((current?.token ?? null) !== observedToken) return false;
  await rm(leaseFile, { force: true });
  return true;
}

async function reapStaleLease(
  leaseFile: string,
  observedToken: string | null,
  now: () => number,
  staleMs: number,
): Promise<boolean> {
  const reaperFile = `${leaseFile}.reaper`;
  const reaperToken = randomUUID();

  while (true) {
    try {
      await writeFile(reaperFile, `${JSON.stringify({ token: reaperToken, pid: process.pid, acquiredAt: now() })}\n`, {
        encoding: 'utf8',
        mode: KEY_FILE_MODE,
        flag: 'wx',
      });
      break;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const staleReaper = await observeStaleLease(reaperFile, now, staleMs);
      if (!staleReaper || !(await removeObservedLease(reaperFile, staleReaper.token))) return false;
    }
  }

  try {
    const current = await readLeaseRecord(leaseFile);
    if ((current?.token ?? null) !== observedToken) return false;
    await rm(leaseFile, { force: true });
    return true;
  } finally {
    await releaseOwnedLease(reaperFile, reaperToken);
  }
}

async function acquireLease(
  keyFile: string,
  now: () => number,
  staleMs: number,
  waitMs: number,
): Promise<() => Promise<void>> {
  const leaseFile = `${keyFile}.provision.lock`;
  const deadline = now() + waitMs;
  await mkdir(dirname(keyFile), { recursive: true, mode: KEY_DIR_MODE });

  while (true) {
    const token = randomUUID();
    try {
      await writeFile(leaseFile, `${JSON.stringify({ token, pid: process.pid, acquiredAt: now() })}\n`, {
        encoding: 'utf8',
        mode: KEY_FILE_MODE,
        flag: 'wx',
      });
      return async () => releaseOwnedLease(leaseFile, token);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const staleLease = await observeStaleLease(leaseFile, now, staleMs);
      if (staleLease && (await reapStaleLease(leaseFile, staleLease.token, now, staleMs))) continue;
      if (now() >= deadline) throw new Error(`agent-key sidecar provisioning lease timed out: ${keyFile}`);
      await sleep(LEASE_RETRY_MS);
    }
  }
}

async function enforceStrictFileMode(file: string): Promise<void> {
  await chmod(file, KEY_FILE_MODE);
  const actualMode = (await stat(file)).mode & 0o777;
  if (actualMode !== KEY_FILE_MODE) {
    throw new Error(`agent-key sidecar file mode is 0o${actualMode.toString(8)}, expected 0o600: ${file}`);
  }
}

async function publishSecret(keyFile: string, secret: string): Promise<void> {
  const temporary = `${keyFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${secret}\n`, { encoding: 'utf8', mode: KEY_FILE_MODE, flag: 'wx' });
    await enforceStrictFileMode(temporary);
    await rename(temporary, keyFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function revokeNonCanonicalKeys(
  registry: AgentKeyRegistry,
  catId: string,
  userId: string,
  canonicalAgentKeyId: string,
): Promise<void> {
  const records = await registry.list({ catId, userId });
  await Promise.all(
    records
      .filter((record) => record.agentKeyId !== canonicalAgentKeyId && record.graceUntil === undefined)
      .map((record) => registry.revoke(record.agentKeyId, 'superseded by canonical sidecar reconciliation')),
  );
}

async function requireIssuedRecord(registry: AgentKeyRegistry, agentKeyId: string): Promise<{ expiresAt: number }> {
  const record = await registry.get(agentKeyId);
  if (!record) throw new Error(`issued agent-key record disappeared before sidecar publication: ${agentKeyId}`);
  return record;
}

async function reconcileUnderLease(options: EnsureAgentKeySidecarOptions): Promise<AgentKeySidecarDisposition> {
  const { registry, catId, userId, keyFile } = options;
  const now = options.now ?? Date.now;
  const renewBeforeMs = options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS;
  const snapshot = await readSidecar(keyFile);
  const verified = snapshot.secret ? await registry.verify(snapshot.secret) : null;
  const matchingRecord =
    verified?.ok && verified.record.catId === catId && verified.record.userId === userId ? verified.record : null;

  if (matchingRecord && matchingRecord.graceUntil === undefined && matchingRecord.expiresAt - now() > renewBeforeMs) {
    await enforceStrictFileMode(keyFile);
    await revokeNonCanonicalKeys(registry, catId, userId, matchingRecord.agentKeyId);
    return {
      kind: 'preserved',
      agentKeyId: matchingRecord.agentKeyId,
      expiresAt: matchingRecord.expiresAt,
    };
  }

  const disposition: Exclude<AgentKeySidecarDisposition['kind'], 'preserved'> = matchingRecord
    ? matchingRecord.graceUntil === undefined
      ? 'rotated'
      : 'replaced'
    : snapshot.exists
      ? 'replaced'
      : 'issued';
  const issued =
    disposition === 'rotated'
      ? await registry.rotate(matchingRecord?.agentKeyId ?? '')
      : await registry.issue(createCatId(catId), userId);

  let publicationComplete = false;
  try {
    const record = await requireIssuedRecord(registry, issued.agentKeyId);
    await (options.publish ?? publishSecret)(keyFile, issued.secret);
    publicationComplete = true;
    await revokeNonCanonicalKeys(registry, catId, userId, issued.agentKeyId);
    return { kind: disposition, agentKeyId: issued.agentKeyId, expiresAt: record.expiresAt };
  } catch (error) {
    if (!publicationComplete) {
      await registry.revoke(issued.agentKeyId, 'sidecar publication failed').catch(() => false);
    }
    throw error;
  }
}

export async function ensureAgentKeySidecar(
  options: EnsureAgentKeySidecarOptions,
): Promise<AgentKeySidecarDisposition> {
  const now = options.now ?? Date.now;
  const release = await acquireLease(
    options.keyFile,
    now,
    options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS,
    options.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS,
  );
  try {
    return await reconcileUnderLease(options);
  } finally {
    await release();
  }
}
