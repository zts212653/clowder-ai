import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { verifyNamedAlphaRedisIdentity } from './alpha-redis-process.mjs';
import { captureProcessIdentity, PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

export function namedAlphaRedisRegistryDir(env = process.env) {
  return env.CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR || join(tmpdir(), 'cat-cafe-alpha-redis');
}

function leaseName(record) {
  return `redis-${record.redis.port}-${record.redis.pid}-${record.owner.pid}.json`;
}

function ownerMatches(expected, current, alphaRoot) {
  const argv = current?.command?.split(/\s+/) ?? [];
  return (
    expected?.startedAtFormat === PROCESS_START_TIME_FORMAT &&
    current?.startedAtFormat === PROCESS_START_TIME_FORMAT &&
    current.argvAvailable === true &&
    current.ucomm === 'bash' &&
    basename(argv[0] ?? '') === 'bash' &&
    Number.isSafeInteger(current.startedAtEpochMs) &&
    ['scripts/start-dev.sh', './scripts/start-dev.sh', join(alphaRoot, 'scripts/start-dev.sh')].includes(argv[1]) &&
    current.cwd === alphaRoot &&
    expected.cwd === current.cwd &&
    expected.command === current.command &&
    expected.startedAt === current.startedAt &&
    expected.startedAtEpochMs === current.startedAtEpochMs
  );
}

function validateLease(record, { now = Date.now(), capture = captureProcessIdentity, readListeners } = {}) {
  if (
    record?.version !== 1 ||
    record.kind !== 'named-alpha' ||
    !Number.isSafeInteger(record.owner?.pid) ||
    record.owner.pid <= 1
  )
    throw new Error('Invalid named Alpha Redis lease');
  const coordinates = parseNamedAlphaCoordinates(JSON.stringify(record.coordinates));
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = record.expiresAt === null ? null : Date.parse(record.expiresAt);
  if (
    !Number.isFinite(createdAt) ||
    createdAt > now ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt <= now))
  )
    throw new Error('Named Alpha Redis lease is expired or has invalid lifetime');
  const owner = capture(record.owner.pid);
  if (!ownerMatches(record.owner.process, owner, coordinates.alphaRoot))
    throw new Error('Named Alpha Redis owner incarnation changed');
  if (
    !Number.isSafeInteger(record.redis?.process?.startedAtEpochMs) ||
    owner.startedAtEpochMs > record.redis.process.startedAtEpochMs ||
    record.redis.process.startedAtEpochMs > createdAt
  )
    throw new Error('Named Alpha Redis does not belong to this owner lifetime');
  verifyNamedAlphaRedisIdentity(JSON.stringify(coordinates), record.redis, {
    capture,
    ...(readListeners ? { readListeners } : {}),
  });
  return record;
}

/** Publish only after the launcher has captured and verified its exact Redis process. */
export function registerNamedAlphaRedisLease(
  { rawCoordinates, redis, ownerPid, expiresAt = null, registryDir = namedAlphaRedisRegistryDir() },
  { now = Date.now(), capture = captureProcessIdentity, readListeners } = {},
) {
  const record = validateLease(
    {
      version: 1,
      kind: 'named-alpha',
      coordinates: parseNamedAlphaCoordinates(rawCoordinates),
      owner: { pid: ownerPid, process: capture(ownerPid) },
      redis,
      createdAt: new Date(now).toISOString(),
      expiresAt,
    },
    { now, capture, readListeners },
  );
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  if (lstatSync(registryDir).isSymbolicLink()) throw new Error('Named Alpha registry must not be a symlink');
  const leaseFile = join(registryDir, leaseName(record));
  const temporary = `${leaseFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, leaseFile);
  return leaseFile;
}

function readLease(file) {
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 32_768)
    throw new Error('Named Alpha lease must be a bounded regular file');
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const after = lstatSync(file);
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs)
    throw new Error('Named Alpha lease changed during read');
  if (basename(file) !== leaseName(record)) throw new Error('Named Alpha lease identity does not match its filename');
  return record;
}

/** Recognition is read-only: stale/unknown metadata never authorizes stopping Alpha or deleting its data. */
export function readNamedAlphaRedisLeases(registryDir = namedAlphaRedisRegistryDir(), deps = {}) {
  const result = { live: [], rejected: [] };
  let names;
  try {
    if (lstatSync(registryDir).isSymbolicLink()) throw new Error('Named Alpha registry is linked');
    names = readdirSync(registryDir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') result.rejected.push({ file: registryDir, reason: error.message });
    return result;
  }
  for (const name of names) {
    const file = join(registryDir, name);
    try {
      const record = validateLease(readLease(file), deps);
      result.live.push({ port: record.redis.port, pid: record.redis.pid, leaseFile: file });
    } catch (error) {
      result.rejected.push({ file, reason: error.message });
    }
  }
  return result;
}

export function removeNamedAlphaRedisLease(
  file,
  ownerPid,
  { registryDir = namedAlphaRedisRegistryDir(), capture = captureProcessIdentity } = {},
) {
  if (resolve(file) !== join(resolve(registryDir), basename(file))) throw new Error('Lease is outside Alpha registry');
  const record = readLease(file);
  if (
    record.owner.pid !== ownerPid ||
    !ownerMatches(record.owner.process, capture(ownerPid), record.coordinates.alphaRoot)
  )
    throw new Error('Cannot remove another Alpha owner lease');
  rmSync(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, raw, proof, owner, expiry] = process.argv.slice(2);
    if (command === 'register')
      process.stdout.write(
        `${registerNamedAlphaRedisLease({
          rawCoordinates: raw,
          redis: JSON.parse(proof),
          ownerPid: Number(owner),
          expiresAt: expiry || null,
        })}\n`,
      );
    else if (command === 'remove') removeNamedAlphaRedisLease(raw, Number(proof));
    else throw new Error('Invalid named Alpha Redis lease operation');
  } catch (error) {
    process.stderr.write(`[alpha-redis-lease] ${error.message}\n`);
    process.exitCode = 1;
  }
}
