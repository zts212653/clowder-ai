import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { parseAlphaLaunchChild } from './alpha-launch-contract.mjs';
import { namedAlphaRedisRegistryDir } from './alpha-redis-leases.mjs';
import { previewProcessRecordId } from './preview-process-record-key.mjs';
import { PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

export const recoveryHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (st) => [st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':');

export function recoveryPathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function recoverySnapshot(path, { maxBytes = 32768 } = {}) {
  const kind = lstatSync(path);
  if (realpathSync(path) !== path || kind.isSymbolicLink()) throw new Error('recovery evidence is linked');
  if (!kind.isFile()) throw new Error('recovery evidence must be a bounded regular file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('recovery evidence must be a bounded regular file');
    const bytes = readFileSync(fd);
    if (identity(fstatSync(fd)) !== identity(before)) throw new Error('recovery evidence changed while reading');
    return { path, bytes, sha256: recoveryHash(bytes), maxBytes };
  } finally {
    closeSync(fd);
  }
}

export function recoveryFile(path) {
  const snapshot = recoverySnapshot(path);
  return { ...snapshot, value: JSON.parse(snapshot.bytes.toString('utf8')) };
}

export function syncRecoveryDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeRecoveryBytes(path, bytes) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncRecoveryDirectory(dirname(path));
}

export const writeRecoveryFile = (path, value) => writeRecoveryBytes(path, `${JSON.stringify(value)}\n`);

export function sameRecoveryFile(snapshot, { missing = false } = {}) {
  try {
    if (recoverySnapshot(snapshot.path, snapshot).sha256 !== snapshot.sha256)
      throw new Error('recovery source bytes changed');
  } catch (error) {
    if (!missing || error.code !== 'ENOENT') throw error;
  }
}

export function readAlphaCompletionEvidence(config, record) {
  return { ...readPreviewCompletionEvidence(config, record), coordinates: readNamedAlphaRegistration(config, record) };
}

export function readNamedAlphaRegistration(config, record) {
  const { coordinates: selected, options } = parseAlphaLaunchChild(record.command, config.cwd);
  if (
    !options['--instance'] ||
    record.version !== 1 ||
    record.cwd !== config.cwd ||
    record.port !== config.port ||
    record.id !== config.id ||
    config.id !== previewProcessRecordId(config.cwd, config.port) ||
    config.port !== selected.ports.frontend ||
    dirname(record.completionPath) !== config.stateDir ||
    !new RegExp(`^${config.id}\\.[a-f0-9-]{36}\\.completion\\.json$`).test(basename(record.completionPath))
  )
    throw new Error('failed cleanup is not the exact registered named Alpha');
  return selected;
}

/** The supervisor/nonce envelope does not imply a cleanup owner ever existed. */
export function readRegisteredPreviewEnvelope(config, record) {
  if (
    record.version !== 1 ||
    record.cwd !== config.cwd ||
    record.port !== config.port ||
    record.id !== config.id ||
    config.id !== previewProcessRecordId(config.cwd, config.port) ||
    dirname(record.completionPath ?? '') !== config.stateDir ||
    !new RegExp(`^${config.id}\\.[a-f0-9-]{36}\\.completion\\.json$`).test(basename(record.completionPath ?? ''))
  ) {
    throw new Error('cleanup is not the exact registered preview');
  }
  const sources = {
    record: recoveryFile(config.recordPath),
    completion: recoveryFile(record.completionPath),
  };
  if (JSON.stringify(sources.record.value) !== JSON.stringify(record)) throw new Error('preview record changed');
  const completion = sources.completion.value;
  if (
    completion.pid !== record.pid ||
    completion.expiresAt !== record.expiresAt ||
    completion.forced !== false ||
    !Number.isInteger(completion.exitCode) ||
    completion.exitCode < 0 ||
    completion.exitCode > 255 ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 1 ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    !Number.isFinite(Date.parse(completion.completedAt)) ||
    Date.parse(completion.completedAt) < Date.parse(record.startedAt)
  )
    throw new Error('failed cleanup owner completion is missing, forced, or inconsistent');
  if (
    !Number.isFinite(Date.parse(`${record.processStartedAt} UTC`)) ||
    Date.parse(`${record.processStartedAt} UTC`) > Date.parse(record.startedAt) ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.expiresAt) <= Date.parse(record.startedAt)
  )
    throw new Error('failed cleanup supervisor lifetime is inconsistent');
  return { sources, completion };
}

/** Shared envelope only; Alpha coordinates/leases remain the Alpha caller's responsibility. */
export function readPreviewCompletionEvidence(config, record) {
  const { sources, completion } = readRegisteredPreviewEnvelope(config, record);
  sources.owner = recoveryFile(`${record.completionPath}.owner.json`);
  const owner = sources.owner.value;
  if (
    completion.cleanupOwnerStatus !== 'complete' ||
    !Number.isInteger(owner.exitCode) ||
    owner.exitCode < 0 ||
    owner.exitCode > 255 ||
    ![owner.pid, owner.processGroupId].every((pid) => Number.isSafeInteger(pid) && pid > 1)
  )
    throw new Error('failed cleanup owner completion is missing, forced, or inconsistent');
  const exitCode = (value) => Number.isInteger(value) && value >= 0 && value <= 255;
  if (
    (completion.version !== undefined && completion.version !== 2) ||
    (owner.version !== undefined && owner.version !== 2) ||
    (owner.version === 2 && (!exitCode(owner.commandExitCode) || owner.cleanupExitCode !== owner.exitCode)) ||
    (completion.version === 2 &&
      ((completion.commandExitCode !== null && !exitCode(completion.commandExitCode)) ||
        (completion.cleanupExitCode !== null && !exitCode(completion.cleanupExitCode)))) ||
    (completion.version === 2 &&
      owner.version === 2 &&
      (completion.cleanupExitCode !== owner.cleanupExitCode || completion.commandExitCode !== owner.commandExitCode))
  )
    throw new Error('versioned preview outcomes are inconsistent');
  return { sources, owner, completion };
}

function readAlphaProducerEvidence(
  config,
  record,
  { registryDir = namedAlphaRedisRegistryDir(), savedLease } = {},
  protocolRecovery,
) {
  const { sources, coordinates: selected, owner, completion } = readAlphaCompletionEvidence(config, record);
  // Redis protocol recovery retains its existing tighter lifetime proof.
  // Metadata-only retirement proves that no resources remain instead; the
  // registration may legitimately be published later than the runner's birth.
  if (protocolRecovery && Math.abs(Date.parse(`${record.processStartedAt} UTC`) - Date.parse(record.startedAt)) >= 1000)
    throw new Error('failed cleanup supervisor lifetime is inconsistent');
  const explicit = completion.version === 2 && owner.version === 2;
  if (completion.exitCode < 1 || ((protocolRecovery || !explicit) && owner.exitCode !== completion.exitCode))
    throw new Error('failed cleanup owner completion is missing, forced, or inconsistent');
  if (lstatSync(registryDir).isSymbolicLink()) throw new Error('named Alpha lease registry is linked');
  // macOS's native TMPDIR uses /var, whose system alias is /private/var.
  // Normalize that spelling before opening bounded, unlinked lease files.
  registryDir = realpathSync(registryDir);
  const names = readdirSync(registryDir).filter((name) =>
    new RegExp(`^redis-${selected.ports.redis}-[1-9]\\d*-${owner.pid}\\.json$`).test(name),
  );
  if (names.length === 0 && savedLease && dirname(savedLease.path) === registryDir) sources.lease = savedLease;
  else if (names.length === 1) sources.lease = recoveryFile(join(registryDir, names[0]));
  else throw new Error('failed cleanup requires one exact producer lease');
  const lease = sources.lease.value;
  const coordinates = parseNamedAlphaCoordinates(JSON.stringify(lease.coordinates));
  const { targetSha, ...scope } = coordinates;
  const ownerProcess = lease.owner?.process;
  if (
    JSON.stringify(scope) !== JSON.stringify(selected) ||
    !targetSha ||
    lease.version !== 1 ||
    lease.kind !== 'named-alpha' ||
    lease.owner?.pid !== owner.pid ||
    lease.expiresAt !== record.expiresAt ||
    basename(sources.lease.path) !== `redis-${coordinates.ports.redis}-${lease.redis?.pid}-${owner.pid}.json` ||
    ownerProcess?.cwd !== coordinates.alphaRoot ||
    ownerProcess?.ucomm !== 'bash' ||
    ownerProcess?.argvAvailable !== true ||
    ownerProcess?.startedAtFormat !== PROCESS_START_TIME_FORMAT ||
    !['bash', '/bin/bash', '/usr/bin/bash'].includes(ownerProcess.command?.split(' ')[0]) ||
    ![
      `bash ${join(coordinates.alphaRoot, 'scripts/start-dev.sh')} --quick`,
      `/bin/bash ${join(coordinates.alphaRoot, 'scripts/start-dev.sh')} --quick`,
      '/bin/bash ./scripts/start-dev.sh --quick',
      'bash ./scripts/start-dev.sh --quick',
      'bash scripts/start-dev.sh --quick',
    ].includes(ownerProcess.command) ||
    ownerProcess.startedAtEpochMs <
      (protocolRecovery ? Date.parse(record.startedAt) - 1000 : Date.parse(`${record.processStartedAt} UTC`)) ||
    Date.parse(`${ownerProcess.startedAt} UTC`) !== ownerProcess.startedAtEpochMs ||
    ownerProcess.startedAtEpochMs > lease.redis?.process?.startedAtEpochMs ||
    lease.redis?.process?.startedAtEpochMs > Date.parse(lease.createdAt) ||
    Date.parse(lease.createdAt) > Date.parse(completion.completedAt) ||
    ![ownerProcess.startedAtEpochMs, lease.redis?.process?.startedAtEpochMs, Date.parse(lease.createdAt)].every(
      Number.isSafeInteger,
    )
  )
    throw new Error('failed cleanup producer lease does not belong to the recorded owner lifetime');
  return { sources, coordinates, owner, proof: lease.redis };
}

/** Existing saving recovery keeps its original strict registration/lifetime envelope. */
export function readFailedAlphaEvidence(config, record, deps = {}) {
  return readAlphaProducerEvidence(config, record, deps, true);
}

/** Historical binding only. Current absence must be proved separately; never authorizes Redis protocol. */
export function readHistoricalAlphaLeaseEvidence(config, record, deps = {}) {
  return readAlphaProducerEvidence(config, record, deps, false);
}
