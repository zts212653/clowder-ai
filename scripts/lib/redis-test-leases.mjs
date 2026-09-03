import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const PROTECTED_REDIS_TEST_PORTS = new Set([6398, 6399, 6401]);
export const PROTECTED_REDIS_DEV_PORTS = new Set([6099, 6398, 6399, 6401]);

export function redisTestRegistryDir(env = process.env) {
  return env.CAT_CAFE_REDIS_TEST_REGISTRY_DIR || path.join(env.TMPDIR || '/tmp', 'cat-cafe-redis-tests');
}

export function redisDevRegistryDir(env = process.env) {
  return env.CAT_CAFE_REDIS_DEV_REGISTRY_DIR || path.join(env.TMPDIR || '/tmp', 'cat-cafe-redis-dev');
}

export function readProcessIdentity(pid, { execFileSyncFn = execFileSync, killFn = process.kill.bind(process) } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' };
  try {
    killFn(pid, 0);
  } catch (error) {
    return error?.code === 'ESRCH' ? { status: 'dead' } : { status: 'unknown' };
  }
  try {
    const output = execFileSyncFn('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    const startedAt = output.slice(0, 24).trim();
    const command = output.slice(24).trim();
    if (!startedAt || !command) return { status: 'unknown' };
    return { status: 'live', identity: { pid, startedAt, command } };
  } catch {
    return { status: 'unknown' };
  }
}

export function inspectExpectedProcess(identity, deps) {
  const current = readProcessIdentity(Number(identity?.pid), deps);
  if (current.status !== 'live') return current;
  return current.identity.startedAt === identity.startedAt && current.identity.command === identity.command
    ? current
    : { status: 'dead' };
}

export function inspectLeaseOwner(identity, deps) {
  const current = readProcessIdentity(Number(identity?.pid), deps);
  if (current.status !== 'live') return current;
  // Bash may exec the final test command in-place, preserving PID and process
  // birth time while changing command. The start token still prevents PID reuse.
  return current.identity.startedAt === identity.startedAt ? current : { status: 'dead' };
}

function leasesDir(registryDir) {
  return path.join(registryDir, 'leases');
}

function devLeasesDir(registryDir) {
  return path.join(registryDir, 'dev-leases');
}

function normalizeLease(raw, leaseFile) {
  if (
    raw?.version !== 1 ||
    !Number.isSafeInteger(raw.port) ||
    raw.port <= 0 ||
    raw.port > 65535 ||
    PROTECTED_REDIS_TEST_PORTS.has(raw.port) ||
    typeof raw.dataDir !== 'string' ||
    !path.isAbsolute(raw.dataDir) ||
    typeof raw.startedAt !== 'string' ||
    !raw.startedAt ||
    !raw.owner ||
    !raw.redis
  ) {
    return null;
  }
  for (const identity of [raw.owner, raw.redis]) {
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.startedAt !== 'string' ||
      !identity.startedAt ||
      typeof identity.command !== 'string' ||
      !identity.command
    ) {
      return null;
    }
  }
  return { ...raw, leaseFile };
}

export function readRedisTestLeases(registryDir = redisTestRegistryDir()) {
  const dir = leasesDir(registryDir);
  if (!existsSync(dir)) return { leases: [], invalidFiles: [] };
  const leases = [];
  const invalidFiles = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const leaseFile = path.join(dir, name);
    try {
      const lease = normalizeLease(JSON.parse(readFileSync(leaseFile, 'utf8')), leaseFile);
      if (lease) leases.push(lease);
      else invalidFiles.push(leaseFile);
    } catch {
      invalidFiles.push(leaseFile);
    }
  }
  return { leases, invalidFiles };
}

export function writeRedisTestLease(
  { port, redisPid, dataDir, ownerPid, registryDir = redisTestRegistryDir() },
  { readIdentityFn = readProcessIdentity } = {},
) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`invalid Redis test port ${port}`);
  if (PROTECTED_REDIS_TEST_PORTS.has(port)) throw new Error(`refusing protected Redis test port ${port}`);
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Redis test dataDir must be absolute');
  const owner = readIdentityFn(ownerPid);
  const redis = readIdentityFn(redisPid);
  if (owner.status !== 'live') throw new Error(`cannot capture Redis test lease owner identity for pid ${ownerPid}`);
  if (redis.status !== 'live') throw new Error(`cannot capture Redis process identity for pid ${redisPid}`);
  const lease = {
    version: 1,
    port,
    dataDir: path.resolve(dataDir),
    startedAt: new Date().toISOString(),
    owner: owner.identity,
    redis: redis.identity,
  };
  const dir = leasesDir(registryDir);
  mkdirSync(dir, { recursive: true });
  const leaseFile = path.join(dir, `redis-${port}-${redisPid}-${ownerPid}.json`);
  const tempFile = `${leaseFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempFile, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(tempFile, leaseFile);
  return leaseFile;
}

export function removeRedisTestLease(leaseFile, registryDir = redisTestRegistryDir()) {
  const expectedDir = `${path.resolve(leasesDir(registryDir))}${path.sep}`;
  const resolved = path.resolve(leaseFile);
  if (!resolved.startsWith(expectedDir)) throw new Error('refusing to remove a Redis lease outside the registry');
  rmSync(resolved, { force: true });
}

function normalizeDevLease(raw, leaseFile) {
  if (
    raw?.version !== 1 ||
    raw.kind !== 'worktree-dev' ||
    !Number.isSafeInteger(raw.port) ||
    raw.port <= 0 ||
    raw.port > 65535 ||
    PROTECTED_REDIS_DEV_PORTS.has(raw.port) ||
    typeof raw.dataDir !== 'string' ||
    !path.isAbsolute(raw.dataDir) ||
    typeof raw.projectRoot !== 'string' ||
    !path.isAbsolute(raw.projectRoot) ||
    typeof raw.startedAt !== 'string' ||
    !raw.startedAt ||
    !raw.owner ||
    !raw.redis
  ) {
    return null;
  }
  for (const identity of [raw.owner, raw.redis]) {
    if (
      !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 ||
      typeof identity.startedAt !== 'string' ||
      !identity.startedAt ||
      typeof identity.command !== 'string' ||
      !identity.command
    ) {
      return null;
    }
  }
  return { ...raw, leaseFile };
}

export function readRedisDevLeases(registryDir = redisDevRegistryDir()) {
  const dir = devLeasesDir(registryDir);
  if (!existsSync(dir)) return { leases: [], invalidFiles: [] };
  const leases = [];
  const invalidFiles = [];
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const leaseFile = path.join(dir, name);
    try {
      const lease = normalizeDevLease(JSON.parse(readFileSync(leaseFile, 'utf8')), leaseFile);
      if (lease) leases.push(lease);
      else invalidFiles.push(leaseFile);
    } catch {
      invalidFiles.push(leaseFile);
    }
  }
  return { leases, invalidFiles };
}

export function writeRedisDevLease(
  { port, redisPid, dataDir, ownerPid, projectRoot, registryDir = redisDevRegistryDir() },
  { readIdentityFn = readProcessIdentity } = {},
) {
  if (PROTECTED_REDIS_DEV_PORTS.has(port)) throw new Error(`refusing protected Redis dev port ${port}`);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid Redis dev port ${port}`);
  }
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('Redis dev dataDir must be absolute');
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('Redis dev projectRoot must be absolute');
  }
  const owner = readIdentityFn(ownerPid);
  const redis = readIdentityFn(redisPid);
  if (owner.status !== 'live') throw new Error(`cannot capture Redis dev owner identity for pid ${ownerPid}`);
  if (redis.status !== 'live') throw new Error(`cannot capture Redis dev process identity for pid ${redisPid}`);
  const lease = {
    version: 1,
    kind: 'worktree-dev',
    port,
    dataDir: path.resolve(dataDir),
    projectRoot: path.resolve(projectRoot),
    startedAt: new Date().toISOString(),
    owner: owner.identity,
    redis: redis.identity,
  };
  const dir = devLeasesDir(registryDir);
  mkdirSync(dir, { recursive: true });
  const leaseFile = path.join(dir, `redis-${port}-${redisPid}-${ownerPid}.json`);
  const tempFile = `${leaseFile}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempFile, `${JSON.stringify(lease, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(tempFile, leaseFile);
  return leaseFile;
}

export function removeRedisDevLease(leaseFile, registryDir = redisDevRegistryDir()) {
  const expectedDir = `${path.resolve(devLeasesDir(registryDir))}${path.sep}`;
  const resolved = path.resolve(leaseFile);
  if (!resolved.startsWith(expectedDir)) throw new Error('refusing to remove a Redis dev lease outside the registry');
  rmSync(resolved, { force: true });
}

export function cleanupStaleRedisDevLeases(
  registryDir = redisDevRegistryDir(),
  { inspectOwnerFn = inspectLeaseOwner } = {},
) {
  const { leases, invalidFiles } = readRedisDevLeases(registryDir);
  const live = [];
  const unknown = [];
  const stale = [];
  for (const lease of leases) {
    const owner = inspectOwnerFn(lease.owner);
    if (owner.status === 'live') {
      live.push(lease);
      continue;
    }
    if (owner.status !== 'dead') {
      unknown.push(lease);
      continue;
    }
    removeRedisDevLease(lease.leaseFile, registryDir);
    stale.push(lease);
  }
  return { live, unknown, stale, invalidFiles };
}

export function cleanupRedisGateOwnership(env = process.env) {
  return {
    test: cleanupStaleRedisTestLeases(redisTestRegistryDir(env)),
    dev: cleanupStaleRedisDevLeases(redisDevRegistryDir(env)),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function defaultStopInstance(lease) {
  const initial = inspectExpectedProcess(lease.redis);
  if (initial.status === 'unknown') return false;
  if (initial.status === 'dead') return true;
  spawnSync('redis-cli', ['-h', '127.0.0.1', '-p', String(lease.port), 'shutdown', 'nosave'], {
    timeout: 3000,
    stdio: 'ignore',
  });
  const waitForExit = (attempts) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = inspectExpectedProcess(lease.redis);
      if (current.status === 'dead') return 'dead';
      if (current.status === 'unknown') return 'unknown';
      sleep(100);
    }
    return 'live';
  };
  let state = waitForExit(30);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (state !== 'live') return state === 'dead';
    try {
      process.kill(lease.redis.pid, signal);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      return false;
    }
    state = waitForExit(signal === 'SIGTERM' ? 20 : 10);
  }
  return state === 'dead';
}

export function cleanupStaleRedisTestLeases(
  registryDir = redisTestRegistryDir(),
  { inspectOwnerFn = inspectLeaseOwner, stopInstanceFn = defaultStopInstance } = {},
) {
  const { leases, invalidFiles } = readRedisTestLeases(registryDir);
  const live = [];
  const unknown = [];
  const cleaned = [];
  for (const lease of leases) {
    const owner = inspectOwnerFn(lease.owner);
    if (owner.status === 'live') {
      live.push(lease);
      continue;
    }
    if (owner.status !== 'dead') {
      unknown.push(lease);
      continue;
    }
    if (!stopInstanceFn(lease)) {
      unknown.push(lease);
      continue;
    }
    removeRedisTestLease(lease.leaseFile, registryDir);
    if (path.basename(lease.dataDir).startsWith('cat-cafe-redis-test.')) {
      rmSync(lease.dataDir, { recursive: true, force: true });
    }
    cleaned.push(lease);
  }
  return { live, unknown, cleaned, invalidFiles };
}
